from __future__ import annotations

import asyncio
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Iterable

MARK_ORDER = (
    "t0_speech_end",
    "t1_stt_final",
    "t2_llm_first_token",
    "t3_first_sentence",
    "t4_tts_first_text",
    "t5_first_audio",
    "t6_playback_start",
    "t7_action_start",
    "t8_action_done",
)


@dataclass
class TurnTimeline:
    request_id: str
    created_at: float = field(default_factory=time.time)
    marks: dict[str, float] = field(default_factory=dict)
    meta: dict[str, Any] = field(default_factory=dict)
    error: str = ""

    @classmethod
    def start(cls, request_id: str | None = None) -> "TurnTimeline":
        return cls(request_id=request_id or uuid.uuid4().hex[:12])

    def mark(self, name: str, value: float | None = None) -> float:
        if name in self.marks:
            return self.marks[name]
        stamp = value if value is not None else time.perf_counter()
        self.marks[name] = stamp
        return stamp

    def has(self, name: str) -> bool:
        return name in self.marks

    def latency(self, begin: str, end: str) -> float | None:
        if begin not in self.marks or end not in self.marks:
            return None
        return round((self.marks[end] - self.marks[begin]) * 1000.0, 1)

    def summary(self) -> dict[str, Any]:
        return {
            "request_id": self.request_id,
            "stt_ms": self.latency("t0_speech_end", "t1_stt_final"),
            "llm_ttft_ms": self.latency("t1_stt_final", "t2_llm_first_token"),
            "first_sentence_ms": self.latency("t1_stt_final", "t3_first_sentence"),
            "tts_queue_ms": self.latency("t3_first_sentence", "t4_tts_first_text"),
            "tts_first_audio_ms": self.latency("t4_tts_first_text", "t5_first_audio"),
            "first_audible_ms": self.latency("t0_speech_end", "t6_playback_start"),
            "action_start_ms": self.latency("t1_stt_final", "t7_action_start"),
            "action_done_ms": self.latency("t1_stt_final", "t8_action_done"),
            "marks": {k: round(v, 4) for k, v in self.marks.items()},
            "error": self.error,
            "meta": self.meta,
        }


def percentile(values: Iterable[float], ratio: float) -> float | None:
    data = sorted(v for v in values if v is not None)
    if not data:
        return None
    if len(data) == 1:
        return round(data[0], 1)
    position = (len(data) - 1) * ratio
    low = int(position)
    high = min(low + 1, len(data) - 1)
    weight = position - low
    return round(data[low] * (1 - weight) + data[high] * weight, 1)


class MetricsStore:
    def __init__(self, capacity: int = 200):
        self._lock = threading.Lock()
        self._turns: list[dict[str, Any]] = []
        self._capacity = capacity

    def add(self, timeline: TurnTimeline) -> None:
        record = timeline.summary()
        with self._lock:
            self._turns.append(record)
            if len(self._turns) > self._capacity:
                self._turns = self._turns[-self._capacity :]

    def update(self, timeline: TurnTimeline) -> None:
        record = timeline.summary()
        with self._lock:
            for index, existing in enumerate(self._turns):
                if existing.get("request_id") == record["request_id"]:
                    self._turns[index] = record
                    return
            self._turns.append(record)
            if len(self._turns) > self._capacity:
                self._turns = self._turns[-self._capacity :]

    def recent(self, limit: int = 20) -> list[dict[str, Any]]:
        with self._lock:
            return list(reversed(self._turns[-limit:]))

    def aggregate(self) -> dict[str, Any]:
        with self._lock:
            turns = list(self._turns)
        fields = (
            "stt_ms",
            "llm_ttft_ms",
            "first_sentence_ms",
            "tts_first_audio_ms",
            "first_audible_ms",
        )
        result: dict[str, Any] = {"count": len(turns)}
        for name in fields:
            values = [t[name] for t in turns if t.get(name) is not None]
            result[name] = {
                "p50": percentile(values, 0.5),
                "p90": percentile(values, 0.9),
                "min": round(min(values), 1) if values else None,
                "max": round(max(values), 1) if values else None,
            }
        return result


class EventHub:
    """对话事件的多订阅者分发，用于实时推送到 Studio 与桥接进程。"""

    def __init__(self, queue_size: int = 512) -> None:
        self._subscribers: set[asyncio.Queue] = set()
        self._queue_size = queue_size

    def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=self._queue_size)
        self._subscribers.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self._subscribers.discard(queue)

    async def publish(self, payload: dict[str, Any]) -> None:
        for queue in list(self._subscribers):
            if queue.full():
                queue.get_nowait()
            queue.put_nowait(payload)
