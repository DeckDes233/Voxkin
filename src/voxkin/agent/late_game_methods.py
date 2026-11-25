from __future__ import annotations

import math
from dataclasses import replace
from typing import Any

from voxkin.agent.goal_methods import (
    FOOD_ITEMS, S2_SHELTER_BLOCKS, S3_FUEL_BURN, S3_MINING_PICKAXES, early_craft, early_planks,
    _danger_now, _hunt_closing, _s3_needs_surface_route, _s3_return_to_known_surface,
)
from voxkin.agent.goals import inventory_count
from voxkin.agent.plans import S5_STEPS, S6_STEPS
from voxkin.agent.runner import StepSpec


def prepare_late_action(step: StepSpec | None, index: int | None, state: dict, ledger: dict) -> tuple[StepSpec | None, int | None]:
    ledger.pop("late_game_wait_reason", None)
    if step is None:
        return None, index
    if step.tool == "hunt_animal" and str(state.get("dimension") or "").removeprefix("minecraft:") == "overworld":
        shelter = state.get("shelter") or {}
        camped = shelter.get("inside") is True and shelter.get("sealed") is True
        evening = state.get("is_day") is False or _hunt_closing(state)
        if camped and not evening and state.get("is_day") is True:
            return StepSpec("天亮后离开庇护所补粮", "leave_shelter", {"range": 3}, {"type": "outside_shelter"},
                            retries=1, timeout_s=90, effect_class="replan"), None
        if evening and not _danger_now(state):
            failures = (ledger.get("counters") or {}).get("method_failures") or {}
            if state.get("is_day") is False and (state.get("resource_sites") or {}).get("sleep_bed"):
                sleep = StepSpec("在已观察到的床上过夜", "sleep_safe", {"range": 32},
                                 {"type": "daylight", "min_health": 1, "camp_day": state.get("day")},
                                 retries=1, timeout_s=90, effect_class="replan")
                if not failures.get(late_method_key(ledger.get("stage", ""), sleep)):
                    return sleep, None
            if camped:
                ledger["late_game_wait_reason"] = "已在封闭庇护所内，天亮后开出口补粮"
                return None, None
            access = state.get("surface_access") or {}
            stock = sum(inventory_count(state.get("inventory") or {}, item) for item in S2_SHELTER_BLOCKS)
            if stock >= 25 and access.get("connected_land") is True and not access.get("in_water"):
                camp = StepSpec("天黑前用现有方块搭就地庇护所", "make_shelter", {"size": 3},
                                {"type": "sealed_camp", "camp_day": state.get("day")},
                                retries=1, timeout_s=180, effect_class="replan")
                if not failures.get(late_method_key(ledger.get("stage", ""), camp)):
                    return camp, None
    needs_health = step.tool in {
        "hunt_animal", "hunt_material", "hunt_enderman", "raid_fortress", "collect_blaze_rods", "fight_dragon",
        "collect_obsidian", "mine_collect", "safe_descend", "strip_mine", "explore_mining_site",
    }
    if needs_health and isinstance(state.get("health"), (int, float)) and state["health"] <= 10:
        inventory = state.get("inventory") or {}
        if state.get("food", 20) < 20 and any(inventory_count(inventory, name) for name in FOOD_ITEMS):
            return StepSpec("先吃一份口粮恢复血量", "eat_if_hungry", {"threshold": 20, "count": 0},
                            {"type": "food", "min": min(20, math.floor(state["food"]) + 1)}, retries=2, timeout_s=60, effect_class="replan"), None
        if state.get("food", 20) < 18 and inventory_count(inventory, "rotten_flesh"):
            return StepSpec("缺粮且无法自然回血，吃一份腐肉应急", "eat", {"item": "rotten_flesh", "count": 1},
                            {"type": "food", "min": math.floor(state["food"]) + 1}, retries=1, timeout_s=25, effect_class="replan"), None
        surface = state.get("surface_access") or {}
        if (step.tool == "hunt_animal" and state["health"] > 2 and state.get("food", 20) < 18
                and state.get("is_day") is True and not _hunt_closing(state) and state.get("nearby_food_animal") is True
                and not surface.get("in_water") and not (state.get("executor") or {}).get("safety_active")):
            return replace(step, arguments={**step.arguments, "radius": 24, "walk_only": True,
                                            "nearby_only": True, "min_health": 2},
                           retries=1, timeout_s=45), None
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
        for previous in reversed(ledger.get("action_history") or []):
            if previous.get("status") == "rejected_before_start":
                continue
            data = previous.get("result_data") or {}
            hazard = (data.get("observation") or {}).get("position") or {}
            position = state.get("position") or {}
            if (previous.get("tool") == "strip_mine" and previous.get("receipt_confirmed") is True
                    and data.get("reason") == "nearby_hostiles" and (previous.get("arguments") or {}).get("rise")
                    and all(isinstance(p.get(k), (int, float)) for p in (position, hazard) for k in "xyz")
                    and math.dist(tuple(position[k] for k in "xyz"), tuple(hazard[k] for k in "xyz")) < 6):
                return StepSpec("从敌怪把守的出口侧向撤离，再找上行路线", "explore_mining_site",
                                {"min_distance": 8, "avoid_positions": [hazard], "covered_escape": True},
                                {"type": "late_threat_relocation", "min_distance": 8}, retries=1, timeout_s=240,
                                effect_class="replan"), None
            break
        failures = (ledger.get("counters") or {}).get("method_failures") or {}
        if route.tool == "goto" and failures.get(late_method_key(ledger.get("stage", ""), route)) and not _danger_now(state):
            position = state["position"]
            rise = min(6, math.floor(route.arguments["y"]) - math.floor(position["y"]))
            if rise >= 2:
                dx, dz = route.arguments["x"] - position["x"], route.arguments["z"] - position["z"]
                direction = ("east" if dx > 0 else "west") if abs(dx) > abs(dz) else ("south" if dz > 0 else "north")
                args = {"rise": rise, "direction": direction}
                prior = f"{str(ledger.get('stage', '')).lower()}:ascent:{math.floor(position['y'])}"
                inventory = state.get("inventory") or {}
                if failures.get(prior) and not any(inventory_count(inventory, name) for name in (*S3_MINING_PICKAXES, "wooden_pickaxe", "golden_pickaxe")):
                    rise = min(rise, 2)
                    args.update(rise=rise, clear_by_hand=True)
                elif failures.get(prior) and inventory_count(inventory, "cobblestone") > 0:
                    args["fill_gaps"] = True
                return StepSpec("上行寻路失败，改挖有支撑的短阶梯", "strip_mine", args,
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
    if (not capacity and inventory_count(inventory, "wooden_pickaxe")
            and any(inventory_count(inventory, item) for item in S3_MINING_PICKAXES if item != "wooden_pickaxe")):
        fuel, capacity = "wooden_pickaxe", 1
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
    overworld = str(state.get("dimension") or "").removeprefix("minecraft:") == "overworld"
    shelter = state.get("shelter") or {}
    mine_station = (state.get("nearby_owned_crafting_table") is True and _s3_needs_surface_route(state)
                    and (state.get("surface_access") or {}).get("sky_light") == 0)
    safe_to_cook = (state.get("is_day") is True and not _hunt_closing(state)) or (
        shelter.get("inside") is True and shelter.get("sealed") is True) or mine_station
    health = state.get("health")
    if (overworld and reserve and safe_to_cook and food >= 14 and isinstance(health, (int, float)) and health > 10
            and not _danger_now(state) and not (state.get("surface_access") or {}).get("in_water")
            and inventory_count(inventory, "furnace")):
        fuel = next((name for name in ("coal", "charcoal") if inventory_count(inventory, name) >= 2), None)
        meats = ("beef", "porkchop", "mutton", "chicken", "salmon", "cod")
        raw = max(meats, key=lambda name: inventory_count(inventory, name))
        batch = min(8, inventory_count(inventory, raw))
        if fuel and batch >= 2 and not any(inventory_count(inventory, f"cooked_{name}") for name in meats):
            cooked = f"cooked_{raw}"
            return action("smelt_batch", {"item": raw, "count": batch, "output": cooked, "fuel": fuel},
                          {cooked: batch}, "用现有熔炉和富余燃料烤制远行口粮")
    if food < 18 and stock:
        return StepSpec("行动前用现有食物恢复", "eat_if_hungry", {"threshold": 18, "count": 0},
                        {"type": "food", "min": min(18, math.floor(food) + 1)}, retries=2, timeout_s=60, effect_class="replan")
    if overworld and (stock < reserve or (food < 12 and not stock)):
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
    if step.verify.get("type") == "late_threat_relocation":
        hazard = step.arguments["avoid_positions"][0]
        return f"{prefix}:leave_threat:{math.floor(hazard['x'] / 8)}:{math.floor(hazard['y'] / 4)}:{math.floor(hazard['z'] / 8)}"
    if "camp_day" in step.verify:
        return f"{prefix}:{step.tool}:day:{step.verify['camp_day']}"
    if step.tool == "goto" and step.verify.get("site") == "surface_exit":
        target = step.arguments
        return f"{prefix}:surface_exit:{math.floor(target['x'] / 8)}:{math.floor(target['y'] / 4)}:{math.floor(target['z'] / 8)}"
    if step.tool == "strip_mine" and step.arguments.get("rise"):
        key = f"{prefix}:ascent:{step.verify['y'] - step.arguments['rise']}"
        if step.arguments.get("clear_by_hand"):
            return key + ":hand"
        return key + ":fill" if step.arguments.get("fill_gaps") else key
    if step.tool == "eat_if_hungry":
        return f"{prefix}:eat_to:{step.verify['min']}"
    if step.tool == "hunt_animal":
        if step.arguments.get("nearby_only"):
            return f"{prefix}:hunt_animal:nearby:{step.verify['count']}"
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
                if not any(inventory_count(inventory, p) for p in (*S3_MINING_PICKAXES, "wooden_pickaxe", "golden_pickaxe")):
                    materials = (("diamond", "diamond_pickaxe"), ("iron_ingot", "iron_pickaxe"),
                                 ("cobblestone", "stone_pickaxe"), ("blackstone", "stone_pickaxe"), ("cobbled_deepslate", "stone_pickaxe"))
                    pick = next((p for material, p in materials if inventory_count(inventory, material) >= 3), None)
                    if pick:
                        if not inventory_count(inventory, "crafting_table"):
                            repair = early_craft(inventory, "crafting_table")
                        elif inventory_count(inventory, "stick") < 2:
                            repair = early_planks(inventory, 2, "镐柄") or action("craft", {"item": "stick", "count": 4}, {"stick": 2}, "制作镐柄", 60)
                        else:
                            repair = action("craft", {"item": pick, "count": 1}, {pick: 1}, "用随身材料补做要塞侦察用镐", 60)
                        if repair.tool == "craft":
                            return repair, None
                surveyed = []
                walk_misses = []
                for entry in ledger.get("action_history", []):
                    obs = entry.get("terminal_observation") or {}
                    if (entry.get("tool") not in {"raid_fortress", "strip_mine"} or not entry.get("receipt_confirmed")
                            or str(obs.get("dimension")).removeprefix("minecraft:") != "the_nether"):
                        continue
                    route = ((entry.get("result_data") or {}).get("fortress_evidence") or {}).get("route") or {}
                    if isinstance(route.get("walk_misses"), list):
                        walk_misses = route["walk_misses"][-16:]
                    for pos in (entry.get("baseline_position"), route.get("origin"), *(route.get("visited") or [])[-24:], obs.get("position")):
                        if isinstance(pos, dict) and all(isinstance(pos.get(a), (int, float)) and math.isfinite(pos[a]) for a in ("x", "z")):
                            level = (state.get("position") or {}).get("y")
                            if isinstance(level, (int, float)) and isinstance(pos.get("y"), (int, float)) and abs(level - pos["y"]) >= 6:
                                continue
                            surveyed.append({"x": pos["x"], "z": pos["z"]})
                if surveyed:
                    # 一次原地失败只能占一个位置。保留最近区域的实际足迹与下界入口参照点。
                    locations = {(math.floor(p["x"] / 3), math.floor(p["z"] / 3)): p for p in surveyed}
                    here = state.get("position") or {}
                    if not all(isinstance(here.get(a), (int, float)) and math.isfinite(here[a]) for a in ("x", "z")):
                        here = surveyed[-1]
                    nearby = sorted(locations.values(), key=lambda p: math.hypot(p["x"] - here["x"], p["z"] - here["z"]))
                    checkpoint = ((ledger.get("s5_portal_checkpoint") or {}).get("transition") or {}).get("target") or {}
                    anchor = checkpoint.get("position") if checkpoint.get("dimension") == "minecraft:the_nether" else None
                    anchor = anchor if isinstance(anchor, dict) and all(isinstance(anchor.get(a), (int, float)) and
                        math.isfinite(anchor[a]) for a in ("x", "z")) else surveyed[0]
                    reference = {"x": anchor["x"], "z": anchor["z"]}
                    arguments = {**S5_STEPS[7].arguments, "surveyed": [reference, *(p for p in nearby if p != reference)][:128]}
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
    # 两份牛排或熟猪排即可回复 16 点饥饿。门料齐备时，再带一份口粮便可出发。
    hearty = inventory_count(inventory, "cooked_beef") + inventory_count(inventory, "cooked_porkchop")
    if (obsidian >= 10 or cursor >= 6) and hearty >= 2 and inventory_count(inventory, "flint_and_steel"):
        reserve = 3
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
            ledger["s5_rebuild_pickaxe"] = True
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
    position = state.get("position") or {}
    stops = ledger.get("s5_portal_search_stops") or []
    if (stops and all(isinstance(position.get(a), (int, float)) for a in "xyz")
            and any(abs(position["y"] - p["y"]) < 4 and math.hypot(position["x"] - p["x"], position["z"] - p["z"]) < 10
                    for p in stops)):
        above = (state.get("surface_access") or {}).get("exit") or {}
        if all(isinstance(above.get(a), (int, float)) for a in "xyz") and 2 < above["y"] - position["y"] <= 24:
            climb = StepSpec("到已观察的地面寻找足够大的干燥门址", "goto", dict(above),
                             {"type": "position", "target": dict(above), "radius": 2, "site": "surface_exit"},
                             timeout_s=90, effect_class="replan")
            failures = (ledger.get("counters") or {}).get("method_failures") or {}
            if not failures.get(late_method_key("S5", climb, position)):
                return climb, None
        return StepSpec("离开低顶或无地基的门址，到新的干地建门", "explore_mining_site",
                        {"min_distance": 16, "avoid_positions": stops},
                        {"type": "s5_portal_relocation", "min_distance": 16}, timeout_s=150, effect_class="replan"), None
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
