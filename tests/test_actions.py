import asyncio

import pytest

from voxkin.agent.actions import ActionDispatcher, ActionError
from voxkin.bridge.protocol import ActionResult, parse_chat


async def test_dispatch_waits_for_result():
    dispatcher = ActionDispatcher(default_timeout_s=5)
    sent: list[dict] = []

    async def sender(message: dict) -> None:
        sent.append(message)

    dispatcher.attach(sender, "test-bridge")
    task = asyncio.create_task(dispatcher.dispatch("collect_blocks", {"block": "oak_log"}))
    await asyncio.sleep(0.01)
    assert sent[0]["type"] == "action"
    assert sent[0]["tool"] == "collect_blocks"
    dispatcher.resolve(
        ActionResult(action_id=sent[0]["action_id"], ok=True, detail="collected 3 oak_log")
    )
    assert await task == "collected 3 oak_log"


async def test_failed_result_raises():
    dispatcher = ActionDispatcher(default_timeout_s=5)

    async def sender(message: dict) -> None:
        return None

    dispatcher.attach(sender)
    task = asyncio.create_task(dispatcher.dispatch("move_to", {"x": 1}))
    await asyncio.sleep(0.01)
    action_id = next(iter(dispatcher._pending))
    dispatcher.resolve(ActionResult(action_id=action_id, ok=False, detail="path blocked"))
    with pytest.raises(ActionError, match="path blocked"):
        await task


async def test_timeout_raises():
    dispatcher = ActionDispatcher(default_timeout_s=0.05)

    async def sender(message: dict) -> None:
        return None

    dispatcher.attach(sender)
    with pytest.raises(ActionError, match="超时"):
        await dispatcher.dispatch("dig", {})


async def test_dispatch_without_bridge_raises():
    dispatcher = ActionDispatcher()
    with pytest.raises(ActionError, match="没有已连接的 Minecraft 桥接"):
        await dispatcher.dispatch("dig", {})


async def test_detach_fails_pending_actions():
    dispatcher = ActionDispatcher(default_timeout_s=5)

    async def sender(message: dict) -> None:
        return None

    dispatcher.attach(sender)
    task = asyncio.create_task(dispatcher.dispatch("dig", {}))
    await asyncio.sleep(0.01)
    dispatcher.detach(sender)
    with pytest.raises(ActionError, match="断开"):
        await task


def test_parse_chat_rejects_empty():
    with pytest.raises(ValueError):
        parse_chat({"type": "chat", "text": "  "})
    assert parse_chat({"type": "chat", "text": "你好", "player": "Steve"}) == {
        "text": "你好",
        "player": "Steve",
    }


def test_action_result_validation():
    result = ActionResult.from_message(
        {"type": "action_result", "action_id": "abc", "ok": True, "detail": "ok"}
    )
    assert result.ok and result.action_id == "abc"
    with pytest.raises(ValueError):
        ActionResult.from_message({"type": "action_result", "ok": True})
