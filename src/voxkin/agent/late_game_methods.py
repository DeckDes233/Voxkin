from __future__ import annotations

import math
from dataclasses import replace
from typing import Any

from voxkin.agent.goal_methods import (
    FOOD_ITEMS, S3_FUEL_BURN, S3_MINING_PICKAXES, early_craft, early_planks,
    _danger_now, _s3_needs_surface_route, _s3_return_to_known_surface,
)
from voxkin.agent.goals import inventory_count
from voxkin.agent.plans import S5_STEPS, S6_STEPS
from voxkin.agent.runner import StepSpec


def prepare_late_action(step: StepSpec | None, index: int | None, state: dict, ledger: dict) -> tuple[StepSpec | None, int | None]:
    ledger.pop("late_game_wait_reason", None)
    if step is None:
        return None, index
    needs_health = step.tool in {
        "hunt_animal", "hunt_material", "hunt_enderman", "raid_fortress", "collect_blaze_rods", "fight_dragon",
        "collect_obsidian", "mine_collect", "safe_descend", "strip_mine", "explore_mining_site",
    }
    if needs_health and isinstance(state.get("health"), (int, float)) and state["health"] <= 10:
        inventory = state.get("inventory") or {}
        if state.get("food", 20) < 20 and any(inventory_count(inventory, name) for name in FOOD_ITEMS):
            return StepSpec("先吃一份口粮恢复血量", "eat_if_hungry", {"threshold": 20, "count": 0},
                            {"type": "food", "min": min(20, math.floor(state["food"]) + 1)}, retries=2, timeout_s=60, effect_class="replan"), None
        ledger["late_game_wait_reason"] = "血量不足，先由安全控制撤离并等待恢复"
        return None, None
    if step.tool == "mine_collect" and step.arguments.get("block") == "stone" and (state.get("position") or {}).get("y", 64) < 0:
        target = step.arguments["count"]
        step = replace(step, arguments={**step.arguments, "block": "deepslate"},
                       verify={"type": "inventory", "items": {"cobbled_deepslate": target}})
    outdoor = step.tool in {"hunt_animal", "hunt_material", "hunt_enderman", "prepare_bow_arrows"} or (
        step.tool == "mine_collect" and step.arguments.get("block") == "wood_log"
    )
    surface = state.get("surface_access") or {}
    overworld = str(state.get("dimension") or "").removeprefix("minecraft:") == "overworld"
    exit_position = surface.get("exit")
    route = None
    if outdoor and overworld and state.get("is_day") is True and isinstance(exit_position, dict):
        route = StepSpec("先到已观察的露天地面再搜索", "goto", dict(exit_position),
                         {"type": "position", "target": dict(exit_position), "radius": 2.0, "site": "surface_exit"},
                         retries=2, timeout_s=90, effect_class="replan")
    elif outdoor and overworld and surface.get("sky_light", 0) < 12 and _s3_needs_surface_route(state):
        ledger.pop("s3_preflight_terminal_reason", None)
        ledger.pop("s3_preflight_wait_reason", None)
        route = _s3_return_to_known_surface(state, ledger, staged_supply_route=True)
        if route is None:
            ledger["late_game_block_reason"] = ledger.get("s3_preflight_terminal_reason")
            ledger["late_game_wait_reason"] = ledger.get("s3_preflight_wait_reason")
            return None, None
    if route is not None:
        failures = (ledger.get("counters") or {}).get("method_failures") or {}
        if route.tool == "goto" and failures.get(late_method_key(ledger.get("stage", ""), route)) and not _danger_now(state):
            position = state["position"]
            rise = min(6, math.floor(route.arguments["y"]) - math.floor(position["y"]))
            if rise >= 2:
                dx, dz = route.arguments["x"] - position["x"], route.arguments["z"] - position["z"]
                direction = ("east" if dx > 0 else "west") if abs(dx) > abs(dz) else ("south" if dz > 0 else "north")
                return StepSpec("上行寻路失败，改挖有支撑的短阶梯", "strip_mine",
                                {"rise": rise, "direction": direction},
                                {"type": "min_height", "y": math.floor(position["y"]) + rise},
                                retries=1, timeout_s=160, effect_class="replan"), None
        return route, None
    if step.tool == "hunt_animal" and (state.get("is_day") is False or _hunt_closing(state)):
        ledger["late_game_wait_reason"] = "等天亮后再寻找食物，保留狩猎预算"
        return None, None
    if step.tool == "hunt_animal" and step.arguments.get("walk_only"):
        failures = (ledger.get("counters") or {}).get("method_failures") or {}
        if failures.get(late_method_key(ledger.get("stage", ""), step)):
            step = replace(step, arguments={**step.arguments, "radius": 64})
    return step, index


def action(tool: str, arguments: dict, items: dict, description: str, timeout: float = 250) -> StepSpec:
    return StepSpec(description, tool, arguments, {"type": "inventory", "items": items},
                    retries=2, timeout_s=timeout, effect_class="replan")


def _hunt_closing(state: dict) -> bool:
    tick = state.get("time")
    return isinstance(tick, (float, int)) and tick % 24000 > 10000


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
                        {"type": "food", "min": min(18, math.floor(food) + 1)}, retries=2, timeout_s=60, effect_class="replan")
    if str(state.get("dimension") or "").removeprefix("minecraft:") == "overworld" and (stock < reserve or (food < 12 and not stock)):
        raw = sum(inventory_count(inventory, name) for name in ("beef", "porkchop", "mutton", "chicken", "rabbit"))
        arguments = {"count": raw + 1, "radius": 64, "min_health": 10}
        if food < 8 and not stock:
            arguments.update(radius=24, walk_only=True)
        return StepSpec("先取得一份新口粮，再按实际库存继续备粮", "hunt_animal", arguments,
                        {"type": "inventory_any", "items": sorted(FOOD_ITEMS), "count": stock + 1},
                        retries=2, timeout_s=250, effect_class="replan")
    return None


def late_method_key(stage: str, step: StepSpec, position: dict | None = None) -> str:
    prefix = stage.lower()
    if step.tool == "goto" and step.verify.get("site") == "surface_exit":
        target = step.arguments
        return f"{prefix}:surface_exit:{math.floor(target['x'] / 8)}:{math.floor(target['y'] / 4)}:{math.floor(target['z'] / 8)}"
    if step.tool == "strip_mine" and step.arguments.get("rise"):
        return f"{prefix}:ascent:{step.verify['y'] - step.arguments['rise']}"
    if step.tool == "eat_if_hungry":
        return f"{prefix}:eat_to:{step.verify['min']}"
    if step.tool == "hunt_animal":
        mode = "walking" if step.arguments.get("walk_only") else "stock"
        if mode == "walking" and step.arguments.get("radius", 24) > 24:
            mode = "walking_wide"
        key = f"{prefix}:hunt_animal:{mode}:{step.verify['count']}"
        if mode != "walking" and position and all(isinstance(position.get(axis), (float, int)) and math.isfinite(position[axis]) for axis in ("x", "z")):
            return f"{key}:area:{math.floor(position['x'] / 64)}:{math.floor(position['z'] / 64)}"
        return key
    if step.tool == "collect_obsidian":
        return f"{prefix}:collect_obsidian:stock:{step.arguments['count']}"
    resource = step.arguments.get("item") or step.arguments.get("block")
    if stage == "S5" and not resource:
        resource = step.arguments.get("mode")
    return f"{prefix}:{step.tool}:{resource or 'default'}"


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
            if not routed:
                surveyed = []
                walk_misses = []
                for entry in ledger.get("action_history", []):
                    obs = entry.get("terminal_observation") or {}
                    if (entry.get("tool") != "raid_fortress" or not entry.get("receipt_confirmed")
                            or str(obs.get("dimension")).removeprefix("minecraft:") != "the_nether"):
                        continue
                    route = ((entry.get("result_data") or {}).get("fortress_evidence") or {}).get("route") or {}
                    if isinstance(route.get("walk_misses"), list):
                        walk_misses = route["walk_misses"][-16:]
                    for pos in (entry.get("baseline_position"), *(route.get("visited") or [])[-24:], obs.get("position")):
                        if isinstance(pos, dict) and all(isinstance(pos.get(a), (int, float)) and math.isfinite(pos[a]) for a in ("x", "z")):
                            surveyed.append({"x": pos["x"], "z": pos["z"]})
                if surveyed:
                    arguments = {**S5_STEPS[7].arguments, "surveyed": surveyed[-24:]}
                    if walk_misses:
                        arguments["walk_misses"] = walk_misses
                    return replace(S5_STEPS[7], arguments=arguments), 7
            return S5_STEPS[index], index
        return S5_STEPS[9], 9
    if dimension != "overworld":
        ledger["late_game_block_reason"] = "S5 需要主世界或下界的新鲜维度观察"
        return None, None
    obsidian = inventory_count(inventory, "obsidian")
    # 分批采到第一块后游标已指向建门；仍按实有数量判断是否还在矿点。
    local_preparation = cursor < 6 and obsidian < 10 and not rods
    reserve = 1 if local_preparation and (obsidian > 0 or _hunt_closing(state)) else 4
    supply = sustenance(state, reserve=reserve)
    if supply:
        # 地下等天亮补粮时，先用背包现成的材料准备点火器；仍在出发前检查口粮。
        health = state.get("health")
        if (supply.tool == "hunt_animal" and _s3_needs_surface_route(state)
                and state.get("is_day") is False and state.get("food", 0) >= 12
                and isinstance(health, (int, float)) and health > 10 and not _danger_now(state)
                and cursor < 6 and not rods and not inventory_count(inventory, "flint_and_steel")):
            dependency = ingot_dependency(inventory, 1)
            if dependency and dependency.tool == "smelt_batch":
                return dependency, None
            if dependency is None and inventory_count(inventory, "flint"):
                return S5_STEPS[3], 3
        return supply, None
    if rods:
        return S5_STEPS[9], 9
    # 已确认建门/过门的游标只作为门址提示，nether_travel 仍需实测门块及维度变化。
    if cursor >= 6:
        return S5_STEPS[6], 6
    site = ledger.get("s5_portal_site")
    if site:
        origin = site["origin"]
        position = state.get("position") or {}
        if not all(isinstance(position.get(axis), (int, float)) and math.isfinite(position[axis]) for axis in "xyz"):
            ledger["late_game_wait_reason"] = "等待当前位置后返回已记录的下界门址"
            return None, None
        if math.dist(tuple(position[a] for a in "xyz"), tuple(origin[a] for a in "xyz")) > 12:
            beside = dict(origin)
            beside["z" if site["axis"] == "x" else "x"] += 3
            return StepSpec("返回中断前的下界门址旁", "goto", beside,
                            {"type": "position", "target": beside, "radius": 3}, effect_class="replan"), None
        return replace(S5_STEPS[5], arguments={"resume_site": site}), 5
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
        target = min(10, inventory_count(inventory, "obsidian") + 2)
        return replace(S5_STEPS[4], arguments={**S5_STEPS[4].arguments, "count": target},
                       verify={"type": "inventory", "items": {"obsidian": target}}), 4
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
        position = state.get("position") or {}
        frames = (search.get("scan") or {}).get("frames") or []
        if frames and all(isinstance(position.get(axis), (float, int)) for axis in "xyz"):
            frame = min(frames, key=lambda f: sum((position[a] - f[a]) ** 2 for a in "xyz"))
            height = math.floor(position["y"])
            dx, dz = frame["x"] + 0.5 - position["x"], frame["z"] + 0.5 - position["z"]
            distance = math.hypot(dx, dz)
            if distance > 7:
                stride = min(8, distance - 4)
                target = {"x": math.floor(position["x"] + stride * dx / distance),
                          "z": math.floor(position["z"] + stride * dz / distance),
                          "y": max(frame["y"] + 1, height - 2) if height > frame["y"] else height}
                return StepSpec("分段走向门房外侧，绕开起点竖井", "goto", target,
                                {"type": "position", "target": target, "radius": 3},
                                retries=1, timeout_s=100, effect_class="replan"), None
            if height > frame["y"] + 5:
                target = max(height - 6, math.floor(frame["y"] + 3))
                return StepSpec("沿已确认门框的高度安全下探", "safe_descend",
                                {"targetY": target, "maxLayers": height - target, "fill": True, "detour": False},
                                {"type": "position", "target": {**position, "y": target}, "radius": 1.5},
                                retries=1, timeout_s=100, effect_class="replan"), None
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
