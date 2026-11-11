from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import Any, Awaitable, Callable

from voxkin.agent.plans import AUX_PLANS, PLANS
from voxkin.agent.goal_supervisor import GoalSupervisor
from voxkin.agent.goals import (
    GOAL_AUTO_TERMINAL_STATES,
    goal_for_stage,
    goal_state_blocks_automatic_transition,
    inventory_count,
)
from voxkin.agent.progress import is_complete, stage_by_id
from voxkin.agent.runlog import RunLogger
from voxkin.agent.runner import StepSpec, TaskRunner, Verifier
from voxkin.agent.tasks import TaskStore

Dispatch = Callable[..., Awaitable[Any]]
Announce = Callable[[str], Awaitable[None]]
StateProvider = Callable[[], dict[str, Any]]


class RunManager:
    """把 TaskRunner 接到 Core：启动、查询、取消一次阶段演练。"""

    def __init__(
        self,
        dispatch: Dispatch,
        state_provider: StateProvider,
        announce: Announce,
        store: TaskStore,
        runs_dir: Path | str = "runs",
        action_status: Callable[..., Awaitable[Any]] | None = None,
        state_age_provider: Callable[[], float] | None = None,
        cancel_actions: Callable[[str], Awaitable[list[str]]] | None = None,
    ) -> None:
        self._dispatch = dispatch
        self._action_status = action_status
        self._state_age_provider = state_age_provider
        self._cancel_actions = cancel_actions
        self._state_provider = state_provider
        self._announce = announce
        self._store = store
        self._runs_dir = Path(runs_dir)
        self._runner: TaskRunner | None = None
        self._goal_supervisor: GoalSupervisor | None = None
        self._goal_starting = False
        self._goal_launch_task: asyncio.Task | None = None
        self._auto_resume_key: tuple[int, str, int | None] | None = None
        self._task: asyncio.Task | None = None
        self._stage = ""
        self._task_id: int | None = None
        self._started_at: float = 0.0
        self._result: dict[str, Any] | None = None
        self._death_task: asyncio.Task | None = None
        self._death_context: dict[str, Any] | None = None
        self._pending_death_task_id: int | None = None
        self._last_death_lifecycle_id = ""
        self._last_respawn_lifecycle_id = ""

    @property
    def running(self) -> bool:
        return self._goal_starting or (self._task is not None and not self._task.done())

    def shelter_restore_hint(self) -> dict[str, Any] | None:
        """返回最近持久化的庇护所锚点，只用于 Bridge 重新观察结构。"""
        return self._store.latest_shelter_hint()

    def status(self) -> dict[str, Any]:
        if self._task_id is None and self._runner is None:
            latest_task = self._store.latest_task()
            if latest_task is not None:
                self._task_id = latest_task.id
                self._stage = latest_task.stage
                checkpoint = self._store.load_checkpoint(latest_task.id)
                checkpoint_payload = checkpoint["payload"] if checkpoint else {}
                self._result = {
                    "ok": latest_task.status == "done",
                    "status": latest_task.status,
                    "cursor": checkpoint["cursor"] if checkpoint else 0,
                    "detail": checkpoint_payload.get("detail")
                    or checkpoint_payload.get("reason")
                    or "",
                }
        task_id = self._task_id or (self._runner.task_id if self._runner is not None else None)
        stage = stage_by_id(self._stage)
        stage_complete = None
        if stage is not None:
            state = self._state_provider()
            goal_state = self._store.load_goal_state(task_id) if task_id is not None else None
            completed_events = (
                {stage.event}
                if task_id is not None
                and stage.event
                and self._store.has_event(task_id, "goal_event", stage.event)
                else set()
            )
            stage_complete = is_complete(
                stage,
                state.get("inventory") or {},
                completed_events,
                state=state,
                context={
                    "night_required": bool((goal_state or {}).get("night_required")),
                    "sleep_confirmed": bool((goal_state or {}).get("sleep_confirmed")),
                    "guarded_night_confirmed": bool((goal_state or {}).get("guarded_night_confirmed")),
                },
            )
        goal_state = self._store.load_goal_state(task_id) if task_id is not None else None
        goal_counters = (goal_state or {}).get("counters") or {}
        goal_budget = (goal_state or {}).get("budget") or {}
        pending_action = (goal_state or {}).get("pending_action")
        return {
            "running": self.running,
            "stage": self._stage,
            "task_id": task_id,
            "stage_complete": stage_complete,
            "cursor": self._runner.cursor if self._runner is not None else 0,
            "started_at": self._started_at,
            "result": self._result,
            "death": self._death_context,
            "goal": goal_state,
            "current_goal": (goal_state or {}).get("goal_id"),
            "goal_status": (goal_state or {}).get("status"),
            "pending_action": pending_action,
            "budget": goal_budget,
            "counters": goal_counters,
            "blocked_reason": (goal_state or {}).get("block_reason") or "",
            "recovery_reason": ((goal_state or {}).get("recovery") or {}).get("reason", ""),
            "waiting_reason": (goal_state or {}).get("block_reason", "") if (goal_state or {}).get("status") == "waiting" else "",
            "in_flight_action": pending_action,
            "action_budget": {
                "used": int(goal_counters.get("actions", 0)),
                "limit": int(goal_budget.get("max_actions", 0)),
                "deadline_at": (goal_state or {}).get("deadline_at"),
            },
        }

    def on_reflex_event(self, event: dict[str, Any]) -> bool:
        kind = str(event.get("event") or "")
        if kind not in {"damage", "low_health", "low_oxygen", "critical_hunger", "hostile_nearby", "safety_action"}:
            return False
        payload = event.get("data")
        if not isinstance(payload, dict):
            return False
        if self.running and self._task_id is not None:
            self._store.log_event(
                self._task_id,
                "bridge_safety_event",
                {
                    "event": kind,
                    "data": payload,
                    "action_id": payload.get("action_id"),
                    "action": payload.get("action"),
                    "phase": payload.get("phase"),
                    "executor_epoch": payload.get("executor_epoch"),
                },
            )
        # Bridge 是本地避险唯一执行方；Core 只记录该动作并交由目标层重评。
        state = self._state_provider()
        self.on_state_update(state)
        return True

    def on_action_progress(self, progress: dict[str, Any]) -> bool:
        if not self.running or self._goal_supervisor is None:
            return False
        return self._goal_supervisor.on_progress(progress)

    async def wait(self) -> dict[str, Any]:
        if self._goal_launch_task is not None:
            await self._goal_launch_task
        if self._task is not None:
            await self._task
        return self.status()

    async def start(self, stage: str = "S0") -> dict[str, Any]:
        if self.running:
            return self.status()
        goal = goal_for_stage(stage)
        if goal is not None:
            self._stage = stage
            task = self._store.create_task(goal.title, stage=stage)
            return await self._launch_goal(goal, task.id, resume=False)
        steps = PLANS.get(stage) or AUX_PLANS.get(stage)
        if steps is None:
            raise KeyError(f"未知阶段 {stage}")
        self._stage = stage
        task = self._store.create_task(stage, stage=stage)
        return await self._launch(steps, task.id, from_checkpoint=False)

    async def resume(self, task_id: int | None = None) -> dict[str, Any]:
        if self.running:
            return self.status()
        task = self._store.get_task(task_id) if task_id is not None else self._store.latest_resumable()
        if task is None:
            raise KeyError("没有可恢复的活动任务")
        if task.status == "done":
            raise ValueError(f"任务 {task.id} 已完成，不能恢复")
        existing_goal_state = self._store.load_goal_state(task.id)
        if existing_goal_state and existing_goal_state.get("status") == "done":
            self._store.set_status(task.id, "done")
            self._task_id = task.id
            self._stage = task.stage
            self._result = {
                "ok": True,
                "status": "done",
                "goal_id": existing_goal_state.get("goal_id"),
                "detail": existing_goal_state.get("detail") or "持久化目标已完成",
            }
            return self.status()
        steps = PLANS.get(task.stage) or AUX_PLANS.get(task.stage)
        goal = goal_for_stage(task.stage)
        if goal is not None:
            goal_state = self._store.load_goal_state(task.id)
            if goal_state is None:
                goal_state = {}
            # 手动 resume 是唯一清除显式 stop 的入口；仍先查 action_id 与当前世界状态。
            goal_state["status"] = "recovering"
            goal_state["block_reason"] = ""
            goal_state.setdefault("recovery", {})["needs_reconcile"] = True
            goal_state["recovery"]["reason"] = "explicit_resume"
            self._store.save_goal_state(task.id, goal_state)
            self._stage = task.stage
            return await self._launch_goal(goal, task.id, resume=True)
        if steps is None:
            raise KeyError(f"任务 {task.id} 的阶段 {task.stage} 当前没有计划")
        if self._store.load_checkpoint(task.id) is None:
            self._store.save_checkpoint(
                task.id, 0, {"reason": "resume_without_checkpoint"}
            )
        self._stage = task.stage
        return await self._launch(steps, task.id, from_checkpoint=True)

    def on_death(self, payload: dict[str, Any]) -> None:
        lifecycle_id = str(payload.get("lifecycle_id") or "")
        if lifecycle_id and lifecycle_id == self._last_death_lifecycle_id:
            return
        if lifecycle_id:
            self._last_death_lifecycle_id = lifecycle_id
        self._death_context = dict(payload)
        task_id = self._task_id if self.running else None
        self._pending_death_task_id = task_id
        if task_id is not None:
            self._store.log_event(task_id, "player_death", payload)
            goal_state = self._store.load_goal_state(task_id)
            goal_status = str((goal_state or {}).get("status") or "")
            if goal_status == "done":
                task = self._store.get_task(task_id)
                if task.status != "done":
                    self._store.complete_goal(task_id, goal_state)
            elif goal_state is not None and not goal_state_blocks_automatic_transition(goal_status):
                recovery = goal_state.setdefault("recovery", {})
                recovery.update(
                    {
                        "needs_reconcile": True,
                        "reason": "death",
                        "baseline_session_id": str(payload.get("session_id") or ""),
                        "baseline_revision": payload.get("revision"),
                    }
                )
                if not goal_state.get("pending_action"):
                    goal_state["method_index"] = 0
                goal_state["status"] = "dead"
                goal_state["block_reason"] = "角色死亡；等待重生后用新鲜观察重算目标依赖"
                self._store.save_goal_state(task_id, goal_state)
                self._store.set_status(task_id, "dead")
        if task_id is not None and self._runner is not None:
            self._runner.interrupt("dead", "玩家角色死亡，任务在当前步骤暂停")

    def on_respawn(self, payload: dict[str, Any]) -> None:
        lifecycle_id = str(payload.get("lifecycle_id") or "")
        if lifecycle_id and lifecycle_id == self._last_respawn_lifecycle_id:
            return
        if (
            lifecycle_id
            and self._last_death_lifecycle_id
            and lifecycle_id != self._last_death_lifecycle_id
        ):
            return
        if lifecycle_id:
            self._last_respawn_lifecycle_id = lifecycle_id
        self._death_context = None
        if self._task_id is not None and self._store.load_goal_state(self._task_id) is not None:
            self.on_state_update(payload)
            return
        task_id = self._pending_death_task_id
        self._pending_death_task_id = None
        if task_id is None:
            return
        checkpoint = self._store.load_checkpoint(task_id)
        task = self._store.get_task(task_id)
        steps = PLANS.get(task.stage) or AUX_PLANS.get(task.stage)
        cursor = int(checkpoint["cursor"]) if checkpoint is not None else 0
        if steps is None or cursor >= len(steps):
            return
        self._death_task = asyncio.create_task(
            self._resume_after_respawn(task_id), name=f"death-resume-{task_id}"
        )

    async def _resume_after_respawn(self, task_id: int) -> None:
        if self._task is not None and not self._task.done():
            await self._task
        state: dict[str, Any] = {}
        for _ in range(80):
            state = self._state_provider()
            position = state.get("position") or {}
            has_position = all(isinstance(position.get(axis), (int, float)) for axis in "xyz")
            try:
                health = float(state.get("health", 0))
            except (TypeError, ValueError):
                health = 0
            if state.get("alive") is True and health > 0 and has_position:
                break
            await asyncio.sleep(0.25)
        else:
            self._store.log_event(task_id, "death_recovery_wait_timeout", {"state": state})
            return
        task = self._store.get_task(task_id)
        if task.status != "dead":
            return
        checkpoint = self._store.load_checkpoint(task_id)
        cursor = int(checkpoint["cursor"]) if checkpoint is not None else 0
        steps = PLANS.get(task.stage) or AUX_PLANS.get(task.stage)
        if steps is None or cursor >= len(steps):
            return
        step = steps[cursor]
        if step.verify.get("type") not in ("inventory", "dimension", "position"):
            self._store.log_event(
                task_id,
                "death_recovery_manual_review",
                {"index": cursor, "step": step.description, "reason": "验收条件不足以证明步骤已完成"},
            )
            self._death_task = asyncio.create_task(
                self._announce(
                    f"我已重生，但当前步骤「{step.description}」没有足够的世界状态证据判断是否完成；为避免重复动作，我先暂停，请在 Studio 检查后续跑。"
                ),
                name=f"death-review-{task_id}",
            )
            return
        completed, reason = Verifier().check(step.verify, state)
        if not completed:
            self._store.log_event(
                task_id,
                "death_recovery_manual_review",
                {"index": cursor, "step": step.description, "reason": reason},
            )
            await self._announce(
                f"我已重生，但当前步骤「{step.description}」还无法确认完成（{reason}）；为避免重复消耗材料，我没有重放。请检查后在 Studio 手动续跑。"
            )
            return
        self._store.log_event(task_id, "death_recovery_started", {"state": state})
        await self.resume(task_id)

    async def _launch(
        self,
        steps: tuple[StepSpec, ...],
        task_id: int,
        from_checkpoint: bool,
    ) -> dict[str, Any]:
        self._runs_dir.mkdir(parents=True, exist_ok=True)
        logger = RunLogger(self._runs_dir / f"{self._stage}-{int(time.time())}.jsonl")
        self._runner = TaskRunner(
            executor=self._dispatch,
            state_provider=self._state_provider,
            store=self._store,
            logger=logger,
            announce=self._announce,
        )
        self._started_at = time.time()
        self._result = None
        self._task_id = task_id
        self._task = asyncio.create_task(
            self._run(steps, task_id, from_checkpoint), name=f"run-{self._stage}"
        )
        return self.status()

    async def _launch_goal(self, goal, task_id: int, *, resume: bool) -> dict[str, Any]:
        self._goal_starting = False
        self._goal_launch_task = None
        self._runs_dir.mkdir(parents=True, exist_ok=True)
        self._goal_supervisor = GoalSupervisor(
            goal,
            self._store,
            self._dispatch,
            self._state_provider,
            action_status=self._action_status,
            announce=self._announce,
            state_age_provider=self._state_age_provider,
            require_protocol=True,
        )
        self._started_at = time.time()
        self._result = None
        self._task_id = task_id
        self._task = asyncio.create_task(
            self._run_goal(task_id, resume), name=f"goal-{goal.stage}"
        )
        return self.status()

    async def _run_goal(self, task_id: int, resume: bool) -> None:
        assert self._goal_supervisor is not None
        try:
            result = await self._goal_supervisor.run(task_id, resume=resume)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            goal_state = self._store.load_goal_state(task_id)
            goal_status = str((goal_state or {}).get("status") or "")
            if goal_status in GOAL_AUTO_TERMINAL_STATES:
                if goal_status == "done" and goal_state is not None:
                    self._store.complete_goal(task_id, goal_state)
                else:
                    task_status = {
                        "paused_by_user": "cancelled",
                        "cancelled": "cancelled",
                        "blocked": "blocked",
                        "failed": "failed",
                    }.get(goal_status, goal_status)
                    self._store.set_status(task_id, task_status)
                self._result = {
                    "ok": goal_status == "done",
                    "status": goal_status,
                    "goal_id": (goal_state or {}).get("goal_id"),
                    "detail": (goal_state or {}).get("detail") or str(error),
                    "block_reason": (goal_state or {}).get("block_reason") or "",
                }
                return
            if goal_state is not None:
                goal_state["status"] = "failed"
                goal_state["block_reason"] = f"goal_supervisor_failed:{error}"
                goal_state.setdefault("recovery", {}).update(
                    {"needs_reconcile": False, "reason": "supervisor_failure"}
                )
                self._store.save_goal_state(task_id, goal_state)
            self._result = {"ok": False, "status": "failed", "detail": str(error)}
            self._store.set_status(task_id, "failed")
            self._store.log_event(task_id, "goal_supervisor_failed", {"error": str(error)})
            return
        steps_done = int(result.get("method_index", 0))
        steps_total = len(PLANS.get(self._stage, ()))
        if self._stage in {"S0", "S1"}:
            targets = goal_for_stage(self._stage).acceptance["items"]
            inventory = (self._state_provider() or {}).get("inventory") or {}
            steps_total = len(targets)
            steps_done = steps_total if result.get("status") == "done" else sum(
                inventory_count(inventory, item) >= count for item, count in targets.items()
            )
        self._result = {
            **result,
            "steps_done": steps_done,
            "steps_total": steps_total,
            "cursor": int(result.get("method_index", 0)),
        }

    def on_bridge_unavailable(self, reason: str = "bridge disconnected") -> None:
        task_id = self._task_id if self._task_id is not None else None
        if task_id is None:
            task = self._store.latest_resumable()
            task_id = task.id if task else None
        if task_id is None:
            return
        task = self._store.get_task(task_id)
        goal_state = self._store.load_goal_state(task_id)
        if goal_state is None or goal_state_blocks_automatic_transition(goal_state.get("status")):
            return
        recoverable = {"active", "recovering", "dead", "disconnected", "unknown"}
        if goal_state.get("status") not in recoverable:
            return
        if task.status not in {"active", "dead", "disconnected", "unknown"}:
            return
        goal_state.setdefault("recovery", {}).update({"needs_reconcile": True, "reason": "bridge_disconnected"})
        pending = goal_state.get("pending_action")
        if isinstance(pending, dict):
            pending["status"] = "unknown"
        goal_state["status"] = "disconnected"
        goal_state["block_reason"] = "Bridge 断开；保留目标和在途 action_id，等待重连对账"
        self._store.save_goal_state(task_id, goal_state)
        self._store.set_status(task_id, "disconnected")

    def on_state_update(self, state: dict[str, Any]) -> bool:
        """只在 ready、alive、安全动作结束且观察前进后自动恢复持久化目标。"""
        if self.running:
            return False
        task = self._store.get_task(self._task_id) if self._task_id is not None else self._store.latest_resumable()
        if task is None:
            return False
        goal = goal_for_stage(task.stage)
        goal_state = self._store.load_goal_state(task.id)
        if goal is None or goal_state is None or goal_state_blocks_automatic_transition(goal_state.get("status")):
            return False
        recoverable_goal_states = {"active", "dead", "disconnected", "unknown", "recovering", "preempted", "waiting"}
        if goal_state.get("status") not in recoverable_goal_states:
            return False
        if task.status not in {"active", "dead", "disconnected", "unknown", "preempted"} and goal_state.get("status") not in {"recovering", "dead", "disconnected", "unknown", "preempted", "waiting"}:
            return False
        executor = state.get("executor") or {}
        if (
            state.get("ready") is not True
            or state.get("alive") is not True
            or executor.get("safety_active") is not False
            or "active_action_id" not in executor
            or executor.get("active_action_id")
        ):
            return False
        session = str(state.get("session_id") or "")
        if not session:
            return False
        try:
            revision = int(state.get("revision"))
        except (TypeError, ValueError):
            return False
        recovery = goal_state.get("recovery") or {}
        baseline_revision = recovery.get("baseline_revision")
        baseline_session = str(recovery.get("baseline_session_id") or "")
        if baseline_revision is not None:
            try:
                if session == baseline_session and revision <= int(baseline_revision):
                    return False
            except (TypeError, ValueError):
                return False
        key = (task.id, session, revision)
        if key == self._auto_resume_key:
            return False
        self._auto_resume_key = key
        self._task_id = task.id
        self._stage = task.stage
        goal_state["status"] = "recovering"
        goal_state["block_reason"] = ""
        recovery = goal_state.setdefault("recovery", {})
        recovery["needs_reconcile"] = True
        recovery["baseline_session_id"] = session
        recovery["baseline_revision"] = revision
        self._store.save_goal_state(task.id, goal_state)
        self._goal_starting = True
        self._goal_launch_task = asyncio.create_task(
            self._launch_goal(goal, task.id, resume=True),
            name=f"auto-resume-{task.id}",
        )
        return True

    async def _run(
        self, steps: tuple[StepSpec, ...], task_id: int, from_checkpoint: bool
    ) -> None:
        assert self._runner is not None
        try:
            result = await self._runner.run(
                self._stage,
                list(steps),
                task_id=task_id,
                from_checkpoint=from_checkpoint,
            )
        except asyncio.CancelledError:
            cursor = self._runner.cursor
            self._store.save_checkpoint(
                task_id, cursor, {"reason": "run_manager_cancelled"}
            )
            self._store.set_status(task_id, "cancelled")
            self._store.log_event(
                task_id, "run_cancelled", {"cursor": cursor, "reason": "manager_cancelled"}
            )
            self._result = {
                "ok": False,
                "cursor": cursor,
                "detail": "任务已取消",
                "steps_done": cursor,
                "steps_total": len(steps),
                "status": "cancelled",
            }
            return
        self._task_id = result.task_id
        self._result = {
            "ok": result.ok,
            "cursor": result.cursor,
            "detail": result.detail,
            "steps_done": result.steps_done,
            "steps_total": result.steps_total,
            "status": result.status,
        }

    async def stop(self) -> dict[str, Any]:
        self.request_stop()
        if self._goal_supervisor is not None and self._cancel_actions is not None:
            await self._cancel_actions("玩家要求停止目标")
        if self._runner is not None:
            self._runner.cancel()
        if self._task is not None and not self._task.done():
            try:
                await asyncio.wait_for(self._task, timeout=5)
            except asyncio.TimeoutError:
                self._task.cancel()
                try:
                    await self._task
                except asyncio.CancelledError:
                    pass
        return self.status()

    def request_stop(self) -> dict[str, Any]:
        """同步持久化显式停止意图，供 WebSocket 读循环立即继续消费回执。"""
        if self._goal_supervisor is not None and self._task is not None and not self._task.done():
            self._goal_supervisor.stop("user_stop")
        if self._task_id is not None:
            goal_state = self._store.load_goal_state(self._task_id)
            active_statuses = {"active", "waiting", "recovering", "dead", "disconnected", "unknown", "preempted"}
            if goal_state is not None and goal_state.get("status") in active_statuses:
                if self._goal_supervisor is not None and not (self._task is not None and not self._task.done()):
                    self._goal_supervisor.stop("user_stop")
                goal_state = self._store.load_goal_state(self._task_id) or goal_state
                goal_state["status"] = "paused_by_user"
                goal_state["block_reason"] = "目标由用户停止"
                self._store.save_goal_state(self._task_id, goal_state)
                self._store.set_status(self._task_id, "cancelled")
        if self._runner is not None:
            self._runner.cancel()
        return self.status()

    async def close(self) -> None:
        if self._goal_launch_task is not None and not self._goal_launch_task.done():
            self._goal_launch_task.cancel()
            try:
                await self._goal_launch_task
            except asyncio.CancelledError:
                pass
            self._goal_launch_task = None
            self._goal_starting = False
        if self._goal_supervisor is not None and self._task is not None and not self._task.done():
            # Core shutdown is a recoverable interruption, not an explicit user stop.
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        elif self._runner is not None and self._task is not None and not self._task.done():
            self._runner.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        if self._death_task is not None and not self._death_task.done():
            self._death_task.cancel()
            try:
                await self._death_task
            except asyncio.CancelledError:
                pass
