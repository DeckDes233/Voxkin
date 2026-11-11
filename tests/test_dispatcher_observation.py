from __future__ import annotations

import asyncio
import time

import pytest

from voxkin.agent.actions import ActionDispatcher, ActionError
from voxkin.bridge.protocol import ActionResult, ActionStatusResult


def _state(session_id: str, revision: int, **extra: object) -> dict:
    return {
        "session_id": session_id,
        "revision": revision,
        "ready": True,
        "alive": True,
        "health": 20,
        "position": {"x": 0, "y": 64, "z": 0},
        **extra,
    }


async def test_late_result_from_old_session_does_not_replace_current_state():
    dispatcher = ActionDispatcher()
    sent: list[dict] = []

    async def sender(message: dict) -> None:
        sent.append(message)

    dispatcher.attach(sender)
    assert dispatcher.update_state(_state("old-world", 4, inventory={"oak_log": 0}))
    task = asyncio.create_task(
        dispatcher.dispatch_result("collect_blocks", {"block": "oak_log", "count": 1})
    )
    await asyncio.sleep(0)
    assert sent[-1]["session_id"] == "old-world"
    assert sent[-1]["state_revision"] == 4

    assert dispatcher.update_state(_state("new-world", 1, inventory={"oak_log": 7}))
    dispatcher.resolve(
        ActionResult(
            action_id=sent[-1]["action_id"],
            ok=True,
            status="succeeded",
            data={"observation": _state("old-world", 5, inventory={"oak_log": 1})},
        )
    )
    await task
    assert dispatcher.state_snapshot()["session_id"] == "new-world"
    assert dispatcher.state_snapshot()["inventory"] == {"oak_log": 7}


async def test_old_action_status_observation_does_not_replace_current_state():
    dispatcher = ActionDispatcher()
    sent: list[dict] = []

    async def sender(message: dict) -> None:
        sent.append(message)

    dispatcher.attach(sender)
    assert dispatcher.update_state(_state("old-world", 10, inventory={"iron_ingot": 0}))
    task = asyncio.create_task(dispatcher.action_status("action-1"))
    await asyncio.sleep(0)
    assert sent[-1] == {"type": "action_status", "action_id": "action-1"}

    assert dispatcher.update_state(_state("new-world", 1, inventory={"iron_ingot": 2}))
    dispatcher.resolve_action_status(
        ActionStatusResult(
            action_id="action-1",
            status="succeeded",
            data={"observation": _state("old-world", 11, inventory={"iron_ingot": 1})},
        )
    )
    result = await task
    assert result.status == "succeeded"
    assert dispatcher.state_snapshot()["session_id"] == "new-world"
    assert dispatcher.state_snapshot()["inventory"] == {"iron_ingot": 2}


def test_duplicate_revision_does_not_refresh_observation_freshness():
    dispatcher = ActionDispatcher()
    assert dispatcher.update_state(_state("world", 12))
    dispatcher._state_at = time.monotonic() - 31

    assert not dispatcher.update_state(_state("world", 12, inventory={"dirt": 40}))
    assert dispatcher.state_snapshot() == {}
    assert dispatcher.state_age_s() > 30

    assert dispatcher.update_state(_state("world", 13, inventory={"dirt": 40}))
    assert dispatcher.state_snapshot()["inventory"] == {"dirt": 40}


async def test_readiness_hold_blocks_result_observations_until_explicit_release():
    dispatcher = ActionDispatcher(require_protocol=True)
    sent: list[dict] = []

    async def sender(message: dict) -> None:
        sent.append(message)

    dispatcher.attach(sender)
    assert dispatcher.update_state(_state("world", 1, inventory={"oak_log": 0}))
    status_task = asyncio.create_task(dispatcher.action_status("previous-action"))
    await asyncio.sleep(0)
    assert sent[-1] == {"type": "action_status", "action_id": "previous-action"}

    dispatcher.set_readiness_hold(True)
    assert dispatcher.update_state(
        _state("world", 2, inventory={"oak_log": 1}), source="result"
    )
    dispatcher.resolve_action_status(
        ActionStatusResult(
            action_id="previous-action",
            status="succeeded",
            data={"observation": _state("world", 3, inventory={"oak_log": 2})},
        )
    )
    assert (await status_task).status == "succeeded"
    assert dispatcher.state_snapshot() == {}
    assert dispatcher.state_age_s() == float("inf")

    dispatcher.set_readiness_hold(False)
    assert dispatcher.state_snapshot()["revision"] == 3
    assert dispatcher.state_snapshot()["inventory"] == {"oak_log": 2}


async def test_formal_dispatcher_refuses_action_without_fresh_ready_session():
    dispatcher = ActionDispatcher(require_protocol=True)
    sent: list[dict] = []

    async def sender(message: dict) -> None:
        sent.append(message)

    dispatcher.attach(sender)
    with pytest.raises(ActionError) as error:
        await dispatcher.dispatch_result("observe", {})
    assert error.value.status == "blocked"
    assert sent == []

    dispatcher.update_state(_state("world", 1, ready=False))
    with pytest.raises(ActionError) as error:
        await dispatcher.dispatch_result("observe", {})
    assert error.value.status == "blocked"
    assert sent == []
