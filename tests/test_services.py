import asyncio
import socket
import sys
from pathlib import Path

import pytest

from voxkin.services import ManagedService, ServiceError, ServiceSpec, ServiceSupervisor


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def http_spec(tmp_path: Path, port: int) -> ServiceSpec:
    return ServiceSpec(
        name="http",
        command=[sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1"],
        cwd=str(tmp_path),
        health_url=f"http://127.0.0.1:{port}/",
    )


async def wait_healthy(supervisor: ServiceSupervisor, name: str, timeout: float = 10.0) -> bool:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        health = await supervisor.health(name)
        if health.get("reachable"):
            return True
        await asyncio.sleep(0.2)
    return False


async def test_start_health_stop(tmp_path):
    supervisor = ServiceSupervisor(tmp_path / "logs")
    port = free_port()
    supervisor.register(http_spec(tmp_path, port))
    try:
        started = await supervisor.start("http")
        assert started["pid"] > 0
        assert await wait_healthy(supervisor, "http")
        status = await supervisor.status()
        assert status["http"]["running"] is True
        assert status["http"]["health"]["status_code"] == 200
    finally:
        stopped = await supervisor.stop("http")
    assert stopped["return_code"] is not None
    assert (tmp_path / "logs" / "http.log").exists()


async def test_start_twice_is_rejected(tmp_path):
    supervisor = ServiceSupervisor(tmp_path / "logs")
    port = free_port()
    supervisor.register(http_spec(tmp_path, port))
    try:
        await supervisor.start("http")
        with pytest.raises(ServiceError, match="已在运行"):
            await supervisor.start("http")
    finally:
        await supervisor.stop("http")


async def test_stop_when_not_running_is_rejected(tmp_path):
    supervisor = ServiceSupervisor(tmp_path / "logs")
    supervisor.register(http_spec(tmp_path, free_port()))
    with pytest.raises(ServiceError, match="未在运行"):
        await supervisor.stop("http")


async def test_unknown_service(tmp_path):
    supervisor = ServiceSupervisor(tmp_path / "logs")
    with pytest.raises(ServiceError, match="未注册"):
        await supervisor.start("nope")
