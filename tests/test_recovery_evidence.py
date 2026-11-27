from dataclasses import replace

import pytest

from voxkin.agent.actions import ActionError
from voxkin.agent.goal_supervisor import GoalSupervisor
from voxkin.agent.goals import GOALS
from voxkin.agent.recovery_evidence import failure_reason, surface_wood_evidence
from voxkin.agent.runner import StepSpec
from voxkin.agent.strategy_choices import major_fork
from voxkin.agent.tasks import TaskStore
from voxkin.bridge.protocol import ActionResult


def world(x):
    return {
        "session_id": "bridge-a", "dimension": "overworld", "revision": 5, "ready": True, "alive": True,
        "day": 2, "is_day": True, "time": 3000, "position": {"x": x, "y": 64, "z": 0.2},
        "health": 20, "food": 20, "inventory": {}, "surface_access": {"sky_light": 15, "connected_land": True},
    }


def empty_search(radius):
    origin, end = world(31.8), world(32.1)
    return {
        "action_id": f"search-{radius}", "method_key": f"original-key-{radius}",
        "tool": "mine_collect", "arguments": {"surface_wood": True, "block": "wood_log", "range": radius},
        "session_id": end["session_id"], "revision": 4, "status": "blocked", "receipt_confirmed": True,
        "result_data": {"reason": "resource_not_found", "observation": end, "resource_search": {
            "origin": origin["position"], "range": radius, "resource": "wood_log",
            "attempted": 0, "failed_positions": [], "inventory_count": 0,
        }},
    }


@pytest.mark.parametrize("stage", ["S2", "S3", "S4", "S5", "S6"])
def test_confirmed_local_exhaustion_crosses_region_boundary_but_not_new_sites(tmp_path, stage):
    state = world(32.2)
    supervisor = GoalSupervisor(GOALS[stage], TaskStore(tmp_path / "test.db"), None, lambda: state)
    supervisor.state = {"counters": {"method_failures": {}}, "action_history": [empty_search(64)]}
    request = StepSpec("收集原木", "mine_collect", {"surface_wood": True, "block": "wood_log", "range": 64}, {})
    key = "fresh_region_key"

    wide, wide_key = supervisor._plan_surface_wood_search(request, state, key)
    assert wide.arguments["range"] == 128 and wide_key != key
    fork = major_fork(stage, wide, wide_key, state, supervisor.state)
    assert fork and fork.options["continue_task"] == wide and fork.options["relocate_wood"].tool == "explore_mining_site"
    supervisor.state["action_history"].append(empty_search(128))
    relocation, _ = supervisor._plan_surface_wood_search(request, state, key)
    assert relocation.tool == "explore_mining_site" and relocation.verify["type"] == "s3_wood_relocation"
    assert not supervisor.state["counters"]["method_failures"]
    assert supervisor._plan_surface_wood_search(request, world(49), key) == (request, key)


@pytest.mark.parametrize("change", ["session", "stale", "dimension", "day", "elevation", "inventory", "filtered",
                                    "unconfirmed", "partial", "missing_observation"])
def test_filtered_or_stale_recovery_cannot_declare_the_new_area_searched(change):
    row, state = empty_search(128), world(32.2)
    end = row["result_data"]["observation"]
    if change == "session":
        state["session_id"] = "new"
    elif change == "stale":
        end["revision"] = row["revision"]
    elif change == "dimension":
        state["dimension"] = "the_nether"
    elif change == "day":
        state["day"] += 1
    elif change == "elevation":
        end["position"]["y"] += 3
    elif change == "inventory":
        state["inventory"]["oak_log"] = 1
    elif change == "filtered":
        row["arguments"]["avoid_positions"] = [state["position"]]
    elif change == "unconfirmed":
        row["receipt_confirmed"] = False
    elif change == "partial":
        row["status"] = "partial"
    else:
        row["terminal_observation"] = row["result_data"].pop("observation")
    assert surface_wood_evidence([row], state).searched_range == 0


def test_failed_approaches_exclude_only_observed_targets_and_do_not_exhaust_the_radius(tmp_path):
    row, state = empty_search(128), world(32.2)
    rejected = [{"x": 42 + i, "y": 67, "z": 4} for i in range(3)]
    data = row["result_data"]
    data.update(reason="surface_route_stalled", surface_trunk=rejected[-1])
    data["resource_search"].update(attempted=3, failed_positions=rejected)
    supervisor = GoalSupervisor(GOALS["S4"], TaskStore(tmp_path / "test.db"), None, lambda: state)
    supervisor.state = {"counters": {"method_failures": {}}, "action_history": [row]}
    request = StepSpec("收集原木", "mine_collect", {"surface_wood": True, "block": "wood_log", "range": 64}, {})
    wide, _ = supervisor._plan_surface_wood_search(request, state, "new_key")
    assert wide.tool == "mine_collect" and wide.arguments["avoid_positions"] == rejected and wide.arguments["range"] == 128
    moved = surface_wood_evidence([row], world(53))
    assert moved.trunks == [rejected[-1]] and not moved.avoid and not moved.stalled_here


def test_confirmed_reason_takes_precedence_over_old_text():
    row = {"status": "blocked", "receipt_confirmed": True, "result_detail": "血量不足"}
    assert failure_reason(row) == "low_health"
    row["result_data"] = {"reason": "nearby_hostiles"}
    assert failure_reason(row) == "nearby_hostiles"
    row["receipt_confirmed"] = False
    assert failure_reason(row) is None


@pytest.mark.parametrize("moved", ["session", "floor"])
def test_a_hostile_dirt_receipt_does_not_contaminate_another_world_or_floor(tmp_path, moved):
    state = world(32.2)
    if moved == "session":
        state["session_id"] = "another-connection"
    else:
        state["position"]["y"] -= 12
    row = empty_search(64)
    row["arguments"] = {"block": "dirt"}
    row["result_data"]["reason"] = "nearby_hostiles"
    supervisor = GoalSupervisor(GOALS["S2"], TaskStore(tmp_path / "test.db"), None, lambda: state)
    supervisor.state = {"action_history": [row]}
    step = StepSpec("补充泥土", "mine_collect", {"block": "dirt", "count": 40}, {})
    assert supervisor._plan_s2_dirt_collection(step, "dirt", state) == (step, "dirt")


def test_later_confirmed_wood_find_reopens_the_location_even_after_spending_logs():
    old = empty_search(128)
    found = world(32.4)
    found.update(revision=6, inventory={"birch_log": 1})
    receipt = {**old, "revision": 5, "status": "succeeded", "result_data": {"collected": 1, "observation": found}}
    now = {**world(32.3), "revision": 8, "inventory": {"birch_planks": 4}}
    assert surface_wood_evidence([old, receipt], now).searched_range == 0


@pytest.mark.asyncio
async def test_s2_dispatch_expands_after_crossing_a_cell_edge_then_relocates(tmp_path):
    state = world(31.8)
    state["inventory"] = {"white_wool": 3, "mutton": 4}
    state["executor"] = {"active_action_id": None, "safety_active": False, "epoch": 1}
    store = TaskStore(tmp_path / "dispatch.db")
    store.initialize()
    task = store.create_task("S2", "S2")
    calls = []

    async def dispatch(tool, arguments, timeout_s=0, *, action_id="", **kwargs):
        calls.append((tool, arguments.get("range")))
        origin = dict(state["position"])
        state["revision"] += 1
        if tool == "mine_collect":
            state["position"] = {**origin, "x": 32.2}
            data = empty_search(arguments["range"])["result_data"]
            data["observation"] = dict(state)
            data["resource_search"]["origin"] = origin
            raise ActionError("当前范围没有原木", status="blocked", receipt_confirmed=True, action_id=action_id, data=data)
        assert tool == "explore_mining_site"
        state["position"] = {**origin, "x": origin["x"] + arguments["min_distance"]}
        return ActionResult(action_id, True, status="succeeded", data={
            "observation": dict(state), "relocation": {"origin": origin, "destination": state["position"]}})

    goal = replace(GOALS["S2"], budget=replace(GOALS["S2"].budget, max_actions=3))
    supervisor = GoalSupervisor(goal, store, dispatch, lambda: state)
    await supervisor.run(task.id)
    assert calls == [("mine_collect", 64), ("mine_collect", 128), ("explore_mining_site", None)]
    store.close()
