from __future__ import annotations

import asyncio
import time
from typing import Any, Awaitable, Callable

from voxkin.audio.capture import Microphone
from voxkin.pipeline import ConversationPipeline
from voxkin.stt.vad import VadSegmenter
from voxkin.stt.whisper import WhisperSTT

StatusCallback = Callable[[str, dict[str, Any]], Awaitable[None]]


class VoiceLoop:
    """麦克风 → 端点检测 → 识别 → 对话管线；播放期间只对更响的语音让路。"""

    def __init__(
        self,
        pipeline: ConversationPipeline,
        stt: WhisperSTT,
        vad: VadSegmenter,
        microphone: Microphone,
        emit=None,
        barge_in: bool = True,
        barge_in_rms: float = 0.08,
        gain: float = 1.0,
        playback_cooldown_s: float = 0.9,
        on_status: StatusCallback | None = None,
    ) -> None:
        self.pipeline = pipeline
        self.stt = stt
        self.vad = vad
        self.microphone = microphone
        self.emit = emit
        self.barge_in = barge_in
        self.barge_in_rms = barge_in_rms
        self.gain = gain
        self.playback_cooldown_s = playback_cooldown_s
        self._resume_at = 0.0
        self._was_speaking = False
        self.on_status = on_status
        self._running = False
        self.last_transcript = ""
        self.last_stt_ms: float | None = None

    async def _status(self, kind: str, payload: dict[str, Any]) -> None:
        if self.on_status is not None:
            await self.on_status(kind, payload)

    async def run(self, listen_only: bool = False) -> None:
        await asyncio.to_thread(self.stt.load)
        await asyncio.to_thread(self.microphone.start)
        await self._calibrate()
        self._running = True
        await self._status("ready", self.status())
        while self._running:
            chunk = await asyncio.to_thread(self.microphone.read, 0.5)
            if chunk is None:
                continue
            chunk = self._apply_gain(chunk)
            speaking = self.pipeline.is_audible
            if self._was_speaking and not speaking:
                self._resume_at = time.monotonic() + self.playback_cooldown_s
            self._was_speaking = speaking
            if not speaking and time.monotonic() < self._resume_at:
                continue
            if speaking:
                if not self.barge_in:
                    continue
                if self._rms(chunk) < self.barge_in_rms:
                    continue
                await self.pipeline.interrupt("barge_in")
                await self._status("barge_in", {})
            was_active = self.vad._active
            utterances = self.vad.feed(chunk)
            if self.vad._active and not was_active:
                await self._status("speech_start", {})
            for utterance in utterances:
                await self._handle_utterance(utterance, listen_only)

    async def _handle_utterance(self, pcm, listen_only: bool) -> None:
        speech_end = time.perf_counter()
        text = await asyncio.to_thread(self.stt.transcribe, pcm)
        self.last_transcript = text
        self.last_stt_ms = round((time.perf_counter() - speech_end) * 1000, 1)
        await self._status("transcript", {"text": text, "stt_ms": self.last_stt_ms})
        if self.emit is not None:
            await self.emit({"type": "stt_final", "text": text, "stt_ms": self.last_stt_ms})
        if not text or listen_only:
            return
        summary = await self.pipeline.respond(text)
        await self._status("reply", {"summary": summary})

    async def _calibrate(self) -> None:
        samples = []
        border = time.monotonic() + 1.2
        while time.monotonic() < border:
            chunk = await asyncio.to_thread(self.microphone.read, 0.3)
            if chunk is not None:
                samples.append(self._rms(self._apply_gain(chunk)))
        if samples:
            samples.sort()
            self.vad.calibrate(samples[len(samples) // 2])

    def _apply_gain(self, chunk):
        if self.gain == 1.0:
            return chunk
        import numpy as np

        boosted = chunk.astype(np.float32) * self.gain
        return np.clip(boosted, -32768, 32767).astype(np.int16)

    @staticmethod
    def _rms(chunk) -> float:
        import numpy as np

        data = chunk.astype(np.float32) / 32768.0
        return float(np.sqrt(np.mean(np.square(data))))

    def stop(self) -> None:
        self._running = False
        self.microphone.close()

    def status(self) -> dict[str, Any]:
        return {
            "running": self._running,
            "last_transcript": self.last_transcript,
            "last_stt_ms": self.last_stt_ms,
            "barge_in": self.barge_in,
        }
