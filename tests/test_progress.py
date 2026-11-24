from __future__ import annotations

from voxkin.agent.progress import (
    STAGES,
    current_stage,
    is_complete,
    missing_items,
    next_stage,
    stage_by_id,
)


def test_stage_order() -> None:
    assert [stage.id for stage in STAGES] == ["S0", "S1", "S2", "S3", "S4", "S5", "S6"]


def test_stage_lookup() -> None:
    assert stage_by_id("S0") is not None
    assert stage_by_id("S9") is None
    assert next_stage("S0").id == "S1"
    assert next_stage("S6") is None


def test_completion() -> None:
    stage = stage_by_id("S0")
    assert stage is not None
    assert not is_complete(stage, {})
    assert not is_complete(stage, {"wooden_pickaxe": 1})
    assert is_complete(stage, {"wooden_pickaxe": 1, "crafting_table": 1})


def test_missing_items() -> None:
    stage = stage_by_id("S1")
    assert stage is not None
    assert missing_items(stage, {"stone_pickaxe": 1}) == {
        "stone_sword": 1,
        "furnace": 1,
    }


def test_current_stage_advances() -> None:
    assert current_stage({}).id == "S0"
    inventory = {
        "wooden_pickaxe": 1,
        "crafting_table": 1,
        "stone_pickaxe": 1,
        "stone_sword": 1,
        "furnace": 1,
        "bed": 1,
        "cooked_beef": 3,
    }
    prepared_state = {
        "alive": True,
        "health": 20,
        "food": 12,
        "dimension": "overworld",
        "is_day": True,
        "inventory": inventory,
        "shelter": {
            "position": {"x": 0, "y": 64, "z": 0},
            "size": 4,
            "sealed": True,
            "inside": True,
            "bounds": {"min": {"x": -2, "y": 64, "z": -2}, "max": {"x": 1, "y": 67, "z": 1}},
        },
        "nearby_beds": [{"x": 0, "y": 65, "z": 0}],
    }
    assert current_stage(inventory, state=prepared_state).id == "S3"


def test_s2_requires_fresh_structural_shelter_and_placed_bed_evidence() -> None:
    stage = stage_by_id("S2")
    assert stage is not None
    inventory = {"red_bed": 1}
    assert not is_complete(stage, inventory)
    state = {
        "alive": True,
        "health": 20,
        "food": 8,
        "dimension": "overworld",
        "is_day": True,
        "inventory": inventory,
        "shelter": {
            "position": {"x": 0, "y": 64, "z": 0},
            "size": 4,
            "sealed": True,
            "inside": True,
            "bounds": {"min": {"x": -2, "y": 64, "z": -2}, "max": {"x": 1, "y": 67, "z": 1}},
        },
        "nearby_beds": [{"x": 0, "y": 65, "z": 0}],
    }
    assert is_complete(stage, inventory, state=state)
    state["nearby_beds"] = [{"x": 1, "y": 65, "z": 1}]
    assert not is_complete(stage, inventory, state=state)


def test_s2_night_observation_requires_safe_night_evidence_and_finite_needs() -> None:
    stage = stage_by_id("S2")
    assert stage is not None
    state = {
        "alive": True,
        "health": 20,
        "food": 12,
        "dimension": "overworld",
        "is_day": False,
        "shelter": {
            "position": {"x": 0, "y": 64, "z": 0},
            "size": 4,
            "sealed": True,
            "inside": True,
            "bounds": {"min": {"x": -2, "y": 64, "z": -2}, "max": {"x": 1, "y": 67, "z": 1}},
        },
        "nearby_beds": [{"x": 0, "y": 65, "z": 0}],
    }
    context: dict[str, bool] = {}
    assert not is_complete(stage, {}, state=state, context=context)
    assert context["night_required"] is True
    assert is_complete(stage, {}, state=state, context={"sleep_confirmed": True}) is False
    state["is_day"] = True
    assert is_complete(
        stage, {}, state=state, context={"night_required": True, "guarded_night_confirmed": True}
    )
    state["food"] = float("nan")
    assert not is_complete(
        stage, {}, state=state, context={"night_required": True, "guarded_night_confirmed": True}
    )


def test_nether_stage_budget_matches_eyes_for_search_and_end_portal() -> None:
    stage = stage_by_id("S5")
    end_stage = stage_by_id("S6")
    assert stage is not None and end_stage is not None
    assert stage.produces == {"blaze_rod": 12, "ender_pearl": 24}
    assert end_stage.requires == stage.produces
    assert not is_complete(stage, {"blaze_rod": 7, "ender_pearl": 16})
    assert not is_complete(stage, {"blaze_rod": 12, "ender_pearl": 24})
    assert missing_items(stage, {"blaze_rod": 12, "ender_pearl": 24}) == {"_acceptance_condition": 1}
    assert is_complete(
        stage,
        {"blaze_rod": 12, "ender_pearl": 24},
        state={"dimension": "overworld"},
    )


def test_end_stage_needs_an_event() -> None:
    stage = stage_by_id("S6")
    assert stage is not None
    assert not is_complete(stage, {})
    assert not is_complete(stage, {}, {"ender_dragon_killed"})
    assert missing_items(stage, {}) == {"_acceptance_condition": 1}
    assert is_complete(
        stage,
        {},
        {"ender_dragon_killed"},
        state={"dimension": "overworld"},
    )
