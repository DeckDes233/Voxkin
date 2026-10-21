from __future__ import annotations

from typing import Any, AsyncIterator, Protocol

import numpy as np


class TTSError(RuntimeError):
    pass


class TTSAdapter(Protocol):
    sample_rate: int

    async def initialize(self) -> None: ...

    def describe(self) -> dict[str, Any]: ...

    def synthesize(self, text: str) -> AsyncIterator[np.ndarray]: ...

    async def stop(self) -> None: ...

    async def close(self) -> None: ...
