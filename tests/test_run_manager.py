from __future__ import annotations

import asyncio
import sqlite3
import time
from pathlib import Path

import pytest

from voxkin.agent.run_manager import RunManager
from voxkin.agent.tasks import TaskStore
from voxkin.agent.actions import ActionError


def modern_state(inventory: dict[str, int] | None = None, *, revision: int = 1) -> dict:
    return {
        "session_id": "world-1",
        "revision": revision,
        "ready": True,
        "alive": True,
        "health": 20,
        "food": 12,
        "position": {"x": 0, "y": 64, "z": 0},
        "dimension": "overworld",
        "is_day": True,
        "inventory": dict(inventory or {}),
        "executor": {"active_action_id": None, "safety_active": False, "epoch": 1},
    }


def test_run_manager_completes_s0(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    state = modern_state()
    inventory: dict[str, int] = state["inventory"]
    messages: list[str] = []

    async def dispatch(tool: str, arguments: dict, timeout_s: float = 0, **kwargs) -> str:
        if tool == "mine_collect":
            inventory["oak_log"] = 4
        elif tool == "craft":
            inventory[arguments["item"]] = int(arguments.get("count", 1))
        state["revision"] += 1
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

    async def scenario() -> None:
        await manager.start("S0")
        status = await manager.wait()
        assert status["running"] is False
        assert status["result"]["ok"] is True
        assert status["result"]["steps_done"] == 2
        assert inventory["wooden_pickaxe"] == 1
        assert messages[-1] == "目标「木头与工作台」已由当前观察验收完成。"

    asyncio.run(scenario())


@pytest.mark.asyncio
@pytest.mark.parametrize("manual_resume", [True, False])
async def test_resume_preserves_budget_after_shutdown_at_start(tmp_path, manual_resume):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    state = modern_state({"wooden_pickaxe": 1, "crafting_table": 1})

    def manager():
        return RunManager(lambda *a, **kw: pytest.fail("目标已满足"), lambda: state,
                          lambda text: asyncio.sleep(0), store, runs_dir=tmp_path / "runs")

    first = manager()
    started = await first.start("S0", budget_mode="adaptive")
    assert started["action_budget"]["mode"] == "adaptive"
    assert started["action_budget"]["limit"] == 24
    await first.close()

    restarted = manager()
    if manual_resume:
        await restarted.resume(started["task_id"])
    else:
        assert restarted.on_state_update(state)
    finished = await restarted.wait()
    assert finished["stage_complete"] and finished["result"]["ok"]
    assert finished["action_budget"]["mode"] == "adaptive"
    assert finished["goal"]["progress_watchdog"]["action_limit"] == finished["action_budget"]["limit"]


def test_status_reports_absolute_adaptive_limit_after_extensions(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("采钻", "S4", initial_goal_state={
        "budget": {"mode": "adaptive", "max_actions": 24},
        "counters": {"actions": 122},
        "progress_watchdog": {"action_limit": 143},
    })
    manager = RunManager(lambda *args: asyncio.sleep(0), modern_state, lambda text: asyncio.sleep(0), store)
    status = manager.status()
    assert status["task_id"] == task.id
    assert status["action_budget"] == {"mode": "adaptive", "used": 122, "limit": 143, "deadline_at": None}


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
        state_provider=lambda: modern_state(inventory),
        announce=lambda text: asyncio.sleep(0),
        store=store,
        runs_dir=tmp_path / "runs",
    )

    async def scenario() -> None:
        await manager.resume(task.id)
        result = await manager.wait()
        assert result["result"]["ok"] is True
        assert calls == []
        assert store.load_goal_state(task.id)["status"] == "done"

    asyncio.run(scenario())


def test_run_manager_persists_forced_cancellation(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    state = modern_state()

    async def dispatch(tool: str, arguments: dict, timeout_s: float = 0, **kwargs) -> str:
        await asyncio.Event().wait()
        return "unreachable"

    manager = RunManager(
        dispatch=dispatch,
        state_provider=lambda: state,
        announce=lambda text: asyncio.sleep(0),
        store=store,
        runs_dir=tmp_path / "runs",
    )

    async def scenario() -> None:
        status = await manager.start("S0")
        task_id = status["task_id"]
        await asyncio.sleep(0.01)
        assert manager._task is not None
        manager.request_stop()
        manager._task.cancel()
        result = await manager.wait()
        assert result["result"]["status"] == "cancelled"
        assert store.get_task(task_id).status == "cancelled"
        goal_state = store.load_goal_state(task_id)
        assert goal_state["status"] == "paused_by_user"
        assert goal_state["pending_action"]["status"] == "unknown"

    asyncio.run(scenario())


@pytest.mark.parametrize("timestamp_key", ["updated_at", "paused_at"])
def test_resume_preserves_unused_budget_after_an_overnight_pause(tmp_path, timestamp_key):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S0", stage="S0")
    paused = time.time() - 86400
    store.save_goal_state(task.id, {"status": "paused_by_user", timestamp_key: paused, "deadline_at": paused + 45,
                                    "counters": {"actions": 7}})
    state = modern_state({"wooden_pickaxe": 1, "crafting_table": 1})
    manager = RunManager(dispatch=lambda *args: pytest.fail("目标已满足"), state_provider=lambda: state,
                         announce=lambda text: asyncio.sleep(0), store=store, runs_dir=tmp_path / "runs")

    async def scenario():
        before = time.time()
        await manager.resume(task.id)
        result = await manager.wait()
        saved = store.load_goal_state(task.id)
        assert result["stage_complete"] and saved["counters"]["actions"] == 7
        assert before + 45 <= saved["deadline_at"] <= time.time() + 45

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
        state_provider=lambda: modern_state(),
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
        state_provider=lambda: modern_state(),
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


@pytest.mark.asyncio
async def test_resume_s6_accepts_dragon_evidence_before_recent_progress(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S6", stage="S6")
    store.log_event(task.id, "goal_event", {"event": "ender_dragon_killed"})
    with sqlite3.connect(store.path) as history:
        history.executemany(
            "insert into events (task_id, kind, created_at) values (?, 'goal_action_progress', 0)",
            ((task.id,) for _ in range(10001)),
        )
    history.close()

    async def dispatch(*args, **kwargs):
        pytest.fail("已有末影龙击杀证据，不应再派发动作")

    manager = RunManager(dispatch, modern_state, lambda _: asyncio.sleep(0), store, tmp_path)
    await manager.resume(task.id)
    status = await manager.wait()
    assert status["stage_complete"] is True
    assert status["goal_status"] == "done"
    store.close()


def test_run_manager_resumes_latest_checkpointed_task(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S0", stage="S0")
    store.save_checkpoint(task.id, 1, {"reason": "bridge restarted"})
    store.set_status(task.id, "cancelled")
    inventory = {"oak_log": 4, "oak_planks": 12, "crafting_table": 1, "stick": 4}
    calls: list[str] = []
    state = modern_state()
    state["inventory"].update(inventory)
    inventory = state["inventory"]

    async def dispatch(tool: str, arguments: dict, timeout_s: float = 0, **kwargs) -> str:
        calls.append(tool)
        inventory[arguments["item"]] = int(arguments.get("count", 1))
        state["revision"] += 1
        return "ok"

    manager = RunManager(
        dispatch=dispatch,
        state_provider=lambda: state,
        announce=lambda text: asyncio.sleep(0),
        store=store,
        runs_dir=tmp_path / "runs",
    )

    async def scenario() -> None:
        status = await manager.resume()
        assert status["task_id"] == task.id
        result = await manager.wait()
        assert result["result"]["ok"] is True
        assert result["result"]["steps_done"] == 2
        assert calls == ["craft"]
        assert store.get_task(task.id).status == "done"

    asyncio.run(scenario())


def test_death_recovery_skips_completed_collect_step_and_continues(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    state = modern_state()
    calls: list[str] = []
    first = {"value": True}
    messages: list[str] = []
    manager_holder: dict[str, RunManager] = {}

    async def dispatch(tool: str, arguments: dict, timeout_s: float = 0, **kwargs) -> str:
        calls.append(tool)
        if first["value"]:
            first["value"] = False
            state["alive"] = False
            state["health"] = 0
            manager_holder["manager"].on_death(
                {"health": 0, "session_id": "world-1", "revision": state["revision"]}
            )
            raise ActionError("角色死亡", status="dead", action_id=kwargs.get("action_id", ""))
        item = arguments["item"]
        state["inventory"][item] = int(arguments.get("count", 1))
        state["revision"] += 1
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

        state["alive"] = True
        state["health"] = 20
        state["inventory"]["oak_log"] = 4
        state["revision"] += 1
        manager.on_respawn(state)
        await asyncio.sleep(0.02)
        await manager.wait()

        assert calls == ["mine_collect", "craft", "craft", "craft", "craft"]
        assert store.get_task(task_id).status == "done"
        assert any(event["kind"] == "goal_recovery_started" for event in store.events(task_id))

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
