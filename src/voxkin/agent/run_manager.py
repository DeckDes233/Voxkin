from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import Any, Awaitable, Callable

from voxkin.agent.plans import AUX_PLANS, PLANS
from voxkin.agent.runlog import RunLogger
from voxkin.agent.runner import StepSpec, TaskRunner
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

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    def status(self) -> dict[str, Any]:
        return {
            "running": self.running,
            "stage": self._stage,
            "task_id": self._task_id
            or (self._runner.task_id if self._runner is not None else None),
            "cursor": self._runner.cursor if self._runner is not None else 0,
            "started_at": self._started_at,
            "result": self._result,
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
        self._runs_dir.mkdir(parents=True, exist_ok=True)
        logger = RunLogger(self._runs_dir / f"{stage}-{int(time.time())}.jsonl")
        self._runner = TaskRunner(
            executor=self._dispatch,
            state_provider=self._state_provider,
            store=self._store,
            logger=logger,
            announce=self._announce,
        )
        self._started_at = time.time()
        self._result = None
        self._task = asyncio.create_task(self._run(steps), name=f"run-{stage}")

    async def _run(self, steps: tuple[StepSpec, ...]) -> None:
        assert self._runner is not None
        result = await self._runner.run(self._stage, list(steps))
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
