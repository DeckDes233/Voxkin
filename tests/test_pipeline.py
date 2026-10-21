import asyncio
import sys
from pathlib import Path

import pytest
from aiohttp import web

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from dev_llm_server import build_app

from support import ToneTTS
from voxkin.audio.sinks import WavDirSink
from voxkin.config import VoxkinConfig
from voxkin.events import MetricsStore
from voxkin.llm.openai_compat import OpenAICompatLLM
from voxkin.pipeline import ConversationPipeline


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
