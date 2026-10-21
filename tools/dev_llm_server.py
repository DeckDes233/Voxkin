# 本地 OpenAI 兼容流式服务，用于离线基准与端到端测试，不访问外网。
from __future__ import annotations

import argparse
import asyncio
import json
import time
from typing import Any

from aiohttp import web

REPLY = (
    "我在呢。刚才把矿洞出口的火把重新插好了，顺路把掉在岩浆边的铁矿捡了回来。"
    "你要不要先看看背包，缺什么我们再去补。"
)


def build_app(delay_ms: int = 25, reply: str = REPLY) -> web.Application:
    app = web.Application()
    app["delay_ms"] = delay_ms
    app["reply"] = reply
    app.router.add_post("/v1/chat/completions", completions)
    app.router.add_get("/health", health)
    return app


async def health(request: web.Request) -> web.Response:
    return web.json_response({"status": "ok"})


async def completions(request: web.Request) -> web.StreamResponse:
    body = await request.json()
    if not body.get("stream"):
        return web.json_response(
            {
                "choices": [
                    {
                        "message": {"role": "assistant", "content": request.app["reply"]},
                        "finish_reason": "stop",
                    }
                ]
            }
        )
    response = web.StreamResponse(
        headers={"Content-Type": "text/event-stream", "Cache-Control": "no-cache"}
    )
    await response.prepare(request)
    delay = request.app["delay_ms"] / 1000.0
    text = request.app["reply"]
    messages = body.get("messages") or []
    last_user = str(messages[-1].get("content", "")) if messages else ""
    wants_action = "ACTION" in last_user
    dig_block = "dirt" if "泥土" in last_user else "oak_log"
    if wants_action:
        text = "我先去挖一点。"
    chunk_size = 2
    for index in range(0, len(text), chunk_size):
        payload = {
            "choices": [{"delta": {"content": text[index : index + chunk_size]}, "index": 0}]
        }
        try:
            await response.write(f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode())
        except ConnectionResetError:
            return response
        await asyncio.sleep(delay)
    if wants_action:
        call = {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call_dev_1",
                                "type": "function",
                                "function": {
                                    "name": "collect_blocks",
                                    "arguments": json.dumps({"block": dig_block, "count": 3}),
                                },
                            }
                        ]
                    },
                    "index": 0,
                }
            ]
        }
        await response.write(f"data: {json.dumps(call, ensure_ascii=False)}\n\n".encode())
        await asyncio.sleep(delay)
    await response.write(b"data: [DONE]\n\n")
    await response.write_eof()
    return response


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8799)
    parser.add_argument("--delay-ms", type=int, default=25)
    args = parser.parse_args()
    web.run_app(build_app(args.delay_ms), host="127.0.0.1", port=args.port)


if __name__ == "__main__":
    main()
