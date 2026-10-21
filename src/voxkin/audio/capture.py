from __future__ import annotations

import queue
import threading
from typing import Any

import numpy as np


class Microphone:
    """16kHz 单声道麦克风采集，固定块长，供端点检测使用。"""

    def __init__(self, sample_rate: int = 16000, block_ms: int = 32, device: str = "") -> None:
        self.sample_rate = sample_rate
        self.block_size = int(sample_rate * block_ms / 1000)
        self.device = device
        self._queue: queue.Queue[np.ndarray] = queue.Queue()
        self._stream: Any = None
        self._lock = threading.Lock()

    @staticmethod
    def list_devices() -> list[dict[str, Any]]:
        import sounddevice as sd

        result = []
        for index, device in enumerate(sd.query_devices()):
            if device["max_input_channels"] > 0:
                result.append(
                    {
                        "index": index,
                        "name": device["name"],
                        "channels": device["max_input_channels"],
                        "default_samplerate": device["default_samplerate"],
                    }
                )
        return result

    def start(self) -> None:
        import sounddevice as sd

        with self._lock:
            if self._stream is not None:
                return
            self._stream = sd.InputStream(
                samplerate=self.sample_rate,
                channels=1,
                dtype="int16",
                blocksize=self.block_size,
                device=self.device or None,
                callback=self._callback,
            )
            self._stream.start()

    def _callback(self, indata, frames, time_info, status) -> None:
        if status:
            raise RuntimeError(f"麦克风状态异常: {status}")
        self._queue.put(indata[:, 0].copy())

    def read(self, timeout: float = 1.0) -> np.ndarray | None:
        try:
            return self._queue.get(timeout=timeout)
        except queue.Empty:
            return None

    def close(self) -> None:
        with self._lock:
            if self._stream is not None:
                self._stream.stop()
                self._stream.close()
                self._stream = None
