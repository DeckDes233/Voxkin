import asyncio
from typing import Any, AsyncIterator

import numpy as np


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
