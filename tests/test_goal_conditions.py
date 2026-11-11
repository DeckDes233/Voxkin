from __future__ import annotations

import pytest

from voxkin.agent.goals import GOALS, evaluate_condition


@pytest.mark.parametrize(
    ("actual", "expected"),
    [
        ("overworld", "minecraft:overworld"),
        ("minecraft:overworld", "overworld"),
        ("the_nether", "minecraft:the_nether"),
        ("minecraft:the_nether", "the_nether"),
        ("the_end", "minecraft:the_end"),
        ("minecraft:the_end", "the_end"),
    ],
)
def test_dimension_condition_accepts_bare_and_vanilla_namespaced_ids(actual: str, expected: str) -> None:
    passed, _ = evaluate_condition(
        {"type": "dimension", "value": expected},
        {"dimension": actual},
    )

    assert passed


def test_dimension_condition_does_not_alias_custom_namespace_to_vanilla() -> None:
    passed, _ = evaluate_condition(
        {"type": "dimension", "value": "minecraft:the_end"},
        {"dimension": "custom:the_end"},
    )

    assert not passed


def test_dimension_condition_preserves_exact_custom_namespace_ids() -> None:
    passed, _ = evaluate_condition(
        {"type": "dimension", "value": "custom:the_end"},
        {"dimension": "custom:the_end"},
    )

    assert passed


def test_s2_empty_observed_beds_cannot_be_overridden_by_legacy_shelter_flag() -> None:
    passed, detail = evaluate_condition(
        GOALS["S2"].acceptance,
        {
            "dimension": "minecraft:overworld",
            "alive": True,
            "health": 20,
            "food": 18,
            "is_day": True,
            "shelter": {
                "sealed": True,
                "inside": True,
                "bed_inside": True,
                "position": {"x": 0, "y": 64, "z": 0},
                "size": 4,
            },
            "nearby_beds": [],
        },
    )

    assert not passed
    assert "没有可见床" in detail


@pytest.mark.parametrize(
    ("bucket_items", "expected"),
    [
        ({"water_bucket": 1}, False),
        ({"lava_bucket": 1}, False),
        ({"bucket": 1}, True),
        ({"bucket": 1, "water_bucket": 1, "lava_bucket": 1}, True),
    ],
)
def test_s3_acceptance_requires_an_empty_bucket(bucket_items: dict[str, int], expected: bool) -> None:
    inventory = {
        "iron_pickaxe": 1,
        "iron_sword": 1,
        "shield": 1,
        **bucket_items,
    }

    passed, _ = evaluate_condition(GOALS["S3"].acceptance, {"inventory": inventory})

    assert passed is expected
