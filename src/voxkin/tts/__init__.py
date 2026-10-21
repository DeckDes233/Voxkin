from __future__ import annotations

from voxkin.config import TTSConfig
from voxkin.tts.base import TTSAdapter, TTSError
from voxkin.tts.genie import GenieTTS
from voxkin.tts.gpt_sovits import GPTSoVITSClient


def build_tts(config: TTSConfig) -> TTSAdapter:
    if config.engine == "gpt_sovits":
        return GPTSoVITSClient(config)
    if config.engine == "genie":
        return GenieTTS(config)
    raise ValueError(f"未知的 TTS engine: {config.engine}")


__all__ = ["TTSAdapter", "TTSError", "build_tts"]
