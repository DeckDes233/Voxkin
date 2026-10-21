from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from voxkin.config import STTConfig


@dataclass
class VadSegmenter:
    """基于能量的端点检测：自适应噪声底、最短语音、最短静音与最长语句限制。"""

    sample_rate: int = 16000
    frame_size: int = 512
    threshold_ratio: float = 3.0
    min_rms: float = 0.004
    min_speech_ms: int = 320
    min_silence_ms: int = 640
    max_utterance_s: float = 20.0
    noise_floor: float = 0.01
    _buffer: list[np.ndarray] = field(default_factory=list)
    _speech_frames: int = 0
    _silence_frames: int = 0
    _active: bool = False
    _frames: int = 0
    _remainder: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=np.float32))

    @classmethod
    def from_config(cls, config: STTConfig) -> "VadSegmenter":
        return cls(
            sample_rate=config.sample_rate,
            min_speech_ms=config.vad_min_speech_ms,
            min_silence_ms=config.vad_min_silence_ms,
            max_utterance_s=config.max_utterance_s,
            threshold_ratio=max(1.5, config.vad_threshold * 4.0),
        )

    def calibrate(self, noise_rms: float) -> None:
        """用启动时测到的环境噪声设置阈值。"""
        floor = max(0.0005, noise_rms)
        self.noise_floor = floor
        self.min_rms = max(0.0015, floor * 1.5)
        self.threshold_ratio = 2.0

    def _frame_rms(self, frame: np.ndarray) -> float:
        return float(np.sqrt(np.mean(np.square(frame, dtype=np.float64))))

    def feed(self, pcm: np.ndarray) -> list[np.ndarray]:
        if pcm.dtype != np.float32:
            pcm = pcm.astype(np.float32) / 32768.0
        data = np.concatenate([self._remainder, pcm]) if self._remainder.size else pcm
        utterances: list[np.ndarray] = []
        offset = 0
        while offset + self.frame_size <= data.size:
            frame = data[offset : offset + self.frame_size]
            offset += self.frame_size
            rms = self._frame_rms(frame)
            if not self._active:
                if rms < self.noise_floor * 1.2:
                    self.noise_floor = 0.98 * self.noise_floor + 0.02 * rms
            self._frames += 1
            is_speech = rms > max(self.min_rms, self.noise_floor * self.threshold_ratio)
            if not self._active:
                if is_speech:
                    self._speech_frames += 1
                    self._buffer.append(frame)
                    if self._speech_frames * self.frame_size >= self.sample_rate * self.min_speech_ms / 1000:
                        self._active = True
                        self._silence_frames = 0
                else:
                    self._speech_frames = 0
                    self._buffer.clear()
                continue
            self._buffer.append(frame)
            if is_speech:
                self._silence_frames = 0
                self._speech_frames += 1
            else:
                self._silence_frames += 1
                required = int(self.sample_rate * self.min_silence_ms / 1000 / self.frame_size)
                if self._silence_frames >= required:
                    utterance = np.concatenate(self._buffer)
                    utterances.append(utterance)
                    self._reset()
                    continue
            if len(self._buffer) * self.frame_size > self.sample_rate * self.max_utterance_s:
                utterance = np.concatenate(self._buffer)
                utterances.append(utterance)
                self._reset()
        self._remainder = data[offset:]
        return utterances

    def _reset(self) -> None:
        self._buffer.clear()
        self._speech_frames = 0
        self._silence_frames = 0
        self._active = False

    def flush(self) -> list[np.ndarray]:
        if not self._active or not self._buffer:
            self._reset()
            return []
        utterance = np.concatenate(self._buffer)
        self._reset()
        return [utterance]
