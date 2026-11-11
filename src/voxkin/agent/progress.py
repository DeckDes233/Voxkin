from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from voxkin.agent.goals import GOALS, evaluate_condition, inventory_count


@dataclass(frozen=True)
class Stage:
    id: str
    title: str
    goals: tuple[str, ...]

    @property
    def requires(self) -> dict[str, int]:
        return _STAGE_REQUIRES.get(self.id, {})

    @property
    def produces(self) -> dict[str, int]:
        return _inventory_target(GOALS[self.id].acceptance)

    @property
    def event(self) -> str:
        condition = GOALS[self.id].acceptance
        if condition.get("type") == "event":
            return str(condition.get("event") or "")
        if condition.get("type") == "all":
            return next(
                (
                    str(item.get("event") or "")
                    for item in condition.get("conditions") or []
                    if item.get("type") == "event"
                ),
                "",
            )
        return ""


_STAGE_REQUIRES: dict[str, dict[str, int]] = {
    "S0": {},
    "S1": {"wooden_pickaxe": 1},
    "S2": {"stone_pickaxe": 1},
    "S3": {"stone_pickaxe": 1, "furnace": 1},
    "S4": {"iron_pickaxe": 1},
    "S5": {"diamond_pickaxe": 1},
    "S6": {"blaze_rod": 12, "ender_pearl": 24},
}

STAGES: tuple[Stage, ...] = (
    Stage("S0", "木头与工作台", ("收集木头", "合成木板", "合成工作台", "合成木镐")),
    Stage("S1", "石制工具与熔炉", ("挖石头", "合成石镐与石剑", "合成熔炉")),
    Stage("S2", "准备过夜", ("确保饥饿值", "逐格封闭庇护所", "庇护所内有床", "夜晚睡到天亮")),
    Stage("S3", "铁装、盾与空桶", ("挖铁", "熔炼铁锭", "合成铁镐、铁剑、盾与空桶")),
    Stage("S4", "钻石与钻石镐", ("挖钻石", "合成钻石镐")),
    Stage("S5", "下界与末影珍珠", ("造下界门", "获取烈焰棒", "获取末影珍珠")),
    Stage("S6", "要塞与末地", ("找到要塞", "激活末地门", "击败末影龙")),
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
    *,
    state: dict[str, Any] | None = None,
    context: dict[str, Any] | None = None,
) -> bool:
    observation = dict(state or {})
    observation.setdefault("inventory", inventory)
    complete, _ = evaluate_condition(
        GOALS[stage.id].acceptance,
        observation,
        completed_events=completed_events,
        context=context,
    )
    return complete


def missing_items(stage: Stage, inventory: dict[str, int]) -> dict[str, int]:
    missing = {
        item: int(count) - inventory_count(inventory, item)
        for item, count in stage.produces.items()
        if inventory_count(inventory, item) < int(count)
    }
    condition = GOALS[stage.id].acceptance
    observation = {"inventory": inventory}
    complete, _ = evaluate_condition(condition, observation)
    if not complete and _requires_world_evidence(condition):
        # 保留 inventory-only API，但用明示项表达验收条件还缺世界观察证据。
        missing["_acceptance_condition"] = 1
    return missing


def _requires_world_evidence(condition: dict[str, Any]) -> bool:
    kind = condition.get("type")
    if kind in {"all", "any"}:
        return any(
            _requires_world_evidence(item)
            for item in condition.get("conditions") or []
        )
    return kind not in {"inventory", "inventory_any"}


def _inventory_target(condition: dict[str, Any]) -> dict[str, int]:
    if condition.get("type") == "inventory":
        return {str(item): int(count) for item, count in (condition.get("items") or {}).items()}
    if condition.get("type") == "all":
        combined: dict[str, int] = {}
        for nested in condition.get("conditions") or []:
            combined.update(_inventory_target(nested))
        return combined
    return {}


def current_stage(
    inventory: dict[str, int],
    completed_events: set[str] | frozenset[str] = frozenset(),
    *,
    state: dict[str, Any] | None = None,
    context: dict[str, Any] | None = None,
) -> Stage:
    for stage in STAGES:
        if not is_complete(
            stage,
            inventory,
            completed_events,
            state=state,
            context=context,
        ):
            return stage
    return STAGES[-1]
