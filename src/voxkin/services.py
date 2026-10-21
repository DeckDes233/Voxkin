from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from pathlib import Path

import aiohttp


class ServiceError(RuntimeError):
    pass


@dataclass
class ServiceSpec:
    name: str
    command: list[str]
    cwd: str
    health_url: str = ""
    startup_timeout_s: float = 60.0


@dataclass
class ManagedService:
    spec: ServiceSpec
    process: asyncio.subprocess.Process | None = None
    log_path: Path | None = None
    started_at: float | None = None
    last_return_code: int | None = None

    @property
    def running(self) -> bool:
        return self.process is not None and self.process.returncode is None


class ServiceSupervisor:
    """管理外部引擎进程：启动、停止、重启与健康检查。"""

    def __init__(self, log_dir: Path) -> None:
        self.log_dir = Path(log_dir)
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self._services: dict[str, ManagedService] = {}

    def register(self, spec: ServiceSpec) -> None:
        if spec.name in self._services:
            raise ServiceError(f"服务已注册: {spec.name}")
        if not spec.command:
            raise ServiceError(f"服务 {spec.name} 没有启动命令")
        self._services[spec.name] = ManagedService(spec=spec)

    def names(self) -> list[str]:
        return sorted(self._services)

    def get(self, name: str) -> ManagedService:
        if name not in self._services:
            raise ServiceError(f"未注册的服务: {name}")
        return self._services[name]

    async def start(self, name: str) -> dict:
        service = self.get(name)
        if service.running:
            raise ServiceError(f"服务 {name} 已在运行")
        log_path = self.log_dir / f"{name}.log"
        log_file = log_path.open("ab")
        try:
            process = await asyncio.create_subprocess_exec(
                *service.spec.command,
                cwd=service.spec.cwd,
                stdout=log_file,
                stderr=asyncio.subprocess.STDOUT,
            )
        finally:
            log_file.close()
        service.process = process
        service.log_path = log_path
        service.started_at = time.time()
        return {"name": name, "pid": process.pid, "log": str(log_path)}

    async def stop(self, name: str, timeout_s: float = 8.0) -> dict:
        service = self.get(name)
        process = service.process
        if process is None or process.returncode is not None:
            raise ServiceError(f"服务 {name} 未在运行")
        process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=timeout_s)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
        service.last_return_code = process.returncode
        service.process = None
        return {"name": name, "return_code": process.returncode}

    async def restart(self, name: str) -> dict:
        service = self.get(name)
        if service.running:
            await self.stop(name)
        return await self.start(name)

    async def health(self, name: str) -> dict:
        service = self.get(name)
        url = service.spec.health_url
        if not url:
            return {"reachable": None, "detail": "未配置健康检查地址"}
        timeout = aiohttp.ClientTimeout(total=2)
        try:
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.get(url) as response:
                    return {"reachable": True, "status_code": response.status}
        except aiohttp.ClientConnectorError:
            return {"reachable": False, "detail": "无法连接"}
        except asyncio.TimeoutError:
            return {"reachable": False, "detail": "健康检查超时"}

    async def status(self) -> dict[str, dict]:
        result: dict[str, dict] = {}
        for name, service in self._services.items():
            result[name] = {
                "running": service.running,
                "pid": service.process.pid if service.running else None,
                "started_at": service.started_at,
                "last_return_code": service.last_return_code,
                "health_url": service.spec.health_url,
                "health": await self.health(name),
            }
        return result

    async def close(self) -> None:
        for name, service in self._services.items():
            if service.running:
                await self.stop(name)
