from __future__ import annotations

from dataclasses import replace

from voxkin.agent.goal_methods import FOOD_ITEMS, S2_WOOD_BLOCKS, early_craft
from voxkin.agent.goals import inventory_count
from voxkin.agent.runner import StepSpec


# 储备是一次采集的软目标；验收保留当前阶段的硬缺口，避免为了囤货卡住进度。
STOCK_TARGETS = {
    "S0": {"wood_log": 8},
    "S1": {"wood_log": 12, "stone": 32},
    "S2": {"wood_log": 12, "stone": 32},
    "S3": {"wood_log": 16, "stone": 32, "iron_ore": 24, "coal_ore": 16},
    "S4": {"wood_log": 16, "stone": 32, "iron_ore": 12, "coal_ore": 16, "diamond_ore": 6},
    "S5": {"wood_log": 16, "stone": 32, "iron_ore": 8, "coal_ore": 16},
    "S6": {"wood_log": 16, "stone": 32, "coal_ore": 16},
}
FOOD_TARGETS = {"S0": 8, "S1": 8, "S2": 8, "S3": 12, "S4": 16, "S5": 24, "S6": 24}


def supports_resource_policy(state: dict) -> bool:
    # 老 Bridge 没有声明资源观察时，保持原动作参数兼容，不发送新采集合同。
    return isinstance(state.get("resource_sites"), dict)


def batch_resource_step(stage: str, step: StepSpec, state: dict) -> StepSpec:
    if not supports_resource_policy(state):
        return step
    slots = state.get("inventory_free_slots")
    if isinstance(slots, (int, float)) and slots < 2:
        return step
    if isinstance(state.get("health"), (int, float)) and state["health"] <= 10:
        return step
    if step.tool != "mine_collect":
        return step
    block = str(step.arguments.get("block") or "")
    resource = "wood_log" if block.endswith("_log") else block.replace("deepslate_", "")
    if block == "deepslate":
        resource = "stone"
    target = STOCK_TARGETS.get(stage, {}).get(resource, 0)
    minimum = int(step.arguments.get("count") or 1)
    inventory = state.get("inventory") or {}
    if resource == "iron_ore":
        target = max(0, target - inventory_count(inventory, "iron_ingot"))
    if resource == "wood_log":
        planks = sum(inventory_count(inventory, name) for name in inventory if name.endswith("_planks"))
        target = max(0, target - planks // 4)
    if target <= minimum:
        return step
    return replace(step, arguments={**step.arguments, "count": target, "minimum_count": minimum},
                   description=f"{step.description}，顺路补足后续储备（最低 {minimum}，目标 {target}）")


def choose_supply_opportunity(stage: str, state: dict, ledger: dict) -> tuple[StepSpec, str] | None:
    if not supports_resource_policy(state) or str(state.get("dimension") or "").removeprefix("minecraft:") != "overworld":
        return None
    if stage == "S6" and ledger.get("stronghold_search"):
        return None
    health = state.get("health")
    if not isinstance(health, (int, float)) or health <= 10 or state.get("is_day") is not True:
        return None
    if (state.get("shelter") or {}).get("inside") is True:
        return None
    slots = state.get("inventory_free_slots")
    if isinstance(slots, (int, float)) and slots < 2:
        return None
    inventory = state.get("inventory") or {}
    sites = state["resource_sites"]
    attempted = ledger.setdefault("supply_sites_attempted", [])
    food = sum(inventory_count(inventory, name) for name in FOOD_ITEMS)
    food_target = FOOD_TARGETS.get(stage, 12)
    if (state.get("food") or 0) < 12 and food:
        return None
    if food < food_target and inventory_count(inventory, "wheat") >= 3:
        if not inventory_count(inventory, "crafting_table"):
            return early_craft(inventory, "crafting_table"), "supply:bread:table"
        amount = min(food_target - food, inventory_count(inventory, "wheat") // 3)
        return StepSpec("将储备麦子制成旅途面包", "craft", {"item": "bread", "count": amount},
                        {"type": "inventory", "items": {"bread": inventory_count(inventory, "bread") + amount}},
                        timeout_s=60, effect_class="replan"), "supply:bread"
    if food < food_target and inventory_count(inventory, "hay_block"):
        amount = min(inventory_count(inventory, "hay_block"), (food_target - food + 2) // 3, 7)
        return StepSpec("将干草储备拆成麦子", "craft", {"item": "wheat", "count": amount * 9},
                        {"type": "inventory", "items": {"wheat": inventory_count(inventory, "wheat") + amount * 9}},
                        timeout_s=60, effect_class="replan"), "supply:wheat"
    bed_target = 0 if inventory_count(inventory, "bed") or state.get("nearby_beds") else 1
    targets = {"iron_ingot": 16, "diamond": 3, "iron_pickaxe": 1, "iron_sword": 1,
               "iron_helmet": 1, "iron_chestplate": 1, "iron_leggings": 1, "iron_boots": 1,
               "obsidian": 10}
    candidates = []
    if food < food_target:
        candidates.extend(sites.get("hay") or [])
    if bed_target:
        candidates.extend(sites.get("beds") or [])
    if food < food_target or any(inventory_count(inventory, item) < count for item, count in targets.items()):
        candidates.extend(sites.get("chests") or [])
    fresh = [p for p in candidates if _site_key(p) not in attempted]
    if fresh:
        # 一次机会搜索覆盖当前视野；失败或空箱后回到基础路线，不在同一点空转。
        attempted.extend(_site_key(p) for p in fresh)
        del attempted[:-128]
        return StepSpec("利用村庄床、箱中物资和干草补足旅途储备", "loot_village",
                        {"targets": targets, "bed_count": bed_target, "food_target": food_target,
                         "range": 32, "max_search_steps": 0,
                         "avoid_positions": [p for p in attempted if p not in {_site_key(s) for s in fresh}]},
                        {"type": "always"}, retries=0, timeout_s=250, effect_class="replan"), "supply:village:" + _site_key(fresh[0])
    # 铁傀儡是可替代的取铁机会，仅在有武器、垫脚材料和真实目标时选择。
    blocks = max(inventory_count(inventory, name) for name in ("dirt", "cobblestone", "cobbled_deepslate", "stone", *S2_WOOD_BLOCKS))
    weapon = any(count and name.endswith(("_sword", "_axe")) for name, count in inventory.items())
    if stage in {"S3", "S4", "S5"} and (state.get("food") or 0) >= 12 and inventory_count(inventory, "iron_ingot") < 12 and blocks >= 3 and weapon:
        for golem in sites.get("golems") or []:
            key = f"golem:{state.get('session_id')}:{golem.get('id')}"
            if key in attempted:
                continue
            attempted.append(key)
            return StepSpec("确认三格高台后击打铁傀儡并拾取铁锭", "harvest_iron_golem",
                            {"entity_id": golem["id"]},
                            {"type": "inventory", "items": {"iron_ingot": inventory_count(inventory, "iron_ingot") + 1}},
                            retries=0, timeout_s=180, effect_class="replan"), "supply:" + key
    return None


def _site_key(site: dict) -> str:
    return f"{int(site['x'])},{int(site['y'])},{int(site['z'])}"
