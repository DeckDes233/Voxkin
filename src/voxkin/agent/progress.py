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
        title="铁装、盾与空桶",
        goals=("挖铁", "熔炼铁锭", "合成铁镐、铁剑、盾与空桶"),
        requires={"stone_pickaxe": 1, "furnace": 1},
        produces={"iron_pickaxe": 1, "iron_sword": 1, "shield": 1, "bucket": 1},
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
        produces={"blaze_rod": 12, "ender_pearl": 24},
    ),
    Stage(
        id="S6",
        title="要塞与末地",
        goals=("找到要塞", "激活末地门", "击败末影龙"),
        requires={"blaze_rod": 12, "ender_pearl": 24},
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


def is_complete(
    stage: Stage,
    inventory: dict[str, int],
    completed_events: set[str] | frozenset[str] = frozenset(),
) -> bool:
    if stage.event:
        return stage.event in completed_events
    return all(_count_item(inventory, item) >= count for item, count in stage.produces.items())


def _count_item(inventory: dict[str, int], item: str) -> int:
    # 床与羊毛在 1.21 里都按颜色拆成独立物品 ID；阶段目标只关心类别。
    if item == "bed":
        return sum(
            count
            for name, count in inventory.items()
            if name == "bed" or name.endswith("_bed")
        )
    if item == "bucket":
        return sum(
            count
            for name, count in inventory.items()
            if name in {"bucket", "water_bucket", "lava_bucket"}
        )
    return inventory.get(item, 0)


def missing_items(stage: Stage, inventory: dict[str, int]) -> dict[str, int]:
    return {
        item: count - _count_item(inventory, item)
        for item, count in stage.produces.items()
        if _count_item(inventory, item) < count
    }


def current_stage(
    inventory: dict[str, int],
    completed_events: set[str] | frozenset[str] = frozenset(),
) -> Stage:
    for stage in STAGES:
        if not is_complete(stage, inventory, completed_events):
            return stage
    return STAGES[-1]
