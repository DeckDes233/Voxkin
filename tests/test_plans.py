from __future__ import annotations

from voxkin.agent.plans import AUX_PLANS, PLANS
from voxkin.agent.progress import STAGES
from voxkin.agent.skills import find_skill, skill_ids

SUPPORTED_VERIFY = {
    "always",
    "inventory",
    "position",
    "dimension",
    "health",
    "food",
    "daylight",
    "result_event",
}


def all_steps():
    for stage, steps in PLANS.items():
        for step in steps:
            yield stage, step


def test_plans_cover_every_stage() -> None:
    assert set(PLANS) == {stage.id for stage in STAGES}


def test_every_stage_has_steps() -> None:
    for stage, steps in PLANS.items():
        assert steps, stage


def test_every_step_uses_a_manifest_skill() -> None:
    known = skill_ids()
    for stage, step in all_steps():
        assert step.tool in known, (stage, step.tool)


def test_step_arguments_match_skill_parameters() -> None:
    for stage, step in all_steps():
        skill = find_skill(step.tool)
        assert skill is not None, (stage, step.tool)
        allowed = {str(item["name"]) for item in skill["parameters"]}
        unknown = set(step.arguments) - allowed
        assert not unknown, (stage, step.tool, unknown)


def test_step_timeouts_leave_bridge_grace() -> None:
    for stage, step in all_steps():
        # 桥接单动作上限 300 秒；计划略高一点，让 Core 等桥接先回结果。
        assert 5 <= step.timeout_s <= 330, (stage, step.tool, step.timeout_s)


def test_verify_rules_are_supported() -> None:
    for stage, step in all_steps():
        rule = step.verify
        assert rule.get("type") in SUPPORTED_VERIFY, (stage, step.tool, rule)
        if rule["type"] == "inventory":
            assert rule.get("items"), (stage, step.tool)


def test_stage_plans_follow_route_order() -> None:
    assert {"mine_collect", "craft"} <= {step.tool for step in PLANS["S1"]}
    assert "make_shelter" in {step.tool for step in PLANS["S2"]}
    assert "strip_mine" in {step.tool for step in PLANS["S3"]}
    assert "deep_mine" in {step.tool for step in PLANS["S4"]}
    assert {"make_nether_portal", "collect_blaze_rods", "hunt_enderman"} <= {
        step.tool for step in PLANS["S5"]
    }
    assert {"throw_eye", "activate_end_portal", "fight_dragon", "return_home"} <= {
        step.tool for step in PLANS["S6"]
    }


def test_s3_budget_covers_the_iron_set_and_an_empty_bucket() -> None:
    steps = PLANS["S3"]
    smelt = next(step for step in steps if step.tool == "smelt_batch")
    bucket = next(step for step in steps if step.tool == "craft" and step.arguments.get("item") == "bucket")
    assert smelt.arguments["count"] == 9
    assert smelt.verify["items"]["iron_ingot"] == 9
    assert bucket.verify["items"]["bucket"] == 1


def test_s3_progress_keeps_bucket_requirement_after_filling_it_with_water() -> None:
    from voxkin.agent.progress import STAGES, is_complete

    stage = next(stage for stage in STAGES if stage.id == "S3")
    inventory = {
        "iron_pickaxe": 1,
        "iron_sword": 1,
        "shield": 1,
        "water_bucket": 1,
    }
    assert is_complete(stage, inventory)


def test_s5_requires_flint_not_gravel_for_flint_and_steel() -> None:
    steps = PLANS["S5"]
    collect_flint = next(step for step in steps if step.tool == "collect_flint")
    craft_flint_and_steel = next(
        step
        for step in steps
        if step.tool == "craft" and step.arguments.get("item") == "flint_and_steel"
    )

    assert collect_flint.verify == {"type": "inventory", "items": {"flint": 1}}
    assert steps.index(collect_flint) < steps.index(craft_flint_and_steel)
    assert collect_flint.arguments["count"] == 1


def test_s5_collects_enough_materials_for_s6_search_and_portal_frames() -> None:
    """一次最多 12 眼的连续搜索后，仍需为门框预留 12 只眼。"""
    rods = next(step for step in PLANS["S5"] if step.tool == "collect_blaze_rods")
    pearls = next(step for step in PLANS["S5"] if step.tool == "hunt_enderman")
    powder = next(step for step in PLANS["S6"] if step.arguments.get("item") == "blaze_powder")
    eyes = next(step for step in PLANS["S6"] if step.arguments.get("item") == "ender_eye")
    throw_eye = next(step for step in PLANS["S6"] if step.tool == "throw_eye")
    activate_portal = next(step for step in PLANS["S6"] if step.tool == "activate_end_portal")

    assert rods.arguments["count"] == 12
    assert rods.arguments["timeout_s"] == 300
    assert powder.arguments["count"] == eyes.arguments["count"] == 24
    assert rods.arguments["count"] * 2 >= powder.arguments["count"]
    assert pearls.arguments["count"] == eyes.arguments["count"]
    assert throw_eye.arguments["count"] == 12
    assert throw_eye.retries == 0
    assert eyes.arguments["count"] - throw_eye.arguments["count"] >= 12
    assert activate_portal.arguments["timeout_s"] == 180


def test_s6_prepares_a_complete_bow_and_arrow_material_budget_before_stronghold_search() -> None:
    steps = PLANS["S6"]
    string = next(step for step in steps if step.tool == "hunt_material" and step.arguments["item"] == "string")
    feather = next(step for step in steps if step.tool == "hunt_material" and step.arguments["item"] == "feather")
    flint = next(step for step in steps if step.tool == "collect_flint")
    bow_arrows = next(step for step in steps if step.tool == "prepare_bow_arrows")
    throw_eye = next(step for step in steps if step.tool == "throw_eye")
    activate_portal = next(step for step in steps if step.tool == "activate_end_portal")
    end_inventory = next(step for step in steps if step.tool == "inventory")
    dragon = next(step for step in steps if step.tool == "fight_dragon")

    assert string.arguments["count"] == string.verify["items"]["string"] == 3
    assert feather.arguments["count"] == feather.verify["items"]["feather"] == 16
    assert flint.arguments["count"] == flint.verify["items"]["flint"] == 16
    assert bow_arrows.arguments == {"count": 64, "range": 64}
    assert bow_arrows.verify["items"] == {"bow": 1, "arrow": 64}
    material_steps = (string, feather, flint, bow_arrows)
    assert max(steps.index(step) for step in material_steps) < steps.index(throw_eye)
    assert steps.index(activate_portal) < steps.index(end_inventory) < steps.index(dragon)
    assert end_inventory.verify["items"] == {"bow": 1, "arrow": 64}
    assert dragon.verify == {"type": "result_event", "event": "ender_dragon_killed"}
    assert dragon.retries == 1


def test_s5_collects_existing_obsidian_or_casts_it_when_needed() -> None:
    steps = PLANS["S5"]
    collect = next(step for step in steps if step.tool == "collect_obsidian")
    assert collect.verify == {"type": "inventory", "items": {"obsidian": 10}}
    assert collect.arguments == {"count": 10, "range": 64}


def test_night_plan_uses_a_bed_and_a_shelter_that_can_hold_it() -> None:
    """4×4 是能放床的最小尺寸；整夜只能睡过去，不能等 7 分钟。"""
    shelter = next(step for step in PLANS["S2"] if step.tool == "make_shelter")
    dirt = next(
        step
        for step in PLANS["S2"]
        if step.tool == "mine_collect" and step.arguments.get("block") == "dirt"
    )
    assert shelter.arguments["size"] == 4
    assert dirt.arguments["count"] >= 40
    aux_tools = {step.tool for step in AUX_PLANS["M3_SHELTER"] + AUX_PLANS["M3_SLEEP"]}
    assert "sleep_safe" in aux_tools
    assert not any(step.tool == "wait_for_day" for step in AUX_PLANS["M3_SLEEP"])
    assert AUX_PLANS["M3_SLEEP"][0].tool == "eat_if_hungry"
    assert AUX_PLANS["M3_SLEEP"][1].verify == {"type": "daylight", "min_health": 1}


def test_s2_manages_hunger_and_does_not_end_inside_a_sealed_shelter() -> None:
    steps = PLANS["S2"]
    eat_steps = [step for step in steps if step.tool == "eat_if_hungry"]
    shelter = next(step for step in steps if step.tool == "make_shelter")
    leave = next(step for step in steps if step.tool == "leave_shelter")

    assert len(eat_steps) == 2
    assert all(step.verify == {"type": "food", "min": 8} for step in eat_steps)
    assert all(step.arguments["threshold"] == 16 for step in eat_steps)
    assert steps.index(eat_steps[0]) < steps.index(shelter)
    assert steps.index(eat_steps[1]) < steps.index(shelter)
    assert steps.index(leave) == steps.index(shelter) + 1


def test_s2_does_not_depend_on_trees_after_s1() -> None:
    """S0/S1 已把出生点附近的树砍空，S2 只允许补 1 根原木做床。"""
    logs = next(
        step
        for step in PLANS["S2"]
        if step.tool == "mine_collect" and step.arguments.get("block") == "oak_log"
    )
    planks = next(
        step
        for step in PLANS["S2"]
        if step.tool == "craft" and step.arguments.get("item") == "oak_planks"
    )
    assert logs.arguments["count"] == 1
    assert planks.arguments["count"] == 4


def test_s2_hunts_inside_the_supported_radius() -> None:
    hunt = next(step for step in PLANS["S2"] if step.tool == "hunt_animal")
    assert hunt.arguments["radius"] == 64


def test_s2_resource_steps_verify_wool_and_bed_inventory() -> None:
    shears = next(
        step
        for step in PLANS["S2"]
        if step.tool == "craft" and step.arguments.get("item") == "shears"
    )
    wool = next(step for step in PLANS["S2"] if step.tool == "shear_sheep")
    bed = next(step for step in PLANS["S2"] if step.tool == "craft_bed")

    assert shears.arguments["item"] == "shears"
    assert wool.arguments["count"] == 3
    assert wool.timeout_s == 180
    assert wool.verify["items"] == {"wool": 3}
    assert bed.verify["items"] == {"bed": 1}


def test_s2_shears_sheep_instead_of_hunting_them_for_wool() -> None:
    sheep_steps = [
        step
        for step in PLANS["S2"]
        if step.tool == "hunt_animal" and step.arguments.get("species") == "sheep"
    ]
    steps = PLANS["S2"]

    assert sheep_steps == []
    iron = next(
        step
        for step in PLANS["S2"]
        if step.tool == "mine_collect" and step.arguments.get("block") == "iron_ore"
    )
    coal_steps = [
        step
        for step in PLANS["S2"]
        if step.tool == "mine_collect" and step.arguments.get("block") == "coal_ore"
    ]
    fuel = next(
        step
        for step in PLANS["S2"]
        if step.tool == "smelt_batch" and step.arguments.get("item") == "raw_iron"
    )
    shears = next(
        step
        for step in PLANS["S2"]
        if step.tool == "craft" and step.arguments.get("item") == "shears"
    )
    wool = next(step for step in PLANS["S2"] if step.tool == "shear_sheep")

    assert iron.arguments["count"] == 2
    assert [step.arguments["count"] for step in coal_steps] == [2, 2]
    assert fuel.arguments["item"] == "raw_iron"
    assert shears.arguments["item"] == "shears"
    assert steps.index(fuel) < steps.index(shears) < steps.index(wool)


def test_s2_preserves_enough_coal_to_cook_food_and_smelt_iron() -> None:
    steps = PLANS["S2"]
    coal_indices = [
        index
        for index, step in enumerate(steps)
        if step.tool == "mine_collect" and step.arguments.get("block") == "coal_ore"
    ]
    food_smelt = next(
        index for index, step in enumerate(steps)
        if step.tool == "smelt_batch" and step.arguments.get("item") == "beef"
    )
    iron_mine = next(
        index for index, step in enumerate(steps)
        if step.tool == "mine_collect" and step.arguments.get("block") == "iron_ore"
    )
    iron_smelt = next(
        index for index, step in enumerate(steps)
        if step.tool == "smelt_batch" and step.arguments.get("item") == "raw_iron"
    )

    assert len(coal_indices) == 2
    assert steps[coal_indices[0]].arguments["count"] == 2
    assert steps[coal_indices[1]].arguments["count"] == 2
    assert coal_indices[0] < food_smelt < iron_mine < coal_indices[1] < iron_smelt
