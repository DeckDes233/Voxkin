from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from voxkin.agent.actions import ActionDispatcher, ActionError
from voxkin.agent.runlog import RunLogger
from voxkin.agent.runner import StepSpec, TaskRunner
from voxkin.agent.tasks import TaskStore
from voxkin.bridge.protocol import ActionResult


def make_store(tmp_path: Path) -> TaskStore:
    store = TaskStore(tmp_path / "tasks.db")
    store.initialize()
    return store


def test_result_status_drives_ok_flag():
    result = ActionResult.from_message(
        {
            "type": "action_result",
            "action_id": "abc",
            "ok": True,
            "detail": "只挖到 2 个",
            "status": "partial",
            "skill_id": "collect_blocks",
        }
    )
    assert result.status == "partial"
    assert result.ok is True
    assert result.skill_id == "collect_blocks"


def test_result_without_status_falls_back_to_ok():
    ok_result = ActionResult.from_message(
        {"type": "action_result", "action_id": "abc", "ok": True, "detail": "完成"}
    )
    assert ok_result.status == "succeeded"
    failed = ActionResult.from_message(
        {"type": "action_result", "action_id": "abc", "ok": False, "detail": "没有目标"}
    )
    assert failed.status == "failed"
    assert failed.ok is False


def test_partial_result_keeps_failed_flag():
    result = ActionResult.from_message(
        {
            "type": "action_result",
            "action_id": "abc",
            "ok": False,
            "status": "partial",
            "detail": "只拿到 2 个 橡木，还差 1 个",
        }
    )
    assert result.status == "partial"
    assert result.ok is False


def test_result_accepts_disconnected_status():
    result = ActionResult.from_message(
        {
            "type": "action_result",
            "action_id": "abc",
            "ok": False,
            "status": "disconnected",
            "detail": "与 Minecraft 的连接已断开",
        }
    )
    assert result.status == "disconnected"


def test_result_accepts_dead_status():
    result = ActionResult.from_message(
        {"type": "action_result", "action_id": "death-1", "ok": False, "status": "dead"}
    )

    assert result.status == "dead"
    assert result.ok is False
    assert result.ok is False


async def test_dispatch_result_returns_status_and_action_id():
    dispatcher = ActionDispatcher(default_timeout_s=5)
    sent: list[dict] = []

    async def sender(message: dict) -> None:
        sent.append(message)

    dispatcher.attach(sender, "test-bridge")
    task = asyncio.create_task(
        dispatcher.dispatch_result("collect_blocks", {"block": "oak_log"})
    )
    await asyncio.sleep(0.01)
    dispatcher.resolve(
        ActionResult(
            action_id=sent[0]["action_id"],
            ok=True,
            detail="获得 2 个 橡木",
            status="partial",
            skill_id="collect_blocks",
        )
    )
    result = await task
    assert result.status == "partial"
    assert result.action_id == sent[0]["action_id"]
    assert sent[0]["skill_id"] == "collect_blocks"


async def test_dispatch_result_raises_with_bridge_status():
    dispatcher = ActionDispatcher(default_timeout_s=5)
    sent: list[dict] = []

    async def sender(message: dict) -> None:
        sent.append(message)

    dispatcher.attach(sender)
    task = asyncio.create_task(dispatcher.dispatch_result("goto", {"x": 1}))
    await asyncio.sleep(0.01)
    dispatcher.resolve(
        ActionResult(
            action_id=sent[0]["action_id"],
            ok=False,
            detail="被停止指令取消",
            status="cancelled",
        )
    )
    with pytest.raises(ActionError) as error:
        await task
    assert error.value.status == "cancelled"


async def test_dispatch_without_bridge_is_blocked():
    dispatcher = ActionDispatcher()
    with pytest.raises(ActionError) as error:
        await dispatcher.dispatch_result("dig", {})
    assert error.value.status == "blocked"


def test_runner_records_status_and_action_id(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    logger = RunLogger(tmp_path / "run.jsonl")
    state = {"inventory": {"oak_log": 3}}

    async def executor(tool: str, arguments: dict) -> ActionResult:
        return ActionResult(
            action_id="a-1",
            ok=True,
            detail="获得 3 个 橡木",
            status="succeeded",
            skill_id="collect_blocks",
        )

    steps = [
        StepSpec(
            "收集木头",
            "collect_blocks",
            {"block": "oak_log", "count": 3},
            {"type": "inventory", "items": {"oak_log": 3}},
        )
    ]
    runner = TaskRunner(executor, lambda: state, store, logger=logger)
    result = asyncio.run(runner.run("S0", steps))
    assert result.ok
    assert result.status == "succeeded"
    record = logger.tail(1)[0]
    assert record["status"] == "succeeded"
    assert record["action_id"] == "a-1"
    assert record["skill_id"] == "collect_blocks"


def test_runner_stops_on_cancelled_action(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    attempts = {"count": 0}

    async def executor(tool: str, arguments: dict) -> ActionResult:
        attempts["count"] += 1
        raise ActionError("动作 collect_blocks 执行失败: 被停止指令取消", "cancelled")

    steps = [
        StepSpec(
            "收集木头",
            "collect_blocks",
            {"block": "oak_log"},
            {"type": "inventory", "items": {"oak_log": 3}},
            retries=3,
        )
    ]
    runner = TaskRunner(executor, lambda: {"inventory": {}}, store)
    result = asyncio.run(runner.run("S0", steps))
    assert not result.ok
    assert result.status == "cancelled"
    assert attempts["count"] == 1
    assert store.get_task(result.task_id).status == "cancelled"


def test_runner_preserves_checkpoint_on_bridge_disconnect(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    attempts = {"count": 0}

    async def executor(tool: str, arguments: dict) -> ActionResult:
        attempts["count"] += 1
        raise ActionError("Minecraft 桥接已断开", "disconnected")

    steps = [
        StepSpec(
            "收集木头",
            "collect_blocks",
            {"block": "oak_log"},
            {"type": "inventory", "items": {"oak_log": 3}},
            retries=3,
        ),
        StepSpec("合成木板", "craft", {"item": "oak_planks"}, {"type": "always"}),
    ]
    runner = TaskRunner(executor, lambda: {"inventory": {}}, store)
    result = asyncio.run(runner.run("S0", steps))
    assert not result.ok
    assert result.status == "disconnected"
    assert "断开" in result.detail
    assert store.get_task(result.task_id).status == "failed"
    checkpoint = store.load_checkpoint(result.task_id)
    assert checkpoint is not None
    assert checkpoint["cursor"] == 0
    assert checkpoint["payload"]["status"] == "disconnected"
    assert attempts["count"] == 1


def test_runner_reports_partial_when_inventory_has_progress(tmp_path: Path) -> None:
    store = make_store(tmp_path)

    async def executor(tool: str, arguments: dict) -> str:
        return "拿到 1 个"

    steps = [
        StepSpec(
            "收集木头",
            "collect_blocks",
            {"block": "oak_log"},
            {"type": "inventory", "items": {"oak_log": 3}},
        )
    ]
    runner = TaskRunner(executor, lambda: {"inventory": {"oak_log": 1}}, store)
    result = asyncio.run(runner.run("S0", steps))
    assert not result.ok
    assert result.status == "partial"
    assert store.get_task(result.task_id).status == "failed"


def test_runner_blocks_when_nothing_progressed(tmp_path: Path) -> None:
    store = make_store(tmp_path)

    async def executor(tool: str, arguments: dict) -> str:
        return "附近没有橡木"

    steps = [
        StepSpec(
            "收集木头",
            "collect_blocks",
            {"block": "oak_log"},
            {"type": "inventory", "items": {"oak_log": 3}},
        )
    ]
    runner = TaskRunner(executor, lambda: {"inventory": {}}, store)
    result = asyncio.run(runner.run("S0", steps))
    assert not result.ok
    assert result.status == "blocked"
    assert store.get_task(result.task_id).status == "blocked"


def test_runner_records_partial_action_status(tmp_path: Path) -> None:
    store = make_store(tmp_path)

    async def executor(tool: str, arguments: dict) -> str:
        raise ActionError("动作 collect_blocks 执行失败: 只拿到 2 个 橡木，还差 1 个", "partial")

    steps = [
        StepSpec(
            "收集木头",
            "collect_blocks",
            {"block": "oak_log"},
            {"type": "inventory", "items": {"oak_log": 3}},
        )
    ]
    runner = TaskRunner(executor, lambda: {"inventory": {"oak_log": 2}}, store)
    result = asyncio.run(runner.run("S0", steps))
    assert not result.ok
    assert result.status == "partial"


def test_runner_does_not_accept_partial_action_for_always_verification(
    tmp_path: Path,
) -> None:
    store = make_store(tmp_path)

    async def executor(tool: str, arguments: dict) -> ActionResult:
        return ActionResult(
            action_id="partial-action",
            ok=False,
            detail="partial result",
            status="partial",
            skill_id=tool,
        )

    steps = [
        StepSpec(
            "complete objective",
            "fight_dragon",
            {},
            {"type": "always"},
            retries=0,
        )
    ]
    runner = TaskRunner(executor, lambda: {}, store)
    result = asyncio.run(runner.run("S6", steps))
    assert not result.ok
    assert result.status == "partial"
    assert "partial result" in result.detail


def test_bridge_reports_structured_status():
    source = (Path(__file__).resolve().parents[1] / "bridge" / "minecraft_bridge.js").read_text(
        encoding="utf-8"
    )
    assert "status: finalStatus" in source
    assert "skill_id: message.skill_id || message.tool" in source
    assert "function statusForError(error)" in source
    assert "return 'disconnected'" in source
    assert "FINAL_ACTION_STATUSES.has(reportedStatus)" in source
