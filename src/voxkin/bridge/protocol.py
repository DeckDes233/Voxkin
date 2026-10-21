from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any


@dataclass
class ActionRequest:
    tool: str
    arguments: dict[str, Any]
    timeout_s: float = 120.0
    action_id: str = field(default_factory=lambda: uuid.uuid4().hex[:10])

    def to_message(self) -> dict[str, Any]:
        return {
            "type": "action",
            "action_id": self.action_id,
            "tool": self.tool,
            "arguments": self.arguments,
            "timeout_s": self.timeout_s,
        }


@dataclass
class ActionResult:
    action_id: str
    ok: bool
    detail: str = ""

    @classmethod
    def from_message(cls, message: dict[str, Any]) -> "ActionResult":
        if message.get("type") != "action_result":
            raise ValueError(f"不是 action_result 消息: {message.get('type')}")
        action_id = message.get("action_id")
        if not action_id:
            raise ValueError("action_result 缺少 action_id")
        return cls(
            action_id=str(action_id),
            ok=bool(message.get("ok")),
            detail=str(message.get("detail", "")),
        )


def parse_chat(message: dict[str, Any]) -> dict[str, str]:
    if message.get("type") != "chat":
        raise ValueError(f"不是 chat 消息: {message.get('type')}")
    text = str(message.get("text", "")).strip()
    if not text:
        raise ValueError("chat 消息缺少 text")
    return {"text": text, "player": str(message.get("player", "player"))}
