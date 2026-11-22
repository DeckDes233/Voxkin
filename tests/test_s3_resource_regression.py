import pytest

from voxkin.agent.goal_methods import choose_s3_preflight_action, choose_s3_resource_action


def _s3_state(inventory: dict[str, int]) -> dict:
    return {
        "dimension": "overworld",
        "position": {"x": -33.5, "y": 73.9, "z": 130.5},
        "health": 20,
        "food": 18,
        "is_day": True,
        "inventory": inventory,
        "shelter": {
            "position": {"x": -34, "y": 72, "z": 130},
            "size": 4,
            "inside": False,
            "sealed": False,
        },
        "executor": {"safety_active": False},
    }


@pytest.mark.parametrize(
    ("planks", "logs", "missing"),
    [(2, 1, 4), (1, 2, 5)],
)
def test_s3_plank_craft_count_is_desired_output_quantity(planks: int, logs: int, missing: int):
    state = _s3_state(
        {
            "porkchop": 4,
            "crafting_table": 1,
            "stone_pickaxe": 1,
            "stick": 3,
            "oak_planks": planks,
            "oak_log": logs,
        }
    )

    ready, step = choose_s3_preflight_action(state, {})

    assert ready is False
    assert step is not None
    assert step.tool == "craft"
    assert step.arguments == {"item": "oak_planks", "count": missing}
    assert step.verify == {"type": "inventory", "items": {"oak_planks": 6}}


def test_s3_stick_craft_count_is_desired_output_quantity():
    state = _s3_state(
        {
            "porkchop": 4,
            "crafting_table": 1,
            "stone_pickaxe": 1,
            "oak_planks": 6,
        }
    )

    ready, step = choose_s3_preflight_action(state, {})

    assert ready is False
    assert step is not None
    assert step.tool == "craft"
    assert step.arguments == {"item": "stick", "count": 3}
    assert step.verify == {"type": "inventory", "items": {"stick": 3}}


def test_s3_night_shift_can_use_the_saved_mine_inventory_without_returning_to_surface():
    state = _s3_state({"raw_iron": 12, "furnace": 1, "stick": 5, "oak_planks": 4,
                       "wooden_pickaxe": 1, "cobblestone": 105, "mutton": 6})
    state.update(is_day=False, resource_sites={}, collection_within_reach=True,
                 position={"x": -41, "y": 46, "z": 127})
    ledger = {}

    def choose():
        ready, step = choose_s3_preflight_action(state, ledger)
        return choose_s3_resource_action(state, ledger) if ready else step

    assert choose().arguments == {"block": "coal_ore", "count": 16, "minimum_count": 1,
                                  "range": 48, "within_reach": True}
    ledger["s3_coal_search_attempted"] = True
    assert choose() is None
    assert "夜间" in ledger["s3_preflight_wait_reason"]
    state["inventory"]["coal"] = 1
    assert choose().arguments == {"item": "raw_iron", "count": 8, "output": "iron_ingot", "fuel": "coal"}
    state["inventory"].update(raw_iron=4, iron_ingot=8, coal=0)
    assert choose().arguments["item"] == "crafting_table"
    state["inventory"].update(crafting_table=1, oak_planks=0)
    for item, ingots, sticks in [("iron_pickaxe", 3, 2), ("iron_sword", 2, 1), ("bucket", 3, 0)]:
        assert choose().arguments["item"] == item
        state["inventory"][item] = 1
        state["inventory"]["iron_ingot"] -= ingots
        state["inventory"]["stick"] -= sticks
    assert choose() is None and "夜间" in ledger["s3_preflight_wait_reason"]


def test_s3_packs_fuel_before_leaving_daylight_and_uses_hunger_gate():
    state = _s3_state({"stone_pickaxe": 1, "crafting_table": 1, "stick": 3,
                       "oak_planks": 6, "porkchop": 4})
    state.update(resource_sites={}, collection_within_reach=True)
    assert choose_s3_preflight_action(state, {})[1].arguments == {
        "block": "wood_log", "count": 2, "range": 64, "within_reach": True,
    }
    ledger = {"counters": {"attempts": {"s3:surface_fuel_wood": 1}}}
    assert choose_s3_preflight_action(state, ledger) == (True, None)
    state["inventory"]["coal"] = 2
    assert choose_s3_preflight_action(state, {}) == (True, None)
    state.update(food=9)
    assert choose_s3_preflight_action(state, {})[1].tool == "eat_if_hungry"
