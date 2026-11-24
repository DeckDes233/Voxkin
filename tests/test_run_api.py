from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from aiohttp.test_utils import TestClient, TestServer

from voxkin.server import StudioServer


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
