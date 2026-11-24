from __future__ import annotations

import pytest

from voxkin.agent.actions import ActionError
from voxkin.agent.goal_methods import choose_s4_preflight_action
from voxkin.agent.goal_supervisor import GoalSupervisor, choose_s4_resource_action
from voxkin.agent.goals import GOALS, method_for_goal
from voxkin.agent.tasks import TaskStore
from voxkin.bridge.protocol import ActionResult, ActionStatusResult


def s4_state(*, y: float = 59.9, revision: int = 20, **updates) -> dict:
    state = {
        "ready": True,
        "alive": True,
        "health": 20,
        "food": 18,
        "dimension": "overworld",
        "position": {"x": -10.0, "y": y, "z": 159.0},
        "session_id": "s4-session",
        "revision": revision,
        "is_day": False,
        "shelter": {
            "inside": False,
            "sealed": True,
            "size": 4,
            "position": {"x": -10.0, "y": 64.0, "z": 159.0},
        },
        "inventory": {
            "crafting_table": 1,
            "iron_pickaxe": 1,
            "stick": 2,
            "porkchop": 2,
        },
        "executor": {"active_action_id": None, "safety_active": False, "epoch": 1},
    }
    state.update(updates)
    return state


def test_s4_uses_the_observed_exit_before_a_distant_shelter():
    state = s4_state(position={"x": 118.5, "y": 42, "z": 12.5}, is_day=False,
                     shelter={"inside": False, "size": 4, "position": {"x": 9, "y": 69, "z": 152}},
                     inventory={"iron_pickaxe": 1, "stick": 1, "porkchop": 3},
                     surface_access={"sky_light": 0, "exit": {"x": 118, "y": 63, "z": 12}})
    ledger = {}
    ready, step = choose_s4_preflight_action(state, ledger)
    assert not ready and step.tool == "goto" and step.arguments == {"x": 118, "y": 48, "z": 12}
    state["position"]["y"] = 55
    ready, step = choose_s4_preflight_action(state, ledger)
    assert not ready and step is None and ledger.get("s4_preflight_wait_reason")


def observation(state: dict) -> dict:
    return {
        **state,
        "position": dict(state["position"]),
        "inventory": dict(state["inventory"]),
        "executor": dict(state["executor"]),
    }


def saved_s4_state(supervisor: GoalSupervisor, **updates) -> dict:
    state = supervisor._new_state()
    state.update({"s4_food_reserve_ready": True, "s4_diamond_no_progress": 1})
    state.update(updates)
    return state


def make_store_task(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S4", "S4")
    return store, task


def test_s4_metadata_keeps_diamond_pickaxe_acceptance_and_selects_resource_strategy():
    assert GOALS["S4"].acceptance == {
        "type": "inventory",
        "items": {"diamond_pickaxe": 1},
    }
    assert GOALS["S4"].method_id == "s4_diamond_adaptive"
    assert method_for_goal(GOALS["S4"]).strategy == "s4_resource_reconciliation"


def test_s4_final_depth_segment_clamps_shaft_to_one_for_fractional_y():
    state = s4_state(y=-55.5)

    step = choose_s4_resource_action(state, {"s4_diamond_no_progress": 1})

    assert step is not None
    assert step.tool == "strip_mine"
    assert step.arguments["shaft"] == 1
    assert step.verify == {"type": "s4_depth_reached", "target_y": -56}


def test_s4_descends_before_searching_for_diamonds_on_the_surface():
    step = choose_s4_resource_action(s4_state(y=74), {})
    assert step.tool == "strip_mine"
    assert step.verify == {"type": "s4_depth_reached", "target_y": 62}


def test_s4_uses_a_table_still_present_after_reconnecting_underground():
    state = s4_state(y=-10, nearby_crafting_table=True, inventory={"diamond": 3, "stick": 3})
    ready, preparation = choose_s4_preflight_action(state, {})
    assert ready and preparation is None
    assert choose_s4_resource_action(state, {}).arguments == {"item": "diamond_pickaxe", "count": 1}


@pytest.mark.parametrize(("food_item", "hunt_target"), [("porkchop", 2), ("apple", 1)])
def test_s4_food_hunt_uses_the_inventory_total_as_its_count_target(food_item, hunt_target):
    state = s4_state(
        is_day=True,
        inventory={
            "crafting_table": 1,
            "iron_pickaxe": 1,
            "stick": 2,
            food_item: 1,
        },
    )

    complete, step = choose_s4_preflight_action(state, {})

    assert complete is False
    assert step is not None
    assert step.tool == "hunt_animal"
    assert step.arguments["count"] == hunt_target
    assert step.verify["count"] == 2


def test_s4_rebuilds_a_missing_stone_pickaxe_from_cobbled_deepslate():
    state = s4_state(
        y=-20,
        inventory={
            "crafting_table": 1,
            "stick": 4,
            "porkchop": 2,
            "cobbled_deepslate": 3,
            "furnace": 1,
        },
    )

    complete, step = choose_s4_preflight_action(state, {"s4_food_reserve_ready": True})

    assert complete is False
    assert step is not None
    assert step.tool == "craft"
    assert step.arguments == {"item": "stone_pickaxe", "count": 1}


def test_s4_propagates_safe_wait_when_missing_stone_pickaxe_requires_nighttime_wood():
    state = s4_state(
        y=-20,
        is_day=False,
        inventory={
            "crafting_table": 1,
            "stick": 4,
            "porkchop": 2,
            "furnace": 1,
        },
    )
    goal_state = {"s4_food_reserve_ready": True}

    complete, step = choose_s4_preflight_action(state, goal_state)

    assert complete is False
    assert step is None
    assert goal_state.get("s4_preflight_wait_reason")
    assert "s4_preflight_block_reason" not in goal_state


def test_s4_can_retry_nighttime_bed_admission_until_a_physical_failure():
    state = s4_state(y=74, is_day=False, day=0, resource_sites={"sleep_bed": {"x": 4, "y": 72, "z": 3}},
                     inventory={"iron_pickaxe": 1, "crafting_table": 1, "porkchop": 4})
    ledger = {"s4_food_reserve_ready": True}
    for _ in range(2):
        _, step = choose_s4_preflight_action(state, ledger)
        assert step.tool == "sleep_safe"
        assert step.arguments["range"] == 32
    ledger["counters"] = {"method_failures": {"wood_sleep:day0": 1}}
    _, step = choose_s4_preflight_action(state, ledger)
    assert step is None and ledger["s4_preflight_wait_reason"]


def test_s4_mines_deepslate_when_stone_pickaxe_repair_needs_more_stone():
    state = s4_state(
        y=-20,
        inventory={
            "crafting_table": 1,
            "stick": 4,
            "porkchop": 2,
            "wooden_pickaxe": 1,
            "cobbled_deepslate": 1,
            "furnace": 1,
        },
    )

    complete, step = choose_s4_preflight_action(state, {"s4_food_reserve_ready": True})

    assert complete is False
    assert step is not None
    assert step.tool == "mine_collect"
    assert step.arguments == {"block": "deepslate", "count": 3, "range": 48}
    assert step.verify == {"type": "inventory", "items": {"cobbled_deepslate": 3}}


def test_s4_uses_cobbled_deepslate_for_furnace_and_planks_for_iron_fuel():
    mixed_stone_state = s4_state(
        y=-20,
        inventory={
            "crafting_table": 1,
            "stone_pickaxe": 1,
            "stick": 4,
            "porkchop": 2,
            "cobblestone": 4,
            "cobbled_deepslate": 4,
            "raw_iron": 3,
        },
    )
    complete, mixed_stone_step = choose_s4_preflight_action(
        mixed_stone_state, {"s4_food_reserve_ready": True}
    )
    assert complete is False
    assert mixed_stone_step is not None
    assert mixed_stone_step.tool == "mine_collect"
    assert mixed_stone_step.arguments == {"block": "deepslate", "count": 8, "range": 48}
    assert mixed_stone_step.verify == {
        "type": "inventory",
        "items": {"cobbled_deepslate": 8},
    }

    furnace_state = s4_state(
        y=-20,
        inventory={
            "crafting_table": 1,
            "stone_pickaxe": 1,
            "stick": 4,
            "porkchop": 2,
            "cobbled_deepslate": 8,
            "raw_iron": 3,
        },
    )
    complete, furnace_step = choose_s4_preflight_action(
        furnace_state, {"s4_food_reserve_ready": True}
    )
    assert complete is False
    assert furnace_step is not None
    assert furnace_step.tool == "craft"
    assert furnace_step.arguments == {"item": "furnace", "count": 1}

    fuel_state = s4_state(
        inventory={
            "crafting_table": 1,
            "stone_pickaxe": 1,
            "stick": 4,
            "porkchop": 2,
            "furnace": 1,
            "raw_iron": 3,
            "oak_planks": 1,
        },
    )
    complete, fuel_step = choose_s4_preflight_action(fuel_state, {"s4_food_reserve_ready": True})
    assert complete is False
    assert fuel_step is not None
    assert fuel_step.tool == "smelt_batch"
    assert fuel_step.arguments == {
        "item": "raw_iron",
        "count": 1,
        "output": "iron_ingot",
        "fuel": "oak_planks",
    }
    assert fuel_step.verify == {"type": "inventory", "items": {"iron_ingot": 1}}


@pytest.mark.asyncio
async def test_supervisor_crafts_existing_diamonds_without_food_or_day_gates(tmp_path):
    store, task = make_store_task(tmp_path)
    state = s4_state(
        y=64,
        dimension="the_nether",
        health=4,
        food=0,
        is_day=False,
        shelter={
            "inside": True,
            "sealed": True,
            "size": 4,
            "position": {"x": -10.0, "y": 64.0, "z": 159.0},
        },
        inventory={
            "crafting_table": 1,
            "stick": 2,
            "diamond": 3,
        },
    )
    calls = []

    async def dispatch(tool, arguments, timeout_s=0.0, action_id="", **kwargs):
        calls.append((tool, dict(arguments)))
        assert tool == "craft"
        state["inventory"]["diamond_pickaxe"] = 1
        state["revision"] += 1
        return ActionResult(
            action_id,
            True,
            status="succeeded",
            data={"observation": observation(state)},
        )

    supervisor = GoalSupervisor(GOALS["S4"], store, dispatch, lambda: state)
    store.save_goal_state(task.id, supervisor._new_state())
    store.set_status(task.id, "active")

    result = await supervisor.run(task.id, resume=True)

    assert result["status"] == "done"
    assert calls == [("craft", {"item": "diamond_pickaxe", "count": 1})]
    store.close()


@pytest.mark.asyncio
async def test_supervisor_records_only_fresh_verified_descent_then_searches_diamonds(tmp_path):
    store, task = make_store_task(tmp_path)
    state = s4_state(y=26)
    calls = []

    async def dispatch(tool, arguments, timeout_s=0.0, action_id="", **kwargs):
        calls.append((tool, dict(arguments), action_id))
        if tool == "strip_mine":
            state["position"]["y"] = 14.0
            state["revision"] += 1
            return ActionResult(
                action_id,
                True,
                status="succeeded",
                data={"observation": observation(state)},
            )
        assert tool == "mine_collect"
        raise ActionError(
            "Bridge 在钻石采集期间断开",
            status="unknown",
            action_id=action_id,
            receipt_confirmed=False,
        )

    supervisor = GoalSupervisor(GOALS["S4"], store, dispatch, lambda: state)
    store.save_goal_state(task.id, saved_s4_state(supervisor))
    store.set_status(task.id, "active")

    result = await supervisor.run(task.id, resume=True)

    assert result["status"] == "unknown"
    saved = store.load_goal_state(task.id)
    assert [call[0] for call in calls] == ["strip_mine", "mine_collect"]
    assert calls[0][1]["shaft"] == 12
    assert saved["s4_descent_segments"] == 1
    assert saved["s4_diamond_no_progress"] == 0
    assert saved["counters"]["method_failures"].get("s4:descend:0:14", 0) == 0
    assert saved["pending_action"]["tool"] == "mine_collect"
    assert saved["pending_action"]["baseline_diamond_count"] == 0
    store.close()


@pytest.mark.asyncio
async def test_supervisor_routes_confirmed_safe_stop_once_and_counts_physical_failure(tmp_path):
    store, task = make_store_task(tmp_path)
    state = s4_state()
    calls = []

    async def dispatch(tool, arguments, timeout_s=0.0, action_id="", **kwargs):
        calls.append((tool, dict(arguments), action_id))
        state["revision"] += 1
        data = {"observation": observation(state)}
        if tool == "strip_mine" and arguments.get("shaft") is not False:
            data.update(
                {
                    "phase": "safe_stop",
                    "reason": "no_safe_stair",
                    "position": dict(state["position"]),
                    "target_y": -56,
                    "candidates": [],
                }
            )
            return ActionResult(action_id, False, status="blocked", data=data)
        return ActionResult(
            action_id,
            False,
            status="blocked",
            detail="横向路径未找到矿石",
            data=data,
        )

    supervisor = GoalSupervisor(GOALS["S4"], store, dispatch, lambda: state)
    store.save_goal_state(task.id, saved_s4_state(supervisor))
    store.set_status(task.id, "active")

    result = await supervisor.run(task.id, resume=True)

    saved = store.load_goal_state(task.id)
    assert result["status"] == "blocked"
    assert [call[0] for call in calls] == ["strip_mine", "strip_mine"]
    assert calls[1][1]["shaft"] is False
    assert calls[1][1]["length"] == 12
    assert saved["s4_safe_stair_stops"] == 1
    assert saved["s4_safe_route_fallback_pending"] is True
    assert saved.get("s4_safe_route_fallback_used") is not True
    assert saved["counters"]["attempts"]["s4:descend:0:47"] == 1
    assert saved["counters"]["method_failures"]["s4:descend:0:47"] == 1
    assert saved["action_history"][0]["action_id"] == calls[0][2]
    assert saved["action_history"][0]["result_data"]["reason"] == "no_safe_stair"
    store.close()


@pytest.mark.asyncio
async def test_resume_reconciles_known_safe_stop_without_double_counting_or_replaying(tmp_path):
    store, task = make_store_task(tmp_path)
    state = s4_state()
    state["revision"] = 21
    calls = []
    safe_stop_data = {
        "phase": "safe_stop",
        "reason": "no_safe_stair",
        "position": dict(state["position"]),
        "target_y": -56,
        "candidates": [],
        "observation": observation(state),
    }

    async def dispatch(tool, arguments, timeout_s=0.0, action_id="", **kwargs):
        calls.append((tool, dict(arguments), action_id))
        raise ActionError(
            "横向路线结果未知",
            status="unknown",
            action_id=action_id,
            receipt_confirmed=False,
        )

    async def action_status(action_id):
        if action_id == "known-descent":
            return ActionStatusResult(
                action_id, "blocked", "没有安全阶梯", safe_stop_data
            )
        return ActionStatusResult(action_id, "unknown", "没有终态回执")

    supervisor = GoalSupervisor(
        GOALS["S4"], store, dispatch, lambda: state, action_status=action_status
    )
    saved = saved_s4_state(supervisor)
    saved.update(
        {
            "status": "disconnected",
            "pending_action": {
                "action_id": "known-descent",
                "goal_id": "stage:s4",
                "method_id": "s4_diamond_adaptive",
                "method_key": "s4:descend:0:-56",
                "tool": "strip_mine",
                "arguments": {"shaft": 12, "length": 1},
                "expected_condition": {"type": "s4_depth_reached", "target_y": -56},
                "effect_class": "non_replayable",
                "session_id": "s4-session",
                "revision": 20,
                "status": "disconnected",
                "receipt_confirmed": False,
                "result_data": {},
            },
            "recovery": {
                "needs_reconcile": True,
                "reason": "bridge_disconnected",
                "baseline_session_id": "s4-session",
                "baseline_revision": 20,
            },
        }
    )
    store.save_goal_state(task.id, saved)
    store.set_status(task.id, "disconnected")

    first = await supervisor.run(task.id, resume=True)

    assert first["status"] == "unknown"
    after_first = store.load_goal_state(task.id)
    assert after_first["s4_safe_stair_stops"] == 1
    assert after_first["counters"]["method_failures"]["s4:descend:0:-56"] == 1
    assert after_first["pending_action"]["method_key"] == "s4:ore_horizontal_fallback"
    assert len([item for item in after_first["action_history"] if item.get("action_id") == "known-descent"]) == 1

    state["revision"] = 22
    second = await supervisor.run(task.id, resume=True)
    after_second = store.load_goal_state(task.id)

    assert second["status"] == "blocked"
    assert after_second["s4_safe_stair_stops"] == 1
    assert after_second["counters"]["method_failures"]["s4:descend:0:-56"] == 1
    assert len([item for item in after_second["action_history"] if item.get("action_id") == "known-descent"]) == 1
    assert len(calls) == 1
    store.close()


@pytest.mark.parametrize("terminal_status", ["unknown", "partial"])
@pytest.mark.asyncio
async def test_nonreplayable_unknown_or_partial_descent_never_advances_segment(
    tmp_path, terminal_status
):
    store, task = make_store_task(tmp_path)
    state = s4_state(y=-56.0, revision=21)
    dispatches = []

    async def dispatch(*args, **kwargs):
        dispatches.append(args)
        raise AssertionError("non-replayable action must not be reissued")

    async def action_status(action_id):
        data = {"observation": observation(state)}
        return ActionStatusResult(action_id, terminal_status, "终态不提供可重放证据", data)

    supervisor = GoalSupervisor(
        GOALS["S4"], store, dispatch, lambda: state, action_status=action_status
    )
    saved = saved_s4_state(supervisor)
    saved.update(
        {
            "status": "unknown",
            "pending_action": {
                "action_id": f"descent-{terminal_status}",
                "goal_id": "stage:s4",
                "method_id": "s4_diamond_adaptive",
                "method_key": "s4:descend:0:-56",
                "tool": "strip_mine",
                "arguments": {"shaft": 12, "length": 1},
                "expected_condition": {"type": "s4_depth_reached", "target_y": -56},
                "effect_class": "non_replayable",
                "session_id": "s4-session",
                "revision": 20,
                "status": "unknown",
                "receipt_confirmed": False,
            },
            "recovery": {
                "needs_reconcile": True,
                "reason": "bridge_disconnected",
                "baseline_session_id": "s4-session",
                "baseline_revision": 20,
            },
        }
    )
    store.save_goal_state(task.id, saved)
    store.set_status(task.id, "unknown")

    result = await supervisor.run(task.id, resume=True)

    after = store.load_goal_state(task.id)
    assert result["status"] == "blocked"
    assert after.get("s4_descent_segments", 0) == 0
    assert after["unresolved_action"]["action_id"] == f"descent-{terminal_status}"
    assert after["unresolved_action"]["status"] == terminal_status
    assert after["unresolved_action"]["receipt_confirmed"] is (terminal_status == "partial")
    assert after["counters"]["attempts"].get("s4:descend:0:-56", 0) == 0
    assert dispatches == []

    resumed = await supervisor.run(task.id, resume=True)

    assert resumed["status"] == "blocked"
    assert dispatches == []
    store.close()
