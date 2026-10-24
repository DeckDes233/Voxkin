from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from voxkin.agent.run_manager import RunManager
from voxkin.agent.tasks import TaskStore
from voxkin.agent.actions import ActionError


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


def test_respawn_does_not_automatically_resume_unrelated_old_task(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    old_task = store.create_task("S0", stage="S0")
    store.save_checkpoint(old_task.id, 0, {"status": "dead"})
    store.set_status(old_task.id, "dead")
    calls: list[str] = []

    async def dispatch(tool: str, arguments: dict) -> str:
        calls.append(tool)
        return "unexpected"

    manager = RunManager(
        dispatch=dispatch,
        state_provider=lambda: {
            "alive": True,
            "health": 20,
            "position": {"x": 0, "y": 64, "z": 0},
            "inventory": {"oak_log": 4},
        },
        announce=lambda text: asyncio.sleep(0),
        store=store,
        runs_dir=tmp_path / "runs",
    )

    async def scenario() -> None:
        manager.on_respawn({"alive": True, "health": 20})
        await asyncio.sleep(0)
        assert manager._death_task is None
        assert calls == []
        assert store.get_task(old_task.id).status == "dead"

    asyncio.run(scenario())


def test_run_manager_reconciles_world_when_resuming_without_checkpoint(
    tmp_path: Path,
) -> None:
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S0", stage="S0")
    store.set_status(task.id, "failed")
    inventory = {
        "oak_log": 4,
        "oak_planks": 12,
        "crafting_table": 1,
        "stick": 4,
        "wooden_pickaxe": 1,
    }
    calls: list[str] = []

    async def dispatch(tool: str, arguments: dict) -> str:
        calls.append(tool)
        return "ok"

    manager = RunManager(
        dispatch=dispatch,
        state_provider=lambda: {"inventory": dict(inventory)},
        announce=lambda text: asyncio.sleep(0),
        store=store,
        runs_dir=tmp_path / "runs",
    )

    async def scenario() -> None:
        await manager.resume(task.id)
        result = await manager.wait()
        assert result["result"]["ok"] is True
        assert calls == []
        assert store.resume_cursor(task.id) == 5

    asyncio.run(scenario())


def test_run_manager_persists_forced_cancellation(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()

    async def dispatch(tool: str, arguments: dict) -> str:
        await asyncio.Event().wait()
        return "unreachable"

    manager = RunManager(
        dispatch=dispatch,
        state_provider=lambda: {},
        announce=lambda text: asyncio.sleep(0),
        store=store,
        runs_dir=tmp_path / "runs",
    )

    async def scenario() -> None:
        status = await manager.start("S0")
        task_id = status["task_id"]
        await asyncio.sleep(0.01)
        assert manager._task is not None
        manager._task.cancel()
        result = await manager.wait()
        assert result["result"]["status"] == "cancelled"
        assert store.get_task(task_id).status == "cancelled"
        assert store.load_checkpoint(task_id)["payload"]["reason"] == "run_manager_cancelled"

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


def test_run_manager_status_reads_stage_event_from_current_task(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S6", stage="S6")
    manager = RunManager(
        dispatch=lambda tool, arguments: asyncio.sleep(0, result="ok"),
        state_provider=lambda: {"inventory": {}},
        announce=lambda text: asyncio.sleep(0),
        store=store,
    )
    manager._stage = "S6"
    manager._task_id = task.id

    assert manager.status()["stage_complete"] is False

    store.log_event(task.id, "goal_event", {"event": "ender_dragon_killed"})

    assert manager.status()["stage_complete"] is True


def test_run_manager_restores_completed_stage_status_after_restart(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S6", stage="S6")
    store.log_event(
        task.id,
        "goal_event",
        {"event": "ender_dragon_killed", "evidence": "dragon_health_zero"},
    )
    store.save_checkpoint(task.id, 6, {"detail": "阶段完成"})
    store.set_status(task.id, "done")
    manager = RunManager(
        dispatch=lambda tool, arguments: asyncio.sleep(0, result="ok"),
        state_provider=lambda: {"inventory": {}},
        announce=lambda text: asyncio.sleep(0),
        store=store,
    )

    status = manager.status()

    assert status["task_id"] == task.id
    assert status["stage"] == "S6"
    assert status["stage_complete"] is True
    assert status["result"] == {
        "ok": True,
        "status": "done",
        "cursor": 6,
        "detail": "阶段完成",
    }


def test_run_manager_resumes_latest_checkpointed_task(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S0", stage="S0")
    store.save_checkpoint(task.id, 1, {"reason": "bridge restarted"})
    store.set_status(task.id, "cancelled")
    inventory = {"oak_log": 4, "oak_planks": 12, "crafting_table": 1, "stick": 4}
    calls: list[str] = []

    async def dispatch(tool: str, arguments: dict) -> str:
        calls.append(tool)
        inventory[arguments["item"]] = int(arguments.get("count", 1))
        return "ok"

    manager = RunManager(
        dispatch=dispatch,
        state_provider=lambda: {"inventory": dict(inventory)},
        announce=lambda text: asyncio.sleep(0),
        store=store,
        runs_dir=tmp_path / "runs",
    )

    async def scenario() -> None:
        status = await manager.resume()
        assert status["task_id"] == task.id
        result = await manager.wait()
        assert result["result"]["ok"] is True
        assert result["result"]["steps_done"] == 5
        assert calls == ["craft"]
        assert store.get_task(task.id).status == "done"

    asyncio.run(scenario())


def test_death_recovery_skips_completed_collect_step_and_continues(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    state = {
        "alive": True,
        "health": 20,
        "position": {"x": 0, "y": 64, "z": 0},
        "inventory": {},
    }
    calls: list[str] = []
    first = {"value": True}
    messages: list[str] = []
    manager_holder: dict[str, RunManager] = {}

    async def dispatch(tool: str, arguments: dict, timeout_s: float) -> str:
        calls.append(tool)
        if first["value"]:
            first["value"] = False
            manager_holder["manager"].on_death({"health": 0})
            raise ActionError("角色死亡", status="dead")
        item = arguments["item"]
        state["inventory"][item] = int(arguments.get("count", 1))
        return "ok"

    async def announce(text: str) -> None:
        messages.append(text)

    manager = RunManager(
        dispatch=dispatch,
        state_provider=lambda: state,
        announce=announce,
        store=store,
        runs_dir=tmp_path / "runs",
    )
    manager_holder["manager"] = manager

    async def scenario() -> None:
        started = await manager.start("S0")
        task_id = started["task_id"]
        dead = await manager.wait()
        assert dead["result"]["status"] == "dead"
        assert store.get_task(task_id).status == "dead"
        assert store.resume_cursor(task_id) == 0

        state["inventory"]["oak_log"] = 4
        manager.on_respawn({"alive": True, "health": 20, "position": state["position"]})
        await asyncio.sleep(0.02)
        await manager.wait()

        assert calls == ["collect_blocks", "craft", "craft", "craft", "craft"]
        assert store.get_task(task_id).status == "done"
        assert any(event["kind"] == "step_recovered" for event in store.events(task_id))

    asyncio.run(scenario())


def test_duplicate_death_lifecycle_events_are_ignored(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    manager = RunManager(
        dispatch=lambda tool, arguments: asyncio.sleep(0),
        state_provider=lambda: {},
        announce=lambda text: asyncio.sleep(0),
        store=store,
        runs_dir=tmp_path / "runs",
    )
    task = store.create_task("S0", stage="S0")
    manager._task_id = task.id
    async def scenario() -> None:
        manager._task = asyncio.create_task(asyncio.sleep(30))
        manager.on_death({"lifecycle_id": "death-7", "health": 0})
        manager.on_death({"lifecycle_id": "death-7", "health": 0})

        events = store.events(task.id)
        assert len([event for event in events if event["kind"] == "player_death"]) == 1
        manager._task.cancel()
        try:
            await manager._task
        except asyncio.CancelledError:
            pass

    asyncio.run(scenario())


def test_death_recovery_does_not_replay_unverifiable_step(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("M3 shelter", stage="M3_SHELTER")
    store.save_checkpoint(task.id, 1, {"status": "dead"})
    store.set_status(task.id, "dead")
    state = {
        "alive": True,
        "health": 20,
        "position": {"x": 0, "y": 64, "z": 0},
        "inventory": {"dirt": 40},
    }
    calls: list[str] = []
    messages: list[str] = []

    async def dispatch(tool: str, arguments: dict) -> str:
        calls.append(tool)
        return "unexpected"

    manager = RunManager(
        dispatch=dispatch,
        state_provider=lambda: state,
        announce=lambda text: messages.append(text) or asyncio.sleep(0),
        store=store,
        runs_dir=tmp_path / "runs",
    )

    async def scenario() -> None:
        manager._pending_death_task_id = task.id
        manager.on_respawn(state)
        await manager._death_task

        assert calls == []
        assert store.get_task(task.id).status == "dead"
        assert store.events(task.id)[-1]["kind"] == "death_recovery_manual_review"
        assert "避免重复动作" in messages[-1]

    asyncio.run(scenario())
