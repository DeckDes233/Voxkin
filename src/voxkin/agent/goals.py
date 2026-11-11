from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Any

from voxkin.agent.plans import AUX_PLANS, PLANS
from voxkin.agent.runner import StepSpec


GOAL_IMMUTABLE_STATES = frozenset({"done"})
GOAL_AUTO_TERMINAL_STATES = frozenset({"done", "paused_by_user", "cancelled", "blocked", "failed"})


def goal_state_blocks_automatic_transition(status: Any) -> bool:
    """终态或用户暂停状态只能由明确入口改变，自动观察/中断不能覆盖。"""
    return str(status or "") in GOAL_AUTO_TERMINAL_STATES


@dataclass(frozen=True)
class GoalBudget:
    max_actions: int = 120
    max_elapsed_s: float = 7200.0
    max_attempts_per_method: int = 3
    max_transport_recoveries: int = 8


@dataclass(frozen=True)
class GoalSpec:
    goal_id: str
    stage: str
    title: str
    acceptance: dict[str, Any]
    method_id: str
    budget: GoalBudget = GoalBudget()


@dataclass(frozen=True)
class MethodSpec:
    method_id: str
    stage: str
    steps: tuple[StepSpec, ...]
    strategy: str = "linear_reconcile"


_STAGE_ACCEPTANCE: dict[str, dict[str, Any]] = {
    "S0": {"type": "inventory", "items": {"wooden_pickaxe": 1, "crafting_table": 1}},
    "S1": {"type": "inventory", "items": {"stone_pickaxe": 1, "stone_sword": 1, "furnace": 1}},
    "S2": {"type": "s2_prepared", "min_food": 8},
    "S3": {"type": "inventory", "items": {"iron_pickaxe": 1, "iron_sword": 1, "shield": 1, "bucket": 1}},
    "S4": {"type": "inventory", "items": {"diamond_pickaxe": 1}},
    "S5": {
        "type": "all",
        "conditions": [
            {"type": "inventory", "items": {"blaze_rod": 12, "ender_pearl": 24}},
            {"type": "dimension", "value": "overworld"},
        ],
    },
    "S6": {
        "type": "all",
        "conditions": [
            {"type": "event", "event": "ender_dragon_killed"},
            {"type": "dimension", "value": "overworld"},
        ],
    },
}

_STAGE_TITLES = {
    "S0": "木头与工作台",
    "S1": "石制工具与熔炉",
    "S2": "准备过夜",
    "S3": "铁制工具、盾与空桶",
    "S4": "钻石与钻石镐",
    "S5": "下界与末影珍珠",
    "S6": "要塞与末地",
}

GOALS: dict[str, GoalSpec] = {
    stage: GoalSpec(
        goal_id=f"stage:{stage.lower()}",
        stage=stage,
        title=_STAGE_TITLES[stage],
        acceptance=rule,
        method_id=(
            "s2_adaptive" if stage == "S2" else
            "s3_ore_adaptive" if stage == "S3" else
            "s4_diamond_adaptive" if stage == "S4" else
            f"plan:{stage.lower()}"
        ),
        budget=GoalBudget(
            max_actions=48 if stage == "S2" else 120,
            max_elapsed_s=1800.0 if stage == "S2" else 14400.0,
            max_attempts_per_method=3,
        ),
    )
    for stage, rule in _STAGE_ACCEPTANCE.items()
}


def goal_for_stage(stage: str) -> GoalSpec | None:
    return GOALS.get(stage)


def method_for_goal(goal: GoalSpec) -> MethodSpec:
    if goal.stage == "S2":
        return MethodSpec("s2_adaptive", "S2", (), strategy="s2_survival")
    if goal.stage == "S3":
        return MethodSpec("s3_ore_adaptive", "S3", (), strategy="s3_resource_reconciliation")
    if goal.stage == "S4":
        return MethodSpec("s4_diamond_adaptive", "S4", (), strategy="s4_resource_reconciliation")
    steps = PLANS.get(goal.stage) or AUX_PLANS.get(goal.stage)
    if steps is None:
        raise KeyError(f"目标 {goal.goal_id} 没有可执行方法")
    strategy = ("early_inventory_dependencies" if goal.stage in {"S0", "S1"} else
                "late_inventory_dimensions" if goal.stage in {"S5", "S6"} else "linear_reconcile")
    return MethodSpec(goal.method_id, goal.stage, steps, strategy=strategy)


def inventory_count(inventory: dict[str, Any], item: str) -> int:
    if item == "wood_log":
        return sum(int(inventory.get(f"{wood}_log", 0) or 0) for wood in
                   ("oak", "spruce", "birch", "jungle", "acacia", "dark_oak", "mangrove", "cherry"))
    if item == "bed":
        return sum(
            int(count or 0)
            for name, count in inventory.items()
            if name == "bed" or str(name).endswith("_bed")
        )
    if item == "wool":
        return max(
            (int(count or 0) for name, count in inventory.items() if str(name).endswith("_wool")),
            default=0,
        )
    return int(inventory.get(item, 0) or 0)


def _is_day(state: dict[str, Any]) -> bool | None:
    if isinstance(state.get("is_day"), bool):
        return state["is_day"]
    raw_time = state.get("time")
    try:
        ticks = float(raw_time) % 24000.0
    except (TypeError, ValueError):
        return None
    if not math.isfinite(ticks):
        return None
    return ticks < 12541 or ticks > 23458


def _in_shelter_bounds(position: dict[str, Any], shelter: dict[str, Any]) -> bool:
    bounds = shelter.get("bounds")
    if isinstance(bounds, dict):
        minimum = bounds.get("min") or {}
        maximum = bounds.get("max") or {}
        try:
            return all(
                float(minimum[axis]) < float(position[axis]) < float(maximum[axis])
                for axis in "xyz"
            )
        except (KeyError, TypeError, ValueError):
            return False
    # Bridge position 是庇护所中心锚点，bounds 为外墙/屋顶边界。
    center = shelter.get("position") or {}
    try:
        size = int(shelter.get("size"))
        x, y, z = (float(center[axis]) for axis in "xyz")
        px, py, pz = (float(position[axis]) for axis in "xyz")
        minimum_x = x - size // 2
        maximum_x = minimum_x + size - 1
        minimum_z = z - size // 2
        maximum_z = minimum_z + size - 1
        minimum_y = y
        maximum_y = y + 3
        return (
            minimum_x < px < maximum_x
            and minimum_z < pz < maximum_z
            and minimum_y < py < maximum_y
        )
    except (KeyError, TypeError, ValueError):
        return False


def _has_bed_inside(state: dict[str, Any]) -> bool:
    shelter = state.get("shelter")
    if not isinstance(shelter, dict):
        return False
    beds = state.get("nearby_beds")
    if not isinstance(beds, list):
        return shelter.get("bed_inside") is True
    for bed in beds:
        if isinstance(bed, dict) and _in_shelter_bounds(bed, shelter):
            return True
    return False


def _dimension_id(value: Any) -> str:
    dimension = str(value or "").strip()
    vanilla = {
        "overworld": "minecraft:overworld",
        "minecraft:overworld": "minecraft:overworld",
        "the_nether": "minecraft:the_nether",
        "minecraft:the_nether": "minecraft:the_nether",
        "the_end": "minecraft:the_end",
        "minecraft:the_end": "minecraft:the_end",
    }
    return vanilla.get(dimension, dimension)


def evaluate_condition(
    condition: dict[str, Any],
    state: dict[str, Any],
    *,
    completed_events: set[str] | frozenset[str] = frozenset(),
    context: dict[str, Any] | None = None,
) -> tuple[bool, str]:
    """按目标契约中的结构化条件验收，不读动作 detail。"""
    context = context if context is not None else {}
    kind = condition.get("type")
    inventory = state.get("inventory") or {}
    if kind == "all":
        results = [
            evaluate_condition(rule, state, completed_events=completed_events, context=context)
            for rule in condition.get("conditions") or []
        ]
        missing = [reason for ok, reason in results if not ok]
        return not missing, "全部条件满足" if not missing else "；".join(missing)
    if kind == "any":
        results = [
            evaluate_condition(rule, state, completed_events=completed_events, context=context)
            for rule in condition.get("conditions") or []
        ]
        matched = [reason for ok, reason in results if ok]
        return bool(matched), "；".join(matched) if matched else "没有满足的备选条件"
    if kind == "inventory":
        missing = {
            item: int(count) - inventory_count(inventory, item)
            for item, count in (condition.get("items") or {}).items()
            if inventory_count(inventory, item) < int(count)
        }
        return not missing, "背包目标满足" if not missing else f"目标库存缺少 {missing}"
    if kind == "inventory_any":
        items = condition.get("items") or []
        count = sum(inventory_count(inventory, str(item)) for item in items)
        target = int(condition.get("count", 1))
        return count >= target, "备选食物库存满足" if count >= target else f"备选库存还差 {target - count}"
    if kind == "event":
        event = str(condition.get("event") or "")
        return event in completed_events, f"事件 {'已记录' if event in completed_events else '未记录'}：{event}"
    if kind == "dimension":
        actual = str(state.get("dimension") or "")
        expected = str(condition.get("value") or "")
        return _dimension_id(actual) == _dimension_id(expected), f"维度 {actual or '未知'}"
    if kind == "s2_prepared":
        reasons: list[str] = []
        dimension = str(state.get("dimension") or "")
        if _dimension_id(dimension) != "minecraft:overworld":
            reasons.append("不在主世界")
        if state.get("alive") is not True:
            reasons.append("角色未确认存活")
        try:
            health = float(state.get("health", 0))
        except (TypeError, ValueError):
            health = 0
        if not math.isfinite(health) or health <= 0:
            reasons.append("血量无效")
        try:
            food = float(state.get("food", 0))
        except (TypeError, ValueError):
            food = 0
        if not math.isfinite(food) or food < float(condition.get("min_food", 8)):
            reasons.append(f"饥饿值低于 {condition.get('min_food', 8):g}")
        shelter = state.get("shelter") or {}
        if shelter.get("sealed") is not True:
            reasons.append("庇护所未逐格确认封闭")
        if shelter.get("inside") is not True:
            reasons.append("角色不在庇护所内")
        if not _has_bed_inside(state):
            reasons.append("庇护所内没有可见床")
        is_day = _is_day(state)
        if is_day is False:
            context["night_required"] = True
        if context.get("night_required") and (
            is_day is not True
            or not (context.get("sleep_confirmed") is True or context.get("guarded_night_confirmed") is True)
        ):
            reasons.append("夜间目标需要睡眠或安全守夜回执与天亮状态")
        return not reasons, "准备过夜目标满足" if not reasons else "；".join(reasons)
    return False, f"未知目标条件 {kind}"
