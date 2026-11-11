from __future__ import annotations


# 这些方法可以安全地按新观察中的净缺口重选；其余中断动作必须有明确后置证据。
REPLAN_EFFECT_TOOLS = frozenset(
    {
        "collect_blocks",
        "mine_collect",
        "collect_flint",
        "collect_obsidian",
        "collect_blaze_rods",
        "hunt_animal",
        "hunt_enderman",
        "hunt_material",
        "shear_sheep",
        "craft",
        "craft_bed",
        "craft_tool_set",
        "craft_torch",
        "smelt",
        "smelt_batch",
        "make_shelter",
        "eat",
        "eat_if_hungry",
        "place_block",
    }
)


def action_effect_class(tool: str, declared: str = "") -> str:
    if declared in {"replan", "idempotent", "non_replayable"}:
        return declared
    return "replan" if tool in REPLAN_EFFECT_TOOLS else "non_replayable"
