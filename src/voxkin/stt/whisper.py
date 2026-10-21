from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import numpy as np

from voxkin.config import STTConfig
from voxkin.stt.normalize import to_simplified


class STTError(RuntimeError):
    pass


class WhisperSTT:
    """faster-whisper 本地识别，CPU int8 推理，模型常驻内存。"""

    def __init__(self, config: STTConfig) -> None:
        self.config = config
        self._model: Any = None
        self.load_seconds: float | None = None
        self.last_inference_seconds: float | None = None

    def describe(self) -> dict[str, Any]:
        return {
            "engine": "faster_whisper",
            "model": self.config.model,
            "device": self.config.device,
            "compute_type": self.config.compute_type,
            "language": self.config.language,
            "loaded": self._model is not None,
            "load_seconds": self.load_seconds,
        }

    def load(self) -> None:
        if self._model is not None:
            return
        from faster_whisper import WhisperModel

        started = time.perf_counter()
        self._model = WhisperModel(
            self.config.model,
            device=self.config.device,
            compute_type=self.config.compute_type,
        )
        self.load_seconds = round(time.perf_counter() - started, 3)

    def transcribe(self, pcm: np.ndarray, sample_rate: int = 16000) -> str:
        if self._model is None:
            self.load()
        if pcm.dtype != np.float32:
            audio = pcm.astype(np.float32) / 32768.0
        else:
            audio = pcm
        if sample_rate != 16000:
            raise STTError(f"Whisper 需要 16kHz 音频，收到 {sample_rate}")
        started = time.perf_counter()
        segments, _info = self._model.transcribe(
            audio,
            language=self.config.language,
            beam_size=self.config.beam_size,
            vad_filter=False,
            condition_on_previous_text=False,
        )
        text = "".join(segment.text for segment in segments).strip()
        if self.config.to_simplified and self.config.language.lower().startswith("zh"):
            text = to_simplified(text)
        self.last_inference_seconds = round(time.perf_counter() - started, 3)
        return text

    def transcribe_file(self, path: Path | str) -> dict[str, Any]:
        import soundfile as sf

        audio, rate = sf.read(str(path), dtype="float32")
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        if rate != 16000:
            raise STTError(f"参考文件采样率 {rate}，请先转为 16000Hz")
        started = time.perf_counter()
        text = self.transcribe(audio)
        return {
            "text": text,
            "total_ms": round((time.perf_counter() - started) * 1000, 1),
            "inference_s": self.last_inference_seconds,
        }
