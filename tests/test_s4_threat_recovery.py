from copy import deepcopy

from voxkin.agent.s4_threat_recovery import (
    commit_s4_threat_recovery,
    prepare_s4_threat_recovery,
)


def terminal_action():
    return {
        "action_id": "s4-descent-mobs",
        "tool": "strip_mine",
        "method_key": "s4:descend:0:-7",
        "status": "failed",
        "receipt_confirmed": True,
        "session_id": "session-a",
        "revision": 40,
        "result_detail": "附近 8 格内有敌对生物（僵尸、僵尸、僵尸、僵尸），停止采矿",
        "terminal_observation": {
            "session_id": "session-a",
            "revision": 41,
            "dimension": "minecraft:overworld",
            "position": {"x": 12, "y": 5, "z": 34},
        },
    }


def current_observation():
    return {
        "session_id": "session-a",
        "revision": 43,
        "ready": True,
        "alive": True,
        "dimension": "minecraft:overworld",
        "position": {"x": 12, "y": 5, "z": 34},
        "executor": {"safety_active": False},
    }


def test_confirmed_mob_terminal_authorizes_separate_retreat_but_keeps_unresolved_action():
    action = terminal_action()
    state = {"unresolved_action": action, "pending_action": action}
    plan = prepare_s4_threat_recovery(state, current_observation())

    assert plan["eligible"] is True
    assert plan["target_y"] == -7
    assert plan["terminal_position"]["y"] == 5
    assert plan["retreat_required"] is True
    assert plan["descent_must_not_be_replayed"] is True
    assert state["unresolved_action"] == action
    assert state["pending_action"] == action


def test_historical_terminal_action_can_be_recovered_after_task_reload():
    action = terminal_action()
    state = {"unresolved_action": {"action_id": "other"}, "action_history": [action]}
    plan = prepare_s4_threat_recovery(state, current_observation(), action_id=action["action_id"])
    assert plan["eligible"] is True
    assert plan["action_id"] == action["action_id"]


def test_confirmed_terminal_can_be_combined_with_reconnected_fresh_session():
    action = terminal_action()
    state = {"unresolved_action": action}
    observation = current_observation()
    observation.update({"session_id": "session-b", "revision": 2})
    plan = prepare_s4_threat_recovery(state, observation)
    assert plan["eligible"] is True
    assert plan["session_id"] == "session-a"
    assert plan["current_session_id"] == "session-b"


def test_missing_receipt_wrong_detail_and_stale_or_foreign_observation_are_rejected():
    action = terminal_action()
    state = {"unresolved_action": action}
    action["receipt_confirmed"] = False
    assert prepare_s4_threat_recovery(state, current_observation())["reason"] == "terminal_receipt_not_confirmed"
    action["receipt_confirmed"] = True
    action["result_detail"] = "没有安全的阶梯落点"
    assert prepare_s4_threat_recovery(state, current_observation())["reason"] == "failure_not_identified_as_hostile_pressure"
    action["result_detail"] = terminal_action()["result_detail"]
    action["terminal_observation"]["session_id"] = "session-old"
    assert prepare_s4_threat_recovery(state, current_observation())["reason"] == "terminal_observation_session_mismatch"


def test_commit_requires_separate_confirmed_uphill_retreat_and_fresh_observation():
    action = terminal_action()
    state = {"unresolved_action": action, "pending_action": action, "action_history": []}
    plan = prepare_s4_threat_recovery(state, current_observation())
    before = deepcopy(state)
    ok, reason = commit_s4_threat_recovery(
        state,
        plan,
        {"status": "succeeded", "receipt_confirmed": True, "action_id": "retreat-1", "terminal_observation": {
            **current_observation(), "revision": 44, "position": {"x": 16, "y": 5, "z": 34},
        }, "retreat_evidence": {
            "route_followed": True,
            "origin": {"x": 12, "y": 5, "z": 34},
            "destination": {"x": 16, "y": 5, "z": 34},
            "threat_count_before": 4,
            "threat_count_after": 0,
        }},
        {**current_observation(), "revision": 45, "position": {"x": 16, "y": 5, "z": 34}},
    )
    assert ok is True
    assert reason == "retreat_confirmed_replan_from_fresh_observation"
    assert "unresolved_action" not in state
    assert state["pending_action"] is None
    assert state["status"] == "active"
    assert state["s4_hostile_recovery"]["status"] == "retreated_replan_required"
    assert any(entry.get("recovery") == "s4_hostile_retreat" for entry in state["action_history"])

    blocked = deepcopy(before)
    no_move, failure = commit_s4_threat_recovery(
        blocked,
        plan,
        {"status": "succeeded", "receipt_confirmed": True, "terminal_observation": {
            **current_observation(), "revision": 44,
        }, "retreat_evidence": {
            "route_followed": True,
            "origin": {"x": 12, "y": 5, "z": 34},
            "destination": {"x": 12, "y": 5, "z": 34},
            "threat_count_before": 4,
            "threat_count_after": 0,
        }},
        {**current_observation(), "revision": 45},
    )
    assert no_move is False
    assert failure == "retreat_route_displacement_too_small"
    assert blocked["unresolved_action"] == action


def test_flat_route_retreat_requires_both_route_displacement_and_threat_reduction():
    action = terminal_action()
    state = {"unresolved_action": action}
    plan = prepare_s4_threat_recovery(state, current_observation())
    result = {"status": "succeeded", "receipt_confirmed": True, "terminal_observation": {
        **current_observation(), "revision": 44, "position": {"x": 15, "y": 5, "z": 34},
    }, "retreat_evidence": {
        "route_followed": True,
        "origin": {"x": 12, "y": 5, "z": 34},
        "destination": {"x": 15, "y": 5, "z": 34},
        "threat_score_before": 12,
        "threat_score_after": 5,
    }}
    ok, _ = commit_s4_threat_recovery(
        state, plan, result, {**current_observation(), "revision": 45, "position": {"x": 15, "y": 5, "z": 34}}
    )
    assert ok is True

    result["retreat_evidence"]["threat_score_after"] = 13
    assert commit_s4_threat_recovery(
        {"unresolved_action": action}, plan, result,
        {**current_observation(), "revision": 45, "position": {"x": 15, "y": 5, "z": 34}},
    ) == (
        False, "retreat_threat_not_reduced"
    )
