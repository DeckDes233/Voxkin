import math
from copy import deepcopy

import pytest

from voxkin.agent.goal_methods import (
    choose_early_action, choose_s2_action, choose_s3_preflight_action,
    choose_s3_resource_action, early_planks, S3_FUEL_BURN, S3_ORE_EXPOSE_MAX,
)
from voxkin.agent.goals import GOALS, evaluate_condition
from voxkin.agent.goal_supervisor import GoalSupervisor
from voxkin.agent.tasks import TaskStore
from voxkin.bridge.protocol import ActionResult


def world(inventory=None):
    return {"inventory": inventory or {}, "health": 20, "food": 20, "alive": True,
            "is_day": True, "dimension": "overworld", "position": {"x": 0, "y": 74, "z": 0},
            "shelter": {"inside": False}, "executor": {}}


def apply_recipe_step(step, inventory, species):
    # 确定性配方替身：真实消耗输入、按配方产量取整，不把派发直接当作验收成功。
    args = step.arguments
    if step.tool == "mine_collect":
        item = {"wood_log": f"{species}_log", "stone": "cobblestone", "iron_ore": "raw_iron"}[args["block"]]
        inventory[item] = max(inventory.get(item, 0), args["count"])
        return
    if step.tool == "smelt_batch":
        count, fuel = args["count"], args["fuel"]
        costs = {"raw_iron": count, fuel: math.ceil(count / S3_FUEL_BURN[fuel])}
        item, produced = "iron_ingot", count
    else:
        assert step.tool == "craft"
        item = args["item"]
        plank = next((name for name, count in inventory.items() if name.endswith("_planks") and count > 0), f"{species}_planks")
        recipes = {"crafting_table": ({plank: 4}, 1), "stick": ({plank: 2}, 4),
                   "wooden_pickaxe": ({plank: 3, "stick": 2}, 1),
                   "stone_pickaxe": ({"cobblestone": 3, "stick": 2}, 1),
                   "stone_sword": ({"cobblestone": 2, "stick": 1}, 1), "furnace": ({"cobblestone": 8}, 1),
                   "iron_pickaxe": ({"iron_ingot": 3, "stick": 2}, 1),
                   "iron_sword": ({"iron_ingot": 2, "stick": 1}, 1),
                   "shield": ({"iron_ingot": 1, plank: 6}, 1), "bucket": ({"iron_ingot": 3}, 1)}
        if item.endswith("_planks"):
            costs, output = {item.replace("_planks", "_log"): 1}, 4
        else:
            costs, output = recipes[item]
        operations = math.ceil(args["count"] / output)
        costs = {name: amount * operations for name, amount in costs.items()}
        produced = operations * output
    for name, amount in costs.items():
        assert inventory.get(name, 0) >= amount, (step, inventory, costs)
        inventory[name] -= amount
    inventory[item] = inventory.get(item, 0) + produced


@pytest.mark.parametrize("species", ["oak", "spruce", "birch", "jungle", "acacia", "dark_oak", "mangrove", "cherry"])
def test_s0_s1_s3_consumption_chain_without_oak_or_coal(species):
    state = world({"cooked_beef": 4})
    for stage in ("S0", "S1", "S3"):
        for _ in range(80):
            if evaluate_condition(GOALS[stage].acceptance, state)[0]:
                break
            if stage == "S3":
                ready, step = choose_s3_preflight_action(state, {})
                if ready:
                    step = choose_s3_resource_action(state, {})
            else:
                step = choose_early_action(stage, state)
            assert step is not None, (stage, state)
            apply_recipe_step(step, state["inventory"], species)
        else:
            pytest.fail(f"{stage} 没有在配方动作预算内收敛")
    assert state["inventory"]["iron_ingot"] == 0


def test_s1_recovers_from_empty_inventory_without_a_saved_cursor():
    state = world()
    for _ in range(40):
        step = choose_early_action("S1", state)
        if step is None:
            break
        apply_recipe_step(step, state["inventory"], "spruce")
    assert evaluate_condition(GOALS["S1"].acceptance, state)[0]
    state["inventory"].clear()
    assert choose_early_action("S1", state).arguments["block"] == "wood_log"


def test_mixed_planks_are_not_mistaken_for_an_executable_homogeneous_recipe():
    step = early_planks({"oak_planks": 2, "birch_planks": 2, "birch_log": 1}, 4, "工作台")
    assert step.arguments == {"item": "birch_planks", "count": 2}


def test_s2_wool_does_not_require_iron_and_existing_shears_are_used():
    assert choose_s2_action(world(), {}).arguments["item"] == "wool"
    assert choose_s2_action(world({"shears": 1}), {}).tool == "shear_sheep"
    step = choose_s2_action(world({"white_wool": 2, "black_wool": 1}), {})
    assert step.tool == "hunt_material"
    assert step.verify == {"type": "inventory", "items": {"wool": 3}}


def test_s3_surface_iron_search_descends_in_bounded_segments_then_exposes():
    state = world({"stone_pickaxe": 1, "coal": 2})
    ledger = {"s3_ore_no_progress": 1}
    for index in range(S3_ORE_EXPOSE_MAX):
        step = choose_s3_resource_action(state, ledger)
        assert step.tool == "strip_mine"
        assert step.arguments["shaft"] <= 12
        assert step.effect_class == "non_replayable"
        state["position"]["y"] = step.arguments.get("y", state["position"]["y"])
        ledger["s3_ore_expose_used"] = index + 1
    assert state["position"]["y"] == 16
    relocation = choose_s3_resource_action(state, ledger)
    assert relocation.tool == "explore_mining_site"
    assert relocation.arguments["min_distance"] == 16


def test_s3_prefers_usable_fuel_and_reserves_shield_wood():
    state = world({"raw_iron": 9, "furnace": 1, "coal": 1, "spruce_planks": 20})
    step = choose_s3_resource_action(state, {})
    assert step.arguments == {"item": "raw_iron", "count": 8, "output": "iron_ingot", "fuel": "spruce_planks"}
    apply_recipe_step(step, state["inventory"], "spruce")
    assert state["inventory"]["spruce_planks"] >= 6


@pytest.mark.asyncio
async def test_supervisor_s0_to_s3_consumption_and_receipts(tmp_path):
    state = world({"cooked_beef": 4})
    state.update(session_id="progression", revision=1, ready=True)
    state["executor"] = {"active_action_id": None, "safety_active": False, "epoch": 1}
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    calls = []

    async def dispatch(tool, arguments, timeout_s=0, **kwargs):
        calls.append((tool, deepcopy(arguments)))
        inv = state["inventory"]
        if tool == "hunt_material":
            assert arguments["item"] == "wool"
            inv["white_wool"] = 3
        elif tool == "craft_bed":
            assert inv["white_wool"] >= 3 and inv["spruce_planks"] >= 3
            inv["white_wool"] -= 3
            inv["spruce_planks"] -= 3
            inv["white_bed"] = 1
        elif tool == "mine_collect" and arguments["block"] == "dirt":
            inv["dirt"] = arguments["count"]
        elif tool == "make_shelter":
            remaining = 40
            for item in ("dirt", "cobblestone", "spruce_planks", "spruce_log"):
                used = min(remaining, inv.get(item, 0))
                inv[item] = inv.get(item, 0) - used
                remaining -= used
            assert remaining == 0
            state["shelter"] = {"position": {"x": 0, "y": 73, "z": 0}, "size": 4, "sealed": True, "inside": True}
            state["position"] = {"x": 0, "y": 74, "z": 0}
        elif tool == "place_block":
            assert arguments["block"] == "white_bed" and inv["white_bed"] == 1
            inv["white_bed"] -= 1
            state["nearby_beds"] = [{axis: arguments[axis] for axis in "xyz"}]
        elif tool == "leave_shelter":
            state["shelter"].update(inside=False, sealed=False)
        else:
            class Step:
                pass
            step = Step()
            step.tool, step.arguments = tool, arguments
            apply_recipe_step(step, inv, "spruce")
        state["revision"] += 1
        return ActionResult(kwargs["action_id"], True, status="succeeded", detail="配方/世界替身确认完成",
                            data={"observation": deepcopy(state)})

    for stage in ("S0", "S1", "S2", "S3"):
        task = store.create_task(stage, stage)
        supervisor = GoalSupervisor(GOALS[stage], store, dispatch, lambda: state)
        result = await supervisor.run(task.id)
        assert result["status"] == "done", (result.get("block_reason"), store.load_goal_state(task.id).get("action_history", [])[-1:])
        assert evaluate_condition(GOALS[stage].acceptance, state)[0]
        ledger = store.load_goal_state(task.id)
        assert ledger["pending_action"] is None
        assert ledger["counters"]["actions"] > 0
    assert any(tool == "hunt_material" for tool, _ in calls)
    assert not any(args.get("block") == "oak_log" for _, args in calls)
    store.close()
