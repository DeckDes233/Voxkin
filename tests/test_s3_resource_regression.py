import pytest

from voxkin.agent.goal_methods import choose_s3_preflight_action


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
