from __future__ import annotations

import asyncio
import inspect
import math
import time
import uuid
from collections import deque
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Protocol

from voxkin.agent.actions import ActionDispatcher, ActionError
from voxkin.agent.skills import find_skill
from voxkin.bridge.protocol import ActionResult

PRIORITY_SAFETY = 0
PRIORITY_STOP = 1
PRIORITY_PLAYER = 2
PRIORITY_TASK = 3
PRIORITY_AUTONOMOUS = 4
PRIORITY_REPORT = 5

TYPE_PRIORITY = {
    "sense": PRIORITY_REPORT,
    "voice": PRIORITY_REPORT,
    "act": PRIORITY_TASK,
    "path": PRIORITY_TASK,
    "wait": PRIORITY_TASK,
    "plan": PRIORITY_TASK,
}
WORLD_TYPES = ("act", "path")
STOP_SKILLS = ("stop",)


def priority_for(tool: str, origin: str = "llm") -> int:
    if tool in STOP_SKILLS:
        return PRIORITY_STOP
    if origin == "reflex":
        return PRIORITY_SAFETY
    if origin in ("fast_path", "player", "voice"):
        return PRIORITY_PLAYER
    if origin in ("autonomous", "goal"):
        return PRIORITY_AUTONOMOUS
    skill = find_skill(tool)
    skill_type = str(skill.get("type") or "") if skill else ""
    return TYPE_PRIORITY.get(skill_type, PRIORITY_TASK)


def is_world_action(tool: str) -> bool:
    skill = find_skill(tool)
    if skill is None:
        return True
    return str(skill.get("type")) in WORLD_TYPES


@dataclass
class ActionTicket:
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
    goal_id: str = ""
    intent_id: str = ""
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
            "goal_id": self.goal_id,
            "intent_id": self.intent_id,
        }


class ActionController(Protocol):
    async def submit(self, ticket: ActionTicket) -> ActionResult: ...

    async def cancel_all(self, reason: str) -> list[str]: ...

    async def wait_cancelled(self, action_ids: list[str], timeout_s: float = 5.0) -> bool: ...

    def status(self) -> dict[str, Any]: ...


def cancelled_error(ticket: ActionTicket, reason: str, status: str = "cancelled") -> ActionError:
    return ActionError(f"动作 {ticket.tool} 已被中断：{reason}", status=status, action_id=ticket.action_id)


class ActionArbiter:
    """Core 准入并关联请求；排队、执行和抢占由 Bridge 的 Executor 独占管理。"""

    def __init__(
        self,
        dispatcher: ActionDispatcher,
        on_event: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
    ) -> None:
        self.dispatcher = dispatcher
        self.on_event = on_event
        self._tickets: dict[str, ActionTicket] = {}
        self._done: dict[str, asyncio.Event] = {}
        self._history: deque[dict[str, Any]] = deque(maxlen=50)
        self._receipt_events: dict[str, asyncio.Event] = {}
        self._confirmed_receipts: set[str] = set()
        self._receipt_order: deque[str] = deque()
        self._epoch = 0

    @property
    def epoch(self) -> int:
        return self._epoch

    def _prepare(self, ticket: ActionTicket) -> None:
        if not ticket.action_id:
            ticket.action_id = uuid.uuid4().hex[:10]
        ticket.skill_id = ticket.skill_id or ticket.tool
        skill = find_skill(ticket.tool)
        if skill is not None:
            ticket.cancellable = bool(skill.get("cancellable"))
            ticket.preemptible = ticket.cancellable
        ticket.priority = priority_for(ticket.tool, ticket.origin)
        ticket.world_mutating = is_world_action(ticket.tool)
        state = self.dispatcher.state_snapshot()
        executor = state.get("executor") or {}
        try:
            self._epoch = int(executor.get("epoch", self._epoch))
        except (TypeError, ValueError):
            pass
        ticket.epoch = self._epoch

    def _validate_admission(self, ticket: ActionTicket) -> None:
        if not ticket.world_mutating:
            return
        if not self.dispatcher.connected:
            raise ActionError("Minecraft bridge is disconnected", status="disconnected")
        state = self.dispatcher.state_snapshot()
        if not state:
            raise ActionError("Minecraft world state is unavailable or stale", status="blocked")
        # 新协议下 ready 是硬准入条件；旧测试/客户端没有该字段时沿用基本校验。
        if ("session_id" in state or "ready" in state) and state.get("ready") is not True:
            raise ActionError("Minecraft bridge is not ready for ordinary actions", status="blocked")
        if state.get("alive") is False:
            raise ActionError("Minecraft 角色已死亡，动作未派发", status="dead")
        position = state.get("position") or {}
        if state.get("alive") is not True or not all(
            isinstance(position.get(axis), (int, float))
            and math.isfinite(float(position[axis]))
            for axis in "xyz"
        ):
            raise ActionError("Minecraft world state is incomplete", status="blocked")
        try:
            health = float(state.get("health"))
            if not math.isfinite(health):
                raise ValueError("non-finite health")
            if health <= 0:
                raise ActionError("Minecraft 角色已死亡，动作未派发", status="dead")
        except (TypeError, ValueError):
            raise ActionError("Minecraft 生命值状态无效，动作未派发", status="blocked")

    async def submit(self, ticket: ActionTicket) -> ActionResult:
        self._prepare(ticket)
        self._validate_admission(ticket)
        self._tickets[ticket.action_id] = ticket
        done = asyncio.Event()
        self._done[ticket.action_id] = done
        receipt = asyncio.Event()
        self._receipt_events[ticket.action_id] = receipt
        self._confirmed_receipts.discard(ticket.action_id)
        self._receipt_order.append(ticket.action_id)
        self._trim_receipts()
        self._history.append({"event": "submitted", **ticket.describe()})
        try:
            dispatch = self.dispatcher.dispatch_result
            try:
                parameters = inspect.signature(dispatch).parameters
            except (TypeError, ValueError):
                parameters = {}
            accepts_kwargs = any(
                item.kind == inspect.Parameter.VAR_KEYWORD for item in parameters.values()
            )
            association = {
                "action_id": ticket.action_id,
                "priority": ticket.priority,
                "goal_id": ticket.goal_id,
                "intent_id": ticket.intent_id or ticket.turn_id or ticket.action_id,
                "origin": ticket.origin,
            }
            supported = {
                key: value
                for key, value in association.items()
                if accepts_kwargs or key in parameters
            }
            result = await dispatch(
                ticket.tool,
                ticket.arguments,
                ticket.timeout_s or None,
                **supported,
            )
            if result.status in {
                "succeeded", "partial", "failed", "blocked", "cancelled",
                "preempted", "dead", "disconnected",
            }:
                self._confirm_receipt(ticket.action_id)
            self._history.append(
                {"event": "finished", "action_id": ticket.action_id, "status": result.status}
            )
            return result
        except ActionError as error:
            if error.receipt_confirmed:
                self._confirm_receipt(ticket.action_id)
            self._history.append(
                {"event": "finished", "action_id": ticket.action_id, "status": error.status}
            )
            raise
        finally:
            self._tickets.pop(ticket.action_id, None)
            done.set()
            self._trim_receipts()

    async def cancel(
        self,
        action_id: str,
        reason: str = "cancelled",
        interrupt_status: str = "cancelled",
    ) -> bool:
        ticket = self._tickets.get(action_id)
        if ticket is None:
            return False
        return await self.dispatcher.cancel(
            action_id,
            reason,
            ticket.turn_id,
            interrupt_status=interrupt_status,
        )

    async def cancel_all(self, reason: str = "cancelled") -> list[str]:
        ids = list(self._tickets)
        await self.dispatcher.cancel_all(reason)
        await self._emit({"type": "actions_cancel_requested", "action_ids": ids, "reason": reason})
        return ids

    def is_cancelled(self, action_id: str) -> bool:
        return False

    async def wait_cancelled(self, action_ids: list[str], timeout_s: float = 5.0) -> bool:
        if not action_ids:
            return True
        deadline = time.monotonic() + max(0.0, timeout_s)
        terminal = {
            "succeeded", "partial", "failed", "blocked", "cancelled",
            "preempted", "dead", "disconnected",
        }
        while True:
            unresolved = [action_id for action_id in action_ids if action_id not in self._confirmed_receipts]
            if not unresolved:
                return True
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            # 取消 action_result 若丢失，通过 Bridge action_id 账本核对 terminal receipt。
            for action_id in unresolved:
                if time.monotonic() >= deadline:
                    break
                query_status = getattr(self.dispatcher, "action_status", None)
                if query_status is None:
                    break
                result = await query_status(action_id, timeout_s=min(0.2, max(0.05, deadline - time.monotonic())))
                if result.status in terminal:
                    self._confirm_receipt(action_id)
            if all(action_id in self._confirmed_receipts for action_id in action_ids):
                return True
            await asyncio.sleep(min(0.05, max(0.0, deadline - time.monotonic())))

    def _confirm_receipt(self, action_id: str) -> None:
        self._confirmed_receipts.add(action_id)
        receipt = self._receipt_events.get(action_id)
        if receipt is not None:
            receipt.set()
        self._trim_receipts()

    def _trim_receipts(self) -> None:
        attempts = len(self._receipt_order)
        while len(self._receipt_order) > 100 and attempts > 0:
            expired = self._receipt_order.popleft()
            attempts -= 1
            if expired in self._tickets:
                self._receipt_order.append(expired)
                continue
            self._receipt_events.pop(expired, None)
            self._done.pop(expired, None)
            self._confirmed_receipts.discard(expired)

    def status(self) -> dict[str, Any]:
        state = self.dispatcher.state_snapshot()
        executor = state.get("executor") or {}
        return {
            "current": executor.get("active_action_id"),
            "waiting": [],
            "tracked": len(self._tickets),
            "epoch": executor.get("epoch", self._epoch),
            "safety_active": bool(executor.get("safety_active")),
            "actions": [ticket.describe() for ticket in self._tickets.values()],
        }

    async def _emit(self, payload: dict[str, Any]) -> None:
        if self.on_event is not None:
            await self.on_event(payload)
