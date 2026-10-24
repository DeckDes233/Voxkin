from __future__ import annotations

import asyncio

import pytest

from voxkin.agent.actions import ActionDispatcher, ActionError, status_for_detail
from voxkin.agent.arbiter import ActionArbiter, ActionTicket
from voxkin.bridge.protocol import ActionProgress, ActionResult, parse_chat


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


async def test_dispatch_uses_step_timeout():
    dispatcher = ActionDispatcher(default_timeout_s=5)
    sent: list[dict] = []

    async def sender(message: dict) -> None:
        sent.append(message)

    dispatcher.attach(sender, "test-bridge")
    task = asyncio.create_task(
        dispatcher.dispatch("collect_blocks", {"block": "oak_log"}, timeout_s=180)
    )
    await asyncio.sleep(0.01)
    assert sent[0]["timeout_s"] == 180
    dispatcher.resolve(
        ActionResult(action_id=sent[0]["action_id"], ok=True, detail="ok")
    )
    assert await task == "ok"


async def test_failed_result_raises():
    dispatcher = ActionDispatcher(default_timeout_s=5)

    async def sender(message: dict) -> None:
        return None

    dispatcher.attach(sender)
    task = asyncio.create_task(dispatcher.dispatch("attack_nearest", {"range": 16}))
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
        await dispatcher.dispatch("attack_nearest", {}, timeout_s=0.05)


async def test_timeout_requests_bridge_cancellation_and_clears_pending_action():
    dispatcher = ActionDispatcher()
    sent: list[dict] = []

    async def sender(message: dict) -> None:
        sent.append(message)

    dispatcher.attach(sender)
    with pytest.raises(ActionError, match="超时"):
        await dispatcher.dispatch("attack_nearest", {}, timeout_s=0.05)

    assert [message["type"] for message in sent] == ["action", "action_cancel"]
    assert sent[0]["action_id"] == sent[1]["action_id"]
    assert dispatcher.pending_count == 0


async def test_cancelled_wait_requests_bridge_cancellation_and_cleans_pending_action():
    dispatcher = ActionDispatcher()
    sent: list[dict] = []

    async def sender(message: dict) -> None:
        sent.append(message)

    dispatcher.attach(sender)
    task = asyncio.create_task(dispatcher.dispatch("attack_nearest", {}))
    await asyncio.sleep(0.01)
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task

    assert [message["type"] for message in sent] == ["action", "action_cancel"]
    assert sent[0]["action_id"] == sent[1]["action_id"]
    assert dispatcher.pending_count == 0


async def test_fail_pending_marks_in_flight_action_with_death_status():
    dispatcher = ActionDispatcher()

    async def sender(message: dict) -> None:
        return None

    dispatcher.attach(sender)
    task = asyncio.create_task(dispatcher.dispatch_result("collect_blocks", {"block": "oak_log"}))
    await asyncio.sleep(0.01)

    action_ids = dispatcher.fail_pending("dead", "角色死亡")

    with pytest.raises(ActionError) as error:
        await task
    assert error.value.status == "dead"
    assert len(action_ids) == 1
    assert dispatcher.pending_count == 0


async def test_dispatch_without_bridge_raises():
    dispatcher = ActionDispatcher()
    with pytest.raises(ActionError, match="没有已连接的 Minecraft 桥接"):
        await dispatcher.dispatch("dig", {})


async def test_detach_fails_pending_actions():
    dispatcher = ActionDispatcher(default_timeout_s=5)

    async def sender(message: dict) -> None:
        return None

    dispatcher.attach(sender)
    task = asyncio.create_task(dispatcher.dispatch("attack_nearest", {}))
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
        {
            "type": "action_result",
            "action_id": "abc",
            "ok": True,
            "detail": "ok",
            "data": {"events": ["ender_dragon_killed"]},
        }
    )
    assert result.ok and result.action_id == "abc"
    assert result.data == {"events": ["ender_dragon_killed"]}
    with pytest.raises(ValueError):
        ActionResult.from_message({"type": "action_result", "ok": True})


def test_timeout_follows_the_manifest():
    """长技能的超时按清单来，不能用 120 秒的默认值把长任务判死。"""
    dispatcher = ActionDispatcher()
    assert dispatcher.timeout_for("smelt_batch") == 300
    assert dispatcher.timeout_for("deep_mine") == 240
    assert dispatcher.timeout_for("collect_blocks") == 240
    assert dispatcher.timeout_for("observe") == 5
    # 清单里没有的技能才用默认值。
    assert dispatcher.timeout_for("dig") == dispatcher.default_timeout_s


async def test_long_skill_uses_manifest_timeout():
    dispatcher = ActionDispatcher()
    sent: list[dict] = []

    async def sender(message: dict) -> None:
        sent.append(message)

    dispatcher.attach(sender)
    task = asyncio.create_task(
        dispatcher.dispatch("smelt_batch", {"item": "raw_iron", "count": 64})
    )
    await asyncio.sleep(0.01)
    assert sent[0]["timeout_s"] == 300
    dispatcher.resolve(
        ActionResult(action_id=sent[0]["action_id"], ok=True, detail="熔好了 64 个")
    )
    assert await task == "熔好了 64 个"


async def test_result_after_bridge_timeout_still_lands():
    """桥接先超时，Core 还要多等一会儿，否则状态会被 Core 的超时盖掉。"""
    dispatcher = ActionDispatcher()
    sent: list[dict] = []

    async def sender(message: dict) -> None:
        sent.append(message)

    dispatcher.attach(sender)
    task = asyncio.create_task(
        dispatcher.dispatch("collect_blocks", {"block": "oak_log"}, timeout_s=0.1)
    )
    await asyncio.sleep(0.01)
    action_id = sent[0]["action_id"]
    await asyncio.sleep(0.15)
    dispatcher.resolve(
        ActionResult(action_id=action_id, ok=False, detail="动作超时", status="cancelled")
    )
    with pytest.raises(ActionError) as error:
        await task
    assert error.value.status == "cancelled"


async def test_partial_result_is_not_a_failure():
    """只完成一部分不是失败，状态要原样交回去。"""
    dispatcher = ActionDispatcher()
    sent: list[dict] = []

    async def sender(message: dict) -> None:
        sent.append(message)

    dispatcher.attach(sender)
    task = asyncio.create_task(
        dispatcher.dispatch_result("collect_blocks", {"block": "oak_log"})
    )
    await asyncio.sleep(0.01)
    dispatcher.resolve(
        ActionResult(
            action_id=sent[0]["action_id"],
            ok=False,
            detail="只拿到 2 个橡木，还差 1 个",
            status="partial",
        )
    )
    result = await task
    assert result.status == "partial"
    assert result.ok is False
    assert "还差" in result.detail


async def test_partial_detail_says_so():
    dispatcher = ActionDispatcher()
    sent: list[dict] = []

    async def sender(message: dict) -> None:
        sent.append(message)

    dispatcher.attach(sender)
    task = asyncio.create_task(dispatcher.dispatch("collect_blocks", {"block": "oak_log"}))
    await asyncio.sleep(0.01)
    dispatcher.resolve(
        ActionResult(
            action_id=sent[0]["action_id"],
            ok=False,
            detail="只拿到 2 个橡木，还差 1 个",
            status="partial",
        )
    )
    assert "只完成一部分" in await task


@pytest.mark.parametrize(
    ("detail", "status"),
    [
        ("只拿到 2 个橡木，还差 1 个", "partial"),
        ("橡木只放进 3 个，还差 5 个", "partial"),
        ("被新的指令打断", "cancelled"),
        ("移动被取消：连接断开", "disconnected"),
        ("附近 16 格内没有床", "blocked"),
        ("材料不够，还差 2 个煤", "partial"),
        ("坐标无效", "failed"),
    ],
)
def test_status_mapping_matches_the_bridge(detail, status):
    """状态映射与桥接 statusForError 一致。"""
    assert status_for_detail(detail) == status


async def test_missing_status_falls_back_to_detail():
    """桥接没给状态时，Core 用同一套关键词补出状态。"""
    dispatcher = ActionDispatcher()
    sent: list[dict] = []

    async def sender(message: dict) -> None:
        sent.append(message)

    dispatcher.attach(sender)
    task = asyncio.create_task(dispatcher.dispatch("collect_blocks", {"block": "oak_log"}))
    await asyncio.sleep(0.01)
    dispatcher.resolve(
        ActionResult(
            action_id=sent[0]["action_id"],
            ok=False,
            detail="附近 16 格内没有橡木",
        )
    )
    with pytest.raises(ActionError) as error:
        await task
    assert error.value.status == "blocked"


async def test_unknown_tool_is_blocked():
    dispatcher = ActionDispatcher()
    sent: list[dict] = []

    async def sender(message: dict) -> None:
        sent.append(message)

    dispatcher.attach(sender)
    with pytest.raises(ActionError) as error:
        await dispatcher.dispatch("dig", {})
    assert error.value.status == "blocked"
    assert sent == []


async def test_chat_is_not_forwarded_to_the_bridge():
    """chat 只在游戏内生效，Core 用 TTS 说话。"""
    dispatcher = ActionDispatcher()
    sent: list[dict] = []

    async def sender(message: dict) -> None:
        sent.append(message)

    dispatcher.attach(sender)
    with pytest.raises(ActionError) as error:
        await dispatcher.dispatch("chat", {"text": "你好"})
    assert error.value.status == "blocked"
    assert sent == []


async def test_missing_required_parameter_goes_to_the_bridge():
    """必填参数缺了不由 Core 拦，桥接自己会检查并说清缺什么。"""
    dispatcher = ActionDispatcher()
    sent: list[dict] = []

    async def sender(message: dict) -> None:
        sent.append(message)

    dispatcher.attach(sender)
    task = asyncio.create_task(
        dispatcher.dispatch("place_block", {"block": "cobblestone"})
    )
    await asyncio.sleep(0.01)
    assert sent[0]["arguments"] == {"block": "cobblestone"}
    dispatcher.resolve(
        ActionResult(action_id=sent[0]["action_id"], ok=False, detail="坐标无效")
    )
    with pytest.raises(ActionError):
        await task


async def test_arguments_follow_the_manifest():
    """参数按清单校验：数字字符串转成数值，超范围的夹回范围。"""
    dispatcher = ActionDispatcher()
    sent: list[dict] = []

    async def sender(message: dict) -> None:
        sent.append(message)

    dispatcher.attach(sender)
    task = asyncio.create_task(
        dispatcher.dispatch("craft", {"item": "oak_planks", "count": "12"})
    )
    await asyncio.sleep(0.01)
    assert sent[0]["arguments"] == {"item": "oak_planks", "count": 12}
    dispatcher.resolve(ActionResult(action_id=sent[0]["action_id"], ok=True, detail="ok"))
    await task

    task = asyncio.create_task(dispatcher.dispatch("attack_nearest", {"range": 99}))
    await asyncio.sleep(0.01)
    assert sent[1]["arguments"] == {"range": 32}
    dispatcher.resolve(ActionResult(action_id=sent[1]["action_id"], ok=True, detail="ok"))
    await task


async def test_detach_marks_pending_as_disconnected():
    dispatcher = ActionDispatcher()

    async def sender(message: dict) -> None:
        return None

    dispatcher.attach(sender)
    task = asyncio.create_task(dispatcher.dispatch("attack_nearest", {}))
    await asyncio.sleep(0.01)
    dispatcher.detach(sender)
    with pytest.raises(ActionError) as error:
        await task
    assert error.value.status == "disconnected"


async def test_detach_invalidates_cached_world_state():
    dispatcher = ActionDispatcher()

    async def sender(message: dict) -> None:
        return None

    dispatcher.attach(sender)
    dispatcher.update_state({"alive": True, "health": 20, "position": {"x": 1, "y": 2, "z": 3}})
    dispatcher.detach(sender)

    assert dispatcher.state_snapshot() == {}
    assert dispatcher.state_age_s() == float("inf")


async def test_arbiter_rejects_actions_while_player_is_dead():
    dispatcher = ActionDispatcher()
    async def sender(message: dict) -> None:
        return None

    dispatcher.attach(sender)
    dispatcher.update_state({"alive": False, "health": 0})
    arbiter = ActionArbiter(dispatcher)

    with pytest.raises(ActionError) as error:
        await arbiter.submit(ActionTicket(tool="collect_blocks", arguments={"block": "oak_log"}))

    assert error.value.status == "dead"
    assert arbiter.status()["tracked"] == 0


async def test_cancel_sends_action_cancel_with_the_action_id():
    """取消请求必须带 action_id，桥接才不会误伤别的动作。"""
    dispatcher = ActionDispatcher()
    sent: list[dict] = []

    async def sender(message: dict) -> None:
        sent.append(message)

    dispatcher.attach(sender)
    task = asyncio.create_task(dispatcher.dispatch("collect_blocks", {"block": "oak_log"}))
    await asyncio.sleep(0.01)
    action_id = sent[0]["action_id"]

    assert await dispatcher.cancel(action_id, "玩家要求停止", "turn-1") is True
    cancel_message = sent[-1]
    assert cancel_message["type"] == "action_cancel"
    assert cancel_message["action_id"] == action_id
    assert cancel_message["scope"] == "action"
    assert cancel_message["reason"] == "玩家要求停止"
    assert cancel_message["turn_id"] == "turn-1"

    with pytest.raises(ActionError) as error:
        await task
    assert error.value.status == "cancelled"


async def test_cancel_all_clears_scope_and_pending_actions():
    """停止要一次清掉所有在途动作，scope 必须是 all。"""
    dispatcher = ActionDispatcher()
    sent: list[dict] = []

    async def sender(message: dict) -> None:
        sent.append(message)

    dispatcher.attach(sender)
    first = asyncio.create_task(dispatcher.dispatch("collect_blocks", {"block": "oak_log"}))
    await asyncio.sleep(0.01)
    second = asyncio.create_task(dispatcher.dispatch("goto", {"x": 1, "y": 2, "z": 3}))
    await asyncio.sleep(0.01)

    ids = await dispatcher.cancel_all("玩家要求停止")
    assert len(ids) == 2
    assert sent[-1]["type"] == "action_cancel"
    assert sent[-1]["scope"] == "all"

    for task in (first, second):
        with pytest.raises(ActionError) as error:
            await task
        assert error.value.status == "cancelled"


async def test_bridge_cancelled_reply_is_cancelled_not_failed():
    """桥接回「已取消」时，Core 的结论也是取消，不是失败。"""
    dispatcher = ActionDispatcher()
    sent: list[dict] = []

    async def sender(message: dict) -> None:
        sent.append(message)

    dispatcher.attach(sender)
    task = asyncio.create_task(dispatcher.dispatch("collect_blocks", {"block": "oak_log"}))
    await asyncio.sleep(0.01)
    dispatcher.resolve(
        ActionResult(
            action_id=sent[0]["action_id"],
            ok=False,
            detail="已取消：玩家要求停止",
            status="cancelled",
        )
    )
    with pytest.raises(ActionError) as error:
        await task
    assert error.value.status == "cancelled"


async def test_cancel_without_bridge_reports_false():
    dispatcher = ActionDispatcher()
    assert await dispatcher.cancel("abc", "玩家要求停止") is False
    assert await dispatcher.cancel_all("玩家要求停止") == []


async def test_progress_is_recorded_without_being_invented():
    """进度只记录桥接真报上来的，桥接没报就是没有。"""
    dispatcher = ActionDispatcher()
    dispatcher.on_progress(
        ActionProgress(action_id="abc", phase="running", detail="已采集 2/5 泥土", progress=0.4)
    )
    snapshot = dispatcher.progress_snapshot("abc")
    assert snapshot["detail"] == "已采集 2/5 泥土"
    assert snapshot["progress"] == 0.4
    assert dispatcher.progress_snapshot("不存在的动作") == {}
