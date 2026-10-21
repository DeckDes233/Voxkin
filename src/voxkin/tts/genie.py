from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any, AsyncIterator

import numpy as np

from voxkin.config import TTSConfig
from voxkin.tts.base import TTSError

SAMPLE_RATE = 32000


class GenieTTS:
    """Genie TTS 适配器。

    只支持与 Genie 词表一致的 GPT-SoVITS 模型；v2Pro（phoneme_vocab_size=512）
    模型无法直接加载，原因见 docs/TECH_EVALUATION.md。
    """

    capability = {
        "streaming_audio": True,
        "streaming_text": True,
        "word_timestamps": False,
        "emotion_control": False,
    }

    def __init__(self, config: TTSConfig) -> None:
        self.config = config
        self.sample_rate = SAMPLE_RATE
        self._genie: Any = None
        self._lock = asyncio.Lock()
        self._loaded = False
        self.load_seconds: float | None = None
        self._active = False

    @property
    def character(self) -> str:
        return self.config.character

    def describe(self) -> dict[str, Any]:
        return {
            "engine": "genie",
            "character": self.config.character,
            "model_dir": self.config.model_dir,
            "reference_audio": self.config.reference_audio,
            "sample_rate": self.sample_rate,
            "loaded": self._loaded,
            "load_seconds": self.load_seconds,
            "capability": self.capability,
        }

    async def initialize(self) -> None:
        if self._loaded:
            return
        model_dir = Path(self.config.model_dir)
        if not model_dir.exists():
            raise TTSError(f"模型目录不存在: {model_dir}")
        reference = Path(self.config.reference_audio)
        if not reference.exists():
            raise TTSError(f"参考音频不存在: {reference}")
        if not self.config.reference_text:
            raise TTSError("缺少参考音频文本 reference_text，Genie 需要参考音频与对应文本")
        await asyncio.to_thread(self._load_blocking)
        self._loaded = True

    def _load_blocking(self) -> None:
        import time

        if self.config.genie_data_dir:
            os.environ["GENIE_DATA_DIR"] = str(Path(self.config.genie_data_dir).resolve())
        import genie_tts as genie

        started = time.perf_counter()
        genie.load_character(
            character_name=self.config.character,
            onnx_model_dir=str(Path(self.config.model_dir).resolve()),
            language=self.config.language,
        )
        genie.set_reference_audio(
            character_name=self.config.character,
            audio_path=str(Path(self.config.reference_audio).resolve()),
            audio_text=self.config.reference_text,
            language=self.config.language,
        )
        self._genie = genie
        self.load_seconds = round(time.perf_counter() - started, 3)

    async def synthesize(self, text: str) -> AsyncIterator[np.ndarray]:
        if not self._loaded:
            await self.initialize()
        async with self._lock:
            self._active = True
            try:
                iterator = self._genie.tts_async(
                    character_name=self.config.character,
                    text=text,
                    split_sentence=False,
                )
                async for chunk in iterator:
                    if not chunk:
                        continue
                    yield np.frombuffer(chunk, dtype=np.int16)
            finally:
                self._active = False

    async def stop(self) -> None:
        if self._genie is None:
            return
        await asyncio.to_thread(self._genie.stop)

    async def close(self) -> None:
        await self.stop()
