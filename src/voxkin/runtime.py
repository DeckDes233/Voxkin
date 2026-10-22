from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, AsyncIterator

from voxkin.agent.actions import ActionDispatcher
from voxkin.agent.arbiter import ActionArbiter, ActionTicket
from voxkin.agent.run_manager import RunManager
from voxkin.agent.tasks import TaskStore
from voxkin.audio.sinks import AudioSink, build_sink
from voxkin.audio.capture import Microphone
from voxkin.config import VoxkinConfig
from voxkin.events import EventHub, MetricsStore
from voxkin.llm.base import LLMAdapter, LLMDelta, LLMError
from voxkin.llm.openai_compat import OpenAICompatLLM
from voxkin.memory import MemoryStore, MemoryWriter
from voxkin.pipeline import ConversationPipeline
from voxkin.services import ServiceSpec, ServiceSupervisor
from voxkin.stt.vad import VadSegmenter
from voxkin.stt.whisper import WhisperSTT
from voxkin.tts import build_tts
from voxkin.tts.base import TTSAdapter, TTSError
from voxkin.tts.silent import SilentTTS
from voxkin.voice.loop import VoiceLoop

logger = logging.getLogger("voxkin")


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
    arbiter: ActionArbiter | None = None
    memory: MemoryStore | None = None
    run_manager: RunManager | None = None
    voice_loop: VoiceLoop | None = None
    voice_task: asyncio.Task | None = None
    mic_state: str = "stopped"
    last_mic_reply: str = ""

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
        elif config.audio.output == "websocket":
            sink = build_sink("websocket", sample_rate=32000)
        else:
            sink = build_sink(
                "speaker",
                sample_rate=48000,
                device=config.audio.device,
                volume=config.audio.volume,
            )
        dispatcher = ActionDispatcher()
        arbiter = ActionArbiter(dispatcher, on_event=hub.publish)

        async def dispatch_task(
            tool: str, arguments: dict[str, Any], timeout_s: float | None = None
        ) -> Any:
            """任务步骤也走仲裁器：同一个世界里只允许一个动作在改世界。"""
            ticket = ActionTicket(
                tool=tool,
                arguments=dict(arguments or {}),
                origin="task",
                timeout_s=float(timeout_s or 0.0),
            )
            return await arbiter.submit(ticket)
        store: MemoryStore | None = None
        writer: MemoryWriter | None = None
        if config.memory.enabled:
            store = MemoryStore(config.memory)
            store.initialize()
            if isinstance(llm, OpenAICompatLLM):
                writer = MemoryWriter(store, llm, config.memory)
        pipeline = ConversationPipeline(
            config=config,
            llm=llm,
            tts=tts,
            sink=sink,
            metrics=metrics,
            emit=hub.publish,
            memory=store,
            memory_writer=writer,
        )

        pipeline.set_action_controller(arbiter)
        pipeline.set_state_provider(dispatcher.state_snapshot)
        task_store = TaskStore(Path("data") / "tasks.db")
        task_store.initialize()
        run_manager = RunManager(
            dispatch=dispatch_task,
            state_provider=dispatcher.state_snapshot,
            announce=pipeline.announce,
            store=task_store,
        )
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
            arbiter=arbiter,
            pipeline=pipeline,
            supervisor=supervisor,
            memory=store,
            run_manager=run_manager,
        )
        return runtime

    async def services_status(self) -> dict[str, Any]:
        return await self.supervisor.status()

    async def _on_mic_status(self, kind: str, payload: dict[str, Any]) -> None:
        if kind == "transcript":
            await self.hub.publish({"type": "mic_transcript", **payload})
        elif kind == "reply":
            summary = payload["summary"]
            self.last_mic_reply = summary["meta"].get("spoken", "")
            await self.hub.publish({"type": "mic_reply", "summary": summary})
        elif kind == "ready":
            await self.hub.publish({"type": "mic_status", "state": "ready"})
        elif kind == "speech_start":
            await self.hub.publish({"type": "mic_speech_start"})
        elif kind == "barge_in":
            await self.hub.publish({"type": "mic_barge_in"})

    def mic_status(self) -> dict[str, Any]:
        loop = self.voice_loop
        return {
            "state": self.mic_state,
            "running": self.voice_task is not None and not self.voice_task.done(),
            "last_transcript": loop.last_transcript if loop is not None else "",
            "last_reply": self.last_mic_reply,
            "last_stt_ms": loop.last_stt_ms if loop is not None else None,
            "barge_in": self.config.stt.barge_in,
        }

    async def start_mic(self) -> dict[str, Any]:
        if self.voice_task is not None and not self.voice_task.done():
            return self.mic_status()
        self.voice_loop = VoiceLoop(
            pipeline=self.pipeline,
            stt=self.stt,
            vad=VadSegmenter.from_config(self.config.stt),
            microphone=Microphone(
                sample_rate=self.config.stt.sample_rate, device=self.config.stt.input_device
            ),
            emit=self.hub.publish,
            barge_in=self.config.stt.barge_in,
            gain=self.config.stt.input_gain,
            playback_cooldown_s=self.config.stt.playback_cooldown_s,
            on_status=self._on_mic_status,
        )
        self.mic_state = "starting"
        self.voice_task = asyncio.create_task(self._run_mic(), name="voxkin-mic")
        return self.mic_status()

    async def _run_mic(self) -> None:
        try:
            self.mic_state = "running"
            await self.voice_loop.run()
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self.mic_state = f"error: {error}"
            await self.hub.publish({"type": "mic_error", "error": str(error)})
            raise
        finally:
            if self.mic_state == "running" or self.mic_state == "starting":
                self.mic_state = "stopped"

    async def stop_mic(self) -> dict[str, Any]:
        if self.voice_loop is not None:
            self.voice_loop.stop()
        task = self.voice_task
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        self.voice_task = None
        self.mic_state = "stopped"
        return self.mic_status()

    async def start(self) -> None:
        try:
            await self.pipeline.start()
        except TTSError as error:
            # 语音合成挂掉不应该让整个 Core 起不来：自主任务与桥接动作都不依赖语音。
            logger.warning("TTS 不可用，语音输出降级为日志: %s", error)
            silent = SilentTTS(reason=str(error))
            self.pipeline.tts = silent
            self.tts = silent
            await self.pipeline.start()

    def status(self) -> dict[str, Any]:
        cache = self.pipeline.cache
        return {
            "llm": self.llm.describe(),
            "tts": self.tts.describe(),
            "stt": self.stt.describe(),
            "audio": self.sink.describe(),
            "metrics": self.metrics.aggregate(),
            "voice_cache": cache.describe() if cache is not None else {"enabled": False},
            "fast_path": {
                "enabled": self.config.fast_path.enabled,
                "min_confidence": self.config.fast_path.min_confidence,
                "action_min_confidence": self.config.fast_path.action_min_confidence,
            },
            "speaking": self.pipeline.is_speaking,
            "bridge": {
                "connected": self.dispatcher.connected,
                "name": self.dispatcher.bridge_name,
                "pending_actions": self.dispatcher.pending_count,
            },
            "arbiter": self.arbiter.status() if self.arbiter is not None else {"enabled": False},
            "memory": self.memory.counts() if self.memory is not None else {"enabled": False},
            "persona": self.config.persona.name,
            "project_root": str(Path.cwd()),
        }

    async def close(self) -> None:
        try:
            await self.stop_mic()
            if self.run_manager is not None:
                await self.run_manager.close()
            await self.pipeline.close()
        finally:
            await self.supervisor.close()
            if self.memory is not None:
                self.memory.close()
