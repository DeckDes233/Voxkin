import asyncio
import json
from copy import deepcopy

import pytest

from voxkin.agent.decision_brain import DecisionBrain
from voxkin.agent.goal_supervisor import GoalSupervisor
from voxkin.agent.goals import GOALS
from voxkin.agent.runner import StepSpec
from voxkin.agent.tasks import TaskStore
from voxkin.config import BrainConfig
from voxkin.llm.base import LLMDelta


class RouteModel:
    def __init__(self):
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.calls = []

    async def stream_chat(self, messages):
        request = json.loads(messages[-1]["content"])
        self.calls.append(request)
        self.started.set()
        await self.release.wait()
        yield LLMDelta(kind="text", text=json.dumps({"decision_id": request["decision_id"], "candidate_id": "relocate_wood"}))


@pytest.fixture
def search(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    world = {"session_id": "body", "revision": 8, "alive": True, "ready": True,
             "dimension": "overworld", "day": 1, "is_day": True, "health": 20, "food": 18,
             "inventory": {}, "position": {"x": 31, "y": 64, "z": 0}, "surface_access": {"connected_land": True},
             "executor": {"safety_active": False, "active_action_id": "narrow"}}
    llm = RouteModel()
    supervisor = GoalSupervisor(GOALS["S3"], store, None, lambda: world, decision_brain=DecisionBrain(llm, BrainConfig()))
    supervisor.task_id = store.create_task("木头", "S3").id
    supervisor.state = supervisor._new_state()
    pending = {"action_id": "narrow", "session_id": "body", "revision": 6, "status": "running",
               "tool": "mine_collect", "method_key": "old-region", "expected_condition": {"type": "inventory"},
               "arguments": {"block": "wood_log", "surface_wood": True, "range": 64, "count": 8, "minimum_count": 2}}
    progress = {"action_id": "narrow", "session_id": "body", "state_revision": 8, "phase": "search_stalled",
                "data": {"resource": "wood_log", "failed_targets": 2}}
    supervisor.state["pending_action"] = pending
    yield supervisor, llm, world, pending, progress
    store.close()


def finish(search, *, confirmed=True):
    supervisor, _, world, pending, _ = search
    world["executor"]["active_action_id"] = None
    world["revision"] += 1
    world["position"]["x"] += 2
    pending.update(status="blocked", receipt_confirmed=confirmed, result_data={
        "reason": "surface_route_stalled", "observation": deepcopy(world),
    })
    supervisor.state["action_history"] = [pending]
    supervisor.state["pending_action"] = None
    supervisor._mark_attempt("old-region")
    return StepSpec("扩大采木范围", "mine_collect", {"block": "wood_log", "surface_wood": True, "range": 128, "count": 2}, {})


@pytest.mark.asyncio
async def test_body_progress_prepares_real_fork_and_new_region_does_not_repeat_same_receipt(search):
    supervisor, llm, world, _, progress = search
    assert supervisor.on_progress(progress)
    assert supervisor.on_progress(progress)
    await asyncio.wait_for(llm.started.wait(), 1)
    assert world["executor"]["active_action_id"] == "narrow"
    assert llm.calls[0]["facts"]["wood_failure"] == "surface_route_stalled"
    llm.release.set()
    assert await supervisor.decision_brain.wait_ready(supervisor._wood_prefetch.key) == "relocate_wood"
    wide = finish(search)
    selected = await supervisor._select_strategy(wide, "new-region:wide:other_trees", None, world)
    assert selected[0].tool == "explore_mining_site"
    assert selected[0].arguments["avoid_positions"][-1] == world["position"]
    event = next(e for e in supervisor.store.events(supervisor.task_id) if e["kind"] == "goal_strategy_selected")
    assert event["payload"]["prefetched"] is True
    assert event["payload"]["wood_failure_action_id"] == "narrow"
    world["position"]["x"] += 17
    assert await supervisor._select_strategy(wide, "third-region:wide", None, world) == (wide, "third-region:wide", None)
    assert len(llm.calls) == 1
    await supervisor.decision_brain.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["none", "unconfirmed", "collected", "moved", "reflex"])
async def test_unfinished_or_stale_prefetch_never_delays_body(search, change):
    supervisor, llm, world, _, progress = search
    supervisor.on_progress(progress)
    await asyncio.wait_for(llm.started.wait(), 1)
    wide = finish(search, confirmed=change != "unconfirmed")
    if change == "collected":
        world["inventory"]["oak_log"] = 2
    elif change == "moved":
        world["position"]["y"] += 5
    elif change == "reflex":
        world["executor"]["safety_active"] = True
        supervisor.interrupt_decision({"session_id": "body", "state_revision": world["revision"]})
    result = await asyncio.wait_for(supervisor._select_strategy(wide, "wood:wide", None, world), .5)
    assert result == (wide, "wood:wide", None)
    assert len(llm.calls) == 1
    await supervisor.decision_brain.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["ordinary", "other_session", "other_id", "older", "wide", "enough", "safety", "other_active"])
async def test_ordinary_or_untrusted_progress_sends_no_model_request(search, change):
    supervisor, llm, world, pending, progress = search
    if change == "ordinary":
        progress["phase"] = "pathfinding"
    elif change == "other_session":
        progress["session_id"] = "old"
    elif change == "other_id":
        progress["action_id"] = "other"
    elif change == "older":
        progress["state_revision"] -= 1
    elif change == "wide":
        pending["arguments"]["range"] = 128
    elif change == "enough":
        world["inventory"]["oak_log"] = 2
    elif change == "safety":
        world["executor"]["safety_active"] = True
    elif change == "other_active":
        world["executor"]["active_action_id"] = "another-action"
    supervisor.on_progress(progress)
    await asyncio.sleep(0)
    assert not llm.calls
    await supervisor.decision_brain.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("online", [True, False])
async def test_budget_excludes_exhausted_default_and_runs_only_remaining_route_locally(search, online):
    supervisor, llm, world, _, _ = search
    wide = finish(search)
    brain = supervisor.decision_brain
    if not online:
        supervisor.decision_brain = None
    limit = supervisor.goal.budget.max_attempts_per_method
    for _ in range(limit):
        supervisor._mark_attempt("wood:wide")
    assert supervisor._retry_or_block_method("wood:wide", "区域内无原木", wide) == "retry"
    alternative, method_key, cursor = await supervisor._select_strategy(wide, "wood:wide", 2, world)
    assert (alternative.tool, method_key, cursor) == ("explore_mining_site", "wood:wide:relocate_wood", None)
    assert not llm.calls
    for _ in range(limit):
        supervisor._mark_attempt(method_key)
    assert supervisor._retry_or_block_method(method_key, "无法抵达", alternative) == "retry"
    assert await supervisor._select_strategy(wide, "wood:wide", 2, world) == (wide, "wood:wide", 2)
    assert await supervisor._execute_step(wide, "wood:wide", 2) == "blocked"
    assert supervisor.state["block_reason"] == "budget_method_attempts"
    assert supervisor.state["counters"]["actions"] == 0
    await brain.close()


@pytest.mark.asyncio
async def test_only_nonexhausted_choices_are_sent_and_optional_failure_leaves_original_goal_active(search):
    supervisor, llm, world, _, _ = search
    world["food"] = 12
    world["inventory"]["bread"] = 1
    wide = finish(search)
    limit = supervisor.goal.budget.max_attempts_per_method
    for _ in range(limit):
        supervisor._mark_attempt("wood:wide")
    llm.release.set()
    chosen, method_key, _ = await supervisor._select_strategy(wide, "wood:wide", 2, world)
    assert chosen.tool == "explore_mining_site"
    assert set(llm.calls[0]["candidates"]) == {"relocate_wood", "eat_before_travel"}
    for _ in range(limit):
        supervisor._mark_attempt(method_key)
    assert supervisor._retry_or_block_method(method_key, "没有新落脚点", chosen) == "retry"
    assert supervisor.state["status"] == "active"
    chosen, _, _ = await supervisor._select_strategy(wide, "wood:wide", 2, world)
    assert chosen.tool == "eat_if_hungry"
    assert len(llm.calls) == 1
    await supervisor.decision_brain.close()
