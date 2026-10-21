from __future__ import annotations

import asyncio
import queue
import threading
import time
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Callable

import numpy as np


def resample_pcm(pcm: np.ndarray, source_rate: int, target_rate: int) -> np.ndarray:
    if source_rate == target_rate or pcm.size == 0:
        return pcm
    duration = pcm.size / source_rate
    target_length = int(round(duration * target_rate))
    source_positions = np.arange(target_length, dtype=np.float64) * (source_rate / target_rate)
    result = np.interp(source_positions, np.arange(pcm.size), pcm.astype(np.float32))
    return result.astype(np.int16)


class AudioSink(ABC):
    sample_rate: int = 32000

    def __init__(self) -> None:
        self._on_playback_start: Callable[[str, float], None] | None = None

    def set_playback_start_callback(self, callback: Callable[[str, float], None]) -> None:
        self._on_playback_start = callback

    def _notify_playback_start(self, turn_id: str) -> None:
        if self._on_playback_start is not None:
            self._on_playback_start(turn_id, time.perf_counter())

    def is_playing(self) -> bool:
        return False

    @abstractmethod
    async def start(self) -> None: ...

    @abstractmethod
    async def play(self, turn_id: str, pcm: np.ndarray) -> None: ...

    @abstractmethod
    async def flush(self) -> None: ...

    @abstractmethod
    async def close(self) -> None: ...

    @abstractmethod
    def describe(self) -> dict: ...


class SpeakerSink(AudioSink):
    """通过 PortAudio 直接播放，端到端延迟最低。"""

    def __init__(self, sample_rate: int = 48000, device: str = "", volume: float = 1.0) -> None:
        super().__init__()
        self.sample_rate = sample_rate
        self.device = device
        self.volume = volume
        self._queue: queue.Queue[tuple[str, np.ndarray] | None] = queue.Queue()
        self._thread: threading.Thread | None = None
        self._started_turns: set[str] = set()
        self._error: BaseException | None = None
        self._pending = 0
        self._pending_lock = threading.Lock()

    def describe(self) -> dict:
        return {"output": "speaker", "sample_rate": self.sample_rate, "device": self.device or "default"}

    def is_playing(self) -> bool:
        with self._pending_lock:
            return self._pending > 0

    async def start(self) -> None:
        import sounddevice as sd

        devices = sd.query_devices()
        if self.device:
            matches = [d for d in devices if self.device in d["name"]]
            if not matches:
                raise RuntimeError(f"找不到音频输出设备: {self.device}")
        self._thread = threading.Thread(target=self._run, name="voxkin-speaker", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        import sounddevice as sd

        stream = sd.OutputStream(
            samplerate=self.sample_rate,
            channels=1,
            dtype="int16",
            blocksize=1024,
        )
        stream.start()
        try:
            while True:
                item = self._queue.get()
                if item is None:
                    break
                turn_id, pcm = item
                if turn_id not in self._started_turns:
                    self._started_turns.add(turn_id)
                    self._notify_playback_start(turn_id)
                if self.volume != 1.0:
                    pcm = (pcm.astype(np.float32) * self.volume).clip(-32768, 32767).astype(np.int16)
                try:
                    stream.write(pcm)
                finally:
                    with self._pending_lock:
                        self._pending = max(0, self._pending - 1)
        finally:
            stream.stop()
            stream.close()

    async def play(self, turn_id: str, pcm: np.ndarray) -> None:
        with self._pending_lock:
            self._pending += 1
        self._queue.put((turn_id, resample_pcm(pcm, 32000, self.sample_rate)))

    async def flush(self) -> None:
        while True:
            try:
                self._queue.get_nowait()
            except queue.Empty:
                break
        with self._pending_lock:
            self._pending = 0

    async def close(self) -> None:
        self._queue.put(None)
        if self._thread is not None:
            self._thread.join(timeout=5)


class WavDirSink(AudioSink):
    """把每轮语音写为 WAV 文件，用于没有声卡时的基准测试与人工试听。"""

    def __init__(self, directory: Path, sample_rate: int = 32000) -> None:
        super().__init__()
        self.directory = Path(directory)
        self.sample_rate = sample_rate
        self._sequence: dict[str, int] = {}
        self._chunks: dict[str, list[np.ndarray]] = {}

    def describe(self) -> dict:
        return {"output": "wav_dir", "directory": str(self.directory), "sample_rate": self.sample_rate}

    async def start(self) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)

    async def play(self, turn_id: str, pcm: np.ndarray) -> None:
        self._chunks.setdefault(turn_id, []).append(pcm)
        if turn_id not in self._sequence:
            self._sequence[turn_id] = 0
            self._notify_playback_start(turn_id)
        self._sequence[turn_id] += 1
        import wave

        path = self.directory / f"{turn_id}_{self._sequence[turn_id]:03d}.wav"
        with wave.open(str(path), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(self.sample_rate)
            handle.writeframes(pcm.tobytes())

    async def flush(self) -> None:
        return None

    async def close(self) -> None:
        return None


class MinecraftFileSink(AudioSink):
    """把语音写成交接给现有 Minecraft 音频 Mod 的 WAV 分段。

    现有 Mod 通过监听目录内的 .wav 新建事件播放音频，同一时间到达的文件会互相重叠，
    因此这里按照音频时长节流写入，保证分段顺序。
    """

    def __init__(self, directory: Path, sample_rate: int = 32000, lead_s: float = 0.05) -> None:
        super().__init__()
        self.directory = Path(directory)
        self.sample_rate = sample_rate
        self.lead_s = lead_s
        self._next_allowed = 0.0
        self._counter = 0

    def describe(self) -> dict:
        return {
            "output": "minecraft_file",
            "directory": str(self.directory),
            "sample_rate": self.sample_rate,
        }

    async def start(self) -> None:
        self.directory.mkdir(parents=True, exist_ok=True)

    async def play(self, turn_id: str, pcm: np.ndarray) -> None:
        import wave

        now = time.perf_counter()
        wait = self._next_allowed - now
        if wait > 0:
            await asyncio.sleep(wait)
        self._counter += 1
        path = self.directory / f"voxkin_{int(time.time() * 1000)}_{self._counter:04d}.wav"
        with wave.open(str(path), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(self.sample_rate)
            handle.writeframes(pcm.tobytes())
        duration = pcm.size / self.sample_rate
        self._next_allowed = time.perf_counter() + duration - self.lead_s
        self._notify_playback_start(turn_id)

    async def flush(self) -> None:
        self._next_allowed = 0.0

    async def close(self) -> None:
        return None


def build_sink(choice: str, **kwargs) -> AudioSink:
    if choice == "speaker":
        return SpeakerSink(
            sample_rate=kwargs.get("sample_rate", 48000),
            device=kwargs.get("device", ""),
            volume=kwargs.get("volume", 1.0),
        )
    if choice == "wav_dir":
        return WavDirSink(Path(kwargs["directory"]))
    if choice == "minecraft_file":
        return MinecraftFileSink(Path(kwargs["directory"]), lead_s=kwargs.get("lead_s", 0.05))
    if choice == "websocket":
        from voxkin.audio.websocket import WebSocketAudioSink

        return WebSocketAudioSink(sample_rate=kwargs.get("sample_rate", 32000))
    raise ValueError(f"未知的音频输出方式: {choice}")
