import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import numpy as np
import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from dev_llm_server import build_app as build_llm_app

from support import ToneTTS
from voxkin.agent.actions import ActionDispatcher, ActionError
from voxkin.audio.sinks import WavDirSink
from voxkin.config import VoxkinConfig
from voxkin.events import EventHub, MetricsStore
from voxkin.llm.openai_compat import OpenAICompatLLM
from voxkin.pipeline import ConversationPipeline
from voxkin.server import StudioServer


class Harness:
    """把真实管线接到 Studio 服务上，用于验证 WebSocket 协议；TTS 使用确定音源。"""

    def __init__(self, config: VoxkinConfig, tmp_path: Path) -> None:
        self.config = config
        self.hub = EventHub()
        self.metrics = MetricsStore()
        self.dispatcher = ActionDispatcher()
        self.tts = ToneTTS(delay_s=0.001)
        self.llm = OpenAICompatLLM(config.llm)
        self.pipeline = ConversationPipeline(
            config=config,
            llm=self.llm,
            tts=self.tts,
            sink=WavDirSink(tmp_path),
            metrics=self.metrics,
            emit=self.hub.publish,
        )

        async def handle_action(call: dict, turn) -> str:
            return await self.dispatcher.dispatch(call["name"], call.get("arguments") or {})

        self.pipeline.set_action_handler(handle_action)

    def status(self) -> dict[str, Any]:
        return {
            "bridge": {
                "connected": self.dispatcher.connected,
                "name": self.dispatcher.bridge_name,
                "pending_actions": self.dispatcher.pending_count,
            }
        }

    def mic_status(self) -> dict[str, Any]:
        return {
            "state": "stopped",
            "running": False,
            "last_transcript": "",
            "last_stt_ms": None,
            "barge_in": False,
        }


async def wait_until(predicate, timeout: float = 3.0) -> bool:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if predicate():
            return True
        await asyncio.sleep(0.02)
    return predicate()


@pytest.fixture
async def stack(tmp_path):
    llm_app = build_llm_app(delay_ms=2)
    llm_runner = web.AppRunner(llm_app)
    await llm_runner.setup()
    llm_site = web.TCPSite(llm_runner, "127.0.0.1", 0)
    await llm_site.start()
    llm_port = llm_site._server.sockets[0].getsockname()[1]

    config = VoxkinConfig()
    config.llm.api_key = "test-key"
    config.llm.base_url = f"http://127.0.0.1:{llm_port}/v1"
    harness = Harness(config, tmp_path)
    await harness.pipeline.start()

    studio = StudioServer(harness, config_path=tmp_path / "voxkin.yaml")
    server = TestServer(studio.build())
    client = TestClient(server)
    await client.start_server()
    try:
        yield harness, client
    finally:
        await client.close()
        await harness.pipeline.close()
        await llm_runner.cleanup()


async def test_bridge_websocket_dispatch(stack):
    harness, client = stack
    ws = await client.ws_connect("/ws/bridge?name=test")
    welcome = await ws.receive_json()
    assert welcome["type"] == "welcome"

    task = asyncio.create_task(harness.dispatcher.dispatch("collect_blocks", {"block": "oak_log"}))
    message = await ws.receive_json()
    assert message["type"] == "action"
    assert message["tool"] == "collect_blocks"
    await ws.send_json(
        {
            "type": "action_result",
            "action_id": message["action_id"],
            "ok": True,
            "detail": "collected 3 oak_log",
        }
    )
    assert await task == "collected 3 oak_log"

    status = await client.get("/api/status")
    payload = await status.json()
    assert payload["bridge"]["connected"] is True
    await ws.send_json({"type": "death", "lifecycle_id": "ack-1", "data": {"health": 0}})
    assert await ws.receive_json() == {
        "type": "lifecycle_ack",
        "event_type": "death",
        "lifecycle_id": "ack-1",
    }
    await ws.close()


async def test_bridge_disconnect_cancels_arbiter_and_invalidates_state(stack):
    harness, client = stack
    harness.arbiter = SimpleNamespace(cancel_all=AsyncMock())
    harness.dispatcher.update_state({"alive": True, "health": 20, "position": {"x": 1, "y": 2, "z": 3}})
    ws = await client.ws_connect("/ws/bridge?name=disconnect-test")
    await ws.receive_json()

    await ws.close()

    assert await wait_until(lambda: harness.arbiter.cancel_all.await_count == 1)
    assert harness.dispatcher.state_snapshot() == {}


async def test_minecraft_disconnect_event_invalidates_state_without_closing_bridge(stack):
    harness, client = stack
    harness.arbiter = SimpleNamespace(cancel_all=AsyncMock())
    ws = await client.ws_connect("/ws/bridge?name=world-disconnect-test")
    await ws.receive_json()
    await ws.send_json({"type": "state", "data": {"alive": True, "health": 20, "position": {"x": 4, "y": 64, "z": 8}}})
    await asyncio.sleep(0.01)

    await ws.send_json({"type": "world_unavailable", "reason": "minecraft_disconnected"})
    await asyncio.sleep(0.02)

    assert harness.dispatcher.state_snapshot() == {}
    harness.arbiter.cancel_all.assert_awaited_once()
    assert not ws.closed
    await ws.close()


async def test_death_event_fails_pending_action_and_respawn_refreshes_state(stack):
    harness, client = stack

    class RunEvents:
        def __init__(self) -> None:
            self.deaths: list[dict] = []
            self.respawns: list[dict] = []

        def on_death(self, payload: dict) -> None:
            self.deaths.append(payload)

        def on_respawn(self, payload: dict) -> None:
            self.respawns.append(payload)

    manager = RunEvents()
    harness.run_manager = manager
    harness.arbiter = None
    harness.dispatcher.update_state(
        {
            "alive": True,
            "health": 20,
            "position": {"x": 4, "y": 64, "z": 8},
            "inventory": {"oak_log": 3},
        }
    )
    ws = await client.ws_connect("/ws/bridge?name=death-test")
    await ws.receive_json()
    event_queue = harness.hub.subscribe()
    action = asyncio.create_task(
        harness.dispatcher.dispatch_result("collect_blocks", {"block": "oak_log"})
    )
    request = await ws.receive_json()

    await ws.send_json(
        {
            "type": "death",
            "lifecycle_id": "death-1",
            "data": {"health": 0, "position": {"x": 4, "y": 64, "z": 8}},
        }
    )
    with pytest.raises(ActionError) as error:
        await action
    death_event = await asyncio.wait_for(event_queue.get(), timeout=1)
    assert error.value.status == "dead"
    assert death_event["type"] == "player_death"
    assert manager.deaths[0]["interrupted_actions"] == [request["action_id"]]
    assert harness.dispatcher.state_snapshot()["inventory"] == {"oak_log": 3}

    await ws.send_json(
        {
            "type": "respawn",
            "lifecycle_id": "death-1",
            "data": {
                "health": 20,
                "position": {"x": 0, "y": 64, "z": 0},
                "inventory": {"oak_log": 1},
            },
        }
    )
    respawn_event = await asyncio.wait_for(event_queue.get(), timeout=1)
    assert respawn_event["type"] == "player_respawn"
    assert manager.respawns[0]["alive"] is True
    assert harness.dispatcher.state_snapshot()["position"]["x"] == 0
    assert harness.dispatcher.state_snapshot()["inventory"] == {"oak_log": 1}
    harness.hub.unsubscribe(event_queue)
    await ws.close()


async def test_bridge_chat_triggers_turn(stack):
    harness, client = stack
    ws = await client.ws_connect("/ws/bridge?name=test")
    await ws.receive_json()
    queue = harness.hub.subscribe()
    await ws.send_json({"type": "chat", "text": "你好", "player": "Steve"})
    finished = None
    for _ in range(60):
        event = await asyncio.wait_for(queue.get(), timeout=5)
        if event.get("type") == "turn_finished":
            finished = event
            break
    harness.hub.unsubscribe(queue)
    await ws.close()
    assert finished is not None
    assert finished["summary"]["first_audible_ms"] is not None


async def test_action_runs_while_speech_completes(stack):
    harness, client = stack
    ws = await client.ws_connect("/ws/bridge?name=test")
    await ws.receive_json()

    async def answer_actions() -> None:
        while True:
            message = await ws.receive_json()
            if message.get("type") == "action":
                await ws.send_json(
                    {
                        "type": "action_result",
                        "action_id": message["action_id"],
                        "ok": True,
                        "detail": "collected 3 oak_log",
                    }
                )

    responder = asyncio.create_task(answer_actions())
    events = harness.hub.subscribe()
    try:
        summary = await harness.pipeline.respond("ACTION 去砍三块木头")
        finished = None
        for _ in range(40):
            event = await asyncio.wait_for(events.get(), timeout=2)
            if event.get("type") == "action_finished":
                finished = event
                break
        await wait_until(lambda: any("好了" in text for text in harness.tts.texts))
    finally:
        harness.hub.unsubscribe(events)
        responder.cancel()
        await ws.close()
    assert summary["first_audible_ms"] is not None
    assert summary["meta"]["tool_calls"] == 1
    assert "t7_action_start" in summary["marks"]
    assert finished is not None
    assert finished["tool"] == "collect_blocks"
    assert finished["detail"] == "collected 3 oak_log"
    record = harness.metrics.recent(1)[0]
    assert record["action_done_ms"] is not None
    assert any("好了" in text for text in harness.tts.texts)


async def test_llm_test_endpoint(stack):
    harness, client = stack
    response = await client.post("/api/llm/test")
    assert response.status == 200
    data = await response.json()
    assert data["ttft_ms"] is not None
    assert data["total_ms"] >= data["ttft_ms"]
    assert data["text"]


async def test_action_failure_is_spoken(stack):
    harness, client = stack
    ws = await client.ws_connect("/ws/bridge?name=test")
    await ws.receive_json()

    async def fail_actions() -> None:
        while True:
            message = await ws.receive_json()
            if message.get("type") == "action":
                await ws.send_json(
                    {
                        "type": "action_result",
                        "action_id": message["action_id"],
                        "ok": False,
                        "detail": "附近没有可挖的方块",
                    }
                )

    responder = asyncio.create_task(fail_actions())
    events = harness.hub.subscribe()
    try:
        summary = await harness.pipeline.respond("ACTION 去砍三块木头")
        failed = None
        for _ in range(40):
            event = await asyncio.wait_for(events.get(), timeout=2)
            if event.get("type") == "action_failed":
                failed = event
                break
        await wait_until(lambda: any("没做成" in text for text in harness.tts.texts))
    finally:
        harness.hub.unsubscribe(events)
        responder.cancel()
        await ws.close()
    assert failed is not None
    assert summary["meta"].get("action_errors")
    assert any("没做成" in text for text in harness.tts.texts)


async def test_audio_websocket_streams_pcm(stack):
    harness, client = stack
    from voxkin.audio.websocket import WebSocketAudioSink

    sink = WebSocketAudioSink()
    harness.pipeline.sink = sink
    ws = await client.ws_connect("/ws/audio")
    welcome = await ws.receive_json()
    assert welcome["sample_rate"] == 32000

    pcm = np.full(320, 500, dtype=np.int16)
    task = asyncio.create_task(sink.play("turn-1", pcm))
    header = await ws.receive_json()
    assert header["type"] == "pcm"
    assert header["bytes"] == 640
    data = await ws.receive_bytes()
    assert len(data) == 640
    await task

    await sink.flush()
    assert (await ws.receive_json())["type"] == "flush"
    await ws.close()


async def test_second_bridge_is_rejected(stack):
    harness, client = stack
    first = await client.ws_connect("/ws/bridge?name=first")
    await first.receive_json()
    second = await client.ws_connect("/ws/bridge?name=second")
    error = await second.receive_json()
    assert error["type"] == "error"
    await first.close()
    await second.close()
