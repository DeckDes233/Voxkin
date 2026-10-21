from __future__ import annotations

import asyncio
import json
import time
from typing import Any, AsyncIterator, Sequence

import aiohttp

from voxkin.config import LLMConfig
from voxkin.llm.base import LLMDelta, LLMError


class OpenAICompatLLM:
    """OpenAI 兼容接口的流式客户端，适用于 DeepSeek、vLLM、llama.cpp server。"""

    def __init__(self, config: LLMConfig) -> None:
        self.config = config
        self._session: aiohttp.ClientSession | None = None
        self._api_key = config.resolve_api_key()
        if not self._api_key:
            raise LLMError(
                f"缺少 API Key：请设置环境变量 {config.api_key_env} 或在 config/local.yaml 写入 llm.api_key"
            )

    def _get_session(self) -> aiohttp.ClientSession:
        if self._session is None or self._session.closed:
            timeout = aiohttp.ClientTimeout(total=None, sock_connect=15, sock_read=self.config.timeout_s)
            self._session = aiohttp.ClientSession(
                timeout=timeout, connector=aiohttp.TCPConnector(force_close=True)
            )
        return self._session

    def describe(self) -> dict[str, Any]:
        return {
            "provider": "openai_compat",
            "base_url": self.config.base_url,
            "model": self.config.model,
            "stream": self.config.stream,
            "api_key_configured": bool(self._api_key),
        }

    async def close(self) -> None:
        if self._session is not None and not self._session.closed:
            await self._session.close()

    async def stream_chat(
        self,
        messages: Sequence[dict[str, str]],
        tools: Sequence[dict[str, Any]] | None = None,
    ) -> AsyncIterator[LLMDelta]:
        payload = {
            "model": self.config.model,
            "messages": list(messages),
            "temperature": self.config.temperature,
            "max_tokens": self.config.max_tokens,
            "stream": self.config.stream,
        }
        if tools:
            payload["tools"] = list(tools)
            payload["tool_choice"] = "auto"
        url = self.config.base_url.rstrip("/") + "/chat/completions"
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }
        headers.update(self.config.headers)
        session = self._get_session()
        async with session.post(url, json=payload, headers=headers) as response:
            if response.status != 200:
                body = await response.text()
                raise LLMError(f"LLM 请求失败 status={response.status} body={body[:500]}")
            if not self.config.stream:
                data = await response.json()
                text = data["choices"][0]["message"].get("content") or ""
                if text:
                    yield LLMDelta(kind="text", text=text)
                yield LLMDelta(kind="done")
                return
            async for delta in self._iter_sse(response):
                yield delta

    async def _iter_sse(self, response: aiohttp.ClientResponse) -> AsyncIterator[LLMDelta]:
        tool_calls: dict[int, dict[str, Any]] = {}
        async for raw_line in response.content:
            line = raw_line.decode("utf-8").strip()
            if not line or not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            chunk = json.loads(data)
            choices = chunk.get("choices") or []
            if not choices:
                continue
            delta = choices[0].get("delta") or {}
            content = delta.get("content")
            if content:
                yield LLMDelta(kind="text", text=content)
            for entry in delta.get("tool_calls") or []:
                index = entry.get("index", 0)
                slot = tool_calls.setdefault(index, {"name": "", "arguments": ""})
                function = entry.get("function") or {}
                if function.get("name"):
                    slot["name"] = function["name"]
                if function.get("arguments"):
                    slot["arguments"] += function["arguments"]
        for index in sorted(tool_calls):
            slot = tool_calls[index]
            try:
                arguments = json.loads(slot["arguments"]) if slot["arguments"] else {}
            except json.JSONDecodeError as error:
                raise LLMError(f"工具调用参数不是合法 JSON: {slot['arguments'][:200]}") from error
            yield LLMDelta(
                kind="tool_call", tool_call={"name": slot["name"], "arguments": arguments}
            )
        yield LLMDelta(kind="done")


class TimedLLMProbe:
    """用于诊断接口：记录首 token 时间与总耗时。"""

    def __init__(self, adapter: OpenAICompatLLM) -> None:
        self.adapter = adapter

    async def run(self, messages: Sequence[dict[str, str]]) -> dict[str, Any]:
        started = time.perf_counter()
        first_token_at: float | None = None
        text_parts: list[str] = []
        tool_calls: list[dict[str, Any]] = []
        async for delta in self.adapter.stream_chat(messages):
            if delta.kind == "text":
                if first_token_at is None:
                    first_token_at = time.perf_counter()
                text_parts.append(delta.text)
            elif delta.kind == "tool_call" and delta.tool_call:
                tool_calls.append(delta.tool_call)
        finished = time.perf_counter()
        return {
            "text": "".join(text_parts),
            "tool_calls": tool_calls,
            "ttft_ms": round((first_token_at - started) * 1000, 1) if first_token_at else None,
            "total_ms": round((finished - started) * 1000, 1),
        }
