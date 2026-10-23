from __future__ import annotations

import asyncio
import time
from dataclasses import replace
from typing import Any, Awaitable, Callable

from voxkin.agent.skills import find_skill, parameter_bounds
from voxkin.agent.tools import BRIDGE_ONLY_SKILLS
from voxkin.bridge.protocol import ActionCancel, ActionProgress, ActionRequest, ActionResult

# 桥接把 timeout_s 夹在 5 到 300 秒之间，Core 侧用同样的范围。
MIN_TIMEOUT_S = 5.0
MAX_TIMEOUT_S = 300.0

# Core 比桥接多等一会儿，让桥接自己的超时回复先落地，状态才不丢。
TIMEOUT_GRACE_S = 5.0

# 发起取消后，等桥接回执的窗口。窗口内收到回执就是「停止回执」，
# 窗口内没有回执就是「取消已发出但桥接没确认」，两者和「超时」是三条不同的结果。
CANCEL_GRACE_S = 2.0

# 状态关键词与桥接 statusForError 保持一致，判断顺序也一样。
# 「只放进」是箱子存物资时的说法，桥接那边总是和「还差」一起出现，两边结论相同。
PARTIAL_KEYWORDS = ("还差", "只拿到", "只放进")
DISCONNECTED_KEYWORDS = ("断开", "连接结束")
CANCELLED_KEYWORDS = ("打断", "取消")
BLOCKED_KEYWORDS = ("没有", "材料不够")


class ActionError(RuntimeError):
    """动作没有成功完成；status 说明失败属于哪一类。"""

    def __init__(self, message: str, status: str = "failed") -> None:
        super().__init__(message)
        self.status = status


Sender = Callable[[dict[str, Any]], Awaitable[None]]


def status_for_detail(detail: str) -> str:
    """按桥接 statusForError 的同一套关键词把结果文本映射成状态。"""
    text = str(detail or "")
    if any(word in text for word in PARTIAL_KEYWORDS):
        return "partial"
    if any(word in text for word in DISCONNECTED_KEYWORDS):
        return "disconnected"
    if any(word in text for word in CANCELLED_KEYWORDS):
        return "cancelled"
    if any(word in text for word in BLOCKED_KEYWORDS):
        return "blocked"
    return "failed"


def _grace_s(limit: float) -> float:
    """Core 比桥接多等的余量：短动作少等，长动作多等一点。"""
    return min(TIMEOUT_GRACE_S, max(0.25, limit * 0.05))


def _coerce(parameter: dict[str, Any], value: Any) -> Any:
    """把模型给的字符串数字转成数值，并按清单范围夹紧。"""
    declared = str(parameter.get("type") or "string")
    if isinstance(value, str) and declared in ("number", "integer"):
        try:
            value = int(value) if declared == "integer" else float(value)
        except ValueError:
            return value
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return value
    minimum, maximum = parameter_bounds(parameter)
    if minimum is not None:
        value = max(value, minimum)
    if maximum is not None:
        value = min(value, maximum)
    return value


class ActionDispatcher:
    """把工具调用转发给已连接的 Minecraft 桥接，并等待可验证的执行结果。"""

    def __init__(self, default_timeout_s: float = 120.0) -> None:
        self.default_timeout_s = default_timeout_s
        self._sender: Sender | None = None
        self._pending: dict[str, asyncio.Future[ActionResult]] = {}
        self._cancel_events: dict[str, asyncio.Event] = {}
        self._progress: dict[str, dict[str, Any]] = {}
        self._lock = asyncio.Lock()
        self.bridge_name = ""
        self.latest_state: dict[str, Any] = {}
        self._state_at = 0.0

    @property
    def connected(self) -> bool:
        return self._sender is not None

    @property
    def pending_count(self) -> int:
        return len(self._pending)

    def update_state(self, data: dict[str, Any]) -> None:
        self.latest_state = data or {}
        self._state_at = time.monotonic()

    def state_snapshot(self, max_age_s: float = 30.0) -> dict[str, Any]:
        if not self.latest_state:
            return {}
        if time.monotonic() - self._state_at > max_age_s:
            return {}
        return self.latest_state

    def state_age_s(self) -> float:
        """最近一帧状态距今的秒数；没有状态时返回很大值。"""
        if not self.latest_state:
            return float("inf")
        return round(time.monotonic() - self._state_at, 2)

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
        self.latest_state = {}
        self._state_at = 0.0
        for future in self._pending.values():
            if not future.done():
                # 断桥是基础设施故障，不是用户取消；保留独立状态供上层决定重连与续跑。
                future.set_exception(
                    ActionError("Minecraft 桥接已断开", status="disconnected")
                )
        self._pending.clear()

    def resolve(self, result: ActionResult) -> None:
        future = self._pending.pop(result.action_id, None)
        if future is None:
            return
        if not future.done():
            future.set_result(result)

    def fail_pending(self, status: str, detail: str) -> list[str]:
        action_ids = list(self._pending)
        for future in self._pending.values():
            if not future.done():
                future.set_exception(ActionError(detail, status=status))
        self._pending.clear()
        return action_ids

    def on_progress(self, progress: ActionProgress) -> None:
        """记录桥接报上来的动作进度。桥接没报就是没有进度，不许自己编。"""
        self._progress[progress.action_id] = {
            "phase": progress.phase,
            "detail": progress.detail,
            "progress": progress.progress,
            "at": time.monotonic(),
        }

    def progress_snapshot(self, action_id: str) -> dict[str, Any]:
        return dict(self._progress.get(action_id) or {})

    async def cancel(
        self, action_id: str, reason: str = "cancelled", turn_id: str = ""
    ) -> bool:
        """按 action_id 请求桥接取消动作。返回是否真的把取消请求发出去了。"""
        sender = self._sender
        if sender is None or not action_id:
            return False
        event = self._cancel_events.get(action_id)
        if event is not None:
            event.set()
        payload = ActionCancel(
            action_id=action_id, reason=reason, turn_id=turn_id, scope="action"
        )
        try:
            await sender(payload.to_message())
        except Exception:
            return False
        return True

    async def _cancel_interrupted_action(self, action_id: str, reason: str) -> None:
        try:
            await asyncio.wait_for(
                self.cancel(action_id, reason), timeout=CANCEL_GRACE_S
            )
        except asyncio.TimeoutError:
            return

    async def cancel_all(self, reason: str = "cancelled", turn_id: str = "") -> list[str]:
        """取消所有在途动作并清空队列，返回被取消的 action_id 列表。"""
        ids = list(self._cancel_events)
        for event in self._cancel_events.values():
            event.set()
        sender = self._sender
        if sender is None:
            return ids
        payload = ActionCancel(action_id="", reason=reason, turn_id=turn_id, scope="all")
        try:
            await sender(payload.to_message())
        except Exception:
            return ids
        return ids

    def timeout_for(self, tool: str) -> float:
        """技能超时按清单来，清单里没有的技能才用默认值。

        清单里的 timeout_s 最大到 300 秒（批量熔炼、末影龙战），
        Core 不能再用 120 秒的默认值把长任务判成失败。
        """
        skill = find_skill(tool)
        declared = float(skill.get("timeout_s") or 0) if skill else 0.0
        if declared <= 0:
            return self.default_timeout_s
        return min(max(declared, MIN_TIMEOUT_S), MAX_TIMEOUT_S)

    def check_arguments(self, tool: str, arguments: dict[str, Any]) -> dict[str, Any]:
        """按技能清单校验参数，返回能直接发给桥接的参数。

        工具名与参数类型都按清单核对，不在这里维护任何硬编码名单。
        必填参数缺了不在 Core 侧拦：桥接自己会检查并说清缺什么，
        Core 抢着报错只会把桥接那句更准的话挡掉。
        """
        if tool in BRIDGE_ONLY_SKILLS:
            raise ActionError(
                f"技能 {tool} 只在游戏内生效，Core 不转发", status="blocked"
            )
        skill = find_skill(tool)
        if skill is None:
            raise ActionError(f"未知技能 {tool}", status="blocked")
        parameters = {
            str(item.get("name")): item for item in (skill.get("parameters") or [])
        }
        # 清单没写的参数原样透传：桥接可能有自己的额外开关。
        return {
            key: value if parameters.get(key) is None else _coerce(parameters[key], value)
            for key, value in arguments.items()
        }

    async def dispatch_result(
        self,
        tool: str,
        arguments: dict[str, Any],
        timeout_s: float | None = None,
        action_id: str = "",
        priority: int = 3,
    ) -> ActionResult:
        """执行一个动作并返回带结构化状态的结果。"""
        sender = self._sender
        if sender is None:
            raise ActionError(
                "没有已连接的 Minecraft 桥接，无法执行游戏动作", status="blocked"
            )
        payload = self.check_arguments(tool, arguments)
        limit = float(timeout_s) if timeout_s else self.timeout_for(tool)
        request = ActionRequest(tool=tool, arguments=payload, timeout_s=limit, priority=priority)
        if action_id:
            request.action_id = action_id
        loop = asyncio.get_running_loop()
        future: asyncio.Future[ActionResult] = loop.create_future()
        cancel_event = asyncio.Event()
        self._pending[request.action_id] = future
        self._cancel_events[request.action_id] = cancel_event
        try:
            await sender(request.to_message())
            result = await self._await_result(request.action_id, future, cancel_event, limit)
        except asyncio.CancelledError:
            await self._cancel_interrupted_action(
                request.action_id, "Core 动作等待被取消"
            )
            raise
        except asyncio.TimeoutError as error:
            await self._cancel_interrupted_action(
                request.action_id, "Core 等待动作结果超时"
            )
            raise ActionError(
                f"动作 {tool} 超时未返回结果（清单预算 {limit:.0f} 秒）", status="failed"
            ) from error
        finally:
            if not future.done():
                future.cancel()
            self._pending.pop(request.action_id, None)
            self._cancel_events.pop(request.action_id, None)
        result = self._refine_status(result)
        # partial 是做了一部分，不是失败：交回调用方，由它决定怎么接着做。
        if not result.ok and result.status != "partial":
            raise ActionError(
                f"动作 {tool} 执行失败: {result.detail}", status=result.status
            )
        return result

    async def _await_result(
        self,
        action_id: str,
        future: asyncio.Future[ActionResult],
        cancel_event: asyncio.Event,
        limit_s: float,
    ) -> ActionResult:
        """等桥接回执。期间收到取消请求时先给桥接一点回执时间，再按取消收场。"""
        waiter = asyncio.ensure_future(cancel_event.wait())
        try:
            done, _ = await asyncio.wait(
                {future, waiter},
                timeout=limit_s + _grace_s(limit_s),
                return_when=asyncio.FIRST_COMPLETED,
            )
        finally:
            waiter.cancel()
        if future in done:
            return future.result()
        if cancel_event.is_set():
            # 取消已经发起：等桥接的回执，窗口内没有回执就按本地取消收场。
            done, _ = await asyncio.wait({future}, timeout=CANCEL_GRACE_S)
            if future in done:
                return future.result()
            raise ActionError(f"动作 {action_id} 已取消，桥接没有回执", status="cancelled")
        raise asyncio.TimeoutError()

    async def dispatch(
        self, tool: str, arguments: dict[str, Any], timeout_s: float | None = None
    ) -> str:
        result = await self.dispatch_result(tool, arguments, timeout_s)
        if result.status == "partial":
            return f"{result.detail}（只完成一部分）"
        return result.detail

    @staticmethod
    def _refine_status(result: ActionResult) -> ActionResult:
        """桥接没给明确状态时，用结果文本补出状态，结论与桥接一致。"""
        if result.ok:
            return result
        if result.status in ("partial", "cancelled", "disconnected", "blocked", "dead"):
            return result
        return replace(result, status=status_for_detail(result.detail))
