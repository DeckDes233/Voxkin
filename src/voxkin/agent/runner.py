from __future__ import annotations

import asyncio
import inspect
import math
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from voxkin.agent.runlog import RunLogger
from voxkin.agent.action_effects import action_effect_class
from voxkin.agent.tasks import TaskStore
from voxkin.bridge.protocol import ActionResult

Executor = Callable[..., Awaitable[Any]]
StateProvider = Callable[[], dict[str, Any]]
Announce = Callable[[str], Awaitable[None]]

_VANILLA_DIMENSIONS = {
    "overworld": "minecraft:overworld",
    "minecraft:overworld": "minecraft:overworld",
    "the_nether": "minecraft:the_nether",
    "minecraft:the_nether": "minecraft:the_nether",
    "the_end": "minecraft:the_end",
    "minecraft:the_end": "minecraft:the_end",
}


def _dimension_id(value: Any) -> str:
    dimension = str(value or "").strip().lower()
    return _VANILLA_DIMENSIONS.get(dimension, dimension)


@dataclass(frozen=True)
class StepSpec:
    description: str
    tool: str
    arguments: dict[str, Any]
    verify: dict[str, Any]
    retries: int = 1
    timeout_s: float = 60.0
    effect_class: str = "reconcile"


class Verifier:
    """只读世界状态做机器判定，不调用模型。"""

    @staticmethod
    def _inventory_count(inventory: dict[str, Any], item: str) -> int:
        if item == "bed":
            suffix = "bed"
            return sum(
                int(count)
                for name, count in inventory.items()
                if name == suffix or name.endswith(f"_{suffix}")
            )
        if item == "wool":
            return max((int(count) for name, count in inventory.items() if name.endswith("_wool")), default=0)
        return int(inventory.get(item, 0))

    def check(
        self,
        rule: dict[str, Any],
        state: dict[str, Any],
        result_data: dict[str, Any] | None = None,
    ) -> tuple[bool, str]:
        kind = rule.get("type")
        if kind == "always":
            return True, "无需判定"
        if kind == "inventory_free_slots":
            free = state.get("inventory_free_slots")
            return isinstance(free, int) and free >= rule["min"], f"背包空格 {free}，目标至少 {rule['min']}"
        if kind == "result_event":
            event = str(rule.get("event") or "")
            events = (result_data or {}).get("events") or []
            matched = bool(event) and isinstance(events, list) and event in events
            return matched, f"结果事件{'包含' if matched else '缺少'} {event}"
        if kind == "inventory":
            inventory = state.get("inventory") or {}
            missing = {
                item: count - self._inventory_count(inventory, item)
                for item, count in (rule.get("items") or {}).items()
                if self._inventory_count(inventory, item) < count
            }
            return (not missing, "背包满足" if not missing else f"缺少 {missing}")
        if kind == "inventory_any":
            inventory = state.get("inventory") or {}
            items = rule.get("items") or {}
            available = sum(self._inventory_count(inventory, item) for item in items)
            required = int(rule.get("count", 1))
            return (
                available >= required,
                "背包满足" if available >= required else f"可用物品共 {available} 个，还差 {required - available} 个",
            )
        if kind == "max_height":
            y = (state.get("position") or {}).get("y")
            dimension = str(state.get("dimension") or "").removeprefix("minecraft:")
            reached = dimension == rule["dimension"] and type(y) in (int, float) and math.isfinite(y) and y <= rule["y"]
            return reached, f"实际维度 {dimension}，高度 {y}"
        if kind == "min_height":
            y = (state.get("position") or {}).get("y")
            target = rule["y"]
            return isinstance(y, (int, float)) and y >= target, f"实际高度 {y}，目标至少 {target}"
        if kind == "position":
            position = state.get("position") or {}
            target = rule.get("target") or {}
            radius = float(rule.get("radius", 2.0))
            if not all(isinstance(position.get(axis), (int, float)) for axis in "xyz"):
                return False, "没有位置状态"
            distance = (
                (float(position["x"]) - float(target.get("x", 0))) ** 2
                + (float(position["y"]) - float(target.get("y", 0))) ** 2
                + (float(position["z"]) - float(target.get("z", 0))) ** 2
            ) ** 0.5
            return (distance <= radius, f"距离 {distance:.1f} 格")
        if kind == "dimension":
            actual = state.get("dimension")
            expected = rule.get("value")
            return (
                _dimension_id(actual) == _dimension_id(expected),
                f"维度 {actual}",
            )
        if kind == "health":
            health = float(state.get("health", 0))
            return (health >= float(rule.get("min", 1)), f"血量 {health:.0f}")
        if kind == "food":
            food = float(state.get("food", 0))
            return (food >= float(rule.get("min", 1)), f"饥饿 {food:.0f}")
        if kind == "daylight":
            daylight = state.get("is_day") is True
            health = float(state.get("health", 0))
            return (
                daylight and health >= float(rule.get("min_health", 1)),
                f"白天 {daylight}，血量 {health:.0f}",
            )
        return False, f"未知判定规则 {kind}"

    def classify(self, rule: dict[str, Any], state: dict[str, Any]) -> str:
        """判定失败属于哪一类：有进展算部分完成，没进展算被环境阻塞。"""
        if rule.get("type") == "inventory":
            inventory = state.get("inventory") or {}
            wanted = rule.get("items") or {}
            progress = any(self._inventory_count(inventory, item) > 0 for item in wanted)
            return "partial" if progress else "blocked"
        return "blocked"


@dataclass
class RunResult:
    ok: bool
    task_id: int
    cursor: int
    detail: str
    steps_done: int = 0
    steps_total: int = 0
    status: str = "succeeded"


class TaskRunner:
    """PLAN → ACT → VERIFY → RECOVER 的最小循环。

    Planner 暂时由调用方给出 StepSpec 列表；后续接 LLM 只替换计划来源。
    """

    def __init__(
        self,
        executor: Executor,
        state_provider: StateProvider,
        store: TaskStore,
        logger: RunLogger | None = None,
        verifier: Verifier | None = None,
        announce: Announce | None = None,
    ) -> None:
        self._executor = executor
        self._executor_takes_timeout = self._accepts_timeout(executor)
        self._state_provider = state_provider
        self._store = store
        self._logger = logger
        self._verifier = verifier or Verifier()
        self._announce = announce
        self._paused = False
        self._cancelled = False
        self._interrupt_status = ""
        self._interrupt_detail = ""
        self.cursor = 0
        self.task_id: int | None = None

    def pause(self) -> None:
        self._paused = True

    def resume(self) -> None:
        self._paused = False

    def cancel(self) -> None:
        self._cancelled = True

    def interrupt(self, status: str, detail: str) -> None:
        self._interrupt_status = status
        self._interrupt_detail = detail

    @staticmethod
    def _accepts_timeout(executor: Executor) -> bool:
        """执行器可以多接一个 timeout_s 参数，用来把步骤预算传动作层。"""
        try:
            parameters = inspect.signature(executor).parameters
        except (TypeError, ValueError):
            return False
        return len(parameters) >= 3

    async def _execute(self, step: StepSpec) -> Any:
        if self._executor_takes_timeout:
            return await self._executor(step.tool, step.arguments, step.timeout_s)
        return await self._executor(step.tool, step.arguments)

    async def _say(self, text: str) -> None:
        if self._announce is not None:
            await self._announce(text)

    async def _verify_with_wait(
        self, rule: dict[str, Any]
    ) -> tuple[bool, str, str]:
        """桥接状态 5 秒一帧；动作刚结束时允许等待下一帧完整状态。"""
        state = self._state_provider()
        ok, reason = self._verifier.check(rule, state)
        for _ in range(60):
            if self._interrupt_status:
                return False, self._interrupt_detail, self._interrupt_status
            if ok:
                break
            await asyncio.sleep(0.1)
            state = self._state_provider()
            ok, reason = self._verifier.check(rule, state)
        status = "succeeded" if ok else self._verifier.classify(rule, state)
        return ok, reason, status

    async def run(
        self,
        objective: str,
        steps: list[StepSpec],
        task_id: int | None = None,
        from_checkpoint: bool = True,
    ) -> RunResult:
        task = self._store.get_task(task_id) if task_id is not None else self._store.create_task(objective)
        self.task_id = task.id
        checkpoint = self._store.load_checkpoint(task.id) if from_checkpoint else None
        start = int(checkpoint["cursor"]) if checkpoint is not None else 0
        recovering = checkpoint is not None
        self.cursor = start
        self._store.set_status(task.id, "active")
        total = len(steps)
        done = min(start, total)
        for index in range(start, total):
            if self._interrupt_status:
                status = self._interrupt_status
                detail = self._interrupt_detail
                self.cursor = index
                self._store.save_checkpoint(
                    task.id, index, {"reason": detail, "status": status}
                )
                self._store.set_status(task.id, status)
                self._store.log_event(
                    task.id, f"task_{status}", {"index": index, "reason": detail}
                )
                return RunResult(
                    False, task.id, index, detail, done, total, status=status
                )
            if self._cancelled:
                self._store.save_checkpoint(task.id, index, {"reason": "cancelled"})
                self._store.set_status(task.id, "cancelled")
                return RunResult(
                    False, task.id, index, "任务已取消", done, total, status="cancelled"
                )
            while self._paused and not self._cancelled:
                await asyncio.sleep(0.2)
            step = steps[index]
            if recovering:
                already_done = False
                if step.verify.get("type") != "always":
                    result_data: dict[str, Any] = {}
                    if step.verify.get("type") == "result_event":
                        expected_event = str(step.verify.get("event") or "")
                        if self._store.has_event(task.id, "goal_event", expected_event):
                            result_data = {"events": [expected_event]}
                    already_done, verify_reason = self._verifier.check(
                        step.verify, self._state_provider(), result_data
                    )
                if already_done:
                    detail = f"恢复检查通过：{verify_reason}，跳过重复动作"
                    self.cursor = index + 1
                    done += 1
                    self._store.save_checkpoint(
                        task.id, index + 1, {"step": step.description, "detail": detail}
                    )
                    self._store.log_event(
                        task.id, "step_recovered", {"index": index, "detail": detail}
                    )
                    if self._logger is not None:
                        self._logger.log(
                            "step",
                            {
                                "task_id": task.id,
                                "index": index,
                                "description": step.description,
                                "tool": step.tool,
                                "arguments": step.arguments,
                                "attempt": 0,
                                "detail": detail,
                                "ok": True,
                                "reason": "checkpoint_state_satisfied",
                                "status": "succeeded",
                                "skill_id": step.tool,
                                "action_id": "",
                            },
                        )
                    continue
                recovering = False
            detail = ""
            ok = False
            reason = ""
            status = "failed"
            skill_id = step.tool
            action_id = ""
            result_data: dict[str, Any] = {}
            preemptions = 0
            attempt = 0
            while attempt <= step.retries:
                result_data = {}
                try:
                    outcome = await asyncio.wait_for(
                        self._execute(step), timeout=step.timeout_s
                    )
                except Exception as error:  # noqa: BLE001 - 执行器失败要转成步骤失败
                    if self._interrupt_status:
                        detail = self._interrupt_detail
                        reason = self._interrupt_detail
                        status = self._interrupt_status
                    else:
                        detail = f"执行失败: {error}"
                        reason = "exception"
                        status = getattr(error, "status", "failed")
                    ok = False
                else:
                    if self._interrupt_status:
                        detail = self._interrupt_detail
                        reason = self._interrupt_detail
                        status = self._interrupt_status
                    elif isinstance(outcome, ActionResult):
                        detail = outcome.detail
                        status = outcome.status
                        skill_id = outcome.skill_id or step.tool
                        action_id = outcome.action_id
                        result_data = outcome.data
                        if step.verify.get("type") == "always":
                            ok = outcome.ok and status == "succeeded"
                            reason = (
                                "动作报告成功"
                                if ok
                                else f"动作未报告成功：{status}"
                            )
                        elif step.verify.get("type") == "result_event":
                            event_ok, reason = self._verifier.check(
                                step.verify, self._state_provider(), outcome.data
                            )
                            ok = outcome.ok and status == "succeeded" and event_ok
                            if not ok and outcome.ok and status == "succeeded":
                                status = "blocked"
                        else:
                            ok, reason, verify_status = await self._verify_with_wait(
                                step.verify
                            )
                            if not ok:
                                status = verify_status
                    else:
                        detail = str(outcome)
                        status = "succeeded"
                        if step.verify.get("type") == "result_event":
                            ok, reason = self._verifier.check(
                                step.verify, self._state_provider()
                            )
                            verify_status = "blocked"
                        else:
                            ok, reason, verify_status = await self._verify_with_wait(
                                step.verify
                            )
                        if not ok:
                            status = verify_status
                if self._logger is not None:
                    self._logger.log(
                        "step",
                        {
                            "task_id": task.id,
                            "index": index,
                            "description": step.description,
                            "tool": step.tool,
                            "arguments": step.arguments,
                            "attempt": attempt,
                            "detail": detail,
                            "ok": ok,
                            "reason": reason,
                            "status": status,
                            "skill_id": skill_id,
                            "action_id": action_id,
                        },
                    )
                if status == "preempted":
                    preemptions += 1
                    refreshed, safe = await self._wait_after_preemption()
                    verified, verify_reason = self._verifier.check(step.verify, refreshed)
                    if safe and step.verify.get("type") != "always" and verified:
                        ok = True
                        detail = f"安全动作后状态验收通过：{verify_reason}"
                        reason = "preempted_step_verified"
                        status = "succeeded"
                    elif (
                        safe
                        and step.verify.get("type") != "always"
                        and action_effect_class(step.tool, step.effect_class) == "replan"
                        and preemptions <= 3
                    ):
                        self._store.log_event(
                            task.id,
                            "step_preempted_retry",
                            {"index": index, "reason": reason, "verify": verify_reason},
                        )
                        continue
                    else:
                        detail = "抢占后未取得安全结束与新观察，步骤已暂停"
                        status = "blocked"
                if ok:
                    status = "succeeded"
                    break
                if status in ("cancelled", "disconnected", "dead", "preempted", "unknown"):
                    break
                attempt += 1
                await asyncio.sleep(0.2)
            if not ok:
                self.cursor = index
                self._store.save_checkpoint(
                    task.id,
                    index,
                    {
                        "step": step.description,
                        "reason": reason,
                        "status": status,
                    },
                )
                if status == "cancelled":
                    self._store.set_status(task.id, "cancelled")
                    self._store.log_event(
                        task.id, "step_cancelled", {"index": index, "reason": reason}
                    )
                    return RunResult(
                        False, task.id, index, "步骤已取消", done, total, status="cancelled"
                    )
                if status in ("disconnected", "dead", "unknown"):
                    self._store.set_status(task.id, status)
                    self._store.log_event(
                        task.id,
                        f"step_{status}",
                        {"index": index, "reason": reason, "status": status},
                    )
                    return RunResult(
                        False, task.id, index, detail or reason, done, total, status=status
                    )
                self._store.set_status(
                    task.id, status if status in ("blocked", "dead") else "failed"
                )
                event_kind = f"step_{status}"
                self._store.log_event(
                    task.id,
                    event_kind,
                    {"index": index, "reason": reason, "status": status},
                )
                if status == "disconnected":
                    await self._say("Minecraft 桥接断开了，我先停在这一步。")
                elif status == "dead":
                    await self._say("我在执行时死亡了，检查点已保存；等重生后先核对当前步骤。")
                else:
                    await self._say(f"{step.description}没做成，先停一下。")
                return RunResult(
                    False, task.id, index, detail or reason, done, total, status=status
                )
            if step.verify.get("type") == "result_event":
                self._store.log_event(
                    task.id,
                    "goal_event",
                    {
                        "event": step.verify.get("event"),
                        "evidence": result_data.get("evidence"),
                        "step_index": index,
                        "skill_id": skill_id,
                        "action_id": action_id,
                    },
                )
            done += 1
            self.cursor = index + 1
            self._store.save_checkpoint(
                task.id, index + 1, {"step": step.description, "detail": detail}
            )
            self._store.log_event(
                task.id, "step_done", {"index": index, "detail": detail}
            )
        self._store.set_status(task.id, "done")
        await self._say("这一阶段完成了。")
        return RunResult(True, task.id, total, "阶段完成", done, total)

    async def _wait_after_preemption(self) -> tuple[dict[str, Any], bool]:
        before = self._state_provider()
        before_session = str(before.get("session_id") or "")
        try:
            before_revision = int(before.get("revision"))
        except (TypeError, ValueError):
            before_revision = None
        for _ in range(600):
            if self._cancelled or self._interrupt_status in ("dead", "disconnected", "cancelled"):
                return self._state_provider(), False
            await asyncio.sleep(0.1)
            state = self._state_provider()
            executor = state.get("executor") or {}
            try:
                revision = int(state.get("revision"))
            except (TypeError, ValueError):
                revision = None
            advanced = (
                before_revision is None
                or revision is None
                or str(state.get("session_id") or "") != before_session
                or revision > before_revision
            )
            safe = (
                state.get("ready", True) is True
                and not bool(executor.get("safety_active"))
                and state.get("alive", True) is True
                and advanced
            )
            if safe:
                return state, True
        return self._state_provider(), False
