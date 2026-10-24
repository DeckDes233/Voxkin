from __future__ import annotations

from pathlib import Path

from voxkin.agent.tasks import TaskStore


def test_task_lifecycle(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("独立通关 Minecraft", stage="S0")
    assert task.status == "active"
    assert store.latest_active() == task
    store.set_status(task.id, "paused", stage="S1")
    assert store.get_task(task.id).stage == "S1"
    assert store.latest_active() is None
    store.set_status(task.id, "active")
    assert store.latest_active() is not None
    store.set_status(task.id, "cancelled")
    assert store.latest_resumable() == store.get_task(task.id)
    assert store.latest_task() == store.get_task(task.id)
    store.close()


def test_latest_task_returns_none_for_empty_store(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    assert store.latest_task() is None
    store.close()


def test_steps_and_events(tmp_path: Path) -> None:
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S0")
    step = store.add_step(task.id, 1, "收集木头", tool="collect_blocks", arguments={"block": "oak_log"})
    assert step.status == "pending"
    assert step.arguments == {"block": "oak_log"}
    store.finish_step(step.id, "done", "挖到 3 个橡木")
    assert store.steps(task.id)[0].status == "done"
    store.log_event(task.id, "stage_complete", {"stage": "S0"})
    store.log_event(task.id, "goal_event", {"event": "ender_dragon_killed"})
    events = store.events(task.id)
    assert events[-2]["kind"] == "stage_complete"
    assert events[-2]["payload"] == {"stage": "S0"}
    assert store.has_event(task.id, "goal_event", "ender_dragon_killed")
    assert not store.has_event(task.id, "goal_event", "other_event")
    store.close()
