import asyncio

import numpy as np
import pytest

from voxkin.events import (
    FULL_TURN_MARKS,
    EventHub,
    MetricsStore,
    TimelineIncomplete,
    TurnTimeline,
    percentile,
)


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


def test_alias_marks_share_one_timestamp():
    timeline = TurnTimeline.start()
    timeline.mark("t6_playback_start", 5.0)
    timeline.mark("t_audio_start", 9.0)
    assert timeline.marks["t6_playback_start"] == timeline.marks["t_audio_start"] == 5.0
    timeline.mark("t7_action_start", 7.0)
    timeline.mark("t_action_start", 11.0)
    assert timeline.marks["t7_action_start"] == timeline.marks["t_action_start"] == 7.0


def test_summary_reports_fast_path_latencies():
    timeline = TurnTimeline.start()
    timeline.mark("t0_speech_end", 0.0)
    timeline.mark("t_cmd_final", 0.1)
    timeline.mark("t_intent_done", 0.2)
    timeline.mark("t_ack_ready", 0.3)
    timeline.mark("t_audio_start", 0.4)
    timeline.mark("t_action_submit", 0.5)
    timeline.mark("t_action_start", 0.6)
    timeline.mark("t8_action_done", 1.0)
    summary = timeline.summary()
    assert summary["intent_ms"] == 100.0
    assert summary["ack_ready_ms"] == 200.0
    assert summary["audio_start_ms"] == 300.0
    assert summary["action_submit_ms"] == 400.0
    assert summary["action_start_ms"] == 500.0


def test_missing_marks_are_reported_and_fail_loudly():
    timeline = TurnTimeline.start()
    timeline.mark("t0_speech_end", 0.0)
    missing = timeline.missing(FULL_TURN_MARKS)
    assert "t_cmd_final" in missing
    with pytest.raises(TimelineIncomplete) as error:
        timeline.require(FULL_TURN_MARKS)
    assert "t_cmd_final" in str(error.value)


def test_require_passes_when_all_marks_present():
    timeline = TurnTimeline.start()
    for name in FULL_TURN_MARKS:
        timeline.mark(name)
    timeline.require(FULL_TURN_MARKS)
