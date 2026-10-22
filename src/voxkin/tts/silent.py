from __future__ import annotations

import logging
from typing import Any, AsyncIterator

import numpy as np

logger = logging.getLogger("voxkin")


class SilentTTS:
    """语音合成不可用时的降级适配器：只记日志，不出声。

    自主任务（`/api/run/*`）不依赖语音，合成服务挂掉不应该让整个 Core 起不来。
    `describe()` 会如实报告 `adapter_ready=False`，不会假装已经合成成功。
    """

    def __init__(self, reason: str = "语音合成服务不可用") -> None:
        self.sample_rate = 32000
        self.reason = reason
        self.spoken: list[str] = []

    async def initialize(self) -> None:
        logger.warning("TTS 降级为日志输出: %s", self.reason)

    def describe(self) -> dict[str, Any]:
        return {
            "engine": "silent",
            "adapter_ready": False,
            "reason": self.reason,
            "sample_rate": self.sample_rate,
        }

    async def synthesize(self, text: str) -> AsyncIterator[np.ndarray]:
        self.spoken.append(text)
        logger.info("（无语音）%s", text)
        return
        yield  # pragma: no cover - 让函数保持异步生成器语义

    async def stop(self) -> None:
        return None

    async def close(self) -> None:
        return None
