from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from voxkin.agent.goals import inventory_count


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


def failure_reason(row: dict) -> str | None:
    if row.get("receipt_confirmed") is not True or row.get("status") not in {"blocked", "failed", "partial"}:
        return None
    data = row.get("result_data") or {}
    reason = data.get("reason")
    if isinstance(reason, str) and reason:
        return reason
    # 旧存档只有中文回执。新的原因码优先，避免文字相同却覆盖其他已确认的原因。
    detail = str(row.get("result_detail") or "")
    if "血量不足" in detail:
        return "low_health"
    if "干燥矿道未能通到" in detail:
        return "no_dry_retreat"
    if ("格内有敌对生物（" in detail and detail.endswith("），停止采矿")) or detail.endswith("附近有敌对生物，先处理生存恢复"):
        return "nearby_hostiles"
    if "太远走不过去" in detail:
        return "surface_route_stalled"
    if "附近" in detail and "一个都没有找到" in detail:
        return "resource_not_found"
    return None


def _position(value: object) -> bool:
    return isinstance(value, dict) and all(type(value.get(k)) in (int, float) and math.isfinite(value[k]) for k in "xyz")


def _same_ground(a: dict, b: dict) -> bool:
    return abs(a["y"] - b["y"]) < 3 and math.hypot(a["x"] - b["x"], a["z"] - b["z"]) < 8


@dataclass
class SurfaceWoodEvidence:
    trunks: list[dict] = field(default_factory=list)
    avoid: list[dict] = field(default_factory=list)
    searched_range: int = 0
    stalled_here: bool = False


def surface_wood_evidence(history: list[dict], state: dict) -> SurfaceWoodEvidence:
    evidence = SurfaceWoodEvidence()
    feet = state.get("position")
    inventory = state.get("inventory") or {}
    if not _position(feet):
        return evidence
    for row in history[-40:]:
        args = row.get("arguments") or {}
        if row.get("tool") != "mine_collect" or row.get("receipt_confirmed") is not True or not args.get("surface_wood"):
            continue
        data = row.get("result_data") or {}
        search = data.get("resource_search")
        if search is not None:
            end = _fresh_terminal_observation(row, data) or {}
            if not isinstance(search, dict) or not end or end.get("session_id") != state.get("session_id"):
                continue
        else:
            end = data.get("observation") or row.get("terminal_observation") or {}
        if (end.get("dimension") != state.get("dimension")
                or (end.get("session_id") and end["session_id"] != state.get("session_id"))):
            continue
        trunk = data.get("surface_trunk")
        reason = failure_reason(row)
        stop = end.get("position")
        gained = data.get("collected")
        if (row.get("status") in {"succeeded", "partial"} and type(gained) is int and gained > 0
                and _position(stop) and _same_ground(stop, feet) and _fresh_terminal_observation(row, data)
                and inventory_count(end.get("inventory") or {}, "wood_log") >= gained):
            # 之后在这里拿到了木头。即使已经把原木合成木板，也不能重新采用更早的空扫描。
            evidence = SurfaceWoodEvidence()
        if _position(trunk) and math.hypot(trunk["x"] - feet["x"], trunk["z"] - feet["z"]) <= 128:
            if trunk not in evidence.trunks:
                evidence.trunks.append(trunk)
            if (search is None and reason == "surface_route_stalled" and _position(stop) and trunk["y"] - stop["y"] >= 5
                    and math.hypot(trunk["x"] - stop["x"], trunk["z"] - stop["z"]) <= 12 and trunk not in evidence.avoid):
                evidence.avoid.append(trunk)
        if not search:
            continue
        origin = search.get("origin")
        # 同一动作确实从这里出发、停在这里，并且仍然处于相同地形。走到对岸后重新观察树木。
        if (reason not in {"resource_not_found", "surface_route_stalled"} or row.get("status") == "partial"
                or args.get("block") != "wood_log" or search.get("resource") != "wood_log"
                or type(end.get("day")) is not int or end["day"] < 0 or end["day"] != state.get("day")
                or end.get("alive") is not True or end.get("ready") is not True
                or type(search.get("inventory_count")) is not int or search["inventory_count"] != inventory_count(inventory, "wood_log")
                or not _position(origin) or not _position(stop) or not _same_ground(origin, feet) or not _same_ground(stop, feet)):
            continue
        if reason == "resource_not_found":
            radius = search.get("range")
            if search.get("attempted") == 0 and not args.get("avoid_positions") and type(radius) is int and 0 < radius <= 128:
                evidence.searched_range = max(evidence.searched_range, radius)
        elif type(search.get("attempted")) is int and search["attempted"] > 0:
            for target in search.get("failed_positions") or []:
                if _position(target):
                    evidence.stalled_here = True
                    if target not in evidence.avoid:
                        evidence.avoid.append(target)
    return evidence
