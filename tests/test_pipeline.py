import asyncio
import sys
from pathlib import Path

import numpy as np
import pytest
from aiohttp import web

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from dev_llm_server import build_app

from support import BrokenTTS, RecordingSink, SlowTTS, ToneTTS
from voxkin.agent.actions import ActionError
from voxkin.agent.arbiter import ActionTicket
from voxkin.audio.sinks import WavDirSink
from voxkin.bridge.protocol import ActionResult
from voxkin.config import VoxkinConfig
from voxkin.events import MetricsStore
from voxkin.llm.openai_compat import OpenAICompatLLM
from voxkin.pipeline import ConversationPipeline
from voxkin.voice.cache import SpeechCache


@pytest.fixture
async def llm_port():
    app = build_app(delay_ms=5)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    try:
        yield port
    finally:
        await runner.cleanup()


def make_config(port: int) -> VoxkinConfig:
    config = VoxkinConfig()
    config.llm.api_key = "test-key"
    config.llm.base_url = f"http://127.0.0.1:{port}/v1"
    config.persona.system_prompt = "你是一个简洁的中文伙伴。"
    return config


async def test_turn_produces_audio_and_latency_marks(llm_port, tmp_path):
    config = make_config(llm_port)
    llm = OpenAICompatLLM(config.llm)
    tts = ToneTTS(delay_s=0.005)
    sink = WavDirSink(tmp_path)
    pipeline = ConversationPipeline(config, llm, tts, sink, MetricsStore())
    await pipeline.start()
    try:
        summary = await pipeline.respond("你好，介绍一下现在的计划。")
    finally:
        await pipeline.close()

    marks = summary["marks"]
    assert "t2_llm_first_token" in marks
    assert "t3_first_sentence" in marks
    assert "t5_first_audio" in marks
    assert "t6_playback_start" in marks
    assert marks["t2_llm_first_token"] <= marks["t3_first_sentence"] <= marks["t5_first_audio"]
    assert summary["first_audible_ms"] is not None
    assert summary["meta"]["spoken"]
    assert list(tmp_path.glob("*.wav"))


async def test_spoken_text_matches_sentences(llm_port, tmp_path):
    config = make_config(llm_port)
    tts = ToneTTS(delay_s=0.001)
    pipeline = ConversationPipeline(
        config, OpenAICompatLLM(config.llm), tts, WavDirSink(tmp_path), MetricsStore()
    )
    await pipeline.start()
    try:
        summary = await pipeline.respond("说说你在矿洞看到的东西。")
    finally:
        await pipeline.close()
    assert tts.texts
    assert "熔岩" in summary["meta"]["spoken"] or "矿洞" in summary["meta"]["spoken"]


async def test_new_request_interrupts_previous_turn(llm_port, tmp_path):
    config = make_config(llm_port)
    tts = ToneTTS(chunk_ms=400, delay_s=0.02)
    pipeline = ConversationPipeline(
        config, OpenAICompatLLM(config.llm), tts, WavDirSink(tmp_path), MetricsStore()
    )
    await pipeline.start()
    try:
        first = asyncio.create_task(pipeline.respond("第一句话请慢慢说。"))
        await asyncio.sleep(0.08)
        second = asyncio.create_task(pipeline.respond("先停一下，我们换个话题。"))
        first_summary, second_summary = await asyncio.gather(first, second)
    finally:
        await pipeline.close()
    assert first_summary["meta"].get("interrupted") == "superseded"
    assert second_summary["first_audible_ms"] is not None
    assert tts.stopped


async def test_history_keeps_user_and_assistant(llm_port, tmp_path):
    config = make_config(llm_port)
    pipeline = ConversationPipeline(
        config,
        OpenAICompatLLM(config.llm),
        ToneTTS(delay_s=0.001),
        WavDirSink(tmp_path),
        MetricsStore(),
    )
    await pipeline.start()
    try:
        await pipeline.respond("记住我喜欢在夜晚挖矿。")
    finally:
        await pipeline.close()
    roles = [item["role"] for item in pipeline.history]
    assert roles.count("user") == 1
    assert roles.count("assistant") == 1


async def test_pipeline_persists_turns_to_memory(llm_port, tmp_path):
    from voxkin.memory import MemoryStore

    config = make_config(llm_port)
    config.memory.db_path = str(tmp_path / "memory.db")
    config.memory.summarize_threshold = 99
    store = MemoryStore(config.memory)
    store.initialize()
    pipeline = ConversationPipeline(
        config,
        OpenAICompatLLM(config.llm),
        ToneTTS(delay_s=0.001),
        WavDirSink(tmp_path),
        MetricsStore(),
        memory=store,
    )
    await pipeline.start()
    try:
        await pipeline.respond("记住我喜欢在夜晚挖矿。")
    finally:
        await pipeline.close()
    assert store.counts()["turns"] == 2
    turns = store.recent_turns()
    assert turns[0]["role"] == "user"
    assert turns[1]["role"] == "assistant"
    store.close()


async def wait_until(predicate, timeout: float = 3.0) -> bool:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if predicate():
            return True
        await asyncio.sleep(0.01)
    return bool(predicate())


async def make_cache(tmp_path, key: str, text: str) -> SpeechCache:
    cache = SpeechCache(tmp_path / "voice_cache", "test-voice")
    await cache.put(
        key,
        text,
        [np.full(3200, 1200, dtype=np.int16)],
        sample_rate=32000,
        engine="tone",
    )
    return cache


class FakeController:
    """动作仲裁器的测试替身：记录提交的动作，取消时回取消结果。"""

    def __init__(self) -> None:
        self.tickets: list[ActionTicket] = []
        self.cancels: list[str] = []
        self._pending: dict[str, asyncio.Future] = {}

    async def submit(self, ticket: ActionTicket) -> ActionResult:
        self.tickets.append(ticket)
        future = asyncio.get_running_loop().create_future()
        self._pending[ticket.action_id] = future
        result = await future
        if not result.ok and result.status != "partial":
            raise ActionError(
                f"动作 {ticket.tool} 执行失败: {result.detail}", status=result.status
            )
        return result

    async def cancel_all(self, reason: str) -> list[str]:
        self.cancels.append(reason)
        ids = list(self._pending)
        for action_id, future in self._pending.items():
            if not future.done():
                future.set_result(
                    ActionResult(
                        action_id=action_id, ok=False, detail="已取消", status="cancelled"
                    )
                )
        return ids

    async def wait_cancelled(self, action_ids: list[str], timeout_s: float = 5.0) -> bool:
        return True

    def status(self) -> dict:
        return {"tracked": len(self.tickets)}

    def finish(self, action_id: str, detail: str = "挖到 3 块泥土") -> None:
        future = self._pending.get(action_id)
        if future is not None and not future.done():
            future.set_result(
                ActionResult(action_id=action_id, ok=True, detail=detail, status="succeeded")
            )

    def release_all(self) -> None:
        for action_id, future in self._pending.items():
            if not future.done():
                future.set_result(
                    ActionResult(
                        action_id=action_id, ok=False, detail="已取消", status="cancelled"
                    )
                )


async def test_stop_cancels_the_running_action(llm_port, tmp_path):
    """停止类指令要停掉正在跑的动作，只停语音不算数。"""
    config = make_config(llm_port)
    controller = FakeController()
    pipeline = ConversationPipeline(
        config,
        OpenAICompatLLM(config.llm),
        ToneTTS(delay_s=0.001),
        RecordingSink(),
        MetricsStore(),
    )
    pipeline.set_action_controller(controller)
    await pipeline.start()
    try:
        await pipeline.respond("停下")
        assert await wait_until(lambda: bool(controller.tickets))
    finally:
        controller.release_all()
        await pipeline.close()

    assert controller.cancels == ["玩家要求停止"]
    assert controller.tickets[0].tool == "stop"


async def test_speech_interrupt_does_not_cancel_the_action(llm_port, tmp_path):
    """语音打断只停说话，动作要继续跑。"""
    config = make_config(llm_port)
    controller = FakeController()
    pipeline = ConversationPipeline(
        config,
        OpenAICompatLLM(config.llm),
        ToneTTS(delay_s=0.001),
        RecordingSink(),
        MetricsStore(),
    )
    pipeline.set_action_controller(controller)
    await pipeline.start()
    try:
        await pipeline.respond("挖三块泥土")
        assert await wait_until(lambda: bool(controller.tickets))
        await pipeline.respond("你刚才说什么")
        await asyncio.sleep(0.05)
    finally:
        controller.release_all()
        await pipeline.close()

    assert controller.cancels == []


async def test_superseded_turn_does_not_announce_the_action_result(llm_port, tmp_path):
    """旧回合的动作结果不能播报进已经取代它的新回合。"""
    config = make_config(llm_port)
    tts = ToneTTS(delay_s=0.001)
    controller = FakeController()
    pipeline = ConversationPipeline(
        config, OpenAICompatLLM(config.llm), tts, RecordingSink(), MetricsStore()
    )
    pipeline.set_action_controller(controller)
    await pipeline.start()
    try:
        await pipeline.respond("挖三块泥土")
        assert await wait_until(lambda: bool(controller.tickets))
        await pipeline.respond("你刚才说什么")
        controller.finish(controller.tickets[0].action_id, "挖到 3 块泥土")
        await asyncio.sleep(0.15)
    finally:
        controller.release_all()
        await pipeline.close()

    assert not any(text.startswith("好了，") for text in tts.texts)


async def test_action_result_is_announced_when_the_turn_is_still_current(llm_port, tmp_path):
    """回合没被取代时，动作完成照常播报。"""
    config = make_config(llm_port)
    tts = ToneTTS(delay_s=0.001)
    controller = FakeController()
    pipeline = ConversationPipeline(
        config, OpenAICompatLLM(config.llm), tts, RecordingSink(), MetricsStore()
    )
    pipeline.set_action_controller(controller)
    await pipeline.start()
    try:
        await pipeline.respond("挖三块泥土")
        assert await wait_until(lambda: bool(controller.tickets))
        controller.finish(controller.tickets[0].action_id, "挖到 3 块泥土")
        assert await wait_until(
            lambda: any(text.startswith("好了，") for text in tts.texts)
        )
    finally:
        controller.release_all()
        await pipeline.close()


async def test_fast_path_uses_cached_ack_without_tts(llm_port, tmp_path):
    config = make_config(llm_port)
    cache = await make_cache(tmp_path, "ack.collect_blocks#count=3", "好，我去挖三块。")
    tts = ToneTTS(delay_s=0.001)
    sink = RecordingSink()
    calls: list[dict] = []

    async def handle(call, turn):
        calls.append(call)
        return "挖到 3 块泥土"

    pipeline = ConversationPipeline(
        config,
        OpenAICompatLLM(config.llm),
        tts,
        sink,
        MetricsStore(),
        cache=cache,
    )
    pipeline.set_action_handler(handle)
    await pipeline.start()
    try:
        summary = await pipeline.respond("挖三块泥土")
        assert await wait_until(lambda: bool(calls))
    finally:
        await pipeline.close()

    assert summary["meta"]["ack_source"] == "cache"
    assert "好，我去挖三块。" not in tts.texts
    assert calls[0]["name"] == "collect_blocks"
    assert calls[0]["arguments"] == {"block": "dirt", "count": 3}
    assert sink.total_frames > 0


async def test_fast_path_marks_action_and_audio_timeline(llm_port, tmp_path):
    config = make_config(llm_port)
    cache = await make_cache(tmp_path, "ack.collect_blocks#count=3", "好，我去挖三块。")
    metrics = MetricsStore()
    calls: list[dict] = []

    async def handle(call, turn):
        calls.append(call)
        return "挖到 3 块泥土"

    pipeline = ConversationPipeline(
        config,
        OpenAICompatLLM(config.llm),
        ToneTTS(delay_s=0.001),
        RecordingSink(),
        metrics,
        cache=cache,
    )
    pipeline.set_action_handler(handle)
    await pipeline.start()
    try:
        await pipeline.respond("挖三块泥土")
        assert await wait_until(lambda: bool(calls))
        await asyncio.sleep(0.05)
    finally:
        await pipeline.close()

    record = metrics.recent()[0]
    marks = record["marks"]
    for name in (
        "t_cmd_final",
        "t_intent_done",
        "t_ack_ready",
        "t_audio_start",
        "t_action_submit",
        "t_action_start",
    ):
        assert name in marks, name
    assert marks["t_cmd_final"] <= marks["t_intent_done"]
    assert marks["t_action_submit"] <= marks["t_action_start"]
    assert record["ack_ready_ms"] is not None
    assert record["action_start_ms"] is not None


async def test_fast_path_dedupes_identical_llm_tool_call(llm_port, tmp_path):
    config = make_config(llm_port)
    cache = await make_cache(tmp_path, "ack.collect_blocks#count=3", "好，我去挖三块。")
    calls: list[dict] = []

    async def handle(call, turn):
        calls.append(call)
        return "挖到 3 泥土"

    pipeline = ConversationPipeline(
        config,
        OpenAICompatLLM(config.llm),
        ToneTTS(delay_s=0.001),
        RecordingSink(),
        MetricsStore(),
        cache=cache,
    )
    pipeline.set_action_handler(handle)
    await pipeline.start()
    try:
        summary = await pipeline.respond("ACTION 挖三块泥土")
        assert await wait_until(lambda: bool(calls))
        await asyncio.sleep(0.05)
    finally:
        await pipeline.close()

    assert len(calls) == 1
    assert summary["meta"]["deduped_actions"] == ["collect_blocks"]


async def test_fast_path_ignores_small_talk(llm_port, tmp_path):
    config = make_config(llm_port)
    calls: list[dict] = []

    async def handle(call, turn):
        calls.append(call)
        return "完成"

    pipeline = ConversationPipeline(
        config,
        OpenAICompatLLM(config.llm),
        ToneTTS(delay_s=0.001),
        RecordingSink(),
        MetricsStore(),
    )
    pipeline.set_action_handler(handle)
    await pipeline.start()
    try:
        summary = await pipeline.respond("今天天气不错")
    finally:
        await pipeline.close()

    assert calls == []
    assert "fast_path" not in summary["meta"]


async def test_fast_path_ignores_capability_question(llm_port, tmp_path):
    config = make_config(llm_port)
    calls: list[dict] = []

    async def handle(call, turn):
        calls.append(call)
        return "完成"

    pipeline = ConversationPipeline(
        config,
        OpenAICompatLLM(config.llm),
        ToneTTS(delay_s=0.001),
        RecordingSink(),
        MetricsStore(),
    )
    pipeline.set_action_handler(handle)
    await pipeline.start()
    try:
        await pipeline.respond("你会挖泥土吗")
    finally:
        await pipeline.close()

    assert calls == []


async def test_cache_miss_falls_back_to_dynamic_tts(llm_port, tmp_path):
    config = make_config(llm_port)
    tts = ToneTTS(delay_s=0.001)
    pipeline = ConversationPipeline(
        config, OpenAICompatLLM(config.llm), tts, RecordingSink(), MetricsStore()
    )
    await pipeline.start()
    try:
        summary = await pipeline.respond("挖三块泥土")
    finally:
        await pipeline.close()

    assert summary["meta"]["ack_source"] == "dynamic"
    assert "好。" in tts.texts


async def test_cached_ack_plays_when_tts_is_unavailable(llm_port, tmp_path):
    config = make_config(llm_port)
    cache = await make_cache(tmp_path, "ack.collect_blocks#count=3", "好，我去挖三块。")
    tts = BrokenTTS()
    sink = RecordingSink()
    calls: list[dict] = []

    async def handle(call, turn):
        calls.append(call)
        return "挖到 3 块泥土"

    pipeline = ConversationPipeline(
        config, OpenAICompatLLM(config.llm), tts, sink, MetricsStore(), cache=cache
    )
    pipeline.set_action_handler(handle)
    await pipeline.start()
    try:
        await pipeline.respond("挖三块泥土")
        assert await wait_until(lambda: bool(calls))
    finally:
        await pipeline.close()

    assert sink.total_frames > 0


async def test_ack_deadline_records_degradation(llm_port, tmp_path):
    config = make_config(llm_port)
    config.voice_cache.ack_deadline_ms = 50
    tts = SlowTTS(delay_s=0.5)
    pipeline = ConversationPipeline(
        config, OpenAICompatLLM(config.llm), tts, RecordingSink(), MetricsStore()
    )
    await pipeline.start()
    try:
        summary = await pipeline.respond("挖三块泥土")
    finally:
        await pipeline.close()

    assert summary["meta"]["ack_source"] == "deadline_exceeded"
