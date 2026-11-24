import asyncio
import time
from typing import Any, AsyncIterator

import numpy as np

from voxkin.audio.sinks import AudioSink


class ToneTTS:
    """测试用确定性音频源：按句子产生等幅 PCM，用于验证管线时序与队列。"""

    sample_rate = 32000
    capability = {"streaming_audio": True, "streaming_text": True}

    def __init__(self, chunk_ms: int = 200, delay_s: float = 0.01) -> None:
        self.chunk_ms = chunk_ms
        self.delay_s = delay_s
        self.texts: list[str] = []
        self.stopped = False

    async def initialize(self) -> None:
        return None

    def describe(self) -> dict[str, Any]:
        return {"engine": "tone", "chunk_ms": self.chunk_ms}

    async def synthesize(self, text: str) -> AsyncIterator[np.ndarray]:
        self.texts.append(text)
        frames = int(self.sample_rate * self.chunk_ms / 1000)
        for _ in range(3):
            await asyncio.sleep(self.delay_s)
            yield np.full(frames, 1200, dtype=np.int16)

    async def stop(self) -> None:
        self.stopped = True

    async def close(self) -> None:
        return None


class BrokenTTS:
    """TTS 不可用时的替身：合成直接报错，用来验证降级路径。"""

    sample_rate = 32000
    capability = {"streaming_audio": False, "streaming_text": False}

    def __init__(self) -> None:
        self.texts: list[str] = []
        self.stopped = False

    async def initialize(self) -> None:
        return None

    def describe(self) -> dict[str, Any]:
        return {"engine": "broken"}

    async def synthesize(self, text: str) -> AsyncIterator[np.ndarray]:
        self.texts.append(text)
        raise RuntimeError("TTS 不可用")
        yield np.zeros(0, dtype=np.int16)

    async def stop(self) -> None:
        self.stopped = True

    async def close(self) -> None:
        return None


class SlowTTS(ToneTTS):
    """合成很慢的替身：用来触发确认语的截止时间兜底。"""

    def __init__(self, delay_s: float = 0.5, chunk_ms: int = 200) -> None:
        super().__init__(chunk_ms=chunk_ms, delay_s=delay_s)
        self.first_delay_s = delay_s

    async def synthesize(self, text: str) -> AsyncIterator[np.ndarray]:
        self.texts.append(text)
        await asyncio.sleep(self.first_delay_s)
        frames = int(self.sample_rate * self.chunk_ms / 1000)
        yield np.full(frames, 1200, dtype=np.int16)


class RecordingSink(AudioSink):
    """记录每次播放的块大小与时间，用来断言首音与动作的先后。"""

    def __init__(self, sample_rate: int = 32000) -> None:
        super().__init__()
        self.sample_rate = sample_rate
        self.plays: list[tuple[str, int, float]] = []
        self.flushes = 0

    async def start(self) -> None:
        return None

    async def play(self, turn_id: str, pcm: np.ndarray) -> None:
        self.plays.append((turn_id, int(pcm.size), time.perf_counter()))
        self._notify_playback_start(turn_id)

    async def flush(self) -> None:
        self.flushes += 1

    async def close(self) -> None:
        return None

    def describe(self) -> dict[str, Any]:
        return {"output": "recording", "sample_rate": self.sample_rate}

    @property
    def total_frames(self) -> int:
        return sum(size for _, size, _ in self.plays)
