from __future__ import annotations

import asyncio
import io
import json
import logging
import math
import time
import uuid
from pathlib import Path
from typing import Any

from aiohttp import WSMsgType, web

from voxkin.audio.capture import Microphone
from voxkin.audio.wav import arrays_to_wav_bytes
from voxkin.audio.websocket import WebSocketAudioSink
from voxkin.agent.actions import ActionError
from voxkin.bridge.protocol import ActionProgress, ActionResult, ActionStatusResult, parse_chat
from voxkin.config import load_config, save_config
from voxkin.intent import is_stop
from voxkin.logging_setup import tail_log
from voxkin.runtime import Runtime
from voxkin.services import ServiceError

STATIC_DIR = Path(__file__).with_name("studio")
logger = logging.getLogger("voxkin")
MAX_SHELTER_RESTORE_REQUESTS = 2


def _dimension_family(value: Any) -> str:
    return {
        "overworld": "overworld",
        "minecraft:overworld": "overworld",
        "the_nether": "the_nether",
        "minecraft:the_nether": "the_nether",
        "nether": "the_nether",
        "the_end": "the_end",
        "minecraft:the_end": "the_end",
        "end": "the_end",
    }.get(str(value or "").strip().lower(), "")


def _shelter_anchor(shelter: Any) -> dict[str, Any] | None:
    if not isinstance(shelter, dict) or not isinstance(shelter.get("position"), dict):
        return None
    position: dict[str, int] = {}
    for axis in "xyz":
        value = shelter["position"].get(axis)
        if isinstance(value, bool):
            return None
        try:
            numeric = float(value)
        except (TypeError, ValueError):
            return None
        if not math.isfinite(numeric) or not numeric.is_integer():
            return None
        if axis == "y":
            if not -64 <= numeric <= 320:
                return None
        elif abs(numeric) > 30_000_000:
            return None
        position[axis] = int(numeric)
    raw_size = shelter.get("size")
    if isinstance(raw_size, bool):
        return None
    try:
        numeric_size = float(raw_size)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(numeric_size) or not numeric_size.is_integer():
        return None
    size = int(numeric_size)
    if size not in {3, 4, 5}:
        return None
    return {"position": position, "size": size}


def _shelter_context(shelter: Any) -> dict[str, Any] | None:
    anchor = _shelter_anchor(shelter)
    if anchor is None or not isinstance(shelter.get("sealed"), bool) or not isinstance(shelter.get("inside"), bool):
        return None
    return anchor


class StudioServer:
    def __init__(self, runtime: Runtime, config_path: Path) -> None:
        self.runtime = runtime
        self.config_path = config_path
        self.started_at = time.time()
        self._turn_task: asyncio.Task | None = None

    def build(self) -> web.Application:
        app = web.Application()
        app.router.add_get("/", self.index)
        app.router.add_get("/static/{name}", self.static_file)
        app.router.add_get("/api/status", self.status)
        app.router.add_get("/api/bridge/state", self.bridge_state)
        app.router.add_post("/api/say", self.say)
        app.router.add_post("/api/interrupt", self.interrupt)
        app.router.add_post("/api/tts", self.tts)
        app.router.add_post("/api/stt", self.stt)
        app.router.add_get("/api/metrics", self.metrics)
        app.router.add_get("/api/logs", self.logs)
        app.router.add_get("/api/audio/devices", self.audio_devices)
        app.router.add_get("/api/services", self.services)
        app.router.add_post("/api/services/{name}/{action}", self.service_action)
        app.router.add_get("/api/mic", self.mic_status)
        app.router.add_post("/api/mic/start", self.mic_start)
        app.router.add_post("/api/mic/stop", self.mic_stop)
        app.router.add_get("/api/run/status", self.run_status)
        app.router.add_post("/api/run/start", self.run_start)
        app.router.add_post("/api/run/resume", self.run_resume)
        app.router.add_post("/api/run/stop", self.run_stop)
        app.router.add_post("/api/config", self.update_config)
        app.router.add_post("/api/llm/test", self.llm_test)
        app.router.add_get("/ws", self.websocket)
        app.router.add_get("/ws/bridge", self.bridge_socket)
        app.router.add_get("/ws/audio", self.audio_socket)
        return app

    async def index(self, request: web.Request) -> web.StreamResponse:
        return web.FileResponse(STATIC_DIR / "index.html")

    async def static_file(self, request: web.Request) -> web.StreamResponse:
        name = request.match_info["name"]
        target = (STATIC_DIR / name).resolve()
        if not str(target).startswith(str(STATIC_DIR.resolve())) or not target.exists():
            raise web.HTTPNotFound()
        return web.FileResponse(target)

    async def status(self, request: web.Request) -> web.Response:
        payload = self.runtime.status()
        payload["uptime_s"] = round(time.time() - self.started_at, 1)
        payload["config_path"] = str(self.config_path)
        payload["mic"] = self.runtime.mic_status()
        return web.json_response(payload)

    async def bridge_state(self, request: web.Request) -> web.Response:
        """桥接最近一帧世界状态；用来判断 bot 是否已经进世界。"""
        dispatcher = self.runtime.dispatcher
        state = dispatcher.state_snapshot()
        return web.json_response(
            {
                "connected": dispatcher.connected,
                "ready": bool(state.get("position")),
                "age_s": dispatcher.state_age_s(),
                "state": state,
            }
        )

    async def say(self, request: web.Request) -> web.Response:
        body = await request.json()
        text = (body.get("text") or "").strip()
        if not text:
            raise web.HTTPBadRequest(text="text 不能为空")
        request_id = uuid.uuid4().hex[:12]
        wait = bool(body.get("wait"))
        if self._turn_task is not None and not self._turn_task.done():
            await self.runtime.pipeline.interrupt("new_request")
        self._turn_task = asyncio.create_task(self.runtime.pipeline.respond(text, request_id))
        if wait:
            summary = await self._turn_task
            return web.json_response({"request_id": request_id, "summary": summary})
        return web.json_response({"request_id": request_id, "accepted": True})

    async def interrupt(self, request: web.Request) -> web.Response:
        await self.runtime.pipeline.interrupt("manual")
        return web.json_response({"interrupted": True})

    async def tts(self, request: web.Request) -> web.Response:
        body = await request.json()
        text = (body.get("text") or "").strip()
        if not text:
            raise web.HTTPBadRequest(text="text 不能为空")
        started = time.perf_counter()
        chunks = []
        first_audio: float | None = None
        async for pcm in self.runtime.tts.synthesize(text):
            if first_audio is None:
                first_audio = time.perf_counter()
            chunks.append(pcm)
        payload = arrays_to_wav_bytes(chunks, self.runtime.tts.sample_rate)
        return web.Response(
            body=payload,
            content_type="audio/wav",
            headers={
                "X-First-Audio-Ms": str(round(((first_audio or started) - started) * 1000, 1)),
                "X-Total-Ms": str(round((time.perf_counter() - started) * 1000, 1)),
            },
        )

    async def stt(self, request: web.Request) -> web.Response:
        reader = await request.multipart()
        field = await reader.next()
        if field is None or field.name != "file":
            raise web.HTTPBadRequest(text="需要 multipart 字段 file")
        import soundfile as sf

        data = await field.read()
        audio, rate = sf.read(io.BytesIO(data), dtype="float32")
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        if rate != 16000:
            raise web.HTTPBadRequest(text=f"采样率必须为 16000，收到 {rate}")
        started = time.perf_counter()
        text = await asyncio.to_thread(self.runtime.stt.transcribe, audio)
        return web.json_response(
            {
                "text": text,
                "stt_ms": round((time.perf_counter() - started) * 1000, 1),
            }
        )

    async def metrics(self, request: web.Request) -> web.Response:
        limit = int(request.query.get("limit", "20"))
        return web.json_response(
            {
                "aggregate": self.runtime.metrics.aggregate(),
                "recent": self.runtime.metrics.recent(limit),
            }
        )

    async def logs(self, request: web.Request) -> web.Response:
        lines = int(request.query.get("lines", "200"))
        return web.json_response({"lines": tail_log(lines)})

    async def mic_status(self, request: web.Request) -> web.Response:
        return web.json_response(self.runtime.mic_status())

    async def mic_start(self, request: web.Request) -> web.Response:
        return web.json_response(await self.runtime.start_mic())

    async def mic_stop(self, request: web.Request) -> web.Response:
        return web.json_response(await self.runtime.stop_mic())

    async def run_status(self, request: web.Request) -> web.Response:
        manager = self.runtime.run_manager
        return web.json_response(manager.status() if manager is not None else {"running": False})

    async def run_start(self, request: web.Request) -> web.Response:
        manager = self.runtime.run_manager
        if manager is None:
            raise web.HTTPServiceUnavailable(text="没有可用的任务执行器")
        try:
            body = await request.json()
        except Exception:
            body = {}
        stage = str(body.get("stage") or "S0")
        try:
            await manager.start(stage)
        except KeyError as error:
            raise web.HTTPBadRequest(text=str(error)) from error
        return web.json_response(manager.status())

    async def run_resume(self, request: web.Request) -> web.Response:
        manager = self.runtime.run_manager
        if manager is None:
            raise web.HTTPServiceUnavailable(text="没有可用的任务执行器")
        dispatcher = self.runtime.dispatcher
        state = dispatcher.state_snapshot()
        age = dispatcher.state_age_s()
        position = state.get("position") or {}
        valid_position = all(
            isinstance(position.get(axis), (int, float))
            and math.isfinite(float(position[axis]))
            for axis in "xyz"
        )
        try:
            health = float(state.get("health"))
        except (TypeError, ValueError):
            health = 0.0
        if (
            not dispatcher.connected
            or not valid_position
            or state.get("alive") is not True
            or not math.isfinite(health)
            or health <= 0
            or age is None
            or age > 15
        ):
            raise web.HTTPConflict(text="Minecraft 桥接未就绪或状态帧已过期，暂时不能恢复任务")
        try:
            body = await request.json()
        except Exception:
            body = {}
        if not isinstance(body, dict):
            body = {}
        raw_task_id = body.get("task_id")
        try:
            task_id = int(raw_task_id) if raw_task_id is not None else None
            status = await manager.resume(task_id)
        except (KeyError, ValueError) as error:
            raise web.HTTPBadRequest(text=str(error)) from error
        return web.json_response(status)

    async def run_stop(self, request: web.Request) -> web.Response:
        manager = self.runtime.run_manager
        if manager is None:
            raise web.HTTPServiceUnavailable(text="没有可用的任务执行器")
        return web.json_response(await manager.stop())

    async def services(self, request: web.Request) -> web.Response:
        return web.json_response(await self.runtime.services_status())

    async def service_action(self, request: web.Request) -> web.Response:
        name = request.match_info["name"]
        action = request.match_info["action"]
        try:
            if action == "start":
                result = await self.runtime.supervisor.start(name)
            elif action == "stop":
                result = await self.runtime.supervisor.stop(name)
            elif action == "restart":
                result = await self.runtime.supervisor.restart(name)
            else:
                raise web.HTTPBadRequest(text=f"未知动作: {action}")
        except ServiceError as error:
            raise web.HTTPConflict(text=str(error))
        return web.json_response(result)

    async def audio_devices(self, request: web.Request) -> web.Response:
        devices = await asyncio.to_thread(Microphone.list_devices)
        return web.json_response({"input": devices})

    async def llm_test(self, request: web.Request) -> web.Response:
        from voxkin.llm.base import LLMError
        from voxkin.llm.openai_compat import OpenAICompatLLM, TimedLLMProbe

        if not isinstance(self.runtime.llm, OpenAICompatLLM):
            raise web.HTTPConflict(text="当前没有配置可用的 LLM 凭据")
        probe = TimedLLMProbe(self.runtime.llm)
        try:
            result = await probe.run([{"role": "user", "content": "用一句话打个招呼"}])
        except LLMError as error:
            raise web.HTTPBadGateway(text=str(error))
        return web.json_response(result)

    async def update_config(self, request: web.Request) -> web.Response:
        body = await request.json()
        current = load_config(self.config_path)
        changed: list[str] = []
        for section, values in body.items():
            if not hasattr(current, section):
                raise web.HTTPBadRequest(text=f"未知配置段落: {section}")
            target = getattr(current, section)
            for key, value in values.items():
                if not hasattr(target, key):
                    raise web.HTTPBadRequest(text=f"未知配置键: {section}.{key}")
                if getattr(target, key) != value:
                    setattr(target, key, value)
                    changed.append(f"{section}.{key}")
        current.validate()
        save_config(current, self.config_path)
        return web.json_response({"saved": True, "changed": changed, "restart_required": changed})

    async def audio_socket(self, request: web.Request) -> web.StreamResponse:
        sink = self.runtime.pipeline.sink
        if not isinstance(sink, WebSocketAudioSink):
            raise web.HTTPConflict(text="当前音频输出不是 websocket，请把 audio.output 改为 websocket")
        ws = web.WebSocketResponse(heartbeat=30)
        await ws.prepare(request)

        async def send(payload: bytes | str) -> None:
            if ws.closed:
                raise ConnectionError("音频连接已关闭")
            if isinstance(payload, bytes):
                await ws.send_bytes(payload)
            else:
                await ws.send_str(payload)

        sink.attach(send)
        await send(
            json.dumps(
                {
                    "type": "welcome",
                    "sample_rate": sink.sample_rate,
                    "channels": 1,
                    "format": "s16le",
                }
            )
        )
        try:
            async for message in ws:
                if message.type == WSMsgType.TEXT and message.data == "ping":
                    await send("pong")
        finally:
            sink.detach(send)
        return ws

    async def bridge_socket(self, request: web.Request) -> web.StreamResponse:
        ws = web.WebSocketResponse(heartbeat=30)
        await ws.prepare(request)
        name = request.query.get("name", "mineflayer")

        async def send(payload: dict[str, Any]) -> None:
            if ws.closed:
                raise ConnectionError("Minecraft 桥接连接已关闭")
            await ws.send_str(json.dumps(payload, ensure_ascii=False))

        try:
            self.runtime.dispatcher.attach(send, name)
        except ActionError as error:
            await ws.send_str(json.dumps({"type": "error", "error": str(error)}, ensure_ascii=False))
            await ws.close()
            return ws
        manager = getattr(self.runtime, "run_manager", None)
        hint_provider = getattr(manager, "shelter_restore_hint", None)
        shelter_hint = hint_provider() if callable(hint_provider) else None
        shelter_restore = {
            "hint": shelter_hint,
            "attempted": False,
            "awaiting_state": False,
            "session_id": "",
            "revision": None,
            "requests_sent": 0,
            "retry_limit_warned": False,
        }
        retired_sessions: set[str] = set()

        async def request_shelter_restore(session_id: str, revision: int) -> bool:
            hint = shelter_restore["hint"]
            if hint is None or shelter_restore["requests_sent"] >= MAX_SHELTER_RESTORE_REQUESTS:
                return False
            shelter_restore.update(
                {
                    "awaiting_state": True,
                    "session_id": session_id,
                    "revision": revision,
                    "requests_sent": shelter_restore["requests_sent"] + 1,
                }
            )
            self.runtime.dispatcher.set_readiness_hold(True)
            self.runtime.dispatcher.invalidate_state({"ready": False})
            await send(
                {
                    "type": "state_request",
                    "shelter": {"position": dict(hint["position"]), "size": int(hint["size"])},
                }
            )
            return True

        await send({"type": "welcome", "name": name, "protocol": 1})
        try:
            async for message in ws:
                if message.type != WSMsgType.TEXT:
                    continue
                data = json.loads(message.data)
                kind = data.get("type")
                if kind == "chat":
                    chat = parse_chat(data)
                    if (
                        is_stop(chat["text"])
                        and self.runtime.run_manager is not None
                        and self.runtime.run_manager.running
                    ):
                        self.runtime.run_manager.request_stop()
                    asyncio.create_task(self.runtime.pipeline.respond(chat["text"]))
                elif kind == "action_result":
                    self.runtime.dispatcher.resolve(ActionResult.from_message(data))
                    manager = getattr(self.runtime, "run_manager", None)
                    if manager is not None:
                        manager.on_state_update(self.runtime.dispatcher.state_snapshot())
                elif kind == "action_status_result":
                    self.runtime.dispatcher.resolve_action_status(ActionStatusResult.from_message(data))
                elif kind == "death":
                    lifecycle_id = str(data.get("lifecycle_id") or "")
                    state = {
                        **dict(self.runtime.dispatcher.latest_state),
                        **dict(data.get("data") or {}),
                    }
                    state["lifecycle_id"] = str(data.get("lifecycle_id") or state.get("lifecycle_id") or "")
                    state["alive"] = False
                    state["ready"] = False
                    self.runtime.dispatcher.invalidate_state(state)
                    action_ids = self.runtime.dispatcher.fail_pending(
                        "dead", "Minecraft 角色死亡，动作中止"
                    )
                    manager = getattr(self.runtime, "run_manager", None)
                    if manager is not None:
                        manager.on_death({**state, "interrupted_actions": action_ids})
                    arbiter = getattr(self.runtime, "arbiter", None)
                    if arbiter is not None:
                        await arbiter.cancel_all("玩家角色死亡")
                    await self.runtime.hub.publish(
                        {"type": "player_death", **state, "interrupted_actions": action_ids}
                    )
                    if lifecycle_id:
                        await send({"type": "lifecycle_ack", "event_type": "death", "lifecycle_id": lifecycle_id})
                elif kind == "respawn":
                    lifecycle_id = str(data.get("lifecycle_id") or "")
                    state = dict(data.get("data") or {})
                    state["lifecycle_id"] = str(data.get("lifecycle_id") or state.get("lifecycle_id") or "")
                    state["alive"] = True
                    current_state = dict(self.runtime.dispatcher.latest_state)
                    if current_state:
                        state.setdefault("session_id", current_state.get("session_id", ""))
                        state.setdefault("revision", current_state.get("revision"))
                    state["ready"] = False
                    self.runtime.dispatcher.invalidate_state(state)
                    manager = getattr(self.runtime, "run_manager", None)
                    if manager is not None:
                        manager.on_respawn(state)
                    await self.runtime.hub.publish({"type": "player_respawn", **state})
                    if lifecycle_id:
                        await send({"type": "lifecycle_ack", "event_type": "respawn", "lifecycle_id": lifecycle_id})
                elif kind == "world_unavailable":
                    manager = getattr(self.runtime, "run_manager", None)
                    if manager is not None:
                        manager.on_bridge_unavailable(str(data.get("reason") or "Minecraft world connection lost"))
                    self.runtime.dispatcher.invalidate_state({"ready": False})
                    self.runtime.dispatcher.fail_pending(
                        "disconnected", "Minecraft world connection lost"
                    )
                    arbiter = getattr(self.runtime, "arbiter", None)
                    if arbiter is not None:
                        await arbiter.cancel_all("Minecraft world connection lost")
                    await self.runtime.hub.publish(
                        {"type": "bridge_world_unavailable", "reason": data.get("reason", "")}
                    )
                elif kind == "action_progress":
                    progress = ActionProgress.from_message(data)
                    accepted = self.runtime.dispatcher.on_progress(progress)
                    manager = getattr(self.runtime, "run_manager", None)
                    if accepted and manager is not None:
                        manager.on_action_progress(
                            {
                                "action_id": progress.action_id,
                                "session_id": progress.session_id,
                                "state_revision": progress.state_revision,
                                "executor_epoch": progress.executor_epoch,
                                "phase": progress.phase,
                                "detail": progress.detail,
                                "progress": progress.progress,
                                "data": progress.data,
                            }
                        )
                    await self.runtime.hub.publish(
                        {
                            "type": "action_progress",
                            "action_id": progress.action_id,
                            "skill_id": progress.skill_id,
                            "session_id": progress.session_id,
                            "state_revision": progress.state_revision,
                            "executor_epoch": progress.executor_epoch,
                            "phase": progress.phase,
                            "detail": progress.detail,
                            "progress": progress.progress,
                            "data": progress.data,
                            "accepted": accepted,
                        }
                    )
                elif kind == "reflex_event":
                    event = str(data.get("event") or "")
                    if event not in {
                        "damage",
                        "low_health",
                        "low_oxygen",
                        "critical_hunger",
                        "hostile_nearby",
                    }:
                        await send({"type": "error", "error": "未知安全事件"})
                        continue
                    payload = data.get("data")
                    if not isinstance(payload, dict):
                        await send({"type": "error", "error": "安全事件缺少结构化 data"})
                        continue
                    accepted = False
                    manager = getattr(self.runtime, "run_manager", None)
                    if manager is not None:
                        accepted = manager.on_reflex_event({"event": event, "data": payload})
                    await self.runtime.hub.publish(
                        {"type": "reflex_event", "event": event, "accepted": accepted}
                    )
                elif kind == "hello":
                    self.runtime.dispatcher.bridge_name = str(data.get("bridge", name))
                    await send({"type": "welcome", "name": self.runtime.dispatcher.bridge_name})
                elif kind == "state":
                    incoming_state = data.get("data", {})
                    if not isinstance(incoming_state, dict):
                        continue
                    incoming_session = str(incoming_state.get("session_id") or "")
                    if incoming_session and incoming_session in retired_sessions:
                        continue
                    previous_session = str(self.runtime.dispatcher.latest_state.get("session_id") or "")
                    if previous_session and incoming_session and previous_session != incoming_session:
                        retired_sessions.add(previous_session)
                    accepted = self.runtime.dispatcher.update_state(incoming_state)
                    state = self.runtime.dispatcher.state_snapshot()
                    on_state_update = getattr(manager, "on_state_update", None)
                    allow_resume = True
                    hint = shelter_restore["hint"]
                    if shelter_restore["awaiting_state"]:
                        try:
                            revision = int(incoming_state.get("revision"))
                        except (TypeError, ValueError):
                            revision = None
                        incoming_dimension = _dimension_family(incoming_state.get("dimension"))
                        fresh_context = (
                            accepted
                            and incoming_state.get("ready") is True
                            and bool(incoming_dimension)
                            and revision is not None
                            and _shelter_context(incoming_state.get("shelter")) is not None
                        )
                        same_session = incoming_session == shelter_restore["session_id"]
                        fresh_revision = (
                            revision is not None
                            and revision > int(shelter_restore["revision"])
                        )
                        if same_session and fresh_revision and fresh_context:
                            shelter_restore["awaiting_state"] = False
                            self.runtime.dispatcher.set_readiness_hold(False)
                            state = self.runtime.dispatcher.state_snapshot()
                        elif not same_session and incoming_session and accepted and incoming_state.get("ready") is True:
                            retired_sessions.add(shelter_restore["session_id"])
                            if fresh_context or (incoming_dimension and incoming_dimension != hint["dimension"]):
                                shelter_restore["awaiting_state"] = False
                                self.runtime.dispatcher.set_readiness_hold(False)
                                state = self.runtime.dispatcher.state_snapshot()
                            elif revision is not None and await request_shelter_restore(incoming_session, revision):
                                state = {**dict(incoming_state), "ready": False}
                                allow_resume = False
                            else:
                                shelter_restore["session_id"] = incoming_session
                                shelter_restore["revision"] = revision
                                self.runtime.dispatcher.set_readiness_hold(True)
                                self.runtime.dispatcher.invalidate_state({"ready": False})
                                state = {**dict(incoming_state), "ready": False}
                                allow_resume = False
                                if not shelter_restore["retry_limit_warned"]:
                                    logger.warning(
                                        "庇护所上下文请求达到连接重试上限；等待当前 Bridge session 的新鲜几何状态",
                                        extra={"session_id": incoming_session},
                                    )
                                    shelter_restore["retry_limit_warned"] = True
                        elif (
                            same_session
                            and accepted
                            and incoming_state.get("ready") is True
                            and fresh_revision
                            and incoming_dimension
                            and incoming_dimension != hint["dimension"]
                        ):
                            shelter_restore["awaiting_state"] = False
                            self.runtime.dispatcher.set_readiness_hold(False)
                            state = self.runtime.dispatcher.state_snapshot()
                        elif (
                            same_session
                            and accepted
                            and incoming_state.get("ready") is True
                            and fresh_revision
                            and incoming_dimension == hint["dimension"]
                            and shelter_restore["requests_sent"] < MAX_SHELTER_RESTORE_REQUESTS
                            and await request_shelter_restore(incoming_session, revision)
                        ):
                            state = {**dict(incoming_state), "ready": False}
                            allow_resume = False
                        elif (
                            same_session
                            and fresh_revision
                            and accepted
                            and incoming_state.get("ready") is True
                            and incoming_dimension == hint["dimension"]
                        ):
                            shelter_restore["revision"] = revision
                            self.runtime.dispatcher.set_readiness_hold(True)
                            self.runtime.dispatcher.invalidate_state({"ready": False})
                            state = {**dict(incoming_state), "ready": False}
                            allow_resume = False
                            if not shelter_restore["retry_limit_warned"]:
                                logger.warning(
                                    "庇护所上下文请求达到连接重试上限；等待当前 Bridge session 的新鲜几何状态",
                                    extra={"session_id": incoming_session},
                                )
                                shelter_restore["retry_limit_warned"] = True
                        else:
                            self.runtime.dispatcher.invalidate_state({"ready": False})
                            state = {**dict(incoming_state), "ready": False}
                            allow_resume = False
                    elif (
                        hint is not None
                        and not shelter_restore["attempted"]
                        and accepted
                        and state.get("ready") is True
                    ):
                        shelter_restore["attempted"] = True
                        current_context = _shelter_anchor(state.get("shelter"))
                        try:
                            revision = int(state.get("revision"))
                        except (TypeError, ValueError):
                            revision = None
                        session_id = str(state.get("session_id") or "")
                        same_dimension = _dimension_family(state.get("dimension")) == hint["dimension"]
                        if (
                            current_context is None
                            and same_dimension
                            and state.get("ready") is True
                            and session_id
                            and revision is not None
                            and await request_shelter_restore(session_id, revision)
                        ):
                            state = {**dict(state), "ready": False}
                            allow_resume = False
                    if allow_resume and callable(on_state_update):
                        on_state_update(state)
                    await self.runtime.hub.publish(
                        {"type": "bridge_state", "data": state}
                    )
        except Exception:
            logger.exception("Minecraft 桥接 WebSocket 处理失败: %s", name)
            raise
        finally:
            logger.info(
                "Minecraft 桥接 WebSocket 已关闭: name=%s close_code=%s exception=%r",
                name,
                ws.close_code,
                ws.exception(),
            )
            arbiter = getattr(self.runtime, "arbiter", None)
            manager = getattr(self.runtime, "run_manager", None)
            on_unavailable = getattr(manager, "on_bridge_unavailable", None)
            if callable(on_unavailable):
                on_unavailable("Minecraft bridge websocket closed")
            self.runtime.dispatcher.invalidate_state({"ready": False})
            if arbiter is not None:
                await arbiter.cancel_all("Minecraft bridge disconnected")
            self.runtime.dispatcher.detach(send)
        return ws

    async def websocket(self, request: web.Request) -> web.StreamResponse:
        ws = web.WebSocketResponse(heartbeat=30)
        await ws.prepare(request)
        queue = self.runtime.hub.subscribe()

        async def forward_events() -> None:
            while not ws.closed:
                payload = await queue.get()
                await ws.send_str(json.dumps(payload, ensure_ascii=False))

        async def read_commands() -> None:
            async for message in ws:
                if message.type != WSMsgType.TEXT:
                    continue
                command = json.loads(message.data)
                if command.get("type") == "say":
                    asyncio.create_task(self.runtime.pipeline.respond(command["text"]))
                elif command.get("type") == "interrupt":
                    await self.runtime.pipeline.interrupt("ws_command")

        forward = asyncio.create_task(forward_events())
        reading = asyncio.create_task(read_commands())
        done, pending = await asyncio.wait(
            {forward, reading}, return_when=asyncio.FIRST_COMPLETED
        )
        for task in pending:
            task.cancel()
        for task in done:
            task.result()
        self.runtime.hub.unsubscribe(queue)
        return ws
