from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from voxkin.agent.run_manager import RunManager
from voxkin.agent.tasks import TaskStore


def test_run_manager_completes_s0(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    inventory: dict[str, int] = {}
    messages: list[str] = []

    async def dispatch(tool: str, arguments: dict) -> str:
        if tool == "collect_blocks":
                inventory["oak_log"] = 4
        elif tool == "craft":
            inventory[arguments["item"]] = int(arguments.get("count", 1))
        return "ok"

    async def announce(text: str) -> None:
        messages.append(text)

    manager = RunManager(
        dispatch=dispatch,
        state_provider=lambda: {"inventory": dict(inventory)},
        announce=announce,
        store=store,
        runs_dir=tmp_path / "runs",
    )

    async def scenario() -> None:
        await manager.start("S0")
        status = await manager.wait()
        assert status["running"] is False
        assert status["result"]["ok"] is True
        assert status["result"]["steps_done"] == 5
        assert inventory["wooden_pickaxe"] == 1
        assert messages[-1] == "这一阶段完成了。"

    asyncio.run(scenario())


def test_run_manager_rejects_unknown_stage(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    manager = RunManager(
        dispatch=lambda tool, arguments: asyncio.sleep(0, result="ok"),
        state_provider=lambda: {},
        announce=lambda text: asyncio.sleep(0),
        store=store,
    )

    async def scenario() -> None:
        with pytest.raises(KeyError):
            await manager.start("S9")

    asyncio.run(scenario())
