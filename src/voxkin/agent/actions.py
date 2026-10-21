from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable

from voxkin.bridge.protocol import ActionRequest, ActionResult


class ActionError(RuntimeError):
    pass


Sender = Callable[[dict[str, Any]], Awaitable[None]]


class ActionDispatcher:
    """把工具调用转发给已连接的 Minecraft 桥接，并等待可验证的执行结果。"""

    def __init__(self, default_timeout_s: float = 120.0) -> None:
        self.default_timeout_s = default_timeout_s
        self._sender: Sender | None = None
        self._pending: dict[str, asyncio.Future[ActionResult]] = {}
        self._lock = asyncio.Lock()
        self.bridge_name = ""

    @property
    def connected(self) -> bool:
        return self._sender is not None

    @property
    def pending_count(self) -> int:
        return len(self._pending)

    def attach(self, sender: Sender, bridge_name: str = "") -> None:
        if self._sender is not None:
            raise ActionError("已经有一个 Minecraft 桥接连接，请先断开旧连接")
        self._sender = sender
        self.bridge_name = bridge_name

    def detach(self, sender: Sender | None = None) -> None:
        if sender is not None and sender is not self._sender:
            return
        self._sender = None
        self.bridge_name = ""
        for future in self._pending.values():
            if not future.done():
                future.set_exception(ActionError("Minecraft 桥接已断开"))
        self._pending.clear()

    def resolve(self, result: ActionResult) -> None:
        future = self._pending.pop(result.action_id, None)
        if future is None:
            return
        if not future.done():
            future.set_result(result)

    async def dispatch(self, tool: str, arguments: dict[str, Any]) -> str:
        sender = self._sender
        if sender is None:
            raise ActionError("没有已连接的 Minecraft 桥接，无法执行游戏动作")
        request = ActionRequest(tool=tool, arguments=arguments, timeout_s=self.default_timeout_s)
        loop = asyncio.get_running_loop()
        future: asyncio.Future[ActionResult] = loop.create_future()
        self._pending[request.action_id] = future
        try:
            await sender(request.to_message())
            result = await asyncio.wait_for(future, timeout=request.timeout_s)
        except asyncio.TimeoutError as error:
            raise ActionError(f"动作 {tool} 超时未返回结果") from error
        finally:
            self._pending.pop(request.action_id, None)
        if not result.ok:
            raise ActionError(f"动作 {tool} 执行失败: {result.detail}")
        return result.detail
