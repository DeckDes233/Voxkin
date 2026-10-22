from __future__ import annotations

from voxkin.agent.runner import StepSpec

S0_STEPS: tuple[StepSpec, ...] = (
    StepSpec(
        "收集 3 个橡木",
        "collect_blocks",
        {"block": "oak_log", "count": 3, "range": 64},
        {"type": "inventory", "items": {"oak_log": 3}},
        retries=1,
        timeout_s=240,
    ),
    StepSpec(
        "合成木板",
        "craft",
        {"item": "oak_planks", "count": 12},
        {"type": "inventory", "items": {"oak_planks": 12}},
        retries=1,
        timeout_s=30,
    ),
    StepSpec(
        "合成工作台",
        "craft",
        {"item": "crafting_table", "count": 1},
        {"type": "inventory", "items": {"crafting_table": 1}},
        retries=1,
        timeout_s=30,
    ),
    StepSpec(
        "合成木棍",
        "craft",
        {"item": "stick", "count": 4},
        {"type": "inventory", "items": {"stick": 4}},
        retries=1,
        timeout_s=30,
    ),
    StepSpec(
        "合成木镐",
        "craft",
        {"item": "wooden_pickaxe", "count": 1},
        {"type": "inventory", "items": {"wooden_pickaxe": 1}},
        retries=1,
        timeout_s=30,
    ),
)

PLANS = {
    "S0": S0_STEPS,
}
