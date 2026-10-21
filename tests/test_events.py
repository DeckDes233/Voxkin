import asyncio

import numpy as np
import pytest

from voxkin.events import EventHub, MetricsStore, TurnTimeline, percentile


def test_marks_are_idempotent():
    timeline = TurnTimeline.start("abc")
    first = timeline.mark("t0_speech_end", 1.0)
    second = timeline.mark("t0_speech_end", 2.0)
    assert first == second == 1.0


def test_latency_conversion_to_milliseconds():
    timeline = TurnTimeline.start()
    timeline.mark("t0_speech_end", 10.0)
    timeline.mark("t6_playback_start", 12.345)
    summary = timeline.summary()
    assert summary["first_audible_ms"] == 2345.0
    assert summary["stt_ms"] is None


def test_percentile_interpolates():
    values = [10.0, 20.0, 30.0]
    assert percentile(values, 0.5) == 20.0
    assert percentile(values, 0.9) == 28.0
    assert percentile([], 0.5) is None


def test_metrics_store_keeps_recent_and_aggregates():
    store = MetricsStore(capacity=2)
    for index in range(3):
        turn = TurnTimeline.start(f"id{index}")
        turn.mark("t0_speech_end", 0.0)
        turn.mark("t1_stt_final", 0.1 + index * 0.01)
        turn.mark("t6_playback_start", 2.0)
        store.add(turn)
    recent = store.recent()
    assert len(recent) == 2
    assert recent[0]["request_id"] == "id2"
    aggregate = store.aggregate()
    assert aggregate["count"] == 2
    assert aggregate["first_audible_ms"]["p50"] == 2000.0


async def test_event_hub_drops_oldest_when_full():
    hub = EventHub(queue_size=2)
    queue = hub.subscribe()
    for index in range(3):
        await hub.publish({"index": index})
    assert queue.qsize() == 2
    assert queue.get_nowait()["index"] == 1
    hub.unsubscribe(queue)
    await hub.publish({"index": 9})
    assert queue.qsize() == 1
