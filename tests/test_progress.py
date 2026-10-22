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
    assert current_stage(inventory).id == "S3"


def test_stage_accepts_colored_bed_items() -> None:
    stage = stage_by_id("S2")
    assert stage is not None
    assert is_complete(stage, {"red_bed": 1, "cooked_beef": 3})


def test_end_stage_needs_an_event() -> None:
    stage = stage_by_id("S6")
    assert stage is not None
    assert not is_complete(stage, {})
