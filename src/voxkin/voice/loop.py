from __future__ import annotations

import asyncio
import time
from typing import Any

from voxkin.audio.capture import Microphone
from voxkin.pipeline import ConversationPipeline
from voxkin.stt.vad import VadSegmenter
from voxkin.stt.whisper import WhisperSTT


class VoiceLoop:
    """麦克风 → 端点检测 → 识别 → 对话管线；检测到新语音时立即打断旧回复。"""

    def __init__(
        self,
        pipeline: ConversationPipeline,
        stt: WhisperSTT,
        vad: VadSegmenter,
        microphone: Microphone,
        emit=None,
    ) -> None:
        self.pipeline = pipeline
        self.stt = stt
        self.vad = vad
        self.microphone = microphone
        self.emit = emit
        self._running = False
        self.last_transcript: str = ""
        self.last_stt_ms: float | None = None

    async def run(self) -> None:
        await asyncio.to_thread(self.stt.load)
        await asyncio.to_thread(self.microphone.start)
        self._running = True
        while self._running:
            chunk = await asyncio.to_thread(self.microphone.read, 0.5)
            if chunk is None:
                continue
            was_active = self.vad._active
            utterances = self.vad.feed(chunk)
            if self.vad._active and not was_active and self.pipeline.is_speaking:
                await self.pipeline.interrupt("barge_in")
            for utterance in utterances:
                await self._handle_utterance(utterance)

    async def _handle_utterance(self, pcm) -> None:
        speech_end = time.perf_counter()
        text = await asyncio.to_thread(self.stt.transcribe, pcm)
        self.last_transcript = text
        self.last_stt_ms = round((time.perf_counter() - speech_end) * 1000, 1)
        if self.emit is not None:
            await self.emit(
                {
                    "type": "stt_final",
                    "text": text,
                    "stt_ms": self.last_stt_ms,
                }
            )
        if not text:
            return
        await self.pipeline.respond(text)

    def stop(self) -> None:
        self._running = False
        self.microphone.close()

    def status(self) -> dict[str, Any]:
        return {
            "running": self._running,
            "last_transcript": self.last_transcript,
            "last_stt_ms": self.last_stt_ms,
            "vad_threshold": self.vad.threshold_ratio,
        }
