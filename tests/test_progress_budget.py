import asyncio
from dataclasses import asdict, replace
import time

import pytest

from voxkin.agent.goal_supervisor import GoalSupervisor
from voxkin.agent.goals import GOALS, goal_for_stage
from voxkin.agent.progress_budget import observe_progress, record_action_progress
from voxkin.agent.tasks import TaskStore
from voxkin.bridge.protocol import ActionResult


def world(revision=1, *, x=0, inventory=None):
    return {
        "session_id": "dev", "revision": revision, "ready": True, "alive": True, "health": 20, "food": 20,
        "dimension": "overworld", "position": {"x": x, "y": 64, "z": 0},
        "inventory": inventory or {}, "executor": {"active_action_id": None, "safety_active": False},
    }


def adaptive_state(stage="S3"):
    budget = goal_for_stage(stage, budget_mode="adaptive").budget
    return {"stage": stage, "budget": asdict(budget), "counters": {"actions": 0}, "deadline_at": 1800.0}


def test_only_explicit_adaptive_mode_changes_stage_budget():
    for stage, fixed in GOALS.items():
        assert goal_for_stage(stage) is fixed
        assert goal_for_stage(stage, budget_mode="acceptance") is fixed
        assert fixed.budget.max_actions == (48 if stage == "S2" else 120)
        assert fixed.budget.max_elapsed_s == (1800 if stage == "S2" else 14400)
        adaptive = goal_for_stage(stage, budget_mode="adaptive")
        assert adaptive.acceptance == fixed.acceptance
        assert adaptive.budget.max_actions == 24
        assert adaptive.budget.max_attempts_per_method == fixed.budget.max_attempts_per_method
    with pytest.raises(ValueError):
        goal_for_stage("S0", budget_mode="unknown")


def test_only_fresh_material_highs_extend_the_idle_window():
    state = adaptive_state()
    observe_progress(state, world(inventory={"raw_iron": 2}), 10)
    timer = state["progress_watchdog"]
    state["counters"]["actions"] = 21
    observe_progress(state, world(2, inventory={"raw_iron": 3}), 100)
    assert timer["action_limit"] == 45
    assert state["deadline_at"] == 1900
    for report in (
        world(2, inventory={"raw_iron": 4}), world(3), world(4, inventory={"raw_iron": 3}),
        dict(world(5, inventory={"raw_iron": 4}), alive=False),
        world(6, inventory={"feather": 64}),
    ):
        observe_progress(state, report, 110)
    assert timer["action_limit"] == 45
    assert state["deadline_at"] == 1900
    state["counters"]["actions"] = 40
    observe_progress(state, world(7, inventory={"raw_iron": 100}), 120)
    observe_progress(state, world(8, inventory={"raw_iron": 101}), 140)
    assert timer["action_limit"] == 64
    assert state["deadline_at"] == 1920


def test_region_jitter_revisits_and_endless_wandering_are_bounded():
    state = adaptive_state()
    observe_progress(state, world(x=31), 1)
    timer = state["progress_watchdog"]
    for revision, x in enumerate((32, 70, 31, 70, 110, 160, 220, 260), 2):
        state["counters"]["actions"] = revision
        observe_progress(state, world(revision, x=x), revision)
    assert timer["exploration_credits"] == 3
    assert len(timer["regions"]) == 4
    assert timer["action_limit"] == 7 + 24
    observe_progress(state, world(10, x=260, inventory={"raw_iron": 1}), 20)
    assert timer["exploration_credits"] == 0
    assert timer["last_progress"] == "milestone:raw_iron"


def test_late_game_search_evidence_keeps_total_even_beyond_120_actions():
    state = adaptive_state("S6")
    observe_progress(state, world(), 1)
    for revision, layers in enumerate(range(8, 57, 8), 2):
        state["counters"]["actions"] += 20
        state["stronghold_search"] = {"phase": "descend", "descent": {"layers_completed": layers}}
        observe_progress(state, world(revision), revision)
    timer = state["progress_watchdog"]
    assert state["counters"]["actions"] == 140
    assert timer["action_limit"] == 164
    state["stronghold_search"]["descent"]["layers_completed"] = 8
    observe_progress(state, world(10), 100)
    assert state["deadline_at"] == 1808


def test_method_credit_requires_a_confirmed_fresh_physical_search():
    state = adaptive_state()
    observe_progress(state, world(), 1)
    state["counters"]["actions"] = 20
    pending = {"tool": "explore_mining_site", "session_id": "dev", "revision": 3,
               "expected_condition": {"type": "s3_wood_relocation"}}
    data = {"observation": world(4), "attempted_positions": [{"x": 4, "y": 64, "z": 0}]}
    timer = state["progress_watchdog"]
    record_action_progress(state, pending, data, 10)
    pending["receipt_confirmed"] = True
    for invalid in (dict(data, observation=world(3)), dict(data, attempted_positions=[{}]),
                    dict(data, observation=dict(world(4), session_id="other"))):
        record_action_progress(state, pending, invalid, 10)
    assert timer["action_limit"] == 24
    record_action_progress(state, pending, data, 11)
    record_action_progress(state, dict(pending, method_key="same:site:999"), data, 12)
    assert timer["exploration_credits"] == 1
    assert timer["action_limit"] == 44
    assert state["deadline_at"] == 1811


@pytest.mark.asyncio
@pytest.mark.parametrize("mode,expected", [("acceptance", "blocked"), ("adaptive", "done")])
async def test_supervisor_renews_only_the_adaptive_window(tmp_path, mode, expected):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S0", "S0")
    observed = world(inventory={"oak_log": 3, "stick": 2})
    called = []

    async def dispatch(tool, arguments, timeout_s=0, *, action_id, **kwargs):
        assert tool == "craft"
        item = arguments["item"]
        called.append(item)
        inv = observed["inventory"]
        if item == "oak_planks":
            inv["oak_log"] -= 1
            inv["oak_planks"] = inv.get("oak_planks", 0) + 4
        else:
            inv["oak_planks"] -= 4 if item == "crafting_table" else 3
            inv[item] = 1
        observed["revision"] += 1
        return ActionResult(action_id, True, status="succeeded", data={"observation": observed.copy()})

    goal = goal_for_stage("S0", budget_mode=mode)
    goal = replace(goal, budget=replace(goal.budget, max_actions=2))
    supervisor = GoalSupervisor(goal, store, dispatch, lambda: observed)
    result = await supervisor.run(task.id)
    saved = store.load_goal_state(task.id)
    assert result["status"] == expected, result
    if mode == "adaptive":
        assert called == ["oak_planks", "crafting_table", "oak_planks", "wooden_pickaxe"]
        assert saved["counters"]["actions"] == 4
    else:
        assert saved["block_reason"] == "budget_actions"
        assert "progress_watchdog" not in saved
    store.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("legacy", [False, True])
async def test_resume_uses_persisted_budget_without_refilling(tmp_path, legacy):
    store = TaskStore(tmp_path / "resume.db")
    store.initialize()
    task = store.create_task("S0", "S0")
    mode, other = ("acceptance", "adaptive") if legacy else ("adaptive", "acceptance")
    goal = goal_for_stage("S0", budget_mode=mode)
    seed = GoalSupervisor(goal, store, None, world)._new_state()
    seed["counters"]["actions"] = goal.budget.max_actions
    if legacy:
        seed["budget"].pop("mode")
    else:
        observe_progress(seed, world(), 1)
    store.save_goal_state(task.id, seed)
    supervisor = GoalSupervisor(goal_for_stage("S0", budget_mode=other), store, None, world)
    result = await supervisor.run(task.id, resume=True)
    assert result["block_reason"] == ("budget_actions" if legacy else "budget_no_progress")
    assert store.load_goal_state(task.id)["budget"]["mode"] == mode
    store.close()


@pytest.mark.asyncio
async def test_waiting_for_ready_honors_idle_deadline_without_dispatch(tmp_path):
    goal = goal_for_stage("S0", budget_mode="adaptive")
    supervisor = GoalSupervisor(goal, TaskStore(tmp_path / "unused.db"), None, lambda: dict(world(), ready=False),
                                observation_event=asyncio.Event())
    supervisor.state = supervisor._new_state()
    supervisor.state["deadline_at"] = time.time() + 0.05
    assert await asyncio.wait_for(supervisor._wait_for_usable_state(), timeout=2) is None
    assert supervisor.state["block_reason"] == "budget_no_progress"
    assert supervisor.state["counters"]["actions"] == 0
    assert "progress_watchdog" not in supervisor.state


@pytest.mark.asyncio
async def test_reconnect_neither_renews_idle_watchdog_nor_resumes_paused_goal(tmp_path):
    store = TaskStore(tmp_path / "resume.db")
    store.initialize()
    task = store.create_task("S0", "S0")
    goal = goal_for_stage("S0", budget_mode="adaptive")
    supervisor = GoalSupervisor(goal, store, None, lambda: dict(world(), session_id="reconnected"))
    seed = supervisor._new_state()
    observe_progress(seed, world(100), time.time())
    seed["counters"]["actions"] = seed["progress_watchdog"]["action_limit"]
    seed["status"] = "paused_by_user"
    store.save_goal_state(task.id, seed)
    result = await supervisor.run(task.id, resume=True)
    assert result["status"] == "cancelled"
    assert store.load_goal_state(task.id) == seed
    seed["status"] = "disconnected"
    store.save_goal_state(task.id, seed)
    result = await supervisor.run(task.id, resume=True)
    assert result["block_reason"] == "budget_no_progress"
    saved = store.load_goal_state(task.id)
    assert saved["progress_watchdog"]["session_id"] == "reconnected"
    assert saved["progress_watchdog"]["action_limit"] == seed["progress_watchdog"]["action_limit"]
    assert saved["deadline_at"] == seed["deadline_at"]
    store.close()
