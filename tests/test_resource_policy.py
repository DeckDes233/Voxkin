from copy import deepcopy

import pytest

from voxkin.agent.goal_supervisor import GoalSupervisor
from voxkin.agent.goals import GOALS
from voxkin.agent.resource_policy import batch_resource_step, choose_supply_opportunity
from voxkin.agent.runner import StepSpec
from voxkin.agent.tasks import TaskStore
from voxkin.bridge.protocol import ActionResult


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
