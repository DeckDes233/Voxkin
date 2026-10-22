from __future__ import annotations

import asyncio
import time
import uuid
from collections import deque
from typing import Any, Awaitable, Callable

from voxkin.agent.actions import ActionError
from voxkin.agent.arbiter import ActionController, ActionTicket
from voxkin.agent.tools import MINECRAFT_TOOLS, TOOL_SYSTEM_HINT
from voxkin.agent.skills import find_skill
from voxkin.audio.sinks import AudioSink
from voxkin.config import VoxkinConfig
from voxkin.events import MetricsStore, TurnTimeline
from voxkin.intent import IntentPlan
from voxkin.intent import classify as classify_intent
from voxkin.intent import plan as plan_intent
from voxkin.llm.base import LLMAdapter, LLMDelta
from voxkin.memory import ContextBuilder, MemoryStore, MemoryWriter
from voxkin.text import SentenceSplitter
from voxkin.tts.base import TTSAdapter
from voxkin.voice.cache import SpeechCache
from voxkin.voice.phrase_catalog import acknowledgement, phrase_for_skill
from voxkin.world_state import format_world_state

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
        memory: MemoryStore | None = None,
        memory_writer: MemoryWriter | None = None,
        cache: SpeechCache | None = None,
    ) -> None:
        self.config = config
        self.llm = llm
        self.tts = tts
        self.sink = sink
        self.metrics = metrics
        self.emit = emit
        self.memory = memory
        self.memory_writer = memory_writer
        if cache is None and config.voice_cache.enabled:
            cache = SpeechCache(
                root=config.voice_cache.root,
                voice_id=config.voice_cache.voice_id or config.tts.character,
                expected_engine=config.tts.engine,
            )
        self.cache = cache
        system_parts = []
        if config.persona.system_prompt:
            system_parts.append(config.persona.system_prompt)
        if config.llm.enable_tools:
            system_parts.append(TOOL_SYSTEM_HINT)
        self._system_prompt = "\n".join(system_parts)
        self._context_builder = (
            ContextBuilder(memory, config.memory, self._system_prompt) if memory is not None else None
        )
        self._local_history: deque[dict[str, str]] = deque(
            maxlen=config.persona.max_history_turns * 2
        )
        self._generation = 0
        self._turn_seq = 0
        self._active_turn: TurnTimeline | None = None
        self._active_tasks: list[asyncio.Task] = []
        self._background_tasks: set[asyncio.Task] = set()
        self._sentence_queue: asyncio.Queue[str | None] | None = None
        self._tts_active = False
        self._accept_audio = False
        self._action_handler: ActionHandler | None = None
        self._action_controller: ActionController | None = None
        self._state_provider = None
        self._started = False
        self._summarize_task: asyncio.Task | None = None
        self.sink.set_playback_start_callback(self._on_playback_start)
        self._spoken_texts: dict[str, list[str]] = {}
        self._action_notes: deque[str] = deque(maxlen=5)
        self._ack_task: asyncio.Task | None = None

    def set_action_handler(self, handler: ActionHandler) -> None:
        self._action_handler = handler

    def set_action_controller(self, controller: ActionController) -> None:
        """接上动作仲裁器。接上之后动作的优先级、取消与结果路由由仲裁器负责。"""
        self._action_controller = controller

    def set_state_provider(self, provider) -> None:
        self._state_provider = provider

    @property
    def is_speaking(self) -> bool:
        return self._active_turn is not None

    @property
    def is_audible(self) -> bool:
        return self.is_speaking or self.sink.is_playing()

    async def start(self) -> None:
        if self._started:
            return
        await self.tts.initialize()
        await self.sink.start()
        if self.cache is not None and self.config.voice_cache.preload:
            await self.cache.load()
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
        if self._context_builder is not None:
            messages = self._context_builder.build(user_text)
        else:
            messages = []
            if self._system_prompt:
                messages.append({"role": "system", "content": self._system_prompt})
            messages.extend(self._local_history)
            messages.append({"role": "user", "content": user_text})
        state = self._state_provider() if self._state_provider is not None else None
        state_line = format_world_state(state)
        if state_line:
            index = 1 if messages and messages[0].get("role") == "system" else 0
            messages.insert(index, {"role": "system", "content": state_line})
        notes = list(self._action_notes)
        self._action_notes.clear()
        if notes:
            messages.insert(
                max(0, len(messages) - 1),
                {"role": "system", "content": "[最近动作] " + "；".join(notes)},
            )
        return messages

    @property
    def history(self) -> list[dict[str, Any]]:
        if self.memory is not None:
            return self.memory.recent_turns(limit=self.config.memory.recent_turns)
        return list(self._local_history)

    def _tool_schemas(self) -> list[dict[str, Any]] | None:
        return MINECRAFT_TOOLS if self.config.llm.enable_tools else None

    def _action_threshold(self, plan: IntentPlan) -> float:
        """会改世界的动作阈值更高，只读查询可以放宽。"""
        skill = find_skill(plan.skill_id)
        read_only = skill is not None and str(skill.get("type")) == "sense"
        if read_only:
            return self.config.fast_path.min_confidence
        return self.config.fast_path.action_min_confidence

    def _already_submitted(self, turn: TurnTimeline, call: dict[str, Any]) -> bool:
        """快路已经提交过的动作，模型再提一次也不重复执行。"""
        submitted = turn.meta.get("submitted_actions") or []
        if not submitted:
            return False
        skill_id = str(call.get("name") or "")
        arguments = dict(call.get("arguments") or {})
        for key in submitted:
            parts = str(key).split("|")
            if parts[0] != skill_id:
                continue
            known: dict[str, str] = {}
            for item in parts[1:]:
                name, _, value = item.partition("=")
                known[name] = value
            if all(str(arguments.get(name)) == value for name, value in known.items()):
                return True
        return False

    async def _play_dynamic(self, turn: TurnTimeline, text: str) -> bool:
        """动态合成一路语音并直接送到输出；返回是否真的出了声。"""
        ready = False
        async for pcm in self.tts.synthesize(text):
            if not ready:
                turn.mark("t_ack_ready")
                ready = True
            await self.sink.play(turn.request_id, pcm)
        return ready

    async def _speak_ack(self, turn: TurnTimeline, plan: IntentPlan) -> bool:
        """播确认语：缓存命中直接播放；未命中走动态 TTS，超出截止时间就如实降级。"""
        if self.cache is None or not plan.ack_text:
            return False
        clip = self.cache.lookup(plan.ack_key)
        if clip is not None:
            turn.mark("t_ack_ready")
            turn.meta["ack_source"] = "cache"
            for chunk in clip.chunks(self.config.voice_cache.chunk_ms):
                await self.sink.play(turn.request_id, chunk)
            return True
        phrase = phrase_for_skill(plan.skill_id)
        fallback = phrase.fallback if phrase is not None else "好。"
        deadline_s = self.config.voice_cache.ack_deadline_ms / 1000.0
        try:
            played = await asyncio.wait_for(
                self._play_dynamic(turn, fallback), timeout=deadline_s
            )
        except asyncio.TimeoutError:
            turn.meta["ack_source"] = "deadline_exceeded"
            return False
        except Exception as error:
            turn.meta["ack_source"] = "tts_unavailable"
            turn.meta.setdefault("ack_errors", []).append(str(error))
            return False
        if not played:
            turn.meta["ack_source"] = "no_audio"
            return False
        turn.meta["ack_source"] = "dynamic"
        return True

    async def _run_fast_path(self, turn: TurnTimeline, user_text: str) -> IntentPlan | None:
        """本地规则命中就提交动作并播确认语，不等云端模型。"""
        if not self.config.fast_path.enabled:
            return None
        plan = plan_intent(user_text)
        if plan is None:
            return None
        if plan.confidence < self._action_threshold(plan):
            turn.meta["fast_path_skipped"] = {
                "intent_id": plan.intent_id,
                "confidence": plan.confidence,
                "reason": "置信度不够",
            }
            return None
        call = {"name": plan.skill_id, "arguments": dict(plan.arguments)}
        turn.meta["fast_path"] = {
            "intent_id": plan.intent_id,
            "skill_id": plan.skill_id,
            "confidence": plan.confidence,
            "ack_key": plan.ack_key,
        }
        turn.meta.setdefault("submitted_actions", []).append(plan.dedupe_key)
        turn.mark("t_action_submit")
        # 先排确认语的任务，再排动作的任务：确认语是纯本地播放，
 # 要保证它先进输出队列，玩家先听到反馈，再看到动作开始。
        ack_task = asyncio.create_task(
            self._speak_ack(turn, plan), name=f"ack-{turn.request_id}"
        )
        self._ack_task = ack_task
        self._background_tasks.add(ack_task)
        ack_task.add_done_callback(self._background_tasks.discard)
        action_task = asyncio.create_task(
            self._run_action(
                call, turn, ack_text=plan.ack_text, announce_ack=False, origin="fast_path"
            ),
            name=f"fast-{turn.request_id}",
        )
        self._background_tasks.add(action_task)
        action_task.add_done_callback(self._background_tasks.discard)
        await self._broadcast(
            {
                "type": "fast_path_started",
                "request_id": turn.request_id,
                "intent_id": plan.intent_id,
                "confidence": plan.confidence,
                "tool": plan.skill_id,
                "arguments": plan.arguments,
            }
        )
        return plan

    def _turn_is_live(self, turn: TurnTimeline) -> bool:
        """回合还算不算数。被新回合取代的旧回合不再播报结果，只留记录。"""
        if turn.meta.get("interrupted"):
            return False
        return turn.meta.get("seq") == self._turn_seq

    async def _cancel_actions(self, reason: str) -> list[str]:
        """取消在途动作。语音打断不会走到这里，只有停止类指令才会。"""
        if self._action_controller is None:
            return []
        return await self._action_controller.cancel_all(reason)

    async def _handle_stop(self, turn: TurnTimeline, user_text: str) -> bool:
        """停止类指令要同时停掉正在跑的动作，只停语音不算数。"""
        intent = classify_intent(user_text)
        if intent is None or intent.name != "stop_movement":
            return False
        turn.mark("t_stop_sent")
        cancelled = await self._cancel_actions("玩家要求停止")
        turn.meta["cancelled_actions"] = cancelled
        await self._broadcast(
            {
                "type": "actions_cancelled",
                "request_id": turn.request_id,
                "action_ids": cancelled,
                "reason": "玩家要求停止",
            }
        )
        if self._action_controller is not None:
            # 停止回执不等语音：先让快路把确认语说出去，回执到了再补时间线。
            task = asyncio.create_task(
                self._await_stop_receipt(turn, cancelled), name=f"stop-{turn.request_id}"
            )
            self._background_tasks.add(task)
            task.add_done_callback(self._background_tasks.discard)
        return True

    async def _await_stop_receipt(self, turn: TurnTimeline, cancelled: list[str]) -> None:
        """等被取消的动作回执。收到回执与等到超时是两条不同的结果。"""
        if self._action_controller is None:
            return
        stopped = await self._action_controller.wait_cancelled(cancelled)
        if not cancelled:
            turn.meta["stop_result"] = "idle"
        else:
            turn.meta["stop_result"] = "receipt" if stopped else "timeout"
        if stopped:
            turn.mark("t_stop_done")
        self.metrics.update(turn)

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
        self._accept_audio = False
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
        if self._summarize_task is not None and not self._summarize_task.done():
            self._summarize_task.cancel()
        if self._active_turn is not None:
            await self.interrupt("superseded")
        self._generation += 1
        generation = self._generation
        self._turn_seq += 1
        turn = TurnTimeline.start(request_id)
        turn.meta["text"] = user_text
        turn.meta["seq"] = self._turn_seq
        turn.mark("t0_speech_end")
        turn.mark("t1_stt_final")
        turn.mark("t_cmd_final")
        self._active_turn = turn
        await self.sink.flush()
        self._spoken_texts[turn.request_id] = []
        queue: asyncio.Queue[str | None] = asyncio.Queue()
        self._sentence_queue = queue
        self._tts_active = True
        self._accept_audio = True
        tts_task = asyncio.create_task(
            self._tts_worker(turn, queue, generation), name=f"tts-{turn.request_id}"
        )
        self._active_tasks = [tts_task]
        await self._broadcast(
            {"type": "turn_started", "request_id": turn.request_id, "text": user_text}
        )
        # 停止类指令先停动作，再走快路播确认语；顺序反了就会出现「说了停但还在挖」。
        await self._handle_stop(turn, user_text)
        await self._run_fast_path(turn, user_text)
        turn.mark("t_intent_done")
        splitter = SentenceSplitter(max_chars=self.config.tts.max_chars_per_request)
        collected: list[str] = []
        tool_calls = 0
        stream = self.llm.stream_chat(self._build_messages(user_text), tools=self._tool_schemas())
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
                    if self._already_submitted(turn, delta.tool_call):
                        turn.meta.setdefault("deduped_actions", []).append(
                            str(delta.tool_call.get("name") or "")
                        )
                        await self._broadcast(
                            {
                                "type": "action_deduped",
                                "request_id": turn.request_id,
                                "tool": delta.tool_call.get("name"),
                                "arguments": delta.tool_call.get("arguments"),
                            }
                        )
                        continue
                    turn.mark("t_action_submit")
                    action_task = asyncio.create_task(
                        self._run_action(delta.tool_call, turn),
                        name=f"action-{turn.request_id}",
                    )
                    self._background_tasks.add(action_task)
                    action_task.add_done_callback(self._background_tasks.discard)
            for sentence in splitter.flush():
                await self._enqueue_sentence(turn, sentence, queue)
            self._accept_audio = False
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
                self._accept_audio = False
            await stream.aclose()
        turn.meta["spoken"] = "".join(self._spoken_texts.get(turn.request_id, []))
        if self._ack_task is not None:
            await asyncio.gather(self._ack_task, return_exceptions=True)
            self._ack_task = None
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
        if self.memory is not None:
            self.memory.add_turn(turn.request_id, "user", user_text)
            if collected:
                self.memory.add_turn(turn.request_id, "assistant", "".join(collected))
            if self.memory_writer is not None:
                self._summarize_task = asyncio.create_task(
                    self._delayed_summarize(), name=f"memory-{turn.request_id}"
                )
                self._background_tasks.add(self._summarize_task)
                self._summarize_task.add_done_callback(self._background_tasks.discard)
        else:
            self._local_history.append({"role": "user", "content": user_text})
            if collected:
                self._local_history.append({"role": "assistant", "content": "".join(collected)})
        self.metrics.add(turn)
        summary = turn.summary()
        await self._broadcast({"type": "turn_finished", "summary": summary})
        return summary

    async def _delayed_summarize(self) -> None:
        await asyncio.sleep(self.config.memory.summarize_delay_s)
        if self.memory_writer is not None:
            await self.memory_writer.maybe_summarize()

    async def announce(self, text: str) -> None:
        """把一句系统侧的话送进语音通道，不经过 LLM。"""
        cleaned = text.strip()
        if not cleaned:
            return
        await self._broadcast({"type": "announce", "text": cleaned})
        if self._accept_audio and self._sentence_queue is not None:
            await self._sentence_queue.put(cleaned)
            return
        token = f"announce-{uuid.uuid4().hex[:8]}"
        try:
            async for pcm in self.tts.synthesize(cleaned):
                await self.sink.play(token, pcm)
        except Exception as error:
            # 播报失败不该把动作结果也拖垮，如实记录后继续。
            await self._broadcast({"type": "tts_failed", "text": cleaned, "error": str(error)})

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
        try:
            while True:
                sentence = await queue.get()
                if sentence is None:
                    break
                if generation != self._generation:
                    break
                if not turn.has("t4_tts_first_text"):
                    turn.mark("t4_tts_first_text")
                try:
                    async for pcm in self.tts.synthesize(sentence):
                        if generation != self._generation:
                            return
                        if not turn.has("t5_first_audio"):
                            turn.mark("t5_first_audio")
                        await self.sink.play(turn.request_id, pcm)
                except Exception as error:
                    # 动态合成挂掉就停掉这一路语音，不让整轮对话失败；
                    # 已经播出去的缓存确认语仍然算数，失败原因如实上报。
                    turn.meta["tts_error"] = str(error)
                    turn.meta["degraded"] = True
                    await self._broadcast(
                        {
                            "type": "tts_failed",
                            "request_id": turn.request_id,
                            "error": str(error),
                        }
                    )
                    return
        finally:
            self._tts_active = False

    def _action_acknowledgement(self, call: dict[str, Any]) -> str:
        name = str(call.get("name") or "")
        return acknowledgement(name, call.get("arguments") or {})

    async def _run_action(
        self,
        call: dict[str, Any],
        turn: TurnTimeline,
        *,
        ack_text: str = "",
        announce_ack: bool = True,
        origin: str = "llm",
    ) -> None:
        if announce_ack and not turn.has("t5_first_audio"):
            await self.announce(ack_text or self._action_acknowledgement(call))
        await self._broadcast(
            {
                "type": "action_started",
                "request_id": turn.request_id,
                "tool": call.get("name"),
                "arguments": call.get("arguments"),
            }
        )
        if self._action_controller is None and self._action_handler is None:
            self._action_notes.append(f"{call.get('name')} 未执行：没有配置动作执行器")
            await self._broadcast(
                {
                    "type": "action_skipped",
                    "request_id": turn.request_id,
                    "tool": call.get("name"),
                    "reason": "没有配置动作执行器",
                }
            )
            return
        turn.mark("t7_action_start")
        try:
            detail = await self._dispatch_action(call, turn, origin)
        except ActionError as error:
            # 取消与失败要分开说：取消是玩家要的结果，不是没做成。
            status = error.status
            turn.meta.setdefault("action_errors", []).append(str(error))
            turn.meta["action_status"] = status
            self._action_notes.append(f"{call.get('name')} {status}：{str(error)[:160]}")
            self.metrics.update(turn)
            await self._broadcast(
                {
                    "type": "action_cancelled" if status == "cancelled" else "action_failed",
                    "request_id": turn.request_id,
                    "tool": call.get("name"),
                    "status": status,
                    "error": str(error),
                }
            )
            if not self._turn_is_live(turn):
                return
            if status == "cancelled":
                await self.announce("好的，先停下了。")
            else:
                await self.announce("这次没做成，我换个地方看看。")
            return
        except Exception as error:
            turn.meta.setdefault("action_errors", []).append(str(error))
            self._action_notes.append(f"{call.get('name')} 失败：{str(error)[:160]}")
            self.metrics.update(turn)
            await self._broadcast(
                {
                    "type": "action_failed",
                    "request_id": turn.request_id,
                    "tool": call.get("name"),
                    "error": str(error),
                }
            )
            if self._turn_is_live(turn):
                await self.announce("这次没做成，我换个地方看看。")
            return
        turn.mark("t8_action_done")
        self._action_notes.append(f"{call.get('name')} 完成：{str(detail)[:160]}")
        self.metrics.update(turn)
        # 被新回合取代的旧回合只留记录，不把结果播进新回合。
        if self._turn_is_live(turn):
            await self.announce(f"好了，{detail}。")
        await self._broadcast(
            {
                "type": "action_finished",
                "request_id": turn.request_id,
                "tool": call.get("name"),
                "detail": detail,
            }
        )

    async def _dispatch_action(
        self, call: dict[str, Any], turn: TurnTimeline, origin: str
    ) -> str:
        """把一次动作请求交给仲裁器或旧的动作执行器。"""
        if self._action_controller is not None:
            ticket = ActionTicket(
                tool=str(call.get("name") or ""),
                arguments=dict(call.get("arguments") or {}),
                turn_id=turn.request_id,
                origin=origin,
            )
            result = await self._action_controller.submit(ticket)
            if result.status == "partial":
                return f"{result.detail}（只完成一部分）"
            return result.detail
        assert self._action_handler is not None
        return await self._action_handler(call, turn)

    async def close(self) -> None:
        for task in list(self._background_tasks):
            task.cancel()
        try:
            await self.interrupt("shutdown")
        finally:
            await self.tts.close()
            await self.sink.close()
            await self.llm.close()
