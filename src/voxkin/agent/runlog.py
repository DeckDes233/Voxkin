from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any


class RunLogger:
    """一次通关演练的 JSONL 记录：状态、计划、动作、判定都能回放。"""

    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def log(self, kind: str, payload: dict[str, Any] | None = None) -> None:
        record = {"ts": round(time.time(), 4), "kind": kind}
        record.update(payload or {})
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")

    def tail(self, limit: int = 20) -> list[dict[str, Any]]:
        if not self.path.exists():
            return []
        lines = self.path.read_text(encoding="utf-8").splitlines()[-limit:]
        return [json.loads(line) for line in lines if line.strip()]
