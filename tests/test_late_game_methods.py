from copy import deepcopy

import pytest

from voxkin.agent.late_game_methods import choose_s5_action, choose_s6_action, ingot_dependency, prepare_late_action
from voxkin.agent.goal_supervisor import GoalSupervisor
from voxkin.agent.goals import GOALS
from voxkin.agent.tasks import TaskStore
from voxkin.bridge.protocol import ActionResult


def world(dimension="overworld", **inventory):
    return {"dimension": dimension, "inventory": inventory, "food": 20, "health": 20,
            "alive": True, "ready": True, "session_id": "late", "revision": 1,
            "position": {"x": 0, "y": 64, "z": 0}, "is_day": True,
            "executor": {"safety_active": False, "active_action_id": None}}


def test_s5_in_nether_does_not_repeat_overworld_preparation():
    step, index = choose_s5_action(world("the_nether", cooked_beef=4), {})
    assert (step.tool, index) == ("raid_fortress", 7)
    step, index = choose_s5_action(world("the_nether", blaze_rod=12, cooked_beef=4), {})
    assert (step.tool, index) == ("hunt_enderman", 9)
    step, index = choose_s5_action(world("the_nether", blaze_rod=12, ender_pearl=24), {})
    assert (step.tool, step.arguments["mode"]) == ("nether_travel", "exit")


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


def test_late_combat_eats_and_waits_for_health_before_reengaging():
    state = world("the_nether", cooked_beef=4)
    state.update(health=8, food=15)
    ledger = {}
    step, index = choose_s5_action(state, ledger)
    assert step.tool == "eat_if_hungry"
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
