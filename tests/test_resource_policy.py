from copy import deepcopy

import pytest

from voxkin.agent.goal_supervisor import GoalSupervisor
from voxkin.agent.goals import GOALS
from voxkin.agent.resource_policy import batch_resource_step, choose_supply_opportunity
from voxkin.agent.runner import StepSpec
from voxkin.agent.tasks import TaskStore
from voxkin.bridge.protocol import ActionResult


def test_full_mining_inventory_stores_excess_before_collecting_new_drops():
    state = world(cobblestone=640, diamond_pickaxe=1, diamond=3, oak_log=15, crafting_table=1)
    state.update(inventory_free_slots=0, is_day=False)
    step, key = choose_supply_opportunity("S5", state, {})
    assert step.tool == "store_items"
    assert step.arguments == {"item": "cobblestone", "count": 512, "range": 5,
                              "place_if_missing": True, "craft_if_missing": True}
    assert step.verify == {"type": "inventory_free_slots", "min": 2}
    assert choose_supply_opportunity("S5", state, {"counters": {"method_failures": {key: 1}}}) is None
    state["inventory_free_slots"] = 6
    assert choose_supply_opportunity("S5", state, {}) is None


def test_full_nether_inventory_preserves_wood_and_avoids_repeated_drops_in_one_chunk():
    state = world(basalt=384, oak_planks=4, diamond=3)
    state.update(dimension="the_nether", inventory_free_slots=0)
    step, key = choose_supply_opportunity("S5", state, {})
    assert step.tool == "discard_rubble" and step.arguments == {"item": "basalt"}
    assert step.verify == {"type": "inventory_free_slots", "min": 2}
    state["inventory"]["diamond_pickaxe"] = 1
    assert choose_supply_opportunity("S5", state, {"method_index": 7}) is None
    assert choose_supply_opportunity("S5", state, {"method_index": 8})[0].tool == "discard_rubble"
    ledger = {"action_history": [{"method_key": key, "status": "succeeded"}]}
    assert choose_supply_opportunity("S5", state, ledger) is None
    state["resource_sites"]["chests"] = [{"x": 1, "y": 64, "z": 1}]
    assert choose_supply_opportunity("S5", state, {})[0].tool == "store_items"
    state["resource_sites"]["chests"] = []
    state["inventory"]["basalt"] = 128
    assert choose_supply_opportunity("S5", state, {}) is None


def test_visible_water_fills_a_bucket_after_s3_only_once_per_source():
    state = world(bucket=1)
    state["resource_sites"]["water_source"] = {"x": 1, "y": 63, "z": 0}
    ledger = {}
    assert choose_supply_opportunity("S3", state, ledger) is None
    step, _ = choose_supply_opportunity("S4", state, ledger)
    assert step.tool == "fill_water_bucket"
    assert choose_supply_opportunity("S4", state, ledger) is None


def test_early_stock_plants_one_available_sapling_without_counting_wood():
    state, ledger = world(oak_sapling=3), {}
    soil = {"x": 2, "y": 64, "z": 0}
    state["resource_sites"]["oak_planting_site"] = soil
    step, _ = choose_supply_opportunity("S1", state, ledger)
    assert step.tool == "place_block" and step.arguments == {"block": "oak_sapling", **soil}
    assert choose_supply_opportunity("S1", state, ledger) is None
    assert state["inventory"] == {"oak_sapling": 3}


def test_prepares_wood_for_shield_and_spare_handles_once_before_entering_mine():
    state = world(oak_log=1, oak_planks=2, stick=3)
    state["surface_access"] = {"connected_land": True}
    ledger = {}
    step, _ = choose_supply_opportunity("S3", state, ledger)
    assert step.arguments["count"] == 3
    assert choose_supply_opportunity("S3", state, ledger) is None
    state["inventory"]["oak_log"] = 3
    assert choose_supply_opportunity("S3", state, {}) is None


def world(**inventory):
    return {"dimension": "overworld", "health": 20, "food": 20, "is_day": True,
            "resource_sites": {}, "inventory_free_slots": 10, "inventory": inventory,
            "position": {"x": 0, "y": 64, "z": 0}, "shelter": {"inside": False},
            "alive": True, "ready": True, "session_id": "supply", "revision": 1,
            "executor": {"safety_active": False, "active_action_id": None}}


def test_bulk_stock_preserves_hard_requirement_and_accounts_for_existing_refined_material():
    step = StepSpec("补铁", "mine_collect", {"block": "iron_ore", "count": 3},
                    {"type": "inventory", "items": {"raw_iron": 3}}, effect_class="replan")
    batched = batch_resource_step("S3", step, world(iron_ingot=8))
    assert batched.arguments == {"block": "iron_ore", "count": 16, "minimum_count": 3}
    assert batched.verify == step.verify
    state = world()
    state["inventory_free_slots"] = 1
    assert batch_resource_step("S3", step, state) == step
    state.pop("resource_sites")
    assert batch_resource_step("S3", step, state) == step


def test_village_is_attempted_once_then_existing_task_can_continue():
    state = world()
    state["resource_sites"] = {"chests": [{"name": "chest", "x": 10, "y": 64, "z": 0}]}
    ledger = {}
    step, key = choose_supply_opportunity("S2", state, ledger)
    assert step.tool == "loot_village" and step.arguments["food_target"] == 8
    assert step.arguments["max_search_steps"] == 0
    assert choose_supply_opportunity("S2", state, ledger) is None
    assert key.startswith("supply:village:")


def test_hay_and_wheat_use_recipe_yields_and_existing_food():
    state = world(hay_block=2, bread=2, crafting_table=1)
    step, _ = choose_supply_opportunity("S2", state, {})
    assert step.arguments == {"item": "wheat", "count": 18}
    state["inventory"] = {"wheat": 18, "bread": 2, "crafting_table": 1}
    step, _ = choose_supply_opportunity("S2", state, {})
    assert step.arguments == {"item": "bread", "count": 6}
    assert step.verify["items"]["bread"] == 8


def test_golem_requires_observation_weapon_blocks_and_food_and_is_not_repeated():
    state = world(iron_sword=1, dirt=3)
    state["resource_sites"] = {"golems": [{"id": 9, "x": 3, "y": 64, "z": 0}]}
    ledger = {}
    step, _ = choose_supply_opportunity("S3", state, ledger)
    assert step.tool == "harvest_iron_golem" and step.arguments == {"entity_id": 9}
    assert choose_supply_opportunity("S3", state, ledger) is None
    state["inventory"]["dirt"] = 2
    assert choose_supply_opportunity("S3", state, {}) is None


@pytest.mark.asyncio
async def test_supervisor_uses_bulk_wood_and_continues_after_empty_village(tmp_path):
    state = world()
    state["resource_sites"] = {"chests": [{"name": "chest", "x": 10, "y": 64, "z": 0}]}
    calls = []
    store = TaskStore(tmp_path / "supply.db")
    store.initialize()
    task = store.create_task("S0 resource policy", "S0")

    async def dispatch(tool, args, timeout_s=0, **kwargs):
        calls.append((tool, args))
        status = "succeeded"
        inv = state["inventory"]
        if tool == "loot_village":
            status = "partial"
        elif tool == "mine_collect":
            assert args["count"] == 8 and args["minimum_count"] < 8
            # 储备未满，但已拿到当前木工具和工作台所需材料。
            inv["oak_log"] = args["minimum_count"]
        elif tool == "craft":
            if args["item"] == "oak_planks":
                consumed = (args["count"] + 3) // 4
                assert inv["oak_log"] >= consumed
                inv["oak_log"] -= consumed
                inv["oak_planks"] = inv.get("oak_planks", 0) + consumed * 4
            else:
                # 这里仅验证监督器路由；配方扣料连续流程由 early_progression 覆盖。
                inv[args["item"]] = inv.get(args["item"], 0) + args["count"]
        else:
            raise AssertionError(tool)
        state["revision"] += 1
        return ActionResult(kwargs["action_id"], True, status=status, data={"observation": deepcopy(state)})

    result = await GoalSupervisor(GOALS["S0"], store, dispatch, lambda: state).run(task.id)
    assert result["status"] == "done", result
    assert sum(tool == "loot_village" for tool, _ in calls) == 1
    assert any(tool == "mine_collect" for tool, _ in calls)
    store.close()

def test_bulk_stock_never_truncates_multistack_hard_target(monkeypatch):
    from voxkin.agent.resource_policy import STOCK_TARGETS
    monkeypatch.setitem(STOCK_TARGETS, "S3", {"iron_ore": 100})
    step = StepSpec("补铁", "mine_collect", {"block": "iron_ore", "count": 90},
                    {"type": "inventory", "items": {"raw_iron": 90}}, effect_class="replan")
    result = batch_resource_step("S3", step, world())
    assert result.arguments["count"] == 100
    assert result.arguments["minimum_count"] == 90
    assert result.verify == step.verify
