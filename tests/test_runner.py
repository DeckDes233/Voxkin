from __future__ import annotations

import asyncio
from pathlib import Path

from voxkin.agent.runlog import RunLogger
from voxkin.agent.runner import StepSpec, TaskRunner
from voxkin.agent.tasks import TaskStore


def make_store(tmp_path: Path) -> TaskStore:
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    return store


def test_runner_completes_steps(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    logger = RunLogger(tmp_path / "run.jsonl")
    state = {"inventory": {}}
    calls: list[str] = []

    async def executor(tool: str, arguments: dict) -> str:
        calls.append(tool)
        state["inventory"]["oak_log"] = 3
        if tool == "collect_blocks":
            state["inventory"]["wooden_pickaxe"] = 1
        return "ok"

    steps = [
        StepSpec("收集木头", "collect_blocks", {"block": "oak_log", "count": 3}, {"type": "inventory", "items": {"oak_log": 3}}),
        StepSpec("做木镐", "craft", {"item": "wooden_pickaxe"}, {"type": "inventory", "items": {"wooden_pickaxe": 1}}),
    ]
    runner = TaskRunner(executor, lambda: state, store, logger=logger)
    result = asyncio.run(runner.run("S0", steps))
    assert result.ok
    assert result.cursor == 2
    assert calls == ["collect_blocks", "craft"]
    assert store.get_task(result.task_id).status == "done"
    assert logger.tail()[-1]["kind"] == "step"


def test_runner_blocks_when_verification_fails(tmp_path: Path) -> None:
    store = make_store(tmp_path)

    async def executor(tool: str, arguments: dict) -> str:
        return "done"

    steps = [
        StepSpec("挖钻石", "collect_blocks", {"block": "diamond_ore"}, {"type": "inventory", "items": {"diamond": 1}}),
    ]
    runner = TaskRunner(executor, lambda: {"inventory": {}}, store)
    result = asyncio.run(runner.run("S4", steps))
    assert not result.ok
    assert result.cursor == 0
    assert store.get_task(result.task_id).status == "blocked"


def test_runner_waits_for_fresh_state(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    inventory: dict[str, int] = {}
    polls = {"count": 0}

    async def executor(tool: str, arguments: dict) -> str:
        inventory["oak_log"] = 3
        return "ok"

    def state() -> dict:
        polls["count"] += 1
        if polls["count"] <= 5:
            return {"inventory": {}}
        return {"inventory": dict(inventory)}

    steps = [StepSpec("收集木头", "collect_blocks", {"block": "oak_log"}, {"type": "inventory", "items": {"oak_log": 3}})]
    runner = TaskRunner(executor, state, store)
    result = asyncio.run(runner.run("S0", steps))
    assert result.ok
    assert polls["count"] > 5


def test_runner_retries_then_succeeds(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    attempts = {"count": 0}

    async def executor(tool: str, arguments: dict) -> str:
        attempts["count"] += 1
        if attempts["count"] == 1:
            raise RuntimeError("网络抖动")
        return "ok"

    steps = [StepSpec("走一步", "goto", {"x": 1, "y": 2, "z": 3}, {"type": "always"}, retries=1)]
    runner = TaskRunner(executor, lambda: {}, store)
    result = asyncio.run(runner.run("M0", steps))
    assert result.ok
    assert attempts["count"] == 2


def test_runner_resumes_from_checkpoint(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    task = store.create_task("S1")
    store.save_checkpoint(task.id, 1, {"step": "done"})
    calls: list[str] = []

    async def executor(tool: str, arguments: dict) -> str:
        calls.append(tool)
        return "ok"

    steps = [
        StepSpec("第一步", "a", {}, {"type": "always"}),
        StepSpec("第二步", "b", {}, {"type": "always"}),
    ]
    runner = TaskRunner(executor, lambda: {}, store)
    result = asyncio.run(runner.run("S1", steps, task_id=task.id))
    assert result.ok
    assert calls == ["b"]
    assert store.resume_cursor(task.id) == 2


def test_run_logger_tail(tmp_path: Path) -> None:
    logger = RunLogger(tmp_path / "events.jsonl")
    logger.log("state", {"health": 20})
    logger.log("step", {"ok": True})
    tail = logger.tail(1)
    assert tail == [{"ts": tail[0]["ts"], "kind": "step", "ok": True}]
