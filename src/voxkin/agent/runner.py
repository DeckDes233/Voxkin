from __future__ import annotations

import asyncio
import inspect
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from voxkin.agent.runlog import RunLogger
from voxkin.agent.tasks import TaskStore

Executor = Callable[..., Awaitable[str]]
StateProvider = Callable[[], dict[str, Any]]
Announce = Callable[[str], Awaitable[None]]


@dataclass(frozen=True)
class StepSpec:
    description: str
    tool: str
    arguments: dict[str, Any]
    verify: dict[str, Any]
    retries: int = 1
    timeout_s: float = 60.0


class Verifier:
    """只读世界状态做机器判定，不调用模型。"""

    def check(self, rule: dict[str, Any], state: dict[str, Any]) -> tuple[bool, str]:
        kind = rule.get("type")
        if kind == "always":
            return True, "无需判定"
        if kind == "inventory":
            inventory = state.get("inventory") or {}
            missing = {
                item: count - int(inventory.get(item, 0))
                for item, count in (rule.get("items") or {}).items()
                if int(inventory.get(item, 0)) < count
            }
            return (not missing, "背包满足" if not missing else f"缺少 {missing}")
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
            return (
                state.get("dimension") == rule.get("value"),
                f"维度 {state.get('dimension')}",
            )
        if kind == "health":
            health = float(state.get("health", 0))
            return (health >= float(rule.get("min", 1)), f"血量 {health:.0f}")
        if kind == "food":
            food = float(state.get("food", 0))
            return (food >= float(rule.get("min", 1)), f"饥饿 {food:.0f}")
        return False, f"未知判定规则 {kind}"


@dataclass
class RunResult:
    ok: bool
    task_id: int
    cursor: int
    detail: str
    steps_done: int = 0
    steps_total: int = 0


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
        self.cursor = 0
        self.task_id: int | None = None

    def pause(self) -> None:
        self._paused = True

    def resume(self) -> None:
        self._paused = False

    def cancel(self) -> None:
        self._cancelled = True

    @staticmethod
    def _accepts_timeout(executor: Executor) -> bool:
        """执行器可以多接一个 timeout_s 参数，用来把步骤预算传动作层。"""
        try:
            parameters = inspect.signature(executor).parameters
        except (TypeError, ValueError):
            return False
        return len(parameters) >= 3

    async def _execute(self, step: StepSpec) -> str:
        if self._executor_takes_timeout:
            return await self._executor(step.tool, step.arguments, step.timeout_s)
        return await self._executor(step.tool, step.arguments)

    async def _say(self, text: str) -> None:
        if self._announce is not None:
            await self._announce(text)

    async def _verify_with_wait(self, rule: dict[str, Any]) -> tuple[bool, str]:
        """桥接状态 5 秒一帧；动作刚结束时允许等待下一帧完整状态。"""
        state = self._state_provider()
        ok, reason = self._verifier.check(rule, state)
        for _ in range(60):
            if ok:
                break
            await asyncio.sleep(0.1)
            state = self._state_provider()
            ok, reason = self._verifier.check(rule, state)
        return ok, reason

    async def run(
        self,
        objective: str,
        steps: list[StepSpec],
        task_id: int | None = None,
        from_checkpoint: bool = True,
    ) -> RunResult:
        task = self._store.get_task(task_id) if task_id is not None else self._store.create_task(objective)
        self.task_id = task.id
        start = self._store.resume_cursor(task.id) if from_checkpoint else 0
        self.cursor = start
        self._store.set_status(task.id, "active")
        total = len(steps)
        done = 0
        for index in range(start, total):
            if self._cancelled:
                self._store.save_checkpoint(task.id, index, {"reason": "cancelled"})
                self._store.set_status(task.id, "cancelled")
                return RunResult(False, task.id, index, "任务已取消", done, total)
            while self._paused and not self._cancelled:
                await asyncio.sleep(0.2)
            step = steps[index]
            detail = ""
            ok = False
            reason = ""
            for attempt in range(step.retries + 1):
                try:
                    detail = await asyncio.wait_for(
                        self._execute(step), timeout=step.timeout_s
                    )
                except Exception as error:  # noqa: BLE001 - 执行器失败要转成步骤失败
                    detail = f"执行失败: {error}"
                    ok = False
                    reason = "exception"
                else:
                    ok, reason = await self._verify_with_wait(step.verify)
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
                        },
                    )
                if ok:
                    break
                await asyncio.sleep(0.2)
            if not ok:
                self.cursor = index
                self._store.save_checkpoint(
                    task.id, index, {"step": step.description, "reason": reason}
                )
                self._store.set_status(task.id, "blocked")
                self._store.log_event(
                    task.id, "step_blocked", {"index": index, "reason": reason}
                )
                await self._say(f"{step.description}没做成，先停一下。")
                return RunResult(False, task.id, index, reason, done, total)
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
