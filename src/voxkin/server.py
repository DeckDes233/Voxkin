from __future__ import annotations

import asyncio
import io
import json
import time
import uuid
from pathlib import Path
from typing import Any

from aiohttp import WSMsgType, web

from voxkin.audio.capture import Microphone
from voxkin.audio.wav import arrays_to_wav_bytes
from voxkin.agent.actions import ActionError
from voxkin.bridge.protocol import ActionResult, parse_chat
from voxkin.config import load_config, save_config
from voxkin.logging_setup import tail_log
from voxkin.runtime import Runtime
from voxkin.services import ServiceError

STATIC_DIR = Path(__file__).with_name("studio")


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
        app.router.add_post("/api/say", self.say)
        app.router.add_post("/api/interrupt", self.interrupt)
        app.router.add_post("/api/tts", self.tts)
        app.router.add_post("/api/stt", self.stt)
        app.router.add_get("/api/metrics", self.metrics)
        app.router.add_get("/api/logs", self.logs)
        app.router.add_get("/api/audio/devices", self.audio_devices)
        app.router.add_get("/api/services", self.services)
        app.router.add_post("/api/services/{name}/{action}", self.service_action)
        app.router.add_post("/api/config", self.update_config)
        app.router.add_get("/ws", self.websocket)
        app.router.add_get("/ws/bridge", self.bridge_socket)
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
        return web.json_response(payload)

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
        await send({"type": "welcome", "name": name, "protocol": 1})
        try:
            async for message in ws:
                if message.type != WSMsgType.TEXT:
                    continue
                data = json.loads(message.data)
                kind = data.get("type")
                if kind == "chat":
                    chat = parse_chat(data)
                    asyncio.create_task(self.runtime.pipeline.respond(chat["text"]))
                elif kind == "action_result":
                    self.runtime.dispatcher.resolve(ActionResult.from_message(data))
                elif kind == "hello":
                    self.runtime.dispatcher.bridge_name = str(data.get("bridge", name))
                    await send({"type": "welcome", "name": self.runtime.dispatcher.bridge_name})
                elif kind == "state":
                    await self.runtime.hub.publish(
                        {"type": "bridge_state", "data": data.get("data", {})}
                    )
        finally:
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
