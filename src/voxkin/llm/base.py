from __future__ import annotations

from dataclasses import dataclass
from typing import Any, AsyncIterator, Protocol, Sequence


@dataclass
class LLMDelta:
    kind: str
    text: str = ""
    tool_call: dict[str, Any] | None = None


class LLMAdapter(Protocol):
    async def stream_chat(
        self, messages: Sequence[dict[str, str]]
    ) -> AsyncIterator[LLMDelta]: ...

    async def close(self) -> None: ...

    def describe(self) -> dict[str, Any]: ...


class LLMError(RuntimeError):
    pass
