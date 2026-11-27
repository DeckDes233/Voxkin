from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from aiohttp.test_utils import TestClient, TestServer

from voxkin.agent.run_manager import RunManager
from voxkin.agent.tasks import TaskStore
from voxkin.config import VoxkinConfig
from voxkin.runtime import Runtime
from voxkin.server import StudioServer


@pytest.mark.asyncio
@pytest.mark.parametrize("payload, expected_mode", [
    ({"stage": "S4"}, None),
    ({"stage": "S4", "budget_mode": "adaptive"}, "adaptive"),
    ({"stage": "S4", "budget_mode": "acceptance"}, "acceptance"),
])
async def test_start_forwards_budget_mode(tmp_path, payload, expected_mode):
    manager = SimpleNamespace(start=AsyncMock(return_value={"running": True}))
    server = StudioServer(SimpleNamespace(run_manager=manager), tmp_path / "config.yaml")
    async with TestClient(TestServer(server.build())) as client:
        response = await client.post("/api/run/start", json=payload)
        assert response.status == 200
        assert await response.json() == {"running": True}
    kwargs = {"budget_mode": expected_mode} if expected_mode else {}
    manager.start.assert_awaited_once_with("S4", **kwargs)


@pytest.mark.asyncio
@pytest.mark.parametrize("payload", [{"budget_mode": []}, {"budget_mode": "unlimited"}, ["S4"]])
async def test_invalid_budget_request_starts_no_task(tmp_path, payload):
    manager = SimpleNamespace(start=AsyncMock())
    server = StudioServer(SimpleNamespace(run_manager=manager), tmp_path / "config.yaml")
    async with TestClient(TestServer(server.build())) as client:
        response = await client.post("/api/run/start", json=payload)
        assert response.status == 400
    manager.start.assert_not_awaited()


@pytest.mark.asyncio
async def test_studio_engine_poll_skips_task_ledger_and_preserves_default_status(tmp_path):
    engine = SimpleNamespace(describe=lambda: {"loaded": True})
    manager = SimpleNamespace(status=Mock(return_value={"running": False}))
    runtime = Runtime(
        config=VoxkinConfig(), llm=engine, tts=engine, sink=engine, stt=engine, vad=None,
        metrics=SimpleNamespace(aggregate=lambda: {}), hub=None,
        dispatcher=SimpleNamespace(connected=False, bridge_name="", pending_count=0),
        pipeline=SimpleNamespace(cache=None, is_speaking=False), supervisor=None, run_manager=manager,
    )
    server = StudioServer(runtime, tmp_path / "config.yaml")
    async with TestClient(TestServer(server.build())) as client:
        compact = await (await client.get("/api/status?view=studio")).json()
        manager.status.assert_not_called()
        full = await (await client.get("/api/status")).json()
    manager.status.assert_called_once_with()
    assert set(compact) == {"llm", "tts", "audio", "stt", "voice_cache", "speaking"}
    assert all(full[field] == value for field, value in compact.items())
    assert full["run"] == {"running": False}


@pytest.mark.asyncio
async def test_studio_view_retains_display_fields_and_omits_nested_receipts(tmp_path):
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    goal = {
        "goal_id": "stage:s3", "title": "采铁", "status": "waiting", "block_reason": "等待动作回执",
        "pending_action": {"tool": "mine_collect", "status": "unknown", "progress": [{"large": "x" * 8000}]},
        "action_history": [{"result_data": {"large": "y" * 8000}}],
        "recovery": {"reason": "core_restart", "needs_reconcile": True, "baseline_revision": 100},
        "budget": {"mode": "adaptive", "max_actions": 24, "max_elapsed_s": 1800},
        "counters": {"actions": 128}, "progress_watchdog": {"action_limit": 140},
    }
    store.create_task("采铁", "S3", initial_goal_state=goal)
    manager = RunManager(AsyncMock(), dict, AsyncMock(), store)
    server = StudioServer(SimpleNamespace(run_manager=manager), tmp_path / "config.yaml")
    async with TestClient(TestServer(server.build())) as client:
        full = await (await client.get("/api/run/status")).json()
        compact = await (await client.get("/api/run/status?view=studio")).json()
    assert full["goal"] == goal and full["in_flight_action"] == goal["pending_action"]
    assert compact["goal"] == {
        "title": "采铁", "goal_id": "stage:s3", "status": "waiting", "block_reason": "等待动作回执",
        "recovery": {"reason": "core_restart", "needs_reconcile": True},
    }
    assert compact["pending_action"] == {"tool": "mine_collect", "status": "unknown"}
    assert compact["action_budget"] == {"mode": "adaptive", "used": 128, "limit": 140}
    assert compact["budget"] == {"max_elapsed_s": 1800}
    assert "in_flight_action" not in compact and "counters" not in compact
    store.close()


@pytest.mark.asyncio
async def test_invalid_start_json_does_not_launch_default_stage(tmp_path):
    manager = SimpleNamespace(start=AsyncMock())
    server = StudioServer(SimpleNamespace(run_manager=manager), tmp_path / "config.yaml")
    async with TestClient(TestServer(server.build())) as client:
        response = await client.post("/api/run/start", data='{"budget_mode":')
        assert response.status == 400
    manager.start.assert_not_awaited()


@pytest.mark.asyncio
async def test_run_resume_requires_connected_bridge_and_fresh_state(tmp_path: Path) -> None:
    manager = SimpleNamespace(resume=AsyncMock())
    dispatcher = SimpleNamespace(
        state_snapshot=lambda: {},
        state_age_s=lambda: float("inf"),
        connected=False,
    )
    runtime = SimpleNamespace(run_manager=manager, dispatcher=dispatcher)
    client = TestClient(
        TestServer(StudioServer(runtime, tmp_path / "config.yaml").build())
    )
    await client.start_server()
    try:
        response = await client.post("/api/run/resume", json={})
        assert response.status == 409
        manager.resume.assert_not_awaited()
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_run_resume_passes_task_id_after_fresh_bridge_state(tmp_path: Path) -> None:
    manager = SimpleNamespace(
        resume=AsyncMock(return_value={"running": True, "task_id": 17})
    )
    dispatcher = SimpleNamespace(
        state_snapshot=lambda: {"position": {"x": 0, "y": 64, "z": 0}, "alive": True, "health": 20},
        state_age_s=lambda: 1.0,
        connected=True,
    )
    runtime = SimpleNamespace(run_manager=manager, dispatcher=dispatcher)
    client = TestClient(
        TestServer(StudioServer(runtime, tmp_path / "config.yaml").build())
    )
    await client.start_server()
    try:
        response = await client.post("/api/run/resume", json={"task_id": 17})
        assert response.status == 200
        assert await response.json() == {"running": True, "task_id": 17}
        manager.resume.assert_awaited_once_with(17)
    finally:
        await client.close()


@pytest.mark.parametrize("health", [None, "unknown", float("nan")])
@pytest.mark.asyncio
async def test_run_resume_rejects_invalid_health(tmp_path: Path, health: object) -> None:
    manager = SimpleNamespace(resume=AsyncMock())
    dispatcher = SimpleNamespace(
        state_snapshot=lambda: {
            "alive": True,
            "health": health,
            "position": {"x": 0, "y": 64, "z": 0},
        },
        state_age_s=lambda: 1.0,
        connected=True,
    )
    runtime = SimpleNamespace(run_manager=manager, dispatcher=dispatcher)
    client = TestClient(
        TestServer(StudioServer(runtime, tmp_path / "config.yaml").build())
    )
    await client.start_server()
    try:
        response = await client.post("/api/run/resume", json={})
        assert response.status == 409
        manager.resume.assert_not_awaited()
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_run_resume_rejects_dead_player(tmp_path: Path) -> None:
    manager = SimpleNamespace(resume=AsyncMock())
    dispatcher = SimpleNamespace(
        state_snapshot=lambda: {
            "alive": False,
            "health": 0,
            "position": {"x": 0, "y": 64, "z": 0},
        },
        state_age_s=lambda: 1.0,
        connected=True,
    )
    runtime = SimpleNamespace(run_manager=manager, dispatcher=dispatcher)
    client = TestClient(
        TestServer(StudioServer(runtime, tmp_path / "config.yaml").build())
    )
    await client.start_server()
    try:
        response = await client.post("/api/run/resume", json={})
        assert response.status == 409
        manager.resume.assert_not_awaited()
    finally:
        await client.close()
