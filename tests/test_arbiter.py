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


async def test_world_actions_do_not_run_in_parallel():
    """两个会改世界的动作不同时跑；只读动作不受影响。"""
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
    await asyncio.sleep(0.05)
    # 第二个采集还在排队，没有发出去。
    assert len(dispatcher.sent) == 1

    observe = asyncio.create_task(arbiter.submit(ActionTicket(tool="observe")))
    await wait_for_sent(dispatcher, 2)
    assert len(dispatcher.sent) == 2
    assert dispatcher.sent[1]["tool"] == "observe"
    dispatcher.finish(dispatcher.sent[1]["action_id"])
    assert (await observe).status == "succeeded"

    dispatcher.finish(dispatcher.sent[0]["action_id"])
    await first
    await wait_for_sent(dispatcher, 3)
    assert len(dispatcher.sent) == 3
    assert dispatcher.sent[2]["tool"] == "collect_blocks"
    dispatcher.finish(dispatcher.sent[2]["action_id"])
    await second


async def test_stop_preempts_a_running_collect():
    """停止比任务步骤优先级高，正在跑的采集要让位。"""
    dispatcher = FakeDispatcher()
    arbiter = ActionArbiter(dispatcher)

    collect = asyncio.create_task(
        arbiter.submit(ActionTicket(tool="collect_blocks", arguments={"block": "dirt"}))
    )
    await wait_for_sent(dispatcher, 1)
    action_id = dispatcher.sent[0]["action_id"]

    stop = asyncio.create_task(arbiter.submit(ActionTicket(tool="stop")))
    await wait_for_sent(dispatcher, 2)
    assert action_id in dispatcher.cancelled
    with pytest.raises(ActionError) as error:
        await collect
    assert error.value.status == "cancelled"

    assert dispatcher.sent[-1]["tool"] == "stop"
    dispatcher.finish(dispatcher.sent[-1]["action_id"])
    assert (await stop).status == "succeeded"


async def test_stop_preempts_even_a_non_cancellable_action():
    """安全与停止可以抢占任何动作，否则玩家喊停也停不下来。"""
    dispatcher = FakeDispatcher()
    arbiter = ActionArbiter(dispatcher)

    place = asyncio.create_task(
        arbiter.submit(ActionTicket(tool="place_block", arguments={"block": "cobblestone"}))
    )
    await wait_for_sent(dispatcher, 1)
    action_id = dispatcher.sent[0]["action_id"]

    stop = asyncio.create_task(arbiter.submit(ActionTicket(tool="stop")))
    await wait_for_sent(dispatcher, 2)
    assert action_id in dispatcher.cancelled
    with pytest.raises(ActionError):
        await place
    dispatcher.finish(dispatcher.sent[-1]["action_id"])
    await stop


async def test_equal_priority_does_not_preempt():
    """同优先级的动作不互相抢占，只按先来先到排队。"""
    dispatcher = FakeDispatcher()
    arbiter = ActionArbiter(dispatcher)

    first = asyncio.create_task(
        arbiter.submit(ActionTicket(tool="collect_blocks", arguments={"block": "dirt"}))
    )
    await wait_for_sent(dispatcher, 1)
    second = asyncio.create_task(
        arbiter.submit(ActionTicket(tool="place_block", arguments={"block": "cobblestone"}))
    )
    await asyncio.sleep(0.01)
    assert dispatcher.cancelled == []
    dispatcher.finish(dispatcher.sent[0]["action_id"])
    await first
    await wait_for_sent(dispatcher, 2)
    dispatcher.finish(dispatcher.sent[-1]["action_id"])
    await second


async def test_cancel_all_stops_running_and_queued():
    """停止会清空在途与排队的动作，并让取消纪元加一。"""
    dispatcher = FakeDispatcher()
    arbiter = ActionArbiter(dispatcher)

    running = asyncio.create_task(
        arbiter.submit(ActionTicket(tool="collect_blocks", arguments={"block": "dirt"}))
    )
    await wait_for_sent(dispatcher, 1)
    queued = asyncio.create_task(
        arbiter.submit(ActionTicket(tool="collect_blocks", arguments={"block": "oak_log"}))
    )
    await asyncio.sleep(0.05)

    epoch_before = arbiter.epoch
    ids = await arbiter.cancel_all("玩家要求停止")
    assert epoch_before + 1 == arbiter.epoch
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


async def test_status_reports_current_and_waiting():
    dispatcher = FakeDispatcher()
    arbiter = ActionArbiter(dispatcher)

    running = asyncio.create_task(
        arbiter.submit(ActionTicket(tool="collect_blocks", arguments={"block": "dirt"}))
    )
    await wait_for_sent(dispatcher, 1)
    waiting = asyncio.create_task(
        arbiter.submit(ActionTicket(tool="collect_blocks", arguments={"block": "oak_log"}))
    )
    await asyncio.sleep(0.05)

    status = arbiter.status()
    assert status["current"]["tool"] == "collect_blocks"
    assert len(status["waiting"]) == 1
    assert status["epoch"] == 0

    dispatcher.finish(dispatcher.sent[0]["action_id"])
    await running
    await wait_for_sent(dispatcher, 2)
    dispatcher.finish(dispatcher.sent[-1]["action_id"])
    await waiting
