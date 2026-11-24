from __future__ import annotations

import asyncio

import pytest

from voxkin.agent.actions import ActionError
from voxkin.agent.arbiter import (
    PRIORITY_AUTONOMOUS,
    PRIORITY_PLAYER,
    PRIORITY_REPORT,
    PRIORITY_SAFETY,
    PRIORITY_STOP,
    PRIORITY_TASK,
    ActionArbiter,
    ActionTicket,
    is_world_action,
    priority_for,
)
from voxkin.bridge.protocol import ActionResult


class FakeDispatcher:
    """仲裁器测试用的假派发器：记录发出去的动作，按脚本回结果。"""

    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.cancelled: list[str] = []
        self._pending: dict[str, asyncio.Future] = {}
        self.state: dict = {
            "alive": True,
            "health": 20,
            "position": {"x": 0, "y": 64, "z": 0},
        }
        self.connected = True

    def state_snapshot(self) -> dict:
        return self.state

    async def dispatch_result(
        self,
        tool: str,
        arguments: dict,
        timeout_s: float | None = None,
        action_id: str = "",
        priority: int = 3,
    ) -> ActionResult:
        request_id = action_id or f"gen-{len(self.sent)}"
        self.sent.append(
            {"tool": tool, "action_id": request_id, "priority": priority, "arguments": arguments}
        )
        future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        result = await future
        if not result.ok and result.status != "partial":
            raise ActionError(f"动作 {tool} 执行失败: {result.detail}", status=result.status)
        return result

    async def cancel(self, action_id: str, reason: str = "cancelled", turn_id: str = "") -> bool:
        self.cancelled.append(action_id)
        future = self._pending.get(action_id)
        if future is not None and not future.done():
            future.set_result(
                ActionResult(
                    action_id=action_id,
                    ok=False,
                    detail=f"已取消：{reason}",
                    status="cancelled",
                )
            )
        return True

    async def cancel_all(self, reason: str = "cancelled", turn_id: str = "") -> list[str]:
        ids = list(self._pending)
        for action_id in ids:
            await self.cancel(action_id, reason, turn_id)
        return ids

    def finish(self, action_id: str, detail: str = "做完了", status: str = "succeeded") -> None:
        future = self._pending.get(action_id)
        if future is not None and not future.done():
            future.set_result(
                ActionResult(action_id=action_id, ok=True, detail=detail, status=status)
            )


@pytest.mark.asyncio
async def test_arbiter_rejects_world_actions_while_dead():
    dispatcher = FakeDispatcher()
    dispatcher.state = {"alive": False, "health": 0}
    arbiter = ActionArbiter(dispatcher)

    with pytest.raises(ActionError) as error:
        await arbiter.submit(ActionTicket(tool="collect_blocks", arguments={"block": "oak_log"}))

    assert error.value.status == "dead"
    assert dispatcher.sent == []


@pytest.mark.asyncio
async def test_arbiter_blocks_world_actions_until_fresh_state_is_available():
    dispatcher = FakeDispatcher()
    dispatcher.state = {}
    arbiter = ActionArbiter(dispatcher)

    with pytest.raises(ActionError) as error:
        await arbiter.submit(ActionTicket(tool="collect_blocks", arguments={"block": "oak_log"}))

    assert error.value.status == "blocked"
    assert dispatcher.sent == []


@pytest.mark.asyncio
async def test_arbiter_blocks_world_actions_when_position_is_incomplete():
    dispatcher = FakeDispatcher()
    dispatcher.state["position"] = {"x": 0, "y": 64}
    arbiter = ActionArbiter(dispatcher)

    with pytest.raises(ActionError) as error:
        await arbiter.submit(ActionTicket(tool="collect_blocks", arguments={"block": "oak_log"}))

    assert error.value.status == "blocked"
    assert dispatcher.sent == []


@pytest.mark.asyncio
async def test_arbiter_reports_bridge_disconnect_before_dispatch():
    dispatcher = FakeDispatcher()
    dispatcher.connected = False
    arbiter = ActionArbiter(dispatcher)

    with pytest.raises(ActionError) as error:
        await arbiter.submit(ActionTicket(tool="collect_blocks", arguments={"block": "oak_log"}))

    assert error.value.status == "disconnected"
    assert dispatcher.sent == []


async def wait_for_sent(dispatcher: FakeDispatcher, count: int, timeout: float = 2.0) -> None:
    """等到派发器收到第 count 条动作，避免用固定 sleep 猜时序。"""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while len(dispatcher.sent) < count:
        if loop.time() > deadline:
            raise AssertionError(f"等待第 {count} 条动作超时")
        await asyncio.sleep(0.01)


def test_priority_comes_from_manifest_and_origin():
    """优先级由清单的 type 与动作来源决定，不由具体技能名硬编码。"""
    assert priority_for("stop") == PRIORITY_STOP
    assert priority_for("collect_blocks", "fast_path") == PRIORITY_PLAYER
    assert priority_for("collect_blocks", "llm") == PRIORITY_TASK
    assert priority_for("collect_blocks", "autonomous") == PRIORITY_AUTONOMOUS
    assert priority_for("flee_low_health", "reflex") == PRIORITY_SAFETY
    # 只读技能是报告类，排在最后。
    assert priority_for("observe") == PRIORITY_REPORT
    assert priority_for("inventory") == PRIORITY_REPORT


def test_world_actions_are_recognized_by_manifest_type():
    assert is_world_action("collect_blocks") is True
    assert is_world_action("place_block") is True
    assert is_world_action("observe") is False
    assert is_world_action("inventory") is False
    # 清单里没有的技能按会改世界处理，宁可排队也不要并发写世界。
    assert is_world_action("不存在的技能") is True


async def test_core_forwards_actions_to_bridge_without_a_second_execution_queue():
    """Core 不再维护第二条执行队列，Bridge 接收动作并独占排序。"""
    dispatcher = FakeDispatcher()
    arbiter = ActionArbiter(dispatcher)

    first = asyncio.create_task(
        arbiter.submit(ActionTicket(tool="collect_blocks", arguments={"block": "dirt"}))
    )
    await wait_for_sent(dispatcher, 1)
    assert len(dispatcher.sent) == 1

    second = asyncio.create_task(
        arbiter.submit(ActionTicket(tool="collect_blocks", arguments={"block": "oak_log"}))
    )
    await wait_for_sent(dispatcher, 2)

    observe = asyncio.create_task(arbiter.submit(ActionTicket(tool="observe")))
    await wait_for_sent(dispatcher, 3)
    assert len(dispatcher.sent) == 3
    assert [item["tool"] for item in dispatcher.sent] == ["collect_blocks", "collect_blocks", "observe"]
    for item in dispatcher.sent:
        dispatcher.finish(item["action_id"])
    assert all(result.status == "succeeded" for result in await asyncio.gather(first, second, observe))


async def test_stop_action_is_forwarded_without_core_claiming_a_preemption():
    """Core 不声称停止成功或自行抢占，动作交给 Bridge 执行器处理。"""
    dispatcher = FakeDispatcher()
    arbiter = ActionArbiter(dispatcher)

    collect = asyncio.create_task(
        arbiter.submit(ActionTicket(tool="collect_blocks", arguments={"block": "dirt"}))
    )
    await wait_for_sent(dispatcher, 1)
    action_id = dispatcher.sent[0]["action_id"]

    stop = asyncio.create_task(arbiter.submit(ActionTicket(tool="stop")))
    await wait_for_sent(dispatcher, 2)
    assert action_id not in dispatcher.cancelled
    assert dispatcher.sent[-1]["tool"] == "stop"
    dispatcher.finish(action_id)
    dispatcher.finish(dispatcher.sent[-1]["action_id"])
    assert (await collect).status == "succeeded"
    assert (await stop).status == "succeeded"


async def test_bridge_owns_stop_handoff_for_non_cancellable_actions():
    """Core 不在第二层模拟取消；Bridge 负责停止交接与 terminal 回执。"""
    dispatcher = FakeDispatcher()
    arbiter = ActionArbiter(dispatcher)

    place = asyncio.create_task(
        arbiter.submit(ActionTicket(tool="place_block", arguments={"block": "cobblestone"}))
    )
    await wait_for_sent(dispatcher, 1)
    action_id = dispatcher.sent[0]["action_id"]

    stop = asyncio.create_task(arbiter.submit(ActionTicket(tool="stop")))
    await wait_for_sent(dispatcher, 2)
    assert action_id not in dispatcher.cancelled
    dispatcher.finish(action_id)
    dispatcher.finish(dispatcher.sent[-1]["action_id"])
    assert (await place).status == "succeeded"
    await stop


async def test_equal_priority_actions_are_both_associated_with_bridge():
    """优先级策略和实际排队均由 Bridge 执行器判定。"""
    dispatcher = FakeDispatcher()
    arbiter = ActionArbiter(dispatcher)

    first = asyncio.create_task(
        arbiter.submit(ActionTicket(tool="collect_blocks", arguments={"block": "dirt"}))
    )
    await wait_for_sent(dispatcher, 1)
    second = asyncio.create_task(
        arbiter.submit(ActionTicket(tool="place_block", arguments={"block": "cobblestone"}))
    )
    await wait_for_sent(dispatcher, 2)
    assert dispatcher.cancelled == []
    assert len(dispatcher.sent) == 2
    dispatcher.finish(dispatcher.sent[0]["action_id"])
    await first
    dispatcher.finish(dispatcher.sent[-1]["action_id"])
    await second


async def test_cancel_all_requests_bridge_to_stop_every_tracked_action():
    """停止请求由 Bridge 交接；Core 只统计关联中的 action_id。"""
    dispatcher = FakeDispatcher()
    arbiter = ActionArbiter(dispatcher)

    running = asyncio.create_task(
        arbiter.submit(ActionTicket(tool="collect_blocks", arguments={"block": "dirt"}))
    )
    await wait_for_sent(dispatcher, 1)
    queued = asyncio.create_task(
        arbiter.submit(ActionTicket(tool="collect_blocks", arguments={"block": "oak_log"}))
    )
    await wait_for_sent(dispatcher, 2)

    epoch_before = arbiter.epoch
    ids = await arbiter.cancel_all("玩家要求停止")
    assert epoch_before == arbiter.epoch
    assert len(ids) == 2
    with pytest.raises(ActionError) as error:
        await running
    assert error.value.status == "cancelled"
    with pytest.raises(ActionError) as error:
        await queued
    assert error.value.status == "cancelled"


async def test_wait_cancelled_separates_receipt_from_timeout():
    """收到回执与等到超时是两条结果，不能混成一条。"""
    dispatcher = FakeDispatcher()
    arbiter = ActionArbiter(dispatcher)

    running = asyncio.create_task(
        arbiter.submit(ActionTicket(tool="collect_blocks", arguments={"block": "dirt"}))
    )
    await wait_for_sent(dispatcher, 1)
    action_id = dispatcher.sent[0]["action_id"]
    assert await arbiter.wait_cancelled([action_id], timeout_s=0.05) is False

    dispatcher.finish(action_id)
    await running
    assert await arbiter.wait_cancelled([action_id], timeout_s=0.5) is True


@pytest.mark.asyncio
async def test_unknown_result_does_not_confirm_stop_receipt():
    """Core 等待结束或收到 unknown 都不代表 Bridge 确认动作已停。"""
    from voxkin.agent.actions import ActionDispatcher

    dispatcher = ActionDispatcher()
    sent: list[dict] = []

    async def sender(message: dict) -> None:
        sent.append(message)

    dispatcher.attach(sender)
    dispatcher.update_state(
        {
            "session_id": "world",
            "revision": 1,
            "ready": True,
            "alive": True,
            "health": 20,
            "position": {"x": 0, "y": 64, "z": 0},
            "executor": {"safety_active": False, "epoch": 1},
        }
    )
    arbiter = ActionArbiter(dispatcher)
    running = asyncio.create_task(
        arbiter.submit(ActionTicket(tool="collect_blocks", arguments={"block": "dirt"}))
    )
    for _ in range(100):
        if sent:
            break
        await asyncio.sleep(0.01)
    assert sent
    action_id = sent[0]["action_id"]
    dispatcher.resolve(
        ActionResult(action_id, False, "结果未知", status="unknown")
    )
    with pytest.raises(ActionError) as error:
        await running
    assert error.value.status == "unknown"
    assert await arbiter.wait_cancelled([action_id], timeout_s=0.05) is False


async def test_ticket_priority_is_sent_to_the_bridge():
    """优先级要跟着动作一起发给桥接，桥接才知道谁先跑。"""
    dispatcher = FakeDispatcher()
    arbiter = ActionArbiter(dispatcher)

    task = asyncio.create_task(
        arbiter.submit(ActionTicket(tool="collect_blocks", origin="fast_path"))
    )
    await wait_for_sent(dispatcher, 1)
    assert dispatcher.sent[0]["priority"] == PRIORITY_PLAYER
    dispatcher.finish(dispatcher.sent[0]["action_id"])
    await task


async def test_status_reports_bridge_executor_and_associated_tickets():
    dispatcher = FakeDispatcher()
    arbiter = ActionArbiter(dispatcher)

    running = asyncio.create_task(
        arbiter.submit(ActionTicket(tool="collect_blocks", arguments={"block": "dirt"}))
    )
    await wait_for_sent(dispatcher, 1)
    assert dispatcher.sent
    waiting = asyncio.create_task(
        arbiter.submit(ActionTicket(tool="collect_blocks", arguments={"block": "oak_log"}))
    )
    await wait_for_sent(dispatcher, 2)

    status = arbiter.status()
    assert status["current"] is None
    assert status["waiting"] == []
    assert status["tracked"] == 2
    assert len(status["actions"]) == 2
    assert status["epoch"] == 0

    dispatcher.finish(dispatcher.sent[0]["action_id"])
    await running
    dispatcher.finish(dispatcher.sent[-1]["action_id"])
    await waiting
