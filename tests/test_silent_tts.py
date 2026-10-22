import asyncio

from voxkin.audio.sinks import WavDirSink
from voxkin.config import VoxkinConfig
from voxkin.events import MetricsStore
from voxkin.pipeline import ConversationPipeline
from voxkin.runtime import Runtime
from voxkin.services import ServiceSupervisor
from voxkin.tts.base import TTSError
from voxkin.tts.silent import SilentTTS


def test_silent_tts_reports_not_ready():
    tts = SilentTTS(reason="服务没起来")
    described = tts.describe()
    assert described["engine"] == "silent"
    assert described["adapter_ready"] is False
    assert "服务没起来" in described["reason"]


def test_silent_tts_records_text_without_audio():
    tts = SilentTTS()
    asyncio.run(tts.initialize())

    async def collect() -> list:
        chunks = []
        async for chunk in tts.synthesize("今天先做石头"):
            chunks.append(chunk)
        return chunks

    assert asyncio.run(collect()) == []
    assert tts.spoken == ["今天先做石头"]


def test_pipeline_runs_with_silent_tts(tmp_path):
    config = VoxkinConfig()
    pipeline = ConversationPipeline(
        config, _StubLLM(), SilentTTS(), WavDirSink(tmp_path), MetricsStore()
    )

    async def scenario() -> None:
        await pipeline.start()
        try:
            await pipeline.announce("没有语音也要能继续跑")
        finally:
            await pipeline.close()

    asyncio.run(scenario())


class _StubLLM:
    """只满足流水线接口的空模型。"""

    def describe(self) -> dict:
        return {"provider": "test"}

    async def stream_chat(self, *args, **kwargs):
        return None

    async def close(self) -> None:
        return None


class _FailingTTS:
    """模拟语音合成服务没起来。"""

    sample_rate = 32000

    async def initialize(self) -> None:
        raise TTSError("服务没起来")

    def describe(self) -> dict:
        return {"engine": "test"}

    async def synthesize(self, text: str):
        return
        yield  # pragma: no cover

    async def stop(self) -> None:
        return None

    async def close(self) -> None:
        return None


def test_runtime_falls_back_to_silent_tts(tmp_path):
    config = VoxkinConfig()
    pipeline = ConversationPipeline(
        config, _StubLLM(), _FailingTTS(), WavDirSink(tmp_path), MetricsStore()
    )
    runtime = Runtime(
        config=config,
        llm=_StubLLM(),
        tts=pipeline.tts,
        sink=pipeline.sink,
        stt=None,
        vad=None,
        metrics=MetricsStore(),
        hub=None,
        dispatcher=None,
        pipeline=pipeline,
        supervisor=ServiceSupervisor(tmp_path / "services"),
    )

    async def scenario() -> None:
        await runtime.start()
        try:
            assert isinstance(runtime.tts, SilentTTS)
            assert runtime.tts.describe()["adapter_ready"] is False
        finally:
            await runtime.close()

    asyncio.run(scenario())
