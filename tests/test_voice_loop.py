import asyncio
from queue import Empty, Queue
from types import SimpleNamespace
from unittest.mock import AsyncMock

import numpy as np
import pytest

from voxkin.voice.loop import VoiceLoop


@pytest.mark.asyncio
async def test_microphone_keeps_the_whole_interruption_while_reply_is_in_flight():
    chunks = Queue()
    voice = np.full(64, 12000, dtype=np.int16)
    first_started = asyncio.Event()
    replies = []
    heard = []
    active = []

    def read(timeout):
        try:
            return chunks.get(timeout=timeout)
        except Empty:
            return None

    def feed(chunk):
        heard.append(int(chunk[0]))
        return [chunk] if len(heard) in (1, 3) else []

    async def respond(text, request_id):
        active.append(request_id)
        assert len(active) == 1
        try:
            if text == "第一句":
                pipeline.is_audible = True
                first_started.set()
                await asyncio.Event().wait()
            return {"text": text}
        finally:
            active.remove(request_id)

    async def interrupt(reason, **kwargs):
        pipeline.is_audible = False

    async def on_status(kind, payload):
        if kind == "reply":
            replies.append(payload["summary"])
            loop.stop()

    texts = iter(["第一句", "第二句"])
    pipeline = SimpleNamespace(is_audible=False, respond=respond, interrupt=AsyncMock(side_effect=interrupt))
    mic = SimpleNamespace(start=lambda: None, read=read, close=lambda: chunks.put(None))
    stt = SimpleNamespace(load=lambda: None, transcribe=lambda _pcm: next(texts))
    loop = VoiceLoop(pipeline, stt, SimpleNamespace(_active=False, feed=feed), mic, on_status=on_status)
    loop._calibrate = AsyncMock()
    run = asyncio.create_task(loop.run())
    try:
        chunks.put(voice)
        await asyncio.wait_for(first_started.wait(), 2)
        chunks.put(voice)
        chunks.put(voice)
        await asyncio.wait_for(run, 3)
    finally:
        loop.stop()
        await asyncio.gather(run, return_exceptions=True)
    pipeline.interrupt.assert_any_await("barge_in")
    assert heard == [12000] * 3
    assert replies == [{"text": "第二句"}]
    assert active == []
