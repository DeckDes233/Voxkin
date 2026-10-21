from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, AsyncIterator

from voxkin.agent.actions import ActionDispatcher
from voxkin.audio.sinks import AudioSink, build_sink
from voxkin.config import VoxkinConfig
from voxkin.events import EventHub, MetricsStore
from voxkin.llm.base import LLMAdapter, LLMDelta, LLMError
from voxkin.llm.openai_compat import OpenAICompatLLM
from voxkin.pipeline import ConversationPipeline
from voxkin.services import ServiceSpec, ServiceSupervisor
from voxkin.stt.vad import VadSegmenter
from voxkin.stt.whisper import WhisperSTT
from voxkin.tts import build_tts
from voxkin.tts.base import TTSAdapter


class MissingKeyLLM:
    """未配置凭据时的占位适配器：调用即失败，状态接口如实报告未配置。"""

    def __init__(self, config: VoxkinConfig) -> None:
        self.config = config

    def describe(self) -> dict[str, Any]:
        return {
            "provider": "unconfigured",
            "model": self.config.llm.model,
            "base_url": self.config.llm.base_url,
            "api_key_configured": False,
        }

    async def stream_chat(self, messages) -> AsyncIterator[LLMDelta]:
        raise LLMError(
            "LLM 未配置：设置环境变量 "
            f"{self.config.llm.api_key_env} 或写入 config/local.yaml 的 llm.api_key"
        )
        yield LLMDelta(kind="done")

    async def close(self) -> None:
        return None


@dataclass
class Runtime:
    config: VoxkinConfig
    llm: LLMAdapter
    tts: TTSAdapter
    sink: AudioSink
    stt: WhisperSTT
    vad: VadSegmenter
    metrics: MetricsStore
    hub: EventHub
    dispatcher: ActionDispatcher
    pipeline: ConversationPipeline
    supervisor: ServiceSupervisor

    @classmethod
    async def create(cls, config: VoxkinConfig) -> "Runtime":
        hub = EventHub()
        metrics = MetricsStore()
        if config.llm.resolve_api_key():
            llm: LLMAdapter = OpenAICompatLLM(config.llm)
        else:
            llm = MissingKeyLLM(config)
        tts = build_tts(config.tts)
        if config.audio.output == "minecraft_file":
            sink = build_sink(
                "minecraft_file",
                directory=config.audio.minecraft_audio_dir,
                lead_s=config.audio.segment_lead_s,
            )
        elif config.audio.output == "wav_dir":
            sink = build_sink("wav_dir", directory=config.audio.wav_dir)
        else:
            sink = build_sink(
                "speaker",
                sample_rate=48000,
                device=config.audio.device,
                volume=config.audio.volume,
            )
        pipeline = ConversationPipeline(
            config=config,
            llm=llm,
            tts=tts,
            sink=sink,
            metrics=metrics,
            emit=hub.publish,
        )
        dispatcher = ActionDispatcher()

        async def handle_action(call: dict[str, Any], turn) -> str:
            return await dispatcher.dispatch(call["name"], call.get("arguments") or {})

        pipeline.set_action_handler(handle_action)
        supervisor = ServiceSupervisor(Path("logs") / "services")
        if config.tts.manage_service:
            supervisor.register(
                ServiceSpec(
                    name="tts",
                    command=list(config.tts.start_command),
                    cwd=config.tts.working_dir or str(Path.cwd()),
                    health_url=config.tts.health_url,
                )
            )
        runtime = cls(
            config=config,
            llm=llm,
            tts=tts,
            sink=sink,
            stt=WhisperSTT(config.stt),
            vad=VadSegmenter.from_config(config.stt),
            metrics=metrics,
            hub=hub,
            dispatcher=dispatcher,
            pipeline=pipeline,
            supervisor=supervisor,
        )
        return runtime

    async def services_status(self) -> dict[str, Any]:
        return await self.supervisor.status()

    async def start(self) -> None:
        await self.pipeline.start()

    def status(self) -> dict[str, Any]:
        return {
            "llm": self.llm.describe(),
            "tts": self.tts.describe(),
            "stt": self.stt.describe(),
            "audio": self.sink.describe(),
            "metrics": self.metrics.aggregate(),
            "speaking": self.pipeline.is_speaking,
            "bridge": {
                "connected": self.dispatcher.connected,
                "name": self.dispatcher.bridge_name,
                "pending_actions": self.dispatcher.pending_count,
            },
            "persona": self.config.persona.name,
            "project_root": str(Path.cwd()),
        }

    async def close(self) -> None:
        try:
            await self.pipeline.close()
        finally:
            await self.supervisor.close()
