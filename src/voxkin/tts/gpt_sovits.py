from __future__ import annotations

import asyncio
import struct
from pathlib import Path
from typing import Any, AsyncIterator

import aiohttp
import numpy as np

from voxkin.config import TTSConfig


class TTSError(RuntimeError):
    pass


def parse_wav_header(header: bytes) -> tuple[int, int]:
    """返回 (采样率, 数据起点)。GPT-SoVITS 流式响应首块是 44 字节标准 WAV 头。"""
    if len(header) < 44 or header[:4] != b"RIFF" or header[8:12] != b"WAVE":
        raise TTSError("GPT-SoVITS 返回的数据不是 WAV 流")
    channels = struct.unpack_from("<H", header, 22)[0]
    sample_rate = struct.unpack_from("<I", header, 24)[0]
    bits = struct.unpack_from("<H", header, 34)[0]
    if channels != 1 or bits != 16:
        raise TTSError(f"仅支持单声道 16 位音频，收到 channels={channels} bits={bits}")
    offset = 12
    while offset + 8 <= len(header):
        chunk_id = header[offset : offset + 4]
        chunk_size = struct.unpack_from("<I", header, offset + 4)[0]
        if chunk_id == b"data":
            return sample_rate, offset + 8
        offset += 8 + chunk_size
    raise TTSError("WAV 头中找不到 data 块")


class GPTSoVITSClient:
    """对接 GPT-SoVITS api_v2 的流式语音客户端，复用现有音色权重与参考音频。"""

    capability = {
        "streaming_audio": True,
        "streaming_text": False,
        "word_timestamps": False,
        "emotion_control": False,
    }

    def __init__(self, config: TTSConfig) -> None:
        self.config = config
        self.base_url = config.base_url.rstrip("/")
        self.sample_rate = config.sample_rate
        self._session: aiohttp.ClientSession | None = None
        self._response: aiohttp.ClientResponse | None = None
        self._lock = asyncio.Lock()
        self.last_first_chunk_seconds: float | None = None

    def describe(self) -> dict[str, Any]:
        return {
            "engine": "gpt_sovits",
            "character": self.config.character,
            "base_url": self.base_url,
            "reference_audio": self.config.reference_audio,
            "text_lang": self.config.text_lang,
            "prompt_lang": self.config.prompt_lang,
            "sample_rate": self.sample_rate,
            "capability": self.capability,
            "loaded": self._session is not None and not self._session.closed,
            "adapter_ready": self._session is not None,
        }

    def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            timeout = aiohttp.ClientTimeout(total=None, sock_connect=5, sock_read=self.config.timeout_s)
            self._session = aiohttp.ClientSession(
                timeout=timeout, connector=aiohttp.TCPConnector(force_close=True)
            )
        return self._session

    async def initialize(self) -> None:
        reference = Path(self.config.reference_audio)
        if not reference.exists():
            raise TTSError(f"参考音频不存在: {reference}")
        session = self._get_session()
        try:
            async with session.get(self.base_url + "/openapi.json") as response:
                if response.status != 200:
                    raise TTSError(f"GPT-SoVITS 服务不可用: HTTP {response.status}")
        except aiohttp.ClientConnectorError as error:
            raise TTSError(
                f"无法连接 GPT-SoVITS 服务 {self.base_url}，请先启动 api_v2.py"
            ) from error

    def _payload(self, text: str) -> dict[str, Any]:
        return {
            "text": text,
            "text_lang": self.config.text_lang,
            "ref_audio_path": str(Path(self.config.reference_audio).resolve()),
            "prompt_text": self.config.reference_text,
            "prompt_lang": self.config.prompt_lang,
            "text_split_method": "cut5",
            "batch_size": 1,
            "speed_factor": 1.0,
            "media_type": "wav",
            "streaming_mode": True,
        }

    async def synthesize(self, text: str) -> AsyncIterator[np.ndarray]:
        async with self._lock:
            session = self._get_session()
            async with session.post(self.base_url + "/tts", json=self._payload(text)) as response:
                self._response = response
                if response.status != 200:
                    body = await response.text()
                    raise TTSError(f"GPT-SoVITS 合成失败: HTTP {response.status} {body[:300]}")
                buffer = b""
                started_reading = False
                pending = b""
                async for chunk in response.content.iter_any():
                    if not started_reading:
                        buffer += chunk
                        if len(buffer) < 44:
                            continue
                        self.sample_rate, data_offset = parse_wav_header(buffer)
                        chunk = buffer[data_offset:]
                        started_reading = True
                        buffer = b""
                    data = pending + chunk
                    even = len(data) - (len(data) % 2)
                    pending = data[even:]
                    if even == 0:
                        continue
                    yield np.frombuffer(data[:even], dtype=np.int16)

    async def stop(self) -> None:
        if self._response is not None and not self._response.closed:
            self._response.close()

    async def close(self) -> None:
        await self.stop()
        if self._session is not None and not self._session.closed:
            await self._session.close()
