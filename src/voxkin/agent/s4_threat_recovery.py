from __future__ import annotations

import math
import re
from typing import Any


_THREAT_DETAIL = re.compile(
    r"(?:(?:附近\s*8\s*格(?:内)?|8\s*格内).{0,30}(?:多只|多名).{0,8}(?:僵尸|敌对生物|敌人)"
    r"|(?:附近\s*8\s*格(?:内)?|8\s*格内).{0,30}(?:僵尸|敌对生物|敌人).{0,20}(?:过多|威胁|阻止|停止|无法))"
)
_DESCENT_KEY = re.compile(r"^s4:descend:(\d+):(-?\d+)$")
_POSITION_TOLERANCE = 1.5
_MIN_RETREAT_DISTANCE = 2.0


def _finite_position(value: Any) -> dict[str, float] | None:
    if not isinstance(value, dict):
        return None
    try:
        position = {axis: float(value[axis]) for axis in "xyz"}
    except (KeyError, TypeError, ValueError, OverflowError):
        return None
    if not all(math.isfinite(number) for number in position.values()):
        return None
    return position


def _find_action(goal_state: dict[str, Any], action_id: str) -> dict[str, Any] | None:
    unresolved = goal_state.get("unresolved_action")
    matching_history = None
    for record in reversed(goal_state.get("action_history") or []):
        if isinstance(record, dict) and str(record.get("action_id") or "") == action_id:
            matching_history = record
            break
    if isinstance(unresolved, dict) and str(unresolved.get("action_id") or "") == action_id:
        if matching_history is None:
            return unresolved
        merged = {**matching_history, **unresolved}
        for key in ("result_detail", "result_data", "terminal_observation", "method_key", "session_id", "revision"):
            if not merged.get(key) and matching_history.get(key):
                merged[key] = matching_history[key]
        return merged
    if matching_history is not None:
        return matching_history
    return None


def prepare_s4_threat_recovery(
    goal_state: dict[str, Any],
    current_observation: dict[str, Any],
    *,
    action_id: str | None = None,
) -> dict[str, Any]:
    # 这里只授权发起独立撤退动作，不会把下探记为完成或清除未决动作。
    unresolved = goal_state.get("unresolved_action")
    chosen_id = str(action_id or (unresolved or {}).get("action_id") or "")
    record = _find_action(goal_state, chosen_id) if chosen_id else None
    if record is None:
        return {"eligible": False, "reason": "missing_terminal_action"}
    method_key = str(record.get("method_key") or "")
    match = _DESCENT_KEY.fullmatch(method_key)
    if record.get("tool") != "strip_mine" or not match:
        return {"eligible": False, "reason": "not_s4_descent"}
    if record.get("status") not in {"failed", "blocked"} or record.get("receipt_confirmed") is not True:
        return {"eligible": False, "reason": "terminal_receipt_not_confirmed"}

    detail = str(record.get("result_detail") or "")
    result_data = record.get("result_data") if isinstance(record.get("result_data"), dict) else {}
    if not detail:
        detail = str(result_data.get("detail") or "")
    if not _THREAT_DETAIL.search(detail):
        return {"eligible": False, "reason": "failure_not_identified_as_hostile_pressure"}

    terminal = record.get("terminal_observation")
    if not isinstance(terminal, dict):
        terminal = result_data.get("observation")
    current = current_observation if isinstance(current_observation, dict) else {}
    baseline_session = str(record.get("session_id") or "")
    try:
        baseline_revision = int(record.get("revision"))
        terminal_revision = int((terminal or {}).get("revision"))
        current_revision = int(current.get("revision"))
    except (TypeError, ValueError, OverflowError):
        return {"eligible": False, "reason": "observation_revision_missing"}
    if not baseline_session or str((terminal or {}).get("session_id") or "") != baseline_session:
        return {"eligible": False, "reason": "terminal_observation_session_mismatch"}
    if terminal_revision <= baseline_revision:
        return {"eligible": False, "reason": "terminal_observation_stale"}
    current_session = str(current.get("session_id") or "")
    if not current_session:
        return {"eligible": False, "reason": "current_observation_session_missing"}
    if current_session == baseline_session and current_revision < terminal_revision:
        return {"eligible": False, "reason": "terminal_observation_stale"}
    if current.get("ready") is not True or current.get("alive") is not True:
        return {"eligible": False, "reason": "world_not_ready_and_alive"}
    if (current.get("executor") or {}).get("safety_active") is not False:
        return {"eligible": False, "reason": "safety_executor_active"}
    terminal_position = _finite_position((terminal or {}).get("position"))
    current_position = _finite_position(current.get("position"))
    if terminal_position is None or current_position is None:
        return {"eligible": False, "reason": "position_evidence_missing"}
    target_y = int(match.group(2))
    if terminal_position["y"] <= target_y + 1:
        return {"eligible": False, "reason": "terminal_position_near_or_below_target"}
    terminal_dimension = str((terminal or {}).get("dimension") or "")
    current_dimension = str(current.get("dimension") or "")
    if terminal_dimension and current_dimension != terminal_dimension:
        return {"eligible": False, "reason": "dimension_changed_since_terminal"}

    return {
        "eligible": True,
        "reason": "confirmed_s4_hostile_pressure_terminal",
        "action_id": chosen_id,
        "method_key": method_key,
        "target_y": target_y,
        "terminal_position": terminal_position,
        "current_position": current_position,
        "session_id": baseline_session,
        "current_session_id": current_session,
        "terminal_revision": terminal_revision,
        "current_revision": current_revision,
        "retreat_required": True,
        "descent_must_not_be_replayed": True,
    }


def _near_position(left: dict[str, float], right: dict[str, float], tolerance: float) -> bool:
    return math.dist([left[axis] for axis in "xyz"], [right[axis] for axis in "xyz"]) <= tolerance


def _retreat_evidence(receipt: dict[str, Any]) -> dict[str, Any] | None:
    evidence = receipt.get("retreat_evidence")
    if not isinstance(evidence, dict):
        result_data = receipt.get("result_data")
        evidence = result_data.get("retreat_evidence") if isinstance(result_data, dict) else None
    return evidence if isinstance(evidence, dict) else None


def commit_s4_threat_recovery(
    goal_state: dict[str, Any],
    plan: dict[str, Any],
    retreat_receipt: dict[str, Any],
    current_observation: dict[str, Any],
) -> tuple[bool, str]:
    # 必须有单独撤退回执、沿路位移证据和威胁下降证据。
    if not plan.get("eligible") or not plan.get("retreat_required"):
        return False, "invalid_recovery_plan"
    if retreat_receipt.get("status") != "succeeded" or retreat_receipt.get("receipt_confirmed") is not True:
        return False, "retreat_receipt_not_confirmed"
    receipt_observation = retreat_receipt.get("terminal_observation") or retreat_receipt.get("observation")
    observation = current_observation
    if not isinstance(receipt_observation, dict) or not isinstance(observation, dict):
        return False, "retreat_observation_missing"
    if observation.get("ready") is not True or observation.get("alive") is not True:
        return False, "retreat_observation_not_usable"
    retreat_session = str(observation.get("session_id") or "")
    if (
        not retreat_session
        or retreat_session != str(plan.get("current_session_id") or "")
        or str(receipt_observation.get("session_id") or "") != retreat_session
    ):
        return False, "retreat_session_mismatch"
    try:
        revision = int(observation.get("revision"))
        receipt_revision = int(receipt_observation.get("revision"))
        after = _finite_position(observation.get("position"))
        receipt_position = _finite_position(receipt_observation.get("position"))
    except (KeyError, TypeError, ValueError, OverflowError):
        return False, "retreat_position_or_revision_invalid"
    if (
        after is None
        or receipt_position is None
        or revision <= int(plan.get("current_revision", -1))
        or receipt_revision <= int(plan.get("current_revision", -1))
        or revision < receipt_revision
        or not _near_position(receipt_position, after, _POSITION_TOLERANCE)
    ):
        return False, "retreat_observation_stale"
    evidence = _retreat_evidence(retreat_receipt)
    if evidence is None or evidence.get("route_followed") is not True:
        return False, "retreat_route_evidence_missing"
    origin = _finite_position(evidence.get("origin"))
    destination = _finite_position(evidence.get("destination"))
    if origin is None or destination is None:
        return False, "retreat_route_positions_invalid"
    expected_origin = _finite_position(plan.get("current_position"))
    if expected_origin is None or not _near_position(origin, expected_origin, _POSITION_TOLERANCE):
        return False, "retreat_origin_mismatch"
    if not _near_position(destination, after, _POSITION_TOLERANCE):
        return False, "retreat_destination_mismatch"
    moved = math.dist([origin[axis] for axis in "xyz"], [destination[axis] for axis in "xyz"])
    if moved < _MIN_RETREAT_DISTANCE:
        return False, "retreat_route_displacement_too_small"
    try:
        score_before = float(evidence["threat_score_before"])
        score_after = float(evidence["threat_score_after"])
    except (KeyError, TypeError, ValueError, OverflowError):
        try:
            count_before = int(evidence["threat_count_before"])
            count_after = int(evidence["threat_count_after"])
        except (KeyError, TypeError, ValueError, OverflowError):
            return False, "retreat_threat_delta_missing"
        threat_decreased = count_after < count_before
    else:
        threat_decreased = math.isfinite(score_before) and math.isfinite(score_after) and score_after < score_before
    if not threat_decreased:
        return False, "retreat_threat_not_reduced"

    original = _find_action(goal_state, str(plan.get("action_id") or ""))
    if original is None:
        return False, "original_terminal_action_missing"
    history = goal_state.setdefault("action_history", [])
    if not any(isinstance(item, dict) and item.get("action_id") == plan.get("action_id") for item in history):
        history.append({**original, "recovery": "s4_hostile_pressure", "retreat_confirmed": True})
        del history[:-128]
    goal_state.pop("unresolved_action", None)
    goal_state["pending_action"] = None
    goal_state["s4_hostile_recovery"] = {
        "action_id": plan["action_id"],
        "retreat_action_id": retreat_receipt.get("action_id"),
        "position": after,
        "revision": revision,
        "session_id": retreat_session,
        "target_y": plan["target_y"],
        "status": "retreated_replan_required",
    }
    goal_state.setdefault("action_history", []).append({
        "action_id": retreat_receipt.get("action_id"),
        "tool": retreat_receipt.get("tool", "retreat_from_threats"),
        "status": "succeeded",
        "receipt_confirmed": True,
        "terminal_observation": dict(observation),
        "recovery_for_action_id": plan["action_id"],
        "recovery": "s4_hostile_retreat",
    })
    del goal_state["action_history"][:-128]
    goal_state.setdefault("recovery", {}).update({
        "needs_reconcile": False,
        "reason": "s4_hostile_pressure_retreated_replan_from_observation",
    })
    goal_state["status"] = "active"
    goal_state["block_reason"] = ""
    return True, "retreat_confirmed_replan_from_fresh_observation"
