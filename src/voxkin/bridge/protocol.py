from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any

ACTION_STATUSES = (
    "accepted",
    "running",
    "succeeded",
    "partial",
    "failed",
    "cancelled",
    "disconnected",
    "blocked",
    "dead",
    "preempted",
    "unknown",
)

SUCCESS_STATUSES = ("succeeded", "partial")

# 取消范围：只取消一个动作，或取消全部（含正在跑的与排队的）。
CANCEL_SCOPES = ("action", "all")

# 动作进度阶段。progress 消息是可选能力，桥接没实现就不发，Core 不假设它存在。
PROGRESS_PHASES = ("starting", "running", "finishing")


@dataclass
class ActionRequest:
    tool: str
    arguments: dict[str, Any]
    timeout_s: float = 120.0
    skill_id: str = ""
    priority: int = 3
    session_id: str = ""
    state_revision: int | None = None
    goal_id: str = ""
    intent_id: str = ""
    origin: str = "player"
    action_id: str = field(default_factory=lambda: uuid.uuid4().hex[:10])

    def to_message(self) -> dict[str, Any]:
        return {
            "type": "action",
            "action_id": self.action_id,
            "tool": self.tool,
            "skill_id": self.skill_id or self.tool,
            "arguments": self.arguments,
            "timeout_s": self.timeout_s,
            "priority": self.priority,
            "session_id": self.session_id,
            "state_revision": self.state_revision,
            "goal_id": self.goal_id,
            "intent_id": self.intent_id,
            "origin": self.origin,
        }


@dataclass(frozen=True)
class ActionStatusResult:
    action_id: str
    status: str = "unknown"
    detail: str = ""
    data: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_message(cls, message: dict[str, Any]) -> "ActionStatusResult":
        if message.get("type") != "action_status_result":
            raise ValueError(f"不是 action_status_result 消息: {message.get('type')}")
        action_id = str(message.get("action_id") or "")
        if not action_id:
            raise ValueError("action_status_result 缺少 action_id")
        allowed = set(ACTION_STATUSES) | {"queued", "cancelling", "preempting", "unknown"}
        status = str(message.get("status") or "unknown")
        if status not in allowed:
            status = "unknown"
        data = message.get("data")
        return cls(
            action_id=action_id,
            status=status,
            detail=str(message.get("detail") or ""),
            data=dict(data) if isinstance(data, dict) else {},
        )


@dataclass
class ActionCancel:
    """取消请求。scope 为 action 时只针对一个 action_id，为 all 时清空全部。"""

    action_id: str = ""
    reason: str = ""
    turn_id: str = ""
    scope: str = "action"
    interrupt_status: str = "cancelled"

    def to_message(self) -> dict[str, Any]:
        return {
            "type": "action_cancel",
            "action_id": self.action_id,
            "reason": self.reason,
            "turn_id": self.turn_id,
            "scope": self.scope,
            "interrupt_status": self.interrupt_status,
        }

    @classmethod
    def from_message(cls, message: dict[str, Any]) -> "ActionCancel":
        if message.get("type") != "action_cancel":
            raise ValueError(f"不是 action_cancel 消息: {message.get('type')}")
        scope = str(message.get("scope") or "action")
        if scope not in CANCEL_SCOPES:
            scope = "action"
        return cls(
            action_id=str(message.get("action_id") or ""),
            reason=str(message.get("reason") or ""),
            turn_id=str(message.get("turn_id") or ""),
            scope=scope,
            interrupt_status=(
                str(message.get("interrupt_status"))
                if message.get("interrupt_status") in ("cancelled", "preempted")
                else "cancelled"
            ),
        )


@dataclass
class ActionProgress:
    """长动作的进度回报。桥接不发就是没有，不许 Core 自己编进度。"""

    action_id: str
    phase: str = ""
    detail: str = ""
    progress: float = 0.0
    skill_id: str = ""
    session_id: str = ""
    state_revision: int | None = None
    executor_epoch: int | None = None
    data: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_message(cls, message: dict[str, Any]) -> "ActionProgress":
        if message.get("type") != "action_progress":
            raise ValueError(f"不是 action_progress 消息: {message.get('type')}")
        action_id = str(message.get("action_id") or "")
        if not action_id:
            raise ValueError("action_progress 缺少 action_id")
        try:
            progress = float(message.get("progress") or 0.0)
        except (TypeError, ValueError):
            progress = 0.0
        raw_revision = message.get("state_revision", message.get("revision"))
        raw_epoch = message.get("executor_epoch")
        try:
            state_revision = int(raw_revision) if raw_revision is not None else None
        except (TypeError, ValueError):
            state_revision = None
        try:
            executor_epoch = int(raw_epoch) if raw_epoch is not None else None
        except (TypeError, ValueError):
            executor_epoch = None
        raw_data = message.get("data")
        return cls(
            action_id=action_id,
            phase=str(message.get("phase") or ""),
            detail=str(message.get("detail") or ""),
            progress=max(0.0, min(1.0, progress)),
            skill_id=str(message.get("skill_id") or ""),
            session_id=str(message.get("session_id") or ""),
            state_revision=state_revision,
            executor_epoch=executor_epoch,
            data=dict(raw_data) if isinstance(raw_data, dict) else {},
        )


@dataclass
class ActionResult:
    action_id: str
    ok: bool
    detail: str = ""
    status: str = ""
    skill_id: str = ""
    data: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_message(cls, message: dict[str, Any]) -> "ActionResult":
        if message.get("type") != "action_result":
            raise ValueError(f"不是 action_result 消息: {message.get('type')}")
        action_id = message.get("action_id")
        if not action_id:
            raise ValueError("action_result 缺少 action_id")
        raw_status = str(message.get("status") or "")
        if raw_status in ACTION_STATUSES:
            status = raw_status
            # ok 说的是动作本身有没有报错，status 说的是目标完成到什么程度。
            # 部分完成的动作会同时给出 ok=false 与 status=partial。
            ok = bool(message.get("ok")) if "ok" in message else status in SUCCESS_STATUSES
        else:
            status = "succeeded" if message.get("ok") else "failed"
            ok = bool(message.get("ok"))
        return cls(
            action_id=str(action_id),
            ok=ok,
            detail=str(message.get("detail", "")),
            status=status,
            skill_id=str(message.get("skill_id", "")),
            data=dict(message.get("data") or {}),
        )


def parse_chat(message: dict[str, Any]) -> dict[str, str]:
    if message.get("type") != "chat":
        raise ValueError(f"不是 chat 消息: {message.get('type')}")
    text = str(message.get("text", "")).strip()
    if not text:
        raise ValueError("chat 消息缺少 text")
    return {"text": text, "player": str(message.get("player", "player"))}
