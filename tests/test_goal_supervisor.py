from __future__ import annotations

import asyncio
from dataclasses import replace
import time

import pytest

from voxkin.agent.actions import ActionError
from voxkin.agent.goal_supervisor import (
    GoalSupervisor,
    choose_early_survival_action,
    choose_early_action,
    choose_s2_action,
    choose_s3_preflight_action,
    choose_s3_resource_action,
)
from voxkin.agent.goals import GOALS, GoalBudget, evaluate_condition, method_for_goal
from voxkin.agent.run_manager import RunManager
from voxkin.agent.runner import StepSpec
from voxkin.agent.tasks import TaskStore
from voxkin.bridge.protocol import ActionProgress, ActionResult, ActionStatusResult


def modern_state(**updates: object) -> dict:
    state = {
        "session_id": "world-1",
        "revision": 1,
        "ready": True,
        "alive": True,
        "health": 20,
        "food": 12,
        "position": {"x": 0, "y": 64, "z": 0},
        "dimension": "overworld",
        "is_day": True,
        "inventory": {},
        "executor": {"active_action_id": None, "safety_active": False, "epoch": 1},
    }
    state.update(updates)
    return state


@pytest.mark.asyncio
async def test_observation_wakes_goal_and_requires_revision_progress(tmp_path):
    store = TaskStore(tmp_path / "observation.db")
    store.initialize()
    event = asyncio.Event()
    sampled = asyncio.Event()
    current = modern_state()

    def observe():
        sampled.set()
        return current

    supervisor = GoalSupervisor(GOALS["S3"], store, None, observe, observation_event=event)
    supervisor.state = supervisor._new_state()
    task = asyncio.create_task(supervisor._wait_for_usable_state(after=("world-1", 1)))
    try:
        await asyncio.wait_for(sampled.wait(), 1)
        sampled.clear()
        event.set()
        await asyncio.wait_for(sampled.wait(), 1)
        assert not task.done()
        current["revision"] = 2
        event.set()
        assert (await asyncio.wait_for(task, 1))["revision"] == 2
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        store.close()


@pytest.mark.asyncio
async def test_observation_and_night_evidence_are_checkpointed_together(tmp_path, monkeypatch):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S0")
    state = modern_state(is_day=False, inventory={"wooden_pickaxe": 1, "crafting_table": 1})
    snapshots = []
    save = store.save_goal_state

    def record_save(task_id, payload):
        if payload.get("last_observation"):
            snapshots.append((payload["last_observation"]["revision"], payload["night_required"]))
        save(task_id, payload)

    monkeypatch.setattr(store, "save_goal_state", record_save)
    supervisor = GoalSupervisor(GOALS["S0"], store, None, lambda: state)
    assert (await supervisor.run(task.id))["status"] == "done"
    assert snapshots == [(1, True)]
    store.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("terminal, expected", [("done", "done"), ("paused_by_user", "cancelled"), ("blocked", "blocked")])
async def test_observation_honors_terminal_saved_while_waiting(tmp_path, terminal, expected):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S0")

    def observe():
        saved = store.load_goal_state(task.id)
        saved.update(status=terminal, block_reason="从另一个入口结束")
        store.save_goal_state(task.id, saved)
        return modern_state()

    async def dispatch(*args, **kwargs):
        pytest.fail("已持久化的终态不可派发动作")

    supervisor = GoalSupervisor(GOALS["S0"], store, dispatch, observe)
    assert (await supervisor.run(task.id))["status"] == expected
    assert store.load_goal_state(task.id)["status"] == terminal
    store.close()


def test_early_survival_finds_food_instead_of_repeatedly_resuming_wood():
    hungry = modern_state(food=8, inventory={})
    step = choose_early_survival_action(hungry)
    assert step is not None and step.tool == "hunt_animal"
    step = choose_early_survival_action(modern_state(food=8, inventory={"bread": 1}))
    assert step is not None and step.tool == "eat_if_hungry"
    step = choose_early_survival_action(modern_state(food=0, inventory={"sweet_berries": 1}))
    assert step is not None and step.verify == {"type": "food", "min": 1}
    assert choose_early_survival_action(modern_state(food=9)) is None
    assert choose_early_survival_action(modern_state(food=8, is_day=False)) is None


def test_s1_uses_observed_owned_table_instead_of_crafting_another():
    state = modern_state(nearby_owned_crafting_table=True,
                         inventory={"stone_pickaxe": 1, "stick": 2, "cobblestone": 10})
    step = choose_early_action("S1", state)
    assert step.tool == "craft" and step.arguments["item"] == "stone_sword"
    state["nearby_owned_crafting_table"] = False
    fallback = choose_early_action("S1", state)
    assert fallback.tool != "craft" or fallback.arguments.get("item") != "stone_sword"


@pytest.mark.asyncio
async def test_respawn_reconciles_terminal_dead_action_then_completes_from_new_observation(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S0", "S0")
    state = modern_state(
        revision=7,
        inventory={"wooden_pickaxe": 1, "crafting_table": 1},
    )
    calls: list[str] = []
    status_queries: list[str] = []

    async def dispatch(tool: str, arguments: dict, **kwargs):
        calls.append(tool)
        raise AssertionError("目标条件已完成，不应重放动作")

    async def action_status(action_id: str):
        status_queries.append(action_id)
        return ActionStatusResult(action_id, "dead", "角色死亡时动作终止", data={"observation": dict(state)})

    supervisor = GoalSupervisor(GOALS["S0"], store, dispatch, lambda: state, action_status=action_status)
    saved = supervisor._new_state()
    saved.update(
        {
            "status": "dead",
            "pending_action": {
                "action_id": "old-action",
                "tool": "collect_blocks",
                "method_key": "plan:s0:0",
                "effect_class": "replan",
                "expected_condition": {"type": "inventory", "items": {"oak_log": 4}},
                "session_id": "world-1",
                "revision": 6,
            },
            "recovery": {
                "needs_reconcile": True,
                "reason": "death",
                "baseline_session_id": "world-1",
                "baseline_revision": 6,
            },
        }
    )
    store.save_goal_state(task.id, saved)
    store.set_status(task.id, "dead")

    result = await supervisor.run(task.id, resume=True)

    assert result["status"] == "done"
    assert status_queries == ["old-action"]
    assert calls == []
    final_state = store.load_goal_state(task.id)
    assert final_state["pending_action"] is None
    assert final_state["action_history"][0]["status"] == "dead"
    assert store.get_task(task.id).status == "done"


@pytest.mark.asyncio
async def test_unknown_non_replayable_action_blocks_without_reissuing_it(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S0", "S0")
    state = modern_state()
    calls: list[str] = []

    async def dispatch(tool: str, arguments: dict, **kwargs):
        calls.append(tool)
        return "should not replay"

    async def action_status(action_id: str):
        return ActionStatusResult(action_id, "unknown", "账本没有该动作")

    supervisor = GoalSupervisor(GOALS["S0"], store, dispatch, lambda: state, action_status=action_status)
    saved = supervisor._new_state()
    saved.update(
        {
            "status": "unknown",
            "pending_action": {
                "action_id": "throw-unknown",
                "tool": "throw_eye",
                "method_key": "plan:s5:throw",
                "expected_condition": {"type": "always"},
                "session_id": "world-1",
                "revision": 0,
            },
            "recovery": {
                "needs_reconcile": True,
                "reason": "core_restart",
                "baseline_session_id": "world-1",
                "baseline_revision": 0,
            },
        }
    )
    store.save_goal_state(task.id, saved)
    result = await supervisor.run(task.id, resume=True)

    assert result["status"] == "blocked"
    assert "unknown_action_outcome" in result["block_reason"]
    assert calls == []
    saved = store.load_goal_state(task.id)
    assert saved["pending_action"] is None
    assert saved["unresolved_action"]["action_id"] == "throw-unknown"


@pytest.mark.asyncio
async def test_expired_resume_reconciles_pending_from_fresh_observation_before_budget(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S3", "S3")
    calls: list[str] = []
    state = modern_state(
        session_id="new-session",
        revision=1,
        inventory={"crafting_table": 1, "oak_log": 0},
    )

    async def dispatch(tool: str, arguments: dict, **kwargs):
        calls.append(f"dispatch:{tool}")
        raise AssertionError("旧 pending 对账与过期结算期间不得派发新动作")

    async def action_status(action_id: str):
        calls.append(f"status:{action_id}")
        return ActionStatusResult(action_id, "unknown", "新 Bridge 没有旧 action ledger")

    def state_provider():
        calls.append("state")
        return state

    supervisor = GoalSupervisor(
        GOALS["S3"], store, dispatch, state_provider, action_status=action_status
    )
    deadline_at = time.time() - 10
    pending = {
        "action_id": "1e55e347dc3a",
        "goal_id": "stage:s3",
        "method_id": "s3_ore_adaptive",
        "method_key": "s3:wood_search:overworld:-2:9:4:oak_log",
        "step_index": None,
        "tool": "mine_collect",
        "arguments": {"block": "oak_log", "count": 1, "range": 64},
        "timeout_s": 250.0,
        "expected_condition": {"type": "inventory", "items": {"oak_log": 1}},
        "effect_class": "replan",
        "session_id": "old-session",
        "revision": 21,
        "started_at": deadline_at - 1,
        "status": "disconnected",
        "receipt_confirmed": False,
        "result_data": {},
        "result_detail": "Bridge 断开，动作结果未知",
    }
    counters = {
        "actions": 2,
        "attempts": {},
        "method_failures": {},
        "transport_recoveries": 0,
        "transport_recovery_action_ids": [],
        "recovery_budget_version": 1,
        "admission_retries": {},
        "admission_rejections_total": {},
    }
    saved = supervisor._new_state()
    saved.update(
        {
            "status": "recovering",
            "deadline_at": deadline_at,
            "method_index": 0,
            "counters": counters,
            "pending_action": pending,
            "recovery": {
                "needs_reconcile": True,
                "reason": "explicit_resume",
                "baseline_session_id": "old-session",
                "baseline_revision": 21,
            },
        }
    )
    saved.pop("action_history", None)
    store.save_goal_state(task.id, saved)
    store.set_status(task.id, "cancelled")
    store.log_event(task.id, "goal_action_finished", {"action_id": "3520b792b45a", "status": "succeeded"})

    result = await supervisor.run(task.id, resume=True)

    assert result["status"] == "blocked"
    assert result["block_reason"] == "budget_elapsed"
    assert calls[0] == "state"
    assert calls[1] == "status:1e55e347dc3a"
    assert "dispatch:mine_collect" not in calls
    persisted = store.load_goal_state(task.id)
    assert persisted["deadline_at"] == deadline_at
    assert persisted["pending_action"] is None
    assert persisted["action_history"][0]["action_id"] == "1e55e347dc3a"
    assert persisted["action_history"][0]["status"] == "unknown_reconciled_for_replan"
    assert persisted["counters"]["actions"] == counters["actions"]
    assert persisted["counters"]["attempts"] == {
        "s3:wood_search:overworld:-2:9:4:oak_log": 1
    }
    assert persisted["counters"]["transport_recoveries"] == 1
    assert persisted["method_index"] == 0
    assert persisted["recovery"]["needs_reconcile"] is False
    assert persisted["last_observation"]["session_id"] == "new-session"
    assert any(
        event["kind"] == "goal_action_finished"
        and event["payload"].get("action_id") == "3520b792b45a"
        for event in store.events(task.id)
    )
    assert store.get_task(task.id).status == "blocked"
    store.close()


@pytest.mark.asyncio
async def test_deadline_crossed_while_waiting_reconciles_pending_before_budget(tmp_path, monkeypatch):
    clock = {"now": 1000.0}
    monkeypatch.setattr("voxkin.agent.goal_supervisor.time.time", lambda: clock["now"])
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S3", "S3")
    calls: list[str] = []
    state = modern_state(session_id="reconnected-session", revision=1)

    async def dispatch(tool: str, arguments: dict, **kwargs):
        calls.append(f"dispatch:{tool}")
        raise AssertionError("到期 pending 对账期间不得派发新动作")

    async def action_status(action_id: str):
        calls.append(f"status:{action_id}")
        return ActionStatusResult(action_id, "unknown", "新 Bridge 没有旧 action ledger")

    supervisor = GoalSupervisor(
        GOALS["S3"], store, dispatch, lambda: state, action_status=action_status
    )
    pending = {
        "action_id": "late-deadline-goto",
        "tool": "goto",
        "method_key": "s3:surface_route:shelter_anchor",
        "session_id": "old-session",
        "revision": 20,
        "effect_class": "replan",
        "status": "disconnected",
        "receipt_confirmed": False,
    }
    saved = supervisor._new_state()
    saved.update(
        {
            "status": "recovering",
            "deadline_at": 1001.0,
            "pending_action": pending,
            "recovery": {"needs_reconcile": True, "reason": "explicit_resume"},
        }
    )
    store.save_goal_state(task.id, saved)

    async def wait_then_expire(*, after=None):
        clock["now"] = 1002.0
        return state

    supervisor._wait_for_usable_state = wait_then_expire
    result = await supervisor.run(task.id, resume=True)

    assert result["status"] == "blocked"
    assert result["block_reason"] == "budget_elapsed"
    assert calls == ["status:late-deadline-goto"]
    persisted = store.load_goal_state(task.id)
    assert persisted["pending_action"] is None
    assert persisted["action_history"][0]["action_id"] == "late-deadline-goto"
    assert persisted["action_history"][0]["status"] == "unknown_reconciled_for_replan"
    assert persisted["deadline_at"] == 1001.0
    store.close()


@pytest.mark.asyncio
async def test_active_bridge_ledger_keeps_original_action_id_without_replay(tmp_path, monkeypatch):
    monkeypatch.setattr("voxkin.agent.goal_supervisor.MAX_ACTION_RECONCILE_S", 0)
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S0", "S0")
    state = modern_state(revision=12)
    calls: list[str] = []

    async def dispatch(tool: str, arguments: dict, **kwargs):
        calls.append(tool)
        return "must not replay while Bridge owns action"

    async def action_status(action_id: str):
        return ActionStatusResult(action_id, "running", "Bridge 仍在执行")

    supervisor = GoalSupervisor(GOALS["S0"], store, dispatch, lambda: state, action_status=action_status)
    saved = supervisor._new_state()
    saved.update(
        {
            "status": "recovering",
            "deadline_at": time.time() + 600,
            "method_index": 3,
            "pending_action": {
                "action_id": "original-action",
                "tool": "collect_blocks",
                "method_key": "plan:s0:0",
                "effect_class": "replan",
                "expected_condition": {"type": "inventory", "items": {"oak_log": 4}},
                "session_id": "world-1",
                "revision": 11,
            },
            "recovery": {"needs_reconcile": True, "reason": "core_restart"},
        }
    )
    saved["counters"].update(
        {
            "actions": 2,
            "attempts": {"plan:s0:0": 1},
            "method_failures": {"plan:s0:0": 1},
            "transport_recoveries": 1,
            "transport_recovery_action_ids": ["older-recovery"],
        }
    )
    deadline = saved["deadline_at"]
    counters_before = dict(saved["counters"])
    store.save_goal_state(task.id, saved)

    result = await supervisor.run(task.id, resume=True)

    assert result["status"] == "waiting"
    assert calls == []
    persisted = store.load_goal_state(task.id)
    assert persisted["pending_action"]["action_id"] == "original-action"
    assert persisted["pending_action"]["status"] == "running"
    assert persisted["recovery"]["reason"] == "bridge_action_still_active"
    assert persisted["deadline_at"] == deadline
    assert persisted["method_index"] == 3
    assert persisted["counters"] == counters_before


@pytest.mark.asyncio
async def test_legacy_terminal_receipt_keeps_non_protocol_compatibility(tmp_path):
    store = TaskStore(tmp_path / "legacy-tasks.db")
    store.initialize()
    task = store.create_task("S0", "S0")
    state = {
        "alive": True,
        "health": 20,
        "position": {"x": 0, "y": 64, "z": 0},
        "inventory": {},
        "executor": {},
    }

    async def action_status(action_id: str):
        return ActionStatusResult(action_id, "succeeded", "legacy terminal receipt")

    supervisor = GoalSupervisor(
        GOALS["S0"], store, lambda *args, **kwargs: asyncio.sleep(0), lambda: state,
        action_status=action_status, require_protocol=False,
    )
    supervisor.task_id = task.id
    supervisor.state = supervisor._new_state()
    supervisor.state["pending_action"] = {
        "action_id": "legacy-action",
        "tool": "collect_blocks",
        "method_key": "legacy:s0:collect",
        "effect_class": "replan",
        "expected_condition": {"type": "always"},
        # _execute_step 即使运行在 legacy state 下也会写入空协议字段。
        "session_id": "",
        "revision": None,
    }
    supervisor.state["recovery"]["needs_reconcile"] = True

    assert await supervisor._reconcile_pending(state)
    assert supervisor.state["pending_action"] is None
    assert any(event["kind"] == "pending_action_reconciled" for event in store.events(task.id))
    store.close()


@pytest.mark.asyncio
async def test_goal_action_retries_stale_admission_without_spending_method_attempt(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S0", "S0")
    state = modern_state(revision=1)
    action_ids: list[str] = []

    async def dispatch(tool: str, arguments: dict, timeout_s: float = 0, action_id: str = "", **kwargs):
        action_ids.append(action_id)
        if len(action_ids) == 1:
            state["revision"] = 2
            raise ActionError(
                "Bridge 拒绝过期观察，动作未启动",
                status="blocked",
                action_id=action_id,
                data={
                    "admission": {"started": False, "retryable": True, "reason": "stale_observation"},
                    "observation": dict(state),
                },
                receipt_confirmed=True,
            )
        return ActionResult(action_id, True, status="succeeded", detail="完成")

    supervisor = GoalSupervisor(GOALS["S0"], store, dispatch, lambda: state)
    supervisor.task_id = task.id
    supervisor.state = supervisor._new_state()
    step = StepSpec("采集木头", "collect_blocks", {"block": "oak_log", "count": 4}, {"type": "always"})

    first = await supervisor._execute_step(step, "plan:s0:0", 0)
    first_counters = {
        **supervisor.state["counters"],
        "attempts": dict(supervisor.state["counters"]["attempts"]),
        "admission_retries": dict(supervisor.state["counters"]["admission_retries"]),
    }
    second = await supervisor._execute_step(step, "plan:s0:0", 0)

    assert first == "retry"
    assert second == "done"
    assert len(action_ids) == 2 and action_ids[0] != action_ids[1]
    assert first_counters["attempts"] == {}
    assert first_counters["actions"] == 0
    assert first_counters["admission_retries"]["plan:s0:0"] == 1
    assert supervisor.state["counters"]["attempts"] == {}
    assert supervisor.state["counters"]["actions"] == 1
    assert supervisor.state["counters"]["admission_retries"]["plan:s0:0"] == 0
    assert supervisor.state["counters"]["admission_rejections_total"]["plan:s0:0"] == 1


@pytest.mark.asyncio
async def test_successful_admissions_reset_consecutive_stale_admission_fuse(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S0", "S0")
    state = modern_state(revision=1)
    calls: list[str] = []

    async def dispatch(tool: str, arguments: dict, timeout_s: float = 0, action_id: str = "", **kwargs):
        calls.append(action_id)
        if len(calls) in {1, 3, 5}:
            state["revision"] += 1
            raise ActionError(
                "Bridge 拒绝过期观察，动作未启动",
                status="blocked",
                action_id=action_id,
                data={
                    "admission": {"started": False, "retryable": True, "reason": "stale_observation"},
                    "observation": dict(state),
                },
                receipt_confirmed=True,
            )
        return ActionResult(action_id, True, status="succeeded", detail="完成")

    supervisor = GoalSupervisor(GOALS["S0"], store, dispatch, lambda: state)
    supervisor.task_id = task.id
    supervisor.state = supervisor._new_state()
    step = StepSpec("采集木头", "collect_blocks", {"block": "oak_log", "count": 4}, {"type": "always"})

    results = [await supervisor._execute_step(step, "plan:s0:0", 0) for _ in range(5)]

    assert results == ["retry", "done", "retry", "done", "retry"]
    counters = supervisor.state["counters"]
    assert len(calls) == 5
    assert counters["admission_retries"]["plan:s0:0"] == 1
    assert counters["admission_rejections_total"]["plan:s0:0"] == 3
    assert counters["attempts"] == {}
    assert supervisor.state["block_reason"] == ""


@pytest.mark.asyncio
async def test_repeated_stale_admission_has_a_separate_retry_fuse(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S0", "S0")
    state = modern_state(revision=1)
    calls: list[str] = []

    async def dispatch(tool: str, arguments: dict, timeout_s: float = 0, action_id: str = "", **kwargs):
        calls.append(action_id)
        state["revision"] += 1
        raise ActionError(
            "Bridge 拒绝过期观察，动作未启动",
            status="blocked",
            action_id=action_id,
            data={
                "admission": {"started": False, "retryable": True, "reason": "stale_observation"},
                "observation": dict(state),
            },
            receipt_confirmed=True,
        )

    supervisor = GoalSupervisor(GOALS["S0"], store, dispatch, lambda: state)
    supervisor.task_id = task.id
    supervisor.state = supervisor._new_state()
    step = StepSpec("采集木头", "collect_blocks", {"block": "oak_log", "count": 4}, {"type": "always"})

    results = [await supervisor._execute_step(step, "plan:s0:0", 0) for _ in range(3)]

    assert results == ["retry", "retry", "blocked"]
    assert len(calls) == 3
    assert supervisor.state["counters"]["actions"] == 0
    assert supervisor.state["counters"]["attempts"] == {}
    assert supervisor.state["counters"]["admission_retries"]["plan:s0:0"] == 3
    assert supervisor.state["counters"]["admission_rejections_total"]["plan:s0:0"] == 3
    assert supervisor.state["block_reason"] == "budget_admission_retries"


@pytest.mark.asyncio
@pytest.mark.parametrize("receipt_status", ["succeeded", "failed"])
async def test_reconciled_non_stale_receipt_resets_consecutive_admission_rejections(tmp_path, receipt_status):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S0", "S0")
    state = modern_state(revision=2)

    async def action_status(action_id: str):
        return ActionStatusResult(
            action_id,
            receipt_status,
            "Bridge 已确认终态",
            data={"observation": dict(state)},
        )

    supervisor = GoalSupervisor(
        GOALS["S0"],
        store,
        lambda *args, **kwargs: asyncio.sleep(0),
        lambda: state,
        action_status=action_status,
    )
    supervisor.task_id = task.id
    supervisor.state = supervisor._new_state()
    supervisor.state["counters"]["admission_retries"]["plan:s0:0"] = 2
    supervisor.state["counters"]["admission_rejections_total"]["plan:s0:0"] = 5
    supervisor.state["pending_action"] = {
        "action_id": "recovered-action",
        "tool": "collect_blocks",
        "method_key": "plan:s0:0",
        "effect_class": "replan",
        "expected_condition": {"type": "always"},
        "session_id": "world-1",
        "revision": 1,
        "status": "unknown",
    }
    supervisor.state["recovery"].update({"needs_reconcile": True, "reason": "core_restart"})

    assert await supervisor._reconcile_pending(state)

    counters = supervisor.state["counters"]
    assert counters["admission_retries"]["plan:s0:0"] == 0
    assert counters["admission_rejections_total"]["plan:s0:0"] == 5


@pytest.mark.asyncio
async def test_recovered_stale_admission_counts_toward_consecutive_retry_fuse(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S0", "S0")
    state = modern_state(revision=4)
    stale_data = {
        "admission": {"started": False, "retryable": True, "reason": "stale_observation"},
        "observation": dict(state),
    }

    async def action_status(action_id: str):
        return ActionStatusResult(action_id, "blocked", "拒绝过期观察", stale_data)

    supervisor = GoalSupervisor(
        GOALS["S0"],
        store,
        lambda *args, **kwargs: asyncio.sleep(0),
        lambda: state,
        action_status=action_status,
    )
    supervisor.task_id = task.id
    supervisor.state = supervisor._new_state()
    supervisor.state["counters"]["admission_retries"]["plan:s0:0"] = 2
    supervisor.state["counters"]["admission_rejections_total"]["plan:s0:0"] = 2
    supervisor.state["counters"]["actions"] = 1
    supervisor.state["pending_action"] = {
        "action_id": "recovered-stale-action",
        "tool": "collect_blocks",
        "method_key": "plan:s0:0",
        "effect_class": "replan",
        "expected_condition": {"type": "inventory", "items": {"oak_log": 4}},
        "session_id": "world-1",
        "revision": 4,
        "status": "unknown",
    }
    supervisor.state["recovery"].update({"needs_reconcile": True, "reason": "core_restart"})

    assert not await supervisor._reconcile_pending(state)

    counters = supervisor.state["counters"]
    assert counters["admission_retries"]["plan:s0:0"] == 3
    assert counters["admission_rejections_total"]["plan:s0:0"] == 3
    assert supervisor.state["block_reason"] == "budget_admission_retries"


def test_goal_progress_keeps_structured_fields_and_rejects_stale_associations(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S0", "S0")
    state = modern_state(revision=8)
    supervisor = GoalSupervisor(GOALS["S0"], store, lambda *args, **kwargs: asyncio.sleep(0), lambda: state)
    supervisor.task_id = task.id
    supervisor.state = supervisor._new_state()
    supervisor.state["pending_action"] = {
        "action_id": "active-action",
        "session_id": "world-1",
        "revision": 7,
        "progress": [],
    }

    assert not supervisor.on_progress(
        {"action_id": "old-action", "session_id": "world-1", "state_revision": 8, "phase": "running"}
    )
    assert not supervisor.on_progress(
        {"action_id": "active-action", "session_id": "other-world", "state_revision": 8, "phase": "running"}
    )
    assert not supervisor.on_progress(
        {"action_id": "active-action", "session_id": "world-1", "state_revision": 6, "phase": "running"}
    )
    assert supervisor.on_progress(
        {
            "action_id": "active-action",
            "session_id": "world-1",
            "state_revision": 8,
            "executor_epoch": 3,
            "phase": "running",
            "progress": 0.5,
            "data": {"item": "oak_log", "collected": 2, "target": 4},
        }
    )

    saved = store.load_goal_state(task.id)
    entry = saved["pending_action"]["progress"][0]
    assert entry["phase"] == "running"
    assert entry["session_id"] == "world-1"
    assert entry["state_revision"] == 8
    assert entry["executor_epoch"] == 3
    assert entry["data"] == {"item": "oak_log", "collected": 2, "target": 4}


@pytest.mark.asyncio
async def test_preemption_waits_for_safety_done_without_spending_method_retry(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S0", "S0")
    state = modern_state()

    async def dispatch(tool: str, arguments: dict, timeout_s: float = 0, **kwargs):
        raise ActionError("被 Bridge 安全动作抢占", status="preempted", action_id=kwargs.get("action_id", ""))

    supervisor = GoalSupervisor(GOALS["S0"], store, dispatch, lambda: state)
    supervisor.task_id = task.id
    supervisor.state = supervisor._new_state()
    step = StepSpec("采集木头", "collect_blocks", {"block": "oak_log", "count": 4}, {"type": "always"})

    result = await supervisor._execute_step(step, "plan:s0:0", 0)

    assert result == "preempted"
    assert supervisor.state["counters"]["attempts"] == {}
    assert supervisor.state["pending_action"]["status"] == "preempted"
    assert supervisor._resolve_interrupted_action(
        supervisor.state["pending_action"], "preempted", state, {}
    )
    assert supervisor.state["pending_action"] is None
    assert supervisor.state["counters"]["actions"] == 0
    assert supervisor.state["method_index"] == 0


@pytest.mark.asyncio
async def test_cancelled_non_replayable_step_stays_blocked_across_explicit_resume(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S6", "S6")
    state = modern_state()
    status_queries: list[str] = []
    calls: list[str] = []

    async def dispatch(tool: str, arguments: dict, timeout_s: float = 0, **kwargs):
        calls.append(tool)
        return "must not replay"

    async def action_status(action_id: str):
        status_queries.append(action_id)
        return ActionStatusResult(action_id, "cancelled", "停止已确认", data={"observation": dict(state)})

    supervisor = GoalSupervisor(GOALS["S6"], store, dispatch, lambda: state, action_status=action_status)
    saved = supervisor._new_state()
    saved.update(
        {
            "status": "recovering",
            "pending_action": {
                "action_id": "throw-eye-1",
                "tool": "throw_eye",
                "method_key": "plan:s6:throw_eye",
                "effect_class": "non_replayable",
                "expected_condition": {"type": "always"},
                "session_id": "world-1",
                "revision": 0,
            },
            "recovery": {"needs_reconcile": True, "reason": "explicit_resume"},
        }
    )
    store.save_goal_state(task.id, saved)

    first = await supervisor.run(task.id, resume=True)
    second = await supervisor.run(task.id, resume=True)

    assert first["status"] == "blocked"
    assert second["status"] == "blocked"
    assert "interrupted_non_replayable_action" in first["block_reason"]
    assert status_queries == ["throw-eye-1"]
    assert calls == []
    assert store.load_goal_state(task.id)["unresolved_action"]["action_id"] == "throw-eye-1"


def test_s2_chooses_existing_food_or_fallback_hunt_source():
    goal_state: dict = {}
    with_food = modern_state(food=4, inventory={"apple": 2})
    step = choose_s2_action(with_food, goal_state)
    assert step is not None and step.tool == "eat_if_hungry"

    no_food = modern_state(food=4, inventory={})
    step = choose_s2_action(no_food, {})
    assert step is not None and step.tool == "hunt_animal"
    assert not step.arguments.get("exclude_species")
    assert step.verify["type"] == "inventory_any"


def test_s2_empty_inventory_and_partial_iron_choose_wool_without_mining_prerequisite():
    for inventory in ({}, {"wooden_pickaxe": 1}, {"raw_iron": 1}, {"iron_ingot": 1}):
        step = choose_s2_action(modern_state(inventory=inventory), {})
        assert step.tool == "hunt_material"
        assert step.arguments["item"] == "wool"
        assert step.verify == {"type": "inventory", "items": {"wool": 3}}
    step = choose_s2_action(modern_state(inventory={"iron_ingot": 2}), {})
    assert step.tool == "craft" and step.arguments["item"] == "shears"


def test_s2_waits_for_health_observation_before_spending_gathering_budget():
    ledger = {}
    state = modern_state(health=4.4, food=20, inventory={"white_wool": 2, "mutton": 6})
    assert choose_s2_action(state, ledger) is None
    assert ledger["s2_wait_reason"]
    state["food"] = 17
    step = choose_s2_action(state, ledger)
    assert step.tool == "eat_if_hungry" and step.arguments["threshold"] == 18
    state.update(health=12, food=18)
    assert choose_s2_action(state, ledger).arguments["item"] == "wool"
    assert "s2_wait_reason" not in ledger


@pytest.mark.asyncio
@pytest.mark.parametrize("failure_health, expected_calls", [(4.4, 1), (None, 0), (20, 0)])
async def test_s2_resumes_dirt_only_after_confirmed_low_health_failures(tmp_path, failure_health, expected_calls):
    store = TaskStore(tmp_path / "shelter.db")
    store.initialize()
    task = store.create_task("S2", "S2")
    state = modern_state(is_day=False, health=20, food=18)
    calls = []

    async def dispatch(tool, arguments, timeout_s=0, *, action_id="", **kwargs):
        calls.append(tool)
        state["revision"] += 1
        state["inventory"]["dirt"] = arguments["count"]
        return ActionResult(action_id, True, status="succeeded", data={"observation": dict(state)})

    goal = replace(GOALS["S2"], budget=replace(GOALS["S2"].budget, max_actions=4))
    supervisor = GoalSupervisor(goal, store, dispatch, lambda: state)
    saved = supervisor._new_state()
    key = "s2:mine_collect:dirt"
    saved["counters"]["actions"] = 3
    saved["counters"]["method_failures"][key] = 3
    saved["action_history"] = [{"method_key": key, "status": "failed", "receipt_confirmed": True,
                                "result_detail": "血量不足", "terminal_observation": {"health": failure_health}}
                               for _ in range(3)]
    store.save_goal_state(task.id, saved)
    await supervisor.run(task.id, resume=True)
    assert calls == ["mine_collect"] * expected_calls
    assert supervisor.state["counters"]["method_failures"][key] == 3
    store.close()


def test_s2_climbs_out_of_the_dirt_pit_before_choosing_a_new_shelter_site():
    state = modern_state(inventory={"white_bed": 1, "cobblestone": 18, "dirt": 22})
    exit_pos = {"x": 7, "y": 69, "z": 136}
    state.update(shelter={}, position={"x": 7, "y": 65, "z": 136}, is_day=True,
                 surface_access={"sky_light": 0, "exit": exit_pos})
    step = choose_s2_action(state, {})
    assert step.tool == "goto" and step.verify["target"] == exit_pos
    state.update(position=exit_pos, surface_access={"sky_light": 15, "exit": None})
    assert choose_s2_action(state, {}).tool == "make_shelter"


def test_s2_leaves_a_confirmed_hostile_dirt_site_then_excludes_it(tmp_path):
    hazard = {"x": -44, "y": 63, "z": 5}
    state = modern_state(position=hazard, revision=2)
    supervisor = GoalSupervisor(GOALS["S2"], TaskStore(tmp_path / "threat.db"), None, lambda: state)
    row = {"tool": "mine_collect", "arguments": {"block": "dirt"}, "status": "failed", "receipt_confirmed": True,
           "session_id": state["session_id"], "revision": 1,
           "result_data": {"reason": "nearby_hostiles", "observation": dict(state)}}
    supervisor.state = {"action_history": [row], "counters": {"method_failures": {}}}
    key = "s2:mine_collect:dirt"
    step = StepSpec("采集建材", "mine_collect", {"block": "dirt", "count": 40}, {})
    retreat, retreat_key = supervisor._plan_s2_dirt_collection(step, key, state)
    assert retreat.tool == "explore_mining_site" and retreat.arguments["avoid_positions"] == [hazard]
    supervisor.state["counters"]["method_failures"][retreat_key] = 1
    retreat, next_key = supervisor._plan_s2_dirt_collection(step, key, state)
    assert next_key != retreat_key and retreat.arguments["covered_escape"]
    supervisor.state["action_history"].append({"method_key": next_key, "status": "failed", "receipt_confirmed": True,
        "result_data": {"relocation": {"attempted_positions": []}}, "result_detail": "已观察的干燥矿道未能通到足够远的安全位置"})
    retreat, dig_key = supervisor._plan_s2_dirt_collection(step, key, state)
    assert retreat.arguments["covered_escape"] and not retreat.arguments["connected_route"]
    supervisor.state["counters"]["method_failures"][dig_key] = 1
    supervisor.state["action_history"].append({"method_key": dig_key, "status": "failed", "receipt_confirmed": True,
                                              "terminal_observation": {"is_day": False}})
    state["is_day"] = False
    assert supervisor._plan_s2_dirt_collection(step, key, state)[0] is None
    state["overworld_mining_hostiles"] = []
    assert supervisor._plan_s2_dirt_collection(step, key, state)[0].tool == "mine_collect"
    del state["overworld_mining_hostiles"]
    state["is_day"] = True
    retreat, daylight_key = supervisor._plan_s2_dirt_collection(step, key, state)
    assert daylight_key != dig_key and retreat.arguments["connected_route"]
    state["position"] = {**hazard, "x": -25}
    collect, _ = supervisor._plan_s2_dirt_collection(step, key, state)
    assert collect.tool == "mine_collect" and collect.arguments["avoid_positions"] == [hazard]
    row["receipt_confirmed"] = False
    assert supervisor._plan_s2_dirt_collection(step, key, state) == (step, key)


def test_s2_uses_bridge_missing_block_count_and_night_shelter_priority():
    state = modern_state(
        is_day=False,
        inventory={"dirt": 5},
        shelter={"position": {"x": 0, "y": 64, "z": 0}, "size": 4, "sealed": False, "inside": False, "missing_blocks": 2},
    )
    step = choose_s2_action(state, {})
    assert step is not None
    assert step.tool == "make_shelter"


def test_s2_night_can_use_verified_safe_guard_without_bed():
    state = modern_state(
        is_day=False,
        shelter={
            "position": {"x": 0, "y": 64, "z": 0},
            "size": 4,
            "sealed": True,
            "inside": True,
            "bounds": {"min": {"x": -2, "y": 64, "z": -2}, "max": {"x": 1, "y": 67, "z": 1}},
        },
        nearby_beds=[],
    )
    step = choose_s2_action(state, {})
    assert step is not None and step.tool == "wait_for_day"


def test_s3_preflight_eats_existing_food_inside_then_exits_before_hunting():
    goal_state: dict = {}
    state = modern_state(food=12, inventory={"apple": 1}, shelter={"inside": True})

    ready, step = choose_s3_preflight_action(state, goal_state)

    assert not ready
    assert step is not None and step.tool == "eat_if_hungry"
    assert step.arguments["threshold"] == 16
    assert step.verify == {"type": "food", "min": 16}

    state.update(food=16, inventory={}, shelter={"inside": True})
    ready, step = choose_s3_preflight_action(state, goal_state)

    assert not ready
    assert step is not None and step.tool == "leave_shelter"
    assert step.verify == {"type": "outside_shelter"}

    state["shelter"] = {"inside": False}
    ready, step = choose_s3_preflight_action(state, goal_state)

    assert not ready
    assert step is not None and step.tool == "hunt_animal"
    assert step.arguments["count"] == 3
    assert not step.arguments.get("exclude_species")
    assert step.verify["type"] == "inventory_any"


def test_s3_processes_collected_iron_before_leaving_to_hunt():
    state = modern_state(health=20, food=18, inventory={"raw_iron": 9, "crafting_table": 1, "stone_pickaxe": 1,
                         "cobblestone": 92, "stick": 4, "oak_planks": 9, "mutton": 1}, shelter={"inside": False})
    ready, step = choose_s3_preflight_action(state, {})
    if ready:
        step = choose_s3_resource_action(state, {})
    assert step.tool == "craft" and step.arguments["item"] == "furnace"
    state["inventory"]["raw_iron"] = 2
    assert choose_s3_preflight_action(state, {})[1].tool == "hunt_animal"


def test_s3_preflight_never_hunts_inside_at_night_or_with_missing_safety():
    goal_state: dict = {}
    state = modern_state(
        is_day=False,
        food=12,
        inventory={},
        shelter={"inside": True},
    )

    ready, step = choose_s3_preflight_action(state, goal_state)

    assert not ready and step is None
    assert "留在庇护所" in goal_state["s3_preflight_wait_reason"]

    state.update(is_day=True, shelter={"inside": False}, health=10)
    ready, step = choose_s3_preflight_action(state, goal_state)

    assert not ready and step is None
    assert "血量恢复" in goal_state["s3_preflight_wait_reason"]

    state.update(is_day=True, health=20, shelter={})
    ready, step = choose_s3_preflight_action(state, goal_state)
    assert not ready and step is None
    assert "明确观察" in goal_state["s3_preflight_wait_reason"]


def test_s3_preflight_repairs_mining_dependencies_from_total_inventory_counts():
    goal_state: dict = {}
    state = modern_state(
        food=16,
        inventory={
            "beef": 2,
            "crafting_table": 1,
            "wooden_pickaxe": 1,
            "stick": 2,
            "oak_planks": 10,
            "cobblestone": 2,
        },
        shelter={"inside": False},
    )

    ready, step = choose_s3_preflight_action(state, goal_state)
    assert not ready and step is not None
    assert (step.tool, step.arguments["block"], step.arguments["count"]) == ("mine_collect", "stone", 3)
    assert step.verify == {"type": "inventory", "items": {"cobblestone": 3}}

    state["inventory"]["cobblestone"] = 3
    ready, step = choose_s3_preflight_action(state, goal_state)
    assert not ready and step is not None
    assert step.tool == "craft"
    assert step.arguments == {"item": "stick", "count": 3}
    assert step.verify == {"type": "inventory", "items": {"stick": 5}}

    state["inventory"]["stick"] = 5
    ready, step = choose_s3_preflight_action(state, goal_state)
    assert not ready and step is not None
    assert (step.tool, step.arguments["item"]) == ("craft", "stone_pickaxe")


def test_s3_preflight_reuses_existing_iron_pickaxe_without_lower_tier_toolchain():
    state = modern_state(
        food=16,
        inventory={
            "beef": 2,
            "crafting_table": 1,
            "iron_pickaxe": 1,
            "iron_sword": 1,
            "shield": 1,
            "bucket": 1,
        },
        shelter={"inside": False},
    )

    ready, step = choose_s3_preflight_action(state, {})

    assert ready
    assert step is None


def test_s3_preflight_returns_underground_to_known_shelter_anchor_for_wood():
    state = modern_state(
        food=18,
        position={"x": -10.43, "y": 47, "z": 159.52},
        inventory={
            "porkchop": 2,
            "crafting_table": 1,
            "stone_pickaxe": 1,
            "stick": 3,
            "oak_planks": 2,
        },
        shelter={
            "position": {"x": -34, "y": 72, "z": 130},
            "size": 4,
            "sealed": False,
            "inside": False,
        },
    )
    goal_state = {"counters": {"actions": 15, "attempts": {"s3:mine_collect:oak_log": 3}}}

    ready, step = choose_s3_preflight_action(state, goal_state)

    assert not ready
    assert step is not None and step.tool == "goto"
    assert step.arguments == {"x": -34, "y": 73, "z": 130}
    assert step.verify == {"type": "position", "target": {"x": -34, "y": 73, "z": 130}, "radius": 3.0}
    assert goal_state["counters"]["attempts"]["s3:mine_collect:oak_log"] == 3


def test_s3_preflight_searches_all_tree_species_after_legacy_oak_absence():
    state = modern_state(
        food=18,
        position={"x": -34, "y": 73, "z": 130},
        inventory={
            "porkchop": 2,
            "crafting_table": 1,
            "stone_pickaxe": 1,
            "stick": 3,
            "oak_planks": 2,
        },
        shelter={
            "position": {"x": -34, "y": 72, "z": 130},
            "size": 4,
            "sealed": False,
            "inside": False,
        },
    )
    goal_state = {
        "action_history": [
            {
                "tool": "mine_collect",
                "arguments": {"block": "oak_log"},
                "status": "blocked",
                "receipt_confirmed": True,
                "result_detail": "附近 64 格内没有橡木，一个都没有找到",
                "terminal_observation": {
                    "dimension": "overworld",
                    "position": {"x": -34, "y": 73, "z": 130},
                },
            }
        ]
    }

    ready, step = choose_s3_preflight_action(state, goal_state)

    assert not ready
    assert step is not None and step.tool == "mine_collect"
    assert step.arguments == {"block": "wood_log", "count": 1, "range": 64}


def test_s3_preflight_does_not_suppress_tree_from_stale_admission():
    state = modern_state(
        food=18,
        position={"x": -34, "y": 73, "z": 130},
        inventory={
            "porkchop": 2,
            "crafting_table": 1,
            "stone_pickaxe": 1,
            "stick": 3,
            "oak_planks": 2,
        },
        shelter={"position": {"x": -34, "y": 72, "z": 130}, "size": 4, "inside": False},
    )
    goal_state = {
        "action_history": [
            {
                "tool": "mine_collect",
                "arguments": {"block": "oak_log"},
                "status": "rejected_before_start",
                "receipt_confirmed": False,
                "result_detail": "附近 64 格内没有橡木，一个都没有找到",
                "terminal_observation": dict(state),
            }
        ]
    }

    ready, step = choose_s3_preflight_action(state, goal_state)

    assert not ready
    assert step is not None and step.tool == "mine_collect"
    assert step.arguments["block"] == "wood_log"


def test_s3_safe_underground_mining_preflight_can_continue_at_night():
    state = modern_state(
        is_day=False,
        food=18,
        position={"x": -10, "y": 47, "z": 159},
        inventory={
            "porkchop": 2,
            "crafting_table": 1,
            "stone_pickaxe": 1,
            "stick": 3,
            "iron_pickaxe": 1,
            "iron_sword": 1,
            "shield": 1,
            "bucket": 1,
        },
        shelter={"position": {"x": -34, "y": 72, "z": 130}, "size": 4, "inside": False},
    )

    ready, step = choose_s3_preflight_action(state, {})

    assert ready
    assert step is None


def test_s3_preflight_waits_until_day_before_underground_surface_route():
    state = modern_state(
        is_day=False,
        food=18,
        position={"x": -10.43, "y": 47, "z": 159.52},
        inventory={
            "porkchop": 2,
            "crafting_table": 1,
            "stone_pickaxe": 1,
            "stick": 3,
            "oak_planks": 2,
        },
        shelter={"position": {"x": -34, "y": 72, "z": 130}, "size": 4, "inside": False},
    )
    goal_state: dict = {}

    ready, step = choose_s3_preflight_action(state, goal_state)

    assert not ready and step is None
    assert "夜间留在当前位置" in goal_state["s3_preflight_wait_reason"]


@pytest.mark.asyncio
async def test_s3_preflight_without_bounded_surface_anchor_blocks_instead_of_waiting_forever(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S3", "S3")
    state = modern_state(
        food=18,
        position={"x": -10, "y": 47, "z": 159},
        inventory={
            "porkchop": 2,
            "crafting_table": 1,
            "stone_pickaxe": 1,
            "stick": 3,
            "oak_planks": 2,
        },
        shelter={"inside": False},
    )
    calls: list[str] = []

    async def dispatch(tool: str, arguments: dict, **kwargs):
        calls.append(tool)
        return "unexpected"

    supervisor = GoalSupervisor(GOALS["S3"], store, dispatch, lambda: state)

    result = await supervisor.run(task.id)

    assert result["status"] == "blocked"
    assert result["block_reason"] == "s3_preflight_route_exhausted"
    assert calls == []


@pytest.mark.asyncio
async def test_s3_resume_runs_outdoor_preflight_before_saved_method_cursor(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S3", "S3")
    state = modern_state(
        food=16,
        inventory={
            "beef": 2,
            "crafting_table": 1,
            "stone_pickaxe": 1,
            "stick": 3,
            "oak_planks": 1,
        },
        shelter={"inside": True},
    )
    calls: list[str] = []

    async def dispatch(tool: str, arguments: dict, timeout_s: float = 0, **kwargs):
        calls.append(tool)
        if tool == "leave_shelter":
            state["shelter"] = {"inside": False}
            state["revision"] += 1
        elif tool == "mine_collect":
            state["inventory"].update(
                raw_iron=9,
                iron_pickaxe=1,
                iron_sword=1,
                shield=1,
                bucket=1,
            )
            state["revision"] += 1
        return "完成"

    supervisor = GoalSupervisor(GOALS["S3"], store, dispatch, lambda: state)
    saved = supervisor._new_state()
    saved.update({"status": "active", "method_index": 1})
    store.save_goal_state(task.id, saved)

    result = await supervisor.run(task.id, resume=True)

    assert result["status"] == "done"
    assert calls == ["leave_shelter", "mine_collect"]


@pytest.mark.asyncio
async def test_partial_strip_mine_with_always_condition_blocks_instead_of_replaying(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S3", "S3")
    state = modern_state()
    calls: list[str] = []

    async def dispatch(tool: str, arguments: dict, timeout_s: float = 0, **kwargs):
        calls.append(tool)
        return ActionResult(
            kwargs["action_id"],
            True,
            status="partial",
            detail="挖道部分完成",
            data={"observation": dict(state), "depth": 48},
        )

    supervisor = GoalSupervisor(GOALS["S3"], store, dispatch, lambda: state)
    supervisor.task_id = task.id
    supervisor.state = supervisor._new_state()
    strip_mine = StepSpec("挖到矿层", "strip_mine", {"y": 16}, {"type": "always"})

    outcome = await supervisor._execute_step(strip_mine, "plan:s3:0", 0)

    assert outcome == "blocked"
    assert calls == ["strip_mine"]
    saved = store.load_goal_state(task.id)
    assert saved["status"] == "blocked"
    assert saved["unresolved_action"]["status"] == "partial"
    assert saved["unresolved_action"]["tool"] == "strip_mine"


def test_s3_resource_method_targets_current_iron_total_without_forcing_strip_mine():
    state = modern_state(
        position={"x": -5.5, "y": 59.9, "z": 151.3},
        inventory={"stone_pickaxe": 1, "iron_ingot": 2, "raw_iron": 4},
    )

    step = choose_s3_resource_action(state, {})

    assert method_for_goal(GOALS["S3"]).strategy == "s3_resource_reconciliation"
    assert GOALS["S3"].method_id == "s3_ore_adaptive"
    assert step is not None
    assert step.tool == "mine_collect"
    assert step.arguments == {"block": "iron_ore", "count": 7, "range": 64}


def test_s3_partial_gear_and_ingots_smelt_only_the_remaining_item_cost():
    state = modern_state(
        inventory={
            "iron_ingot": 1,
            "raw_iron": 4,
            "iron_pickaxe": 1,
            "shield": 1,
            "bucket": 1,
            "furnace": 1,
            "coal": 1,
        }
    )

    smelt = choose_s3_resource_action(state, {})
    assert smelt is not None
    assert smelt.tool == "smelt_batch"
    assert smelt.arguments == {"item": "raw_iron", "count": 1, "output": "iron_ingot", "fuel": "coal"}
    assert smelt.verify == {"type": "inventory", "items": {"iron_ingot": 2}}

    state["inventory"]["iron_ingot"] = 2
    craft = choose_s3_resource_action(state, {})
    assert craft is not None
    assert craft.tool == "craft"
    assert craft.arguments == {"item": "iron_sword", "count": 1}


def test_s3_preflight_covers_all_six_shield_planks_before_crafting():
    state = modern_state(
        food=18,
        shelter={"inside": False},
        inventory={
            "crafting_table": 1,
            "stone_pickaxe": 1,
            "stick": 3,
            "oak_planks": 2,
            "oak_log": 1,
            "iron_ingot": 1,
            "porkchop": 2,
        },
    )

    ready, step = choose_s3_preflight_action(state, {})

    assert ready is False
    assert step is not None
    assert step.tool == "craft"
    assert step.arguments == {"item": "oak_planks", "count": 4}
    assert step.verify == {"type": "inventory", "items": {"oak_planks": 6}}


def test_s3_descent_passes_bounded_shaft_and_target_height():
    state = modern_state(
        position={"x": -5.5, "y": 59.9, "z": 151.3},
        inventory={"iron_ingot": 0, "raw_iron": 0, "stone_pickaxe": 1},
    )

    step = choose_s3_resource_action(state, {"s3_ore_no_progress": 1})

    assert step is not None
    assert step.tool == "strip_mine"
    assert step.arguments["shaft"] == 12
    assert step.arguments["y"] == 47
    assert step.arguments["length"] == 1
    assert step.arguments["target"] == "iron_ore"
    assert step.effect_class == "non_replayable"


def test_s3_successful_horizontal_exposure_is_used_once_then_rechecks_ore():
    state = modern_state(
        position={"x": -5.5, "y": 59.9, "z": 151.3},
        inventory={"iron_ingot": 0, "raw_iron": 0, "stone_pickaxe": 1},
    )
    supervisor = GoalSupervisor(GOALS["S3"], TaskStore(":memory:"), lambda *args, **kwargs: None, lambda: state)
    supervisor.state = supervisor._new_state()
    supervisor.state["s3_ore_no_progress"] = 1

    supervisor._advance_after_success({"method_key": "s3:ore_expose:1"}, {})
    next_step = choose_s3_resource_action(state, supervisor.state)

    assert supervisor.state["s3_ore_expose_used"] == 1
    assert supervisor.state["s3_ore_no_progress"] == 0
    assert next_step is not None
    assert next_step.tool == "mine_collect"


def test_s3_known_terminal_no_safe_stair_is_recorded_and_never_counts_as_done(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S3", "S3")
    state = modern_state(
        position={"x": -5.5, "y": 59.9, "z": 151.3},
        inventory={"iron_ingot": 0, "raw_iron": 0, "stone_pickaxe": 1},
    )
    supervisor = GoalSupervisor(GOALS["S3"], store, lambda *args, **kwargs: None, lambda: state)
    supervisor.task_id = task.id
    supervisor.state = supervisor._new_state()
    pending = {
        "action_id": "horizontal-expose-1",
        "tool": "strip_mine",
        "method_key": "s3:ore_expose:1",
        "effect_class": "non_replayable",
        "arguments": {"shaft": False, "target": "iron_ore"},
        "expected_condition": {"type": "always"},
        "receipt_confirmed": True,
        "result_detail": "没有安全的阶梯落点",
    }
    terminal_data = {
        "phase": "safe_stop",
        "reason": "no_safe_stair",
        "position": {"x": -5.5, "y": 59.9, "z": 151.3},
        "candidates": [{"reason": "unsupported"}],
    }

    resolved = supervisor._resolve_interrupted_action(pending, "blocked", state, terminal_data)

    assert resolved is True
    assert supervisor.state["status"] == "active"
    assert supervisor.state["last_s3_mining_failure"]["status"] == "blocked"
    assert supervisor.state["last_s3_mining_failure"]["data"]["reason"] == "no_safe_stair"
    assert supervisor.state["action_history"][-1]["result_data"] == terminal_data
    assert supervisor.state["action_history"][-1]["receipt_confirmed"] is True
    assert supervisor.state["s3_ore_expose_used"] == 1
    fallback = choose_s3_resource_action(state, supervisor.state)
    assert fallback.tool == "strip_mine"
    assert fallback.arguments["shaft"] == 0
    assert "y" not in fallback.arguments


def test_s3_stripmine_without_confirmed_receipt_remains_blocked(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S3", "S3")
    state = modern_state()
    supervisor = GoalSupervisor(GOALS["S3"], store, lambda *args, **kwargs: None, lambda: state)
    supervisor.task_id = task.id
    supervisor.state = supervisor._new_state()
    pending = {
        "action_id": "unknown-stripmine",
        "tool": "strip_mine",
        "method_key": "s3:ore_expose:1",
        "effect_class": "non_replayable",
        "arguments": {"shaft": False, "target": "iron_ore"},
        "expected_condition": {"type": "always"},
        "receipt_confirmed": False,
    }

    resolved = supervisor._resolve_interrupted_action(
        pending,
        "blocked",
        state,
        {"phase": "running", "progress": 0},
    )

    assert resolved is False
    assert supervisor.state["status"] == "blocked"
    assert supervisor.state["unresolved_action"]["action_id"] == "unknown-stripmine"


@pytest.mark.asyncio
async def test_s3_reconcile_preserves_terminal_bridge_failure_and_observation(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S3", "S3")
    state = modern_state(revision=4, position={"x": -5.5, "y": 59.9, "z": 151.3})
    data = {
        "phase": "safe_stop",
        "reason": "no_safe_stair",
        "observation": {**state, "revision": 4},
    }

    async def action_status(action_id: str):
        return ActionStatusResult(action_id, "blocked", "没有安全的阶梯落点", data)

    supervisor = GoalSupervisor(
        GOALS["S3"],
        store,
        lambda *args, **kwargs: None,
        lambda: state,
        action_status=action_status,
    )
    supervisor.task_id = task.id
    supervisor.state = supervisor._new_state()
    supervisor.state.update(
        {
            "status": "recovering",
            "pending_action": {
                "action_id": "terminal-stripmine",
                "tool": "strip_mine",
                "method_key": "s3:ore_expose:1",
                "effect_class": "non_replayable",
                "arguments": {"shaft": False, "target": "iron_ore"},
                "expected_condition": {"type": "always"},
                "session_id": "world-1",
                "revision": 3,
            },
            "recovery": {"needs_reconcile": True, "reason": "core_restart"},
        }
    )

    resolved = await supervisor._reconcile_pending(state)

    assert resolved is True
    assert supervisor.state["status"] == "active"
    history = supervisor.state["action_history"][-1]
    assert history["status"] == "blocked"
    assert history["receipt_confirmed"] is True
    assert history["result_detail"] == "没有安全的阶梯落点"
    assert history["terminal_observation"]["revision"] == 4
    assert supervisor.state["last_s3_mining_failure"]["data"]["reason"] == "no_safe_stair"


@pytest.mark.asyncio
async def test_s3_confirmed_actionerror_failure_keeps_terminal_receipt_in_history(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S3", "S3")
    state = modern_state(position={"x": -5.5, "y": 59.9, "z": 151.3})

    async def dispatch(tool: str, arguments: dict, timeout_s: float = 0, **kwargs):
        raise ActionError(
            "附近没有可达铁矿",
            status="blocked",
            action_id=kwargs["action_id"],
            data={"reason": "ore_not_reachable", "observation": dict(state)},
            receipt_confirmed=True,
        )

    supervisor = GoalSupervisor(GOALS["S3"], store, dispatch, lambda: state)
    supervisor.task_id = task.id
    supervisor.state = supervisor._new_state()
    step = StepSpec(
        "采集当前可见铁矿",
        "mine_collect",
        {"block": "iron_ore", "count": 9, "range": 64},
        {"type": "inventory", "items": {"raw_iron": 9}},
    )

    outcome = await supervisor._execute_step(step, "s3:mine_collect:iron_ore:raw0", None)

    assert outcome == "retry"
    terminal = supervisor.state["action_history"][-1]
    assert terminal["status"] == "blocked"
    assert terminal["receipt_confirmed"] is True
    assert terminal["result_detail"] == "附近没有可达铁矿"
    assert terminal["result_data"]["reason"] == "ore_not_reachable"
    assert terminal["terminal_observation"]["position"] == state["position"]


def test_legacy_s3_migration_requires_matching_terminal_stripmine_history():
    state = modern_state()
    supervisor = GoalSupervisor(GOALS["S3"], TaskStore(":memory:"), lambda *args, **kwargs: None, lambda: state)
    supervisor.state = supervisor._new_state()
    unresolved = {"action_id": "old", "tool": "strip_mine", "status": "blocked"}
    supervisor.state["action_history"] = [
        {
            "action_id": "old",
            "method_id": "plan:s3",
            "method_key": "plan:s3:1",
            "step_index": 1,
            "tool": "strip_mine",
            "arguments": {"target": "iron_ore", "y": 16},
            "status": "blocked",
        }
    ]

    assert supervisor._migrate_known_s3_stripmine_terminal(unresolved) is False


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["paused_by_user", "done"])
async def test_legacy_receipt_migration_honors_newer_terminal_status(tmp_path, status):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S3", "S3")
    unresolved = {"action_id": "old", "tool": "strip_mine", "status": "blocked"}
    receipt = {
        **unresolved, "method_id": "plan:s3", "method_key": "plan:s3:0", "step_index": 0,
        "arguments": {"target": "iron_ore"}, "result_data": {"observation": modern_state()},
        "receipt_confirmed": True,
    }
    saved = {"status": "blocked", "unresolved_action": unresolved, "action_history": [receipt]}
    store.save_goal_state(task.id, saved)
    expected = "cancelled" if status == "paused_by_user" else "done"

    def observe():
        store.save_goal_state(task.id, {**saved, "status": status})
        store.set_status(task.id, expected)
        return modern_state()

    supervisor = GoalSupervisor(GOALS["S3"], store, None, observe)
    assert (await supervisor.run(task.id, resume=True))["status"] == expected
    assert store.load_goal_state(task.id)["status"] == status
    assert store.get_task(task.id).status == expected
    store.close()


@pytest.mark.parametrize(
    "progress,result_data",
    [
        ([], {"observation": {"revision": 3}}),
        ([{"phase": "running", "session_id": "world-1", "state_revision": 3}], {}),
        (
            [{"phase": "running", "session_id": "world-1", "state_revision": 3}],
            {"observation": {"revision": 3}, "admission": {"started": False}},
        ),
    ],
)
def test_legacy_s3_migration_requires_bridge_execution_evidence(progress, result_data):
    state = modern_state()
    supervisor = GoalSupervisor(GOALS["S3"], TaskStore(":memory:"), lambda *args, **kwargs: None, lambda: state)
    supervisor.state = supervisor._new_state()
    unresolved = {"action_id": "old", "tool": "strip_mine", "status": "blocked"}
    supervisor.state["action_history"] = [
        {
            "action_id": "old",
            "method_id": "plan:s3",
            "method_key": "plan:s3:0",
            "step_index": 0,
            "tool": "strip_mine",
            "arguments": {"target": "iron_ore", "y": 16},
            "status": "blocked",
            "progress": progress,
            "result_data": result_data,
        }
    ]

    assert supervisor._migrate_known_s3_stripmine_terminal(unresolved) is False


@pytest.mark.asyncio
async def test_legacy_s3_terminal_stripmine_migrates_to_fresh_ore_collection(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S3", "S3")
    state = modern_state(
        food=18,
        position={"x": -5.5, "y": 59.9, "z": 151.3},
        shelter={
            "position": {"x": -5, "y": 72, "z": 151},
            "size": 4,
            "sealed": False,
            "inside": False,
        },
        inventory={
            "crafting_table": 1,
            "stone_pickaxe": 1,
            "stick": 3,
            "oak_planks": 2,
            "porkchop": 2,
            "cobblestone": 44,
        },
    )
    calls: list[tuple[str, dict]] = []

    async def dispatch(tool: str, arguments: dict, timeout_s: float = 0, **kwargs):
        calls.append((tool, dict(arguments)))
        if tool == "goto":
            state["position"] = dict(arguments)
            state["revision"] += 1
        elif tool == "mine_collect" and arguments.get("block") == "wood_log":
            state["inventory"]["oak_log"] = arguments["count"]
            state["revision"] += 1
        elif tool == "craft" and arguments.get("item") == "oak_planks":
            state["inventory"]["oak_planks"] += arguments["count"]
            state["inventory"]["oak_log"] = 0
            state["revision"] += 1
        elif tool == "mine_collect" and arguments.get("block") == "iron_ore":
            state["inventory"].update(
                raw_iron=9,
                iron_pickaxe=1,
                iron_sword=1,
                shield=1,
                bucket=1,
            )
            state["revision"] += 1
        return "完成"

    supervisor = GoalSupervisor(GOALS["S3"], store, dispatch, lambda: state)
    saved = supervisor._new_state()
    saved.update(
        {
            "status": "blocked",
            "method_id": "plan:s3",
            "unresolved_action": {
                "action_id": "old-stripmine-terminal",
                "tool": "strip_mine",
                "status": "blocked",
                "effect_class": "non_replayable",
                "reason": "旧计划挖矿已终止",
            },
            "action_history": [
                {
                    "action_id": "old-stripmine-terminal",
                    "goal_id": "stage:s3",
                    "method_id": "plan:s3",
                    "method_key": "plan:s3:0",
                    "step_index": 0,
                    "tool": "strip_mine",
                    "arguments": {"y": 16, "target": "iron_ore"},
                    "status": "blocked",
                    "progress": [
                        {"phase": "running", "progress": 0, "session_id": "world-1", "state_revision": 8}
                    ],
                    "result_data": {"phase": "running", "observation": dict(state)},
                }
            ],
        }
    )
    store.save_goal_state(task.id, saved)

    result = await supervisor.run(task.id, resume=True)

    assert result["status"] == "done", result
    assert calls[0] == ("goto", {"x": -5, "y": 73, "z": 151})
    assert calls[1] == ("mine_collect", {"block": "wood_log", "count": 1, "range": 64, "surface_wood": True})
    assert ("mine_collect", {"block": "iron_ore", "count": 9, "range": 64}) in calls
    assert all(tool != "strip_mine" for tool, _ in calls)
    persisted = store.load_goal_state(task.id)
    assert persisted["method_id"] == "s3_ore_adaptive"
    assert persisted["migrated_terminal_actions"] == ["old-stripmine-terminal"]
    assert persisted["action_history"][0]["receipt_confirmed"] is True


@pytest.mark.asyncio
async def test_s3_confirmed_wood_search_failure_persists_context_and_budget(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S3", "S3")
    state = modern_state(
        food=18,
        position={"x": -34, "y": 73, "z": 130},
        inventory={
            "porkchop": 2,
            "crafting_table": 1,
            "stone_pickaxe": 1,
            "stick": 3,
            "oak_planks": 2,
        },
        shelter={"position": {"x": -34, "y": 72, "z": 130}, "size": 4, "inside": False},
    )
    detail = "附近 64 格内没有橡木，一个都没有找到"

    async def dispatch(tool: str, arguments: dict, timeout_s: float = 0, **kwargs):
        raise ActionError(
            detail,
            status="blocked",
            action_id=str(kwargs.get("action_id") or "oak-no-resource"),
            data={"observation": dict(state)},
            receipt_confirmed=True,
        )

    supervisor = GoalSupervisor(GOALS["S3"], store, dispatch, lambda: state)
    supervisor.task_id = task.id
    supervisor.state = supervisor._new_state()
    ready, step = choose_s3_preflight_action(state, supervisor.state)
    assert not ready and step is not None and step.arguments["block"] == "wood_log"
    context = "overworld:-2:9:4"

    outcome = await supervisor._execute_step(step, f"s3:wood_search:{context}:wood_log", None)

    assert outcome == "retry"
    entry = supervisor.state["action_history"][-1]
    assert entry["receipt_confirmed"] is True
    assert entry["wood_search_context"] == context
    assert supervisor.state["counters"]["attempts"][f"s3:wood_search:{context}:wood_log"] == 1
    ready, next_step = choose_s3_preflight_action(state, supervisor.state)
    assert not ready and next_step is not None
    assert next_step.arguments["block"] == "wood_log"


async def test_s3_exhausted_wood_search_expands_then_relocates_before_retry(tmp_path):
    store = TaskStore(tmp_path / "wood.db")
    store.initialize()
    task = store.create_task("S3", "S3")
    state = modern_state(food=20, inventory={
        "porkchop": 8, "iron_pickaxe": 1, "iron_sword": 1, "bucket": 1, "iron_ingot": 1,
        "crafting_table": 1, "oak_planks": 2,
    }, shelter={"inside": False})
    calls = []

    async def dispatch(tool, arguments, timeout_s=0, **kwargs):
        calls.append((tool, arguments))
        state["revision"] += 1
        data = {}
        if tool == "explore_mining_site":
            origin = state["position"]
            assert origin in arguments["avoid_positions"]
            state["position"] = {**origin, "x": origin["x"] + arguments["min_distance"]}
            data["relocation"] = {"origin": origin, "destination": state["position"]}
        elif tool == "mine_collect" and len(calls) <= 2:
            raise ActionError("附近没有原木", status="blocked", receipt_confirmed=True,
                              action_id=kwargs["action_id"], data={"observation": dict(state)})
        elif tool == "mine_collect":
            state["inventory"]["oak_log"] = 2
        elif tool == "craft" and arguments["item"] == "oak_planks":
            state["inventory"].update(oak_planks=10, oak_log=0)
        elif tool == "craft" and arguments["item"] == "shield":
            state["inventory"]["shield"] = 1
        data["observation"] = dict(state)
        return ActionResult(action_id=kwargs["action_id"], ok=True, status="succeeded", detail="完成", data=data)

    supervisor = GoalSupervisor(GOALS["S3"], store, dispatch, lambda: state)
    result = await supervisor.run(task.id)
    assert result["status"] == "done", result
    assert [args.get("range") for _, args in calls[:4]] == [64, 128, None, 64]
    assert all(args["surface_wood"] for tool, args in calls if tool == "mine_collect")
    assert calls[2][0] == "explore_mining_site"
    assert not supervisor.state.get("s3_ore_regions")


@pytest.mark.asyncio
async def test_goal_budget_fuses_before_dispatch(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S0", "S0")
    goal = replace(GOALS["S0"], budget=GoalBudget(max_actions=0, max_elapsed_s=60, max_attempts_per_method=1))
    calls: list[str] = []

    async def dispatch(tool: str, arguments: dict, **kwargs):
        calls.append(tool)
        return "unexpected"

    supervisor = GoalSupervisor(goal, store, dispatch, lambda: modern_state())
    result = await supervisor.run(task.id)

    assert result["status"] == "blocked"
    assert result["block_reason"] == "budget_actions"
    assert calls == []
    assert store.get_task(task.id).status == "blocked"


@pytest.mark.asyncio
async def test_last_budgeted_partial_action_can_complete_goal_from_fresh_observation(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S2", "S2")
    state = modern_state(
        is_day=False,
        shelter={
            "position": {"x": 0, "y": 64, "z": 0},
            "size": 4,
            "sealed": True,
            "inside": True,
            "bounds": {"min": {"x": -2, "y": 64, "z": -2}, "max": {"x": 1, "y": 67, "z": 1}},
        },
        nearby_beds=[{"x": 0, "y": 65, "z": 0}],
    )
    dispatched: list[str] = []
    goal = replace(
        GOALS["S2"],
        budget=GoalBudget(max_actions=1, max_elapsed_s=60, max_attempts_per_method=1),
    )

    async def dispatch(tool: str, arguments: dict, timeout_s: float = 0, action_id: str = "", **kwargs):
        dispatched.append(tool)
        assert tool == "sleep_safe"
        state["is_day"] = True
        state["revision"] += 1
        return ActionResult(
            action_id,
            True,
            status="partial",
            detail="动作被观察到部分完成",
            data={"observation": dict(state)},
        )

    supervisor = GoalSupervisor(goal, store, dispatch, lambda: state)
    result = await supervisor.run(task.id)

    assert dispatched == ["sleep_safe"]
    assert result["status"] == "done"
    assert result["actions"] == 1
    assert store.load_goal_state(task.id)["status"] == "done"
    assert store.get_task(task.id).status == "done"


@pytest.mark.asyncio
async def test_method_attempt_budget_persists_blocked_goal_task_and_api_state(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    state = modern_state()
    calls: list[str] = []

    async def dispatch(tool: str, arguments: dict, timeout_s: float = 0, **kwargs):
        calls.append(tool)
        raise ActionError("测试动作稳定失败", status="failed", action_id=kwargs.get("action_id", ""))

    manager = RunManager(dispatch, lambda: state, lambda text: asyncio.sleep(0), store, runs_dir=tmp_path / "runs")
    started = await manager.start("S0")
    task_id = started["task_id"]
    status = await manager.wait()

    goal_state = store.load_goal_state(task_id)
    task = store.get_task(task_id)
    api_status = manager.status()
    assert calls == ["mine_collect"] * GOALS["S0"].budget.max_attempts_per_method
    assert status["result"]["status"] == "blocked"
    assert goal_state["status"] == "blocked"
    assert goal_state["block_reason"] == "budget_method_attempts"
    assert goal_state["counters"]["attempts"]["s0:mine_collect:wood_log"] == GOALS["S0"].budget.max_attempts_per_method
    assert goal_state["counters"]["method_failures"]["s0:mine_collect:wood_log"] == GOALS["S0"].budget.max_attempts_per_method
    assert task.status == "blocked"
    assert api_status["goal_status"] == "blocked"
    assert api_status["result"]["status"] == "blocked"

    state["revision"] += 1
    assert manager.on_state_update(state) is False
    assert store.load_goal_state(task_id)["status"] == "blocked"
    await manager.close()


@pytest.mark.asyncio
async def test_run_manager_persists_unhandled_supervisor_exception_as_failed_goal(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    provider_calls = 0

    def broken_state_provider():
        nonlocal provider_calls
        provider_calls += 1
        if provider_calls == 2:
            raise RuntimeError("state provider failed")
        return modern_state()

    manager = RunManager(
        lambda tool, arguments, timeout_s=0, **kwargs: asyncio.sleep(0),
        broken_state_provider,
        lambda text: asyncio.sleep(0),
        store,
        runs_dir=tmp_path / "runs",
    )
    started = await manager.start("S0")
    task_id = started["task_id"]
    result = await manager.wait()

    goal_state = store.load_goal_state(task_id)
    assert result["result"]["status"] == "failed"
    assert goal_state["status"] == "failed"
    assert goal_state["block_reason"].startswith("goal_supervisor_failed:")
    assert store.get_task(task_id).status == "failed"
    assert manager.on_state_update(modern_state(revision=2)) is False
    await manager.close()


@pytest.mark.asyncio
async def test_stop_pauses_goal_and_fresh_state_does_not_auto_resume(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    state = modern_state(ready=False)
    calls: list[str] = []

    async def dispatch(tool: str, arguments: dict, **kwargs):
        calls.append(tool)
        return "unexpected"

    manager = RunManager(dispatch, lambda: state, lambda text: asyncio.sleep(0), store, runs_dir=tmp_path / "runs")
    started = await manager.start("S0")
    task_id = started["task_id"]
    for _ in range(20):
        goal_state = store.load_goal_state(task_id)
        if goal_state and goal_state.get("status") == "waiting":
            break
        await asyncio.sleep(0.01)

    manager.request_stop()
    await manager.wait()
    state.update(ready=True, revision=2, inventory={"wooden_pickaxe": 1, "crafting_table": 1})

    assert store.load_goal_state(task_id)["status"] == "paused_by_user"
    assert manager.on_state_update(state) is False
    assert calls == []
    await manager.close()


@pytest.mark.asyncio
async def test_stop_immediately_after_start_preserves_choice_and_prevents_dispatch(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    state = modern_state(inventory={"wooden_pickaxe": 1, "crafting_table": 1})
    calls: list[str] = []

    async def dispatch(tool: str, arguments: dict, timeout_s: float = 0, **kwargs):
        calls.append(tool)
        return "unexpected"

    manager = RunManager(dispatch, lambda: state, lambda text: asyncio.sleep(0), store, runs_dir=tmp_path / "runs")
    started = await manager.start("S0", budget_mode="adaptive")
    assert store.load_goal_state(started["task_id"])["budget"]["mode"] == "adaptive"

    manager.request_stop()
    await manager.wait()

    assert store.load_goal_state(started["task_id"])["status"] == "paused_by_user"
    assert store.get_task(started["task_id"]).status == "cancelled"
    assert calls == []
    await manager.close()

    restarted = RunManager(dispatch, lambda: state, lambda text: asyncio.sleep(0), store, runs_dir=tmp_path / "runs")
    assert restarted.on_state_update(state) is False
    restored = restarted.status()
    assert restored["goal_status"] == "paused_by_user"
    assert restored["action_budget"]["mode"] == "adaptive"
    assert restored["action_budget"]["used"] == 0
    assert calls == []
    await restarted.close()


@pytest.mark.asyncio
async def test_core_shutdown_during_completion_announcement_keeps_done_terminal(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S0", "S0")
    state = modern_state(inventory={"wooden_pickaxe": 1, "crafting_table": 1})
    announcing = asyncio.Event()

    async def dispatch(tool: str, arguments: dict, timeout_s: float = 0, **kwargs):
        raise AssertionError("当前目标条件已满足")

    async def announce(text: str) -> None:
        announcing.set()
        await asyncio.Event().wait()

    supervisor = GoalSupervisor(GOALS["S0"], store, dispatch, lambda: state, announce=announce)
    running = asyncio.create_task(supervisor.run(task.id))
    await announcing.wait()
    assert store.load_goal_state(task.id)["status"] == "done"
    running.cancel()
    with pytest.raises(asyncio.CancelledError):
        await running

    assert store.load_goal_state(task.id)["status"] == "done"
    assert store.get_task(task.id).status == "done"


@pytest.mark.asyncio
async def test_stop_death_and_disconnect_cannot_overwrite_done_during_announcement(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    state = modern_state(inventory={"wooden_pickaxe": 1, "crafting_table": 1})
    announcing = asyncio.Event()
    release = asyncio.Event()

    async def dispatch(tool: str, arguments: dict, timeout_s: float = 0, **kwargs):
        raise AssertionError("当前目标条件已满足")

    async def announce(text: str) -> None:
        announcing.set()
        await release.wait()

    manager = RunManager(dispatch, lambda: state, announce, store, runs_dir=tmp_path / "runs")
    started = await manager.start("S0")
    task_id = started["task_id"]
    await announcing.wait()

    manager.on_death({"lifecycle_id": "death-after-goal-complete", "session_id": "world-1", "revision": 2})
    manager.on_bridge_unavailable("disconnect during completion announcement")
    manager.request_stop()

    assert store.load_goal_state(task_id)["status"] == "done"
    assert store.get_task(task_id).status == "done"
    release.set()
    await manager.wait()
    assert store.load_goal_state(task_id)["status"] == "done"
    assert store.get_task(task_id).status == "done"
    assert manager.status()["result"]["status"] == "done"
    await manager.close()


def test_resume_repairs_task_mirror_from_persisted_done_goal_without_reopening(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S0", "S0")
    saved = {
        "goal_id": "stage:s0",
        "status": "done",
        "detail": "验收已完成",
        "pending_action": None,
    }
    store.save_goal_state(task.id, saved)
    assert store.get_task(task.id).status == "active"

    manager = RunManager(lambda tool, args: asyncio.sleep(0), lambda: modern_state(), lambda text: asyncio.sleep(0), store)
    result = asyncio.run(manager.resume(task.id))

    assert result["goal_status"] == "done"
    assert result["running"] is False
    assert store.load_goal_state(task.id)["status"] == "done"
    assert store.get_task(task.id).status == "done"


@pytest.mark.asyncio
async def test_death_does_not_reopen_blocked_goal(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S0", "S0")
    store.save_goal_state(
        task.id,
        {"goal_id": "stage:s0", "status": "blocked", "block_reason": "budget_actions"},
    )
    store.set_status(task.id, "blocked")
    manager = RunManager(lambda tool, args: asyncio.sleep(0), lambda: modern_state(), lambda text: asyncio.sleep(0), store)
    manager._task_id = task.id
    manager._task = asyncio.create_task(asyncio.sleep(60))

    manager.on_death({"lifecycle_id": "death-while-blocked"})

    assert store.load_goal_state(task.id)["status"] == "blocked"
    assert store.get_task(task.id).status == "blocked"
    manager._task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await manager._task


@pytest.mark.asyncio
async def test_multiple_fresh_revisions_reserve_only_one_auto_resume(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S0", "S0")
    state = modern_state(
        revision=2,
        inventory={"wooden_pickaxe": 1, "crafting_table": 1},
    )
    status_queries: list[str] = []

    async def dispatch(tool: str, arguments: dict, **kwargs):
        raise AssertionError("目标已满足，不应派发动作")

    async def action_status(action_id: str):
        status_queries.append(action_id)
        return ActionStatusResult(action_id, "unknown", "桥接账本没有原动作记录")

    saved = {
        "goal_id": "stage:s0",
        "stage": "S0",
        "status": "disconnected",
        "pending_action": {
            "action_id": "old-action",
            "tool": "collect_blocks",
            "effect_class": "replan",
            "expected_condition": {"type": "inventory", "items": {"oak_log": 4}},
        },
        "recovery": {
            "needs_reconcile": True,
            "reason": "bridge_disconnected",
            "baseline_session_id": "world-1",
            "baseline_revision": 1,
        },
    }
    store.save_goal_state(task.id, saved)
    store.set_status(task.id, "disconnected")
    manager = RunManager(
        dispatch,
        lambda: state,
        lambda text: asyncio.sleep(0),
        store,
        action_status=action_status,
        runs_dir=tmp_path / "runs",
    )
    manager._task_id = task.id
    manager._stage = "S0"

    assert manager.on_state_update(state) is True
    state["revision"] = 3
    assert manager.on_state_update(state) is False
    await manager.wait()

    assert status_queries == ["old-action"]
    assert store.load_goal_state(task.id)["status"] == "done"
    assert store.get_task(task.id).status == "done"
    await manager.close()


def test_bridge_disconnect_does_not_reopen_done_or_cancelled_goals(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    manager = RunManager(
        lambda tool, arguments: asyncio.sleep(0, result="ok"),
        lambda: modern_state(),
        lambda text: asyncio.sleep(0),
        store,
    )
    for goal_status, task_status in (("done", "done"), ("paused_by_user", "cancelled")):
        task = store.create_task("S0", "S0")
        state = {"goal_id": "stage:s0", "status": goal_status, "pending_action": None}
        store.save_goal_state(task.id, state)
        store.set_status(task.id, task_status)
        manager._task_id = task.id
        manager.on_bridge_unavailable()
        assert store.load_goal_state(task.id)["status"] == goal_status
        assert store.get_task(task.id).status == task_status
    store.close()


def test_status_exposes_goal_progress_instead_of_only_legacy_cursor(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S2", "S2")
    store.save_goal_state(
        task.id,
        {
            "goal_id": "stage:s2",
            "status": "waiting",
            "block_reason": "Bridge 尚未 ready",
            "recovery": {"reason": "core_restart"},
            "pending_action": {"action_id": "a1", "tool": "craft", "status": "unknown"},
            "budget": {"max_actions": 48},
            "counters": {"actions": 4},
        },
    )
    manager = RunManager(lambda tool, args: asyncio.sleep(0), lambda: modern_state(), lambda text: asyncio.sleep(0), store)
    manager._stage = "S2"
    manager._task_id = task.id

    status = manager.status()

    assert status["current_goal"] == "stage:s2"
    assert status["goal_status"] == "waiting"
    assert status["pending_action"]["action_id"] == "a1"
    assert status["budget"] == {"max_actions": 48}
    assert status["counters"] == {"actions": 4}
    assert status["waiting_reason"] == "Bridge 尚未 ready"
    assert status["recovery_reason"] == "core_restart"
    assert status["in_flight_action"]["action_id"] == "a1"
    assert status["action_budget"] == {"mode": "acceptance", "used": 4, "limit": 48, "deadline_at": None}


def test_legacy_attempts_are_split_only_with_exact_transport_evidence(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S3", "S3")
    supervisor = GoalSupervisor(GOALS["S3"], store, lambda *args, **kwargs: asyncio.sleep(0), lambda: modern_state())
    supervisor.task_id = task.id
    supervisor.state = supervisor._new_state()
    attempts = {
        "s3:surface_route:shelter_anchor": 3,
        "s3:mine_collect:iron_ore:raw0": 1,
        "s3:mine_collect:oak_log": 3,
        "legacy:missing_receipt": 1,
        "legacy:missing_effect": 1,
        "legacy:wrong_effect": 1,
        "legacy:unverified_disconnect": 1,
        "legacy:verified_disconnect": 0,
        "legacy:confirmed_history": 0,
    }
    supervisor.state["counters"] = {
        "actions": 13,
        "attempts": dict(attempts),
        "admission_retries": {},
        "admission_rejections_total": {},
    }
    supervisor.state["action_history"] = [
        *[
            {
                "action_id": f"route-unknown-{index}",
                "method_key": "s3:surface_route:shelter_anchor",
                "tool": "goto",
                "effect_class": "replan",
                "status": "unknown_reconciled_for_replan",
                "receipt_confirmed": False,
            }
            for index in range(3)
        ],
        {
            "action_id": "ore-unknown-1",
            "method_key": "s3:mine_collect:iron_ore:raw0",
            "tool": "mine_collect",
            "effect_class": "replan",
            "status": "unknown_reconciled_for_replan",
            "receipt_confirmed": False,
        },
        {
            "action_id": "oak-failed-1",
            "method_key": "s3:mine_collect:oak_log",
            "tool": "mine_collect",
            "effect_class": "replan",
            "status": "blocked",
            "receipt_confirmed": True,
        },
        {
            "action_id": "missing-receipt",
            "method_key": "legacy:missing_receipt",
            "tool": "goto",
            "effect_class": "replan",
            "status": "unknown_reconciled_for_replan",
        },
        {
            "action_id": "missing-effect",
            "method_key": "legacy:missing_effect",
            "tool": "goto",
            "status": "unknown_reconciled_for_replan",
            "receipt_confirmed": False,
        },
        {
            "action_id": "wrong-effect",
            "method_key": "legacy:wrong_effect",
            "tool": "goto",
            "effect_class": "non_replayable",
            "status": "unknown_reconciled_for_replan",
            "receipt_confirmed": False,
        },
        {
            "action_id": "disconnect-without-fresh-state",
            "method_key": "legacy:unverified_disconnect",
            "tool": "goto",
            "effect_class": "replan",
            "status": "disconnected",
            "receipt_confirmed": False,
            "session_id": "old-session",
            "revision": 8,
        },
        {
            "action_id": "verified-disconnect",
            "method_key": "legacy:verified_disconnect",
            "tool": "goto",
            "effect_class": "replan",
            "status": "disconnected",
            "receipt_confirmed": False,
            "session_id": "old-session",
            "revision": 8,
            "terminal_observation": {"session_id": "new-session", "revision": 1},
        },
        {
            "action_id": "confirmed-history-only",
            "method_key": "legacy:confirmed_history",
            "tool": "craft",
            "effect_class": "replan",
            "status": "failed",
            "receipt_confirmed": True,
        },
    ]

    supervisor._initialize_recovery_budgets()
    counters = supervisor.state["counters"]
    assert counters["attempts"] == attempts
    assert counters["method_failures"] == {
        "s3:surface_route:shelter_anchor": 0,
        "s3:mine_collect:iron_ore:raw0": 0,
        "s3:mine_collect:oak_log": 3,
        "legacy:missing_receipt": 1,
        "legacy:missing_effect": 1,
        "legacy:wrong_effect": 1,
        "legacy:unverified_disconnect": 1,
        "legacy:verified_disconnect": 0,
        "legacy:confirmed_history": 1,
    }
    assert counters["transport_recoveries"] == 5
    assert len(counters["transport_recovery_action_ids"]) == 5

    supervisor._initialize_recovery_budgets()
    assert counters["transport_recoveries"] == 5
    assert len(counters["transport_recovery_action_ids"]) == 5
    store.close()


@pytest.mark.asyncio
async def test_three_unknown_goto_receipts_do_not_block_same_route_method(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S3", "S3")
    state = modern_state(
        session_id="fresh-bridge",
        revision=8,
        food=18,
        position={"x": -18.5, "y": 57.0, "z": 143.4},
        inventory={"porkchop": 2},
        shelter={
            "position": {"x": -34, "y": 72, "z": 130},
            "size": 4,
            "inside": False,
        },
    )
    dispatches: list[tuple[str, dict]] = []

    async def dispatch(tool: str, arguments: dict, timeout_s: float = 0.0, action_id: str = "", **kwargs):
        dispatches.append((tool, dict(arguments)))
        assert tool == "goto"
        state["position"] = dict(arguments)
        state["inventory"] = {
            "crafting_table": 1,
            "iron_pickaxe": 1,
            "iron_sword": 1,
            "shield": 1,
            "bucket": 1,
            "porkchop": 2,
        }
        state["revision"] += 1
        return ActionResult(action_id, True, status="succeeded", detail="到达安全地表", data={"observation": dict(state)})

    async def action_status(action_id: str):
        return ActionStatusResult(action_id, "unknown", "原 Bridge ledger 不含终态回执")

    supervisor = GoalSupervisor(
        GOALS["S3"],
        store,
        dispatch,
        lambda: state,
        action_status=action_status,
    )
    saved = supervisor._new_state()
    saved["status"] = "disconnected"
    saved["counters"]["attempts"]["s3:surface_route:shelter_anchor"] = 3
    saved["action_history"] = [
        {
            "action_id": f"old-unknown-goto-{index}",
            "goal_id": "stage:s3",
            "method_id": "s3_ore_adaptive",
            "method_key": "s3:surface_route:shelter_anchor",
            "tool": "goto",
            "effect_class": "replan",
            "status": "unknown_reconciled_for_replan",
            "receipt_confirmed": False,
        }
        for index in range(1, 4)
    ]
    saved.pop("counters")
    saved["counters"] = {
        "actions": 1,
        "attempts": {"s3:surface_route:shelter_anchor": 3},
        "admission_retries": {},
        "admission_rejections_total": {},
    }
    saved["pending_action"] = {
        "action_id": "pending-unknown-goto",
        "goal_id": "stage:s3",
        "method_id": "s3_ore_adaptive",
        "method_key": "s3:surface_route:shelter_anchor",
        "tool": "goto",
        "arguments": {"x": -34, "y": 73, "z": 130},
        "expected_condition": {"type": "position", "target": {"x": -34, "y": 73, "z": 130}, "radius": 3.0},
        "effect_class": "replan",
        "session_id": "old-bridge",
        "revision": 7,
        "status": "disconnected",
        "receipt_confirmed": False,
        "result_data": {},
    }
    saved["recovery"] = {
        "needs_reconcile": True,
        "reason": "bridge_disconnected",
        "baseline_session_id": "old-bridge",
        "baseline_revision": 7,
    }
    store.save_goal_state(task.id, saved)
    store.set_status(task.id, "disconnected")

    result = await supervisor.run(task.id, resume=True)

    assert result["status"] == "done", (result, store.load_goal_state(task.id))
    assert dispatches == [("goto", {"x": -34, "y": 73, "z": 130})]
    final = store.load_goal_state(task.id)
    counters = final["counters"]
    assert counters["attempts"]["s3:surface_route:shelter_anchor"] == 4
    assert counters["method_failures"]["s3:surface_route:shelter_anchor"] == 0
    assert counters["transport_recoveries"] == 4
    assert len(counters["transport_recovery_action_ids"]) == 4
    assert sum(entry.get("action_id") == "pending-unknown-goto" for entry in final["action_history"]) == 1
    store.close()


@pytest.mark.asyncio
async def test_unknown_reconciliation_waits_for_new_revision_before_spending_transport_budget(tmp_path, monkeypatch):
    monkeypatch.setattr("voxkin.agent.goal_supervisor.MAX_READY_WAIT_S", 0.01)
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S3", "S3")
    state = modern_state(
        session_id="same-bridge",
        revision=7,
        food=18,
        position={"x": -18.5, "y": 57.0, "z": 143.4},
        inventory={"porkchop": 2},
        shelter={"position": {"x": -34, "y": 72, "z": 130}, "size": 4, "inside": False},
    )
    calls: list[str] = []

    async def dispatch(tool: str, arguments: dict, timeout_s: float = 0.0, action_id: str = "", **kwargs):
        calls.append(tool)
        raise ActionError(
            "Bridge 在动作期间断开",
            status="disconnected",
            action_id=action_id,
            receipt_confirmed=False,
        )

    async def action_status(action_id: str):
        return ActionStatusResult(action_id, "unknown", "账本暂时没有终态")

    supervisor = GoalSupervisor(
        GOALS["S3"], store, dispatch, lambda: state, action_status=action_status
    )
    saved = supervisor._new_state()
    saved.update(
        {
            "status": "disconnected",
            "pending_action": {
                "action_id": "stale-unknown-goto",
                "method_key": "s3:surface_route:shelter_anchor",
                "tool": "goto",
                "arguments": {"x": -34, "y": 73, "z": 130},
                "expected_condition": {
                    "type": "position",
                    "target": {"x": -34, "y": 73, "z": 130},
                    "radius": 3.0,
                },
                "effect_class": "replan",
                "session_id": "same-bridge",
                "revision": 7,
                "status": "disconnected",
                "receipt_confirmed": False,
            },
            "recovery": {
                "needs_reconcile": True,
                "reason": "bridge_disconnected",
                "baseline_session_id": "same-bridge",
                "baseline_revision": 7,
            },
        }
    )
    store.save_goal_state(task.id, saved)
    store.set_status(task.id, "disconnected")

    waiting = await supervisor.run(task.id, resume=True)

    assert waiting["status"] == "waiting"
    first = store.load_goal_state(task.id)
    assert first["pending_action"]["action_id"] == "stale-unknown-goto"
    assert first["counters"]["transport_recoveries"] == 0
    assert first["counters"]["attempts"] == {}
    assert calls == []

    state["revision"] = 8
    state["executor"] = {"active_action_id": None, "safety_active": False, "epoch": 2}
    resumed = await supervisor.run(task.id, resume=True)

    assert resumed["status"] == "disconnected", (resumed, store.load_goal_state(task.id))
    final = store.load_goal_state(task.id)
    assert final["counters"]["transport_recoveries"] == 1
    assert final["counters"]["method_failures"].get("s3:surface_route:shelter_anchor", 0) == 0
    assert calls == ["goto"]
    store.close()


@pytest.mark.asyncio
async def test_transport_recovery_budget_exhausts_once_and_repeat_resume_does_not_recount(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S3", "S3")
    state = modern_state(
        session_id="fresh-bridge",
        revision=20,
        food=18,
        position={"x": -18.5, "y": 57.0, "z": 143.4},
        inventory={"porkchop": 0},
        shelter={"position": {"x": -34, "y": 72, "z": 130}, "size": 4, "inside": False},
    )
    dispatches: list[str] = []

    async def dispatch(tool: str, arguments: dict, **kwargs):
        dispatches.append(tool)
        raise AssertionError("第八次传输恢复耗尽后不应派发新动作")

    async def action_status(action_id: str):
        return ActionStatusResult(action_id, "unknown", "原 Bridge ledger 不含终态回执")

    supervisor = GoalSupervisor(GOALS["S3"], store, dispatch, lambda: state, action_status=action_status)
    saved = supervisor._new_state()
    saved["status"] = "disconnected"
    transport_history = [
        {
            "action_id": f"transport-{index}",
            "goal_id": "stage:s3",
            "method_id": "s3_ore_adaptive",
            "method_key": "s3:surface_route:shelter_anchor",
            "tool": "goto",
            "effect_class": "replan",
            "status": "unknown_reconciled_for_replan",
            "receipt_confirmed": False,
        }
        for index in range(1, 8)
    ]
    saved["action_history"] = list(transport_history)
    saved["counters"] = {
        "actions": 8,
        "attempts": {"s3:surface_route:shelter_anchor": 7},
        "admission_retries": {},
        "admission_rejections_total": {},
    }
    saved["pending_action"] = {
        "action_id": "transport-8",
        "goal_id": "stage:s3",
        "method_id": "s3_ore_adaptive",
        "method_key": "s3:surface_route:shelter_anchor",
        "tool": "goto",
        "arguments": {"x": -34, "y": 73, "z": 130},
        "expected_condition": {"type": "position", "target": {"x": -34, "y": 73, "z": 130}, "radius": 3.0},
        "effect_class": "replan",
        "session_id": "old-bridge",
        "revision": 19,
        "status": "disconnected",
        "receipt_confirmed": False,
        "result_data": {},
    }
    saved["recovery"] = {
        "needs_reconcile": True,
        "reason": "bridge_disconnected",
        "baseline_session_id": "old-bridge",
        "baseline_revision": 19,
    }
    store.save_goal_state(task.id, saved)
    store.set_status(task.id, "disconnected")

    result = await supervisor.run(task.id, resume=True)

    assert result["status"] == "blocked"
    assert result["block_reason"] == "budget_transport_recovery"
    first = store.load_goal_state(task.id)
    assert first["counters"]["transport_recoveries"] == 8
    assert first["counters"]["method_failures"]["s3:surface_route:shelter_anchor"] == 0
    assert first["counters"]["attempts"]["s3:surface_route:shelter_anchor"] == 8
    assert sum(entry.get("action_id") == "transport-8" for entry in first["action_history"]) == 1

    repeated = await supervisor.run(task.id, resume=True)

    assert repeated["status"] == "blocked"
    assert repeated["block_reason"] == "budget_transport_recovery"
    second = store.load_goal_state(task.id)
    assert second["counters"]["transport_recoveries"] == 8
    assert second["counters"]["attempts"]["s3:surface_route:shelter_anchor"] == 8
    assert sum(entry.get("action_id") == "transport-8" for entry in second["action_history"]) == 1
    assert dispatches == []
    store.close()


def _s6_search_context(*, phase="descend", layers=0, y=64):
    return {
        "schema_version": 1,
        "search_id": None,
        "phase": phase,
        "evidence": {
            "kind": "eye_overhead",
            "throw_origin": {"x": 10, "y": 64, "z": 20},
            "eye_position": {"x": 15, "y": 64, "z": 20},
            "horizontal_distance": 5,
        },
        "estimate": {"x": 12, "z": 18, "distance": 4, "angle_deg": 90, "throws": 2},
        "eye_accounting": {
            "throws_completed": 2,
            "inventory_before": 5,
            "inventory_after": 3,
            "inventory_net_change": -2,
        },
        "position": {"x": 10, "y": y, "z": 20},
        "descent": {"layers_completed": layers, "max_layers": 96, "segment_layers": 8},
        "scan": {
            "fresh": True,
            "stable": True,
            "dimension": "minecraft:overworld",
            "radius": 64,
            "frames": [],
        },
    }


@pytest.mark.asyncio
async def test_s6_partial_resumes_saved_search_without_rethrowing_eyes(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S6", "S6")
    state = modern_state(food=20, inventory={"cooked_beef": 4, "bow": 1, "arrow": 64, "ender_eye": 24})
    calls: list[tuple[str, dict, str]] = []

    async def dispatch(tool: str, arguments: dict, timeout_s: float = 0, **kwargs):
        calls.append((tool, arguments, kwargs["action_id"]))
        if len(calls) == 1:
            return ActionResult(
                action_id=kwargs["action_id"],
                ok=False,
                status="partial",
                detail="eye overhead; no frame",
                data={"stronghold_search": _s6_search_context()},
            )
        search = arguments["resume_search"]
        assert search["search_id"] == calls[0][2]
        stopped = _s6_search_context(phase="blocked", layers=8, y=56)
        stopped["search_id"] = search["search_id"]
        stopped["stop_reason"] = "safe_descend stopped at lava"
        return ActionResult(
            action_id=kwargs["action_id"],
            ok=False,
            status="partial",
            detail="safe descent blocked",
            data={"stronghold_search": stopped},
        )

    supervisor = GoalSupervisor(GOALS["S6"], store, dispatch, lambda: state)
    saved = supervisor._new_state()
    saved.update({"status": "active", "method_index": 6})
    store.save_goal_state(task.id, saved)

    result = await supervisor.run(task.id, resume=True)

    assert result["status"] == "blocked"
    assert [tool for tool, _, _ in calls] == ["throw_eye", "throw_eye"]
    assert "resume_search" not in calls[0][1]
    assert set(calls[1][1]) == {"resume_search"}
    assert calls[1][1]["resume_search"]["eye_accounting"]["throws_completed"] == 2
    persisted = store.load_goal_state(task.id)
    assert persisted["method_index"] == 7
    assert persisted["stronghold_search"]["search_id"] == calls[0][2]
    assert persisted["stronghold_search"]["descent"]["layers_completed"] == 8
    assert persisted["stronghold_search"]["eye_accounting"]["inventory_net_change"] == -2
    assert persisted["pending_action"] is None
    assert "unresolved_action" not in persisted
    store.close()


@pytest.mark.asyncio
async def test_s6_reconciles_partial_receipt_then_dispatches_only_saved_search(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S6", "S6")
    state = modern_state(revision=2)
    action_queries: list[str] = []
    calls: list[dict] = []

    async def dispatch(tool: str, arguments: dict, timeout_s: float = 0, **kwargs):
        calls.append(arguments)
        assert tool == "throw_eye"
        search = arguments["resume_search"]
        assert search["search_id"] == "eye-action-1"
        stopped = _s6_search_context(phase="blocked", layers=8, y=56)
        stopped["search_id"] = search["search_id"]
        stopped["stop_reason"] = "hostile nearby"
        return ActionResult(
            action_id=kwargs["action_id"],
            ok=False,
            status="partial",
            detail="hostile nearby",
            data={"stronghold_search": stopped},
        )

    async def action_status(action_id: str):
        action_queries.append(action_id)
        return ActionStatusResult(
            action_id,
            "partial",
            "eye overhead; no frame",
            data={"stronghold_search": _s6_search_context(), "observation": dict(state)},
        )

    supervisor = GoalSupervisor(
        GOALS["S6"], store, dispatch, lambda: state, action_status=action_status,
    )
    saved = supervisor._new_state()
    saved.update({
        "status": "recovering",
        "method_index": 6,
        "pending_action": {
            "action_id": "eye-action-1",
            "goal_id": "stage:s6",
            "method_id": "plan:s6",
            "method_key": "plan:s6:6",
            "step_index": 6,
            "tool": "throw_eye",
            "arguments": {"count": 12},
            "expected_condition": {"type": "always"},
            "effect_class": "non_replayable",
            "status": "unknown",
            "session_id": "world-1",
            "revision": 1,
        },
        "recovery": {"needs_reconcile": True, "reason": "explicit_resume"},
    })
    store.save_goal_state(task.id, saved)

    result = await supervisor.run(task.id, resume=True)

    assert result["status"] == "blocked"
    assert action_queries == ["eye-action-1"]
    assert len(calls) == 1
    assert set(calls[0]) == {"resume_search"}
    assert calls[0]["resume_search"]["search_id"] == "eye-action-1"
    persisted = store.load_goal_state(task.id)
    assert persisted["stronghold_search"]["phase"] == "blocked"
    assert persisted["pending_action"] is None
    assert "unresolved_action" not in persisted
    store.close()


@pytest.mark.asyncio
async def test_s6_partial_without_overhead_evidence_stays_blocked_on_resume(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S6", "S6")
    state = modern_state(food=20, inventory={"cooked_beef": 4, "bow": 1, "arrow": 64, "ender_eye": 24})
    calls = 0

    async def dispatch(tool: str, arguments: dict, timeout_s: float = 0, **kwargs):
        nonlocal calls
        calls += 1
        search = _s6_search_context(phase="blocked")
        search["evidence"] = {"kind": "direction_estimate_only"}
        search["stop_reason"] = "没有 eye-overhead 证据"
        return ActionResult(
            action_id=kwargs["action_id"],
            ok=False,
            status="partial",
            detail="estimate only",
            data={"stronghold_search": search},
        )

    supervisor = GoalSupervisor(GOALS["S6"], store, dispatch, lambda: state)
    saved = supervisor._new_state()
    saved.update({"status": "active", "method_index": 6})
    store.save_goal_state(task.id, saved)

    first = await supervisor.run(task.id, resume=True)
    second = await supervisor.run(task.id, resume=True)

    assert first["status"] == second["status"] == "blocked"
    assert calls == 1
    persisted = store.load_goal_state(task.id)
    assert persisted["stronghold_search"]["phase"] == "blocked"
    assert persisted["stronghold_search"]["estimate"]["x"] == 12
    assert persisted["method_index"] == 7
    assert "unresolved_action" not in persisted
    store.close()


@pytest.mark.asyncio
async def test_s6_explicit_resume_rechecks_saved_overhead_search_without_rethrowing(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S6", "S6")
    state = modern_state(food=20, inventory={"cooked_beef": 4, "bow": 1, "arrow": 64, "ender_eye": 24})
    calls: list[tuple[str, dict]] = []

    async def dispatch(tool: str, arguments: dict, timeout_s: float = 0, **kwargs):
        calls.append((tool, arguments))
        if len(calls) == 1:
            search = _s6_search_context()
            return ActionResult(
                action_id=kwargs["action_id"],
                ok=False,
                status="partial",
                detail="eye overhead; no frame",
                data={"stronghold_search": search},
            )
        search = _s6_search_context(phase="blocked")
        search["search_id"] = calls[-1][1]["resume_search"]["search_id"]
        search["resume_allowed"] = True
        search["stop_reason"] = "health below descent threshold"
        return ActionResult(
            action_id=kwargs["action_id"],
            ok=False,
            status="partial",
            detail="health below descent threshold",
            data={"stronghold_search": search},
        )

    supervisor = GoalSupervisor(GOALS["S6"], store, dispatch, lambda: state)
    saved = supervisor._new_state()
    saved.update({"status": "active", "method_index": 6})
    store.save_goal_state(task.id, saved)

    first = await supervisor.run(task.id, resume=True)
    second = await supervisor.run(task.id, resume=True)

    assert first["status"] == second["status"] == "blocked"
    persisted = store.load_goal_state(task.id)
    assert [tool for tool, _ in calls] == ["throw_eye", "throw_eye", "throw_eye"]
    assert "resume_search" not in calls[0][1]
    assert set(calls[1][1]) == set(calls[2][1]) == {"resume_search"}
    assert calls[2][1]["resume_search"]["phase"] == "descend"
    assert calls[2][1]["resume_search"]["search_id"] == calls[1][1]["resume_search"]["search_id"]
    assert calls[2][1]["resume_search"].get("resume_allowed") is False
    assert not any("count" in arguments and arguments.get("count") == 12 for _, arguments in calls[1:])
    assert persisted["stronghold_search"]["phase"] == "blocked"
    assert persisted["stronghold_search"]["resume_allowed"] is True
    store.close()


@pytest.mark.asyncio
async def test_s6_rejects_resume_permission_when_saved_scan_dimension_is_not_overworld(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S6", "S6")
    state = modern_state(food=20, inventory={"cooked_beef": 4, "bow": 1, "arrow": 64, "ender_eye": 24})
    calls = 0

    async def dispatch(tool: str, arguments: dict, timeout_s: float = 0, **kwargs):
        nonlocal calls
        calls += 1
        search = _s6_search_context(phase="blocked")
        search["resume_allowed"] = True
        search["scan"]["dimension"] = "minecraft:the_nether"
        return ActionResult(
            action_id=kwargs["action_id"],
            ok=False,
            status="partial",
            detail="scan dimension mismatch",
            data={"stronghold_search": search},
        )

    supervisor = GoalSupervisor(GOALS["S6"], store, dispatch, lambda: state)
    saved = supervisor._new_state()
    saved.update({"status": "active", "method_index": 6})
    store.save_goal_state(task.id, saved)

    first = await supervisor.run(task.id, resume=True)
    second = await supervisor.run(task.id, resume=True)

    assert first["status"] == second["status"] == "blocked"
    assert calls == 1
    persisted = store.load_goal_state(task.id)
    assert persisted["stronghold_search"]["phase"] == "blocked"
    assert persisted["stronghold_search"]["resume_allowed"] is False
    store.close()


@pytest.mark.asyncio
async def test_s6_estimate_without_actual_frame_coordinates_cannot_verify_throw_eye(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S6", "S6")
    state = modern_state()
    calls = 0

    async def dispatch(tool: str, arguments: dict, timeout_s: float = 0, **kwargs):
        nonlocal calls
        calls += 1
        search = _s6_search_context(phase="frames_found")
        search["scan"] = {
            "fresh": True,
            "stable": True,
            "dimension": "minecraft:overworld",
            "radius": 64,
            "frames": [],
        }
        return ActionResult(
            action_id=kwargs["action_id"],
            ok=True,
            status="succeeded",
            detail="estimate only",
            data={
                "stronghold_search": search,
                "observation": {"dimension": "minecraft:overworld", "position": state["position"]},
            },
        )

    supervisor = GoalSupervisor(GOALS["S6"], store, dispatch, lambda: state)
    supervisor.task_id = task.id
    supervisor.state = supervisor._new_state()
    step = supervisor._method_steps()[6]

    outcome = await supervisor._execute_step(step, "plan:s6:6", 6)

    assert outcome == "blocked"
    assert calls == 1
    persisted = store.load_goal_state(task.id)
    assert persisted["status"] == "blocked"
    assert "unresolved_action" in persisted
    assert "没有实际门框坐标" in persisted["unresolved_action"]["reason"]
    store.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("visible", [False, True])
async def test_s6_fresh_overworld_frame_coordinates_verify_search_step(tmp_path, visible):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S6", "S6")
    state = modern_state()

    async def dispatch(tool: str, arguments: dict, timeout_s: float = 0, **kwargs):
        search = _s6_search_context(phase="frames_found")
        search["scan"] = {
            "fresh": True,
            "stable": True,
            "dimension": "minecraft:overworld",
            "radius": 64,
            "frames": [{"x": 11, "y": 24, "z": 20}],
            "line_of_sight": visible,
        }
        return ActionResult(
            action_id=kwargs["action_id"],
            ok=True,
            status="succeeded",
            detail="observed frame",
            data={
                "stronghold_search": search,
                "observation": {"dimension": "minecraft:overworld", "position": state["position"]},
            },
        )

    supervisor = GoalSupervisor(GOALS["S6"], store, dispatch, lambda: state)
    supervisor.task_id = task.id
    supervisor.state = supervisor._new_state()
    step = supervisor._method_steps()[6]

    outcome = await supervisor._execute_step(step, "plan:s6:6", 6)

    persisted = store.load_goal_state(task.id)
    if visible:
        assert outcome == "done"
        assert persisted["status"] == "active"
        assert persisted["method_index"] == 7
        assert persisted["stronghold_search"]["phase"] == "frames_found"
        assert persisted["stronghold_search"]["scan"]["frames"] == [{"x": 11, "y": 24, "z": 20}]
    else:
        assert outcome == "blocked"
        assert "视线" in persisted["unresolved_action"]["reason"]
    store.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("scenario", "expected_status", "expect_pending"),
    [
        ("old_observation", "waiting", True),
        ("inflight_observation", "waiting", True),
        ("terminal_new_session_old_current", "waiting", True),
        ("old_dispatch_state_with_mismatched_receipt_baseline", "waiting", True),
        ("same_session_terminal_observation", "done", False),
        ("new_session_observation", "done", False),
    ],
)
async def test_resume_known_terminal_receipt_requires_post_action_observation(
    tmp_path, scenario, expected_status, expect_pending
):
    store = TaskStore(tmp_path / f"tasks-{scenario}.db")
    store.initialize()
    task = store.create_task("S3", "S3")
    action_id = "pending-oak-collect"
    method_key = "s3:wood_search:overworld:-2:9:4:oak_log"
    baseline_revision = 20
    objective_inventory = {
        "iron_pickaxe": 1,
        "iron_sword": 1,
        "shield": 1,
        "bucket": 1,
    }
    start_inventory = {
        "porkchop": 4,
        "crafting_table": 1,
        "stone_pickaxe": 1,
        "stick": 3,
        "oak_planks": 2,
    }
    terminal_state = modern_state(
        session_id="paper-session",
        revision=22,
        food=18,
        inventory={**objective_inventory, "oak_log": 1},
    )
    state = modern_state(
        session_id="paper-session",
        revision=baseline_revision + 1,
        food=18,
        inventory=dict(start_inventory),
        shelter={
            "position": {"x": -34, "y": 72, "z": 130},
            "size": 4,
            "inside": False,
        },
    )
    pending = {
        "action_id": action_id,
        "goal_id": "stage:s3",
        "method_id": "s3_ore_adaptive",
        "method_key": method_key,
        "step_index": None,
        "tool": "mine_collect",
        "arguments": {"block": "oak_log", "count": 1, "range": 64},
        "timeout_s": 250.0,
        "expected_condition": {"type": "inventory", "items": {"oak_log": 1}},
        "effect_class": "replan",
        "session_id": "paper-session",
        "revision": baseline_revision,
        "started_at": time.time() - 10,
        "status": "disconnected",
        "receipt_confirmed": False,
        "result_data": {},
        "result_detail": "Bridge 已断开，动作结果未知",
    }
    if scenario == "old_dispatch_state_with_mismatched_receipt_baseline":
        pending["terminal_receipt_baseline"] = {
            "session_id": "reconnected-session",
            "revision": 1,
        }
    deadline_at = time.time() + 600
    counters = {
        "actions": 2,
        "attempts": {method_key: 1},
        "method_failures": {method_key: 0},
        "transport_recoveries": 2,
        "transport_recovery_action_ids": ["older-recovery-1", "older-recovery-2"],
        "recovery_budget_version": 1,
        "admission_retries": {},
        "admission_rejections_total": {},
    }
    seed = GoalSupervisor(
        GOALS["S3"], store, lambda *args, **kwargs: asyncio.sleep(0), lambda: state
    )._new_state()
    seed.update(
        {
            "status": "paused_by_user",
            "deadline_at": deadline_at,
            "method_index": 0,
            "counters": counters,
            "pending_action": pending,
            "last_observation": dict(state),
            "recovery": {
                "needs_reconcile": True,
                "reason": "user_stop",
                "baseline_session_id": "paper-session",
                "baseline_revision": baseline_revision,
            },
        }
    )
    store.save_goal_state(task.id, seed)
    store.set_status(task.id, "cancelled")
    status_queries: list[str] = []
    dispatches: list[str] = []

    async def dispatch(tool: str, arguments: dict, **kwargs):
        dispatches.append(tool)
        raise AssertionError("终态回执对账前不得重新派发动作")

    async def action_status(query_action_id: str):
        status_queries.append(query_action_id)
        if scenario == "inflight_observation":
            state.clear()
            state.update(
                modern_state(
                    session_id="paper-session",
                    revision=baseline_revision + 2,
                    food=18,
                    inventory=dict(start_inventory),
                    executor={
                        "active_action_id": action_id,
                        "safety_active": False,
                        "epoch": 2,
                    },
                )
            )
        elif scenario == "same_session_terminal_observation":
            state.clear()
            state.update(terminal_state)
        elif scenario == "new_session_observation":
            state.clear()
            state.update(
                modern_state(
                    session_id="reconnected-session",
                    revision=1,
                    food=18,
                    inventory={**objective_inventory, "oak_log": 1},
                )
            )
        receipt_observation = terminal_state
        if scenario == "terminal_new_session_old_current":
            receipt_observation = modern_state(
                session_id="reconnected-session",
                revision=1,
                food=18,
                inventory={**objective_inventory, "oak_log": 1},
            )
        receipt_data = {} if scenario == "old_dispatch_state_with_mismatched_receipt_baseline" else {
            "observation": receipt_observation
        }
        return ActionStatusResult(
            query_action_id,
            "succeeded",
            "Bridge 已确认终态",
            data=receipt_data,
        )

    manager = RunManager(
        dispatch,
        lambda: state,
        lambda text: asyncio.sleep(0),
        store,
        runs_dir=tmp_path / "runs",
        action_status=action_status,
        state_age_provider=lambda: 0.0,
    )

    await manager.resume(task.id)
    status = await manager.wait()

    final_state = store.load_goal_state(task.id)
    assert status["goal_status"] == expected_status
    assert status_queries == [action_id]
    assert dispatches == []
    assert final_state["deadline_at"] == deadline_at
    assert final_state["method_index"] == 0
    assert final_state["counters"] == counters
    if expect_pending:
        assert final_state["pending_action"]["action_id"] == pending["action_id"]
        assert final_state["pending_action"]["session_id"] == pending["session_id"]
        assert final_state["pending_action"]["revision"] == pending["revision"]
        if scenario == "old_dispatch_state_with_mismatched_receipt_baseline":
            assert final_state["pending_action"]["terminal_receipt_baseline"] == {
                "session_id": "reconnected-session",
                "revision": 1,
            }
        elif scenario != "terminal_new_session_old_current":
            assert final_state["pending_action"]["terminal_receipt_baseline"] == {
                "session_id": "paper-session",
                "revision": terminal_state["revision"],
            }
        assert final_state["recovery"]["needs_reconcile"] is True
        assert not any(
            event["kind"] == "pending_action_reconciled" for event in store.events(task.id)
        )
    else:
        assert final_state["pending_action"] is None
        assert final_state["status"] == "done"
    await manager.close()
    store.close()


@pytest.mark.asyncio
async def test_same_session_terminal_receipt_without_observation_waits_for_later_revision(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S0", "S0")
    state = modern_state(session_id="paper-session", revision=21)
    queries: list[str] = []

    async def action_status(action_id: str):
        queries.append(action_id)
        return ActionStatusResult(action_id, "succeeded", "terminal receipt without observation")

    supervisor = GoalSupervisor(
        GOALS["S0"], store, lambda *args, **kwargs: asyncio.sleep(0), lambda: state,
        action_status=action_status,
    )
    supervisor.task_id = task.id
    supervisor.state = supervisor._new_state()
    supervisor.state["deadline_at"] = time.time() + 600
    supervisor.state["counters"]["actions"] = 4
    supervisor.state["pending_action"] = {
        "action_id": "same-session-no-observation",
        "tool": "collect_blocks",
        "method_key": "plan:s0:0",
        "effect_class": "replan",
        "expected_condition": {"type": "always"},
        "session_id": "paper-session",
        "revision": 20,
        "status": "unknown",
    }
    supervisor.state["recovery"].update({"needs_reconcile": True, "reason": "explicit_resume"})
    deadline = supervisor.state["deadline_at"]
    counters = dict(supervisor.state["counters"])

    assert not await supervisor._reconcile_pending(state)
    assert supervisor.state["pending_action"]["action_id"] == "same-session-no-observation"
    assert supervisor.state["pending_action"]["terminal_receipt_baseline"] == {
        "session_id": "paper-session",
        "revision": 21,
    }
    assert supervisor.state["deadline_at"] == deadline
    assert supervisor.state["counters"] == counters

    state["revision"] = 22
    assert await supervisor._reconcile_pending(state)
    assert supervisor.state["pending_action"] is None
    assert queries == ["same-session-no-observation", "same-session-no-observation"]
    store.close()


@pytest.mark.asyncio
async def test_same_session_terminal_receipt_without_observation_resumes_after_new_revision(tmp_path):
    store = TaskStore(tmp_path / "resume-tasks.db")
    store.initialize()
    task = store.create_task("S0", "S0")
    state = modern_state(
        session_id="paper-session",
        revision=21,
        inventory={"wooden_pickaxe": 1, "crafting_table": 1},
    )
    queries: list[str] = []
    dispatches: list[str] = []

    async def dispatch(tool: str, arguments: dict, **kwargs):
        dispatches.append(tool)
        raise AssertionError("resume must reconcile the existing action before dispatch")

    async def action_status(action_id: str):
        queries.append(action_id)
        return ActionStatusResult(action_id, "succeeded", "terminal receipt without observation")

    seed_supervisor = GoalSupervisor(GOALS["S0"], store, dispatch, lambda: state)
    saved = seed_supervisor._new_state()
    saved.update(
        {
            "status": "paused_by_user",
            "deadline_at": time.time() + 600,
            "method_index": 0,
            "counters": {
                **saved["counters"],
                "actions": 4,
                "attempts": {"plan:s0:0": 1},
                "method_failures": {"plan:s0:0": 0},
                "transport_recoveries": 2,
                "transport_recovery_action_ids": ["old-recovery-1", "old-recovery-2"],
            },
            "pending_action": {
                "action_id": "same-session-no-observation",
                "tool": "collect_blocks",
                "method_key": "plan:s0:0",
                "effect_class": "replan",
                "expected_condition": {"type": "always"},
                "session_id": "paper-session",
                "revision": 20,
                "status": "unknown",
            },
            "recovery": {
                "needs_reconcile": True,
                "reason": "user_stop",
                "baseline_session_id": "paper-session",
                "baseline_revision": 20,
            },
        }
    )
    store.save_goal_state(task.id, saved)
    store.set_status(task.id, "cancelled")
    deadline = saved["deadline_at"]
    counters = dict(saved["counters"])
    manager = RunManager(
        dispatch,
        lambda: state,
        lambda text: asyncio.sleep(0),
        store,
        runs_dir=tmp_path / "runs",
        action_status=action_status,
        state_age_provider=lambda: 0.0,
    )

    await manager.resume(task.id)
    first = await manager.wait()
    after_first = store.load_goal_state(task.id)
    assert first["goal_status"] == "waiting"
    assert after_first["pending_action"]["action_id"] == "same-session-no-observation"
    assert after_first["pending_action"]["terminal_receipt_baseline"] == {
        "session_id": "paper-session",
        "revision": 21,
    }
    assert after_first["deadline_at"] == deadline
    assert after_first["counters"] == counters
    assert after_first["method_index"] == 0
    assert dispatches == []

    state["revision"] = 22
    await manager.resume(task.id)
    second = await manager.wait()

    assert second["goal_status"] == "done"
    assert queries == ["same-session-no-observation", "same-session-no-observation"]
    assert dispatches == []
    after_second = store.load_goal_state(task.id)
    assert after_second["pending_action"] is None
    assert after_second["deadline_at"] == deadline
    assert after_second["counters"] == counters
    await manager.close()
    store.close()


@pytest.mark.asyncio
async def test_foreign_session_terminal_receipt_replans_eat_from_fresh_observation(tmp_path):
    store = TaskStore(tmp_path / "foreign-receipt-replan.db")
    store.initialize()
    task = store.create_task("S5 reconnect", "S5")
    current = modern_state(session_id="new-session", revision=4, food=15)

    async def action_status(action_id: str):
        return ActionStatusResult(
            action_id,
            "succeeded",
            "receipt from unrelated session",
            data={
                "observation": modern_state(
                    session_id="receipt-session",
                    revision=12,
                    food=14,
                )
            },
        )

    supervisor = GoalSupervisor(
        GOALS["S5"], store, lambda *_args, **_kwargs: None, lambda: current,
        action_status=action_status,
    )
    supervisor.task_id = task.id
    supervisor.state = supervisor._new_state()
    supervisor.state["pending_action"] = {
        "action_id": "eat-old-session",
        "tool": "eat_if_hungry",
        "method_key": "s5:eat",
        "effect_class": "replan",
        "expected_condition": {"type": "food", "min": 15},
        "session_id": "71dc-old-session",
        "revision": 10,
        "receipt_confirmed": False,
    }
    supervisor.state["recovery"].update(
        {"needs_reconcile": True, "baseline_session_id": "71dc-old-session", "baseline_revision": 10}
    )

    resolved = await supervisor._reconcile_pending(current)

    assert resolved is True
    assert supervisor.state["pending_action"] is None
    history = supervisor.state["action_history"][-1]
    assert history["status"] == "unknown_reconciled_from_observation"
    assert history["receipt_confirmed"] is False
    assert history["untrusted_terminal_receipt"]["status"] == "succeeded"
    assert history["untrusted_terminal_receipt"]["data"]["observation"]["session_id"] == "receipt-session"
    store.close()


@pytest.mark.asyncio
async def test_foreign_session_terminal_receipt_still_blocks_unknown_non_replayable_action(tmp_path):
    store = TaskStore(tmp_path / "foreign-receipt-block.db")
    store.initialize()
    task = store.create_task("S5 reconnect", "S5")
    current = modern_state(session_id="new-session", revision=4)

    async def action_status(action_id: str):
        return ActionStatusResult(
            action_id,
            "succeeded",
            "receipt from unrelated session",
            data={"observation": modern_state(session_id="receipt-session", revision=12)},
        )

    supervisor = GoalSupervisor(
        GOALS["S5"], store, lambda *_args, **_kwargs: None, lambda: current,
        action_status=action_status,
    )
    supervisor.task_id = task.id
    supervisor.state = supervisor._new_state()
    supervisor.state["pending_action"] = {
        "action_id": "portal-old-session",
        "tool": "nether_travel",
        "method_key": "s5:portal",
        "effect_class": "non_replayable",
        "expected_condition": {"type": "always"},
        "session_id": "71dc-old-session",
        "revision": 10,
        "receipt_confirmed": False,
    }
    supervisor.state["recovery"].update(
        {"needs_reconcile": True, "baseline_session_id": "71dc-old-session", "baseline_revision": 10}
    )

    resolved = await supervisor._reconcile_pending(current)

    assert resolved is False
    assert supervisor.state["status"] == "blocked"
    assert supervisor.state["unresolved_action"]["action_id"] == "portal-old-session"
    assert supervisor.state["unresolved_action"]["receipt_confirmed"] is False
    assert supervisor.state["action_history"][-1]["untrusted_terminal_receipt"]["status"] == "succeeded"
    store.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("terminal_status", ["dead", "disconnected"])
async def test_dead_or_disconnected_receipt_without_observation_accepts_new_session(
    tmp_path, terminal_status
):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S0", "S0")
    state = modern_state(session_id="reconnected-session", revision=1)

    async def action_status(action_id: str):
        return ActionStatusResult(action_id, terminal_status, "old Bridge session ended")

    supervisor = GoalSupervisor(
        GOALS["S0"], store, lambda *args, **kwargs: asyncio.sleep(0), lambda: state,
        action_status=action_status,
    )
    supervisor.task_id = task.id
    supervisor.state = supervisor._new_state()
    supervisor.state["pending_action"] = {
        "action_id": f"{terminal_status}-without-observation",
        "tool": "collect_blocks",
        "method_key": "plan:s0:0",
        "effect_class": "replan",
        "expected_condition": {"type": "always"},
        "session_id": "old-session",
        "revision": 12,
        "status": "unknown",
    }
    supervisor.state["recovery"].update(
        {"needs_reconcile": True, "reason": "explicit_resume", "baseline_session_id": "old-session", "baseline_revision": 12}
    )

    assert await supervisor._reconcile_pending(state)
    assert supervisor.state["pending_action"] is None
    assert supervisor.state["action_history"][-1]["status"] == terminal_status
    store.close()


def test_s2_partial_shelter_subtracts_all_usable_stock_before_collecting():
    state = modern_state(is_day=False, inventory={"dirt": 15, "cobblestone": 2, "oak_planks": 2, "oak_log": 1},
        shelter={"position": {"x": 0, "y": 64, "z": 0}, "size": 4, "sealed": False, "inside": False, "missing_blocks": 35})
    step = choose_s2_action(state, {})
    assert step.tool == "mine_collect"
    assert step.arguments["count"] == 30
    assert step.verify == {"type": "inventory", "items": {"dirt": 30}}
    state["inventory"]["dirt"] = 30
    assert choose_s2_action(state, {}).tool == "make_shelter"


@pytest.mark.asyncio
async def test_s2_supervisor_reconciles_material_collection_then_builds(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S2", "S2")
    state = modern_state(is_day=False, inventory={"dirt": 15, "cobblestone": 2, "oak_planks": 2, "oak_log": 1},
        shelter={"position": {"x": 0, "y": 64, "z": 0}, "size": 4, "sealed": False, "inside": False, "missing_blocks": 35})
    calls = []
    async def dispatch(tool, arguments, timeout_s=0, action_id="", **kwargs):
        calls.append((tool, dict(arguments)))
        state["revision"] += 1
        if tool == "mine_collect":
            state["inventory"]["dirt"] = arguments["count"]
            return ActionResult(action_id, True, status="succeeded", data={"observation": dict(state)})
        raise ActionError("test stop after observing next action", status="failed", action_id=action_id)
    goal = replace(GOALS["S2"], budget=GoalBudget(max_actions=2, max_elapsed_s=60, max_attempts_per_method=1))
    supervisor = GoalSupervisor(goal, store, dispatch, lambda: state)
    result = await supervisor.run(task.id)
    assert calls, result
    assert calls[0] == ("mine_collect", {"block": "dirt", "count": 30, "range": 64})
    assert calls[1][0] == "make_shelter"
    store.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("in_water", [False, True])
async def test_s2_exhausted_sheep_search_relocates_before_new_region_retry(tmp_path, in_water):
    store = TaskStore(tmp_path / "sheep-relocation.db")
    store.initialize()
    task = store.create_task("S2", "S2")
    state = modern_state(food=20, inventory={"white_wool": 2})
    if in_water:
        state["surface_access"] = {"in_water": True, "open_water": True}
    calls = []

    async def dispatch(tool, arguments, timeout_s=0, action_id="", **kwargs):
        calls.append((tool, dict(arguments)))
        if tool == "swim_out":
            state.update(surface_access={"connected_land": True}, position={"x": -8, "y": 64, "z": 0})
            state["revision"] += 1
            return ActionResult(action_id, True, status="succeeded", data={
                "events": ["connected_bank_reached"], "observation": dict(state)})
        if tool == "explore_mining_site":
            assert bool(arguments.get("connected_route")) == in_water
            origin = dict(state["position"])
            state["position"] = {"x": 25, "y": 64, "z": 0}
            state["revision"] += 1
            return ActionResult(action_id, True, status="succeeded", data={
                "observation": dict(state),
                "relocation": {"origin": origin, "destination": dict(state["position"])},
            })
        raise ActionError("测试停止", status="failed", action_id=action_id)

    goal = replace(GOALS["S2"], budget=GoalBudget(max_actions=3 if in_water else 2, max_elapsed_s=60, max_attempts_per_method=3))
    supervisor = GoalSupervisor(goal, store, dispatch, lambda: state)
    saved = supervisor._new_state()
    saved["status"] = "blocked"
    saved["counters"]["attempts"]["s2:hunt_material:wool"] = 3
    saved["counters"]["method_failures"]["s2:hunt_material:wool"] = 3
    if in_water:
        saved["counters"]["method_failures"]["s2:wool_relocate:region0"] = 3
    store.save_goal_state(task.id, saved)
    store.set_status(task.id, "blocked")
    await supervisor.run(task.id, resume=True)
    expected = ["explore_mining_site", "hunt_material"]
    assert [tool for tool, _ in calls] == (["swim_out", *expected] if in_water else expected)
    persisted = store.load_goal_state(task.id)
    assert persisted["s2_wool_search_region"] == 1
    assert persisted["counters"]["method_failures"]["s2:hunt_material:wool"] == 3
    assert state["inventory"]["white_wool"] == 2
    store.close()


@pytest.mark.asyncio
async def test_s2_relocates_for_bed_wood_after_surface_search(tmp_path):
    store = TaskStore(tmp_path / "bed-wood.db")
    store.initialize()
    task = store.create_task("S2", "S2")
    state = modern_state(food=20, inventory={"white_wool": 3, "mutton": 4})
    calls = []

    async def dispatch(tool, arguments, timeout_s=0, *, action_id="", **kwargs):
        calls.append((tool, arguments))
        state["revision"] += 1
        if tool == "mine_collect":
            assert arguments["surface_wood"]
            raise ActionError("当前区域缺木", status="blocked", receipt_confirmed=True, action_id=action_id,
                              data={"observation": dict(state)})
        assert tool == "explore_mining_site"
        origin = state["position"]
        state["position"] = {**origin, "x": origin["x"] + arguments["min_distance"]}
        return ActionResult(action_id, True, status="succeeded", data={
            "observation": dict(state), "relocation": {"origin": origin, "destination": state["position"]}})

    goal = replace(GOALS["S2"], budget=replace(GOALS["S2"].budget, max_actions=4))
    supervisor = GoalSupervisor(goal, store, dispatch, lambda: state)
    await supervisor.run(task.id)
    assert [args.get("range") for _, args in calls] == [64, 128, None, 64]
    assert supervisor.state["counters"]["actions"] == 4
    store.close()


def test_s3_uses_available_fuel_before_seeking_extra_coal():
    state = modern_state(resource_sites={}, inventory={"stone_pickaxe": 1, "furnace": 1,
        "raw_iron": 9, "oak_planks": 12, "coal": 2})
    step = choose_s3_resource_action(state, {})
    assert step is not None and step.tool == "smelt_batch"
    assert step.arguments["fuel"] == "coal"
    state["inventory"].update(coal=0, oak_planks=4)
    search = choose_s3_resource_action(state, {})
    assert search.arguments == {"block": "coal_ore", "count": 16, "minimum_count": 1, "range": 48}
    fallback = choose_s3_resource_action(state, {"s3_coal_search_attempted": True})
    assert fallback.arguments["block"] == "wood_log"


def test_s3_relocation_requires_fresh_observed_progress_and_preserves_budget(tmp_path):
    store = TaskStore(tmp_path / "relocation.db")
    store.initialize()
    supervisor = GoalSupervisor(GOALS["S3"], store, lambda *args, **kwargs: None, lambda: {})
    supervisor.state = supervisor._new_state()
    supervisor.state.update(s3_ore_expose_used=12, s3_ore_no_progress=1, s3_ore_avoid_positions=[{"x": 0, "y": 60, "z": 0}])
    pending = {"tool": "explore_mining_site", "receipt_confirmed": True, "session_id": "world-1", "revision": 10,
               "baseline_position": {"x": 0, "y": 60, "z": 0}, "arguments": {"avoid_positions": [{"x": 0, "y": 60, "z": 0}]}}
    condition = {"type": "s3_mining_relocation", "min_distance": 16}
    state = modern_state(revision=11, position={"x": 20, "y": 60, "z": 0})
    data = {"relocation": {"origin": {"x": 0, "y": 60, "z": 0}, "destination": {"x": 20, "y": 60, "z": 0}}, "observation": dict(state)}
    assert not supervisor._verify_pending_method_condition(condition, modern_state(revision=10), pending, "succeeded", data)[0]
    assert not supervisor._verify_pending_method_condition(condition, state, pending, "failed", data)[0]
    bad = {**data, "observation": {**state, "position": {"x": 2, "y": 60, "z": 0}}}
    assert not supervisor._verify_pending_method_condition(condition, state, pending, "succeeded", bad)[0]
    assert supervisor.state["s3_ore_expose_used"] == 12
    assert supervisor._verify_pending_method_condition(condition, state, pending, "succeeded", data)[0]
    actions = supervisor.state["counters"]["actions"] = 23
    supervisor._advance_after_success(pending, data)
    assert supervisor.state["s3_ore_expose_used"] == 0
    assert supervisor.state["s3_ore_regions"] == 1
    assert supervisor.state["counters"]["actions"] == actions
    assert choose_s3_resource_action(state, supervisor.state).tool == "mine_collect"
    store.close()

@pytest.mark.asyncio
@pytest.mark.parametrize("stage", ["S3", "S4"])
async def test_relocation_execute_reconciles_displacement_and_preserves_total_budget(tmp_path, stage):
    store = TaskStore(tmp_path / "s3_relocation.db")
    store.initialize()
    task = store.create_task(stage, stage)
    state = modern_state(position={"x": 0, "y": 60, "z": 0}, inventory={"raw_iron": 8, "stone_pickaxe": 1})
    async def dispatch(tool, arguments, timeout_s=0, action_id="", **kwargs):
        assert tool == "explore_mining_site"
        state["revision"] += 1
        state["position"] = {"x": 20, "y": 60, "z": 0}
        return ActionResult(action_id, True, status="succeeded", data={
            "relocation": {"origin": {"x": 0, "y": 60, "z": 0}, "destination": dict(state["position"]), "attempted_positions": []},
            "observation": dict(state),
        })
    supervisor = GoalSupervisor(GOALS[stage], store, dispatch, lambda: state)
    supervisor.task_id = task.id
    supervisor.state = supervisor._new_state()
    supervisor.state.update(s3_ore_expose_used=12, s3_ore_no_progress=1)
    supervisor.state["counters"]["actions"] = 23
    step = choose_s3_resource_action(state, supervisor.state)
    if stage == "S4":
        step = StepSpec("换区采木", "explore_mining_site", {"min_distance": 16}, {"type": "s3_wood_relocation", "min_distance": 16}, effect_class="replan")
    result = await supervisor._execute_step(step, f"{stage}:relocate", None)
    assert result == "done", (result, supervisor.state)
    persisted = store.load_goal_state(task.id)
    assert persisted["counters"]["actions"] == 24
    if stage == "S3":
        assert persisted["s3_ore_regions"] == 1
        assert persisted["s3_ore_expose_used"] == 0
        assert persisted["s3_ore_avoid_positions"] == [{"x": 0.0, "y": 60.0, "z": 0.0}]
        assert choose_s3_resource_action(state, persisted).tool == "mine_collect"
    store.close()

def test_s3_confirmed_water_enclosed_stair_relocates_without_repeating_tunnel():
    state = modern_state(position={"x": 2, "y": 58, "z": 83}, inventory={"raw_iron": 8, "stone_pickaxe": 1})
    ledger = {"s3_ore_no_progress": 1, "s3_ore_expose_used": 1,
              "last_s3_mining_failure": {"data": {"reason": "no_safe_stair", "candidates": [{"name": "water"}] * 4}}}
    step = choose_s3_resource_action(state, ledger)
    assert step.tool == "explore_mining_site"
    assert step.arguments["avoid_positions"] == [{"x": 2.0, "y": 58.0, "z": 83.0}]

def test_s3_failed_relocation_persists_attempted_sites_without_reset(tmp_path):
    store = TaskStore(tmp_path / "failed_relocation.db")
    store.initialize()
    task = store.create_task("S3", "S3")
    supervisor = GoalSupervisor(GOALS["S3"], store, lambda *args, **kwargs: None, lambda: {})
    supervisor.task_id = task.id
    supervisor.state = supervisor._new_state()
    supervisor.state.update(s3_ore_expose_used=12, s3_ore_no_progress=1)
    pending = {"action_id": "fail", "tool": "explore_mining_site", "receipt_confirmed": True, "method_key": "s3:ore_relocate:0"}
    attempted = [{"x": 20, "y": 60, "z": 5}, {"x": 30, "y": 61, "z": 5}]
    supervisor._record_known_terminal_failure(pending, "blocked", modern_state(), {"relocation": {"attempted_positions": attempted}}, "不可达")
    supervisor._save()
    saved = store.load_goal_state(task.id)
    assert saved["s3_ore_avoid_positions"] == attempted
    assert saved["s3_ore_expose_used"] == 12
    assert saved["s3_ore_no_progress"] == 1
    store.close()

def test_s3_retries_ore_in_a_distant_respawn_area_and_retains_the_old_budget():
    state = modern_state(position={"x": 95, "y": 55, "z": 20}, inventory={"stone_pickaxe": 1})
    before = {**state, "session_id": "old", "position": {"x": 15, "y": 47, "z": 139}}
    ledger = {"s3_ore_no_progress": 1, "s3_ore_expose_used": 12, "s3_relocation_failed": True,
              "last_s3_mining_failure": {"data": {"observation": before}},
              "counters": {"method_failures": {"s3:ore_relocate:0": 3}}}
    assert choose_s3_resource_action(state, ledger).tool == "mine_collect"
    assert choose_s3_resource_action(state, ledger).tool == "mine_collect"
    assert ledger["s3_ore_regions"] == 1 and ledger["counters"]["method_failures"]["s3:ore_relocate:0"] == 3


def test_s3_relocation_failure_returns_to_known_surface_once():
    state = modern_state(position={"x": 2, "y": 58, "z": 83}, is_day=True,
        inventory={"raw_iron": 8, "stone_pickaxe": 1},
        shelter={"position": {"x": 4, "y": 71, "z": 97}, "size": 4})
    ledger = {"s3_ore_no_progress": 1, "s3_ore_expose_used": 12, "s3_relocation_failed": True}
    route = choose_s3_resource_action(state, ledger)
    assert route.tool == "goto" and route.arguments == {"x": 4, "y": 72, "z": 97}
    assert "s3_relocation_surface_return_used" not in ledger
    assert choose_s3_resource_action(state, ledger).tool == "goto"
    ledger["s3_relocation_surface_return_used"] = True
    next_step = choose_s3_resource_action(state, ledger)
    assert next_step.tool == "explore_mining_site"
    assert ledger["s3_ore_expose_used"] == 12


def test_wood_search_climbs_out_of_a_dark_failed_relocation(tmp_path):
    state = modern_state(position={"x": 82, "y": 55, "z": 18}, inventory={"iron_pickaxe": 1},
                         surface_access={"sky_light": 1, "exit": None}, is_day=True)
    supervisor = GoalSupervisor(GOALS["S3"], TaskStore(tmp_path / "tasks.db"), None, lambda: state)
    key = "s3:wood_search:overworld:2:6:0:wood_log"
    supervisor.state = {"counters": {"method_failures": {key: 1, key + ":wide": 1, key + ":relocate": 3}}}
    request = StepSpec("采木", "mine_collect", {"block": "wood_log"}, {})
    step, method = supervisor._expand_wood_search(request, state, key)
    assert (step.tool, step.verify, method) == ("strip_mine", {"type": "min_height", "y": 61}, key + ":ascent:55")
    state["surface_access"]["sky_light"] = 15
    assert supervisor._expand_wood_search(request, state, key)[0].tool == "explore_mining_site"
    state["surface_access"].update(connected_land=False, exit={"x": 82, "y": 62, "z": 18})
    state["inventory"] = {}
    step, method = supervisor._expand_wood_search(request, state, key)
    assert step.tool == "strip_mine" and step.arguments["clear_by_hand"]
    assert step.verify == {"type": "min_height", "y": 57}
    state["surface_access"]["connected_land"] = True
    assert supervisor._expand_wood_search(request, state, key)[0].tool == "explore_mining_site"


def test_wood_relocation_at_attempt_limit_replans_toward_observed_tree(tmp_path):
    position = {"x": -31, "y": 64, "z": 91}
    state = modern_state(position=position, inventory={}, surface_access={"sky_light": 15, "connected_land": True}, is_day=True)
    supervisor = GoalSupervisor(GOALS["S3"], TaskStore(tmp_path / "tasks.db"), None, lambda: state)
    key = "s3:wood_search:overworld:-1:8:2:land:wood_log"
    connected = key + ":relocate:connected"
    trunk = {"x": -50, "y": 63, "z": 11}
    survey = {"origin": position, "dry_ground_extent": 3.7}
    supervisor.state = {"counters": {"method_failures": {key + ":wide": 1, key + ":relocate": 3, connected: 3}},
                        "action_history": [
                            {"tool": "mine_collect", "receipt_confirmed": True, "arguments": {"surface_wood": True},
                             "result_data": {"surface_trunk": trunk}, "terminal_observation": {"dimension": state["dimension"]}},
                            {"tool": "explore_mining_site", "method_key": connected, "status": "blocked", "receipt_confirmed": True,
                             "expected_condition": {"type": "s3_wood_relocation"}, "result_data": {"relocation": survey}}]}
    assert supervisor._retry_or_block_method(connected, "窄岸") == "retry"
    request = StepSpec("采木", "mine_collect", {"block": "wood_log"}, {})
    step, _ = supervisor._expand_wood_search(request, state, key)
    assert step.tool == "strip_mine" and step.arguments["direction"] == "north"
    assert supervisor._method_failure_count(connected) == 3
    survey["dry_ground_extent"] = 40
    step, _ = supervisor._expand_wood_search(request, state, key)
    assert step.tool == "explore_mining_site" and step.arguments["toward"] == trunk
    state["position"] = {**position, "y": 68}
    step, new_key = supervisor._expand_wood_search(request, state, key)
    assert step.tool == "explore_mining_site" and new_key == connected + ":site:-31:68:91"
    supervisor.state["action_history"][-1]["status"] = "failed"
    assert supervisor._expand_wood_search(request, state, key)[1] == new_key
    tree_attempt = supervisor.state["action_history"][0]
    tree_attempt.update(status="blocked", result_detail="距离 8.9 格，太远走不过去")
    tree_attempt["terminal_observation"]["position"] = {**trunk, "y": trunk["y"] - 7}
    step, other_trees = supervisor._expand_wood_search(request, state, key)
    assert step.tool == "mine_collect" and step.arguments["avoid_positions"] == [trunk]
    supervisor.state["counters"]["method_failures"][other_trees] = 1
    step, _ = supervisor._expand_wood_search(request, state, key)
    assert step.tool == "explore_mining_site" and "toward" not in step.arguments


def test_s5_fortress_scout_can_exit_a_portal_in_a_rock_wall(tmp_path):
    supervisor = GoalSupervisor(GOALS["S5"], TaskStore(tmp_path / "tasks.db"), None, lambda: {})
    key = "s5:raid_fortress:default:chunk:0:1"
    origin = {"x": 8, "y": 81, "z": 21}
    evidence = {"route": {"origin": origin, "attempted_waypoints": 0}}
    supervisor.state = {"counters": {"method_failures": {key: 3}}, "action_history": [
        {"method_key": key, "status": "blocked", "result_data": {"fortress_evidence": evidence}}]}
    state = modern_state(position=origin, dimension="the_nether", nether_portal_bank="north",
                         health=20, food=18, inventory={"iron_pickaxe": 1})
    scout = StepSpec("侦察", "raid_fortress", {"scout_only": True}, {})
    step, method = supervisor._fortress_portal_exit(scout, state, key)
    assert (step.tool, step.arguments, method) == ("strip_mine", {"rise": 4, "direction": "north"}, key + ":bank:north:81")
    state.update(position={**origin, "y": 85}, nether_portal_bank=None)
    assert supervisor._fortress_portal_exit(scout, state, key) == (scout, key + ":layer:21")


def test_s5_repeated_lower_gallery_checks_an_unsurveyed_height(tmp_path):
    supervisor = GoalSupervisor(GOALS["S5"], TaskStore(tmp_path / "tasks.db"), None, lambda: {})
    origin = {"x": -4, "y": 58, "z": -140}
    key = "s5:raid_fortress:default:chunk:-1:-9"
    def receipt(y, z):
        route = {"origin": {**origin, "y": y, "z": z}, "visited": [origin]}
        return {"tool": "raid_fortress", "method_key": key, "status": "blocked",
                "receipt_confirmed": True, "result_data": {"fortress_evidence": {"route": route}}}
    history = [receipt(58, z) for z in (-123, -136, -142, -147)]
    supervisor.state = {"action_history": history}
    state = modern_state(position=origin, dimension="the_nether", health=20, food=20, inventory={"diamond_pickaxe": 1})
    scout = StepSpec("侦察", "raid_fortress", {"surveyed": [{"x": -4, "z": -11}]}, {})
    step, method = supervisor._fortress_portal_exit(scout, state, key)
    assert step.arguments == {"rise": 6} and method.endswith(":ascend")
    supervisor.state["counters"] = {"method_failures": {method: 1}}
    history.append({"method_key": method, "status": "failed", "receipt_confirmed": True,
                    "result_data": {"reason": "nearby_hostiles"}})
    assert supervisor._fortress_portal_exit(scout, state, key)[1] != method + ":threat_cleared"
    state["nether_mining_hostiles"] = []
    assert supervisor._fortress_portal_exit(scout, state, key)[1] == method + ":threat_cleared"
    history.append(receipt(64, -138))
    step, method = supervisor._fortress_portal_exit(scout, state, key)
    assert "rise" not in step.arguments


def test_s5_exhausted_survey_backtracks_only_to_confirmed_nether_waypoints(tmp_path):
    supervisor = GoalSupervisor(GOALS["S5"], TaskStore(tmp_path / "tasks.db"), None, lambda: {})
    origin = {"x": -5, "y": 59, "z": -132}
    target = {"x": -9, "y": 58, "z": -146}
    key = "s5:raid_fortress:default:chunk:-1:-9"
    gallery = key + ":gallery:-1:14:-17"
    route = {"origin": origin, "dimension": "minecraft:the_nether", "visited": [target]}
    entry = {"tool": "raid_fortress", "method_key": gallery, "receipt_confirmed": True, "status": "blocked",
             "result_data": {"fortress_evidence": {"route": route}}}
    supervisor.state = {"counters": {"method_failures": {gallery: 3}}, "action_history": [entry]}
    state = modern_state(position=origin, dimension="the_nether", inventory={})
    scout = StepSpec("侦察", "raid_fortress", {"surveyed": [{"x": -4, "z": -11}]}, {})
    step, method = supervisor._fortress_portal_exit(scout, state, key)
    assert step.tool == "goto" and step.arguments == {**target, "nether_safe": True}
    supervisor.state["action_history"].append({"tool": "goto", "method_key": method, "status": "failed"})
    assert supervisor._fortress_portal_exit(scout, state, key)[0] == scout


def test_s5_exhausted_connected_survey_opens_a_gallery_then_scouts_from_new_ground(tmp_path):
    supervisor = GoalSupervisor(GOALS["S5"], TaskStore(tmp_path / "tasks.db"), None, lambda: {})
    key = "s5:raid_fortress:default:chunk:-2:4"
    origin = {"x": -24, "y": 83, "z": 65}
    route = {"origin": origin, "attempted_waypoints": 0}
    supervisor.state = {"action_history": [{"tool": "raid_fortress", "method_key": key + ":follow_cells",
        "receipt_confirmed": True, "status": "blocked", "result_data": {"fortress_evidence": {"route": route}}}]}
    state = modern_state(position=origin, dimension="the_nether", health=20, food=20, inventory={"diamond_pickaxe": 1})
    scout = StepSpec("侦察", "raid_fortress", {"scout_only": True, "surveyed": [{"x": -24, "z": 54}]}, {})
    step, method = supervisor._fortress_portal_exit(scout, state, key)
    assert step.tool == "strip_mine" and step.arguments["direction"] == "south"
    assert method.endswith(":south")
    previous = {"tool": "strip_mine", "receipt_confirmed": True, "status": "failed",
                "result_data": {"nether_passages": {"origin": origin, "lengths": {"west": 2}}},
                "terminal_observation": {"session_id": state["session_id"]}}
    supervisor.state["action_history"].append(previous)
    alternative, _ = supervisor._fortress_portal_exit(scout, state, key)
    assert alternative.arguments["length"] == 2 and alternative.arguments["direction"] == "west"
    previous["terminal_observation"]["session_id"] = "old-session"
    assert supervisor._fortress_portal_exit(scout, state, key)[0] == step
    state["position"] = step.verify["target"]
    step, method = supervisor._fortress_portal_exit(scout, state, key)
    assert step == scout and ":gallery:" in method
    supervisor.state["counters"] = {"method_failures": {method: 2}}
    step, method = supervisor._fortress_portal_exit(scout, state, key)
    assert method.endswith(":descend") and step.arguments["shaft"] == 6
    state["position"]["y"] -= 6
    assert supervisor.verifier.check(step.verify, state)[0]
    state["dimension"] = "overworld"
    assert not supervisor.verifier.check(step.verify, state)[0]


def test_s4_flooded_descent_requires_a_confirmed_same_session_safety_receipt(tmp_path):
    supervisor = GoalSupervisor(GOALS["S4"], TaskStore(tmp_path / "tasks.db"), None, lambda: {})
    pos = {"x": 101, "y": 17, "z": 9}
    receipt = modern_state(revision=41, ready=False, position=pos)
    entry = {"action_id": "shaft", "tool": "strip_mine", "status": "preempted", "receipt_confirmed": True,
             "session_id": "world-1", "revision": 35, "expected_condition": {"type": "s4_depth_reached", "target_y": 16},
             "result_data": {"preempt_cause": "safety_priority", "observation": receipt,
                             "safety_interruption": {"event": "low_oxygen", "safety_action_id": "air", "position": pos}}}
    supervisor.state = {"action_history": [entry], "s4_descent_segments": 3}
    current = modern_state(session_id="after-restart", revision=4)
    assert supervisor._recover_s4_interrupted_shaft(entry, current)
    assert supervisor.state["s4_flooded_shaft"]["position"] == pos
    assert supervisor.state["s4_descent_segments"] == 3
    entry["result_data"]["observation"] = {**receipt, "session_id": "wrong"}
    assert not supervisor._recover_s4_interrupted_shaft(entry, current)


def test_s4_flood_bypass_requires_a_dry_destination_away_from_the_water(tmp_path):
    supervisor = GoalSupervisor(GOALS["S4"], TaskStore(tmp_path / "tasks.db"), None, lambda: {})
    rule = {"type": "s4_water_bypass", "hazard": {"x": 101, "y": 17, "z": 9}}
    pending = {"session_id": "world-1", "revision": 1, "receipt_confirmed": True,
               "baseline_position": {"x": 101, "y": 17, "z": 7}}
    state = modern_state(revision=2, position={"x": 109, "y": 17, "z": 7}, surface_access={"sky_light": 0})
    check = supervisor._verify_pending_method_condition
    assert check(rule, state, pending, "succeeded", {"observation": state})[0]
    state["surface_access"]["in_water"] = True
    assert not check(rule, state, pending, "succeeded", {"observation": state})[0]
    state.update(position={"x": 105, "y": 17, "z": 9}, surface_access={"sky_light": 0})
    assert not check(rule, state, pending, "succeeded", {"observation": state})[0]


async def test_s3_horizontal_arrival_below_exit_switches_to_stairs(tmp_path):
    store = TaskStore(tmp_path / "exit.db")
    store.initialize()
    task = store.create_task("S3", "S3")
    state = modern_state(is_day=True, food=20, position={"x": 86, "y": 52, "z": 20},
                         surface_access={"sky_light": 0, "exit": {"x": 86, "y": 66, "z": 20}},
                         shelter={"position": {"x": 28, "y": 61, "z": 124}, "size": 4, "inside": False},
                         inventory={"iron_pickaxe": 1, "iron_sword": 1, "bucket": 1, "iron_ingot": 1,
                                    "oak_planks": 3, "porkchop": 4, "crafting_table": 1})
    calls = []

    async def dispatch(tool, arguments, timeout_s=0, **kwargs):
        calls.append(tool)
        state["revision"] += 1
        if tool == "strip_mine":
            assert arguments == {"rise": 6}
            state["position"]["y"] += arguments["rise"]
            state["inventory"]["shield"] = 1
        return ActionResult(action_id=kwargs["action_id"], ok=True, status="succeeded", detail="完成",
                            data={"observation": dict(state)})

    supervisor = GoalSupervisor(GOALS["S3"], store, dispatch, lambda: state)
    result = await asyncio.wait_for(supervisor.run(task.id), 8)
    assert result["status"] == "done", result
    assert calls == ["goto", "strip_mine"]
    store.close()


@pytest.mark.asyncio
async def test_s3_surface_recovery_stale_admission_does_not_consume_route(tmp_path):
    store = TaskStore(tmp_path / "stale_surface.db")
    store.initialize()
    task = store.create_task("S3", "S3")
    state = modern_state(revision=2, is_day=True, position={"x": 2, "y": 58, "z": 83},
                         inventory={"raw_iron": 8, "stone_pickaxe": 1},
                         shelter={"position": {"x": 4, "y": 71, "z": 97}, "size": 4})
    supervisor = GoalSupervisor(GOALS["S3"], store, lambda *a, **k: None, lambda: state)
    supervisor.task_id = task.id
    supervisor.state = supervisor._new_state()
    supervisor.state.update(s3_ore_no_progress=1, s3_ore_expose_used=12, s3_relocation_failed=True)
    assert choose_s3_resource_action(state, supervisor.state).tool == "goto"
    pending = {"action_id": "old", "tool": "goto", "session_id": "world-1", "revision": 1}
    data = {"admission": {"started": False, "retryable": True, "reason": "stale_observation"}}
    assert await supervisor._handle_admission_rejection(pending, data, "s3:ore_return_surface:0") == "retry"
    assert choose_s3_resource_action(state, supervisor.state).tool == "goto"
    assert "s3_relocation_surface_return_used" not in store.load_goal_state(task.id)
    store.close()

def test_s3_low_oxygen_preemption_requires_fresh_safety_then_relocates_even_if_iron_gained(tmp_path):
    store = TaskStore(tmp_path / "low_oxygen.db")
    store.initialize()
    task = store.create_task("S3", "S3")
    state = modern_state(revision=8, position={"x": 20, "y": 57, "z": 63},
                         inventory={"raw_iron": 9, "stone_pickaxe": 1})
    supervisor = GoalSupervisor(GOALS["S3"], store, lambda *a, **k: None, lambda: state)
    supervisor.task_id = task.id
    supervisor.state = supervisor._new_state()
    pending = {"action_id": "mine", "tool": "mine_collect", "status": "preempted", "receipt_confirmed": True,
               "session_id": "world-1", "revision": 8, "baseline_raw_iron": 8, "effect_class": "replan",
               "arguments": {"block": "iron_ore", "count": 9}, "expected_condition": {"type": "inventory", "items": {"raw_iron": 9}}}
    data = {"preempt_cause": "safety_priority", "safety_interruption": {"event": "low_oxygen", "position": {"x": 20, "y": 55, "z": 63}, "oxygen": 8, "safety_action_id": "oxygen"}}
    assert not supervisor._resolve_interrupted_action(pending, "preempted", state, data)
    assert not supervisor.state.get("s3_low_oxygen_relocation_required")
    state["revision"] = 9
    assert supervisor._resolve_interrupted_action(pending, "preempted", state, data)
    assert supervisor.state["s3_low_oxygen_relocation_required"] is True
    assert supervisor.state["s3_ore_avoid_positions"] == [{"x": 20.0, "y": 55.0, "z": 63.0}]
    assert not supervisor.state["counters"]["method_failures"]
    assert choose_s3_resource_action(state, supervisor.state).tool == "explore_mining_site"
    store.close()


def test_s3_unrelated_preemption_does_not_mark_water_hazard(tmp_path):
    store = TaskStore(tmp_path / "other_preemption.db")
    store.initialize()
    task = store.create_task("S3", "S3")
    state = modern_state(revision=9, inventory={"raw_iron": 8})
    supervisor = GoalSupervisor(GOALS["S3"], store, lambda *a, **k: None, lambda: state)
    supervisor.task_id = task.id
    supervisor.state = supervisor._new_state()
    pending = {"action_id": "mine", "tool": "mine_collect", "receipt_confirmed": True, "session_id": "world-1", "revision": 8,
               "effect_class": "replan", "arguments": {"block": "iron_ore"}, "expected_condition": {"type": "inventory", "items": {"raw_iron": 9}}}
    assert supervisor._resolve_interrupted_action(pending, "preempted", state, {"preempt_cause": "player_priority"})
    assert not supervisor.state.get("s3_low_oxygen_relocation_required")
    store.close()

@pytest.mark.parametrize("tool,args,effect", [("explore_mining_site", {}, "replan"), ("strip_mine", {"target": "iron_ore"}, "non_replayable")])
def test_s3_water_preempts_exploration_or_strip_and_remembers_attempted_sites(tmp_path, tool, args, effect):
    store = TaskStore(tmp_path / "water_interrupt.db")
    store.initialize()
    task = store.create_task("S3", "S3")
    state = modern_state(revision=9, position={"x": 20, "y": 57, "z": 63})
    supervisor = GoalSupervisor(GOALS["S3"], store, lambda *a, **k: None, lambda: state)
    supervisor.task_id = task.id
    supervisor.state = supervisor._new_state()
    pending = {"action_id": "work", "tool": tool, "receipt_confirmed": True, "session_id": "world-1", "revision": 8,
               "effect_class": effect, "arguments": args, "expected_condition": {"type": "always"}}
    data = {"safety_interruption": {"event": "low_oxygen", "position": {"x": 20, "y": 55, "z": 63}, "oxygen": 8, "safety_action_id": "oxygen"},
            "relocation": {"attempted_positions": [{"x": 40, "y": 60, "z": 63}]}}
    assert supervisor._resolve_interrupted_action(pending, "preempted", state, data)
    assert supervisor.state["s3_low_oxygen_relocation_required"] is True
    assert supervisor.state["s3_ore_avoid_positions"][-1] == {"x": 40.0, "y": 60.0, "z": 63.0}
    assert choose_s3_resource_action(state, supervisor.state).tool == "explore_mining_site"
    store.close()

def test_s3_water_relocation_does_not_bypass_survival_emergencies():
    from voxkin.agent.goal_supervisor import _s3_relocation_emergency
    assert _s3_relocation_emergency(modern_state(health=10, food=20))
    assert _s3_relocation_emergency(modern_state(health=20, food=7))
    assert _s3_relocation_emergency(modern_state(health=20, food=20, danger=True))
    assert not _s3_relocation_emergency(modern_state(health=20, food=12))

def test_s3_post_relocation_mine_avoids_only_confirmed_water_hazards():
    state = modern_state(position={"x": 40, "y": 60, "z": 63}, inventory={"raw_iron": 8, "stone_pickaxe": 1})
    hazard = {"x": 20, "y": 55, "z": 63}
    ledger = {"s3_mining_hazards": [hazard], "s3_ore_avoid_positions": [hazard, {"x": 50, "y": 60, "z": 63}]}
    step = choose_s3_resource_action(state, ledger)
    assert step.tool == "mine_collect"
    assert step.arguments["avoid_positions"] == [hazard]
    assert step.verify == {"type": "inventory", "items": {"raw_iron": 9}}
