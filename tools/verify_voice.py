from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
import wave
from pathlib import Path

import numpy as np
from scipy.signal import resample_poly

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from voxkin.config import load_config  # noqa: E402
from voxkin.stt.vad import VadSegmenter  # noqa: E402
from voxkin.stt.whisper import WhisperSTT  # noqa: E402
from voxkin.tts import build_tts  # noqa: E402


def read_wav(path: Path) -> tuple[np.ndarray, int]:
    with wave.open(str(path), "rb") as handle:
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        rate = handle.getframerate()
        raw = handle.readframes(handle.getnframes())
    if width != 2:
        raise SystemExit(f"只支持 16 位 PCM，{path} 是 {width * 8} 位")
    audio = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    return audio, rate


async def verify_tts(text: str, out_dir: Path) -> dict:
    config = load_config()
    adapter = build_tts(config.tts)
    started = time.perf_counter()
    await adapter.initialize()
    ready = time.perf_counter() - started
    chunks: list[np.ndarray] = []
    first_chunk_at = None
    request_started = time.perf_counter()
    async for chunk in adapter.synthesize(text):
        if first_chunk_at is None:
            first_chunk_at = time.perf_counter() - request_started
        chunks.append(chunk)
    total = time.perf_counter() - request_started
    await adapter.stop()
    await adapter.close()
    if not chunks:
        raise SystemExit("TTS 没有返回任何音频分块")
    audio = np.concatenate(chunks)
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / "tts_sample.wav"
    with wave.open(str(target), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(config.tts.sample_rate)
        handle.writeframes((audio * 32767).astype("<i2").tobytes())
    seconds = len(audio) / config.tts.sample_rate
    return {
        "engine": config.tts.engine,
        "character": config.tts.character,
        "text": text,
        "initialize_s": round(ready, 3),
        "first_chunk_s": round(first_chunk_at or 0.0, 3),
        "total_s": round(total, 3),
        "chunks": len(chunks),
        "audio_s": round(seconds, 3),
        "rtf": round(total / max(seconds, 0.001), 3),
        "sample_wav": str(target),
        "adapter": adapter.describe(),
    }


def verify_stt(audio_path: Path) -> dict:
    config = load_config()
    audio, rate = read_wav(audio_path)
    if rate != 16000:
        audio = resample_poly(audio, 16000, rate).astype(np.float32)
    vad = VadSegmenter.from_config(config.stt)
    frames = 0
    utterances: list[np.ndarray] = []
    for start in range(0, len(audio) - vad.frame_size + 1, vad.frame_size):
        utterances.extend(vad.feed(audio[start : start + vad.frame_size]))
        frames += 1
    stt = WhisperSTT(config.stt)
    stt.load()
    started = time.perf_counter()
    text = stt.transcribe(audio, 16000)
    elapsed = time.perf_counter() - started
    return {
        "engine": config.stt.engine,
        "model": config.stt.model,
        "audio": str(audio_path),
        "audio_s": round(len(audio) / 16000, 3),
        "load_s": stt.load_seconds,
        "inference_s": round(elapsed, 3),
        "dropped_segments": stt.last_dropped_segments,
        "text": text,
        "vad_frames": frames,
        "vad_utterances": len(utterances),
        "describe": stt.describe(),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="实测语音合成与识别链路")
    parser.add_argument("--text", default="沃心已经进入世界，正在检查背包。")
    parser.add_argument("--audio", default=str(ROOT / "work" / "question.wav"))
    parser.add_argument("--out", default=str(ROOT / "work" / "voice_verify"))
    parser.add_argument("--skip-tts", action="store_true")
    parser.add_argument("--skip-stt", action="store_true")
    args = parser.parse_args()

    report: dict = {}
    if not args.skip_tts:
        report["tts"] = asyncio.run(verify_tts(args.text, Path(args.out)))
    if not args.skip_stt:
        report["stt"] = verify_stt(Path(args.audio))
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
