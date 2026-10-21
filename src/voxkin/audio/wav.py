from __future__ import annotations

import io
import wave

import numpy as np


def pcm16_to_wav_bytes(pcm: bytes, sample_rate: int) -> bytes:
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(sample_rate)
        handle.writeframes(pcm)
    return buffer.getvalue()


def arrays_to_wav_bytes(chunks: list[np.ndarray], sample_rate: int) -> bytes:
    if not chunks:
        return pcm16_to_wav_bytes(b"", sample_rate)
    pcm = np.concatenate(chunks).astype(np.int16)
    return pcm16_to_wav_bytes(pcm.tobytes(), sample_rate)
