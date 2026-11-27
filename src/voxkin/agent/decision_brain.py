from __future__ import annotations

import asyncio
import json
import uuid
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Mapping

from voxkin.config import BrainConfig
from voxkin.llm.base import LLMAdapter


_PROMPT = (
    '你为 Minecraft 生存角色选择下一项策略。根据当前目标、资源、风险和已失败的方法，'
    '从 candidates 中选择一个 ID。facts 是游戏观察。只返回一个 JSON 对象，'
    '如有 wood_failure，请按窄范围采木最终以该原因结束的场景选择。'
    '格式为 {"decision_id":"原样复制本次 ID","candidate_id":"候选 ID"}。'
)


@dataclass
class _Decision:
    key: str
    candidates: dict[str, str]
    decision_id: str
    prompt: str
    deadline: float
    ready: asyncio.Event = field(default_factory=asyncio.Event)
    choice: str | None = None
    usable_until: float = 0.0


def _distinct_fields(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    fields = dict(pairs)
    if len(fields) != len(pairs):
        raise ValueError("重复的决策字段")
    return fields


class DecisionBrain:
    def __init__(self, llm: LLMAdapter, config: BrainConfig) -> None:
        self._llm = llm
        self._config = config
        self._decision: _Decision | None = None
        self._task: asyncio.Task[str | None] | None = None
        self._running: _Decision | None = None
        self._timer: asyncio.TimerHandle | None = None
        self._counts: Counter[str] = Counter()
        self._closed = False

    def select(self, key: str, candidates: Mapping[str, str], facts: Mapping[str, Any]) -> str | None:
        if self._closed or not self._config.enabled or not key or len(candidates) < 2:
            self.cancel()
            return None
        loop = asyncio.get_running_loop()
        current = self._decision
        if current and current.key == key and current.candidates == candidates:
            return current.choice if loop.time() < current.usable_until else None

        self.cancel()
        decision_id = uuid.uuid4().hex[:12]
        offered = dict(candidates)
        # 在首次提交时冻结观察。调用方可在实际动作期间继续更新原字典。
        try:
            prompt = json.dumps({"decision_id": decision_id, "facts": dict(facts), "candidates": offered},
                                ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        except (TypeError, ValueError, RecursionError):
            self._counts["invalid_context"] += 1
            return None
        current = _Decision(key, offered, decision_id, prompt, loop.time() + self._config.timeout_s)
        self._decision = current
        self._timer = loop.call_at(current.deadline, self._timeout, current)
        if self._task is None:
            self._start(current)
        return None

    async def wait_ready(self, key: str, timeout_s: float | None = None) -> str | None:
        current = self._decision
        if not current or current.key != key:
            return None
        loop = asyncio.get_running_loop()
        remaining = current.deadline - loop.time()
        wait_s = remaining if timeout_s is None else min(remaining, timeout_s)
        if not current.ready.is_set() and wait_s > 0:
            try:
                await asyncio.wait_for(current.ready.wait(), wait_s)
            except asyncio.TimeoutError:
                return None
        if self._decision is current and loop.time() < current.usable_until:
            return current.choice
        return None

    def _start(self, decision: _Decision) -> None:
        self._running = decision
        self._counts["requested"] += 1
        self._task = asyncio.create_task(self._choose(decision))
        self._task.add_done_callback(self._finished)

    async def _choose(self, decision: _Decision) -> str | None:
        chunks: list[str] = []
        size = 0
        stream = self._llm.stream_chat([{"role": "system", "content": _PROMPT},
                                        {"role": "user", "content": decision.prompt}])
        try:
            async for delta in stream:
                if delta.kind == "text":
                    size += len(delta.text)
                    if size > 1024:
                        return None
                    chunks.append(delta.text)
                elif delta.kind == "tool_call":
                    return None
        finally:
            close = getattr(stream, "aclose", None)
            if close is not None:
                await close()
        try:
            reply = json.loads("".join(chunks), object_pairs_hook=_distinct_fields)
        except (ValueError, RecursionError):
            return None
        if not isinstance(reply, dict) or reply.keys() != {"decision_id", "candidate_id"}:
            return None
        choice = reply["candidate_id"]
        if reply["decision_id"] != decision.decision_id or not isinstance(choice, str) or choice not in decision.candidates:
            return None
        return choice

    def _finished(self, task: asyncio.Task[str | None]) -> None:
        finished = self._running
        self._task = None
        self._running = None
        choice = None
        try:
            choice = task.result()
            outcome = "completed" if choice is not None else "invalid"
        except asyncio.CancelledError:
            outcome = "cancelled"
        except Exception:
            # 提供商可能把认证或请求内容放入异常。对外只记录结果类别。
            outcome = "errors"
        current = self._decision
        if current is None or current.ready.is_set():
            return
        if asyncio.get_running_loop().time() >= current.deadline:
            self._timeout(current)
        elif current is not finished:
            # 旧流已经退出并关闭 HTTP 响应，此时才能请求最新的候选。
            self._start(current)
        else:
            if self._timer:
                self._timer.cancel()
                self._timer = None
            current.choice = choice
            current.usable_until = asyncio.get_running_loop().time() + self._config.result_ttl_s
            self._counts[outcome] += 1
            current.ready.set()

    def _timeout(self, decision: _Decision) -> None:
        if self._decision is decision and not decision.ready.is_set():
            self._counts["timed_out"] += 1
            decision.ready.set()
            if self._running is decision and self._task:
                self._task.cancel()

    def cancel(self) -> None:
        if self._timer:
            self._timer.cancel()
            self._timer = None
        current = self._decision
        self._decision = None
        if current and not current.ready.is_set():
            self._counts["cancelled"] += 1
            current.ready.set()
            if self._running is current and self._task:
                self._task.cancel()

    async def close(self) -> None:
        self._closed = True
        self.cancel()
        if self._task:
            # 即使第三方适配器延迟处理取消，关闭也有界。LLM 连接由 Runtime 持有。
            await asyncio.wait({self._task}, timeout=self._config.timeout_s)

    def describe(self) -> dict[str, Any]:
        return {"enabled": self._config.enabled and not self._closed,
                "pending": self._decision is not None and not self._decision.ready.is_set(),
                **self._counts}
