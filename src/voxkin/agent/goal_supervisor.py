from __future__ import annotations

import asyncio
import inspect
import math
import re
import time
import uuid
from dataclasses import asdict, replace
from typing import Any, Awaitable, Callable

from voxkin.agent.action_effects import REPLAN_EFFECT_TOOLS, action_effect_class
from voxkin.agent.late_game_methods import choose_s5_action, choose_s6_action, late_method_key, prepare_late_action
from voxkin.agent.plans import S6_STEPS
from voxkin.agent.resource_policy import batch_resource_step, choose_supply_opportunity
from voxkin.agent.goals import (
    GOAL_IMMUTABLE_STATES,
    GoalSpec,
    evaluate_condition,
    goal_state_blocks_automatic_transition,
    inventory_count,
)
from voxkin.agent.runner import StepSpec, Verifier
from voxkin.agent.tasks import TaskStore
from voxkin.bridge.protocol import ActionResult, ActionStatusResult

Dispatch = Callable[..., Awaitable[Any]]
StateProvider = Callable[[], dict[str, Any]]
StatusQuery = Callable[..., Awaitable[ActionStatusResult]]
Announce = Callable[[str], Awaitable[None]]
StateAge = Callable[[], float]

GOAL_STATE_VERSION = 2
MAX_READY_WAIT_S = 30.0
MAX_ACTION_RECONCILE_S = 30.0
MAX_PREEMPTIONS = 3
MAX_ADMISSION_RETRIES = 3
RECOVERY_BUDGET_VERSION = 1
S6_STRONGHOLD_MAX_DESCENT_LAYERS = 96
S6_STRONGHOLD_SEGMENT_LAYERS = 8

SAFE_REPLAN_TOOLS = REPLAN_EFFECT_TOOLS

from voxkin.agent.goal_methods import (
    FOOD_ITEMS,
    S2_SHELTER_BLOCKS,
    S2_WOOD_BLOCKS,
    S3_ANY_PICKAXES,
    S3_FOOD_RESERVE,
    S3_IRON_COSTS,
    S3_MINING_PICKAXES,
    S3_ORE_EXPOSE_MAX,
    S3_OVERWORLD_WOOD_LOGS,
    S3_OVERWORLD_WOOD_SOURCES,
    S3_SAFE_FOOD,
    S3_SURFACE_ROUTE_MAX_HORIZONTAL,
    S3_SURFACE_ROUTE_MIN_VERTICAL,
    S3_WOOD_PLANKS,
    S3_WOOD_SOURCES,
    S3_FUEL_BURN,
    S4_DESCENT_STEP,
    S4_DIAMOND_MINING_PICKAXES,
    S4_DIAMOND_TARGET,
    S4_FOOD_RESERVE,
    S4_HORIZONTAL_LENGTH,
    S4_IRON_MINING_PICKAXES,
    S4_MAX_DESCENT_SEGMENTS,
    S4_MAX_SAFE_ROUTE_FALLBACKS,
    S4_MIN_HEALTH,
    S4_TARGET_Y,
    _bed_ids,
    _bed_inside,
    _bed_is_inside,
    _bed_wool_color,
    _danger_now,
    _fresh_terminal_observation,
    _fresh_terminal_state,
    _is_day,
    _position_y,
    _s3_action,
    _s3_ensure_planks,
    _s3_ensure_sticks,
    _s3_food_count,
    _s3_iron_ingot_requirement,
    _s3_needs_surface_route,
    _s3_no_resource_wood_logs,
    _s3_return_to_known_surface,
    _s3_smelt_fuel_need,
    _s3_wood_search_context,
    _s4_ensure_mining_pickaxe,
    _shelter_bounds,
    _shelter_missing_blocks,
    _shelter_structurally_ready,
    canonical_s5_portal_dimension,
    choose_s2_action,
    choose_early_action,
    choose_early_survival_action,
    choose_s3_preflight_action,
    choose_s3_resource_action,
    choose_s4_preflight_action,
    choose_s4_resource_action,
    mark_s4_known_no_safe_stair,
    normalize_s5_portal_transition,
    record_s4_descent_success,
    record_s4_diamond_outcome,
    record_s4_horizontal_fallback_success,
    record_s4_wood_search_outcome,
    s4_method_key,
    s5_portal_hint,
    verify_s4_depth_reached,
)

def _s3_relocation_emergency(state: dict[str, Any]) -> bool:
    try:
        health = float(state.get("health", 0))
        food = float(state.get("food", 0))
    except (TypeError, ValueError):
        return True
    return not math.isfinite(health) or not math.isfinite(food) or health <= 10 or food < 8 or _danger_now(state)


class GoalSupervisor:
    """持久化目标闭环：观察、选择方法动作、核验、依赖修复与对账。"""

    def __init__(
        self,
        goal: GoalSpec,
        store: TaskStore,
        dispatch: Dispatch,
        state_provider: StateProvider,
        *,
        action_status: StatusQuery | None = None,
        announce: Announce | None = None,
        state_age_provider: StateAge | None = None,
        observation_event: asyncio.Event | None = None,
        require_protocol: bool = True,
        verifier: Verifier | None = None,
    ) -> None:
        self.goal = goal
        self.store = store
        self.dispatch = dispatch
        self.state_provider = state_provider
        self.action_status = action_status
        self.announce = announce
        self.state_age_provider = state_age_provider
        self._observation_event = observation_event
        self.require_protocol = require_protocol
        self.verifier = verifier or Verifier()
        self.task_id: int | None = None
        self.state: dict[str, Any] = {}
        self._stop_requested = False
        self._cached_state: dict[str, Any] = {}

    def stop(self, reason: str = "user_stop") -> None:
        persisted = self.store.load_goal_state(self.task_id) if self.task_id is not None else None
        status = str((persisted or self.state).get("status") or "")
        if status in GOAL_IMMUTABLE_STATES:
            self.state = dict(persisted or self.state)
            return
        self._stop_requested = True
        if self._observation_event is not None:
            self._observation_event.set()
        if not self.state:
            return
        self.state["status"] = "paused_by_user"
        self.state["block_reason"] = reason
        self.state["updated_at"] = time.time()
        if self.task_id is not None:
            self.store.save_goal_state(self.task_id, self.state)
            self.store.set_status(self.task_id, "cancelled")

    def snapshot(self) -> dict[str, Any]:
        return dict(self.state)

    def on_progress(self, progress: dict[str, Any]) -> bool:
        pending = self.state.get("pending_action")
        if not isinstance(pending, dict) or str(pending.get("action_id") or "") != str(progress.get("action_id") or ""):
            return False
        expected_session = str(pending.get("session_id") or "")
        progress_session = str(progress.get("session_id") or "")
        current = dict(self.state_provider() or {})
        current_session = str(current.get("session_id") or "")
        if expected_session and progress_session and expected_session != progress_session:
            return False
        if current_session and progress_session and current_session != progress_session:
            return False
        expected_revision = self._maybe_int(pending.get("revision"))
        progress_revision = self._maybe_int(progress.get("state_revision"))
        if expected_revision is not None and progress_revision is not None and progress_revision < expected_revision:
            return False
        entries = pending.setdefault("progress", [])
        if not isinstance(entries, list):
            entries = []
            pending["progress"] = entries
        entries.append(
            {
                "phase": str(progress.get("phase") or ""),
                "progress": progress.get("progress"),
                "session_id": progress_session,
                "state_revision": progress_revision,
                "executor_epoch": progress.get("executor_epoch"),
                "data": dict(progress.get("data") or {}),
                "detail": str(progress.get("detail") or ""),
                "received_at": time.time(),
            }
        )
        del entries[:-32]
        self._save()
        if self.task_id is not None:
            self.store.log_event(
                self.task_id,
                "goal_action_progress",
                {"action_id": pending["action_id"], "phase": progress.get("phase"), "progress": progress.get("progress"), "data": progress.get("data") or {}},
            )
        return True

    async def run(self, task_id: int, *, resume: bool = False) -> dict[str, Any]:
        self.task_id = task_id
        saved = self.store.load_goal_state(task_id) if resume else None
        if saved and saved.get("status") == "paused_by_user":
            return self._result(False, "cancelled", str(saved.get("block_reason") or "目标由用户停止"))
        if saved and saved.get("status") == "done":
            self.state = saved
            self.store.set_status(task_id, "done")
            return self._result(True, "done", str(saved.get("detail") or "持久化目标已完成"))
        if saved and isinstance(saved.get("unresolved_action"), dict):
            self.state = saved
            unresolved = saved["unresolved_action"]
            current = dict(self.state_provider() or {})
            if (unresolved.get("tool") == "fight_dragon" and unresolved.get("status") == "preempted"
                    and unresolved.get("receipt_confirmed") is True and str(current.get("dimension")).removeprefix("minecraft:") == "the_end"):
                # 重连时地形往往先于实体和 Boss 栏到达。等待同一末地内的服务器观察。
                deadline = min(time.monotonic() + 10, time.monotonic() + max(0.0, float(saved.get("deadline_at", 0)) - time.time()))
                while not current.get("end_dragon") and time.monotonic() < deadline and not self._stop_requested:
                    if self._observation_event is not None:
                        self._observation_event.clear()
                    await self._wait_for_observation(timeout=deadline - time.monotonic())
                    current = dict(self.state_provider() or {})
                    if str(current.get("dimension")).removeprefix("minecraft:") != "the_end":
                        break
            if self._migrate_known_s3_stripmine_terminal(saved["unresolved_action"]):
                saved = self.state
            elif self._late_action_recovery(unresolved, current):
                self.state.pop("unresolved_action")
                self.state["pending_action"] = None
                self.state["status"] = "active"
                self.state["block_reason"] = ""
                self._save()
            else:
                reason = str(saved.get("block_reason") or "非重放动作结果缺少可验证证据")
                self.state["status"] = "blocked"
                self._save()
                self.store.set_status(task_id, "blocked")
                return self._result(False, "blocked", reason)
        if resume and saved is not None:
            recovery = saved.setdefault("recovery", {})
            if recovery.get("reason") != "known_terminal_s3_stripmine_replanned_from_fresh_observation":
                recovery["reason"] = "explicit_resume"
            search = saved.get("stronghold_search")
            recovery["s6_explicit_search_resume"] = bool(
                self.goal.stage == "S6"
                and isinstance(search, dict)
                and search.get("phase") == "blocked"
                and search.get("resume_allowed") is True
            )
        self.state = saved or self._new_state()
        self.state["schema_version"] = GOAL_STATE_VERSION
        self.state["goal_id"] = self.goal.goal_id
        self.state["stage"] = self.goal.stage
        self.state["title"] = self.goal.title
        self.state.setdefault("method_id", self.goal.method_id)
        self.state.setdefault("created_at", time.time())
        self.state.setdefault("deadline_at", time.time() + self.goal.budget.max_elapsed_s)
        budget = self.state.setdefault("budget", asdict(self.goal.budget))
        budget.setdefault("max_transport_recoveries", self.goal.budget.max_transport_recoveries)
        counters = self.state.setdefault("counters", {"actions": 0, "attempts": {}})
        counters.setdefault("admission_retries", {})
        counters.setdefault("admission_rejections_total", {})
        self._initialize_recovery_budgets()
        self.state.setdefault("method_index", 0)
        self.state.setdefault("recovery", {"reason": "", "needs_reconcile": resume, "baseline_session_id": "", "baseline_revision": None})
        self.state.setdefault("night_required", False)
        self.state.setdefault("sleep_confirmed", False)
        self.state["status"] = "active"
        self.state["updated_at"] = time.time()
        if self._stop_requested:
            self.state["status"] = "paused_by_user"
            self.state["block_reason"] = "目标由用户停止"
            self._save()
            self.store.set_status(task_id, "cancelled")
            return self._result(False, "cancelled", "目标由用户停止")
        self._save()
        if resume:
            self.store.log_event(task_id, "goal_recovery_started", {"goal_id": self.goal.goal_id})

        try:
            pending = self.state.get("pending_action")
            has_pending_action = isinstance(pending, dict)
            expired = time.time() >= float(self.state.get("deadline_at") or 0)
            if expired and not has_pending_action:
                return self._block("budget_elapsed", "目标执行时长预算耗尽")
            reconciliation_baseline = (
                self._pending_reconciliation_baseline(pending)
                if has_pending_action
                else None
            )
            state = await self._wait_for_usable_state(after=reconciliation_baseline)
            if state is None:
                status = str(self.state.get("status") or "blocked")
                return self._result(False, status, str(self.state.get("block_reason") or "等待新鲜世界观察超时"))
            recovery = self.state.setdefault("recovery", {})
            if has_pending_action and not recovery.get("needs_reconcile"):
                recovery.update(
                    {
                        "needs_reconcile": True,
                        "reason": "pending_action_requires_fresh_observation",
                    }
                )
                self._save()
            if recovery.get("needs_reconcile"):
                recovered = await self._reconcile_pending(state)
                if not recovered:
                    return self._result(False, str(self.state.get("status") or "unknown"), str(self.state.get("block_reason") or "动作结果待对账"))
            if time.time() >= float(self.state.get("deadline_at") or 0):
                if has_pending_action:
                    self._record_observation(state)
                return self._block("budget_elapsed", "目标执行时长预算耗尽")
            preemptions = 0
            while True:
                if self._stop_requested:
                    self.stop()
                    return self._result(False, "cancelled", "目标由用户停止")
                if time.time() >= float(self.state.get("deadline_at") or 0):
                    return self._block("budget_elapsed", "目标执行时长预算耗尽")
                state = await self._wait_for_usable_state()
                if state is None:
                    return self._result(False, str(self.state.get("status") or "blocked"), str(self.state.get("block_reason") or "世界未就绪"))
                self._record_observation(state)
                context = self._condition_context(state)
                completed_events = self._completed_events()
                complete, reason = evaluate_condition(
                    self.goal.acceptance,
                    state,
                    completed_events=completed_events,
                    context=context,
                )
                self.state["night_required"] = bool(context.get("night_required"))
                self.state["sleep_confirmed"] = bool(context.get("sleep_confirmed"))
                self._save()
                if complete and not (self.goal.stage == "S3" and self.state.get("s3_low_oxygen_relocation_required")):
                    return await self._complete(reason)
                if self._transport_recovery_budget_exhausted():
                    return self._block_transport_recovery_budget()
                if int((self.state.get("counters") or {}).get("actions", 0)) >= self.goal.budget.max_actions:
                    return self._block("budget_actions", "目标动作预算耗尽")

                supply = (None if self.goal.stage == "S3" and self.state.get("s3_low_oxygen_relocation_required")
                          else choose_supply_opportunity(self.goal.stage, state, self.state))
                if supply is not None:
                    step, method_key = supply
                    step_index = None
                elif self.goal.stage in {"S0", "S1"}:
                    step = choose_early_survival_action(state) or choose_early_action(self.goal.stage, state)
                    if step is None:
                        return self._block("early_dependencies", "目标未验收且没有可执行依赖")
                    resource = step.arguments.get("block") or step.arguments.get("item") or "default"
                    method_key = f"{self.goal.stage.lower()}:{step.tool}:{resource}"
                    step_index = None
                elif self.goal.stage == "S2":
                    step = choose_s2_action(state, self.state)
                    if step is None:
                        self.state["status"] = "waiting"
                        self.state["block_reason"] = "等待下一次夜晚或新鲜状态变化"
                        self._save()
                        await self._wait_for_observation()
                        continue
                    method_key = f"s2:{step.tool}:{step.arguments.get('block') or step.arguments.get('item') or 'default'}"
                    if method_key == "s2:hunt_material:wool":
                        region = int(self.state.get("s2_wool_search_region", 0))
                        if region:
                            method_key += f":region{region}"
                        if self._method_failure_count(method_key) >= self.goal.budget.max_attempts_per_method:
                            position = state.get("position") or {}
                            if not all(self._finite_number(position.get(axis)) for axis in "xyz"):
                                return self._block("s2_wool_position_unknown", "缺少有效坐标，无法安全换区找羊")
                            avoid = list(self.state.get("s2_wool_avoid_positions") or [])
                            origin = {axis: float(position[axis]) for axis in "xyz"}
                            if not any(math.hypot(p["x"] - origin["x"], p["z"] - origin["z"]) < 8 for p in avoid):
                                avoid.append(origin)
                            self.state["s2_wool_avoid_positions"] = avoid[-128:]
                            step = StepSpec("离开已搜索区域，寻找新的羊群", "explore_mining_site",
                                            {"min_distance": 24, "avoid_positions": avoid[-128:]},
                                            {"type": "s2_wool_relocation", "min_distance": 24},
                                            retries=1, timeout_s=180.0, effect_class="replan")
                            method_key = f"s2:wool_relocate:region{region}"
                    step_index: int | None = None
                elif self.goal.stage == "S3":
                    relocation_required = bool(self.state.get("s3_low_oxygen_relocation_required"))
                    preflight_ready, preflight_step = ((True, None) if relocation_required and not _s3_relocation_emergency(state)
                                                       else choose_s3_preflight_action(state, self.state))
                    if not preflight_ready and preflight_step is None:
                        terminal_reason = str(self.state.pop("s3_preflight_terminal_reason", "") or "")
                        if terminal_reason:
                            return self._block("s3_preflight_route_exhausted", terminal_reason)
                        self.state["status"] = "waiting"
                        self.state["block_reason"] = str(
                            self.state.get("s3_preflight_wait_reason")
                            or "等待 S3 下矿前置条件满足"
                        )
                        self._save()
                        await self._wait_for_observation()
                        continue
                    step = preflight_step or choose_s3_resource_action(state, self.state)
                    if step is None:
                        if self.state.get("s3_preflight_wait_reason"):
                            self.state["status"] = "waiting"
                            self.state["block_reason"] = self.state["s3_preflight_wait_reason"]
                            self._save()
                            await self._wait_for_observation()
                            continue
                        return self._block(
                            "s3_ore_route_exhausted",
                            str(self.state.get("s3_resource_block_reason") or "当前观察下没有可执行的 S3 资源动作"),
                        )
                    step_index = None
                    resource = step.arguments.get("block") or step.arguments.get("item") or "default"
                    if step.tool == "mine_collect" and resource in {"iron_ore", "deepslate_iron_ore"}:
                        resource = f"{resource}:raw{inventory_count(state.get('inventory') or {}, 'raw_iron')}:region{int(self.state.get('s3_ore_regions', 0))}:route{int(self.state.get('s3_ore_expose_used', 0))}"
                    if step.tool == "smelt_batch":
                        resource = f"raw{inventory_count(state.get('inventory') or {}, 'raw_iron')}:ingot{inventory_count(state.get('inventory') or {}, 'iron_ingot')}"
                    if step.tool == "goto":
                        method_key = (f"s3:ore_return_surface:{int(self.state.get('s3_ore_regions', 0))}"
                                      if step.description == "换矿区受阻，沿已知庇护所路线返回地表"
                                      else "s3:surface_route:shelter_anchor")
                    elif step.tool == "mine_collect" and resource == "wood_log" and step.arguments.get("within_reach"):
                        method_key = "s3:surface_fuel_wood"
                    elif step.tool == "mine_collect" and resource in {*S3_OVERWORLD_WOOD_LOGS, "wood_log"}:
                        context = _s3_wood_search_context(state) or "unknown"
                        method_key = f"s3:wood_search:{context}:{resource}"
                        if resource == "wood_log":
                            step = replace(step, arguments={**step.arguments, "surface_wood": True})
                            if self._method_failure_count(method_key):
                                step, method_key = self._expand_wood_search(step, state, method_key)
                    else:
                        method_key = f"s3:{step.tool}:{resource}"
                    if step.tool == "strip_mine":
                        method_key = f"s3:ore_expose:region{int(self.state.get('s3_ore_regions', 0))}:{int(self.state.get('s3_ore_expose_used', 0)) + 1}"
                    elif step.tool == "explore_mining_site" and step.verify.get("type") == "s3_mining_relocation":
                        method_key = f"s3:ore_relocate:{int(self.state.get('s3_ore_regions', 0))}"
                elif self.goal.stage == "S4":
                    preflight_ready, preflight_step = choose_s4_preflight_action(state, self.state)
                    if not preflight_ready and preflight_step is None:
                        block_reason = str(self.state.get("s4_preflight_block_reason") or "")
                        if block_reason:
                            return self._block("s4_preflight_blocked", block_reason)
                        self.state["status"] = "waiting"
                        self.state["block_reason"] = str(
                            self.state.get("s4_preflight_wait_reason")
                            or "等待 S4 下矿前置条件满足"
                        )
                        self._save()
                        await self._wait_for_observation()
                        continue
                    self.state.pop("s4_resource_block_reason", None)
                    step = preflight_step or choose_s4_resource_action(state, self.state)
                    if step is None:
                        return self._block(
                            "s4_resource_route_exhausted",
                            str(self.state.get("s4_resource_block_reason") or "当前观察下没有可执行的 S4 资源动作"),
                        )
                    step_index = None
                    method_key = s4_method_key(step, state, self.state)
                elif self.goal.stage == "S5":
                    step, step_index = choose_s5_action(state, self.state)
                    step, step_index = prepare_late_action(step, step_index, state, self.state)
                    if step is None:
                        if self.state.get("late_game_wait_reason"):
                            self.state["status"] = "waiting"
                            self.state["block_reason"] = self.state["late_game_wait_reason"]
                            self._save()
                            await self._wait_for_observation()
                            continue
                        return self._block("s5_dependencies", str(self.state.get("late_game_block_reason") or "等待 S5 补给或可用路线"))
                    method_key = late_method_key("S5", step)
                    if step.tool == "raid_fortress" and step.arguments.get("scout_only") and self._finite_position(state.get("position")):
                        position = state["position"]
                        method_key += f":{math.floor(position['x'] / 48)}:{math.floor(position['z'] / 48)}"
                    if step.tool == "collect_obsidian":
                        step, method_key = self._s5_obsidian_site(step, state, method_key)
                        if step.tool != "collect_obsidian":
                            step_index = None
                elif (self.goal.stage == "S6" and isinstance(self.state.get("stronghold_search"), dict)
                      and self.state["stronghold_search"].get("phase") != "frames_found"
                      and str(state.get("dimension") or "").removeprefix("minecraft:") == "overworld"):
                    search = self.state["stronghold_search"]
                    if search.get("phase") not in {"descend", "bearing"}:
                        recovery = self.state.get("recovery")
                        explicitly_resuming = isinstance(recovery, dict) and (
                            recovery.get("reason") == "explicit_resume"
                            or recovery.get("s6_explicit_search_resume") is True
                        )
                        if search.get("phase") == "blocked" and search.get("resume_allowed") is True and explicitly_resuming:
                            # 显式恢复只重试保存的搜索；Bridge 会重新核对安全条件和门框。
                            search = {**search, "phase": "descend", "resume_allowed": False}
                        else:
                            return self._block(
                                "s6_stronghold_search_stopped",
                                str(search.get("stop_reason") or "本次要塞搜索没有可安全续跑的下探阶段；不会重投末影之眼"),
                            )
                    search_id = str(search.get("search_id") or "")
                    if not search_id:
                        return self._block("s6_stronghold_search_id_missing", "要塞搜索账本缺少 search_id；不会重投末影之眼")
                    descent = search.get("descent")
                    try:
                        layers = int(descent.get("layers_completed", 0)) if isinstance(descent, dict) else -1
                        max_layers = int(descent.get("max_layers", 0)) if isinstance(descent, dict) else 0
                        segment_layers = int(descent.get("segment_layers", 0)) if isinstance(descent, dict) else 0
                    except (TypeError, ValueError, OverflowError):
                        layers, max_layers, segment_layers = -1, 0, 0
                    if (
                        not 0 <= layers <= S6_STRONGHOLD_MAX_DESCENT_LAYERS
                        or not 1 <= max_layers <= S6_STRONGHOLD_MAX_DESCENT_LAYERS
                        or layers > max_layers
                        or not 1 <= segment_layers <= S6_STRONGHOLD_SEGMENT_LAYERS
                    ):
                        return self._block("s6_stronghold_search_invalid_budget", "要塞搜索下探账本无效；不会重投末影之眼")
                    if layers >= S6_STRONGHOLD_MAX_DESCENT_LAYERS:
                        return self._block("s6_stronghold_descent_budget", "要塞下探层数预算耗尽；没有观察到门框")
                    step = StepSpec(
                        "安全分段下探并新扫描要塞门框",
                        "throw_eye",
                        {"resume_search": dict(search)},
                        {"type": "always"},
                        retries=0,
                        timeout_s=120,
                        effect_class="non_replayable",
                    )
                    step_index = None
                    method_key = f"s6:stronghold_search:{search_id}:layer:{layers}"
                    if search.get("phase") == "bearing":
                        used = search["eye_accounting"]["throws_completed"]
                        step = replace(step, description="从已观察的投眼方向恢复定位",
                                       arguments={**S6_STEPS[6].arguments, "count": search["throw_limit"], "resume_search": dict(search)},
                                       timeout_s=310)
                        method_key = f"s6:stronghold_search:{search_id}:bearing:{used}"
                elif self.goal.stage == "S6":
                    step, step_index = choose_s6_action(state, self.state, completed_events)
                    step, step_index = prepare_late_action(step, step_index, state, self.state)
                    if step is None:
                        if self.state.get("late_game_wait_reason"):
                            self.state["status"] = "waiting"
                            self.state["block_reason"] = self.state["late_game_wait_reason"]
                            self._save()
                            await self._wait_for_observation()
                            continue
                        return self._block("s6_dependencies", str(self.state.get("late_game_block_reason") or "等待 S6 补给或可用路线"))
                    method_key = late_method_key("S6", step)
                else:
                    steps = self._method_steps()
                    step_index = int(self.state.get("method_index", 0))
                    while step_index < len(steps):
                        candidate = steps[step_index]
                        if candidate.verify.get("type") != "always":
                            verified, _ = self.verifier.check(candidate.verify, state)
                            if verified:
                                self.state["method_index"] = step_index + 1
                                self._save()
                                self.store.log_event(task_id, "method_step_reconciled", {"index": step_index, "tool": candidate.tool})
                                step_index += 1
                                continue
                        break
                    self.state["method_index"] = step_index
                    self._save()
                    if step_index >= len(steps):
                        if not self.state.get("replanned_after_method_exhaustion"):
                            self.state["method_index"] = 0
                            self.state["replanned_after_method_exhaustion"] = True
                            self.store.log_event(task_id, "method_replanned_from_observation", {"reason": reason})
                            self._save()
                            continue
                        return self._block("method_exhausted", f"方法已执行完，但目标条件仍不满足：{reason}")
                    step = steps[step_index]
                    method_key = f"{self.goal.method_id}:{step_index}"

                if (
                    self.goal.stage == "S5"
                    and step.tool == "nether_travel"
                ):
                    portal_hint = s5_portal_hint(self.state, state)
                    if portal_hint is not None:
                        step = replace(
                            step,
                            arguments={**step.arguments, "portal_hint": portal_hint},
                        )

                step = batch_resource_step(self.goal.stage, step, state)
                outcome = await self._execute_step(step, method_key, step_index)
                if outcome == "preempted":
                    preemptions += 1
                    if preemptions > MAX_PREEMPTIONS:
                        return self._block("preemption_budget", "安全抢占次数超出目标重评预算")
                    safe_state = await self._wait_after_safety()
                    if safe_state is None:
                        return self._result(False, "preempted", "等待 Bridge 安全动作完成与新观察")
                    pending = self.state.get("pending_action")
                    if isinstance(pending, dict) and pending.get("status") in {"preempted", "cancelled"}:
                        resolved = self._resolve_interrupted_action(
                            pending,
                            str(pending.get("status")),
                            safe_state,
                            dict(pending.get("result_data") or {}),
                        )
                        if not resolved:
                            return self._result(False, str(self.state.get("status") or "blocked"), str(self.state.get("block_reason") or "中断动作需要处理"))
                    verified_goal, _ = evaluate_condition(
                        self.goal.acceptance,
                        safe_state,
                        completed_events=self._completed_events(),
                        context=self._condition_context(safe_state),
                    )
                    if verified_goal and not (self.goal.stage == "S3" and self.state.get("s3_low_oxygen_relocation_required")):
                        return await self._complete("抢占后的新观察满足目标")
                    # 抢占不计方法失败和重试预算，重新读取依赖后再选择方法。
                    continue
                if self._stop_requested:
                    self.stop()
                    return self._result(False, "cancelled", "目标由用户停止")
                preemptions = 0
                if outcome == "waiting":
                    return self._result(False, "waiting", str(self.state.get("block_reason") or "等待新鲜观察"))
                if outcome == "unknown":
                    return self._result(False, "unknown", str(self.state.get("block_reason") or "动作结果未知，保留 action_id 等待对账"))
                if outcome == "failed":
                    return self._block(
                        "budget_method_attempts",
                        str(self.state.get("block_reason") or "目标方法失败次数达到上限"),
                    )
                if outcome in {"dead", "disconnected", "cancelled", "blocked", "failed"}:
                    return self._result(False, outcome, str(self.state.get("block_reason") or outcome))
        except asyncio.CancelledError:
            if self._stop_requested:
                self.stop()
                return self._result(False, "cancelled", "目标由用户停止")
            if self.state.get("status") in {"done", "paused_by_user", "cancelled", "blocked"}:
                # 完成播报/blocked 状态收尾期间的 Core shutdown 不应复活终态任务。
                self._save()
                raise
            recovery = self.state.setdefault("recovery", {})
            recovery["needs_reconcile"] = True
            recovery["reason"] = "core_restart"
            self.state["status"] = "recovering"
            self.state["block_reason"] = "Core 停止時保留目标，等待重连后对账"
            self._save()
            self.store.set_status(task_id, "disconnected")
            raise

    def _new_state(self) -> dict[str, Any]:
        now = time.time()
        return {
            "schema_version": GOAL_STATE_VERSION,
            "goal_id": self.goal.goal_id,
            "stage": self.goal.stage,
            "title": self.goal.title,
            "status": "active",
            "method_id": self.goal.method_id,
            "method_index": 0,
            "created_at": now,
            "deadline_at": now + self.goal.budget.max_elapsed_s,
            "budget": asdict(self.goal.budget),
            "counters": {
                "actions": 0,
                "attempts": {},
                "method_failures": {},
                "transport_recoveries": 0,
                "transport_recovery_action_ids": [],
                "recovery_budget_version": RECOVERY_BUDGET_VERSION,
                "admission_retries": {},
                "admission_rejections_total": {},
            },
            "pending_action": None,
            "recovery": {"reason": "", "needs_reconcile": False, "baseline_session_id": "", "baseline_revision": None},
            "s4_terminal_action_events": {},
            "night_required": False,
            "sleep_confirmed": False,
            "block_reason": "",
        }

    def _save(self) -> None:
        if self.task_id is None:
            return
        persisted = self.store.load_goal_state(self.task_id)
        persisted_status = str((persisted or {}).get("status") or "")
        next_status = str(self.state.get("status") or "")
        explicit_resume = str((self.state.get("recovery") or {}).get("reason") or "") == "explicit_resume"
        if persisted_status in GOAL_IMMUTABLE_STATES and next_status not in GOAL_IMMUTABLE_STATES:
            self.state = dict(persisted or self.state)
            return
        if (
            goal_state_blocks_automatic_transition(persisted_status)
            and next_status != persisted_status
            and not explicit_resume
        ):
            # 保持用户暂停/blocked 作为当前状态，但仍持久化取消竞态产生的
            # pending receipt、结构化进度与恢复元数据。
            self.state["status"] = persisted_status
            if persisted is not None:
                self.state["block_reason"] = persisted.get("block_reason", self.state.get("block_reason", ""))
        self.state["updated_at"] = time.time()
        self.store.save_goal_state(self.task_id, self.state)

    def _result(self, ok: bool, status: str, detail: str) -> dict[str, Any]:
        return {
            "ok": ok,
            "status": status,
            "goal_id": self.goal.goal_id,
            "stage": self.goal.stage,
            "detail": detail,
            "method_index": int(self.state.get("method_index", 0)),
            "actions": int((self.state.get("counters") or {}).get("actions", 0)),
            "block_reason": self.state.get("block_reason", ""),
        }

    def _block(self, reason: str, detail: str) -> dict[str, Any]:
        self.state["status"] = "blocked"
        self.state["block_reason"] = reason
        self.state["detail"] = detail
        self._save()
        if self.task_id is not None:
            self.store.set_status(self.task_id, "blocked")
            self.store.log_event(self.task_id, "goal_blocked", {"goal_id": self.goal.goal_id, "reason": reason, "detail": detail})
        return self._result(False, "blocked", detail)

    async def _handle_admission_rejection(
        self,
        pending: dict[str, Any],
        data: dict[str, Any],
        method_key: str,
    ) -> str | None:
        admission = data.get("admission")
        if not isinstance(admission, dict) or not (
            admission.get("started") is False
            and admission.get("retryable") is True
            and admission.get("reason") == "stale_observation"
        ):
            return None

        counters = self.state.setdefault("counters", {"actions": 0, "attempts": {}})
        retries = counters.setdefault("admission_retries", {})
        lifetime_rejections = counters.setdefault("admission_rejections_total", {})
        retry_count = int(retries.get(method_key, 0)) + 1
        retries[method_key] = retry_count
        lifetime_rejections[method_key] = int(lifetime_rejections.get(method_key, 0)) + 1
        pending["status"] = "rejected_before_start"
        pending["result_data"] = data
        pending["resolved_at"] = time.time()
        history = self.state.setdefault("action_history", [])
        history.append(pending)
        del history[:-128]
        self.state["pending_action"] = None
        counters["actions"] = max(0, int(counters.get("actions", 0)) - 1)

        baseline_session = str(pending.get("session_id") or "")
        baseline_revision = self._maybe_int(pending.get("revision"))
        recovery = self.state.setdefault("recovery", {})
        recovery.update(
            {
                "needs_reconcile": False,
                "reason": "stale_observation_admission",
                "baseline_session_id": baseline_session,
                "baseline_revision": baseline_revision,
            }
        )
        self.store.log_event(
            self.task_id,
            "action_rejected_before_start",
            {
                "action_id": pending.get("action_id"),
                "method_key": method_key,
                "retry": retry_count,
                "reason": "stale_observation",
            },
        )
        if retry_count >= MAX_ADMISSION_RETRIES:
            self._block(
                "budget_admission_retries",
                f"方法 {method_key} 因 stale_observation 连续被 Bridge 拒绝 {retry_count} 次",
            )
            return "blocked"

        current = dict(self.state_provider() or {})
        usable, reason = self._state_usable(
            current,
            after=(baseline_session, baseline_revision),
        )
        if not usable:
            self.state["status"] = "waiting"
            self.state["block_reason"] = f"动作未执行；等待新的 ready observation：{reason}"
            self._save()
            return "waiting"

        self.state["status"] = "active"
        self.state["block_reason"] = ""
        self._save()
        return "retry"

    def _reset_admission_retry_streak(self, method_key: str) -> None:
        """已收到非 stale 的 Bridge 回执后，清除此方法连续准入拒绝数。"""
        counters = self.state.setdefault("counters", {})
        retries = counters.setdefault("admission_retries", {})
        if int(retries.get(method_key, 0)):
            retries[method_key] = 0

    async def _complete(self, detail: str) -> dict[str, Any]:
        persisted = self.store.load_goal_state(self.task_id) if self.task_id is not None else None
        persisted_status = str((persisted or {}).get("status") or "")
        if persisted_status == "done":
            self.state = dict(persisted or self.state)
            return self._result(True, "done", str(self.state.get("detail") or detail))
        if persisted_status in {"paused_by_user", "cancelled"}:
            self.state = dict(persisted or self.state)
            return self._result(False, "cancelled", str(self.state.get("block_reason") or "目标由用户停止"))
        self.state["status"] = "done"
        self.state["block_reason"] = ""
        self.state["detail"] = detail
        self.state["pending_action"] = None
        assert self.task_id is not None
        self.state["updated_at"] = time.time()
        self.store.complete_goal(self.task_id, self.state)
        self.store.log_event(self.task_id, "goal_done", {"goal_id": self.goal.goal_id, "evidence": self.state.get("last_observation", {})})
        if self.announce is not None:
            await self.announce(f"目标「{self.goal.title}」已由当前观察验收完成。")
        return self._result(True, "done", detail)

    def _method_steps(self) -> tuple[StepSpec, ...]:
        from voxkin.agent.goals import method_for_goal

        return method_for_goal(self.goal).steps

    def _s4_action_event_seen(self, pending: dict[str, Any], event: str) -> bool:
        action_id = str(pending.get("action_id") or "")
        if not action_id:
            return False
        receipts = self.state.setdefault("s4_terminal_action_events", {})
        if not isinstance(receipts, dict):
            receipts = {}
            self.state["s4_terminal_action_events"] = receipts
        return event in (receipts.get(action_id) or [])

    def _mark_s4_action_event(self, pending: dict[str, Any], event: str) -> None:
        action_id = str(pending.get("action_id") or "")
        if not action_id:
            return
        receipts = self.state.setdefault("s4_terminal_action_events", {})
        if not isinstance(receipts, dict):
            receipts = {}
            self.state["s4_terminal_action_events"] = receipts
        events = receipts.setdefault(action_id, [])
        if event not in events:
            events.append(event)

    def _s4_fresh_terminal_observation(
        self,
        pending: dict[str, Any],
        status: str,
        state: dict[str, Any],
        data: dict[str, Any],
    ) -> dict[str, Any] | None:
        for observation in (state, data.get("observation")):
            if isinstance(observation, dict) and _fresh_terminal_state(pending, status, observation):
                return observation
        return None

    def _verify_pending_method_condition(
        self,
        condition: dict[str, Any],
        state: dict[str, Any],
        pending: dict[str, Any],
        status: str,
        data: dict[str, Any],
    ) -> tuple[bool, str]:
        if self.goal.stage == "S5" and condition.get("type") == "s5_shaft_displacement":
            observation = _fresh_terminal_observation(pending, data)
            origin = pending.get("baseline_position")
            end = (observation or {}).get("position")
            if (not self._finite_position(origin) or not self._finite_position(end)
                    or pending.get("receipt_confirmed") is not True or not _fresh_terminal_state(pending, status, state)):
                return False, "换竖井缺少新鲜位置回执"
            distance = math.hypot(end["x"] - origin["x"], end["z"] - origin["z"])
            return status == "succeeded" and distance >= 4, f"已观察到水平位移 {distance:.1f} 格"
        if (self.goal.stage, condition.get("type")) in {
            ("S3", "s3_mining_relocation"), ("S3", "s3_wood_relocation"), ("S2", "s2_wool_relocation"),
            ("S5", "s5_obsidian_relocation"),
        }:
            observation = _fresh_terminal_observation(pending, data)
            if status != "succeeded" or pending.get("receipt_confirmed") is not True or observation is None or not _fresh_terminal_state(pending, status, state):
                return False, "换矿区缺少成功回执及同 session 新鲜观察"
            relocation = data.get("relocation") or {}
            origin = relocation.get("origin") or {}
            destination = relocation.get("destination") or {}
            actual = observation.get("position") or {}
            baseline = pending.get("baseline_position") or {}
            try:
                numbers = [float(p[a]) for p in (origin, destination, actual, baseline) for a in "xyz"]
                if not all(math.isfinite(v) for v in numbers):
                    raise ValueError
                distance = math.hypot(actual["x"] - origin["x"], actual["z"] - origin["z"])
                baseline_error = math.dist([origin[a] for a in "xyz"], [baseline[a] for a in "xyz"])
                endpoint_error = math.dist([actual[a] for a in "xyz"], [destination[a] for a in "xyz"])
                avoid = (pending.get("arguments") or {}).get("avoid_positions") or []
                if distance < float(condition.get("min_distance", 16)) or baseline_error > 3 or endpoint_error > 3:
                    return False, "换矿区实际位置或位移未达要求"
                if any(math.hypot(actual["x"] - p["x"], actual["z"] - p["z"]) < 8 for p in avoid):
                    return False, "换矿区仍在已尝试区域"
            except (TypeError, ValueError, KeyError):
                return False, "换矿区坐标无效"
            return True, "已在新鲜观察中确认换矿区"
        if self.goal.stage == "S4" and condition.get("type") == "s4_depth_reached":
            if status not in {"succeeded", "blocked", "failed"}:
                return False, f"S4 下探只接受 confirmed terminal receipt，当前状态={status}"
            observation = self._s4_fresh_terminal_observation(pending, status, state, data)
            if observation is None:
                return False, "等待同一 Bridge session 中 revision 前进后的 S4 下探观察"
            return verify_s4_depth_reached(condition, observation)
        return self._verify_method_condition(condition, state)

    def _s5_portal_result(
        self,
        pending: dict[str, Any],
        status: str,
        state: dict[str, Any],
        data: dict[str, Any],
    ) -> tuple[dict[str, Any] | None, dict[str, Any] | None, str]:
        if status != "succeeded" or pending.get("receipt_confirmed") is not True:
            return None, None, "nether_travel 缺少 succeeded 状态或明确动作回执"
        admission = data.get("admission")
        if not isinstance(admission, dict):
            admission = pending.get("admission")
        if isinstance(admission, dict) and admission.get("started") is False:
            return None, None, "动作在 Bridge admission 阶段未启动，不能保存 portal transition"
        observation = _fresh_terminal_observation(pending, data)
        if observation is None:
            return None, None, "nether_travel 回执缺少同 session 的 fresh observation"
        transition = normalize_s5_portal_transition(data.get("portal_transition"))
        if transition is None:
            return None, None, "portal_transition 缺少原版维度的实测源门或抵达锚点"
        expected_dimension = canonical_s5_portal_dimension(
            (pending.get("expected_condition") or {}).get("value")
        )
        target_dimension = transition["target"]["dimension"]
        source_dimension = transition["source"]["dimension"]
        if expected_dimension not in {"minecraft:overworld", "minecraft:the_nether"}:
            return None, None, "nether_travel 的验收条件不是精确原版维度"
        if target_dimension != expected_dimension or source_dimension == target_dimension:
            return None, None, "portal_transition 的来源/抵达维度与目标维度不吻合"
        observation_session = str(observation.get("session_id") or "")
        state_session = str(state.get("session_id") or "")
        baseline_session = str(pending.get("session_id") or "")
        observation_revision = self._maybe_int(observation.get("revision"))
        state_revision = self._maybe_int(state.get("revision"))
        baseline_revision = self._maybe_int(pending.get("revision"))
        if (
            not baseline_session
            or observation_session != baseline_session
            or observation_revision is None
            or baseline_revision is None
            or observation_revision <= baseline_revision
        ):
            return None, None, "portal transition receipt 与当前 session/revision 不匹配"
        if state_session == baseline_session:
            if state_revision is None or state_revision < observation_revision:
                return None, None, "portal transition 当前 observation 早于 terminal observation"
        else:
            usable, reason = self._state_usable(state)
            if not usable:
                return None, None, f"重连后的 portal observation 不可用：{reason}"
        if (
            canonical_s5_portal_dimension(observation.get("dimension")) != target_dimension
            or canonical_s5_portal_dimension(state.get("dimension")) != target_dimension
        ):
            return None, None, "portal transition 抵达维度与当前 fresh observation 不匹配"
        position = observation.get("position")
        if not isinstance(position, dict):
            return None, None, "portal transition observation 缺少抵达坐标"
        for axis in "xyz":
            coordinate = position.get(axis)
            if isinstance(coordinate, bool):
                return None, None, "portal transition observation 坐标无效"
            try:
                numeric = float(coordinate)
            except (TypeError, ValueError, OverflowError):
                return None, None, "portal transition observation 坐标无效"
            if not math.isfinite(numeric):
                return None, None, "portal transition observation 坐标无效"
            try:
                target_coordinate = int(transition["target"]["position"][axis])
            except (TypeError, ValueError, OverflowError):
                return None, None, "portal transition 抵达锚点坐标无效"
            if math.floor(numeric) != target_coordinate:
                return None, None, "portal transition 抵达锚点与 fresh observation 坐标不匹配"
        if canonical_s5_portal_dimension(state.get("dimension")) != expected_dimension:
            return None, None, "当前观察未满足过门目标维度"
        return transition, observation, "fresh portal transition 已由同 session terminal receipt 验证"

    def _record_s5_portal_transition(
        self,
        pending: dict[str, Any],
        data: dict[str, Any],
    ) -> None:
        if self.goal.stage != "S5" or pending.get("tool") != "nether_travel":
            return
        state = dict(self.state_provider() or {})
        transition, observation, _reason = self._s5_portal_result(
            pending, str(pending.get("status") or ""), state, data
        )
        if transition is None or observation is None:
            return
        revision = self._maybe_int(observation.get("revision"))
        if revision is None:
            return
        self.state["s5_portal_checkpoint"] = {
            "schema_version": 1,
            "transition": transition,
            "receipt": {
                "action_id": str(pending.get("action_id") or ""),
                "session_id": str(observation.get("session_id") or ""),
                "revision": revision,
            },
        }

    async def _wait_for_s4_depth_observation(
        self,
        pending: dict[str, Any],
        status: str,
        state: dict[str, Any],
        data: dict[str, Any],
    ) -> dict[str, Any] | None:
        observation = self._s4_fresh_terminal_observation(pending, status, state, data)
        if observation is not None:
            return observation
        baseline_session = str(pending.get("session_id") or "")
        baseline_revision = self._maybe_int(pending.get("revision"))
        if not baseline_session or baseline_revision is None:
            return None
        latest = await self._wait_for_usable_state(after=(baseline_session, baseline_revision))
        if latest is None:
            return None
        return self._s4_fresh_terminal_observation(pending, status, latest, data)

    def _defer_s4_depth_action(self, pending: dict[str, Any]) -> None:
        self.state["pending_action"] = pending
        self.state["status"] = "waiting"
        self.state["block_reason"] = "等待同一 Bridge session 中 revision 前进后的 S4 下探观察"
        self.state.setdefault("recovery", {}).update(
            {"needs_reconcile": True, "reason": "await_s4_terminal_observation"}
        )
        self._save()
        if self.task_id is not None:
            self.store.set_status(self.task_id, "active")

    def _record_s4_action_outcomes(
        self,
        pending: dict[str, Any],
        status: str,
        state: dict[str, Any],
        data: dict[str, Any],
    ) -> None:
        if self.goal.stage != "S4" or not str(pending.get("action_id") or ""):
            return
        observation = self._s4_fresh_terminal_observation(pending, status, state, data)
        if observation is None:
            return
        recorders = (
            ("diamond_search", record_s4_diamond_outcome),
            ("wood_search", record_s4_wood_search_outcome),
            ("descent", record_s4_descent_success),
            ("horizontal_fallback", record_s4_horizontal_fallback_success),
        )
        for event, recorder in recorders:
            if self._s4_action_event_seen(pending, event):
                continue
            if recorder(self.state, pending, observation, status):
                self._mark_s4_action_event(pending, event)

    def _record_s4_safe_stop(
        self,
        pending: dict[str, Any],
        status: str,
        data: dict[str, Any],
    ) -> tuple[bool, bool]:
        if self.goal.stage != "S4":
            return False, False
        if self._s4_action_event_seen(pending, "safe_stop"):
            return True, False
        if not mark_s4_known_no_safe_stair(self.state, pending, status, data):
            return False, False
        self._mark_s4_action_event(pending, "safe_stop")
        return True, True

    def _completed_events(self) -> set[str]:
        assert self.task_id is not None
        events = set()
        for event in self.store.events(self.task_id, limit=10000):
            if event.get("kind") == "goal_event":
                value = str((event.get("payload") or {}).get("event") or "")
                if value:
                    events.add(value)
        return events

    def _condition_context(self, state: dict[str, Any]) -> dict[str, Any]:
        day = _is_day(state)
        if day is False:
            self.state["night_required"] = True
        return {
            "night_required": bool(self.state.get("night_required")),
            "sleep_confirmed": bool(self.state.get("sleep_confirmed")),
            "guarded_night_confirmed": bool(self.state.get("guarded_night_confirmed")),
        }

    def _late_action_recovery(self, action: dict, current: dict) -> str:
        if self._portal_preflight_stopped(action) or self._portal_insertion_reconciled(action, current):
            return "portal_room_approach"
        if self.goal.stage != "S6" or action.get("tool") != "fight_dragon" or action.get("receipt_confirmed") is not True:
            return ""
        dragon = current.get("end_dragon") or {}
        living_dragon = (
            self._finite_position(dragon.get("position")) and self._finite_number(dragon.get("health")) and float(dragon["health"]) > 0
            or dragon.get("source") == "dragon_boss_bar" and self._finite_number(dragon.get("health_fraction"))
            and 0 < float(dragon["health_fraction"]) <= 1
        )
        if not (current.get("ready") and current.get("alive") and str(current.get("dimension")).removeprefix("minecraft:") == "the_end" and living_dragon):
            return ""
        if action.get("status") == "preempted":
            return "dragon_alive_after_safety"
        progress = (action.get("result_data") or {}).get("crystal_progress") or {}
        if (action.get("status") == "partial" and type(progress.get("broken")) is int and 1 <= progress["broken"] <= 10
                and type(progress.get("remaining_visible")) is int and 1 <= progress["remaining_visible"] <= 10 - progress["broken"]):
            return "crystal_progress_observed"
        return ""

    def _portal_insertion_reconciled(self, action: dict, current: dict) -> bool:
        if (self.goal.stage != "S6" or action.get("tool") != "activate_end_portal"
                or action.get("status") != "preempted" or action.get("receipt_confirmed") is not True
                or not self._s6_is_overworld(current.get("dimension")) or not current.get("ready")
                or not current.get("alive") or not current.get("session_id")):
            return False
        search = self.state.get("stronghold_search") or {}
        frames = (current.get("end_portal_room") or {}).get("frames") or []
        if search.get("phase") != "frames_found" or len(frames) != 12 or not all(
            self._finite_position(f) and isinstance(f.get("filled"), bool) for f in frames
        ):
            return False
        positions = {tuple(f[a] for a in "xyz") for f in frames}
        x0, y0, z0 = min(f["x"] for f in frames), frames[0]["y"], min(f["z"] for f in frames)
        ring = {(x0 + i, y0, z0 + j) for i in range(5) for j in range(5)
                if (i in (0, 4)) != (j in (0, 4))}
        previous = (search.get("scan") or {}).get("frames") or []
        return (positions == ring and any(self._finite_position(f) and tuple(f[a] for a in "xyz") in ring for f in previous)
                and inventory_count(current.get("inventory") or {}, "ender_eye") >= sum(not f["filled"] for f in frames))

    def _portal_preflight_stopped(self, action: dict) -> bool:
        if (self.goal.stage != "S6" or action.get("tool") != "activate_end_portal"
                or action.get("status") != "partial" or action.get("receipt_confirmed") is not True
                or (self.state.get("stronghold_search") or {}).get("phase") != "frames_found"):
            return False
        result = action.get("result_data") or {}
        search = self.state["stronghold_search"]
        frames = (search.get("scan") or {}).get("frames") or []
        position = (result.get("observation") or {}).get("position") or search.get("position")
        if not self._finite_position(position) or not frames or not all(self._finite_position(frame) for frame in frames):
            return False
        coords = tuple(float(position[a]) for a in "xyz")
        if min(math.dist(coords, tuple(float(frame[a]) for a in "xyz")) for frame in frames) <= 8:
            return False
        if result.get("portal_phase") == "before_insertion":
            return True
        # 旧版本只在检查房间、尚未插眼时发出这一条完整终态。
        match = re.fullmatch(r"只找到 (\d+) 个末地门框架，还差 (\d+) 个，可能还没走到要塞的传送门房间",
                             str(action.get("result_detail") or ""))
        return bool(match and 0 < int(match[1]) < 12 and int(match[1]) + int(match[2]) == 12)

    def _migrate_known_s3_stripmine_terminal(self, unresolved: dict[str, Any]) -> bool:
        """只迁移旧 S3 计划中有明确终态账本记录的铁矿挖掘失败。"""
        if self.goal.stage != "S3":
            return False
        if unresolved.get("tool") != "strip_mine" or unresolved.get("status") not in {"blocked", "failed"}:
            return False
        action_id = str(unresolved.get("action_id") or "")
        if not action_id:
            return False
        history = self.state.get("action_history") or []
        terminal = next(
            (
                item
                for item in reversed(history)
                if isinstance(item, dict)
                and str(item.get("action_id") or "") == action_id
                and item.get("tool") == "strip_mine"
                and item.get("status") in {"blocked", "failed"}
                and item.get("method_id") == "plan:s3"
                and item.get("method_key") == "plan:s3:0"
                and item.get("step_index") == 0
                and (item.get("arguments") or {}).get("target") in {"iron_ore", "deepslate_iron_ore"}
            ),
            None,
        )
        if terminal is None:
            return False

        terminal_data = terminal.get("result_data") if isinstance(terminal.get("result_data"), dict) else {}
        unresolved_data = unresolved.get("result_data") if isinstance(unresolved.get("result_data"), dict) else {}
        for result_data in (terminal_data, unresolved_data):
            admission = result_data.get("admission")
            if isinstance(admission, dict) and admission.get("started") is False:
                return False
        terminal_observation = terminal_data.get("observation")
        if not isinstance(terminal_observation, dict):
            terminal_observation = terminal.get("terminal_observation")
        if not isinstance(terminal_observation, dict):
            return False
        receipt_confirmed = False
        for record in (terminal, unresolved):
            if "receipt_confirmed" in record:
                if record.get("receipt_confirmed") is not True:
                    return False
                receipt_confirmed = True
        if not receipt_confirmed:
            progress = terminal.get("progress")
            if not isinstance(progress, list) or not any(
                isinstance(entry, dict)
                and entry.get("phase") == "running"
                and entry.get("session_id")
                and entry.get("state_revision") is not None
                for entry in progress
            ):
                return False
        if isinstance(terminal_data.get("observation"), dict):
            terminal["terminal_observation"] = terminal_data["observation"]
        terminal["receipt_confirmed"] = True
        terminal["migrated_terminal_receipt"] = True
        terminal.setdefault(
            "result_detail",
            str(terminal_data.get("detail") or unresolved.get("result_detail") or unresolved.get("reason") or "旧 S3 挖矿动作已有终态失败记录"),
        )
        self.state.pop("unresolved_action", None)
        self.state["pending_action"] = None
        self.state["method_id"] = self.goal.method_id
        self.state["method_index"] = 0
        self.state["status"] = "active"
        self.state["block_reason"] = ""
        self.state["s3_ore_no_progress"] = 0
        self.state.pop("s3_resource_block_reason", None)
        self.state.setdefault("recovery", {}).update(
            {
                "needs_reconcile": False,
                "reason": "known_terminal_s3_stripmine_replanned_from_fresh_observation",
                "terminal_action_id": action_id,
                "terminal_status": terminal.get("status"),
                "terminal_detail": terminal.get("result_detail", ""),
            }
        )
        self.state.setdefault("migrated_terminal_actions", []).append(action_id)
        if self.task_id is not None:
            self.store.set_status(self.task_id, "active")
            self.store.log_event(
                self.task_id,
                "known_terminal_s3_stripmine_migrated",
                {"action_id": action_id, "status": terminal.get("status"), "detail": terminal.get("result_detail", "")},
            )
        self._save()
        return True

    def _record_s3_ore_outcome(
        self,
        pending: dict[str, Any],
        status: str,
        current: dict[str, Any],
        detail: str = "",
    ) -> None:
        if self.goal.stage != "S3" or pending.get("tool") != "mine_collect":
            return
        block = (pending.get("arguments") or {}).get("block")
        if block not in {"iron_ore", "deepslate_iron_ore"}:
            return
        inventory = current.get("inventory") or {}
        observed = inventory_count(inventory, "raw_iron")
        baseline = int(pending.get("baseline_raw_iron", 0))
        if observed > baseline:
            self.state["s3_ore_no_progress"] = 0
            self.state.pop("s3_resource_block_reason", None)
            self.state.pop("last_s3_mining_failure", None)
        else:
            self.state["s3_ore_no_progress"] = int(self.state.get("s3_ore_no_progress", 0)) + 1
        self.state["s3_last_ore_outcome"] = {
            "action_id": pending.get("action_id"),
            "status": status,
            "baseline_raw_iron": baseline,
            "observed_raw_iron": observed,
            "detail": detail,
            "position": current.get("position"),
        }

    def _record_known_terminal_failure(
        self,
        pending: dict[str, Any],
        status: str,
        current: dict[str, Any],
        data: dict[str, Any],
        detail: str,
    ) -> None:
        item = {
            **pending,
            "status": status,
            "receipt_confirmed": bool(pending.get("receipt_confirmed")),
            "result_detail": detail,
            "result_data": data,
            "terminal_observation": data.get("observation") if isinstance(data.get("observation"), dict) else current,
            "resolved_at": time.time(),
        }
        history = self.state.setdefault("action_history", [])
        history.append(item)
        del history[:-128]
        self._record_s3_ore_outcome(pending, status, current, detail)
        if (self.goal.stage == "S3" and str(pending.get("method_key") or "").startswith("s3:ore_return_surface:")
                and pending.get("receipt_confirmed") is True):
            self.state["s3_relocation_surface_return_used"] = True
        if self.goal.stage == "S3" and pending.get("tool") == "explore_mining_site":
            wood = (pending.get("expected_condition") or {}).get("type") == "s3_wood_relocation"
            if not wood:
                self.state["s3_relocation_failed"] = True
            attempted = (data.get("relocation") or {}).get("attempted_positions") or data.get("attempted_positions") or []
            ledger = self.state.setdefault("s3_wood_avoid_positions" if wood else "s3_ore_avoid_positions", [])
            for position in attempted:
                if isinstance(position, dict) and all(isinstance(position.get(a), (int, float)) and math.isfinite(position[a]) for a in "xyz"):
                    ledger.append({a: float(position[a]) for a in "xyz"})
            del ledger[:-128]
        self._record_s4_action_outcomes(pending, status, current, data)

    def _replan_known_action_failure(
        self,
        pending: dict[str, Any],
        status: str,
        current: dict[str, Any],
        data: dict[str, Any],
        detail: str,
    ) -> bool:
        self._record_known_terminal_failure(pending, status, current, data, detail)
        self.state["pending_action"] = None
        self._mark_attempt(str(pending.get("method_key") or pending.get("tool") or "unknown"))
        self.state.setdefault("recovery", {}).update({"needs_reconcile": False, "reason": "known_terminal_failure_replanned"})
        self.state["status"] = "active"
        self.state["block_reason"] = ""
        self._save()
        if self.task_id is not None:
            self.store.set_status(self.task_id, "active")
            self.store.log_event(
                self.task_id,
                "goal_action_terminal_failure_replanned",
                {"action_id": pending.get("action_id"), "tool": pending.get("tool"), "status": status, "detail": detail[:240]},
            )
        return True

    def _record_observation(self, state: dict[str, Any]) -> None:
        self._cached_state = dict(state)
        self.state["last_observation"] = {
            key: state.get(key)
            for key in ("session_id", "revision", "ready", "alive", "health", "food", "dimension", "position", "inventory", "is_day", "shelter", "nearby_beds", "executor")
            if key in state
        }
        recovery = self.state.setdefault("recovery", {})
        recovery["needs_reconcile"] = False
        recovery["reason"] = ""
        self._save()

    def _state_usable(self, state: dict[str, Any], *, after: tuple[str, int | None] | None = None) -> tuple[bool, str]:
        if not state:
            return False, "缺少世界观察"
        strict = self.require_protocol or "session_id" in state or "ready" in state
        if strict and state.get("ready") is not True:
            return False, "Bridge 尚未 ready"
        if state.get("alive") is not True:
            return False, "角色未确认存活"
        try:
            health = float(state.get("health"))
        except (TypeError, ValueError):
            return False, "血量观察无效"
        if not math.isfinite(health) or health <= 0:
            return False, "角色血量无效"
        position = state.get("position") or {}
        try:
            valid_position = all(math.isfinite(float(position[axis])) for axis in "xyz")
        except (KeyError, TypeError, ValueError):
            valid_position = False
        if strict and not valid_position:
            return False, "位置观察无效"
        executor = state.get("executor") or {}
        if strict and executor.get("safety_active") is not False:
            return False, "Bridge 安全执行器仍在工作"
        if strict and "active_action_id" not in executor:
            return False, "Bridge 未报告 active_action_id"
        if strict and executor.get("active_action_id"):
            return False, "Bridge 仍有动作在执行"
        if strict:
            try:
                revision = int(state.get("revision"))
            except (TypeError, ValueError):
                return False, "缺少单调状态 revision"
            if not str(state.get("session_id") or ""):
                return False, "缺少 Bridge session_id"
            if after is not None:
                previous_session, previous_revision = after
                current_session = str(state.get("session_id") or "")
                if previous_session and current_session == previous_session and previous_revision is not None and revision <= previous_revision:
                    return False, "等待 revision 前进后的观察"
        if self.state_age_provider is not None:
            age = self.state_age_provider()
            if age is None or not math.isfinite(float(age)) or float(age) > 15.0:
                return False, "世界观察已过期"
        return True, "ready"

    def _fresh_reconciliation_observation(
        self, pending: dict[str, Any], state: dict[str, Any]
    ) -> tuple[bool, str]:
        fresh, reason = self._observation_after_pending_action(pending, state)
        if not fresh:
            return False, reason
        return self._state_usable(state)

    def _terminal_reconciliation_requires_fresh_observation(
        self,
        pending: dict[str, Any],
        state: dict[str, Any],
        result_data: dict[str, Any],
    ) -> bool:
        admission = result_data.get("admission") if isinstance(result_data, dict) else None
        if (
            isinstance(admission, dict)
            and admission.get("started") is False
            and admission.get("retryable") is True
            and admission.get("reason") == "stale_observation"
        ):
            return False
        if self.require_protocol:
            return True
        # 保留非协议调用方的旧终态回执兼容路径；RunManager 始终启用协议校验。
        recovery = self.state.get("recovery") or {}
        last_observation = self.state.get("last_observation") or {}
        receipt_observation = result_data.get("observation") if isinstance(result_data, dict) else None
        sources = (pending, state, recovery, last_observation, receipt_observation)
        return any(
            isinstance(source, dict)
            and (
                bool(str(source.get("session_id") or ""))
                or source.get("revision") is not None
                or source.get("ready") is not None
            )
            for source in sources
        )

    def _fresh_terminal_receipt_observation(
        self,
        pending: dict[str, Any],
        result_data: dict[str, Any],
        current: dict[str, Any],
        *,
        status: str,
    ) -> tuple[bool, str]:
        terminal = result_data.get("observation") if isinstance(result_data, dict) else None
        if not isinstance(terminal, dict):
            return self._fresh_terminal_receipt_without_observation(
                pending, current, status=status, receipt_session=None
            )
        fresh, reason = self._observation_after_pending_action(pending, terminal)
        if not fresh:
            return False, f"终态 observation 无效：{reason}"
        terminal_executor = terminal.get("executor")
        if not isinstance(terminal_executor, dict) or "active_action_id" not in terminal_executor:
            return False, "终态 observation 缺少 executor.active_action_id"
        if str(terminal_executor.get("active_action_id") or "") == str(pending.get("action_id") or ""):
            terminal_session = str(terminal.get("session_id") or "")
            terminal_revision = self._maybe_int(terminal.get("revision"))
            if terminal_session and terminal_revision is not None:
                pending["terminal_receipt_baseline"] = {
                    "session_id": terminal_session,
                    "revision": terminal_revision,
                }
            return self._fresh_terminal_receipt_without_observation(
                pending,
                current,
                status=status,
                receipt_session=terminal_session or None,
            )

        usable, reason = self._state_usable(current)
        if not usable:
            terminal_session = str(terminal.get("session_id") or "")
            terminal_revision = self._maybe_int(terminal.get("revision"))
            if terminal_session and terminal_revision is not None:
                pending["terminal_receipt_baseline"] = {
                    "session_id": terminal_session,
                    "revision": terminal_revision,
                }
            return False, reason
        fresh, reason = self._observation_after_pending_action(pending, current)
        if not fresh:
            return False, f"当前 observation 无效：{reason}"
        terminal_session = str(terminal.get("session_id") or "")
        terminal_revision = self._maybe_int(terminal.get("revision"))
        current_session = str(current.get("session_id") or "")
        current_revision = self._maybe_int(current.get("revision"))
        if not terminal_session or terminal_revision is None or not current_session or current_revision is None:
            return False, "当前或终态 observation 缺少 session_id/revision"
        if current_session == terminal_session and current_revision < terminal_revision:
            pending["terminal_receipt_baseline"] = {
                "session_id": terminal_session,
                "revision": terminal_revision,
            }
            return False, "当前 observation 早于 Bridge terminal receipt 的终态 observation"
        if current_session != terminal_session:
            dispatch_baseline = self._dispatch_action_baseline(pending)
            dispatch_session = dispatch_baseline[0] if dispatch_baseline is not None else ""
            if terminal_session != dispatch_session:
                if current_session == dispatch_session:
                    return False, "当前 observation 仍是原动作 session；终态 receipt observation 属于其他 session"
                return False, "当前 session 与终态 receipt 不一致，且 receipt 不属于原动作 session"
        return True, "ready"

    def _fresh_terminal_receipt_without_observation(
        self,
        pending: dict[str, Any],
        current: dict[str, Any],
        *,
        status: str,
        receipt_session: str | None,
    ) -> tuple[bool, str]:
        fresh, reason = self._observation_after_pending_action(pending, current)
        if not fresh:
            return False, f"当前 observation 无效：{reason}"
        usable, reason = self._state_usable(current)
        if not usable:
            return False, reason

        baseline = pending.get("terminal_receipt_baseline")
        current_session = str(current.get("session_id") or "")
        dispatch_baseline = self._dispatch_action_baseline(pending)
        dispatch_session = dispatch_baseline[0] if dispatch_baseline is not None else ""
        if status in {"dead", "disconnected"} and current_session and current_session != dispatch_session:
            if receipt_session and receipt_session not in {dispatch_session, current_session}:
                return False, "dead/disconnected receipt 与当前 session 都不同于原动作 session"
            return True, "新 Bridge session 的 ready/alive/idle observation 已越过 dead/disconnected 回执"
        if not isinstance(baseline, dict):
            baseline_session = current_session
            baseline_revision = self._maybe_int(current.get("revision"))
            if baseline_session and baseline_revision is not None:
                pending["terminal_receipt_baseline"] = {
                    "session_id": baseline_session,
                    "revision": baseline_revision,
                }
            return False, "終态回执没有 observation；等待回执之后的新 revision 或新 session"

        baseline_session = str(baseline.get("session_id") or "")
        baseline_revision = self._maybe_int(baseline.get("revision"))
        current_revision = self._maybe_int(current.get("revision"))
        if not current_session or current_revision is None:
            return False, "当前 observation 缺少 session_id/revision"
        if current_session != baseline_session and baseline_session != dispatch_session:
            return False, "当前 session 与回执基线不一致，且回执 session 不属于原动作 session"
        if current_session == baseline_session and (
            baseline_revision is None or current_revision <= baseline_revision
        ):
            return False, "等待 Bridge terminal receipt 之后的 revision 前进"
        return True, "ready"

    def _pending_reconciliation_baseline(
        self, pending: dict[str, Any]
    ) -> tuple[str, int | None] | None:
        receipt_baseline = pending.get("terminal_receipt_baseline")
        if isinstance(receipt_baseline, dict):
            session_id = str(receipt_baseline.get("session_id") or "")
            revision = self._maybe_int(receipt_baseline.get("revision"))
            if session_id and revision is not None:
                return session_id, revision

        return self._dispatch_action_baseline(pending)

    def _dispatch_action_baseline(
        self, pending: dict[str, Any]
    ) -> tuple[str, int | None] | None:
        recovery = self.state.get("recovery") or {}
        last_observation = self.state.get("last_observation") or {}
        session_id = str(
            pending.get("session_id")
            or recovery.get("baseline_session_id")
            or last_observation.get("session_id")
            or ""
        )
        revision = self._maybe_int(pending.get("revision"))
        if revision is None:
            revision = self._maybe_int(recovery.get("baseline_revision"))
        if revision is None:
            revision = self._maybe_int(last_observation.get("revision"))
        if not session_id or revision is None:
            return None
        return session_id, revision

    def _observation_after_pending_action(
        self, pending: dict[str, Any], state: dict[str, Any]
    ) -> tuple[bool, str]:
        baseline = self._dispatch_action_baseline(pending)
        if baseline is None:
            return False, "原动作缺少 session_id/revision 基线，无法证明当前观察新鲜"
        baseline_session, baseline_revision = baseline
        observed_session = str(state.get("session_id") or "")
        observed_revision = self._maybe_int(state.get("revision"))
        if not observed_session or observed_revision is None:
            return False, "observation 缺少 session_id/revision，无法证明相对原动作的新鲜度"
        if observed_session == baseline_session and observed_revision <= baseline_revision:
            return False, "等待原 session revision 前进后的观察"
        return True, "ready"

    async def _wait_for_observation(self, *, timeout: float | None = None) -> None:
        # 正式 Bridge 推送时唤醒。独立调用者只提供快照时仍按原间隔轮询。
        if self._observation_event is None:
            await asyncio.sleep(0.5 if timeout is None else min(0.25, max(0.0, timeout)))
            return
        if timeout is None:
            timeout = float(self.state["deadline_at"]) - time.time()
        try:
            await asyncio.wait_for(self._observation_event.wait(), min(5.0, max(0.0, timeout)))
        except asyncio.TimeoutError:
            pass

    async def _wait_for_usable_state(self, *, after: tuple[str, int | None] | None = None) -> dict[str, Any] | None:
        deadline = time.monotonic() + MAX_READY_WAIT_S
        latest: dict[str, Any] = {}
        while time.monotonic() < deadline:
            if self._stop_requested:
                return None
            if self._observation_event is not None:
                self._observation_event.clear()
            latest = dict(self.state_provider() or {})
            usable, reason = self._state_usable(latest, after=after)
            if usable:
                return latest
            if latest.get("alive") is False:
                self.state["status"] = "dead"
                self.state["block_reason"] = "等待重生后新的 ready 观察"
                self.state.setdefault("recovery", {}).update({"needs_reconcile": True, "reason": "death"})
                self._save()
                if self.task_id is not None:
                    self.store.set_status(self.task_id, "dead")
                return None
            self.state["status"] = "waiting"
            self.state["block_reason"] = reason
            self._save()
            await self._wait_for_observation(timeout=deadline - time.monotonic())
        self.state["status"] = "disconnected" if not latest else ("waiting" if after is not None else "blocked")
        self.state["block_reason"] = "等待 ready 新鲜观察超时"
        self.state.setdefault("recovery", {}).update({"needs_reconcile": True, "reason": "bridge_unavailable"})
        self._save()
        if self.task_id is not None:
            self.store.set_status(self.task_id, self.state["status"])
        return None

    async def _wait_after_safety(self) -> dict[str, Any] | None:
        last = self.state.get("last_observation") or {}
        baseline = (
            str(last.get("session_id") or ""),
            self._maybe_int(last.get("revision")),
        )
        return await self._wait_for_usable_state(after=baseline)

    @staticmethod
    def _maybe_int(value: Any) -> int | None:
        try:
            return int(value) if value is not None else None
        except (TypeError, ValueError):
            return None

    async def _query_status(self, action_id: str) -> ActionStatusResult:
        if self.action_status is None:
            return ActionStatusResult(action_id=action_id, status="unknown", detail="Core 没有 Bridge 对账接口")
        try:
            return await self.action_status(action_id)
        except Exception as error:
            return ActionStatusResult(action_id=action_id, status="unknown", detail=f"action_status 查询失败：{error}")

    async def _reconcile_pending(self, state: dict[str, Any]) -> bool:
        pending = self.state.get("pending_action")
        recovery = self.state.setdefault("recovery", {})
        if not pending:
            recovery["needs_reconcile"] = False
            self._save()
            return True
        action_id = str(pending.get("action_id") or "")
        if not action_id:
            self.state["status"] = "blocked"
            self.state["block_reason"] = "pending_action 缺少 action_id，不能安全续跑"
            self._save()
            return False
        deadline = time.monotonic() + MAX_ACTION_RECONCILE_S
        result = await self._query_status(action_id)
        while result.status in {"queued", "running", "accepted", "cancelling", "preempting"} and time.monotonic() < deadline:
            if self._stop_requested:
                return False
            await asyncio.sleep(0.5)
            result = await self._query_status(action_id)
        if result.status in {"queued", "running", "accepted", "cancelling", "preempting"}:
            pending["status"] = result.status
            self.state["status"] = "waiting"
            self.state["block_reason"] = f"Bridge action_id {action_id} 仍为 {result.status}；保留原 action_id 等待 terminal receipt"
            recovery.update({"needs_reconcile": True, "reason": "bridge_action_still_active"})
            self._save()
            self.store.set_status(self.task_id, "active")
            return False
        if result.status in {"succeeded", "partial", "failed", "blocked", "cancelled", "preempted", "dead", "disconnected"}:
            current = dict(self.state_provider() or state)
            if self._terminal_reconciliation_requires_fresh_observation(
                pending, current, result.data
            ):
                fresh, fresh_reason = self._fresh_terminal_receipt_observation(
                    pending, result.data, current, status=result.status
                )
                if not fresh:
                    if fresh_reason == "当前 session 与终态 receipt 不一致，且 receipt 不属于原动作 session":
                        # 新 Bridge 的状态不与该终态 observation 对账；将其作为未知结果，
                        # 再由动作 effect class 决定按新观察重规划还是阻止续跑。
                        pending["untrusted_terminal_receipt"] = {
                            "status": result.status,
                            "detail": result.detail,
                            "data": result.data,
                        }
                        pending["status"] = "unknown"
                        pending["receipt_confirmed"] = False
                        pending["result_detail"] = "终态 receipt observation 属于其他 session；按未知动作处理"
                        pending["result_data"] = {}
                        return self._reconcile_unknown_pending(pending, current, recovery)
                    self.state["status"] = "waiting"
                    self.state["block_reason"] = (
                        f"终态动作回执已收到；等待其后的新鲜 observation：{fresh_reason}"
                    )
                    recovery.update(
                        {"needs_reconcile": True, "reason": "await_fresh_reconciliation_state"}
                    )
                    self._save()
                    self.store.set_status(self.task_id, "active")
                    return False
            state = current
            if result.status == "blocked":
                admission_outcome = await self._handle_admission_rejection(
                    pending,
                    result.data,
                    str(pending.get("method_key") or "unknown"),
                )
                if admission_outcome is not None:
                    return admission_outcome == "retry"
            self._reset_admission_retry_streak(str(pending.get("method_key") or "unknown"))
            pending["status"] = result.status
            pending["receipt_confirmed"] = True
            pending["result_detail"] = result.detail
            pending["result_data"] = result.data
            self.store.log_event(self.task_id, "pending_action_reconciled", {"action_id": action_id, "status": result.status})
            if result.status in {"partial", "preempted"}:
                consumed = self._consume_s6_stronghold_partial(pending, result.status, result.data, result.detail)
                if consumed is not None:
                    return consumed == "continue"
            expected = pending.get("expected_condition") or {"type": "always"}
            if (
                self.goal.stage == "S4"
                and result.status == "succeeded"
                and pending.get("tool") == "strip_mine"
                and expected.get("type") == "s4_depth_reached"
            ):
                current = dict(self.state_provider() or state)
                fresh = await self._wait_for_s4_depth_observation(
                    pending, result.status, current, result.data
                )
                if fresh is None:
                    self._defer_s4_depth_action(pending)
                    return False
            if result.status in {"dead", "disconnected"}:
                # 重新 ready/alive 后按当前观察重算；旧 terminal observation 仅作审计。
                return self._resolve_interrupted_action(pending, result.status, state, result.data)
            if result.status == "preempted":
                safe = await self._wait_after_safety()
                if safe is None:
                    self.state["status"] = "preempted"
                    self.state["block_reason"] = "抢占后等待 Bridge safety done 与新 observation"
                    self._save()
                    return False
                return self._resolve_interrupted_action(pending, "preempted", safe, result.data)
            if result.status == "cancelled":
                if recovery.get("reason") != "explicit_resume":
                    self.state["pending_action"] = pending
                    self.state["status"] = "cancelled"
                    self.state["block_reason"] = "Bridge 确认动作已取消；需显式恢复目标"
                    recovery.update({"needs_reconcile": False, "reason": "cancelled"})
                    self._save()
                    self.store.set_status(self.task_id, "cancelled")
                    return False
                return self._resolve_interrupted_action(pending, "cancelled", state, result.data)
            if result.status == "partial" and self.goal.stage == "S4" and pending.get("tool") == "strip_mine":
                current = dict(self.state_provider() or state)
                return self._resolve_interrupted_action(pending, "partial", current, result.data)
            if result.status in {"failed", "blocked"}:
                current = dict(self.state_provider() or state)
                if self._effect_class(str(pending.get("tool") or ""), str(pending.get("effect_class") or "")) != "replan":
                    return self._resolve_interrupted_action(pending, result.status, current, result.data)
                return self._replan_known_action_failure(
                    pending,
                    result.status,
                    current,
                    result.data,
                    result.detail,
                )
            current = dict(self.state_provider() or state)
            expected = pending.get("expected_condition") or {"type": "always"}
            if expected.get("type") == "always":
                if self.goal.stage == "S6" and pending.get("tool") == "throw_eye":
                    verified, reason = self._verify_s6_stronghold_frames(pending, result.data, current)
                else:
                    verified = result.status == "succeeded"
                    reason = f"Bridge action ledger status={result.status}"
            elif expected.get("type") == "result_event":
                verified, reason = self.verifier.check(expected, current, result.data)
            else:
                verified, reason = self._verify_pending_method_condition(
                    expected, current, pending, result.status, result.data
                )
            if verified:
                self._record_s4_action_outcomes(pending, result.status, current, result.data)
                self.state["pending_action"] = None
                if self.goal.stage == "S6" and pending.get("tool") == "throw_eye":
                    self._record_s6_stronghold_success(pending, result.data)
                self._advance_after_success(pending, result.data)
                recovery.update({"needs_reconcile": False, "reason": "verified_action_receipt"})
                self._save()
                return True
            tool = str(pending.get("tool") or "")
            self.state["pending_action"] = None
            if self._effect_class(tool, str(pending.get("effect_class") or "")) == "replan":
                self._record_s4_action_outcomes(pending, result.status, current, result.data)
                self._mark_attempt(str(pending.get("method_key") or tool))
                recovery.update({"needs_reconcile": False, "reason": "known_action_replanned_from_observation"})
                self._save()
                return True
            self.state["status"] = "blocked"
            self.state["block_reason"] = f"known_action_without_goal_evidence:{tool}:{reason}"
            recovery.update({"needs_reconcile": False, "reason": "known_action_missing_evidence"})
            self._save()
            self.store.set_status(self.task_id, "blocked")
            return False

        current = dict(self.state_provider() or state)
        return self._reconcile_unknown_pending(pending, current, recovery)

    def _reconcile_unknown_pending(
        self,
        pending: dict[str, Any],
        current: dict[str, Any],
        recovery: dict[str, Any],
    ) -> bool:
        action_id = str(pending.get("action_id") or "")
        fresh, fresh_reason = self._fresh_reconciliation_observation(pending, current)
        if not fresh:
            self.state["status"] = "waiting"
            self.state["block_reason"] = f"动作结果未知；等待新鲜 observation：{fresh_reason}"
            recovery.update({"needs_reconcile": True, "reason": "await_fresh_reconciliation_state"})
            self._save()
            self.store.set_status(self.task_id, "active")
            return False
        accepted, _ = evaluate_condition(
            self.goal.acceptance,
            current,
            completed_events=self._completed_events(),
            context=self._condition_context(current),
        )
        if accepted:
            self._archive_untrusted_terminal_receipt(pending)
            self.state["pending_action"] = None
            recovery.update({"needs_reconcile": False, "reason": "goal_condition_observed"})
            self._save()
            return True
        data = dict(pending.get("result_data") or {})
        expected = pending.get("expected_condition")
        if isinstance(expected, dict) and expected.get("type") != "always":
            if pending.get("tool") in {"sleep_safe", "wait_for_day"}:
                verified = False
            else:
                verified, _ = self._verify_pending_method_condition(
                    expected, current, pending, "unknown", data
                )
            if verified:
                self._archive_untrusted_terminal_receipt(pending)
                self.state["pending_action"] = None
                self._advance_after_success(pending, {})
                recovery.update({"needs_reconcile": False, "reason": "method_condition_observed"})
                self._save()
                return True
        tool = str(pending.get("tool") or "")
        if self._effect_class(tool, str(pending.get("effect_class") or "")) == "replan":
            # Gather/craft 等只按当前缺口重选，继续保留旧 action_id 审计记录。
            pending["status"] = "unknown_reconciled_for_replan"
            pending["resolved_at"] = time.time()
            action_history = self.state.setdefault("action_history", [])
            already_recorded = any(
                isinstance(entry, dict) and str(entry.get("action_id") or "") == action_id
                for entry in action_history
            )
            if pending.get("receipt_confirmed") is not True:
                pending["receipt_confirmed"] = False
            if not already_recorded:
                action_history.append(pending)
                del action_history[:-128]
            self.state["pending_action"] = None
            method_key = str(pending.get("method_key") or tool)
            if already_recorded:
                pass
            elif pending.get("receipt_confirmed") is True:
                # 已有动作回执时，条件缺失属于方法结果，不属于传输中断。
                self._mark_attempt(method_key)
            else:
                if self._record_transport_recovery(pending):
                    self._mark_attempt(method_key, method_failure=False)
            recovery.update({"needs_reconcile": False, "reason": "unknown_effect_replanned_from_observation"})
            if self._transport_recovery_budget_exhausted():
                self._block_transport_recovery_budget(
                    action_id=action_id,
                    method_key=method_key,
                )
                return False
            self._save()
            self.store.log_event(
                self.task_id,
                "unknown_action_replanned",
                {
                    "action_id": action_id,
                    "tool": tool,
                    "method_key": method_key,
                    "receipt_confirmed": pending.get("receipt_confirmed") is True,
                    "transport_recoveries": int((self.state.get("counters") or {}).get("transport_recoveries", 0)),
                    "transport_recovery_limit": self._transport_recovery_limit(),
                    "method_failures": self._method_failure_count(method_key),
                    "method_failure_limit": self.goal.budget.max_attempts_per_method,
                },
            )
            return True
        self.state["pending_action"] = None
        self.state.setdefault("action_history", []).append(
            {**pending, "status": "unknown", "resolved_at": time.time()}
        )
        self.state["unresolved_action"] = {
            "action_id": action_id,
            "tool": tool,
            "status": "unknown",
            "receipt_confirmed": pending.get("receipt_confirmed") is True,
            "effect_class": "non_replayable",
            "reason": "Bridge ledger has no terminal record and the postcondition is not observable",
        }
        self.state["status"] = "blocked"
        self.state["block_reason"] = f"unknown_action_outcome:{tool}:{action_id}"
        recovery.update({"needs_reconcile": False, "reason": "unknown_non_replayable_action"})
        self._save()
        self.store.set_status(self.task_id, "blocked")
        self.store.log_event(self.task_id, "unknown_action_blocked", {"action_id": action_id, "tool": tool})
        return False

    def _archive_untrusted_terminal_receipt(self, pending: dict[str, Any]) -> None:
        if not isinstance(pending.get("untrusted_terminal_receipt"), dict):
            return
        history = self.state.setdefault("action_history", [])
        if any(
            isinstance(entry, dict)
            and str(entry.get("action_id") or "") == str(pending.get("action_id") or "")
            for entry in history
        ):
            return
        history.append(
            {
                **pending,
                "status": "unknown_reconciled_from_observation",
                "receipt_confirmed": False,
                "resolved_at": time.time(),
            }
        )
        del history[:-128]

    def _advance_after_success(self, pending: dict[str, Any], data: dict[str, Any]) -> None:
        self._record_s5_portal_transition(pending, data)
        if (pending.get("expected_condition") or {}).get("type") == "s5_obsidian_relocation":
            self.state["s5_obsidian_region"] = int(self.state.get("s5_obsidian_region", 0)) + 1
        if self.goal.stage == "S3" and pending.get("tool") == "mine_collect" and (pending.get("arguments") or {}).get("block") == "coal_ore":
            self.state["s3_coal_search_attempted"] = True
        if self.goal.stage == "S2" and str(pending.get("method_key") or "").startswith("s2:wool_relocate:region"):
            self.state["s2_wool_search_region"] = int(self.state.get("s2_wool_search_region", 0)) + 1
        if self.goal.stage == "S3" and str(pending.get("method_key") or "").startswith("s3:ore_return_surface:"):
            self.state["s3_relocation_surface_return_used"] = True
        if (self.goal.stage == "S3" and pending.get("tool") == "explore_mining_site"
                and (pending.get("expected_condition") or {}).get("type") != "s3_wood_relocation"):
            self.state["s3_ore_regions"] = int(self.state.get("s3_ore_regions", 0)) + 1
            self.state.pop("s3_relocation_failed", None)
            self.state.pop("s3_relocation_surface_return_used", None)
            self.state.pop("s3_low_oxygen_relocation_required", None)
            self.state["s3_ore_expose_used"] = 0
            self.state["s3_ore_no_progress"] = 0
            self.state.pop("last_s3_mining_failure", None)
            self.state.pop("s3_resource_block_reason", None)
        if self.goal.stage == "S3" and str(pending.get("method_key") or "").startswith("s3:ore_expose:"):
            self.state["s3_ore_expose_used"] = max(int(self.state.get("s3_ore_expose_used", 0)), int(str(pending["method_key"]).rsplit(":", 1)[-1]))
            self.state["s3_ore_no_progress"] = 0
            self.state.pop("s3_resource_block_reason", None)
            self.state.pop("last_s3_mining_failure", None)
        if self.goal.stage == "S2" and pending.get("tool") == "sleep_safe":
            state = dict(self.state_provider() or {})
            if _is_day(state) is True and state.get("alive") is True:
                self.state["sleep_confirmed"] = True
        if self.goal.stage == "S2" and pending.get("tool") == "wait_for_day":
            state = dict(self.state_provider() or {})
            try:
                health = float(state.get("health", 0))
            except (TypeError, ValueError):
                health = 0.0
            if _is_day(state) is True and state.get("alive") is True and math.isfinite(health) and health > 0:
                self.state["guarded_night_confirmed"] = True
        index = pending.get("step_index")
        if index is not None and int(self.state.get("method_index", 0)) == int(index):
            self.state["method_index"] = int(index) + 1
        rule = pending.get("expected_condition") or {}
        if rule.get("type") == "result_event":
            events = data.get("events") or []
            event = str(rule.get("event") or "")
            if event and event in events:
                self.store.log_event(self.task_id, "goal_event", {"event": event, "action_id": pending.get("action_id"), "evidence": data.get("evidence")})

    def _initialize_recovery_budgets(self) -> None:
        """按可核对的历史回执拆分物理失败与传输恢复预算。"""
        counters = self.state.setdefault("counters", {"actions": 0, "attempts": {}})
        attempts = counters.setdefault("attempts", {})
        history = self.state.get("action_history") or []
        transport_ids = counters.get("transport_recovery_action_ids")
        if not isinstance(transport_ids, list):
            transport_ids = []
        normalized_ids = list(dict.fromkeys(str(action_id) for action_id in transport_ids if str(action_id or "")))
        seen_transport_ids = set(normalized_ids)
        transport_attempts_by_method: dict[str, set[str]] = {}
        terminal_failures_by_method: dict[str, set[str]] = {}

        for entry in history:
            if not isinstance(entry, dict):
                continue
            action_id = str(entry.get("action_id") or "")
            method_key = str(entry.get("method_key") or entry.get("tool") or "")
            status = str(entry.get("status") or "")
            receipt_value = entry.get("receipt_confirmed")
            receipt_confirmed = receipt_value is True
            # 迁移旧记录时只相信当时保存的明确 effect_class，不按工具名称推断。
            effect_class = str(entry.get("effect_class") or "")
            if not action_id or not method_key:
                continue

            proven_unknown_replan = (
                status == "unknown_reconciled_for_replan"
                and receipt_value is False
                and effect_class == "replan"
            )
            terminal_observation = entry.get("terminal_observation")
            if not isinstance(terminal_observation, dict):
                result_data = entry.get("result_data") or {}
                terminal_observation = result_data.get("observation") if isinstance(result_data, dict) else None
            proven_disconnected_replan = False
            if (
                status == "disconnected"
                and receipt_value is False
                and effect_class == "replan"
                and isinstance(terminal_observation, dict)
            ):
                baseline_session = str(entry.get("session_id") or "")
                observed_session = str(terminal_observation.get("session_id") or "")
                baseline_revision = self._maybe_int(entry.get("revision"))
                observed_revision = self._maybe_int(terminal_observation.get("revision"))
                proven_disconnected_replan = bool(
                    baseline_session
                    and observed_session
                    and baseline_revision is not None
                    and observed_revision is not None
                    and (
                        observed_session != baseline_session
                        or observed_revision > baseline_revision
                    )
                )
            if proven_unknown_replan or proven_disconnected_replan:
                if action_id not in seen_transport_ids:
                    normalized_ids.append(action_id)
                    seen_transport_ids.add(action_id)
                if proven_unknown_replan:
                    transport_attempts_by_method.setdefault(method_key, set()).add(action_id)

            if status in {"failed", "blocked"} and receipt_confirmed:
                terminal_failures_by_method.setdefault(method_key, set()).add(action_id)

        counters["transport_recovery_action_ids"] = normalized_ids
        counters["transport_recoveries"] = max(
            int(counters.get("transport_recoveries", 0) or 0),
            len(seen_transport_ids),
        )

        if int(counters.get("recovery_budget_version", 0) or 0) < RECOVERY_BUDGET_VERSION:
            method_failures: dict[str, int] = {}
            for method_key, raw_total in attempts.items():
                try:
                    total = max(0, int(raw_total or 0))
                except (TypeError, ValueError):
                    total = 0
                proven_transport = len(transport_attempts_by_method.get(str(method_key), set()))
                confirmed_failures = len(terminal_failures_by_method.get(str(method_key), set()))
                method_failures[str(method_key)] = max(
                    max(0, total - proven_transport),
                    confirmed_failures,
                )
            for method_key, failures in terminal_failures_by_method.items():
                method_failures[method_key] = max(method_failures.get(method_key, 0), len(failures))
            counters["method_failures"] = method_failures
            counters["recovery_budget_version"] = RECOVERY_BUDGET_VERSION
        else:
            method_failures = counters.get("method_failures")
            if not isinstance(method_failures, dict):
                counters["method_failures"] = {}

    def _expand_wood_search(self, step: StepSpec, state: dict, local_key: str) -> tuple[StepSpec, str]:
        wide_key = f"{local_key}:wide"
        if not self._method_failure_count(wide_key):
            return replace(step, arguments={**step.arguments, "range": 128}), wide_key
        position = state["position"]
        avoid = self.state.setdefault("s3_wood_avoid_positions", [])
        if not any(math.hypot(p["x"] - position["x"], p["z"] - position["z"]) < 8 for p in avoid):
            avoid.append({axis: position[axis] for axis in "xyz"})
        del avoid[:-128]
        relocation = StepSpec("离开已搜索的林木区域，寻找新的干燥落脚点", "explore_mining_site",
                              {"min_distance": 40, "avoid_positions": list(avoid)},
                              {"type": "s3_wood_relocation", "min_distance": 40},
                              retries=1, timeout_s=180, effect_class="replan")
        return relocation, f"{local_key}:relocate"

    def _s5_obsidian_site(self, step: StepSpec, state: dict, key: str) -> tuple[StepSpec, str]:
        region = int(self.state.get("s5_obsidian_region", 0))
        sites = self.state.setdefault("s5_obsidian_avoid_positions", [])
        position = state.get("position") or {}
        local_failures = ("没有装到水", "没有已加载的静止水源", "静止岩浆源耗尽")
        exhausted_lava = None
        for entry in reversed(self.state.get("action_history", [])):
            if entry.get("tool") != "collect_obsidian" or not entry.get("receipt_confirmed") or entry.get("status") == "rejected_before_start":
                continue
            if entry.get("status") in {"blocked", "failed", "partial"} and any(reason in str(entry.get("result_detail")) for reason in local_failures):
                site = (entry.get("terminal_observation") or (entry.get("result_data") or {}).get("observation") or {}).get("position")
                if self._finite_position(site):
                    if "静止岩浆源耗尽" in str(entry.get("result_detail")):
                        exhausted_lava = site
                    if not any(abs(float(site["y"]) - p["y"]) < 5 and math.hypot(float(site["x"]) - p["x"], float(site["z"]) - p["z"]) < 8 for p in sites):
                        sites.append({a: float(site[a]) for a in "xyz"})
                        del sites[:-128]
            break
        leaving_aquifer = self.state.get("s5_wet_region") == region
        if self._finite_position(position) and (leaving_aquifer or any(abs(float(position["y"]) - p["y"]) < 5 and
                math.hypot(float(position["x"]) - p["x"], float(position["z"]) - p["z"]) < 12 for p in sites)):
            y = math.floor(float(position["y"]))
            descent_key = f"s5:lava_descent:{region}:{y}"
            if (not leaving_aquifer and exhausted_lava and abs(y - float(exhausted_lava["y"])) < 5 and y > -54
                    and inventory_count(state.get("inventory") or {}, "water_bucket") and not self._method_failure_count(descent_key)):
                target = max(-54, y - 8)
                descend = StepSpec("带水桶分段下探，在新高度重新寻找岩浆", "safe_descend",
                                   {"targetY": target, "maxLayers": y - target, "fill": True, "detour": False},
                                   {"type": "position", "target": {**position, "y": target}, "radius": 1.5},
                                   retries=1, timeout_s=110, effect_class="replan")
                return descend, descent_key
            if not leaving_aquifer and exhausted_lava and inventory_count(state.get("inventory") or {}, "water_bucket") and self._method_failure_count(descent_key):
                for heading in ("east", "north", "west", "south"):
                    bypass_key = f"s5:lava_bypass:{region}:{math.floor(y / 8)}:{heading}"
                    if self._method_failure_count(bypass_key):
                        continue
                    bypass = StepSpec("沿干燥岩层横移，绕开进水的竖井", "strip_mine",
                                      {"direction": heading, "length": 8, "branches": 0, "torchInterval": 0},
                                      {"type": "s5_shaft_displacement"}, retries=1, timeout_s=120, effect_class="replan")
                    return bypass, bypass_key
                self.state["s5_wet_region"] = region
                leaving_aquifer = True
            surface_exit = (state.get("surface_access") or {}).get("exit")
            exit_key = f"s5:obsidian_exit:{region}:{y}"
            exit_above = self._finite_position(surface_exit) and float(surface_exit["y"]) > float(position["y"]) + 1
            exit_beside = (leaving_aquifer and self._finite_position(surface_exit) and not exit_above
                           and float(surface_exit["y"]) >= y
                           and math.hypot(surface_exit["x"] - position["x"], surface_exit["z"] - position["z"]) > 2)
            if exit_beside:
                exit_key += ":ledge"
            if ((not exhausted_lava or leaving_aquifer) and (exit_above or exit_beside)
                    and self._method_failure_count(exit_key) < 2):
                target = {**surface_exit, "y": min(surface_exit["y"], y + 6)} if leaving_aquifer else dict(surface_exit)
                climb = StepSpec("向已观察到的出口上行，再换干地寻找资源", "goto", target,
                                 {"type": "position", "target": target, "radius": 2},
                                 retries=1, timeout_s=100, effect_class="replan")
                return climb, exit_key
            avoided = list(sites)
            relocation_key = f"s5:obsidian_relocate:{region}"
            for entry in reversed(self.state.get("action_history", [])):
                prior_key = str(entry.get("method_key") or "")
                if (prior_key != relocation_key and not prior_key.startswith(relocation_key + ":")) or entry.get("status") not in {"failed", "blocked"}:
                    continue
                route = (entry.get("result_data") or {}).get("relocation") or {}
                # 井底出发时无法走到的岸上落点，上岸后应按新的连通地形重新寻路。
                origin = route.get("origin")
                if leaving_aquifer and self._finite_position(origin) and abs(float(origin["y"]) - y) >= 8:
                    continue
                avoided.extend(p for p in route.get("attempted_positions", []) if self._finite_position(p))
            relocation = StepSpec("前往新的干燥区域寻找水源和岩浆", "explore_mining_site",
                                  {"min_distance": 32, "avoid_positions": avoided[:128]},
                                  {"type": "s5_obsidian_relocation", "min_distance": 32},
                                  retries=1, timeout_s=160, effect_class="replan")
            return relocation, f"{relocation_key}:{math.floor(y / 8)}" if leaving_aquifer else relocation_key
        if region and self._finite_position(position) and inventory_count(state.get("inventory") or {}, "water_bucket"):
            return step, f"{key}:region{region}:layer{math.floor(float(position['y']) / 8)}"
        return step, f"{key}:region{region}" if region else key

    def _method_failure_count(self, method_key: str) -> int:
        counters = self.state.get("counters") or {}
        method_failures = counters.get("method_failures")
        if isinstance(method_failures, dict):
            try:
                return max(0, int(method_failures.get(method_key, 0) or 0))
            except (TypeError, ValueError):
                return 0
        attempts = counters.get("attempts") or {}
        try:
            return max(0, int(attempts.get(method_key, 0) or 0))
        except (TypeError, ValueError):
            return 0

    def _transport_recovery_limit(self) -> int:
        budget = self.state.get("budget") or {}
        try:
            return max(0, int(budget.get("max_transport_recoveries", self.goal.budget.max_transport_recoveries)))
        except (TypeError, ValueError):
            return self.goal.budget.max_transport_recoveries

    def _transport_recovery_budget_exhausted(self) -> bool:
        counters = self.state.get("counters") or {}
        try:
            used = max(0, int(counters.get("transport_recoveries", 0) or 0))
        except (TypeError, ValueError):
            used = 0
        return used >= self._transport_recovery_limit()

    def _record_transport_recovery(self, pending: dict[str, Any]) -> bool:
        """按 action_id 只登记一次已用新鲜观察对账的传输中断。"""
        action_id = str(pending.get("action_id") or "")
        if not action_id:
            return False
        counters = self.state.setdefault("counters", {"actions": 0, "attempts": {}})
        action_ids = counters.setdefault("transport_recovery_action_ids", [])
        if not isinstance(action_ids, list):
            action_ids = []
            counters["transport_recovery_action_ids"] = action_ids
        if action_id in {str(value) for value in action_ids}:
            return False
        action_ids.append(action_id)
        counters["transport_recoveries"] = max(0, int(counters.get("transport_recoveries", 0) or 0)) + 1
        return True

    def _block_transport_recovery_budget(
        self,
        *,
        action_id: str = "",
        method_key: str = "",
    ) -> dict[str, Any]:
        counters = self.state.get("counters") or {}
        used = int(counters.get("transport_recoveries", 0) or 0)
        limit = self._transport_recovery_limit()
        detail = f"传输恢复预算耗尽：未知动作重规划 {used}/{limit} 次"
        if action_id:
            detail += f"；最后 action_id={action_id}"
        if method_key:
            detail += f"；方法={method_key}"
        result = self._block("budget_transport_recovery", detail)
        if self.task_id is not None:
            self.store.log_event(
                self.task_id,
                "transport_recovery_budget_exhausted",
                {
                    "action_id": action_id,
                    "method_key": method_key,
                    "used": used,
                    "limit": limit,
                },
            )
        return result

    def _mark_attempt(self, method_key: str, *, method_failure: bool = True) -> None:
        counters = self.state.setdefault("counters", {"actions": 0, "attempts": {}})
        attempts = counters.setdefault("attempts", {})
        attempts[method_key] = int(attempts.get(method_key, 0)) + 1
        if method_failure:
            failures = counters.setdefault("method_failures", {})
            failures[method_key] = int(failures.get(method_key, 0)) + 1

    def _retry_or_block_method(self, method_key: str, detail: str) -> str:
        failures = self._method_failure_count(method_key)
        if self.goal.stage == "S3" and method_key == "s3:mine_collect:coal_ore":
            self.state["s3_coal_search_attempted"] = True
            self.state["status"] = "active"
            self.state["block_reason"] = "本次煤矿搜索未完成，按现有燃料重规划"
            self._save()
            return "retry"
        if failures >= self.goal.budget.max_attempts_per_method:
            if self.goal.stage == "S2" and method_key.startswith("s2:hunt_material:wool"):
                self.state["status"] = "active"
                self.state["block_reason"] = "当前区域找羊未成功，将换区继续搜索"
                self._save()
                return "retry"
            self._block(
                "budget_method_attempts",
                f"方法 {method_key} 达到物理失败次数上限 {failures}/{self.goal.budget.max_attempts_per_method}：{detail}",
            )
            return "blocked"
        self.state["status"] = "active"
        self.state["block_reason"] = detail
        self._save()
        return "retry"

    @staticmethod
    def _finite_number(value: Any) -> bool:
        if isinstance(value, bool):
            return False
        try:
            return math.isfinite(float(value))
        except (TypeError, ValueError):
            return False

    @classmethod
    def _finite_position(cls, value: Any) -> bool:
        return isinstance(value, dict) and all(cls._finite_number(value.get(axis)) for axis in "xyz")

    @staticmethod
    def _s6_is_overworld(value: Any) -> bool:
        return str(value or "").strip().lower() in {"overworld", "minecraft:overworld"}

    def _verify_s6_stronghold_frames(
        self,
        pending: dict[str, Any],
        data: dict[str, Any],
        state: dict[str, Any],
    ) -> tuple[bool, str]:
        search = data.get("stronghold_search")
        scan = search.get("scan") if isinstance(search, dict) else None
        if not isinstance(search, dict) or search.get("schema_version") != 1:
            return False, "Bridge 没有提供结构化要塞搜索回执"
        if search.get("phase") != "frames_found":
            return False, "Bridge 没有确认搜索阶段已发现门框"
        if not isinstance(scan, dict) or scan.get("fresh") is not True or scan.get("stable") is not True:
            return False, "门框证据不是稳定的 fresh frame scan"
        if not self._s6_is_overworld(scan.get("dimension")):
            return False, "fresh frame scan 维度不是主世界"
        observation = data.get("observation")
        if not isinstance(observation, dict) or not self._s6_is_overworld(observation.get("dimension")):
            return False, "终态 observation 没有确认当前仍在主世界"
        if not self._s6_is_overworld(state.get("dimension")):
            return False, "Core 当前 observation 没有确认主世界维度"
        if not self._finite_position(search.get("position")):
            return False, "搜索回执缺少实际当前位置"
        scan_position = observation.get("position")
        if not self._finite_position(scan_position):
            return False, "终态 observation 缺少实际坐标"
        if not self._finite_position(state.get("position")):
            return False, "Core 当前 observation 缺少实际坐标"
        radius = scan.get("radius")
        try:
            radius_value = float(radius)
        except (TypeError, ValueError):
            return False, "fresh frame scan 半径无效"
        if not math.isfinite(radius_value) or not 1 <= radius_value <= 64:
            return False, "fresh frame scan 半径超出 1-64 格"
        frames = scan.get("frames")
        if not isinstance(frames, list) or not frames:
            return False, "没有实际门框坐标，不能认定找到要塞"
        if any(not self._finite_position(frame) for frame in frames):
            return False, "门框坐标无效"
        resume = (pending.get("arguments") or {}).get("resume_search")
        expected_search_id = resume.get("search_id") if isinstance(resume, dict) else None
        if expected_search_id and search.get("search_id") != expected_search_id:
            return False, "Bridge 回执属于不同的单次要塞搜索"
        previous = self.state.get("stronghold_search")
        previous_id = previous.get("search_id") if isinstance(previous, dict) else None
        if previous_id and search.get("search_id") not in {None, previous_id}:
            return False, "Bridge 回执与 Core 持久化的 search_id 不一致"
        return True, f"fresh frame scan 在主世界观察到 {len(frames)} 个末地门框架坐标"

    def _record_s6_stronghold_success(self, pending: dict[str, Any], data: dict[str, Any]) -> None:
        search = data.get("stronghold_search")
        if not isinstance(search, dict):
            return
        context = dict(search)
        previous = self.state.get("stronghold_search")
        previous_id = previous.get("search_id") if isinstance(previous, dict) else None
        context["search_id"] = context.get("search_id") or previous_id or str(pending.get("action_id") or "")
        context["last_action_id"] = str(pending.get("action_id") or "")
        self.state["stronghold_search"] = context

    def _consume_s6_stronghold_partial(
        self,
        pending: dict[str, Any],
        status: str,
        data: dict[str, Any],
        detail: str,
    ) -> str | None:
        if self.goal.stage != "S6" or str(pending.get("tool") or "") != "throw_eye" or status not in {"partial", "preempted"}:
            return None
        raw = data.get("stronghold_search") if isinstance(data, dict) else None
        if not isinstance(raw, dict):
            return None

        previous = self.state.get("stronghold_search")
        previous_id = previous.get("search_id") if isinstance(previous, dict) else None
        raw_id = raw.get("search_id")
        search_id = str(previous_id or raw_id or pending.get("action_id") or "")
        accounting = raw.get("eye_accounting")
        descent = raw.get("descent")
        evidence = raw.get("evidence")
        try:
            throw_count = int(accounting.get("throws_completed")) if isinstance(accounting, dict) else 0
            layers = int((descent or {}).get("layers_completed", 0))
            max_layers = int((descent or {}).get("max_layers", 0) or 0)
            segment_layers = int((descent or {}).get("segment_layers", 1) or 1)
        except (TypeError, ValueError):
            throw_count = 0
            layers = -1
            max_layers = 0
            segment_layers = 0
        if not isinstance(evidence, dict):
            evidence = {}
        phase = str(raw.get("phase") or "")
        valid = (
            raw.get("schema_version") == 1
            and bool(search_id)
            and phase in {"descend", "blocked", "bearing"}
            and isinstance(descent, dict)
            and throw_count >= 1
            and 0 <= layers <= S6_STRONGHOLD_MAX_DESCENT_LAYERS
            and 0 <= max_layers <= S6_STRONGHOLD_MAX_DESCENT_LAYERS
            and 1 <= segment_layers <= S6_STRONGHOLD_SEGMENT_LAYERS
            and layers <= max_layers
            and self._finite_position(raw.get("position"))
            and isinstance(evidence, dict)
        )
        if previous_id and raw_id not in {None, previous_id}:
            valid = False
        if phase == "bearing":
            limit = raw.get("throw_limit")
            scan = raw.get("scan") or {}
            valid = (valid and isinstance(limit, int) and 1 <= throw_count < limit <= 12
                     and evidence.get("kind") == "eye_bearing"
                     and self._finite_position(evidence.get("throw_origin"))
                     and self._finite_position(evidence.get("eye_position"))
                     and isinstance(scan, dict) and scan.get("fresh") is True and scan.get("stable") is True
                     and self._s6_is_overworld(scan.get("dimension")))
        if phase == "descend":
            valid = valid and max_layers > 0
            try:
                overhead_distance = float(evidence.get("horizontal_distance"))
            except (TypeError, ValueError):
                overhead_distance = math.inf
            valid = valid and evidence.get("kind") == "eye_overhead"
            valid = valid and self._finite_position(evidence.get("throw_origin"))
            valid = valid and self._finite_position(evidence.get("eye_position"))
            valid = valid and math.isfinite(overhead_distance) and 0 <= overhead_distance < 20
            scan = raw.get("scan")
            valid = valid and isinstance(scan, dict)
            if isinstance(scan, dict):
                scan_frames = scan.get("frames")
                valid = valid and scan.get("fresh") is True and scan.get("stable") is True
                valid = valid and self._s6_is_overworld(scan.get("dimension"))
                valid = valid and isinstance(scan_frames, list) and not scan_frames
                try:
                    scan_radius = float(scan.get("radius"))
                except (TypeError, ValueError):
                    scan_radius = math.inf
                valid = valid and math.isfinite(scan_radius) and 1 <= scan_radius <= 64
            estimate = raw.get("estimate")
            if estimate is not None:
                valid = valid and isinstance(estimate, dict)
                if isinstance(estimate, dict):
                    valid = valid and all(
                        self._finite_number(estimate.get(axis))
                        for axis in ("x", "z")
                    )
        if phase == "blocked" and evidence.get("kind") == "eye_overhead":
            try:
                overhead_distance = float(evidence.get("horizontal_distance"))
            except (TypeError, ValueError):
                overhead_distance = math.inf
            valid = valid and self._finite_position(evidence.get("throw_origin"))
            valid = valid and self._finite_position(evidence.get("eye_position"))
            valid = valid and math.isfinite(overhead_distance) and 0 <= overhead_distance < 20
        if valid and phase in {"descend", "blocked"} and evidence.get("kind") == "eye_overhead":
            valid = float(evidence["eye_position"]["y"]) <= float(evidence["throw_origin"]["y"]) + 0.25
        if raw.get("resume_allowed") is True:
            valid = valid and phase == "blocked" and evidence.get("kind") == "eye_overhead"
            valid = valid and max_layers > 0 and layers < max_layers
            valid = valid and self._finite_position(raw.get("position"))
            scan = raw.get("scan")
            valid = valid and isinstance(scan, dict) and self._s6_is_overworld(scan.get("dimension"))

        if valid:
            context = dict(raw)
            context["search_id"] = search_id
            context["last_action_id"] = str(pending.get("action_id") or "")
            context["descent"] = {
                **dict(descent),
                "layers_completed": layers,
                "max_layers": max_layers,
                "segment_layers": segment_layers,
            }
        else:
            context = dict(previous) if isinstance(previous, dict) else dict(raw)
            context.update({
                "schema_version": 1,
                "search_id": search_id or None,
                "phase": "blocked",
                "resume_allowed": False,
                "last_action_id": str(pending.get("action_id") or ""),
                "stop_reason": "partial_receipt_invalid_or_mismatched; 不会重投末影之眼",
            })
            if not self._finite_position(context.get("position")):
                observed = dict(self.state_provider() or {})
                if self._finite_position(observed.get("position")):
                    context["position"] = dict(observed["position"])

        item = {
            **pending,
            "status": status,
            "receipt_confirmed": True,
            "result_detail": str(detail or ""),
            "result_data": data,
            "resolved_at": time.time(),
        }
        history = self.state.setdefault("action_history", [])
        history.append(item)
        del history[:-128]
        self.state.pop("unresolved_action", None)
        self.state["pending_action"] = None
        self.state["stronghold_search"] = context
        index = pending.get("step_index")
        if index is not None:
            self.state["method_index"] = max(int(self.state.get("method_index", 0)), int(index) + 1)
        recovery = self.state.setdefault("recovery", {})
        recovery.update({
            "needs_reconcile": False,
            "reason": "s6_stronghold_partial_consumed",
            "s6_explicit_search_resume": False,
        })
        if context.get("phase") in {"descend", "bearing"}:
            self.state["status"] = "active"
            self.state["block_reason"] = ""
            outcome = "continue"
        else:
            self.state["status"] = "blocked"
            self.state["block_reason"] = str(context.get("stop_reason") or "partial 搜索没有安全下探证据；不会重投末影之眼")
            outcome = "blocked"
        self._save()
        if self.task_id is not None:
            self.store.set_status(self.task_id, str(self.state["status"]))
            self.store.log_event(
                self.task_id,
                "s6_stronghold_partial_consumed",
                {
                    "action_id": pending.get("action_id"),
                    "search_id": context.get("search_id"),
                    "phase": context.get("phase"),
                    "throws_completed": (context.get("eye_accounting") or {}).get("throws_completed"),
                    "layers_completed": (context.get("descent") or {}).get("layers_completed"),
                },
            )
        return outcome

    @staticmethod
    def _effect_class(tool: str, declared: str = "") -> str:
        return action_effect_class(tool, declared)

    def _resolve_interrupted_action(
        self,
        pending: dict[str, Any],
        status: str,
        state: dict[str, Any],
        data: dict[str, Any],
    ) -> bool:
        """以当前观察核对终态中断；无证据的不可重放动作转为持久 blocked。"""
        action_id = str(pending.get("action_id") or "")
        tool = str(pending.get("tool") or "")
        expected = pending.get("expected_condition") or {"type": "always"}
        current = dict(self.state_provider() or state)
        if expected.get("type") == "result_event":
            event = str(expected.get("event") or "")
            verified = bool(event and self.task_id is not None and self.store.has_event(self.task_id, "goal_event", event))
            if not verified:
                verified, reason = self.verifier.check(expected, current, data)
            else:
                reason = f"事件已由目标日志确认：{event}"
        elif expected.get("type") == "always":
            if self.goal.stage == "S6" and tool == "throw_eye":
                verified, reason = self._verify_s6_stronghold_frames(pending, data, current)
            else:
                verified, reason = False, "方法只有动作完成条件，没有可观察后置证据"
        else:
            verified, reason = self._verify_pending_method_condition(
                expected, current, pending, status, data
            )

        safety = data.get("safety_interruption") or {}
        iron_work = (tool == "explore_mining_site"
                     or (tool == "mine_collect" and (pending.get("arguments") or {}).get("block") in {"iron_ore", "deepslate_iron_ore"})
                     or (tool == "strip_mine" and (pending.get("arguments") or {}).get("target") in {"iron_ore", "deepslate_iron_ore"}))
        s3_water = (self.goal.stage == "S3" and status == "preempted" and iron_work
                    and pending.get("receipt_confirmed") is True and isinstance(safety, dict)
                    and safety.get("event") == "low_oxygen" and bool(safety.get("safety_action_id")))
        if s3_water:
            location = safety.get("position") or {}
            baseline = self._dispatch_action_baseline(pending)
            usable, _ = self._state_usable(state, after=baseline) if baseline else (False, "")
            if (not usable or state.get("session_id") != pending.get("session_id")
                    or not all(isinstance(location.get(a), (int, float)) and math.isfinite(location[a]) for a in "xyz")):
                self.state["pending_action"] = pending
                self.state.setdefault("recovery", {}).update({"needs_reconcile": True, "reason": "await_fresh_low_oxygen_observation"})
                self.state["status"] = "waiting"
                self.state["block_reason"] = "低氧抢占后等待同 session 新鲜安全观察"
                self._save()
                return False
            self._record_s3_ore_outcome(pending, status, state, "低氧安全抢占")
            self.state["s3_low_oxygen_relocation_required"] = True
            ledger = self.state.setdefault("s3_ore_avoid_positions", [])
            hazard = {a: float(location[a]) for a in "xyz"}
            ledger.append(hazard)
            hazards = self.state.setdefault("s3_mining_hazards", [])
            hazards.append(hazard)
            del hazards[:-128]
            for position in ((data.get("relocation") or {}).get("attempted_positions") or []):
                if isinstance(position, dict) and all(isinstance(position.get(a), (int, float)) and math.isfinite(position[a]) for a in "xyz"):
                    ledger.append({a: float(position[a]) for a in "xyz"})
            del ledger[:-128]
            self.state["s3_last_low_oxygen"] = {"action_id": action_id, "safety": dict(safety), "observation": dict(state)}
        if status == "preempted":
            self._count_preempted_action()
        terminal_observation = data.get("observation")
        if not isinstance(terminal_observation, dict):
            terminal_observation = current
        history_item = {
            **pending,
            "status": status,
            "result_detail": str(pending.get("result_detail") or data.get("detail") or ""),
            "resolved_at": time.time(),
            "result_data": data,
            "terminal_observation": terminal_observation,
        }
        action_history = self.state.setdefault("action_history", [])
        already_in_history = self.goal.stage == "S4" and any(
            isinstance(entry, dict) and str(entry.get("action_id") or "") == action_id
            for entry in action_history
        )
        if not already_in_history:
            action_history.append(history_item)
        self.state["pending_action"] = None
        recovery = self.state.setdefault("recovery", {})

        observed_recovery = self._late_action_recovery(history_item, current)
        if observed_recovery and not verified:
            self.state["status"] = "active"
            self.state["block_reason"] = ""
            recovery.update(needs_reconcile=False, reason=observed_recovery)
            self._save()
            return True

        if verified:
            self._record_s4_action_outcomes(pending, status, current, data)
            if self.goal.stage == "S6" and tool == "throw_eye":
                self._record_s6_stronghold_success(pending, data)
            self._advance_after_success(pending, data)
            recovery.update({"needs_reconcile": False, "reason": f"{status}_condition_observed"})
            self.state["status"] = "active"
            self.state["block_reason"] = ""
            self._save()
            if self.task_id is not None:
                self.store.set_status(self.task_id, "active")
            return True

        if s3_water or self._effect_class(tool, str(pending.get("effect_class") or "")) == "replan":
            recovery.update({"needs_reconcile": False, "reason": f"{status}_replanned_from_observation"})
            self.state["status"] = "active"
            self.state["block_reason"] = ""
            self._save()
            if self.task_id is not None:
                self.store.set_status(self.task_id, "active")
                self.store.log_event(
                    self.task_id,
                    "interrupted_action_replanned",
                    {"action_id": action_id, "tool": tool, "status": status, "condition": reason},
                )
            return True

        safe_stop_handled, is_new_safe_stop = self._record_s4_safe_stop(
            pending, status, data
        )
        if safe_stop_handled:
            if is_new_safe_stop:
                self._mark_attempt(str(pending.get("method_key") or tool))
            recovery.update({"needs_reconcile": False, "reason": "known_terminal_s4_safe_stop_replanned"})
            self.state["status"] = "active"
            self.state["block_reason"] = ""
            self._save()
            if self.task_id is not None:
                self.store.set_status(self.task_id, "active")
                self.store.log_event(
                    self.task_id,
                    "goal_action_terminal_s4_safe_stop_replanned",
                    {"action_id": action_id, "tool": tool, "status": status},
                )
            return True

        s3_iron_route = (
            self.goal.stage == "S3"
            and tool == "strip_mine"
            and (pending.get("arguments") or {}).get("target") in {"iron_ore", "deepslate_iron_ore"}
            and (pending.get("method_key") == "plan:s3:0" or str(pending.get("method_key") or "").startswith("s3:ore_expose:"))
        )
        if s3_iron_route and status in {"blocked", "failed"} and pending.get("receipt_confirmed") is True:
            detail = str(pending.get("result_detail") or data.get("detail") or data.get("reason") or reason)
            self.state["last_s3_mining_failure"] = {
                "action_id": action_id,
                "status": status,
                "detail": detail,
                "data": data,
                "terminal_observation": terminal_observation,
            }
            if str(pending.get("method_key") or "").startswith("s3:ore_expose:"):
                self.state["s3_ore_expose_used"] = max(int(self.state.get("s3_ore_expose_used", 0)), int(str(pending["method_key"]).rsplit(":", 1)[-1]))
                self.state["s3_ore_no_progress"] = max(1, int(self.state.get("s3_ore_no_progress", 0)))
            recovery.update({"needs_reconcile": False, "reason": "known_terminal_s3_stripmine_replanned_from_observation"})
            self.state["status"] = "active"
            self.state["block_reason"] = ""
            self._save()
            if self.task_id is not None:
                self.store.set_status(self.task_id, "active")
                self.store.log_event(
                    self.task_id,
                    "goal_action_terminal_failure_replanned",
                    {"action_id": action_id, "tool": tool, "status": status, "detail": detail[:240], "reason": data.get("reason", "")},
                )
            return True

        self.state["unresolved_action"] = {
            "action_id": action_id,
            "tool": tool,
            "status": status,
            "effect_class": "non_replayable",
            "reason": reason,
            "result_detail": str(pending.get("result_detail") or ""),
            "result_data": data,
            "terminal_observation": terminal_observation,
            "receipt_confirmed": bool(pending.get("receipt_confirmed")),
        }
        self.state["status"] = "blocked"
        self.state["block_reason"] = f"interrupted_non_replayable_action:{tool}:{action_id}:{reason}"
        recovery.update({"needs_reconcile": False, "reason": "interrupted_non_replayable_action"})
        self._save()
        if self.task_id is not None:
            self.store.set_status(self.task_id, "blocked")
            self.store.log_event(
                self.task_id,
                "interrupted_action_blocked",
                {"action_id": action_id, "tool": tool, "status": status, "condition": reason},
            )
        return False

    async def _execute_step(self, step: StepSpec, method_key: str, step_index: int | None) -> str:
        counters = self.state.get("counters") or {}
        if int(counters.get("recovery_budget_version", 0) or 0) < RECOVERY_BUDGET_VERSION:
            self._initialize_recovery_budgets()
        if self._transport_recovery_budget_exhausted():
            self._block_transport_recovery_budget(method_key=method_key)
            return "blocked"
        counters = self.state.setdefault("counters", {"actions": 0, "attempts": {}})
        counters.setdefault("attempts", {})
        counters.setdefault("method_failures", {})
        if self._method_failure_count(method_key) >= self.goal.budget.max_attempts_per_method:
            self._block(
                "budget_method_attempts",
                f"方法 {method_key} 已达到物理失败次数上限 {self._method_failure_count(method_key)}/{self.goal.budget.max_attempts_per_method}",
            )
            return "blocked"
        action_id = uuid.uuid4().hex[:12]
        state_before = dict(self.state_provider() or {})
        pending = {
            "action_id": action_id,
            "goal_id": self.goal.goal_id,
            "method_id": self.goal.method_id,
            "method_key": method_key,
            "step_index": step_index,
            "tool": step.tool,
            "arguments": dict(step.arguments),
            "timeout_s": float(step.timeout_s),
            "expected_condition": dict(step.verify),
            "effect_class": self._effect_class(step.tool, step.effect_class),
            "session_id": state_before.get("session_id", ""),
            "revision": state_before.get("revision"),
            "started_at": time.time(),
            "status": "running",
            "method_key": method_key,
        }
        if ((self.goal.stage in {"S2", "S3", "S5"} and step.tool == "explore_mining_site")
                or step.verify.get("type") == "s5_shaft_displacement"):
            pending["baseline_position"] = dict(state_before.get("position") or {})
        if self.goal.stage == "S3" and step.tool == "mine_collect" and (step.arguments.get("block") in {"iron_ore", "deepslate_iron_ore"}):
            pending["baseline_raw_iron"] = inventory_count(state_before.get("inventory") or {}, "raw_iron")
        if self.goal.stage == "S3" and step.tool == "mine_collect" and step.arguments.get("block") in {*S3_OVERWORLD_WOOD_LOGS, "wood_log"}:
            pending["wood_search_context"] = _s3_wood_search_context(state_before)
        if self.goal.stage == "S4" and step.tool == "mine_collect":
            block = str(step.arguments.get("block") or "")
            if block == "diamond_ore":
                pending["baseline_diamond_count"] = inventory_count(
                    state_before.get("inventory") or {}, "diamond"
                )
            elif block in {*S3_OVERWORLD_WOOD_LOGS, "wood_log"}:
                pending["baseline_wood_count"] = inventory_count(
                    state_before.get("inventory") or {}, block
                )
                pending["wood_search_context"] = _s3_wood_search_context(state_before)
        self.state["pending_action"] = pending
        self.state["status"] = "active"
        self.state["block_reason"] = ""
        self.state["counters"]["actions"] = int(counters.get("actions", 0)) + 1
        self._save()
        self.store.log_event(self.task_id, "goal_action_started", {key: pending[key] for key in ("action_id", "goal_id", "method_id", "method_key", "tool", "arguments", "session_id", "revision")})
        try:
            outcome = await self._dispatch_step(step, action_id)
        except asyncio.CancelledError:
            pending["status"] = "unknown"
            self.state["status"] = "recovering"
            self.state["block_reason"] = "Core 等待动作中断，保留 action_id 待 Bridge 对账"
            self.state.setdefault("recovery", {}).update({"needs_reconcile": True, "reason": "await_cancelled"})
            self._save()
            raise
        except Exception as error:
            status = str(getattr(error, "status", "failed"))
            action_id = str(getattr(error, "action_id", "") or action_id)
            data = dict(getattr(error, "data", {}) or {})
            pending["action_id"] = action_id
            pending["status"] = status
            pending["receipt_confirmed"] = bool(getattr(error, "receipt_confirmed", False))
            pending["result_data"] = data
            pending["result_detail"] = str(error)
            if status in {"partial", "preempted"} and pending["receipt_confirmed"] is True:
                consumed = self._consume_s6_stronghold_partial(pending, status, data, str(error))
                if consumed is not None:
                    return "done" if consumed == "continue" else "blocked"
            if status == "blocked":
                admission_outcome = await self._handle_admission_rejection(pending, data, method_key)
                if admission_outcome is not None:
                    return admission_outcome
            if getattr(error, "receipt_confirmed", False) and status != "unknown":
                self._reset_admission_retry_streak(method_key)
            if status == "preempted":
                pending["status"] = "preempted"
                pending["result_data"] = data
                pending["result_detail"] = str(error)
                self.state["pending_action"] = pending
                self.state.setdefault("recovery", {}).update({"needs_reconcile": True, "reason": "preempted"})
                self._save()
                return "preempted"
            if status in {"dead", "disconnected", "unknown"}:
                pending["action_id"] = action_id
                pending["status"] = status
                pending["result_data"] = data
                self.state["status"] = status if status != "unknown" else "unknown"
                self.state["block_reason"] = f"{status}:{step.tool}:{action_id}"
                self.state.setdefault("recovery", {}).update({"needs_reconcile": True, "reason": status})
                self._save()
                self.store.set_status(self.task_id, status)
                return status
            if status == "cancelled":
                pending["status"] = "cancelled"
                pending["result_data"] = data
                pending["result_detail"] = str(error)
                if self._stop_requested:
                    self.state["pending_action"] = pending
                    self.state.setdefault("recovery", {}).update({"needs_reconcile": True, "reason": "user_stop"})
                    self.stop("user_stop")
                    return "cancelled"
                self.state["pending_action"] = pending
                self.state["status"] = "active"
                self.state["block_reason"] = "Bridge 确认动作取消，等待新观察后重评"
                self.state.setdefault("recovery", {}).update({"needs_reconcile": True, "reason": "cancelled"})
                self._save()
                return "preempted"
            self.state["pending_action"] = None
            if self._effect_class(step.tool, step.effect_class) != "replan":
                current = dict(self.state_provider() or {})
                if self._resolve_interrupted_action(pending, status, current, data):
                    return "done"
                return "blocked"
            current = dict(self.state_provider() or {})
            if pending.get("receipt_confirmed") is True:
                self._record_known_terminal_failure(pending, status, current, data, str(error))
            else:
                self._record_s3_ore_outcome(pending, status, current, str(error))
            self._mark_attempt(method_key)
            self.state["status"] = "active"
            self.state["block_reason"] = str(error)
            self._save()
            self.store.log_event(self.task_id, "goal_action_failed", {"action_id": action_id, "tool": step.tool, "status": status, "detail": str(error)[:240]})
            return self._retry_or_block_method(method_key, str(error))

        if isinstance(outcome, ActionResult):
            status = outcome.status or ("succeeded" if outcome.ok else "failed")
            data = outcome.data
            action_id = outcome.action_id or action_id
            detail = outcome.detail
            pending["action_id"] = action_id
            pending["status"] = status
            pending["receipt_confirmed"] = status != "unknown"
            pending["result_data"] = data
            pending["result_detail"] = detail
        else:
            status = "succeeded"
            data = {}
            detail = str(outcome)
            pending["receipt_confirmed"] = True
            pending["result_data"] = data
            pending["result_detail"] = detail
        if status == "blocked":
            admission_outcome = await self._handle_admission_rejection(pending, data, method_key)
            if admission_outcome is not None:
                return admission_outcome
        if status != "unknown":
            # ActionResult 是 Bridge 的真实回执；它打断 stale admission 连续计数。
            self._reset_admission_retry_streak(method_key)
        if status == "preempted":
            consumed = self._consume_s6_stronghold_partial(pending, status, data, detail)
            if consumed is not None:
                return "done" if consumed == "continue" else "blocked"
            pending["status"] = "preempted"
            pending["result_data"] = data
            pending["result_detail"] = detail
            self.state["pending_action"] = pending
            self.state.setdefault("recovery", {}).update({"needs_reconcile": True, "reason": "preempted"})
            self._save()
            return "preempted"
        if status in {"dead", "disconnected", "unknown"}:
            pending["action_id"] = action_id
            pending["status"] = status
            self.state["status"] = status
            self.state["block_reason"] = f"{status}:{step.tool}:{action_id}"
            self.state.setdefault("recovery", {}).update({"needs_reconcile": True, "reason": status})
            self._save()
            self.store.set_status(self.task_id, status)
            return status
        if status == "partial":
            consumed = self._consume_s6_stronghold_partial(pending, status, data, detail)
            if consumed is not None:
                return "done" if consumed == "continue" else "blocked"
        if status in {"failed", "blocked", "cancelled"} or not getattr(outcome, "ok", True):
            if status == "cancelled":
                pending["status"] = "cancelled"
                pending["result_data"] = data
                pending["result_detail"] = detail
                if self._stop_requested:
                    self.state["pending_action"] = pending
                    self.state.setdefault("recovery", {}).update({"needs_reconcile": True, "reason": "user_stop"})
                    self.stop("user_stop")
                    return "cancelled"
                self.state["pending_action"] = pending
                self.state["status"] = "active"
                self.state["block_reason"] = "Bridge 确认动作取消，等待新观察后重评"
                self.state.setdefault("recovery", {}).update({"needs_reconcile": True, "reason": "cancelled"})
                self._save()
                return "preempted"
            self.state["pending_action"] = None
            if self._effect_class(step.tool, step.effect_class) != "replan":
                current = dict(self.state_provider() or {})
                if self._resolve_interrupted_action(pending, status, current, data):
                    return "done"
                return "blocked"
            current = dict(self.state_provider() or {})
            self._record_known_terminal_failure(pending, status, current, data, detail)
            self.state["pending_action"] = None
            self._mark_attempt(method_key)
            self.state["block_reason"] = f"{step.tool}:{status}:{detail[:180]}"
            self._save()
            self.store.log_event(self.task_id, "goal_action_failed", {"action_id": action_id, "tool": step.tool, "status": status})
            return self._retry_or_block_method(method_key, self.state["block_reason"])

        if (
            self.goal.stage == "S4"
            and status == "succeeded"
            and step.tool == "strip_mine"
            and step.verify.get("type") == "s4_depth_reached"
        ):
            latest_state = dict(self.state_provider() or {})
            fresh = await self._wait_for_s4_depth_observation(
                pending, status, latest_state, data
            )
            if fresh is None:
                self._defer_s4_depth_action(pending)
                return "waiting"

        latest = dict(self.state_provider() or {})
        pending["status"] = status
        pending["result_data"] = data
        pending["result_detail"] = detail
        if step.verify.get("type") == "result_event":
            verified, reason = self.verifier.check(step.verify, latest, data)
        elif step.verify.get("type") == "always":
            if self.goal.stage == "S6" and step.tool == "throw_eye":
                verified, reason = self._verify_s6_stronghold_frames(pending, data, latest)
            else:
                verified, reason = status == "succeeded", f"Bridge status={status}"
        else:
            verified, reason = self._verify_pending_method_condition(
                step.verify, latest, pending, status, data
            )
        if not verified:
            self.state["pending_action"] = None
            if (
                self.goal.stage == "S6"
                and step.tool == "throw_eye"
                and self._effect_class(step.tool, step.effect_class) != "replan"
            ) or (status == "partial" and self._effect_class(step.tool, step.effect_class) != "replan"):
                self._resolve_interrupted_action(pending, status, latest, data)
                return "blocked"
            self._record_s3_ore_outcome(pending, status, latest, reason)
            self._record_s4_action_outcomes(pending, status, latest, data)
            self._mark_attempt(method_key)
            self.state["block_reason"] = f"动作完成但观察条件未满足：{reason}"
            self._save()
            self.store.log_event(self.task_id, "goal_method_condition_missing", {"action_id": action_id, "tool": step.tool, "reason": reason})
            return self._retry_or_block_method(method_key, self.state["block_reason"])

        self._record_s4_action_outcomes(pending, status, latest, data)
        self.state["pending_action"] = None
        if self.goal.stage == "S6" and step.tool == "throw_eye":
            self._record_s6_stronghold_success(pending, data)
        self._advance_after_success(pending, data)
        if step_index is not None and self.goal.stage != "S2":
            self.state["method_index"] = max(int(self.state.get("method_index", 0)), step_index + 1)
        if self.goal.stage == "S2" and step.tool == "sleep_safe":
            now = dict(self.state_provider() or {})
            if _is_day(now) is True and now.get("alive") is True:
                self.state["sleep_confirmed"] = True
        if self.goal.stage == "S2" and step.tool == "wait_for_day":
            now = dict(self.state_provider() or {})
            try:
                health = float(now.get("health", 0))
            except (TypeError, ValueError):
                health = 0.0
            if _is_day(now) is True and now.get("alive") is True and math.isfinite(health) and health > 0:
                self.state["guarded_night_confirmed"] = True
        self.state["block_reason"] = ""
        self._save()
        self.store.log_event(self.task_id, "goal_action_finished", {"action_id": action_id, "tool": step.tool, "status": status, "condition": reason})
        return "done"

    def _verify_method_condition(
        self, condition: dict[str, Any], state: dict[str, Any]
    ) -> tuple[bool, str]:
        kind = condition.get("type")
        if kind == "inside_shelter":
            ok = (state.get("shelter") or {}).get("inside") is True
            return ok, "角色已进入庇护所" if ok else "角色尚未进入庇护所"
        if kind == "outside_shelter":
            ok = (state.get("shelter") or {}).get("inside") is not True
            return ok, "角色已离开庇护所" if ok else "角色仍在庇护所内"
        if self.goal.stage == "S4" and kind == "s4_depth_reached":
            return verify_s4_depth_reached(condition, state)
        if self.goal.stage == "S2":
            if kind == "shelter":
                ok = _shelter_structurally_ready(state)
                return ok, "庇护所结构已逐格封闭" if ok else "庇护所尚未逐格封闭"
            if kind == "bed_inside":
                ok = _bed_inside(state)
                return ok, "庇护所内床位已观察到" if ok else "庇护所内未观察到床位"
        return self.verifier.check(condition, state)

    def _count_preempted_action(self) -> None:
        counters = self.state.setdefault("counters", {"actions": 0, "attempts": {}})
        counters["actions"] = max(0, int(counters.get("actions", 0)) - 1)

    async def _dispatch_step(self, step: StepSpec, action_id: str) -> Any:
        try:
            parameters = inspect.signature(self.dispatch).parameters
        except (TypeError, ValueError):
            parameters = {}
        kwargs = {
            "action_id": action_id,
            "goal_id": self.goal.goal_id,
            "intent_id": f"{self.goal.goal_id}:{self.state.get('method_index', 0)}:{step.tool}",
            "origin": "goal",
        }
        accepts_kwargs = any(item.kind == inspect.Parameter.VAR_KEYWORD for item in parameters.values())
        supported = {key: value for key, value in kwargs.items() if accepts_kwargs or key in parameters}
        positional = len(parameters)
        if positional >= 3 or accepts_kwargs:
            return await self.dispatch(step.tool, dict(step.arguments), step.timeout_s, **supported)
        return await self.dispatch(step.tool, dict(step.arguments), **supported)
