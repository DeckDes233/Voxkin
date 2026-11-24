"""合成场景测量：把首音与动作的关键节点跑成可重复的记录。

覆盖六种情况：缓存未命中、缓存命中、动作成功、动作失败、停止、TTS 不可用。
这里用的是脚本化的模型与音频替身，测的是链路时序，不代表真实模型或真实 TTS 的延迟。

用法：
    .venv\Scripts\python.exe scripts\latency_scenarios.py
    .venv\Scripts\python.exe scripts\latency_scenarios.py --json work\latency_scenarios.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path
from typing import Any, AsyncIterator

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "src") not in sys.path:
    sys.path.insert(0, str(ROOT / "src"))

from voxkin.audio.sinks import AudioSink
from voxkin.config import VoxkinConfig
from voxkin.events import FULL_TURN_MARKS, MetricsStore, TurnTimeline
from voxkin.llm.base import LLMDelta
from voxkin.pipeline import ConversationPipeline
from voxkin.voice.cache import SpeechCache


class ScriptedLLM:
    """脚本化的模型替身：吐出固定文本，可选再带一次工具调用。"""

    def __init__(self, text: str = "我在呢。", tool_call: dict[str, Any] | None = None) -> None:
        self.text = text
        self.tool_call = tool_call

    async def stream_chat(
        self, messages, tools=None
    ) -> AsyncIterator[LLMDelta]:
        yield LLMDelta(kind="text", text=self.text)
        if self.tool_call is not None:
            yield LLMDelta(kind="tool_call", tool_call=self.tool_call)
        yield LLMDelta(kind="done")

    async def close(self) -> None:
        return None

    def describe(self) -> dict[str, Any]:
        return {"provider": "scripted"}


class ToneTTS:
    """等幅 PCM 替身。

    这里刻意不做真实延时：Windows 的事件循环定时粒度会把 5 毫秒的等待压成
    零点几毫秒，合成出来的毫秒数没有可比性。这个脚本只验证链路顺序、
    观测点齐全和「缓存命中不调用合成」这类结构事实；延迟结论以真实运行为准，
    记录在 docs/BENCHMARK_RESULTS.md。
    """

    sample_rate = 32000
    capability = {"streaming_audio": True, "streaming_text": True}

    def __init__(self, chunk_ms: int = 200) -> None:
        self.chunk_ms = chunk_ms
        self.texts: list[str] = []

    async def initialize(self) -> None:
        return None

    def describe(self) -> dict[str, Any]:
        return {"engine": "tone"}

    async def synthesize(self, text: str) -> AsyncIterator[np.ndarray]:
        self.texts.append(text)
        frames = int(self.sample_rate * self.chunk_ms / 1000)
        for _ in range(2):
            await asyncio.sleep(0)
            yield np.full(frames, 1200, dtype=np.int16)

    async def stop(self) -> None:
        return None

    async def close(self) -> None:
        return None


class BrokenTTS(ToneTTS):
    """TTS 不可用的替身：合成直接报错。"""

    async def synthesize(self, text: str) -> AsyncIterator[np.ndarray]:
        self.texts.append(text)
        raise RuntimeError("TTS 不可用")
        yield np.zeros(0, dtype=np.int16)


class RecordingSink(AudioSink):
    """记录播放块与时间，用来判断首音什么时候真正写出去。"""

    def __init__(self) -> None:
        super().__init__()
        self.sample_rate = 32000
        self.plays: list[tuple[str, int, float]] = []

    async def start(self) -> None:
        return None

    async def play(self, turn_id: str, pcm: np.ndarray) -> None:
        self.plays.append((turn_id, int(pcm.size), time.perf_counter()))
        self._notify_playback_start(turn_id)

    async def flush(self) -> None:
        return None

    async def close(self) -> None:
        return None

    def describe(self) -> dict[str, Any]:
        return {"output": "recording"}


ACTION_MARKS = [
    "t_cmd_final",
    "t_intent_done",
    "t_ack_ready",
    "t_audio_start",
    "t_action_submit",
    "t_action_start",
]


async def wait_for(predicate, timeout: float = 5.0) -> bool:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if predicate():
            return True
        await asyncio.sleep(0.01)
    return bool(predicate())


async def run_scenario(
    name: str,
    text: str,
    cache: SpeechCache | None,
    tts: Any,
    action: Any,
    llm_tool_call: dict[str, Any] | None = None,
    require_marks: list[str] | None = None,
) -> dict[str, Any]:
    config = VoxkinConfig()
    config.voice_cache.root = str(cache.root) if cache is not None else "work/voice_cache"
    config.voice_cache.voice_id = cache.voice_id if cache is not None else "scenario"
    metrics = MetricsStore()
    sink = RecordingSink()
    llm = ScriptedLLM(tool_call=llm_tool_call)
    pipeline = ConversationPipeline(
        config,
        llm,
        tts,
        sink,
        metrics,
        cache=cache,
    )
    calls: list[dict[str, Any]] = []

    async def handle(call, turn):
        calls.append(call)
        return await action(call, turn)

    pipeline.set_action_handler(handle)
    await pipeline.start()
    try:
        summary = await pipeline.respond(text)
        await wait_for(lambda: bool(calls) or not summary["meta"].get("fast_path"))
        await asyncio.sleep(0.05)
    finally:
        await pipeline.close()
    record = metrics.recent()[0] if metrics.recent() else summary
    marks = record.get("marks") or {}
    missing = [item for item in (require_marks or []) if item not in marks]
    mark_order = [key for key, _ in sorted(marks.items(), key=lambda item: item[1])]
    return {
        "scenario": name,
        "text": text,
        "ack_source": summary["meta"].get("ack_source", ""),
        "fast_path": summary["meta"].get("fast_path", {}),
        "actions": calls,
        "audio_blocks": len(sink.plays),
        "tts_calls": list(tts.texts),
        "marks": marks,
        "mark_order": mark_order,
        "latency": {
            "intent_ms": record.get("intent_ms"),
            "ack_ready_ms": record.get("ack_ready_ms"),
            "audio_start_ms": record.get("audio_start_ms"),
            "action_submit_ms": record.get("action_submit_ms"),
            "action_start_ms": record.get("action_start_ms"),
        },
        "missing_marks": missing,
        "meta": summary["meta"],
    }


async def succeed(call, turn) -> str:
    return "挖到 3 块泥土"


async def fail(call, turn) -> str:
    raise RuntimeError("附近 16 格内没有泥土")


async def main_async(output: Path) -> int:
    root = ROOT / "work" / "latency_scenarios"
    root.mkdir(parents=True, exist_ok=True)
    cache = SpeechCache(root / "voice_cache", "scenario-voice")
    await cache.put(
        "ack.collect_blocks",
        "好，我去挖。",
        [np.full(3200, 1200, dtype=np.int16)],
        sample_rate=32000,
        engine="tone",
    )
    empty_cache = SpeechCache(root / "voice_cache_empty", "scenario-voice")
    await empty_cache.load()

    scenarios = [
        await run_scenario(
            "cache_miss",
            "挖泥土",
            empty_cache,
            ToneTTS(),
            succeed,
            require_marks=ACTION_MARKS,
        ),
        await run_scenario(
            "cache_hit",
            "挖泥土",
            cache,
            ToneTTS(),
            succeed,
            require_marks=ACTION_MARKS,
        ),
        await run_scenario(
            "action_success",
            "挖泥土",
            cache,
            ToneTTS(),
            succeed,
            require_marks=ACTION_MARKS,
        ),
        await run_scenario(
            "action_failure",
            "挖泥土",
            cache,
            ToneTTS(),
            fail,
            require_marks=ACTION_MARKS,
        ),
        await run_scenario(
            "stop",
            "停下",
            None,
            ToneTTS(),
            succeed,
            require_marks=ACTION_MARKS,
        ),
        await run_scenario(
            "tts_unavailable",
            "挖泥土",
            cache,
            BrokenTTS(),
            succeed,
            require_marks=["t_ack_ready", "t_audio_start"],
        ),
    ]
    payload = {"generated_at": time.time(), "scenarios": scenarios}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    for item in scenarios:
        latency = item["latency"]
        print(
            f"{item['scenario']:<16} ack={item['ack_source']:<10} "
            f"动作={len(item['actions'])} 音频块={item['audio_blocks']} "
            f"合成次数={len(item['tts_calls'])}"
        )
        print(f"  顺序: {' -> '.join(item['mark_order'])}")
        if item["missing_marks"]:
            print(f"  缺少观测点: {', '.join(item['missing_marks'])}")
    broken = [item["scenario"] for item in scenarios if item["missing_marks"]]
    if broken:
        print(f"时间线不完整: {', '.join(broken)}")
        return 1
    print(f"已写出 {output}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="首音与动作的合成场景测量")
    parser.add_argument(
        "--json",
        default=str(ROOT / "work" / "latency_scenarios.json"),
        help="结果写出的路径",
    )
    args = parser.parse_args()
    return asyncio.run(main_async(Path(args.json)))


if __name__ == "__main__":
    raise SystemExit(main())
