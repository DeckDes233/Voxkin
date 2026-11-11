from __future__ import annotations

import math
from dataclasses import replace
from typing import Any

from voxkin.agent.goal_methods import (
    FOOD_ITEMS, S3_FUEL_BURN, S3_MINING_PICKAXES, early_craft, early_planks,
    _s3_needs_surface_route, _s3_return_to_known_surface,
)
from voxkin.agent.goals import inventory_count
from voxkin.agent.plans import S5_STEPS, S6_STEPS
from voxkin.agent.runner import StepSpec


def prepare_late_action(step: StepSpec | None, index: int | None, state: dict, ledger: dict) -> tuple[StepSpec | None, int | None]:
    ledger.pop("late_game_wait_reason", None)
    if step is None:
        return None, index
    combat = step.tool in {"hunt_animal", "hunt_material", "hunt_enderman", "raid_fortress", "collect_blaze_rods", "fight_dragon"}
    if combat and isinstance(state.get("health"), (int, float)) and state["health"] <= 10:
        inventory = state.get("inventory") or {}
        if state.get("food", 20) < 20 and any(inventory_count(inventory, name) for name in FOOD_ITEMS):
            return StepSpec("战斗前进食以恢复血量", "eat_if_hungry", {"threshold": 20, "count": 0},
                            {"type": "food", "min": 20}, retries=2, timeout_s=60, effect_class="replan"), None
        ledger["late_game_wait_reason"] = "血量不足，先由安全控制撤离并等待恢复"
        return None, None
    if step.tool == "mine_collect" and step.arguments.get("block") == "stone" and (state.get("position") or {}).get("y", 64) < 0:
        target = step.arguments["count"]
        step = replace(step, arguments={**step.arguments, "block": "deepslate"},
                       verify={"type": "inventory", "items": {"cobbled_deepslate": target}})
    outdoor = step.tool in {"hunt_animal", "hunt_material", "hunt_enderman", "prepare_bow_arrows"} or (
        step.tool == "mine_collect" and step.arguments.get("block") == "wood_log"
    )
    if outdoor and str(state.get("dimension") or "").removeprefix("minecraft:") == "overworld" and _s3_needs_surface_route(state):
        ledger.pop("s3_preflight_terminal_reason", None)
        ledger.pop("s3_preflight_wait_reason", None)
        route = _s3_return_to_known_surface(state, ledger)
        if route is None:
            ledger["late_game_block_reason"] = ledger.get("s3_preflight_terminal_reason")
            ledger["late_game_wait_reason"] = ledger.get("s3_preflight_wait_reason")
        return route, None
    return step, index


def action(tool: str, arguments: dict, items: dict, description: str, timeout: float = 250) -> StepSpec:
    return StepSpec(description, tool, arguments, {"type": "inventory", "items": items},
                    retries=2, timeout_s=timeout, effect_class="replan")


def ingot_dependency(inventory: dict, count: int) -> StepSpec | None:
    # 三种石材各有合法配方；只替换规划视图，真实背包和动作验收仍使用原物品。
    stone_inventory = dict(inventory)
    stone_inventory["cobblestone"] = max(inventory_count(inventory, name) for name in ("cobblestone", "cobbled_deepslate", "blackstone"))
    missing = max(0, count - inventory_count(inventory, "iron_ingot"))
    if not missing:
        return None
    if inventory_count(inventory, "raw_iron") < missing:
        if not any(inventory_count(inventory, item) for item in S3_MINING_PICKAXES):
            return early_craft(stone_inventory, "stone_pickaxe")
        return action("mine_collect", {"block": "iron_ore", "count": missing, "range": 64},
                      {"raw_iron": missing}, "补齐打火石或水桶所需铁矿")
    if inventory_count(inventory, "furnace") < 1:
        return early_craft(stone_inventory, "furnace")
    fuel = max(S3_FUEL_BURN, key=lambda name: inventory_count(inventory, name) * S3_FUEL_BURN[name])
    capacity = math.floor(inventory_count(inventory, fuel) * S3_FUEL_BURN[fuel])
    if not capacity:
        return early_planks({name: amount for name, amount in inventory.items()
                             if not name.startswith(("crimson_", "warped_"))}, 2, "熔炼燃料")
    batch = min(8, missing, capacity)
    return action("smelt_batch", {"item": "raw_iron", "count": batch, "output": "iron_ingot", "fuel": fuel},
                  {"iron_ingot": inventory_count(inventory, "iron_ingot") + batch}, "按净缺口熔炼铁锭")


def sustenance(state: dict, *, reserve: int = 0) -> StepSpec | None:
    inventory = state.get("inventory") or {}
    food = state.get("food")
    if not isinstance(food, (int, float)):
        return None
    stock = sum(inventory_count(inventory, name) for name in FOOD_ITEMS)
    if food < 18 and stock:
        return StepSpec("行动前用现有食物恢复", "eat_if_hungry", {"threshold": 18, "count": 0},
                        {"type": "food", "min": 18}, retries=2, timeout_s=60, effect_class="replan")
    if str(state.get("dimension") or "").removeprefix("minecraft:") == "overworld" and (stock < reserve or (food < 12 and not stock)):
        return StepSpec("补足长途探索与战斗的食物", "hunt_animal", {"count": max(3, reserve), "radius": 64, "min_health": 10},
                        {"type": "inventory_any", "items": sorted(FOOD_ITEMS), "count": max(1, reserve)},
                        retries=2, timeout_s=250, effect_class="replan")
    return None


def choose_s5_action(state: dict[str, Any], ledger: dict[str, Any]) -> tuple[StepSpec | None, int | None]:
    inventory = state.get("inventory") or {}
    dimension = str(state.get("dimension") or "").removeprefix("minecraft:")
    rods = inventory_count(inventory, "blaze_rod") >= 12
    pearls = inventory_count(inventory, "ender_pearl") >= 24
    cursor = int(ledger.get("method_index", 0))
    if dimension == "the_nether":
        # 已完成补给或饥饿且无食物时直接返回；不在下界寻找主世界木材、牛羊或圆石。
        food = state.get("food", 20)
        stocked = any(inventory_count(inventory, name) for name in FOOD_ITEMS)
        if (rods and pearls) or (isinstance(food, (int, float)) and food < 12 and not stocked):
            return S5_STEPS[10], 10
        supply = sustenance(state)
        if supply:
            return supply, None
        if not rods:
            routed = cursor >= 8 or any(entry.get("tool") == "raid_fortress" and entry.get("status") == "succeeded"
                                        for entry in ledger.get("action_history", []))
            index = 8 if routed else 7
            return S5_STEPS[index], index
        return S5_STEPS[9], 9
    if dimension != "overworld":
        ledger["late_game_block_reason"] = "S5 需要主世界或下界的新鲜维度观察"
        return None, None
    supply = sustenance(state, reserve=4)
    if supply:
        return supply, None
    if rods:
        return S5_STEPS[9], 9
    # 已确认建门/过门的游标只作为门址提示，nether_travel 仍需实测门块及维度变化。
    if cursor >= 6:
        return S5_STEPS[6], 6
    if inventory_count(inventory, "flint_and_steel") < 1:
        dependency = ingot_dependency(inventory, 1)
        if dependency:
            return dependency, None
        if inventory_count(inventory, "flint") < 1:
            return S5_STEPS[2], 2
        return S5_STEPS[3], 3
    if inventory_count(inventory, "obsidian") < 10:
        if not any(inventory_count(inventory, item) for item in ("diamond_pickaxe", "netherite_pickaxe")):
            ledger["late_game_block_reason"] = "S5 黑曜石路线需要先完成 S4 的钻石镐补给"
            return None, None
        if not inventory_count(inventory, "water_bucket") and not inventory_count(inventory, "bucket"):
            dependency = ingot_dependency(inventory, 3)
            if dependency:
                return dependency, None
            if not inventory_count(inventory, "crafting_table"):
                return early_craft(inventory, "crafting_table"), None
            return action("craft", {"item": "bucket", "count": 1}, {"bucket": 1}, "补回浇铸用桶", 60), None
        return S5_STEPS[4], 4
    return S5_STEPS[5], 5


def choose_s6_action(state: dict[str, Any], ledger: dict[str, Any], completed_events: set[str]) -> tuple[StepSpec | None, int | None]:
    inventory = state.get("inventory") or {}
    dimension = str(state.get("dimension") or "").removeprefix("minecraft:")
    if dimension == "the_end":
        if "ender_dragon_killed" in completed_events:
            return S6_STEPS[10], 10
        supply = sustenance(state)
        # 已进末地不要求重新猎鸡/蜘蛛，也不把用掉一支箭当成必须补回 64 支。
        return (supply, None) if supply else (S6_STEPS[9], 9)
    if dimension == "the_nether":
        return S5_STEPS[10], None
    if dimension != "overworld":
        ledger["late_game_block_reason"] = "S6 需要先从下界返回主世界"
        return None, None
    search = ledger.get("stronghold_search") or {}
    if search.get("phase") == "frames_found":
        # 门框状态、缺眼数量和实际维度变化由激活技能重新读取，不重投用于定位的眼。
        return S6_STEPS[7], 7
    supply = sustenance(state, reserve=4)
    if supply:
        return supply, None
    if not inventory_count(inventory, "bow") and inventory_count(inventory, "string") < 3:
        return S6_STEPS[0], 0
    arrows_missing = max(0, 64 - inventory_count(inventory, "arrow"))
    arrow_recipes = math.ceil(arrows_missing / 4)
    for index, item in ((1, "feather"), (2, "flint")):
        if inventory_count(inventory, item) < arrow_recipes:
            step = S6_STEPS[index]
            return replace(step, arguments={**step.arguments, "count": arrow_recipes},
                           verify={"type": "inventory", "items": {item: arrow_recipes}}), index
    if not inventory_count(inventory, "bow") or arrows_missing:
        return S6_STEPS[3], 3
    eyes_missing = max(0, 24 - inventory_count(inventory, "ender_eye"))
    if inventory_count(inventory, "ender_pearl") < eyes_missing:
        return action("hunt_enderman", {"count": eyes_missing, "radius": 48}, {"ender_pearl": eyes_missing}, "补齐剩余末影之眼所需珍珠", 310), None
    powder_missing = max(0, eyes_missing - inventory_count(inventory, "blaze_powder"))
    if powder_missing:
        if inventory_count(inventory, "blaze_rod") * 2 < powder_missing:
            ledger["late_game_block_reason"] = "缺少烈焰棒，当前库存不足以补齐末影之眼；需恢复 S5 下界补给"
            return None, None
        return action("craft", {"item": "blaze_powder", "count": powder_missing},
                      {"blaze_powder": eyes_missing}, "按现有眼与烈焰粉净缺口合成", 60), 4
    if eyes_missing:
        return action("craft", {"item": "ender_eye", "count": eyes_missing}, {"ender_eye": 24}, "补齐定位和激活所需末影之眼", 60), 5
    return S6_STEPS[6], 6
