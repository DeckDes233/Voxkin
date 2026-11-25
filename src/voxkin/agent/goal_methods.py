from __future__ import annotations

import math
from dataclasses import replace
from typing import Any

from voxkin.agent.goals import inventory_count
from voxkin.agent.runner import StepSpec


FOOD_ITEMS = {
    "apple",
    "baked_potato",
    "beef",
    "bread",
    "carrot",
    "chicken",
    "cooked_beef",
    "cooked_chicken",
    "cooked_cod",
    "cooked_mutton",
    "cooked_porkchop",
    "cooked_rabbit",
    "cooked_salmon",
    "cod",
    "melon_slice",
    "mutton",
    "porkchop",
    "potato",
    "rabbit",
    "sweet_berries",
    "beetroot",
    "glow_berries",
    "cookie",
    "pumpkin_pie",
    "dried_kelp",
    "mushroom_stew",
    "rabbit_stew",
    "beetroot_soup",
    "salmon",
}

S2_WOOD_BLOCKS = {"oak_planks", "spruce_planks", "birch_planks", "jungle_planks", "acacia_planks", "dark_oak_planks", "mangrove_planks", "cherry_planks", "bamboo_planks"}
S2_SHELTER_BLOCKS = {"dirt", "cobblestone", "stone", "andesite", "granite", "diorite", *S2_WOOD_BLOCKS, "oak_log", "spruce_log", "birch_log"}
S3_WOOD_SOURCES = (
    ("oak_planks", "oak_log"),
    ("spruce_planks", "spruce_log"),
    ("birch_planks", "birch_log"),
    ("jungle_planks", "jungle_log"),
    ("acacia_planks", "acacia_log"),
    ("dark_oak_planks", "dark_oak_log"),
    ("mangrove_planks", "mangrove_log"),
    ("cherry_planks", "cherry_log"),
    ("crimson_planks", "crimson_stem"),
    ("warped_planks", "warped_stem"),
)
S3_OVERWORLD_WOOD_SOURCES = S3_WOOD_SOURCES[:8]
S3_OVERWORLD_WOOD_LOGS = frozenset(log for _plank, log in S3_OVERWORLD_WOOD_SOURCES)
S3_WOOD_PLANKS = tuple(plank for plank, _ in S3_WOOD_SOURCES)
S3_MINING_PICKAXES = ("stone_pickaxe", "iron_pickaxe", "diamond_pickaxe", "netherite_pickaxe")

S5_PORTAL_DIMENSIONS = frozenset({"minecraft:overworld", "minecraft:the_nether"})


def canonical_s5_portal_dimension(value: Any) -> str:
    """精确映射 Minecraft 原版 bare ID；不把自定义维度猜成原版。"""
    dimension = str(value or "").strip().lower()
    return {
        "overworld": "minecraft:overworld",
        "the_nether": "minecraft:the_nether",
        "the_end": "minecraft:the_end",
    }.get(dimension, dimension)


def normalize_s5_portal_transition(value: Any) -> dict[str, Any] | None:
    """只接收含实测源门和抵达锚点的原版主世界/下界过门记录。"""
    if not isinstance(value, dict):
        return None

    def anchor(raw: Any, observed: str) -> dict[str, Any] | None:
        if not isinstance(raw, dict):
            return None
        dimension = canonical_s5_portal_dimension(raw.get("dimension"))
        position = raw.get("position")
        if dimension not in S5_PORTAL_DIMENSIONS or raw.get("observed") != observed or not isinstance(position, dict):
            return None
        coordinates: dict[str, int] = {}
        for axis in "xyz":
            coordinate = position.get(axis)
            if isinstance(coordinate, bool):
                return None
            try:
                numeric = float(coordinate)
            except (TypeError, ValueError, OverflowError):
                return None
            if not math.isfinite(numeric) or not numeric.is_integer():
                return None
            coordinates[axis] = int(numeric)
        return {"dimension": dimension, "position": coordinates, "observed": observed}

    source = anchor(value.get("source"), "nether_portal_block")
    target = anchor(value.get("target"), "arrival_checkpoint")
    if source is None or target is None or source["dimension"] == target["dimension"]:
        return None
    return {"source": source, "target": target}


def s5_portal_hint(goal_state: dict[str, Any], state: dict[str, Any]) -> dict[str, Any] | None:
    """跨 Bridge session 时仅恢复已验证 portal transition 作为搜索锚点。"""
    checkpoint = goal_state.get("s5_portal_checkpoint")
    if not isinstance(checkpoint, dict) or checkpoint.get("schema_version") != 1:
        return None
    receipt = checkpoint.get("receipt")
    transition = normalize_s5_portal_transition(checkpoint.get("transition"))
    if not isinstance(receipt, dict) or transition is None:
        return None
    action_id = str(receipt.get("action_id") or "")
    saved_session = str(receipt.get("session_id") or "")
    current_session = str(state.get("session_id") or "")
    revision = receipt.get("revision")
    if isinstance(revision, bool):
        return None
    try:
        revision_value = int(revision)
    except (TypeError, ValueError, OverflowError):
        return None
    if not action_id or not saved_session or not current_session or saved_session == current_session or revision_value < 0:
        return None
    if canonical_s5_portal_dimension(state.get("dimension")) not in S5_PORTAL_DIMENSIONS:
        return None
    return transition
S3_ANY_PICKAXES = ("wooden_pickaxe", "golden_pickaxe", *S3_MINING_PICKAXES)
S3_SAFE_FOOD = 16
S3_FOOD_RESERVE = 2
S3_IRON_COSTS = {"iron_pickaxe": 3, "iron_sword": 2, "shield": 1, "bucket": 3}
S3_FUEL_BURN = {"coal": 8.0, "charcoal": 8.0, **{plank: 1.5 for plank in S2_WOOD_BLOCKS}}
S3_ORE_EXPOSE_MAX = 12
S3_SURFACE_ROUTE_MAX_HORIZONTAL = 128.0
S3_SURFACE_ROUTE_MIN_VERTICAL = 8.0


def _bed_wool_color(inventory: dict[str, Any]) -> str:
    for item, count in inventory.items():
        name = str(item)
        if name.endswith("_wool") and int(count or 0) >= 3:
            return name.removesuffix("_wool")
    return ""


def _bed_ids(inventory: dict[str, Any]) -> list[str]:
    return [
        str(item)
        for item, count in inventory.items()
        if (str(item) == "bed" or str(item).endswith("_bed")) and int(count or 0) > 0
    ]


def _shelter_bounds(shelter: dict[str, Any]) -> dict[str, dict[str, float]] | None:
    bounds = shelter.get("bounds")
    if isinstance(bounds, dict) and isinstance(bounds.get("min"), dict) and isinstance(bounds.get("max"), dict):
        try:
            return {
                edge: {axis: float(bounds[edge][axis]) for axis in "xyz"}
                for edge in ("min", "max")
            }
        except (KeyError, TypeError, ValueError):
            return None
    center = shelter.get("position") or {}
    try:
        size = int(shelter.get("size"))
        x, y, z = (float(center[axis]) for axis in "xyz")
    except (KeyError, TypeError, ValueError):
        return None
    minimum_x = x - size // 2
    minimum_z = z - size // 2
    return {
        "min": {"x": minimum_x, "y": y, "z": minimum_z},
        "max": {"x": minimum_x + size - 1, "y": y + 3, "z": minimum_z + size - 1},
    }


def _bed_is_inside(bed: dict[str, Any], shelter: dict[str, Any]) -> bool:
    bounds = _shelter_bounds(shelter)
    if bounds is None:
        return False
    try:
        return all(
            bounds["min"][axis] < float(bed[axis]) < bounds["max"][axis]
            for axis in "xyz"
        )
    except (KeyError, TypeError, ValueError):
        return False


def _shelter_structurally_ready(state: dict[str, Any]) -> bool:
    shelter = state.get("shelter") or {}
    try:
        size = int(shelter.get("size", 0))
    except (TypeError, ValueError):
        size = 0
    return shelter.get("sealed") is True and size >= 4 and _shelter_bounds(shelter) is not None


def _shelter_missing_blocks(state: dict[str, Any], inventory: dict[str, Any]) -> int:
    shelter = state.get("shelter") or {}
    value = shelter.get("missing_blocks")
    present = sum(inventory_count(inventory, item) for item in S2_SHELTER_BLOCKS)
    try:
        missing = int(value)
        if missing >= 0:
            return max(0, missing - present)
    except (TypeError, ValueError):
        pass
    return max(0, 40 - present)


def _bed_inside(state: dict[str, Any]) -> bool:
    shelter = state.get("shelter") or {}
    beds = state.get("nearby_beds")
    return (
        isinstance(beds, list)
        and any(isinstance(bed, dict) and _bed_is_inside(bed, shelter) for bed in beds)
    )


def _is_day(state: dict[str, Any]) -> bool | None:
    if isinstance(state.get("is_day"), bool):
        return state["is_day"]
    try:
        value = float(state.get("time")) % 24000.0
    except (TypeError, ValueError):
        return None
    if not math.isfinite(value):
        return None
    return value < 12541 or value > 23458


def _hunt_closing(state: dict) -> bool:
    tick = state.get("time")
    return isinstance(tick, (float, int)) and tick % 24000 > 10000


def _danger_now(state: dict[str, Any]) -> bool:
    executor = state.get("executor") or {}
    if executor.get("safety_active") is True:
        return True
    if state.get("danger") is True or state.get("hostile_nearby") is True:
        return True
    if state.get("hostiles") or state.get("nearby_hostiles") or state.get("threats"):
        return True
    try:
        return float(state.get("health", 20)) <= 8
    except (TypeError, ValueError):
        return False


def early_planks(inventory: dict[str, Any], target: int, label: str) -> StepSpec | None:
    # Mineflayer 的具体配方按单一木种展开，不能把混合木板总数当作可执行配方。
    if any(inventory_count(inventory, name) >= target for name in (*S3_WOOD_PLANKS, "bamboo_planks")):
        return None
    stocked = [pair for pair in S3_WOOD_SOURCES if inventory_count(inventory, pair[1]) > 0]
    if stocked:
        plank, log = max(stocked, key=lambda pair: inventory_count(inventory, pair[0]) + 4 * inventory_count(inventory, pair[1]))
        count = min(target - inventory_count(inventory, plank), 4 * inventory_count(inventory, log))
        return _s3_action(f"加工{label}所需木板", "craft", {"item": plank, "count": count},
                          {"type": "inventory", "items": {plank: inventory_count(inventory, plank) + count}}, 60)
    best_stock = max((inventory_count(inventory, name) for name in S3_WOOD_PLANKS), default=0)
    logs_needed = max(1, math.ceil((target - best_stock) / 4))
    return _s3_action(f"搜索任意主世界树种，补齐{label}原木", "mine_collect",
                      {"block": "wood_log", "count": logs_needed, "range": 64},
                      {"type": "inventory_any", "items": sorted(S3_OVERWORLD_WOOD_LOGS), "count": logs_needed}, 250)


def early_craft(inventory: dict[str, Any], item: str, table_available: bool = False) -> StepSpec:
    # 每次只修复一个直接依赖，下一回合按新背包重新决策，死亡或消耗不会留下失效游标。
    costs = {"crafting_table": (4, 0, 0), "wooden_pickaxe": (3, 2, 0),
             "stone_pickaxe": (0, 2, 3), "stone_sword": (0, 1, 2), "furnace": (0, 0, 8)}
    planks, sticks, cobble = costs[item]
    if item != "crafting_table" and inventory_count(inventory, "crafting_table") < 1 and not table_available:
        return early_craft(inventory, "crafting_table")
    if inventory_count(inventory, "stick") < sticks:
        wood = early_planks(inventory, 2, "木棍")
        return wood or _s3_action("补齐木棍", "craft", {"item": "stick", "count": sticks - inventory_count(inventory, "stick")},
                                  {"type": "inventory", "items": {"stick": sticks}}, 60)
    if planks:
        wood = early_planks(inventory, planks, item)
        if wood:
            return wood
    if inventory_count(inventory, "cobblestone") < cobble:
        if not any(inventory_count(inventory, pick) for pick in S3_ANY_PICKAXES):
            return early_craft(inventory, "wooden_pickaxe", table_available)
        return _s3_action("补齐圆石", "mine_collect", {"block": "stone", "count": cobble, "range": 48},
                          {"type": "inventory", "items": {"cobblestone": cobble}}, 250)
    return _s3_action(f"合成{item}", "craft", {"item": item, "count": 1}, {"type": "inventory", "items": {item: 1}}, 60)


def choose_early_survival_action(state: dict[str, Any]) -> StepSpec | None:
    try:
        food = float(state["food"])
        health = float(state["health"])
    except (KeyError, TypeError, ValueError):
        return None
    if not math.isfinite(food) or not math.isfinite(health) or food > 8:
        return None
    inventory = state.get("inventory") or {}
    if any(inventory_count(inventory, item) > 0 for item in FOOD_ITEMS):
        return StepSpec("用背包里的食物恢复饥饿值", "eat_if_hungry", {"threshold": 9, "count": 0},
                        {"type": "food", "min": min(9, math.floor(food) + 1)}, retries=2, timeout_s=60, effect_class="replan")
    if _is_day(state) is not True or _danger_now(state) or health <= 10:
        return None
    return StepSpec("搜索附近动物补充食物", "hunt_animal", {"count": 1, "radius": 64, "min_health": 10},
                    {"type": "inventory_any", "items": ["beef", "porkchop", "chicken", "rabbit", "mutton"], "count": 1},
                    retries=2, timeout_s=250, effect_class="replan")


def _nearby_crafting_table(state: dict[str, Any]) -> bool:
    return state.get("nearby_crafting_table") is True or state.get("nearby_owned_crafting_table") is True


def choose_early_action(stage: str, state: dict[str, Any]) -> StepSpec | None:
    inventory = state.get("inventory") or {}
    targets = ("crafting_table", "wooden_pickaxe") if stage == "S0" else ("stone_pickaxe", "stone_sword", "furnace")
    for item in targets:
        if inventory_count(inventory, item) < 1:
            return early_craft(inventory, item, _nearby_crafting_table(state))
    return None


def choose_s2_action(state: dict[str, Any], goal_state: dict[str, Any]) -> StepSpec | None:
    """依观察补齐过夜依赖；白天先在室外准备，夜间先获得封闭安全点。"""
    inventory = state.get("inventory") or {}
    day = _is_day(state)
    if day is False:
        goal_state["night_required"] = True
    try:
        food = float(state.get("food", 0) or 0)
    except (TypeError, ValueError):
        food = 0.0
    if not math.isfinite(food):
        food = 0.0
    shelter = state.get("shelter") or {}
    shelter_ready = _shelter_structurally_ready(state)
    inside = shelter.get("inside") is True
    urgent = day is False or _danger_now(state)
    food_ready = food >= 8
    bed_inside = _bed_inside(state)
    bed_stock = _bed_ids(inventory)

    def action(description: str, tool: str, arguments: dict[str, Any], verify: dict[str, Any], timeout: float = 180.0) -> StepSpec:
        return StepSpec(description, tool, arguments, verify, retries=2, timeout_s=timeout, effect_class="replan")

    def collect_block(block: str, missing: int, label: str, timeout: float = 250.0) -> StepSpec:
        current = inventory_count(inventory, block)
        target = current + max(1, missing)
        return action(f"补齐{label}", "mine_collect", {"block": block, "count": target, "range": 64}, {"type": "inventory", "items": {block: target}}, timeout)

    def planks(count: int, label: str) -> StepSpec:
        return early_planks(inventory, count, label)

    # 危险或已入夜时先补足封闭体；材料不足时先采集可用方块。
    if urgent and not shelter_ready:
        missing_blocks = _shelter_missing_blocks(state, inventory)
        if missing_blocks > 0:
            return collect_block("dirt", missing_blocks, "封闭庇护所方块", 250.0)
        goal_state["emergency_shelter"] = True
        return action("优先搭建全封闭庇护所", "make_shelter", {"size": 4}, {"type": "shelter"})

    # 夜里没有床也能留在封闭庇护所守到天亮；回执和新鲜 daylight 是独立证据。
    if urgent and shelter_ready and inside and day is False:
        if bed_inside:
            return action("在庇护所内睡到天亮", "sleep_safe", {"range": 16}, {"type": "daylight", "min_health": 1}, 120.0)
        return action("留在封闭庇护所安全守到天亮", "wait_for_day", {"timeout_s": 280}, {"type": "daylight", "min_health": 1}, 300.0)
    if urgent and shelter_ready and not inside:
        center = shelter.get("position") or {}
        try:
            x, y, z = (int(round(float(center[axis]))) for axis in "xyz")
        except (KeyError, TypeError, ValueError):
            return action("在当前位置搭建紧急庇护所", "make_shelter", {"size": 4}, {"type": "shelter"})
        return action("进入已验证的封闭庇护所", "goto", {"x": x, "y": y + 1, "z": z}, {"type": "inside_shelter"}, 120.0)

    if urgent and shelter_ready and inside and day is True:
        if food < 8 and any(inventory_count(inventory, item) > 0 for item in FOOD_ITEMS):
            return action("在庇护所内用现有食物恢复", "eat_if_hungry", {"threshold": 8, "count": 0}, {"type": "food", "min": 8}, 60.0)
        return None

    # 已有应急 shelter 时，白天显式开出口再外出，避免采集动作挖穿结构。
    if shelter_ready and inside and day is True and (not food_ready or (not bed_stock and not bed_inside)):
        goal_state["emergency_shelter_departed"] = True
        return action("白天从应急庇护所开出口外出补齐材料", "leave_shelter", {"range": 3}, {"type": "outside_shelter"}, 120.0)

    # 食物只作为生存阈值，不是阶段库存产物；桥接会在可食用库存中选来源。
    if not food_ready:
        if any(inventory_count(inventory, item) > 0 for item in FOOD_ITEMS):
            return action("用背包里的可用食物补到安全饥饿值", "eat_if_hungry", {"threshold": 8, "count": 0}, {"type": "food", "min": 8}, 60.0)
        return action("按附近动物来源补充食物", "hunt_animal", {"count": 3, "radius": 64, "min_health": 10}, {"type": "inventory_any", "items": ["beef", "porkchop", "chicken", "rabbit", "mutton"], "count": 1}, 250.0)

    if not bed_inside and not bed_stock:
        if not _bed_wool_color(inventory):
            if inventory_count(inventory, "shears") > 0:
                return action("剪羊毛准备床", "shear_sheep", {"count": 3, "radius": 96, "color": "auto"}, {"type": "inventory", "items": {"wool": 3}}, 300.0)
            if inventory_count(inventory, "iron_ingot") >= 2:
                return action("用现有铁锭合成剪刀", "craft", {"item": "shears", "count": 1}, {"type": "inventory", "items": {"shears": 1}}, 60.0)
            return action("寻找成年羊，收集三块同色羊毛", "hunt_material", {"item": "wool", "count": 3, "radius": 64, "min_health": 10}, {"type": "inventory", "items": {"wool": 3}}, 250.0)

        if inventory_count(inventory, "crafting_table") < 1 and not _nearby_crafting_table(state):
            return early_craft(inventory, "crafting_table")
        plank_step = early_planks(inventory, 3, "床")
        if plank_step:
            return plank_step
        return action("合成床并暂存在背包，等待室内放置", "craft_bed", {"count": 1, "place": False, "color": "auto"}, {"type": "inventory", "items": {"bed": 1}}, 120.0)

    # 外出工作完成后才封闭；开过应急出口时按当前背包净缺口重新补材料。
    if not shelter_ready:
        missing_blocks = _shelter_missing_blocks(state, inventory)
        if missing_blocks > 0:
            return collect_block("dirt", missing_blocks, "最终庇护所方块", 250.0)
        surface = state.get("surface_access") or {}
        exit_pos = surface.get("exit")
        sky_light = surface.get("sky_light")
        if (day is True and not shelter.get("position") and isinstance(sky_light, (int, float)) and sky_light < 8
                and isinstance(exit_pos, dict) and all(isinstance(exit_pos.get(axis), (int, float))
                                                        and math.isfinite(exit_pos[axis]) for axis in "xyz")):
            return action("从取土坑回到已观察到的露天地面再选址", "goto", dict(exit_pos),
                          {"type": "position", "target": dict(exit_pos), "radius": 2}, 90.0)
        return action("搭建最终全封闭庇护所", "make_shelter", {"size": 4}, {"type": "shelter"})

    if not inside:
        center = shelter.get("position") or {}
        try:
            x, y, z = (int(round(float(center[axis]))) for axis in "xyz")
        except (KeyError, TypeError, ValueError):
            return action("重建并进入庇护所", "make_shelter", {"size": 4}, {"type": "shelter"})
        return action("进入已验证的庇护所放置床", "goto", {"x": x, "y": y + 1, "z": z}, {"type": "inside_shelter"}, 120.0)

    if not bed_inside:
        beds = _bed_ids(inventory)
        if not beds:
            return action("补制一张室内床", "craft_bed", {"count": 1, "place": False, "color": "auto"}, {"type": "inventory", "items": {"bed": 1}}, 120.0)
        bounds = _shelter_bounds(shelter)
        if bounds is None:
            return action("重新确认庇护所边界", "make_shelter", {"size": 4}, {"type": "shelter"})
        x = math.floor((bounds["min"]["x"] + bounds["max"]["x"]) / 2)
        z = math.floor((bounds["min"]["z"] + bounds["max"]["z"]) / 2)
        y = math.floor(bounds["min"]["y"] + 1)
        return action("把床放在庇护所内部", "place_block", {"block": beds[0], "x": x, "y": y, "z": z}, {"type": "bed_inside"}, 60.0)

    if goal_state.get("night_required"):
        if day is False:
            return action("在庇护所内睡到天亮", "sleep_safe", {"range": 16}, {"type": "daylight", "min_health": 1}, 120.0)
        if day is True and not (goal_state.get("sleep_confirmed") or goal_state.get("guarded_night_confirmed")):
            return None
    return None


def _s3_food_count(inventory: dict[str, Any]) -> int:
    return sum(inventory_count(inventory, item) for item in FOOD_ITEMS)


def _s3_action(
    description: str,
    tool: str,
    arguments: dict[str, Any],
    verify: dict[str, Any],
    timeout: float = 180.0,
) -> StepSpec:
    return StepSpec(description, tool, arguments, verify, retries=2, timeout_s=timeout, effect_class="replan")


def _s3_wood_search_context(state: dict[str, Any]) -> str:
    position = state.get("position") or {}
    dimension = str(state.get("dimension") or "").strip().lower()
    if dimension in {"overworld", "minecraft:overworld"}:
        dimension = "overworld"
    try:
        x, y, z = (float(position[axis]) for axis in "xyz")
    except (KeyError, TypeError, ValueError):
        return ""
    if not all(math.isfinite(value) for value in (x, y, z)):
        return ""
    region = f"{dimension}:{math.floor(x / 32)}:{math.floor(y / 8)}:{math.floor(z / 32)}"
    access = state.get("surface_access") or {}
    if access.get("connected_land") is True:
        return f"{region}:land"
    return f"{region}:surface" if dimension == "overworld" and access.get("sky_light") == 15 and not access.get("exit") else region


def _s3_no_resource_wood_logs(goal_state: dict[str, Any], context: str) -> set[str]:
    unavailable: set[str] = set()
    for entry in goal_state.get("action_history") or []:
        if not isinstance(entry, dict):
            continue
        if entry.get("tool") != "mine_collect" or entry.get("status") not in {"blocked", "failed"}:
            continue
        if entry.get("receipt_confirmed") is not True:
            continue
        log = str((entry.get("arguments") or {}).get("block") or "")
        if log not in S3_OVERWORLD_WOOD_LOGS:
            continue
        detail = str(entry.get("result_detail") or "")
        if "附近" not in detail or "一个都没有找到" not in detail:
            continue
        failed_context = str(entry.get("wood_search_context") or "")
        if not failed_context:
            observation = entry.get("terminal_observation")
            if not isinstance(observation, dict):
                result_data = entry.get("result_data") or {}
                observation = result_data.get("observation") if isinstance(result_data, dict) else None
            if isinstance(observation, dict):
                failed_context = _s3_wood_search_context(observation)
        if not failed_context or failed_context == context:
            unavailable.add(log)
    return unavailable


def _local_surface_exit(state: dict[str, Any]) -> dict | None:
    position = state.get("position") or {}
    target = (state.get("surface_access") or {}).get("exit")
    if (isinstance(target, dict) and all(isinstance(p.get(a), (int, float)) and math.isfinite(p[a])
                                         for p in (position, target) for a in "xyz")
            and 0 < target["y"] - position["y"] <= 24
            and math.hypot(target["x"] - position["x"], target["z"] - position["z"]) <= 8):
        return target
    return None


def _s3_needs_surface_route(state: dict[str, Any]) -> bool:
    position = state.get("position") or {}
    try:
        y = float(position["y"])
    except (KeyError, TypeError, ValueError):
        return False
    if not math.isfinite(y):
        return False
    surface = state.get("surface_access") or {}
    nearby = _local_surface_exit(state)
    if nearby and nearby["y"] - y >= 2 and surface.get("connected_land") is not True:
        return True
    shelter = state.get("shelter") or {}
    anchor = shelter.get("position") or {}
    try:
        anchor_y = float(anchor["y"])
    except (KeyError, TypeError, ValueError):
        return y < 60.0
    return math.isfinite(anchor_y) and y < anchor_y - S3_SURFACE_ROUTE_MIN_VERTICAL


def _s4_return_stair(state: dict[str, Any], ledger: dict[str, Any]) -> dict | None:
    if str(state.get("dimension")).removeprefix("minecraft:") != "overworld":
        return None
    position = state.get("position") or {}
    if not all(type(position.get(a)) in (int, float) and math.isfinite(position[a]) for a in "xyz"):
        return None
    failures = (ledger.get("counters") or {}).get("method_failures") or {}
    for stair in reversed(ledger.get("s4_mining_stairs") or []):
        top, bottom = stair["top"], stair["bottom"]
        if not 2 < top["y"] - position["y"] <= S4_DESCENT_STEP + 2:
            continue
        if math.dist(tuple(bottom[a] for a in "xyz"), tuple(position[a] for a in "xyz")) > 8:
            continue
        if not failures.get(_s4_stair_key(top)):
            return stair
    return None


def _s4_stair_key(target: dict) -> str:
    return "s4:return_stair:" + ":".join(str(target[a]) for a in "xyz")


def _s3_return_to_known_surface(
    state: dict[str, Any], goal_state: dict[str, Any], *, staged_supply_route: bool = False,
) -> StepSpec | None:
    dimension = str(state.get("dimension") or "").strip().lower()
    if dimension not in {"overworld", "minecraft:overworld"}:
        goal_state["s3_preflight_terminal_reason"] = "当前不在主世界，不能使用主世界庇护所锚点规划返地表路线"
        return None
    position = state.get("position") or {}
    nearby_exit = _local_surface_exit(state)
    if nearby_exit:
        target = dict(nearby_exit)
        if _danger_now(state) or (_is_day(state) is not True and target["y"] - position["y"] <= 8):
            goal_state["s3_preflight_wait_reason"] = "在出口下方等到白天且附近安全后再外出"
            return None
        if _is_day(state) is not True:
            target["y"] = min(math.floor(position["y"]) + 6, target["y"] - 5)
        elif target["y"] - position["y"] > 12:
            target["y"] = math.floor(position["y"]) + 6
        return _s3_action("分段返回附近已观察到的露天地面", "goto", target,
                          {"type": "position", "target": target, "radius": 2.0}, 90.0)
    stair = _s4_return_stair(state, goal_state)
    if stair:
        if _danger_now(state) or (stair.get("outdoors") and _is_day(state) is not True):
            goal_state["s3_preflight_wait_reason"] = "在已走过的矿道里等待安全返程时机"
            return None
        target = stair["top"]
        return _s3_action("沿已走过的干燥矿道回到上一段入口", "goto", {**target, "dry_only": True},
                          {"type": "position", "target": target, "radius": 2.0, "site": "mining_stair"}, 70.0)
    shelter = state.get("shelter") or {}
    anchor = shelter.get("position") or {}
    try:
        current = {axis: float(position[axis]) for axis in "xyz"}
        target = {axis: float(anchor[axis]) for axis in "xyz"}
        size = int(shelter.get("size"))
    except (KeyError, TypeError, ValueError):
        goal_state["s3_preflight_terminal_reason"] = "地下缺少有效的已知庇护所锚点，不能盲目选择上行坐标"
        return None
    if size < 4 or not all(math.isfinite(value) for value in (*current.values(), *target.values())):
        goal_state["s3_preflight_terminal_reason"] = "已知庇护所锚点无效，不能规划安全返地表路线"
        return None
    horizontal = math.hypot(target["x"] - current["x"], target["z"] - current["z"])
    vertical = target["y"] - current["y"]
    far_anchor = horizontal > S3_SURFACE_ROUTE_MAX_HORIZONTAL
    if vertical < S3_SURFACE_ROUTE_MIN_VERTICAL or (not staged_supply_route and (far_anchor or vertical > 96)):
        goal_state["s3_preflight_terminal_reason"] = "已知庇护所锚点不在有界返地表路线范围内"
        return None
    if staged_supply_route and (vertical > 16 or (far_anchor and _is_day(state) is True)):
        if _danger_now(state):
            goal_state["s3_preflight_wait_reason"] = "等待安全控制处理附近危险后继续返地表"
            return None
        # 暗洞白天也可能刷怪。先分段靠近已知出口，临近地表时再按昼夜决定是否外出。
        scale = min(1.0, 6 / max(1.0, horizontal))
        waypoint = {axis: round(current[axis] + (target[axis] - current[axis]) * scale) for axis in ("x", "z")}
        climb = min(8, math.floor(vertical) - 10) if vertical > 16 else min(4, math.floor(vertical))
        waypoint["y"] = math.floor(current["y"]) + climb
        return _s3_action("分段向已知庇护所上行补给", "goto", waypoint,
                          {"type": "position", "target": waypoint, "radius": 3.0, "site": "supply_ascent"}, 90.0)
    if _is_day(state) is not True:
        goal_state["s3_preflight_wait_reason"] = "等待白天再沿已知庇护所路线外出补给" if staged_supply_route else "夜间留在当前位置，白天再沿已知庇护所路线返回采木"
        return None
    target_position = {axis: round(target[axis]) for axis in "xyz"}
    target_position["y"] += 1
    return _s3_action(
        "白天沿已知庇护所坐标安全返回地表取木",
        "goto",
        target_position,
        {"type": "position", "target": target_position, "radius": 3.0},
        180.0,
    )


def _s3_ensure_planks(
    inventory: dict[str, Any],
    target: int,
    label: str,
    state: dict[str, Any],
    goal_state: dict[str, Any],
) -> StepSpec | None:
    step = early_planks(inventory, target, label)
    if step is None:
        return None
    if step.tool == "mine_collect":
        if _s3_needs_surface_route(state):
            return _s3_return_to_known_surface(state, goal_state, staged_supply_route=goal_state.get("stage") in {"S4", "S5", "S6"})
        if _is_day(state) is not True:
            day = state.get("day")
            sleep_failures = (goal_state.get("counters") or {}).get("method_failures") or {}
            if (_is_day(state) is False and isinstance(day, int) and not sleep_failures.get(f"wood_sleep:day{day}")
                    and str(state.get("dimension")).removeprefix("minecraft:") == "overworld"
                    and (state.get("resource_sites") or {}).get("sleep_bed") and not _danger_now(state)):
                return _s3_action("用已观察到的床睡到天亮后采木", "sleep_safe", {"range": 32},
                                  {"type": "daylight", "min_health": 1}, 120)
            goal_state["s3_preflight_wait_reason"] = "夜间不外出采木，等待白天后再采集木材"
            return None
    return step


def _s3_ensure_sticks(
    inventory: dict[str, Any],
    target: int,
    label: str,
    state: dict[str, Any],
    goal_state: dict[str, Any],
) -> StepSpec | None:
    have = inventory_count(inventory, "stick")
    if have >= target:
        return None
    missing = target - have
    operations = (missing + 3) // 4
    plank_step = _s3_ensure_planks(inventory, operations * 2, f"{label}木棍", state, goal_state)
    if plank_step is not None or goal_state.get("s3_preflight_wait_reason") or goal_state.get("s3_preflight_terminal_reason"):
        return plank_step
    return _s3_action(
        f"合成{label}所需木棍",
        "craft",
        {"item": "stick", "count": missing},
        {"type": "inventory", "items": {"stick": target}},
        60.0,
    )


def choose_s3_preflight_action(
    state: dict[str, Any], goal_state: dict[str, Any]
) -> tuple[bool, StepSpec | None]:
    """S3 每次动作前按新观察补齐食物、安全出口与实际挖矿依赖。"""
    goal_state.pop("s3_preflight_wait_reason", None)
    goal_state.pop("s3_preflight_terminal_reason", None)
    inventory = state.get("inventory") or {}
    shelter = state.get("shelter") or {}
    inside = shelter.get("inside") is True
    food_stock = _s3_food_count(inventory)
    try:
        food = float(state.get("food", 0) or 0)
        health = float(state.get("health", 0) or 0)
    except (TypeError, ValueError):
        food = 0.0
        health = 0.0
    if not math.isfinite(food):
        food = 0.0
    if not math.isfinite(health):
        health = 0.0

    def wait(reason: str) -> tuple[bool, StepSpec | None]:
        goal_state["s3_preflight_wait_reason"] = reason
        return False, None

    def defer(step: StepSpec | None) -> tuple[bool, StepSpec | None] | None:
        if step is not None or goal_state.get("s3_preflight_wait_reason") or goal_state.get("s3_preflight_terminal_reason"):
            return False, step
        return None

    def eat() -> tuple[bool, StepSpec | None]:
        goal_state.pop("s3_preflight_wait_reason", None)
        return False, _s3_action(
            "在安全位置用现有食物补到下矿阈值",
            "eat_if_hungry",
            {"threshold": S3_SAFE_FOOD, "count": 0},
            {"type": "food", "min": S3_SAFE_FOOD},
            60.0,
        )

    if not isinstance(shelter.get("inside"), bool):
        return wait("等待 Bridge 明确观察角色位于庇护所内还是室外")

    if inside:
        if food < S3_SAFE_FOOD and food_stock > 0:
            return eat()
        if _is_day(state) is not True or _danger_now(state) or health <= 10:
            return wait("留在庇护所，等到白天且附近安全、血量恢复后再外出")
        goal_state.pop("s3_preflight_wait_reason", None)
        return False, _s3_action(
            "白天从庇护所开出口外出准备下矿",
            "leave_shelter",
            {"range": 3},
            {"type": "outside_shelter"},
            120.0,
        )

    if _danger_now(state) or health <= 10:
        return wait("附近安全且血量恢复后再准备下矿")

    if food < S3_SAFE_FOOD and food_stock > 0:
        return eat()
    has_table = inventory_count(inventory, "crafting_table") > 0 or _nearby_crafting_table(state)
    ingots = inventory_count(inventory, "iron_ingot")
    iron_gap = max(0, _s3_iron_ingot_requirement(inventory) - ingots)
    raw = inventory_count(inventory, "raw_iron")
    can_process_iron = (has_table and raw >= iron_gap and food >= S3_SAFE_FOOD
                        and (not iron_gap or inventory_count(inventory, "furnace") or inventory_count(inventory, "cobblestone") >= 8))
    if food_stock < S3_FOOD_RESERVE and not can_process_iron:
        if _is_day(state) is not True or _hunt_closing(state):
            return wait("等待白天有足够时间寻找食物，再补足储备")
        goal_state.pop("s3_preflight_wait_reason", None)
        return False, _s3_action(
            "在安全的白天从附近动物补足下矿食物储备",
            "hunt_animal",
            {"count": 3, "radius": 64, "min_health": 10},
            {"type": "inventory_any", "items": sorted(FOOD_ITEMS), "count": 3},
            250.0,
        )
    goal_state.pop("s3_preflight_wait_reason", None)
    has_mining_pickaxe = any(inventory_count(inventory, item) > 0 for item in S3_MINING_PICKAXES)
    if has_table:
        if not has_mining_pickaxe and ingots >= 3 and inventory_count(inventory, "stick") < 2:
            wood = early_planks(inventory, 2, "铁镐木棍")
            if wood is None or wood.tool == "craft":
                return False, _s3_ensure_sticks(inventory, 2, "铁镐", state, goal_state)
        for item, cost in S3_IRON_COSTS.items():
            if inventory_count(inventory, item) or ingots < cost:
                continue
            sticks = {"iron_pickaxe": 2, "iron_sword": 1}.get(item, 0)
            if inventory_count(inventory, "stick") < sticks:
                continue
            if item == "shield" and early_planks(inventory, 6, "盾牌") is not None:
                continue
            return False, _s3_gear_step(item)

    has_any_pickaxe = any(inventory_count(inventory, item) > 0 for item in S3_ANY_PICKAXES)
    if (iron_gap and raw >= iron_gap and inventory_count(inventory, "furnace") and has_any_pickaxe
            and (has_table or not ingots or early_planks(inventory, 4, "工作台") is not None)):
        # 现有熔炉无需工作台。先做可执行的生产步骤，缺木只推迟用木的配方。
        return True, None

    if not has_table:
        plank_step = _s3_ensure_planks(inventory, 4, "工作台", state, goal_state)
        deferred = defer(plank_step)
        if deferred is not None:
            return deferred
        return False, _s3_action(
            "补齐下矿与铁制工具合成所需工作台",
            "craft",
            {"item": "crafting_table", "count": 1},
            {"type": "inventory", "items": {"crafting_table": 1}},
            60.0,
        )

    needs_stone_pickaxe = not has_mining_pickaxe and raw < iron_gap
    needs_wooden_pickaxe = not has_any_pickaxe and (
        (needs_stone_pickaxe and inventory_count(inventory, "cobblestone") < 3)
        or (not needs_stone_pickaxe and iron_gap > 0)
    )
    final_sticks = (2 if inventory_count(inventory, "iron_pickaxe") < 1 else 0) + (
        1 if inventory_count(inventory, "iron_sword") < 1 else 0
    )
    mining_sticks = (2 if needs_stone_pickaxe else 0) + (2 if needs_wooden_pickaxe else 0)

    if needs_wooden_pickaxe:
        plank_step = _s3_ensure_planks(inventory, 3, "木镐", state, goal_state)
        deferred = defer(plank_step)
        if deferred is not None:
            return deferred
        stick_step = _s3_ensure_sticks(inventory, final_sticks + mining_sticks, "木镐", state, goal_state)
        deferred = defer(stick_step)
        if deferred is not None:
            return deferred
        return False, _s3_action(
            "合成采石或回收熔炉所需木镐",
            "craft",
            {"item": "wooden_pickaxe", "count": 1},
            {"type": "inventory", "items": {"wooden_pickaxe": 1}},
            60.0,
        )

    if needs_stone_pickaxe and inventory_count(inventory, "cobblestone") < 3:
        if not has_any_pickaxe:
            return wait("需要先恢复木镐后才能安全采集石料")
        return False, _s3_action(
            "采集石镐所需圆石",
            "mine_collect",
            {"block": "stone", "count": 3, "range": 48},
            {"type": "inventory", "items": {"cobblestone": 3}},
            250.0,
        )

    if needs_stone_pickaxe:
        stick_step = _s3_ensure_sticks(inventory, final_sticks + 2, "石镐", state, goal_state)
        deferred = defer(stick_step)
        if deferred is not None:
            return deferred
        return False, _s3_action(
            "合成下矿所需石镐",
            "craft",
            {"item": "stone_pickaxe", "count": 1},
            {"type": "inventory", "items": {"stone_pickaxe": 1}},
            60.0,
        )

    if final_sticks > 0:
        stick_step = _s3_ensure_sticks(inventory, final_sticks, "铁制工具", state, goal_state)
        deferred = defer(stick_step)
        if deferred is not None:
            return deferred
    plank_target = 6 if inventory_count(inventory, "shield") < 1 else 0
    wood_inventory = inventory
    if (raw < iron_gap and isinstance(state.get("resource_sites"), dict)
            and _is_day(state) and not _s3_needs_surface_route(state)):
        # 地表出发前带足这一批铁的备用燃料。已携带的煤或木炭按整批抵扣。
        coal_units = inventory_count(inventory, "coal") + inventory_count(inventory, "charcoal")
        fuel_planks = _s3_smelt_fuel_need(max(0, iron_gap - 8 * coal_units), "oak_planks")
        if fuel_planks:
            wood_inventory = {name: count for name, count in inventory.items() if not name.startswith(("crimson_", "warped_"))}
            plank_target += fuel_planks
    if plank_target:
        plank_step = _s3_ensure_planks(wood_inventory, plank_target, "盾牌与熔炼燃料", state, goal_state)
        shield_wood = 0 if inventory_count(inventory, "shield") else 6
        if plank_step and plank_step.tool == "mine_collect" and plank_target > shield_wood:
            required = early_planks(inventory, shield_wood, "盾牌")
            if required:
                return False, required
            # 可选备用燃料只顺手采一次。收据失败后仍可按原计划下矿。
            attempts = (goal_state.get("counters") or {}).get("attempts") or {}
            if state.get("collection_within_reach") is not True or attempts.get("s3:surface_fuel_wood", 0):
                return True, None
            plank_step = replace(plank_step, arguments={**plank_step.arguments, "within_reach": True})
        deferred = defer(plank_step)
        if deferred is not None:
            return deferred
    return True, None


def _s3_iron_ingot_requirement(inventory: dict[str, Any]) -> int:
    return sum(
        cost
        for item, cost in S3_IRON_COSTS.items()
        if inventory_count(inventory, item) < 1
    )


def _s3_gear_step(item: str) -> StepSpec:
    return _s3_action(f"合成{item}以满足 S3 目标", "craft", {"item": item, "count": 1},
                      {"type": "inventory", "items": {item: 1}}, 60.0)


def _s3_smelt_fuel_need(count: int, fuel_item: str) -> int:
    burn = S3_FUEL_BURN[fuel_item]
    total = 0
    remaining = count
    while remaining > 0:
        batch = min(8, remaining)
        total += math.ceil(batch / burn)
        remaining -= batch
    return total


def _s3_relocate(state: dict[str, Any], goal_state: dict[str, Any]) -> StepSpec | None:
    position = state.get("position") or {}
    try:
        y = float(position["y"])
    except (KeyError, TypeError, ValueError):
        y = math.inf
    surface = state.get("surface_access") or {}
    exit_y = (surface.get("exit") or {}).get("y")
    if (goal_state.get("s3_relocation_failed") and not surface.get("in_water") and not surface.get("connected_land")
            and isinstance(exit_y, (int, float)) and 1 <= exit_y - y <= 16
            and not _danger_now(state) and (state.get("health") or 0) > 10):
        rise = min(4, math.ceil(exit_y - y))
        return StepSpec("沿干燥台阶接近已观察到的地表出口", "strip_mine", {"rise": rise},
                        {"type": "min_height", "y": math.floor(y) + rise, "site": "mining_exit"},
                        retries=1, timeout_s=100, effect_class="replan")
    if (goal_state.get("s3_relocation_failed") and not goal_state.get("s3_relocation_surface_return_used")
            and _s3_needs_surface_route(state)):
        surface = _s3_return_to_known_surface(state, goal_state)
        if surface is not None:
            return replace(surface, description="换矿区受阻，沿已知庇护所路线返回地表")
    if not math.isfinite(y):
        goal_state["s3_resource_block_reason"] = "缺少有效位置，无法安全换矿区"
        return None
    avoid = list(goal_state.get("s3_ore_avoid_positions") or [])
    origin = state.get("position") or {}
    if all(isinstance(origin.get(axis), (int, float)) and math.isfinite(origin[axis]) for axis in "xyz"):
        if not any(math.hypot(p["x"] - origin["x"], p["z"] - origin["z"]) < 8 for p in avoid):
            avoid.append({axis: float(origin[axis]) for axis in "xyz"})
        goal_state["s3_ore_avoid_positions"] = avoid[-128:]
    else:
        goal_state["s3_resource_block_reason"] = "缺少有效位置，无法安全换矿区"
        return None
    arguments = {"avoid_positions": avoid[-128:], "min_distance": 16}
    if goal_state.get("s3_relocation_failed") and (state.get("surface_access") or {}).get("connected_land"):
        last = next((a for a in reversed(goal_state.get("action_history", []))
                     if a.get("receipt_confirmed") and a.get("status") != "rejected_before_start"), {})
        route = (last.get("result_data") or {}).get("relocation") or {}
        start = route.get("origin") or {}
        if (last.get("tool") == "explore_mining_site" and last.get("status") == "blocked"
                and (last.get("arguments") or {}).get("connected_route") and route.get("attempted_positions") == []
                and all(isinstance(start.get(a), (int, float)) for a in "xyz")
                and math.dist(tuple(origin[a] for a in "xyz"), tuple(start[a] for a in "xyz")) < 3
                and not _danger_now(state) and (state.get("health") or 0) > 10):
            return StepSpec("干地出口不够远，从矮壁开两级台阶再换矿区", "strip_mine", {"rise": 2},
                            {"type": "min_height", "y": math.floor(y) + 2, "site": "mining_exit"},
                            retries=1, timeout_s=100, effect_class="replan")
        arguments["connected_route"] = True
    return StepSpec("离开已耗尽的探矿区域并寻找安全新矿区", "explore_mining_site", arguments,
                    {"type": "s3_mining_relocation", "min_distance": 16},
                    retries=1, timeout_s=180.0, effect_class="replan")


def start_s3_ore_region(goal_state: dict[str, Any]) -> None:
    goal_state["s3_ore_regions"] = int(goal_state.get("s3_ore_regions", 0)) + 1
    goal_state["s3_ore_expose_used"] = 0
    goal_state["s3_ore_no_progress"] = 0
    for key in ("s3_relocation_failed", "s3_relocation_surface_return_used", "s3_low_oxygen_relocation_required",
                "last_s3_mining_failure", "s3_resource_block_reason"):
        goal_state.pop(key, None)


def _s3_new_mining_area_after_reconnect(state: dict, ledger: dict) -> bool:
    before = ((ledger.get("last_s3_mining_failure") or {}).get("data") or {}).get("observation") or {}
    if not (state.get("ready") and state.get("alive") and state.get("session_id") and before.get("session_id")
            and before["session_id"] != state["session_id"] and not _danger_now(state)):
        return False
    if any(str(obs.get("dimension")).removeprefix("minecraft:") != "overworld" for obs in (before, state)):
        return False
    a, b = before.get("position") or {}, state.get("position") or {}
    if not all(isinstance(pos.get(axis), (int, float)) and math.isfinite(pos[axis]) for pos in (a, b) for axis in ("x", "z")):
        return False
    # 两个半径 64 格的采铁区域已完全分离，重生后的新位置可以直接试采。
    return math.hypot(a["x"] - b["x"], a["z"] - b["z"]) > 128


def choose_s3_resource_action(state: dict[str, Any], goal_state: dict[str, Any]) -> StepSpec | None:
    """按缺失铁制品净成本选择采矿、熔炼与逐件合成动作。"""
    if goal_state.get("s3_low_oxygen_relocation_required"):
        return _s3_relocate(state, goal_state)
    inventory = state.get("inventory") or {}
    ingots = inventory_count(inventory, "iron_ingot")
    raw_iron = inventory_count(inventory, "raw_iron")
    iron_needed = _s3_iron_ingot_requirement(inventory)
    if ingots < iron_needed:
        raw_target = iron_needed - ingots
        if raw_iron < raw_target:
            position = state.get("position") or {}
            try:
                y = float(position["y"])
            except (KeyError, TypeError, ValueError):
                y = math.inf
            ore_block = "deepslate_iron_ore" if y < 0 else "iron_ore"
            if goal_state.get("s3_ore_no_progress") and _s3_new_mining_area_after_reconnect(state, goal_state):
                start_s3_ore_region(goal_state)
            no_progress = int(goal_state.get("s3_ore_no_progress", 0))
            if no_progress > 0:
                exposed = int(goal_state.get("s3_ore_expose_used", 0))
                failure = goal_state.get("last_s3_mining_failure") or {}
                failure_data = failure.get("data") or {}
                candidates = failure_data.get("candidates") or []
                water_blocked = (failure_data.get("reason") == "no_safe_stair" and bool(candidates)
                                 and all(isinstance(c, dict) and c.get("name") in {"water", "bubble_column"} for c in candidates))
                if exposed < S3_ORE_EXPOSE_MAX and math.isfinite(y) and not water_blocked:
                    no_stair = failure_data.get("reason") == "no_safe_stair"
                    descend = y > 16 and not no_stair
                    target_y = max(16, math.floor(y) - 12) if descend else math.floor(y)
                    args = {"length": 1 if descend else 12, "branches": 0,
                            "branchLength": 1, "shaft": max(0, math.floor(y) - target_y),
                            "target": ore_block, "torchInterval": 0,
                            "direction": ("south", "east", "north", "west")[exposed % 4]}
                    if descend:
                        args["y"] = target_y
                    return StepSpec("向铁矿常见高度分段下探，随后水平探露", "strip_mine", args,
                                    {"type": "always"}, retries=1, timeout_s=240.0, effect_class="non_replayable")
                return _s3_relocate(state, goal_state)
            return _s3_action(
                "从当前观察位置采集达到目标总量所需的铁矿",
                "mine_collect",
                {"block": ore_block, "count": raw_target, "range": 64,
                 **({"avoid_positions": list(goal_state.get("s3_mining_hazards") or [])[-128:]}
                    if goal_state.get("s3_mining_hazards") else {})},
                {"type": "inventory", "items": {"raw_iron": raw_target}},
                250.0,
            )

        batch_count = min(raw_iron, iron_needed - ingots)
        if inventory_count(inventory, "furnace") < 1:
            cobble = inventory_count(inventory, "cobblestone")
            if cobble < 8:
                return _s3_action(
                    "采集熔炼铁矿所需圆石",
                    "mine_collect",
                    {"block": "stone", "count": 8, "range": 48},
                    {"type": "inventory", "items": {"cobblestone": 8}},
                    250.0,
                )
            return _s3_action(
                "合成熔炼铁矿所需熔炉",
                "craft",
                {"item": "furnace", "count": 1},
                {"type": "inventory", "items": {"furnace": 1}},
                60.0,
            )

        # 单批至多 8 个，使用当前能支撑的燃料；先留足尚未制作盾牌所需木板。
        batch_count = min(batch_count, 8)
        coal = inventory_count(inventory, "coal")
        reserve = 6 if inventory_count(inventory, "shield") < 1 else 0
        if not inventory_count(inventory, "crafting_table") and not _nearby_crafting_table(state):
            reserve += 4
        sticks = (2 if not inventory_count(inventory, "iron_pickaxe") else 0) + (1 if not inventory_count(inventory, "iron_sword") else 0)
        if inventory_count(inventory, "stick") < sticks:
            reserve += 2
        available = {name: max(0, inventory_count(inventory, name) - (reserve if name.endswith("_planks") else 0))
                     for name in S3_FUEL_BURN}
        fuel_item = max(available, key=lambda name: available[name] * S3_FUEL_BURN[name])
        capacity = math.floor(available[fuel_item] * S3_FUEL_BURN[fuel_item])
        if capacity < 1:
            if (isinstance(state.get("resource_sites"), dict) and not goal_state.get("s3_coal_search_attempted")
                    and (_is_day(state) is True or state.get("collection_within_reach") is True)
                    and any(inventory_count(inventory, item) > 0 for item in S3_ANY_PICKAXES)):
                return _s3_action(
                    "缺少熔炼燃料，采煤并顺路补充储备", "mine_collect",
                    {"block": "coal_ore", "count": 16, "minimum_count": coal + 1, "range": 48,
                     **({"within_reach": True} if _is_day(state) is not True else {})},
                    {"type": "inventory", "items": {"coal": coal + 1}}, 250.0,
                )
            surface = state.get("surface_access") or {}
            if (goal_state.get("s3_coal_search_attempted") and _is_day(state) is False
                    and state.get("collection_within_reach") is True and _s3_needs_surface_route(state)
                    and not surface.get("in_water") and not _danger_now(state)
                    and (state.get("health") or 0) >= 16 and (state.get("food") or 0) >= 14
                    and any(inventory_count(inventory, p) for p in S3_MINING_PICKAXES)
                    and not ((goal_state.get("counters") or {}).get("attempts") or {}).get("s3:nearby_coal")):
                return _s3_action("井下缺燃料，沿干燥、有支撑的短通道采近处煤矿", "mine_collect",
                                  {"block": "coal_ore", "count": coal + 1, "range": 12, "local_vein": True},
                                  {"type": "inventory", "items": {"coal": coal + 1}}, 100.0)
            fuel_inventory = {name: count for name, count in inventory.items() if not name.startswith(("crimson_", "warped_"))}
            return _s3_ensure_planks(fuel_inventory, reserve + math.ceil(batch_count / 1.5), "熔炼燃料", state, goal_state)
        batch_count = min(batch_count, capacity)
        iron_target_after_batch = ingots + batch_count
        return _s3_action(
            "按当前铁锭缺口熔炼这一批铁矿",
            "smelt_batch",
            {"item": "raw_iron", "count": batch_count, "output": "iron_ingot", "fuel": fuel_item},
            {"type": "inventory", "items": {"iron_ingot": iron_target_after_batch}},
            250.0,
        )

    for item in ("iron_pickaxe", "iron_sword", "shield", "bucket"):
        if inventory_count(inventory, item) < 1:
            return _s3_gear_step(item)
    goal_state.pop("s3_resource_block_reason", None)
    return None


S4_DIAMOND_TARGET = 3
S4_FOOD_RESERVE = 2
S4_MIN_HEALTH = 10
S4_DESCENT_STEP = 12
S4_TARGET_Y = -56
S4_DIAMOND_SEARCH_TOP_Y = 16
S4_MAX_DESCENT_SEGMENTS = 12
S4_MAX_SAFE_ROUTE_FALLBACKS = 1
S4_HORIZONTAL_LENGTH = 12
S4_DIAMOND_MINING_PICKAXES = ("iron_pickaxe", "diamond_pickaxe", "netherite_pickaxe")
S4_IRON_MINING_PICKAXES = ("stone_pickaxe", *S4_DIAMOND_MINING_PICKAXES)
S4_STONE_CRAFTING_MATERIALS = ("cobblestone", "cobbled_deepslate", "blackstone")
S4_HUNT_MEAT_ITEMS = ("beef", "porkchop", "chicken", "rabbit")


def _fresh_terminal_state(pending: dict[str, Any], status: str, state: dict[str, Any]) -> bool:
    if status not in {"succeeded", "blocked", "failed"} or pending.get("receipt_confirmed") is not True:
        return False
    result_data = pending.get("result_data") or {}
    admission = pending.get("admission")
    if not isinstance(admission, dict) and isinstance(result_data, dict):
        admission = result_data.get("admission")
    if isinstance(admission, dict) and admission.get("started") is False:
        return False
    try:
        if int(state["revision"]) <= int(pending["revision"]):
            return False
    except (KeyError, TypeError, ValueError):
        return False
    before_session = str(pending.get("session_id") or "")
    current_session = str(state.get("session_id") or "")
    return bool(before_session and current_session and before_session == current_session)


def _fresh_terminal_observation(pending: dict[str, Any], data: dict[str, Any]) -> dict[str, Any] | None:
    result_data = pending.get("result_data") or {}
    if not isinstance(result_data, dict):
        result_data = {}
    observation = data.get("observation") or result_data.get("observation")
    if not isinstance(observation, dict) or not isinstance(observation.get("position"), dict):
        return None
    try:
        if int(observation["revision"]) <= int(pending["revision"]):
            return None
    except (KeyError, TypeError, ValueError):
        return None
    before_session = str(pending.get("session_id") or "")
    observed_session = str(observation.get("session_id") or "")
    if not before_session or not observed_session or before_session != observed_session:
        return None
    return observation


def choose_s4_preflight_action(
    state: dict[str, Any],
    goal_state: dict[str, Any],
) -> tuple[bool, StepSpec | None]:
    inventory = state.get("inventory") or {}
    shelter = state.get("shelter") or {}
    needs_surface_route = _s3_needs_surface_route(state) or bool(_s4_return_stair(state, goal_state))
    is_overworld = str(state.get("dimension") or "").strip().lower() in {
        "overworld",
        "minecraft:overworld",
    }
    food_stock = _s3_food_count(inventory)
    diamonds = inventory_count(inventory, "diamond")
    needs_diamond_mining = diamonds < S4_DIAMOND_TARGET
    try:
        food = float(state.get("food", 0) or 0)
        health = float(state.get("health", 0) or 0)
    except (TypeError, ValueError):
        food = 0.0
        health = 0.0
    if not math.isfinite(food):
        food = 0.0
    if not math.isfinite(health):
        health = 0.0

    def wait(reason: str) -> tuple[bool, StepSpec | None]:
        goal_state["s4_preflight_wait_reason"] = reason
        return False, None

    def block(reason: str) -> tuple[bool, StepSpec | None]:
        goal_state["s4_preflight_block_reason"] = reason
        return False, None

    def propagate_wood_wait_or_block() -> bool:
        wait_reason = str(goal_state.pop("s3_preflight_wait_reason", "") or "")
        terminal_reason = str(goal_state.pop("s3_preflight_terminal_reason", "") or "")
        if wait_reason:
            goal_state["s4_preflight_wait_reason"] = wait_reason
            return True
        if terminal_reason:
            goal_state["s4_preflight_block_reason"] = terminal_reason
            return True
        return False

    def eat_for_safety(threshold: int, reason: str) -> StepSpec:
        return _s3_action(
            reason,
            "eat_if_hungry",
            {"threshold": threshold, "count": 0},
            {"type": "food", "min": threshold},
            60.0,
        )

    def return_to_surface() -> StepSpec | None:
        goal_state.pop("s3_preflight_wait_reason", None)
        goal_state.pop("s3_preflight_terminal_reason", None)
        route = _s3_return_to_known_surface(state, goal_state, staged_supply_route=True)
        if route is None:
            propagate_wood_wait_or_block()
        return route

    def safe_gathering_step(step: StepSpec) -> StepSpec | None:
        tool = step.tool
        if tool not in {"mine_collect", "hunt_animal", "strip_mine", "goto"}:
            return step
        if not is_overworld:
            goal_state["s4_preflight_block_reason"] = "S4 采矿与返地表路线只允许在主世界执行"
            return None
        if health <= S4_MIN_HEALTH:
            if food_stock > 0 and food < 20:
                return eat_for_safety(20, "血量偏低，先用现有食物恢复饥饿值以触发自然回血")
            if needs_surface_route and food_stock < 1:
                return return_to_surface()
            goal_state["s4_preflight_wait_reason"] = "血量偏低，等待自然恢复后再进行采集或移动"
            return None
        if food < S3_SAFE_FOOD and food_stock > 0:
            return eat_for_safety(S3_SAFE_FOOD, "采集前先用现有食物恢复饥饿值")
        if food < 12 and food_stock < 1 and tool != "hunt_animal":
            if needs_surface_route:
                return return_to_surface()
            goal_state["s4_preflight_wait_reason"] = "饥饿值低且没有食物，等待安全补给"
            return None
        inside = shelter.get("inside")
        if tool in {"mine_collect", "hunt_animal"}:
            if not isinstance(inside, bool):
                goal_state["s4_preflight_wait_reason"] = "等待 Bridge 明确观察角色位于庇护所内还是室外"
                return None
            if inside:
                if _is_day(state) is not True or _danger_now(state):
                    goal_state["s4_preflight_wait_reason"] = "仍在庇护所内，等白天且出口附近安全后再外出"
                    return None
                return _s3_action(
                    "从庇护所安全外出准备 S4",
                    "leave_shelter",
                    {"range": 3},
                    {"type": "outside_shelter"},
                    120.0,
                )
        if tool == "hunt_animal" and (_is_day(state) is not True or _hunt_closing(state) or _danger_now(state)):
            goal_state["s4_preflight_wait_reason"] = "等待白天且附近安全后再狩猎补给"
            return None
        return step

    def wood_step(target: int, label: str) -> StepSpec | None:
        goal_state.pop("s3_preflight_wait_reason", None)
        goal_state.pop("s3_preflight_terminal_reason", None)
        step = _s3_ensure_planks(inventory, target, label, state, goal_state)
        if step is None:
            # 与 early_planks 的具体配方验收保持一致，包含其支持的 bamboo_planks。
            if not any(inventory_count(inventory, item) >= target for item in (*S3_WOOD_PLANKS, "bamboo_planks")):
                propagate_wood_wait_or_block()
            return None
        return safe_gathering_step(step)

    goal_state.pop("s4_preflight_wait_reason", None)
    goal_state.pop("s4_preflight_block_reason", None)

    if goal_state.get("s4_threat_position") and is_overworld and health > S4_MIN_HEALTH:
        return True, None
    if needs_diamond_mining and not isinstance(shelter.get("inside"), bool):
        return wait("等待 Bridge 明确观察角色位于庇护所内还是室外")

    reserve_ready = bool(goal_state.get("s4_food_reserve_ready"))
    if needs_diamond_mining and not reserve_ready:
        if health <= S4_MIN_HEALTH:
            if food_stock > 0 and food < 20:
                return False, eat_for_safety(20, "血量偏低，先用现有食物恢复饥饿值以触发自然回血")
            if needs_surface_route and food_stock < 1:
                route = return_to_surface()
                return False, route
            return wait("血量偏低，等待自然恢复后再下矿")
        if food < S3_SAFE_FOOD and food_stock > 0:
            return False, eat_for_safety(S3_SAFE_FOOD, "用现有食物补足下矿饥饿值")
        if food_stock < S4_FOOD_RESERVE:
            if needs_surface_route:
                route = return_to_surface()
                if route is not None:
                    return False, safe_gathering_step(route)
                return False, None
            if _is_day(state) is not True or _hunt_closing(state) or _danger_now(state):
                return wait("下矿前食物储备不足，等待可安全补充食物的户外时机")
            # hunt_animal 的 count 是可狩猎生肉总数；把熟食和其它食物折算进储备，避免多猎。
            hunt_meat_stock = sum(inventory_count(inventory, item) for item in S4_HUNT_MEAT_ITEMS)
            hunt_target = max(1, S4_FOOD_RESERVE - (food_stock - hunt_meat_stock))
            hunt = _s3_action(
                "为 S4 深层采矿补足食物储备",
                "hunt_animal",
                {"count": hunt_target, "radius": 64, "min_health": S4_MIN_HEALTH, "exclude_species": ["sheep"]},
                {"type": "inventory_any", "items": sorted(FOOD_ITEMS), "count": S4_FOOD_RESERVE},
                250.0,
            )
            return False, safe_gathering_step(hunt)
        if food < S3_SAFE_FOOD:
            return wait("食物储备已满足，等待饥饿值恢复到下矿阈值")
        goal_state["s4_food_reserve_ready"] = True
    elif needs_diamond_mining and food < 12:
        if food_stock > 0:
            return False, eat_for_safety(S3_SAFE_FOOD, "深层采矿前用现有食物恢复饥饿值")
        if needs_surface_route:
            route = return_to_surface()
            if route is not None:
                return False, safe_gathering_step(route)
            return False, None
        if _is_day(state) is True and not _danger_now(state):
            hunt = _s3_action(
                "在地表补充 S4 采矿食物",
                "hunt_animal",
                {"count": 1, "radius": 64, "min_health": S4_MIN_HEALTH, "exclude_species": ["sheep"]},
                {"type": "inventory_any", "items": sorted(FOOD_ITEMS), "count": 1},
                250.0,
            )
            return False, safe_gathering_step(hunt)
        return wait("饥饿值过低且背包没有食物，等待安全补给条件")

    if not is_overworld and needs_diamond_mining:
        return block("S4 钻石采矿只允许在主世界执行")

    needs_iron_pickaxe = needs_diamond_mining and not any(
        inventory_count(inventory, item) > 0 for item in S4_DIAMOND_MINING_PICKAXES
    )
    if inventory_count(inventory, "crafting_table") < 1 and not _nearby_crafting_table(state):
        step = wood_step(4, "工作台")
        if step is not None:
            return False, step
        if goal_state.get("s4_preflight_wait_reason") or goal_state.get("s4_preflight_block_reason"):
            return False, None
        return False, _s3_action(
            "补齐 S4 合成工作台",
            "craft",
            {"item": "crafting_table", "count": 1},
            {"type": "inventory", "items": {"crafting_table": 1}},
            60.0,
        )

    stick_target = 2 + (2 if needs_iron_pickaxe else 0)
    surface_access = state.get("surface_access") or {}
    in_mining_tunnel = (goal_state.get("s4_descent_segments") and surface_access.get("sky_light") == 0
                        and surface_access.get("connected_land") is not True)
    if (needs_surface_route or in_mining_tunnel) and needs_diamond_mining:
        # 刚离开庇护所且尚未深挖时可就近补柄。深井或已经下探后优先修复当前采矿工具。
        feet = state.get("position") or {}
        anchor = shelter.get("position") or {}
        near_shelter = (all(isinstance(p.get(a), (int, float)) and math.isfinite(p[a])
                            for p in (feet, anchor) for a in "xyz")
                        and isinstance(shelter.get("size"), int) and shelter["size"] >= 4
                        and 0 < anchor["y"] - feet["y"] <= 24
                        and math.hypot(anchor["x"] - feet["x"], anchor["z"] - feet["z"]) <= 24)
        early_resupply = (near_shelter and _is_day(state) and not _danger_now(state)
                          and health > S4_MIN_HEALTH and food >= S3_SAFE_FOOD
                          and not goal_state.get("s4_descent_segments")
                          and (goal_state.get("counters") or {}).get("actions", 0) < 6)
        if needs_iron_pickaxe or not early_resupply:
            stick_target = 2 if needs_iron_pickaxe else 0
    elif needs_diamond_mining and surface_access.get("connected_land") is True:
        # 在可步行的地表用手边木料多做几根备用镐柄。
        boards = max((inventory_count(inventory, planks) + 4 * inventory_count(inventory, log)
                      for planks, log in S3_OVERWORLD_WOOD_SOURCES), default=0)
        makeable = inventory_count(inventory, "stick") + boards // 2 * 4
        stick_target = max(stick_target, min(8, makeable))
    goal_state.pop("s3_preflight_wait_reason", None)
    goal_state.pop("s3_preflight_terminal_reason", None)
    stick_step = _s3_ensure_sticks(inventory, stick_target, "S4 工具", state, goal_state)
    if stick_step is not None:
        if (
            stick_step.tool == "mine_collect"
            and str(stick_step.arguments.get("block") or "").endswith(("_log", "_stem"))
            and needs_surface_route
        ):
            route = return_to_surface()
            return False, safe_gathering_step(route) if route is not None else None
        return False, safe_gathering_step(stick_step)
    if inventory_count(inventory, "stick") < stick_target and propagate_wood_wait_or_block():
        return False, None

    if needs_iron_pickaxe:
        iron_step = _s4_ensure_mining_pickaxe(inventory, state, goal_state)
        if iron_step is None:
            if propagate_wood_wait_or_block():
                return False, None
            return block("缺少可挖钻石的镐，且当前库存无法安全补齐铁镐")
        return False, safe_gathering_step(iron_step)

    if needs_diamond_mining and health <= S4_MIN_HEALTH:
        if food_stock > 0 and food < 20:
            return False, eat_for_safety(20, "血量偏低，先用现有食物恢复饥饿值以触发自然回血")
        if needs_surface_route and food_stock < 1:
            route = return_to_surface()
            return False, safe_gathering_step(route) if route is not None else None
        return wait("血量偏低，等待自然恢复后再下矿")

    if needs_diamond_mining and shelter.get("inside") is True:
        if _is_day(state) is not True or _danger_now(state):
            return wait("仍在庇护所内，等白天且出口附近安全后再外出采矿")
        return False, _s3_action(
            "白天从庇护所安全外出准备 S4 采矿",
            "leave_shelter",
            {"range": 3},
            {"type": "outside_shelter"},
            120.0,
        )

    return True, None


def choose_s4_resource_action(state: dict[str, Any], goal_state: dict[str, Any]) -> StepSpec | None:
    inventory = state.get("inventory") or {}
    if inventory_count(inventory, "diamond_pickaxe") >= 1:
        return None
    diamonds = inventory_count(inventory, "diamond")
    if diamonds >= S4_DIAMOND_TARGET:
        return _s3_action(
            "用现有三颗钻石合成目标钻石镐",
            "craft",
            {"item": "diamond_pickaxe", "count": 1},
            {"type": "inventory", "items": {"diamond_pickaxe": 1}},
            60.0,
        )

    if str(state.get("dimension") or "").strip().lower() not in {
        "overworld",
        "minecraft:overworld",
    }:
        goal_state["s4_resource_block_reason"] = "S4 钻石采矿只允许在主世界执行"
        return None

    threat = goal_state.get("s4_threat_position")
    if threat:
        return _s3_action("撤离有近身敌怪的矿点，到干燥新位置继续", "explore_mining_site",
                          {"min_distance": 12, "avoid_positions": [threat]},
                          {"type": "s4_threat_relocation", "min_distance": 12}, 150)
    if goal_state.get("s4_safe_route_fallback_pending") is True:
        failure = (goal_state.get("s4_last_descent_failure") or {}).get("data") or {}
        if _s4_lacks_stair_support(failure):
            avoid = [*(goal_state.get("s4_surface_stops") or []), failure["position"]]
            return _s3_action("离开缺少阶梯支撑的矿点，再从干地开矿", "explore_mining_site",
                              {"min_distance": 12, "avoid_positions": avoid[-12:]},
                              {"type": "s4_surface_relocation", "min_distance": 12}, 150)
        if goal_state.get("s4_safe_route_fallback_used") is True:
            goal_state["s4_resource_block_reason"] = "S4 唯一一次安全水平替代路线已使用，需人工检查新鲜观察"
            return None
        return StepSpec(
            "在当前高度安全水平探露后重新观察钻石",
            "strip_mine",
            {
                "length": S4_HORIZONTAL_LENGTH,
                "branches": 0,
                "branchLength": 1,
                "shaft": False,
                "torchInterval": 0,
            },
            {"type": "always"},
            retries=1,
            timeout_s=180.0,
            effect_class="non_replayable",
        )

    y = _position_y(state)
    if not math.isfinite(y):
        goal_state["s4_resource_block_reason"] = "缺少有效位置观察，不能安全选择下探高度"
        return None
    if y <= S4_DIAMOND_SEARCH_TOP_Y and int(goal_state.get("s4_diamond_no_progress", 0)) <= 0:
        return _s3_action(
            "从当前新鲜观察位置采集钻石总目标",
            "mine_collect",
            {"block": "diamond_ore", "count": S4_DIAMOND_TARGET, "range": 64},
            {"type": "inventory", "items": {"diamond": S4_DIAMOND_TARGET}},
            300.0,
        )

    segments = int(goal_state.get("s4_descent_segments", 0))
    if y <= S4_TARGET_Y or segments >= S4_MAX_DESCENT_SEGMENTS:
        goal_state["s4_resource_block_reason"] = (
            f"已达到有界 S4 下探范围（Y={y:g}, descent_segments={segments}），仍缺少 {S4_DIAMOND_TARGET - diamonds} 颗钻石"
        )
        return None
    target_y = max(S4_TARGET_Y, math.floor(y) - S4_DESCENT_STEP)
    shaft_depth = max(1, min(S4_DESCENT_STEP, math.floor(y) - target_y))
    return StepSpec(
        "以有界安全阶梯下探一段后重新观察钻石矿",
        "strip_mine",
        {
            "shaft": shaft_depth,
            "length": 0,
            "branches": 0,
            "branchLength": 1,
            "torchInterval": 0,
        },
        {"type": "s4_depth_reached", "target_y": target_y},
        retries=1,
        timeout_s=180.0,
        effect_class="non_replayable",
    )


def record_s4_diamond_outcome(
    goal_state: dict[str, Any], pending: dict[str, Any], state: dict[str, Any], status: str
) -> bool:
    if pending.get("tool") != "mine_collect" or (pending.get("arguments") or {}).get("block") != "diamond_ore":
        return False
    if not _fresh_terminal_state(pending, status, state):
        return False
    before = int(pending.get("baseline_diamond_count", 0))
    after = inventory_count(state.get("inventory") or {}, "diamond")
    goal_state["s4_diamond_no_progress"] = 0 if after > before else int(goal_state.get("s4_diamond_no_progress", 0)) + 1
    goal_state["s4_last_diamond_search"] = {
        "action_id": pending.get("action_id"),
        "baseline": before,
        "observed": after,
        "position": state.get("position"),
    }
    return True


def verify_s4_depth_reached(condition: dict[str, Any], state: dict[str, Any]) -> tuple[bool, str]:
    y = _position_y(state)
    target = float(condition.get("target_y", math.inf))
    if math.isfinite(y) and y <= target:
        return True, f"新鲜位置观察已到达 Y={y:g}，目标 Y={target:g}"
    return False, f"深层路线没有观察到目标深度（当前 Y={y:g}，目标 Y={target:g}）"


def record_s4_descent_success(
    goal_state: dict[str, Any], pending: dict[str, Any], state: dict[str, Any], status: str
) -> bool:
    if (
        pending.get("tool") != "strip_mine"
        or not str(pending.get("method_key") or "").startswith("s4:descend:")
        or (pending.get("expected_condition") or {}).get("type") != "s4_depth_reached"
        or not _fresh_terminal_state(pending, status, state)
    ):
        return False
    verified, _ = verify_s4_depth_reached(pending.get("expected_condition") or {}, state)
    if not verified:
        return False
    goal_state["s4_descent_segments"] = int(goal_state.get("s4_descent_segments", 0)) + 1
    start, end = pending.get("baseline_position") or {}, state.get("position") or {}
    if (status == "succeeded" and (pending.get("arguments") or {}).get("length") == 0
            and str(state.get("dimension")).removeprefix("minecraft:") == "overworld"
            and all(type(p.get(a)) in (int, float) and math.isfinite(p[a]) for p in (start, end) for a in "xyz")
            and 0 < start["y"] - end["y"] <= S4_DESCENT_STEP + 2):
        route = goal_state.setdefault("s4_mining_stairs", [])
        route.append({"top": {a: math.floor(start[a]) for a in "xyz"}, "bottom": {a: math.floor(end[a]) for a in "xyz"},
                      "outdoors": pending.get("baseline_connected_land") is True})
        del route[:-64]
    goal_state["s4_diamond_no_progress"] = 0
    goal_state.pop("s4_resource_block_reason", None)
    return True


def _s4_lacks_stair_support(data: dict) -> bool:
    position = data.get("position")
    candidates = data.get("candidates") or []
    return (isinstance(position, dict) and all(isinstance(position.get(axis), (int, float)) for axis in "xyz")
            and len(candidates) == 4
            and all(c.get("loaded") and c.get("reason") == "unsupported" for c in candidates))


def mark_s4_known_no_safe_stair(
    goal_state: dict[str, Any], pending: dict[str, Any], status: str, data: dict[str, Any]
) -> bool:
    if (
        pending.get("tool") != "strip_mine"
        or not str(pending.get("method_key") or "").startswith("s4:descend:")
        or status not in {"blocked", "failed"}
        or pending.get("receipt_confirmed") is not True
        or data.get("phase") != "safe_stop"
        or data.get("reason") != "no_safe_stair"
    ):
        return False
    observation = _fresh_terminal_observation(pending, data)
    if observation is None:
        return False
    admission = data.get("admission") or pending.get("admission")
    if isinstance(admission, dict) and admission.get("started") is False:
        return False
    if not _s4_lacks_stair_support(data):
        if int(goal_state.get("s4_safe_stair_stops", 0)) >= S4_MAX_SAFE_ROUTE_FALLBACKS:
            return False
        goal_state["s4_safe_stair_stops"] = int(goal_state.get("s4_safe_stair_stops", 0)) + 1
    goal_state["s4_safe_route_fallback_pending"] = True
    goal_state["s4_diamond_no_progress"] = 1
    goal_state["s4_last_descent_failure"] = {
        "action_id": pending.get("action_id"),
        "status": status,
        "detail": pending.get("result_detail", ""),
        "data": data,
    }
    return True


def record_s4_horizontal_fallback_success(
    goal_state: dict[str, Any], pending: dict[str, Any], status: str, state: dict[str, Any]
) -> bool:
    if (
        pending.get("tool") == "strip_mine"
        and pending.get("method_key") == "s4:ore_horizontal_fallback"
        and status == "succeeded"
        and _fresh_terminal_state(pending, status, state)
    ):
        goal_state["s4_safe_route_fallback_used"] = True
        goal_state["s4_safe_route_fallback_pending"] = False
        goal_state["s4_diamond_no_progress"] = 0
        return True
    return False


def record_s4_wood_search_outcome(
    goal_state: dict[str, Any], pending: dict[str, Any], state: dict[str, Any], status: str
) -> bool:
    if pending.get("tool") != "mine_collect":
        return False
    block = str((pending.get("arguments") or {}).get("block") or "")
    if not block.endswith(("_log", "_stem")):
        return False
    if not _fresh_terminal_state(pending, status, state):
        return False
    before = int(pending.get("baseline_wood_count", 0))
    after = inventory_count(state.get("inventory") or {}, block)
    goal_state["s4_wood_search_no_progress"] = 0 if after > before else int(
        goal_state.get("s4_wood_search_no_progress", 0)
    ) + 1
    goal_state["s4_last_wood_search"] = {
        "action_id": pending.get("action_id"),
        "block": block,
        "baseline": before,
        "observed": after,
        "position": state.get("position"),
    }
    return True


def _position_y(state: dict[str, Any]) -> float:
    try:
        y = float((state.get("position") or {})["y"])
    except (KeyError, TypeError, ValueError):
        return math.inf
    return y if math.isfinite(y) else math.inf


def _s4_stone_material_count(inventory: dict[str, Any]) -> int:
    return max((inventory_count(inventory, item) for item in S4_STONE_CRAFTING_MATERIALS), default=0)


def _s4_mine_stone_material(
    inventory: dict[str, Any], target_total: int, state: dict[str, Any], label: str
) -> StepSpec:
    item = "cobbled_deepslate" if _position_y(state) < 0 else "cobblestone"
    block = "deepslate" if item == "cobbled_deepslate" else "stone"
    item_target = max(inventory_count(inventory, item), target_total)
    return _s3_action(
        f"采集{label}所需石料",
        "mine_collect",
        {"block": block, "count": item_target, "range": 48},
        {"type": "inventory", "items": {item: item_target}},
        250.0,
    )


def _s4_ensure_mining_pickaxe(
    inventory: dict[str, Any], state: dict[str, Any], goal_state: dict[str, Any]
) -> StepSpec | None:
    if inventory_count(inventory, "iron_pickaxe") > 0:
        return None
    if any(inventory_count(inventory, item) > 0 for item in ("diamond_pickaxe", "netherite_pickaxe")):
        return None

    ingots = inventory_count(inventory, "iron_ingot")
    if ingots >= 3:
        return _s3_action(
            "补做一把用于钻石矿的铁镐",
            "craft",
            {"item": "iron_pickaxe", "count": 1},
            {"type": "inventory", "items": {"iron_pickaxe": 1}},
            60.0,
        )

    raw_target = 3 - ingots
    raw_iron = inventory_count(inventory, "raw_iron")
    stone_pickaxe = inventory_count(inventory, "stone_pickaxe")
    stone_materials = _s4_stone_material_count(inventory)
    needs_stone_mining_tool = raw_iron < raw_target or (
        inventory_count(inventory, "furnace") < 1 and stone_materials < 8
    )
    if stone_pickaxe < 1 and needs_stone_mining_tool:
        if stone_materials >= 3:
            return _s3_action(
                "用现有石料重做可挖铁矿的石镐",
                "craft",
                {"item": "stone_pickaxe", "count": 1},
                {"type": "inventory", "items": {"stone_pickaxe": 1}},
                60.0,
            )
        if inventory_count(inventory, "wooden_pickaxe") > 0:
            return _s4_mine_stone_material(inventory, 3, state, "重做石镐")
        plank_step = _s3_ensure_planks(inventory, 3, "木镐", state, goal_state)
        if plank_step is not None:
            return plank_step
        if inventory_count(inventory, "stick") < 2:
            return _s3_ensure_sticks(inventory, 2, "木镐", state, goal_state)
        if any(inventory_count(inventory, item) >= 3 for item in (*S3_WOOD_PLANKS, "bamboo_planks")):
            return _s3_action(
                "先合成采石用木镐，再恢复石镐",
                "craft",
                {"item": "wooden_pickaxe", "count": 1},
                {"type": "inventory", "items": {"wooden_pickaxe": 1}},
                60.0,
            )
        return None

    can_mine_stone = any(
        inventory_count(inventory, item) > 0
        for item in ("wooden_pickaxe", *S4_IRON_MINING_PICKAXES)
    )
    if inventory_count(inventory, "furnace") < 1 and stone_materials < 8:
        if not can_mine_stone:
            return None
        return _s4_mine_stone_material(inventory, 8, state, "恢复铁镐所需熔炉")

    can_mine_iron = any(inventory_count(inventory, item) > 0 for item in S4_IRON_MINING_PICKAXES)
    if raw_iron < raw_target:
        if not can_mine_iron:
            return None
        return _s3_action(
            "采集用于恢复铁镐的铁矿",
            "mine_collect",
            {"block": "iron_ore", "count": raw_target, "range": 64},
            {"type": "inventory", "items": {"raw_iron": raw_target}},
            250.0,
        )

    if inventory_count(inventory, "furnace") < 1:
        stone_materials = _s4_stone_material_count(inventory)
        if stone_materials >= 8:
            return _s3_action(
                "补齐恢复铁镐所需熔炉",
                "craft",
                {"item": "furnace", "count": 1},
                {"type": "inventory", "items": {"furnace": 1}},
                60.0,
            )
        if can_mine_stone:
            return _s4_mine_stone_material(inventory, 8, state, "恢复铁镐所需熔炉")
        return None

    available_fuel = {name: inventory_count(inventory, name) for name in S3_FUEL_BURN}
    fuel_item = max(available_fuel, key=lambda name: available_fuel[name] * S3_FUEL_BURN[name])
    capacity = math.floor(available_fuel[fuel_item] * S3_FUEL_BURN[fuel_item])
    if capacity < 1:
        can_mine_iron = any(inventory_count(inventory, item) > 0 for item in S4_IRON_MINING_PICKAXES)
        if can_mine_iron:
            return _s3_action(
                "采集恢复铁镐所需熔炼燃料",
                "mine_collect",
                {"block": "coal_ore", "count": 1, "range": 64},
                {"type": "inventory", "items": {"coal": 1}},
                250.0,
            )
        fuel_inventory = {
            name: count
            for name, count in inventory.items()
            if not str(name).startswith(("crimson_", "warped_"))
        }
        fuel_step = _s3_ensure_planks(
            fuel_inventory,
            math.ceil(raw_target / S3_FUEL_BURN["oak_planks"]),
            "恢复铁镐熔炼燃料",
            state,
            goal_state,
        )
        if fuel_step is not None:
            return fuel_step
        return None
    batch_count = min(raw_target, capacity, 8)
    return _s3_action(
        "熔炼恢复铁镐所需铁锭",
        "smelt_batch",
        {"item": "raw_iron", "count": batch_count, "output": "iron_ingot", "fuel": fuel_item},
        {"type": "inventory", "items": {"iron_ingot": ingots + batch_count}},
        190.0,
    )


def s4_method_key(step: StepSpec, state: dict[str, Any], goal_state: dict[str, Any]) -> str:
    inventory = state.get("inventory") or {}
    if step.verify.get("type") == "s4_threat_relocation":
        pos = step.arguments["avoid_positions"][0]
        return f"s4:retreat:{math.floor(pos['x'] / 16)}:{math.floor(pos['y'] / 8)}:{math.floor(pos['z'] / 16)}"
    if step.tool == "goto":
        if step.verify.get("site") == "mining_stair":
            return _s4_stair_key(step.verify["target"])
        return "s4:surface_route:shelter_anchor"
    if step.tool == "strip_mine":
        if goal_state.get("s4_safe_route_fallback_pending") is True:
            return "s4:ore_horizontal_fallback"
        target_y = step.verify.get("target_y", "unknown")
        segment = int(goal_state.get("s4_descent_segments", 0))
        return f"s4:descend:{segment}:{target_y}"
    if step.tool == "mine_collect":
        block = str(step.arguments.get("block") or "default")
        if block == "diamond_ore":
            context = _s3_wood_search_context(state) or "unknown"
            baseline = inventory_count(inventory, "diamond")
            return f"s4:diamond_search:{context}:{baseline}"
        if block in {*S3_OVERWORLD_WOOD_LOGS, "wood_log"}:
            context = _s3_wood_search_context(state) or "unknown"
            return f"s4:wood_search:{context}:{block}"
        have = inventory_count(inventory, block)
        target = int(step.arguments.get("count", have))
        return f"s4:mine_collect:{block}:have{have}:target{target}"
    if step.tool == "craft":
        item = step.arguments.get("item", "default")
        if (item in {"wooden_pickaxe", "stone_pickaxe", "iron_pickaxe", "diamond_pickaxe", "furnace"}
                and inventory_count(inventory, "crafting_table") > 0 and not _nearby_crafting_table(state)):
            return f"s4:craft:{item}:portable_table"
        return f"s4:craft:{item}"
    if step.tool == "leave_shelter":
        return "s4:leave_shelter"
    return f"s4:{step.tool}:{step.arguments.get('item', step.arguments.get('block', 'default'))}"
