from __future__ import annotations

import math

from voxkin.agent.goal_methods import FOOD_ITEMS, S2_SHELTER_BLOCKS, S2_WOOD_BLOCKS, S4_TARGET_Y, _fresh_terminal_observation
from voxkin.agent.goals import GOALS, dimension_id, inventory_count
from voxkin.agent.resource_policy import FOOD_TARGETS, STOCK_TARGETS


# 物资按阶段需求封顶；丢下再捡、反复合成同一个工具不能刷新窗口。
_MILESTONES = {
    "S0": {**GOALS["S0"].acceptance["items"], "stick": 4},
    "S1": {**GOALS["S1"].acceptance["items"], "cobblestone": 32},
    "S2": {"wool": 3, "bed": 1},
    "S3": {**GOALS["S3"].acceptance["items"], "raw_iron": 9, "iron_ingot": 9, "coal": 12},
    "S4": {**GOALS["S4"].acceptance["items"], "diamond": 3},
    "S5": {"obsidian": 10, "flint_and_steel": 1, "water_bucket": 1, "blaze_rod": 12, "ender_pearl": 24},
    "S6": {"ender_eye": 12},
}


def _progress_evidence(state: dict, observation: dict) -> dict[str, int]:
    stage = state["stage"]
    inventory = observation.get("inventory") or {}
    evidence = {
        "wood_log": min(inventory_count(inventory, "wood_log"), STOCK_TARGETS[stage]["wood_log"]),
        "planks": min(sum(inventory_count(inventory, item) for item in S2_WOOD_BLOCKS), 12),
        "food_stock": min(sum(inventory_count(inventory, item) for item in FOOD_ITEMS), FOOD_TARGETS[stage]),
    }
    for prerequisite, targets in _MILESTONES.items():
        if prerequisite == "S2" and stage != "S2":
            continue
        for item, target in targets.items():
            evidence[item] = min(inventory_count(inventory, item), target)
        if prerequisite == stage:
            break
    if stage == "S2":
        evidence["shelter_material"] = min(40, sum(inventory_count(inventory, item) for item in S2_SHELTER_BLOCKS))
        evidence["sealed_shelter"] = int((observation.get("shelter") or {}).get("sealed") is True)
    if stage == "S4" or (stage == "S5" and state.get("s5_rebuild_pickaxe")):
        stairs = state.get("s4_mining_stairs") or []
        if stairs:
            y = (stairs[-1].get("bottom") or {}).get("y")
            if type(y) is int:
                evidence["mining_depth"] = max(0, 320 - max(y, S4_TARGET_Y))
    if stage in {"S5", "S6"}:
        target = "minecraft:the_nether" if stage == "S5" else "minecraft:the_end"
        evidence["target_dimension"] = int(dimension_id(observation.get("dimension")) == target)
    if stage == "S6":
        # 搜索阶段、下探深度与龙血线均由监督器核验回执后入账。
        search = state.get("stronghold_search") or {}
        descent = search.get("descent") or {}
        layers = descent.get("layers_completed") if isinstance(descent, dict) else None
        if type(layers) is int and 0 < layers <= 96:
            evidence["descent_layers"] = layers
        evidence["visible_frames"] = int(search.get("phase") == "frames_found" and
                                         (search.get("scan") or {}).get("line_of_sight") is True)
        health = state.get("s6_lowest_dragon_health")
        if isinstance(health, (float, int)) and 0 < health <= 200:
            evidence["dragon_damage"] = int(200 - health)
    return evidence


def _extend(state: dict, reason: str, now: float) -> None:
    budget = state["budget"]
    watchdog = state["progress_watchdog"]
    watchdog["action_limit"] = max(watchdog["action_limit"], state["counters"]["actions"] + budget["max_actions"])
    watchdog["last_progress"] = reason
    state["deadline_at"] = max(state["deadline_at"], now + budget["max_elapsed_s"])


def observe_progress(state: dict, observation: dict, now: float) -> None:
    if (state.get("budget") or {}).get("mode") != "adaptive" or state.get("stage") not in GOALS:
        return
    if observation.get("ready") is not True or observation.get("alive") is not True:
        return
    session = observation.get("session_id")
    revision = observation.get("revision")
    if not session or type(revision) is not int:
        return
    watchdog = state.get("progress_watchdog")
    if watchdog and watchdog["session_id"] == session and watchdog["revision"] >= revision:
        return
    milestones = _progress_evidence(state, observation)
    dimension = dimension_id(observation.get("dimension"))
    position = observation.get("position") or {}
    x, z = position.get("x"), position.get("z")
    region = None
    if dimension and all(type(v) in (float, int) and math.isfinite(v) for v in (x, z)):
        region = f"{dimension}:{math.floor(x / 32)}:{math.floor(z / 32)}"
    if watchdog is None:
        state["progress_watchdog"] = {
            "milestone_peaks": milestones, "regions": [region] if region else [],
            "last_site": [dimension, x, z] if region else None, "methods": [], "exploration_credits": 0,
            "action_limit": state["budget"]["max_actions"], "last_progress": "initial_observation",
            "session_id": session, "revision": revision,
        }
        return
    watchdog.update(session_id=session, revision=revision)
    peaks = watchdog["milestone_peaks"]
    gained = [item for item, count in milestones.items() if count > peaks.get(item, 0)]
    if gained:
        peaks.update({item: milestones[item] for item in gained})
        watchdog["exploration_credits"] = 0
        _extend(state, "milestone:" + gained[0], now)
    # 仅越过区块边界可能只移动了一步；新区域还须有实际水平位移。
    site = watchdog["last_site"]
    if (region and region not in watchdog["regions"] and watchdog["exploration_credits"] < 3
            and (site is None or site[0] != dimension or math.hypot(x - site[1], z - site[2]) >= 24)):
        watchdog["regions"].append(region)
        watchdog["last_site"] = [dimension, x, z]
        if not gained:
            watchdog["exploration_credits"] += 1
            _extend(state, "region:" + region, now)


def record_action_progress(state: dict, pending: dict, data: dict, now: float) -> None:
    watchdog = state.get("progress_watchdog")
    if not watchdog or (state.get("budget") or {}).get("mode") != "adaptive" or pending.get("receipt_confirmed") is not True:
        return
    receipt = _fresh_terminal_observation(pending, data)
    if not pending.get("tool") or receipt is None or receipt["session_id"] != watchdog["session_id"]:
        return
    revision = receipt.get("revision")
    if receipt.get("ready") is not True or receipt.get("alive") is not True:
        return
    if type(revision) is not int or revision < watchdog["revision"]:
        return
    observe_progress(state, receipt, now)
    # 方法名称和参数变化并非游戏进展。只认有实际探查坐标的回执。
    if watchdog["exploration_credits"] >= 3:
        return
    relocation = data.get("relocation") or {}
    attempted = relocation.get("attempted_positions") if isinstance(relocation, dict) else None
    attempted = attempted or data.get("attempted_positions")
    if not isinstance(attempted, list) or not any(
        isinstance(pos, dict) and all(type(pos.get(a)) in (float, int) and math.isfinite(pos[a]) for a in "xyz")
        for pos in attempted
    ):
        return
    method = f"{pending['tool']}:{(pending.get('expected_condition') or {}).get('type', '')}"
    if method not in watchdog["methods"]:
        watchdog["methods"].append(method)
        watchdog["exploration_credits"] += 1
        _extend(state, "survey:" + method, now)
