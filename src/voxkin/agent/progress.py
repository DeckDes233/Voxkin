from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Stage:
    id: str
    title: str
    goals: tuple[str, ...]
    requires: dict[str, int]
    produces: dict[str, int]
    event: str = ""


STAGES: tuple[Stage, ...] = (
    Stage(
        id="S0",
        title="木头与工作台",
        goals=("收集木头", "合成木板", "合成工作台", "合成木镐"),
        requires={},
        produces={"wooden_pickaxe": 1, "crafting_table": 1},
    ),
    Stage(
        id="S1",
        title="石制工具与熔炉",
        goals=("挖石头", "合成石镐与石剑", "合成熔炉"),
        requires={"wooden_pickaxe": 1},
        produces={"stone_pickaxe": 1, "stone_sword": 1, "furnace": 1},
    ),
    Stage(
        id="S2",
        title="食物与庇护所",
        goals=("获得食物", "建临时庇护所", "准备床"),
        requires={"stone_pickaxe": 1},
        produces={"bed": 1, "cooked_beef": 3},
    ),
    Stage(
        id="S3",
        title="铁装与盾",
        goals=("挖铁", "熔炼铁锭", "合成铁镐、铁剑与盾"),
        requires={"stone_pickaxe": 1, "furnace": 1},
        produces={"iron_pickaxe": 1, "iron_sword": 1, "shield": 1},
    ),
    Stage(
        id="S4",
        title="钻石与钻石镐",
        goals=("挖钻石", "合成钻石镐"),
        requires={"iron_pickaxe": 1},
        produces={"diamond_pickaxe": 1},
    ),
    Stage(
        id="S5",
        title="下界与末影珍珠",
        goals=("造下界门", "获取烈焰棒", "获取末影珍珠"),
        requires={"diamond_pickaxe": 1},
        produces={"blaze_rod": 7, "ender_pearl": 16},
    ),
    Stage(
        id="S6",
        title="要塞与末地",
        goals=("找到要塞", "激活末地门", "击败末影龙"),
        requires={"blaze_rod": 7, "ender_pearl": 16},
        produces={},
        event="ender_dragon_killed",
    ),
)


def stage_by_id(stage_id: str) -> Stage | None:
    for stage in STAGES:
        if stage.id == stage_id:
            return stage
    return None


def next_stage(stage_id: str) -> Stage | None:
    for index, stage in enumerate(STAGES):
        if stage.id == stage_id:
            return STAGES[index + 1] if index + 1 < len(STAGES) else None
    return None


def is_complete(stage: Stage, inventory: dict[str, int]) -> bool:
    if stage.event:
        return False
    return all(inventory.get(item, 0) >= count for item, count in stage.produces.items())


def missing_items(stage: Stage, inventory: dict[str, int]) -> dict[str, int]:
    return {
        item: count - inventory.get(item, 0)
        for item, count in stage.produces.items()
        if inventory.get(item, 0) < count
    }


def current_stage(inventory: dict[str, int]) -> Stage:
    for stage in STAGES:
        if not is_complete(stage, inventory):
            return stage
    return STAGES[-1]
