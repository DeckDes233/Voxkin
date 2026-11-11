from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from aiohttp.test_utils import TestClient, TestServer

from voxkin.agent.actions import ActionDispatcher, ActionError
from voxkin.server import StudioServer


class RestoreManager:
    def __init__(self, hint: dict) -> None:
        self.hint = hint
        self.states: list[dict] = []
        self.state_event = asyncio.Event()

    def shelter_restore_hint(self) -> dict:
        return self.hint

    def on_state_update(self, state: dict) -> None:
        self.states.append(state)
        self.state_event.set()

    def on_bridge_unavailable(self, reason: str) -> None:
        return None


def state_frame(
    revision: int,
    *,
    shelter: dict | None = None,
    dimension: str = "overworld",
    session_id: str = "bridge-session-2",
    ready: bool = True,
) -> dict:
    return {
        "session_id": session_id,
        "revision": revision,
        "ready": ready,
        "alive": True,
        "health": 20,
        "food": 12,
        "position": {"x": -34, "y": 73, "z": 130},
        "dimension": dimension,
        "inventory": {},
        "executor": {"active_action_id": None, "safety_active": False},
        "shelter": shelter,
    }


@pytest.mark.asyncio
async def test_shelter_restore_gates_dispatch_until_same_session_fresh_geometry(tmp_path: Path) -> None:
    hint = {"position": {"x": -34, "y": 72, "z": 130}, "size": 4, "dimension": "overworld"}
    manager = RestoreManager(hint)
    dispatcher = ActionDispatcher(require_protocol=True)
    runtime = SimpleNamespace(
        dispatcher=dispatcher,
        run_manager=manager,
        hub=SimpleNamespace(publish=AsyncMock()),
        arbiter=SimpleNamespace(cancel_all=AsyncMock(return_value=[])),
    )
    client = TestClient(TestServer(StudioServer(runtime, tmp_path / "config.yaml").build()))
    await client.start_server()
    socket = await client.ws_connect("/ws/bridge")
    try:
        welcome = json.loads((await socket.receive()).data)
        assert welcome["type"] == "welcome"

        await socket.send_json({"type": "state", "data": state_frame(1)})
        request = json.loads((await socket.receive()).data)
        assert request == {"type": "state_request", "shelter": {"position": hint["position"], "size": 4}}
        assert manager.states == []
        assert dispatcher.state_snapshot() == {}

        with pytest.raises(ActionError) as error:
            await dispatcher.dispatch_result("craft", {"item": "oak_planks", "count": 1})
        assert error.value.status == "blocked"

        broken_structure = {
            "position": dict(hint["position"]),
            "size": 4,
            "sealed": False,
            "inside": False,
        }
        await socket.send_json({"type": "state", "data": state_frame(2, shelter=broken_structure)})
        await asyncio.wait_for(manager.state_event.wait(), timeout=1.0)

        assert len(manager.states) == 1
        assert manager.states[0]["shelter"]["sealed"] is False
        assert dispatcher.state_snapshot()["ready"] is True
    finally:
        await socket.close()
        await client.close()


@pytest.mark.asyncio
async def test_shelter_restore_does_not_replace_existing_bridge_context_or_cross_dimensions(tmp_path: Path) -> None:
    hint = {"position": {"x": -34, "y": 72, "z": 130}, "size": 4, "dimension": "overworld"}
    for state in (
        state_frame(
            1,
            shelter={"position": {"x": 10, "y": 64, "z": 10}, "size": 3, "sealed": False, "inside": False},
        ),
        state_frame(1, dimension="the_nether"),
    ):
        manager = RestoreManager(hint)
        dispatcher = ActionDispatcher(require_protocol=True)
        runtime = SimpleNamespace(
            dispatcher=dispatcher,
            run_manager=manager,
            hub=SimpleNamespace(publish=AsyncMock()),
            arbiter=SimpleNamespace(cancel_all=AsyncMock(return_value=[])),
        )
        client = TestClient(TestServer(StudioServer(runtime, tmp_path / f"config-{len(state['dimension'])}.yaml").build()))
        await client.start_server()
        socket = await client.ws_connect("/ws/bridge")
        try:
            await socket.receive()
            await socket.send_json({"type": "state", "data": state})
            await asyncio.wait_for(manager.state_event.wait(), timeout=1.0)
            assert len(manager.states) == 1
            assert dispatcher.state_snapshot()["ready"] is True
            with pytest.raises(asyncio.TimeoutError):
                await asyncio.wait_for(socket.receive(), timeout=0.02)
        finally:
            await socket.close()
            await client.close()


@pytest.mark.asyncio
async def test_shelter_restore_retries_new_session_and_rejects_retired_session(tmp_path: Path) -> None:
    hint = {"position": {"x": -34, "y": 72, "z": 130}, "size": 4, "dimension": "overworld"}
    manager = RestoreManager(hint)
    dispatcher = ActionDispatcher(require_protocol=True)
    runtime = SimpleNamespace(
        dispatcher=dispatcher,
        run_manager=manager,
        hub=SimpleNamespace(publish=AsyncMock()),
        arbiter=SimpleNamespace(cancel_all=AsyncMock(return_value=[])),
    )
    client = TestClient(TestServer(StudioServer(runtime, tmp_path / "config.yaml").build()))
    await client.start_server()
    socket = await client.ws_connect("/ws/bridge")
    try:
        await socket.receive()
        await socket.send_json({"type": "state", "data": state_frame(1)})
        first_request = json.loads((await socket.receive()).data)
        assert first_request["type"] == "state_request"
        assert dispatcher.state_snapshot() == {}

        await socket.send_json(
            {
                "type": "state",
                "data": state_frame(1, session_id="bridge-session-3"),
            }
        )
        second_request = json.loads((await socket.receive()).data)
        assert second_request["type"] == "state_request"
        assert manager.states == []
        assert dispatcher.state_snapshot() == {}

        await socket.send_json(
            {
                "type": "state",
                "data": state_frame(2, session_id="bridge-session-3"),
            }
        )
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(socket.receive(), timeout=0.02)
        assert manager.states == []
        assert dispatcher.state_snapshot() == {}

        stale_shelter = {
            "position": dict(hint["position"]),
            "size": 4,
            "sealed": True,
            "inside": True,
        }
        await socket.send_json(
            {
                "type": "state",
                "data": state_frame(2, shelter=stale_shelter, session_id="bridge-session-2"),
            }
        )
        await asyncio.sleep(0.02)
        assert manager.states == []
        assert dispatcher.state_snapshot() == {}

        fresh_broken_shelter = {**stale_shelter, "sealed": False, "inside": False}
        await socket.send_json(
            {
                "type": "state",
                "data": state_frame(3, shelter=fresh_broken_shelter, session_id="bridge-session-3"),
            }
        )
        await asyncio.wait_for(manager.state_event.wait(), timeout=1.0)
        assert len(manager.states) == 1
        assert manager.states[0]["session_id"] == "bridge-session-3"
        assert manager.states[0]["shelter"]["sealed"] is False
        assert dispatcher.state_snapshot()["session_id"] == "bridge-session-3"
    finally:
        await socket.close()
        await client.close()


@pytest.mark.asyncio
async def test_shelter_restore_keeps_gate_closed_after_retry_limit_until_fresh_geometry(tmp_path: Path) -> None:
    hint = {"position": {"x": -34, "y": 72, "z": 130}, "size": 4, "dimension": "overworld"}
    manager = RestoreManager(hint)
    dispatcher = ActionDispatcher(require_protocol=True)
    runtime = SimpleNamespace(
        dispatcher=dispatcher,
        run_manager=manager,
        hub=SimpleNamespace(publish=AsyncMock()),
        arbiter=SimpleNamespace(cancel_all=AsyncMock(return_value=[])),
    )
    client = TestClient(TestServer(StudioServer(runtime, tmp_path / "config.yaml").build()))
    await client.start_server()
    socket = await client.ws_connect("/ws/bridge")
    try:
        await socket.receive()
        await socket.send_json({"type": "state", "data": state_frame(1)})
        assert json.loads((await socket.receive()).data)["type"] == "state_request"

        await socket.send_json({"type": "state", "data": state_frame(2)})
        assert json.loads((await socket.receive()).data)["type"] == "state_request"

        await socket.send_json({"type": "state", "data": state_frame(3)})
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(socket.receive(), timeout=0.02)
        assert manager.states == []
        assert dispatcher.state_snapshot() == {}
        with pytest.raises(ActionError) as error:
            await dispatcher.dispatch_result("craft", {"item": "oak_planks", "count": 1})
        assert error.value.status == "blocked"

        fresh_geometry = {
            "position": dict(hint["position"]),
            "size": 4,
            "sealed": False,
            "inside": False,
        }
        await socket.send_json({"type": "state", "data": state_frame(4, shelter=fresh_geometry)})
        await asyncio.wait_for(manager.state_event.wait(), timeout=1.0)
        assert len(manager.states) == 1
        assert manager.states[0]["shelter"] == fresh_geometry
        assert dispatcher.state_snapshot()["ready"] is True
    finally:
        await socket.close()
        await client.close()


@pytest.mark.asyncio
async def test_shelter_restore_waits_for_ready_frame_before_marking_request_attempted(tmp_path: Path) -> None:
    hint = {"position": {"x": -34, "y": 72, "z": 130}, "size": 4, "dimension": "overworld"}
    manager = RestoreManager(hint)
    dispatcher = ActionDispatcher(require_protocol=True)
    runtime = SimpleNamespace(
        dispatcher=dispatcher,
        run_manager=manager,
        hub=SimpleNamespace(publish=AsyncMock()),
        arbiter=SimpleNamespace(cancel_all=AsyncMock(return_value=[])),
    )
    client = TestClient(TestServer(StudioServer(runtime, tmp_path / "config.yaml").build()))
    await client.start_server()
    socket = await client.ws_connect("/ws/bridge")
    try:
        await socket.receive()
        await socket.send_json({"type": "state", "data": state_frame(1, ready=False)})
        await asyncio.wait_for(manager.state_event.wait(), timeout=1.0)
        assert manager.states[0]["ready"] is False
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(socket.receive(), timeout=0.02)

        await socket.send_json({"type": "state", "data": state_frame(2, ready=True)})
        request = json.loads((await socket.receive()).data)
        assert request["type"] == "state_request"
        assert dispatcher.state_snapshot() == {}
    finally:
        await socket.close()
        await client.close()
