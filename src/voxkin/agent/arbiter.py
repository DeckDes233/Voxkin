from __future__ import annotations

import asyncio
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Protocol

from voxkin.agent.actions import ActionDispatcher, ActionError
from voxkin.agent.skills import find_skill
from voxkin.bridge.protocol import ActionResult

# 优先级数值越小越优先，与 docs/plans/VOICE_ACTION_LATENCY_PLAN.md 8.1 节一致。
PRIORITY_SAFETY = 0
PRIORITY_STOP = 1
PRIORITY_PLAYER = 2
PRIORITY_TASK = 3
PRIORITY_AUTONOMOUS = 4
PRIORITY_REPORT = 5

# 技能类型到默认优先级。type 来自技能清单，清单是唯一事实来源。
TYPE_PRIORITY = {
    "sense": PRIORITY_REPORT,
    "voice": PRIORITY_REPORT,
    "act": PRIORITY_TASK,
    "path": PRIORITY_TASK,
    "wait": PRIORITY_TASK,
    "plan": PRIORITY_TASK,
}

# 会修改世界的技能类型：同一时刻只允许一个在跑。
WORLD_TYPES = ("act", "path")

# 停止类技能固定最高优先级，不受来源影响。
STOP_SKILLS = ("stop",)


def priority_for(tool: str, origin: str = "llm") -> int:
    """算动作优先级。停止最高，反射次之，玩家指令再次，自主行为最低。"""
    if tool in STOP_SKILLS:
        return PRIORITY_STOP
    if origin == "reflex":
        return PRIORITY_SAFETY
    if origin in ("fast_path", "player"):
        return PRIORITY_PLAYER
    if origin == "autonomous":
        return PRIORITY_AUTONOMOUS
    skill = find_skill(tool)
    skill_type = str(skill.get("type") or "") if skill else ""
    return TYPE_PRIORITY.get(skill_type, PRIORITY_TASK)


def is_world_action(tool: str) -> bool:
    """会不会改世界。清单里查不到的技能按会改世界处理，宁可排队也不要并发写世界。"""
    skill = find_skill(tool)
    if skill is None:
        return True
    return str(skill.get("type")) in WORLD_TYPES


@dataclass
class ActionTicket:
    """一次动作请求。action_id 在提交前就定下来，取消和结果路由都靠它。"""

    tool: str
    arguments: dict[str, Any] = field(default_factory=dict)
    action_id: str = ""
    skill_id: str = ""
    turn_id: str = ""
    origin: str = "llm"
    priority: int = PRIORITY_TASK
    cancellable: bool = True
    preemptible: bool = True
    world_mutating: bool = False
    timeout_s: float = 0.0
    epoch: int = 0
    submitted_at: float = field(default_factory=time.monotonic)

    def describe(self) -> dict[str, Any]:
        return {
            "action_id": self.action_id,
            "tool": self.tool,
            "skill_id": self.skill_id,
            "turn_id": self.turn_id,
            "origin": self.origin,
            "priority": self.priority,
            "cancellable": self.cancellable,
            "world_mutating": self.world_mutating,
        }


class ActionController(Protocol):
    """管线只认这个接口，换实现不影响语音回合。"""

    async def submit(self, ticket: ActionTicket) -> ActionResult: ...

    async def cancel_all(self, reason: str) -> list[str]: ...

    async def wait_cancelled(
        self, action_ids: list[str], timeout_s: float = 5.0
    ) -> bool: ...

    def status(self) -> dict[str, Any]: ...


def cancelled_error(ticket: ActionTicket, reason: str) -> ActionError:
    return ActionError(f"动作 {ticket.tool} 已被取消：{reason}", status="cancelled")


class ActionArbiter:
    """动作仲裁器：优先级、排队、当前动作、取消纪元与结果路由。

    仲裁器只管「谁先跑、谁能抢、取消怎么落地」；
    真正执行动作的是桥接，仲裁器通过 ActionDispatcher 与它说话。
    """

    def __init__(
        self,
        dispatcher: ActionDispatcher,
        on_event: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
    ) -> None:
        self.dispatcher = dispatcher
        self.on_event = on_event
        self._cond = asyncio.Condition()
        self._tickets: dict[str, ActionTicket] = {}
        self._waiting: list[ActionTicket] = []
        self._current: ActionTicket | None = None
        self._cancelled: dict[str, str] = {}
        self._done: dict[str, asyncio.Event] = {}
        self._epoch = 0
        self._history: deque[dict[str, Any]] = deque(maxlen=50)

    @property
    def epoch(self) -> int:
        """取消纪元。任何取消都会让它加一，旧规划据此判断自己已经过期。"""
        return self._epoch

    def _prepare(self, ticket: ActionTicket) -> None:
        if not ticket.action_id:
            ticket.action_id = uuid.uuid4().hex[:10]
        ticket.skill_id = ticket.skill_id or ticket.tool
        skill = find_skill(ticket.tool)
        if skill is not None:
            ticket.cancellable = bool(skill.get("cancellable"))
            # 不可取消的动作也不可被抢占，否则会留下写了一半的世界。
            ticket.preemptible = ticket.cancellable
        ticket.priority = priority_for(ticket.tool, ticket.origin)
        ticket.world_mutating = is_world_action(ticket.tool)
        ticket.epoch = self._epoch

    async def submit(self, ticket: ActionTicket) -> ActionResult:
        """提交一个动作并等结果。被取消时抛 ActionError(status='cancelled')。"""
        self._prepare(ticket)
        preempt: ActionTicket | None = None
        async with self._cond:
            self._tickets[ticket.action_id] = ticket
            self._history.append({"event": "submitted", **ticket.describe()})
            if ticket.world_mutating:
                self._waiting.append(ticket)
                self._waiting.sort(key=lambda item: (item.priority, item.submitted_at))
                preempt = self._preempt_target(ticket)
        if preempt is not None:
            await self._cancel_ticket(preempt, "被更高优先级动作抢占")
        result: ActionResult | None = None
        done = asyncio.Event()
        self._done[ticket.action_id] = done
        try:
            await self._acquire(ticket)
            if ticket.action_id in self._cancelled:
                raise cancelled_error(ticket, self._cancelled[ticket.action_id])
            result = await self.dispatcher.dispatch_result(
                ticket.tool,
                ticket.arguments,
                ticket.timeout_s or None,
                action_id=ticket.action_id,
                priority=ticket.priority,
            )
        finally:
            await self._release(ticket)
            async with self._cond:
                self._tickets.pop(ticket.action_id, None)
            done.set()
        async with self._cond:
            self._history.append(
                {"event": "finished", "action_id": ticket.action_id, "status": result.status}
            )
        return result

    async def _acquire(self, ticket: ActionTicket) -> None:
        """会改世界的动作排队执行，只读动作直接放行。"""
        if not ticket.world_mutating:
            return
        async with self._cond:
            while True:
                if ticket.action_id in self._cancelled:
                    return
                if self._current is None and (
                    not self._waiting or self._waiting[0] is ticket
                ):
                    if ticket in self._waiting:
                        self._waiting.remove(ticket)
                    self._current = ticket
                    return
                await self._cond.wait()

    async def _release(self, ticket: ActionTicket) -> None:
        if not ticket.world_mutating:
            return
        async with self._cond:
            if self._current is ticket:
                self._current = None
            if ticket in self._waiting:
                self._waiting.remove(ticket)
            self._cond.notify_all()

    def _preempt_target(self, ticket: ActionTicket) -> ActionTicket | None:
        """新动作优先级更高时返回要抢占的目标。安全反射与停止可以抢占任何动作。"""
        current = self._current
        if current is None:
            return None
        if ticket.priority <= PRIORITY_STOP:
            return current
        if not current.preemptible:
            return None
        if current.priority <= ticket.priority:
            return None
        return current

    async def cancel(self, action_id: str, reason: str = "cancelled") -> bool:
        """按 action_id 取消一个动作。"""
        async with self._cond:
            ticket = self._tickets.get(action_id)
            if ticket is None and action_id not in self._cancelled:
                return False
            self._cancelled[action_id] = reason
            self._epoch += 1
            self._cond.notify_all()
        await self.dispatcher.cancel(action_id, reason, ticket.turn_id if ticket else "")
        await self._emit(
            {
                "type": "action_cancelled",
                "action_id": action_id,
                "tool": ticket.tool if ticket else "",
                "reason": reason,
            }
        )
        return True

    async def cancel_all(self, reason: str = "cancelled") -> list[str]:
        """取消在途与排队的全部动作，返回被取消的 action_id 列表。"""
        async with self._cond:
            ids = list(self._tickets)
            for action_id in ids:
                self._cancelled[action_id] = reason
            self._epoch += 1
            self._cond.notify_all()
        await self.dispatcher.cancel_all(reason)
        await self._emit({"type": "actions_cancelled", "action_ids": ids, "reason": reason})
        return ids

    def is_cancelled(self, action_id: str) -> bool:
        return action_id in self._cancelled

    async def wait_cancelled(
        self, action_ids: list[str], timeout_s: float = 5.0
    ) -> bool:
        """等被取消的动作回报结果。返回是否都在时间内回报了。

        收到回执是「停止生效」，超时是「停止没有确认」，两条结果不能混成一条。
        """
        if not action_ids:
            return True
        waiters = []
        for action_id in action_ids:
            event = self._done.get(action_id)
            if event is not None:
                waiters.append(event.wait())
        if not waiters:
            return True
        try:
            await asyncio.wait_for(asyncio.gather(*waiters), timeout=timeout_s)
        except asyncio.TimeoutError:
            return False
        return True

    def status(self) -> dict[str, Any]:
        return {
            "current": self._current.describe() if self._current else None,
            "waiting": [ticket.describe() for ticket in self._waiting],
            "tracked": len(self._tickets),
            "epoch": self._epoch,
            "cancelled": len(self._cancelled),
        }

    async def _cancel_ticket(self, ticket: ActionTicket, reason: str) -> None:
        async with self._cond:
            self._cancelled[ticket.action_id] = reason
            self._epoch += 1
            self._cond.notify_all()
        await self.dispatcher.cancel(ticket.action_id, reason, ticket.turn_id)
        await self._emit(
            {
                "type": "action_cancelled",
                "action_id": ticket.action_id,
                "tool": ticket.tool,
                "reason": reason,
            }
        )

    async def _emit(self, payload: dict[str, Any]) -> None:
        if self.on_event is not None:
            await self.on_event(payload)
