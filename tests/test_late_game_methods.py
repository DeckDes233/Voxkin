from copy import deepcopy

import pytest

from voxkin.agent.late_game_methods import choose_s5_action, choose_s6_action, ingot_dependency, prepare_late_action
from voxkin.agent.goal_supervisor import GoalSupervisor
from voxkin.agent.goals import GOALS
from voxkin.agent.runner import StepSpec
from voxkin.agent.tasks import TaskStore
from voxkin.bridge.protocol import ActionResult


def test_s6_approaches_distant_frames_before_using_eyes():
    state = world()
    search = {"stronghold_search": {"phase": "frames_found", "scan": {"frames": [{"x": 15, "y": -6, "z": 2}]}}}
    step, index = choose_s6_action(state, search, set())
    assert index is None and step.tool == "goto"
    state["position"] = {"x": 11, "y": 64, "z": 2}
    step, index = choose_s6_action(state, search, set())
    assert index is None and step.tool == "safe_descend" and step.arguments["targetY"] == 58
    state["position"]["y"] = -3
    assert choose_s6_action(state, search, set())[0].tool == "activate_end_portal"


def world(dimension="overworld", **inventory):
    return {"dimension": dimension, "inventory": inventory, "food": 20, "health": 20,
            "alive": True, "ready": True, "session_id": "late", "revision": 1,
            "position": {"x": 0, "y": 64, "z": 0}, "is_day": True,
            "executor": {"safety_active": False, "active_action_id": None}}


def test_s6_reconciles_interrupted_insertion_from_the_same_complete_ring(tmp_path):
    state = world(ender_eye=3)
    room = [{"x": x, "y": -6, "z": z, "filled": True} for x in range(5) for z in range(5)
            if (x in (0, 4)) != (z in (0, 4))]
    for frame in room[-3:]:
        frame["filled"] = False
    state["end_portal_room"] = {"frames": room}
    supervisor = GoalSupervisor(GOALS["S6"], TaskStore(tmp_path / "tasks.db"), None, lambda: state)
    supervisor.state = {"stronghold_search": {"phase": "frames_found", "scan": {"frames": room[:1]}}}
    receipt = {"tool": "activate_end_portal", "status": "preempted", "receipt_confirmed": True}
    assert supervisor._portal_insertion_reconciled(receipt, state)
    state["inventory"]["ender_eye"] = 2
    assert not supervisor._portal_insertion_reconciled(receipt, state)
    state["inventory"]["ender_eye"] = 3
    state["end_portal_room"]["frames"] = room[:11]
    assert not supervisor._portal_insertion_reconciled(receipt, state)


def test_s5_in_nether_does_not_repeat_overworld_preparation():
    step, index = choose_s5_action(world("the_nether", cooked_beef=4), {})
    assert (step.tool, index) == ("raid_fortress", 7)
    assert step.effect_class == "replan" and step.arguments["scout_only"]
    assert step.verify == {"type": "result_event", "event": "fortress_route_found"}
    step, index = choose_s5_action(world("the_nether", blaze_rod=12, cooked_beef=4), {})
    assert (step.tool, index) == ("hunt_enderman", 9)
    step, index = choose_s5_action(world("the_nether", blaze_rod=12, ender_pearl=24), {})
    assert (step.tool, step.arguments["mode"]) == ("nether_travel", "exit")


@pytest.mark.asyncio
async def test_fortress_scout_replans_from_the_chunk_reached_on_its_last_attempt(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S5", "S5")
    state = world("the_nether", cooked_beef=4)
    state["position"].update(x=37, z=2)
    departures = []

    async def dispatch(tool, args, timeout_s=0, **kwargs):
        assert tool == "raid_fortress" and args["scout_only"]
        departures.append(state["position"]["z"])
        state["position"]["z"] = -4
        state["revision"] += 1
        return ActionResult(kwargs["action_id"], False, status="blocked", detail="当前视野无堡垒",
                            data={"observation": deepcopy(state)})

    supervisor = GoalSupervisor(GOALS["S5"], store, dispatch, lambda: state)
    saved = supervisor._new_state()
    saved["counters"]["method_failures"]["s5:raid_fortress:default:chunk:2:0"] = 2
    store.save_goal_state(task.id, saved)
    result = await supervisor.run(task.id, resume=True)
    assert result["block_reason"] == "budget_method_attempts"
    assert departures == [2, -4, -4, -4]
    store.close()


def test_s6_requires_live_dragon_evidence_to_resume_interrupted_combat(tmp_path):
    state = world("the_end", bow=1, arrow=63)
    supervisor = GoalSupervisor(GOALS["S6"], TaskStore(tmp_path / "tasks.db"), None, lambda: state)
    receipt = {"tool": "fight_dragon", "status": "preempted", "receipt_confirmed": True}
    assert not supervisor._late_action_recovery(receipt, state)
    state["end_dragon"] = {"source": "dragon_boss_bar", "health_fraction": 1.0}
    assert supervisor._late_action_recovery(receipt, state) == "dragon_alive_after_safety"
    assert not supervisor._late_action_recovery({**receipt, "receipt_confirmed": False}, state)
    state["end_dragon"]["health_fraction"] = 0.0
    assert not supervisor._late_action_recovery(receipt, state)


def test_s6_partial_crystal_receipt_requires_measured_progress_and_a_live_boss(tmp_path):
    state = world("the_end")
    state["end_dragon"] = {"source": "dragon_boss_bar", "health_fraction": 1.0}
    supervisor = GoalSupervisor(GOALS["S6"], TaskStore(tmp_path / "tasks.db"), None, lambda: state)
    receipt = {"tool": "fight_dragon", "status": "partial", "receipt_confirmed": True,
               "result_data": {"crystal_progress": {"broken": 3, "remaining_visible": 7}}}
    assert supervisor._late_action_recovery(receipt, state) == "crystal_progress_observed"
    for invalid in ({"broken": 0, "remaining_visible": 7}, {"broken": True, "remaining_visible": 7},
                    {"broken": 3, "remaining_visible": 8}):
        assert not supervisor._late_action_recovery({**receipt, "result_data": {"crystal_progress": invalid}}, state)
    assert not supervisor._late_action_recovery(receipt, {**state, "dimension": "overworld"})


def test_s6_preemption_budget_only_credits_new_damage_in_the_same_end_session(tmp_path):
    before = {**world("the_end"), "end_dragon": {"health": 200}}
    after = {**before, "end_dragon": {"health": 192}}
    action = {"tool": "fight_dragon", "status": "preempted", "receipt_confirmed": True,
              "result_data": {"observation": after}}
    supervisor = GoalSupervisor(GOALS["S6"], TaskStore(tmp_path / "tasks.db"), None, lambda: after)
    supervisor.state = {"action_history": [action]}
    assert supervisor._record_dragon_damage(before)
    assert not supervisor._record_dragon_damage(before)
    after.update(session_id="another", end_dragon={"health": 160})
    assert not supervisor._record_dragon_damage(before)


def test_s6_timed_fight_replans_when_the_observed_dragon_is_still_damaged(tmp_path):
    state = {**world("the_end"), "end_dragon": {"position": {"x": 1, "y": 66, "z": 0}, "health": 91}}
    action = {"tool": "fight_dragon", "status": "partial", "receipt_confirmed": True,
              "result_data": {"dragon_progress": {"started_health": 120, "remaining_health": 91}}}
    supervisor = GoalSupervisor(GOALS["S6"], TaskStore(tmp_path / "tasks.db"), None, lambda: state)
    assert supervisor._late_action_recovery(action, state) == "dragon_damage_observed"
    state["end_dragon"]["health"] = 120
    assert not supervisor._late_action_recovery(action, state)


def test_s5_uses_the_shaft_lip_and_reconsiders_routes_from_the_surface(tmp_path):
    state = world(water_bucket=1)
    state["position"] = {"x": 0.5, "y": 71, "z": 0.5}
    lip = {"x": 4, "y": 72, "z": 0}
    state["surface_access"] = {"sky_light": 15, "exit": lip}
    supervisor = GoalSupervisor(GOALS["S5"], TaskStore(tmp_path / "tasks.db"), None, lambda: state)
    old_target = {"x": 32, "y": 75, "z": 0}
    supervisor.state = {"s5_obsidian_region": 1, "s5_wet_region": 1, "action_history": [
        {"method_key": "s5:obsidian_relocate:1", "status": "blocked", "result_data": {
            "relocation": {"origin": {"x": 0, "y": 54, "z": 0}, "attempted_positions": [old_target]}}}]}
    request = StepSpec("采集黑曜石", "collect_obsidian", {}, {})
    step, _ = supervisor._s5_obsidian_site(request, state, "s5:obsidian")
    assert step.tool == "goto" and step.arguments == lip
    state["position"] = lip
    step, _ = supervisor._s5_obsidian_site(request, state, "s5:obsidian")
    assert step.tool == "explore_mining_site" and old_target not in step.arguments["avoid_positions"]
    supervisor.state = {"s5_obsidian_region": 2}
    _, upper = supervisor._s5_obsidian_site(request, state, "s5:obsidian")
    state["position"] = {**lip, "y": lip["y"] - 8}
    _, lower = supervisor._s5_obsidian_site(request, state, "s5:obsidian")
    assert upper != lower


def test_s5_existing_igniter_skips_all_of_its_consumed_ingredients():
    state = world(cooked_beef=4, flint_and_steel=1, obsidian=10)
    step, index = choose_s5_action(state, {})
    assert (step.tool, index) == ("make_nether_portal", 5)
    state["inventory"].pop("obsidian")
    step, index = choose_s5_action(state, {"method_index": 6})
    assert (step.tool, index) == ("nether_travel", 6)


def test_s5_igniter_needs_one_iron_and_uses_non_oak_fuel():
    step = ingot_dependency({"raw_iron": 1, "furnace": 1, "spruce_planks": 1}, 1)
    assert step.arguments == {"item": "raw_iron", "count": 1, "output": "iron_ingot", "fuel": "spruce_planks"}
    assert ingot_dependency({"iron_ingot": 1}, 1) is None


def test_s5_uses_the_night_underground_for_stationary_preparation_before_hunting():
    state = world(raw_iron=3, furnace=1, coal=2)
    state.update(position={"y": -10}, is_day=False, food=17, health=17)
    step, _ = choose_s5_action(state, {})
    assert step.tool == "smelt_batch"
    state["inventory"].update(iron_ingot=1, flint=1)
    step, _ = choose_s5_action(state, {})
    assert step.arguments == {"item": "flint_and_steel", "count": 1}
    state["inventory"]["flint_and_steel"] = 1
    assert choose_s5_action(state, {})[0].tool == "hunt_animal"


def test_late_supply_climbs_in_short_verified_segments_before_dawn():
    state = world()
    state.update(position={"x": 0, "y": -10, "z": 0}, is_day=False,
                 shelter={"position": {"x": 40, "y": 67, "z": 0}, "size": 4})
    ledger = {}
    step, _ = prepare_late_action(*choose_s5_action(state, ledger), state, ledger)
    assert step.tool == "goto" and step.arguments == {"x": 6, "z": 0, "y": -2}
    assert step.verify["target"] == step.arguments
    state["position"]["y"] = 53
    step, _ = prepare_late_action(*choose_s5_action(state, ledger), state, ledger)
    assert step is None and ledger["late_game_wait_reason"]


def test_daytime_hunt_uses_observed_surface_above_a_cave_at_normal_surface_elevation():
    state = world()
    state.update(position={"x": -33, "y": 62, "z": 105},
                 surface_access={"sky_light": 0, "exit": {"x": -33, "y": 79, "z": 105}})
    step, _ = prepare_late_action(*choose_s5_action(state, {}), state, {})
    assert step.tool == "goto" and step.arguments["y"] == 79
    state["surface_access"] = {"sky_light": 15, "exit": None}
    assert prepare_late_action(*choose_s5_action(state, {}), state, {})[0].tool == "hunt_animal"


def test_hunt_progress_counts_raw_meat_in_the_bridge_and_total_food_in_the_goal():
    state = world(beef=1, bread=2)
    step, _ = choose_s5_action(state, {})
    assert step.arguments["count"] == 2
    assert step.verify["count"] == 4


def test_s6_respects_existing_equipment_eyes_and_recipe_yields():
    state = world(cooked_beef=4, bow=1, arrow=60, feather=1, flint=1)
    step, index = choose_s6_action(state, {}, set())
    assert (step.tool, index) == ("prepare_bow_arrows", 3)
    state["inventory"].update(arrow=64, ender_eye=20, ender_pearl=4, blaze_powder=1, blaze_rod=2)
    step, index = choose_s6_action(state, {}, set())
    assert step.arguments == {"item": "blaze_powder", "count": 3}
    state["inventory"]["blaze_powder"] = 5
    step, index = choose_s6_action(state, {}, set())
    assert step.arguments == {"item": "ender_eye", "count": 4}


def test_s6_end_dimension_does_not_hunt_overworld_resources_after_arrows_are_spent():
    state = world("the_end", bow=1, arrow=7)
    assert choose_s6_action(state, {}, set())[0].tool == "fight_dragon"
    assert choose_s6_action(state, {}, {"ender_dragon_killed"})[0].tool == "return_home"


def test_s5_mining_waits_for_recovery_without_spending_another_mining_attempt():
    state = world(porkchop=1, diamond_pickaxe=1, water_bucket=1)
    state.update(health=8, food=18)
    step = StepSpec("采集黑曜石", "collect_obsidian", {"count": 2}, {})
    ledger = {}
    meal, _ = prepare_late_action(step, 4, state, ledger)
    assert meal.tool == "eat_if_hungry"
    state["food"] = 20
    assert prepare_late_action(step, 4, state, ledger) == (None, None)
    state["health"] = 14
    assert prepare_late_action(step, 4, state, ledger) == (step, 4)


def test_late_combat_eats_and_waits_for_health_before_reengaging():
    state = world("the_nether", cooked_beef=4)
    state.update(health=8, food=15)
    ledger = {}
    step, index = choose_s5_action(state, ledger)
    assert step.tool == "eat_if_hungry"
    assert step.verify == {"type": "food", "min": 16}
    state["food"] = 20
    step, index = prepare_late_action(*choose_s5_action(state, ledger), state, ledger)
    assert step is None and ledger["late_game_wait_reason"]
    state["health"] = 18
    step, index = prepare_late_action(*choose_s5_action(state, ledger), state, ledger)
    assert step.tool == "raid_fortress" and "late_game_wait_reason" not in ledger


def test_late_iron_repair_uses_deepslate_without_changing_real_inventory():
    state = world(raw_iron=1, cobbled_deepslate=8, crafting_table=1)
    step = ingot_dependency(state["inventory"], 1)
    assert step.tool == "craft" and step.arguments["item"] == "furnace"
    assert "cobblestone" not in state["inventory"]
    state["inventory"].pop("cobbled_deepslate")
    state["inventory"]["wooden_pickaxe"] = 1
    state["position"]["y"] = -20
    step, _ = prepare_late_action(ingot_dependency(state["inventory"], 1), None, state, {})
    assert step.arguments["block"] == "deepslate"
    assert step.verify["items"] == {"cobbled_deepslate": 8}


@pytest.mark.asyncio
async def test_s6_frames_found_continues_to_end_dragon_and_return(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    task = store.create_task("S6", "S6")
    state = world(cooked_beef=4, bow=1, arrow=64, ender_eye=12)
    calls = []

    async def dispatch(tool, args, timeout_s=0, **kwargs):
        calls.append(tool)
        events = []
        if tool == "activate_end_portal":
            state["dimension"] = "the_end"
            state["inventory"]["ender_eye"] = 0
        elif tool == "fight_dragon":
            state["inventory"]["arrow"] = 7
            events = ["ender_dragon_killed"]
        elif tool == "return_home":
            state["dimension"] = "overworld"
        else:
            raise AssertionError(tool)
        state["revision"] += 1
        return ActionResult(kwargs["action_id"], True, status="succeeded", detail="确定性世界替身",
                            data={"observation": deepcopy(state), "events": events})

    supervisor = GoalSupervisor(GOALS["S6"], store, dispatch, lambda: state)
    saved = supervisor._new_state()
    saved.update(method_index=7, stronghold_search={"schema_version": 1, "phase": "frames_found", "search_id": "located"})
    store.save_goal_state(task.id, saved)
    result = await supervisor.run(task.id, resume=True)
    assert result["status"] == "done", result
    assert calls == ["activate_end_portal", "fight_dragon", "return_home"]
    store.close()
