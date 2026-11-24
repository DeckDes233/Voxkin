from __future__ import annotations

import asyncio
import copy

import pytest

from voxkin.agent.goal_supervisor import GoalSupervisor
from voxkin.agent.goal_methods import s5_portal_hint
from voxkin.agent.goals import GOALS, evaluate_condition
from voxkin.agent.runner import StepSpec
from voxkin.agent.tasks import TaskStore
from voxkin.bridge.protocol import ActionResult, ActionStatusResult


def observation(session_id: str, revision: int, dimension: str, position: dict[str, int], inventory: dict[str, int]) -> dict:
    return {
        "session_id": session_id,
        "revision": revision,
        "ready": True,
        "alive": True,
        "health": 20,
        "dimension": dimension,
        "position": dict(position),
        "inventory": dict(inventory),
        "executor": {"safety_active": False, "active_action_id": None},
    }


def transition(source_dimension: str, source_position: dict[str, int], target_dimension: str, target_position: dict[str, int]) -> dict:
    return {
        "source": {
            "dimension": source_dimension,
            "position": dict(source_position),
            "observed": "nether_portal_block",
        },
        "target": {
            "dimension": target_dimension,
            "position": dict(target_position),
            "observed": "arrival_checkpoint",
        },
    }


def test_s5_portal_receipt_from_old_session_is_confirmed_by_reconnected_observation(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    current = observation(
        "bridge-after-restart",
        2,
        "minecraft:the_nether",
        {"x": 121, "y": 71, "z": -249},
        {"obsidian": 10},
    )
    supervisor = GoalSupervisor(
        GOALS["S5"], store, lambda *_args, **_kwargs: None, lambda: current,
        require_protocol=True,
    )
    pending = {
        "action_id": "portal-action",
        "tool": "nether_travel",
        "session_id": "bridge-before-restart",
        "revision": 9,
        "receipt_confirmed": True,
        "expected_condition": {"type": "dimension", "value": "minecraft:the_nether"},
    }
    data = {
        "observation": observation(
            "bridge-before-restart",
            11,
            "minecraft:the_nether",
            {"x": 121, "y": 71, "z": -249},
            {"obsidian": 10},
        ),
        "portal_transition": transition(
            "minecraft:overworld",
            {"x": 2, "y": 64, "z": 3},
            "minecraft:the_nether",
            {"x": 121, "y": 71, "z": -249},
        ),
    }

    portal_transition, terminal_observation, reason = supervisor._s5_portal_result(
        pending, "succeeded", current, data
    )

    assert portal_transition == data["portal_transition"]
    assert terminal_observation["session_id"] == "bridge-before-restart"
    assert "已由同 session terminal receipt 验证" in reason
    store.close()


@pytest.mark.asyncio
async def test_s5_portal_transition_survives_store_and_bridge_restart_for_exit_hint(tmp_path):
    database = tmp_path / "tasks.db"
    store = TaskStore(database)
    store.initialize()
    task = store.create_task("S5 portal restore", "S5")
    world = observation(
        "bridge-before-restart",
        10,
        "overworld",
        {"x": 16, "y": 64, "z": 16},
        {"obsidian": 10, "flint_and_steel": 1},
    )
    restart_armed = False
    restart_read_used = False
    ready_refresh_armed = False
    ready_refresh_used = False

    def state_provider():
        nonlocal ready_refresh_used, restart_read_used
        if ready_refresh_armed and not ready_refresh_used:
            ready_refresh_used = True
            world["revision"] += 1
            world["ready"] = True
        if restart_armed:
            if restart_read_used:
                raise asyncio.CancelledError("模拟 Core 在无 pending action 时重启")
            restart_read_used = True
        return dict(world)

    async def first_action_status(action_id):
        assert action_id == "pending-make-portal"
        return ActionStatusResult(
            action_id=action_id,
            status="succeeded",
            detail="Bridge terminal receipt",
            data={"observation": dict(world)},
        )

    first_supervisor = GoalSupervisor(
        GOALS["S5"], store, lambda *_args, **_kwargs: None, state_provider,
        action_status=first_action_status, require_protocol=True,
    )
    saved = first_supervisor._new_state()
    saved["method_index"] = 5  # Bridge 已在途确认门框动作，重连后先对账再进入下界。
    saved["pending_action"] = {
        "action_id": "pending-make-portal",
        "goal_id": "stage:s5",
        "method_id": "plan:s5",
        "method_key": "plan:s5:5",
        "step_index": 5,
        "tool": "make_nether_portal",
        "arguments": {},
        "expected_condition": {"type": "always"},
        "effect_class": "non_replayable",
        "session_id": "bridge-before-restart",
        "revision": 9,
        "status": "unknown",
        "receipt_confirmed": False,
    }
    saved["recovery"] = {
        "needs_reconcile": True,
        "reason": "bridge_disconnected",
        "baseline_session_id": "bridge-before-restart",
        "baseline_revision": 9,
    }
    saved["counters"]["actions"] = 5
    saved["counters"]["attempts"] = {"prior:s5": 2}
    saved["budget"]["max_actions"] = 120
    saved["action_history"] = [
        {
            "action_id": "prior-action",
            "method_key": "plan:s5:5",
            "tool": "make_nether_portal",
            "status": "succeeded",
            "receipt_confirmed": True,
        }
    ]
    store.save_goal_state(task.id, saved)
    original_budget = copy.deepcopy(saved["budget"])
    original_history = copy.deepcopy(saved["action_history"])

    async def first_dispatch(tool, arguments, timeout_s=None, **kwargs):
        nonlocal ready_refresh_armed, restart_armed
        world["revision"] += 1
        data = {}
        if tool == "nether_travel":
            assert arguments["mode"] == "enter"
            world.update(
                observation(
                    "bridge-before-restart",
                    world["revision"],
                    "the_nether",
                    {"x": 121, "y": 71, "z": -249},
                    world["inventory"],
                )
            )
            world["ready"] = False
            data["portal_transition"] = transition(
                "minecraft:overworld",
                {"x": 2, "y": 64, "z": 3},
                "minecraft:the_nether",
                {"x": 121, "y": 71, "z": -249},
            )
        elif tool == "raid_fortress":
            assert arguments["scout_only"]
            data["events"] = ["fortress_route_found"]
        elif tool == "collect_blaze_rods":
            world["inventory"]["blaze_rod"] = 12
        elif tool == "hunt_enderman":
            world["inventory"]["ender_pearl"] = 24
            restart_armed = True
        data["observation"] = dict(world)
        if tool == "nether_travel":
            ready_refresh_armed = True
        return ActionResult(
            action_id=kwargs["action_id"], ok=True, status="succeeded", data=data
        )

    first_supervisor.dispatch = first_dispatch
    with pytest.raises(asyncio.CancelledError, match="模拟 Core"):
        await first_supervisor.run(task.id, resume=True)

    after_entry = store.load_goal_state(task.id)
    assert after_entry["method_index"] == 10
    assert after_entry["pending_action"] is None
    assert after_entry["budget"] == original_budget
    assert after_entry["action_history"] == original_history
    assert after_entry["counters"]["actions"] == 9
    assert after_entry["s5_portal_checkpoint"]["schema_version"] == 1
    assert after_entry["s5_portal_checkpoint"]["transition"] == transition(
        "minecraft:overworld",
        {"x": 2, "y": 64, "z": 3},
        "minecraft:the_nether",
        {"x": 121, "y": 71, "z": -249},
    )
    assert after_entry["s5_portal_checkpoint"]["receipt"]["session_id"] == "bridge-before-restart"
    assert after_entry["s5_portal_checkpoint"]["receipt"]["revision"] == 11
    assert s5_portal_hint(
        after_entry,
        {"session_id": "bridge-before-restart", "dimension": "the_nether"},
    ) is None
    assert s5_portal_hint(
        after_entry,
        {"session_id": "bridge-after-restart", "dimension": "custom:the_nether"},
    ) is None
    first_portal_action_id = after_entry["s5_portal_checkpoint"]["receipt"]["action_id"]
    store.close()

    reopened = TaskStore(database)
    reopened.initialize()
    new_world = observation(
        "bridge-after-restart",
        1,
        "the_nether",
        {"x": 121, "y": 71, "z": -249},
        {"obsidian": 10, "flint_and_steel": 1, "blaze_rod": 12, "ender_pearl": 24},
    )
    exit_arguments: list[dict] = []

    async def restarted_dispatch(tool, arguments, timeout_s=None, **kwargs):
        assert tool == "nether_travel"
        assert arguments["mode"] == "exit"
        exit_arguments.append(dict(arguments))
        new_world.update(
            observation(
                "bridge-after-restart",
                new_world["revision"] + 1,
                "minecraft:overworld",
                {"x": 16, "y": 64, "z": 16},
                new_world["inventory"],
            )
        )
        data = {
            "portal_transition": transition(
                "minecraft:the_nether",
                {"x": 121, "y": 71, "z": -249},
                "minecraft:overworld",
                {"x": 16, "y": 64, "z": 16},
            ),
            "observation": dict(new_world),
        }
        return ActionResult(action_id=kwargs["action_id"], ok=True, status="succeeded", data=data)

    restarted = GoalSupervisor(
        GOALS["S5"], reopened, restarted_dispatch, lambda: dict(new_world),
        require_protocol=True,
    )
    result = await restarted.run(task.id, resume=True)

    assert result["status"] == "done"
    assert len(exit_arguments) == 1
    assert exit_arguments[0]["portal_hint"] == transition(
        "minecraft:overworld",
        {"x": 2, "y": 64, "z": 3},
        "minecraft:the_nether",
        {"x": 121, "y": 71, "z": -249},
    )
    final_state = reopened.load_goal_state(task.id)
    assert final_state["pending_action"] is None
    assert final_state["budget"] == original_budget
    assert final_state["action_history"] == original_history
    assert final_state["counters"]["actions"] == 10
    assert final_state["s5_portal_checkpoint"]["receipt"]["action_id"] != first_portal_action_id
    reopened.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "fault",
    ["admission_not_started", "wrong_session", "stale_revision"],
)
async def test_s5_does_not_persist_portal_from_untrusted_receipt(tmp_path, fault):
    store = TaskStore(tmp_path / f"{fault}.db")
    store.initialize()
    task = store.create_task("S5 invalid portal receipt", "S5")
    world = observation(
        "bridge-current", 10, "overworld", {"x": 0, "y": 64, "z": 0}, {}
    )
    supervisor = GoalSupervisor(
        GOALS["S5"], store, lambda *_args, **_kwargs: None, lambda: dict(world),
        require_protocol=True,
    )
    supervisor.task_id = task.id
    supervisor.state = supervisor._new_state()

    async def dispatch(tool, arguments, timeout_s=None, **kwargs):
        world.update(
            observation(
                "bridge-current", 11, "the_nether", {"x": 8, "y": 70, "z": 8}, {}
            )
        )
        action_data = {
            "portal_transition": transition(
                "minecraft:overworld", {"x": 1, "y": 64, "z": 1},
                "minecraft:the_nether", {"x": 8, "y": 70, "z": 8},
            ),
            "observation": dict(world),
        }
        if fault == "admission_not_started":
            action_data["admission"] = {"started": False, "reason": "stale_observation"}
        elif fault == "wrong_session":
            action_data["observation"]["session_id"] = "old-session"
        elif fault == "stale_revision":
            action_data["observation"]["revision"] = 10
        return ActionResult(
            action_id=kwargs["action_id"], ok=True, status="succeeded", data=action_data
        )

    supervisor.dispatch = dispatch
    result = await supervisor._execute_step(
        StepSpec(
            "enter nether",
            "nether_travel",
            {"mode": "enter"},
            {"type": "dimension", "value": "minecraft:the_nether"},
        ),
        "test:s5:enter",
        0,
    )

    assert result == "done"
    final_state = store.load_goal_state(task.id)
    assert "s5_portal_checkpoint" not in final_state
    assert final_state["pending_action"] is None
    assert final_state["method_index"] == 1
    store.close()


def test_s5_confirmed_portal_checkpoint_accepts_bare_dimensions_without_relaxing_ready_gate(tmp_path):
    store = TaskStore(tmp_path / "portal-ready.db")
    store.initialize()
    supervisor = GoalSupervisor(
        GOALS["S5"], store, lambda *_args, **_kwargs: None, lambda: {},
        require_protocol=True,
    )
    supervisor.state = supervisor._new_state()
    current = observation(
        "bridge-current", 12, "the_nether", {"x": 8, "y": 70, "z": 8}, {}
    )
    current["ready"] = False
    terminal = observation(
        "bridge-current", 11, "the_nether", {"x": 8, "y": 70, "z": 8}, {}
    )
    terminal["ready"] = False
    supervisor.state_provider = lambda: dict(current)
    pending = {
        "tool": "nether_travel",
        "action_id": "portal-entry",
        "session_id": "bridge-current",
        "revision": 10,
        "receipt_confirmed": True,
        "status": "succeeded",
        "expected_condition": {"type": "dimension", "value": "the_nether"},
    }
    data = {
        "portal_transition": transition(
            "overworld", {"x": 1, "y": 64, "z": 1},
            "the_nether", {"x": 8, "y": 70, "z": 8},
        ),
        "observation": terminal,
    }

    supervisor._record_s5_portal_transition(pending, data)

    checkpoint = supervisor.state["s5_portal_checkpoint"]
    assert checkpoint["transition"] == transition(
        "minecraft:overworld", {"x": 1, "y": 64, "z": 1},
        "minecraft:the_nether", {"x": 8, "y": 70, "z": 8},
    )
    assert checkpoint["receipt"]["revision"] == 11
    passed, _reason = evaluate_condition(
        pending["expected_condition"], {"dimension": current["dimension"]}
    )
    assert passed
    usable, reason = supervisor._state_usable(current)
    assert not usable
    assert reason == "Bridge 尚未 ready"
    store.close()


@pytest.mark.parametrize("fault", ["missing_transition", "unknown_mid_transition"])
def test_s5_missing_or_untrusted_portal_metadata_does_not_forge_checkpoint(tmp_path, fault):
    store = TaskStore(tmp_path / f"{fault}.db")
    store.initialize()
    world = observation(
        "bridge-current", 12, "the_nether", {"x": 8, "y": 70, "z": 8}, {}
    )
    supervisor = GoalSupervisor(
        GOALS["S5"], store, lambda *_args, **_kwargs: None, lambda: dict(world),
        require_protocol=True,
    )
    supervisor.state = supervisor._new_state()
    pending = {
        "tool": "nether_travel",
        "action_id": "portal-unknown" if fault == "unknown_mid_transition" else "portal-no-metadata",
        "session_id": "bridge-current",
        "revision": 10,
        "receipt_confirmed": fault == "missing_transition",
        "status": "unknown" if fault == "unknown_mid_transition" else "succeeded",
        "expected_condition": {"type": "dimension", "value": "minecraft:the_nether"},
    }
    data = {"observation": observation(
        "bridge-current", 11, "the_nether", {"x": 8, "y": 70, "z": 8}, {}
    )}
    if fault == "unknown_mid_transition":
        data["portal_transition"] = transition(
            "minecraft:overworld", {"x": 1, "y": 64, "z": 1},
            "minecraft:the_nether", {"x": 8, "y": 70, "z": 8},
        )

    supervisor._record_s5_portal_transition(pending, data)

    assert "s5_portal_checkpoint" not in supervisor.state
    passed, _reason = evaluate_condition(
        pending["expected_condition"], {"dimension": "the_nether"}
    )
    assert passed
    store.close()
