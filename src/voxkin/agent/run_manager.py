from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import Any, Awaitable, Callable

from voxkin.agent.plans import AUX_PLANS, PLANS
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
    ) -> None:
        self._dispatch = dispatch
        self._state_provider = state_provider
        self._announce = announce
        self._store = store
        self._runs_dir = Path(runs_dir)
        self._runner: TaskRunner | None = None
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
        return self._task is not None and not self._task.done()

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
            completed_events = (
                {stage.event}
                if task_id is not None
                and stage.event
                and self._store.has_event(task_id, "goal_event", stage.event)
                else set()
            )
            stage_complete = is_complete(
                stage, state.get("inventory") or {}, completed_events
            )
        return {
            "running": self.running,
            "stage": self._stage,
            "task_id": task_id,
            "stage_complete": stage_complete,
            "cursor": self._runner.cursor if self._runner is not None else 0,
            "started_at": self._started_at,
            "result": self._result,
            "death": self._death_context,
        }

    async def wait(self) -> dict[str, Any]:
        if self._task is not None:
            await self._task
        return self.status()

    async def start(self, stage: str = "S0") -> dict[str, Any]:
        if self.running:
            return self.status()
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
        steps = PLANS.get(task.stage) or AUX_PLANS.get(task.stage)
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
        if self._runner is not None:
            self._runner.cancel()
        if self._task is not None and not self._task.done():
            try:
                await asyncio.wait_for(self._task, timeout=5)
            except asyncio.TimeoutError:
                self._task.cancel()
        return self.status()

    async def close(self) -> None:
        await self.stop()
        if self._death_task is not None and not self._death_task.done():
            self._death_task.cancel()
            try:
                await self._death_task
            except asyncio.CancelledError:
                pass
