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
    "t_cmd_final",
    "t_intent_done",
    "t2_llm_first_token",
    "t3_first_sentence",
    "t4_tts_first_text",
    "t_ack_ready",
    "t5_first_audio",
    "t6_playback_start",
    "t_audio_start",
    "t_action_submit",
    "t7_action_start",
    "t_action_start",
    "t_stop_sent",
    "t_stop_done",
    "t8_action_done",
)

# 新观测点与旧观测点指向同一件事时，同组的名字共享同一个时间戳。
# 这样补充观测点不会破坏 Studio 与已有测试对旧名字的依赖。
MARK_GROUPS = (
    ("t6_playback_start", "t_audio_start"),
    ("t7_action_start", "t_action_start"),
)

# 一次走完整动作的回合应该留下的观测点。缺任何一个都说明链路有一段没跑通。
FULL_TURN_MARKS = (
    "t0_speech_end",
    "t_cmd_final",
    "t_intent_done",
    "t_ack_ready",
    "t_audio_start",
    "t_action_submit",
    "t_action_start",
    "t8_action_done",
)


class TimelineIncomplete(ValueError):
    """时间线缺少必须的观测点；让链路缺口显式失败，而不是悄悄少一段。"""

    def __init__(self, missing: list[str]) -> None:
        self.missing = list(missing)
        super().__init__("时间线缺少观测点: " + ", ".join(self.missing))


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
        group = [name]
        for names in MARK_GROUPS:
            if name in names:
                group = list(names)
                break
        existing = next((self.marks[item] for item in group if item in self.marks), None)
        if existing is not None:
            stamp = existing
        else:
            stamp = value if value is not None else time.perf_counter()
        for item in group:
            self.marks[item] = stamp
        return stamp

    def has(self, name: str) -> bool:
        return name in self.marks

    def missing(self, names: Iterable[str] = FULL_TURN_MARKS) -> list[str]:
        """列出还没打上的观测点；顺序跟传入顺序一致。"""
        return [name for name in names if name not in self.marks]

    def require(self, names: Iterable[str] = FULL_TURN_MARKS) -> None:
        """缺少观测点时直接失败，避免拿半条时间线去做延迟结论。"""
        gap = self.missing(names)
        if gap:
            raise TimelineIncomplete(gap)

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
            "intent_ms": self.latency("t_cmd_final", "t_intent_done"),
            "ack_ready_ms": self.latency("t_cmd_final", "t_ack_ready"),
            "audio_start_ms": self.latency("t_cmd_final", "t_audio_start"),
            "action_submit_ms": self.latency("t_cmd_final", "t_action_submit"),
            "action_start_ms": self.latency("t_cmd_final", "t_action_start"),
            "stop_ms": self.latency("t_stop_sent", "t_stop_done"),
            "action_done_ms": self.latency("t_cmd_final", "t8_action_done"),
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
            "intent_ms",
            "ack_ready_ms",
            "audio_start_ms",
            "action_submit_ms",
            "action_start_ms",
            "stop_ms",
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
