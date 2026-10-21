from __future__ import annotations

import asyncio
import time
from collections import deque
from typing import Any, Awaitable, Callable

from voxkin.audio.sinks import AudioSink
from voxkin.config import VoxkinConfig
from voxkin.events import MetricsStore, TurnTimeline
from voxkin.llm.base import LLMAdapter, LLMDelta
from voxkin.text import SentenceSplitter
from voxkin.tts.base import TTSAdapter

EventEmitter = Callable[[dict[str, Any]], Awaitable[None]]
ActionHandler = Callable[[dict[str, Any], TurnTimeline], Awaitable[str]]


class ConversationPipeline:
    def __init__(
        self,
        config: VoxkinConfig,
        llm: LLMAdapter,
        tts: TTSAdapter,
        sink: AudioSink,
        metrics: MetricsStore,
        emit: EventEmitter | None = None,
    ) -> None:
        self.config = config
        self.llm = llm
        self.tts = tts
        self.sink = sink
        self.metrics = metrics
        self.emit = emit
        self.history: deque[dict[str, str]] = deque(maxlen=config.persona.max_history_turns * 2)
        self._generation = 0
        self._active_turn: TurnTimeline | None = None
        self._active_tasks: list[asyncio.Task] = []
        self._background_tasks: set[asyncio.Task] = set()
        self._sentence_queue: asyncio.Queue[str | None] | None = None
        self._action_handler: ActionHandler | None = None
        self._started = False
        self.sink.set_playback_start_callback(self._on_playback_start)
        self._spoken_texts: dict[str, list[str]] = {}

    def set_action_handler(self, handler: ActionHandler) -> None:
        self._action_handler = handler

    @property
    def is_speaking(self) -> bool:
        return self._active_turn is not None

    async def start(self) -> None:
        if self._started:
            return
        await self.tts.initialize()
        await self.sink.start()
        self._started = True

    async def _broadcast(self, payload: dict[str, Any]) -> None:
        if self.emit is not None:
            await self.emit(payload)

    def _on_playback_start(self, turn_id: str, stamp: float) -> None:
        turn = self._active_turn
        if turn is None or turn.request_id != turn_id:
            return
        turn.mark("t6_playback_start", stamp)

    def _build_messages(self, user_text: str) -> list[dict[str, str]]:
        messages: list[dict[str, str]] = []
        if self.config.persona.system_prompt:
            messages.append({"role": "system", "content": self.config.persona.system_prompt})
        messages.extend(self.history)
        messages.append({"role": "user", "content": user_text})
        return messages

    async def interrupt(self, reason: str = "user_interrupt") -> None:
        self._generation += 1
        turn = self._active_turn
        if turn is not None:
            turn.meta["interrupted"] = reason
            await self._broadcast(
                {"type": "turn_interrupted", "request_id": turn.request_id, "reason": reason}
            )
        self._active_turn = None
        self._sentence_queue = None
        for task in self._active_tasks:
            task.cancel()
        tasks = list(self._active_tasks)
        self._active_tasks.clear()
        for task in tasks:
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception as error:
                if turn is not None and not turn.error:
                    turn.error = str(error)
        await self.tts.stop()
        await self.sink.flush()

    async def respond(self, user_text: str, request_id: str | None = None) -> dict[str, Any]:
        if not self._started:
            await self.start()
        if self._active_turn is not None:
            await self.interrupt("superseded")
        self._generation += 1
        generation = self._generation
        turn = TurnTimeline.start(request_id)
        turn.meta["text"] = user_text
        turn.mark("t0_speech_end")
        turn.mark("t1_stt_final")
        self._active_turn = turn
        await self.sink.flush()
        self._spoken_texts[turn.request_id] = []
        queue: asyncio.Queue[str | None] = asyncio.Queue()
        self._sentence_queue = queue
        tts_task = asyncio.create_task(
            self._tts_worker(turn, queue, generation), name=f"tts-{turn.request_id}"
        )
        self._active_tasks = [tts_task]
        await self._broadcast(
            {"type": "turn_started", "request_id": turn.request_id, "text": user_text}
        )
        splitter = SentenceSplitter(max_chars=self.config.tts.max_chars_per_request)
        collected: list[str] = []
        tool_calls = 0
        stream = self.llm.stream_chat(self._build_messages(user_text))
        try:
            async for delta in stream:
                if generation != self._generation:
                    break
                if delta.kind == "text":
                    if not turn.has("t2_llm_first_token"):
                        turn.mark("t2_llm_first_token")
                    collected.append(delta.text)
                    await self._broadcast(
                        {
                            "type": "llm_delta",
                            "request_id": turn.request_id,
                            "text": delta.text,
                        }
                    )
                    for sentence in splitter.feed(delta.text):
                        await self._enqueue_sentence(turn, sentence, queue)
                elif delta.kind == "tool_call" and delta.tool_call:
                    tool_calls += 1
                    action_task = asyncio.create_task(
                        self._run_action(delta.tool_call, turn),
                        name=f"action-{turn.request_id}",
                    )
                    self._background_tasks.add(action_task)
                    action_task.add_done_callback(self._background_tasks.discard)
            for sentence in splitter.flush():
                await self._enqueue_sentence(turn, sentence, queue)
            await queue.put(None)
            if generation == self._generation:
                try:
                    await tts_task
                except asyncio.CancelledError:
                    if generation == self._generation:
                        raise
        except asyncio.CancelledError:
            if generation == self._generation:
                turn.meta["cancelled"] = True
                await self._broadcast(
                    {"type": "turn_cancelled", "request_id": turn.request_id}
                )
                raise
            turn.meta.setdefault("interrupted", "superseded")
        except Exception as error:
            turn.error = str(error)
            self.metrics.add(turn)
            await self._broadcast(
                {"type": "turn_failed", "request_id": turn.request_id, "error": str(error)}
            )
            raise
        finally:
            if generation == self._generation:
                self._active_turn = None
            await stream.aclose()
        turn.meta["spoken"] = "".join(self._spoken_texts.get(turn.request_id, []))
        if generation != self._generation:
            self.metrics.add(turn)
            summary = turn.summary()
            await self._broadcast({"type": "turn_interrupted", "summary": summary})
            return summary
        if turn.error:
            await self._broadcast(
                {"type": "turn_failed", "request_id": turn.request_id, "error": turn.error}
            )
        turn.meta["tokens"] = len(collected)
        turn.meta["tool_calls"] = tool_calls
        self.history.append({"role": "user", "content": user_text})
        if collected:
            self.history.append({"role": "assistant", "content": "".join(collected)})
        self.metrics.add(turn)
        summary = turn.summary()
        await self._broadcast({"type": "turn_finished", "summary": summary})
        return summary

    async def _enqueue_sentence(
        self, turn: TurnTimeline, sentence: str, queue: asyncio.Queue[str | None]
    ) -> None:
        if not sentence:
            return
        if not turn.has("t3_first_sentence"):
            turn.mark("t3_first_sentence")
        self._spoken_texts[turn.request_id].append(sentence)
        await self._broadcast(
            {
                "type": "sentence_ready",
                "request_id": turn.request_id,
                "text": sentence,
            }
        )
        await queue.put(sentence)

    async def _tts_worker(
        self, turn: TurnTimeline, queue: asyncio.Queue[str | None], generation: int
    ) -> None:
        while True:
            sentence = await queue.get()
            if sentence is None:
                break
            if generation != self._generation:
                break
            if not turn.has("t4_tts_first_text"):
                turn.mark("t4_tts_first_text")
            async for pcm in self.tts.synthesize(sentence):
                if generation != self._generation:
                    return
                if not turn.has("t5_first_audio"):
                    turn.mark("t5_first_audio")
                await self.sink.play(turn.request_id, pcm)

    async def _run_action(self, call: dict[str, Any], turn: TurnTimeline) -> None:
        turn.mark("t7_action_start")
        await self._broadcast(
            {
                "type": "action_started",
                "request_id": turn.request_id,
                "tool": call.get("name"),
                "arguments": call.get("arguments"),
            }
        )
        if self._action_handler is None:
            await self._broadcast(
                {
                    "type": "action_skipped",
                    "request_id": turn.request_id,
                    "tool": call.get("name"),
                    "reason": "没有配置动作执行器",
                }
            )
            return
        try:
            detail = await self._action_handler(call, turn)
        except Exception as error:
            turn.meta.setdefault("action_errors", []).append(str(error))
            await self._broadcast(
                {
                    "type": "action_failed",
                    "request_id": turn.request_id,
                    "tool": call.get("name"),
                    "error": str(error),
                }
            )
            return
        turn.mark("t8_action_done")
        await self._broadcast(
            {
                "type": "action_finished",
                "request_id": turn.request_id,
                "tool": call.get("name"),
                "detail": detail,
            }
        )

    async def close(self) -> None:
        for task in list(self._background_tasks):
            task.cancel()
        try:
            await self.interrupt("shutdown")
        finally:
            await self.tts.close()
            await self.sink.close()
            await self.llm.close()
