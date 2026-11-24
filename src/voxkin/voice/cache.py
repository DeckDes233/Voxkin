from __future__ import annotations

import asyncio
import hashlib
import json
import time
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Iterator

import numpy as np

SIDECAR_SUFFIX = ".json"


def trim_silence(pcm: np.ndarray, threshold: int = 300) -> np.ndarray:
    """裁掉首尾静音，让缓存音频一上来就有声音。"""
    if pcm.size == 0:
        return pcm
    loud = np.flatnonzero(np.abs(pcm.astype(np.int32)) > threshold)
    if loud.size == 0:
        return pcm
    return pcm[loud[0] : loud[-1] + 1]


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(65536), b""):
            digest.update(block)
    return digest.hexdigest()


@dataclass(frozen=True)
class SpeechClip:
    """一条预合成语音。pcm 是 int16 单声道，播放时不再解码。"""

    key: str
    text: str
    pcm: np.ndarray
    sample_rate: int
    sha256: str
    duration_s: float
    lead_silence_ms: int
    voice_id: str
    engine: str = ""

    def chunks(self, chunk_ms: int = 200) -> Iterator[np.ndarray]:
        """按播放需要切成小块，WebSocket 与 WAV 输出都能顺序播放。"""
        if chunk_ms <= 0:
            yield self.pcm
            return
        size = max(1, int(self.sample_rate * chunk_ms / 1000))
        for start in range(0, self.pcm.size, size):
            yield self.pcm[start : start + size]


class SpeechCache:
    """确认语缓存：命中直接播放，不命中如实记账并走动态 TTS。"""

    def __init__(
        self,
        root: Path | str,
        voice_id: str,
        expected_engine: str = "",
        expected_reference_sha256: str = "",
    ) -> None:
        self.root = Path(root)
        self.voice_id = voice_id
        self.expected_engine = expected_engine
        self.expected_reference_sha256 = expected_reference_sha256
        self._clips: dict[str, SpeechClip] = {}
        self._hits = 0
        self._misses = 0
        self._miss_reasons: dict[str, int] = {}
        self._loaded_at = 0.0

    @property
    def directory(self) -> Path:
        return self.root / self.voice_id

    @property
    def count(self) -> int:
        return len(self._clips)

    def _record_miss(self, reason: str) -> None:
        self._misses += 1
        self._miss_reasons[reason] = self._miss_reasons.get(reason, 0) + 1

    def lookup(self, key: str) -> SpeechClip | None:
        clip, _ = self.lookup_with_reason(key)
        return clip

    def lookup_with_reason(self, key: str) -> tuple[SpeechClip | None, str]:
        clip = self._clips.get(key)
        if clip is not None:
            self._hits += 1
            return clip, "hit"
        reason = "not_cached"
        path = self.directory / f"{key}.wav"
        if path.exists():
            sidecar = self._read_sidecar(path)
            if sidecar is None:
                reason = "missing_sidecar"
            else:
                reason = self._validate(path, sidecar)
        self._record_miss(reason)
        return None, reason

    def _read_sidecar(self, audio_path: Path) -> dict[str, Any] | None:
        sidecar_path = audio_path.with_suffix(SIDECAR_SUFFIX)
        if not sidecar_path.exists():
            return None
        try:
            data = json.loads(sidecar_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        return data if isinstance(data, dict) else None

    def _validate(self, audio_path: Path, sidecar: dict[str, Any]) -> str:
        """返回空串表示可用，否则返回不匹配的原因。"""
        if str(sidecar.get("voice_id") or "") != self.voice_id:
            return "voice_mismatch"
        if self.expected_engine and str(sidecar.get("engine") or "") != self.expected_engine:
            return "engine_mismatch"
        if self.expected_reference_sha256 and str(
            sidecar.get("reference_audio_sha256") or ""
        ) != self.expected_reference_sha256:
            return "reference_mismatch"
        if str(sidecar.get("sha256") or "") != _file_sha256(audio_path):
            return "hash_mismatch"
        return ""

    def _load_clip(self, key: str, sidecar: dict[str, Any]) -> SpeechClip | None:
        audio_path = self.directory / f"{key}.wav"
        try:
            with wave.open(str(audio_path), "rb") as handle:
                if handle.getsampwidth() != 2 or handle.getnchannels() != 1:
                    return None
                frames = handle.readframes(handle.getnframes())
                sample_rate = handle.getframerate()
        except (OSError, wave.Error):
            return None
        pcm = np.frombuffer(frames, dtype=np.int16).copy()
        return SpeechClip(
            key=key,
            text=str(sidecar.get("text") or ""),
            pcm=pcm,
            sample_rate=int(sample_rate),
            sha256=str(sidecar.get("sha256") or ""),
            duration_s=round(pcm.size / sample_rate, 3) if sample_rate else 0.0,
            lead_silence_ms=int(sidecar.get("lead_silence_ms") or 0),
            voice_id=str(sidecar.get("voice_id") or ""),
            engine=str(sidecar.get("engine") or ""),
        )

    async def load(self, root: Path | str | None = None, voice_id: str | None = None) -> None:
        """异步预加载缓存目录；坏文件只记账，不让整个启动失败。"""
        if root is not None:
            self.root = Path(root)
        if voice_id is not None:
            self.voice_id = voice_id
        await asyncio.to_thread(self._load_sync)

    def _load_sync(self) -> None:
        self._clips = {}
        directory = self.directory
        if not directory.exists():
            self._loaded_at = time.time()
            return
        for audio_path in sorted(directory.glob("*.wav")):
            key = audio_path.stem
            sidecar = self._read_sidecar(audio_path)
            if sidecar is None:
                self._record_miss("missing_sidecar")
                continue
            reason = self._validate(audio_path, sidecar)
            if reason:
                self._record_miss(reason)
                continue
            clip = self._load_clip(key, sidecar)
            if clip is None:
                self._record_miss("corrupt_audio")
                continue
            self._clips[key] = clip
        self._loaded_at = time.time()

    async def put(
        self,
        key: str,
        text: str,
        chunks: Iterable[np.ndarray],
        sample_rate: int | None = None,
        engine: str = "",
        reference_audio_sha256: str = "",
        lead_silence_ms: int = 0,
    ) -> SpeechClip:
        """把一次合成结果写进缓存，并立刻可在内存里命中。"""
        pieces = [np.asarray(chunk, dtype=np.int16) for chunk in chunks]
        pcm = np.concatenate(pieces) if pieces else np.zeros(0, dtype=np.int16)
        if sample_rate is None:
            sample_rate = 32000
        trimmed = trim_silence(pcm)
        if trimmed.size:
            pcm = trimmed
        duration_s = round(pcm.size / sample_rate, 3) if sample_rate else 0.0
        directory = self.directory
        directory.mkdir(parents=True, exist_ok=True)
        audio_path = directory / f"{key}.wav"
        with wave.open(str(audio_path), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(int(sample_rate))
            handle.writeframes(pcm.tobytes())
        digest = _file_sha256(audio_path)
        sidecar = {
            "key": key,
            "text": text,
            "sha256": digest,
            "sample_rate": int(sample_rate),
            "duration_s": duration_s,
            "lead_silence_ms": int(lead_silence_ms),
            "voice_id": self.voice_id,
            "engine": engine,
            "reference_audio_sha256": reference_audio_sha256,
            "created_at": time.time(),
        }
        audio_path.with_suffix(SIDECAR_SUFFIX).write_text(
            json.dumps(sidecar, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        clip = SpeechClip(
            key=key,
            text=text,
            pcm=pcm,
            sample_rate=int(sample_rate),
            sha256=digest,
            duration_s=duration_s,
            lead_silence_ms=int(lead_silence_ms),
            voice_id=self.voice_id,
            engine=engine,
        )
        self._clips[key] = clip
        return clip

    def describe(self) -> dict[str, Any]:
        return {
            "voice_id": self.voice_id,
            "root": str(self.root),
            "count": self.count,
            "hits": self._hits,
            "misses": self._misses,
            "miss_reasons": dict(self._miss_reasons),
            "loaded_at": self._loaded_at,
        }
