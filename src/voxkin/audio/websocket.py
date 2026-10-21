from __future__ import annotations

import json
from typing import Awaitable, Callable

import numpy as np

from voxkin.audio.sinks import AudioSink

Sender = Callable[[bytes | str], Awaitable[None]]


class WebSocketAudioSink(AudioSink):
    """把 PCM 分块广播给已连接的 Minecraft 客户端 Mod。"""

    def __init__(self, sample_rate: int = 32000) -> None:
        super().__init__()
        self.sample_rate = sample_rate
        self._clients: set[Sender] = set()
        self._sequence = 0

    def describe(self) -> dict:
        return {
            "output": "websocket",
            "sample_rate": self.sample_rate,
            "clients": len(self._clients),
        }

    def attach(self, sender: Sender) -> None:
        self._clients.add(sender)

    def detach(self, sender: Sender) -> None:
        self._clients.discard(sender)

    async def start(self) -> None:
        return None

    async def play(self, turn_id: str, pcm: np.ndarray) -> None:
        self._sequence += 1
        header = json.dumps(
            {
                "type": "pcm",
                "turn_id": turn_id,
                "seq": self._sequence,
                "sample_rate": self.sample_rate,
                "channels": 1,
                "format": "s16le",
                "bytes": int(pcm.nbytes),
            },
            ensure_ascii=False,
        )
        payload = pcm.astype(np.int16).tobytes()
        for sender in list(self._clients):
            await sender(header)
            await sender(payload)

    async def flush(self) -> None:
        message = json.dumps({"type": "flush"})
        for sender in list(self._clients):
            await sender(message)

    async def close(self) -> None:
        self._clients.clear()
