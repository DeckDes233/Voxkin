from __future__ import annotations

import re
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from voxkin.config import MemoryConfig

CJK_PATTERN = re.compile(r"[\u4e00-\u9fff]+")
LATIN_PATTERN = re.compile(r"[A-Za-z0-9_]{2,}")
STOP_CHARS = set("的了呢吧啊呀是不我你他她它们这那个有在就很都要会吗嘛哦嗯")


def estimate_tokens(text: str) -> int:
    if not text:
        return 0
    cjk = len(CJK_PATTERN.findall(text))
    latin = len(LATIN_PATTERN.findall(text))
    other = max(0, len(text) - cjk - latin * 2)
    return int(cjk * 0.9 + latin * 1.5 + other * 0.3) + 1


def extract_keywords(text: str, limit: int = 24) -> list[str]:
    keywords: list[str] = []
    for run in CJK_PATTERN.findall(text):
        for index in range(len(run) - 1):
            bigram = run[index : index + 2]
            if any(char in STOP_CHARS for char in bigram):
                continue
            keywords.append(bigram)
    for word in LATIN_PATTERN.findall(text):
        keywords.append(word.lower())
    seen: dict[str, None] = {}
    for keyword in keywords:
        if keyword not in seen:
            seen[keyword] = None
        if len(seen) >= limit:
            break
    return list(seen)


@dataclass
class MemoryRecord:
    id: int
    kind: str
    content: str
    keywords: str
    created_at: float
    weight: float


class MemoryStore:
    """SQLite 持久化：原始对话、可检索的长期记忆与压缩摘要。"""

    def __init__(self, config: MemoryConfig) -> None:
        self.config = config
        self.path = Path(config.db_path)
        self.session_id = config.session_id
        self._lock = threading.Lock()
        self._connection: sqlite3.Connection | None = None

    def initialize(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.path, check_same_thread=False)
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=NORMAL")
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS turns (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                request_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at REAL NOT NULL,
                summarized INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, id);
            CREATE TABLE IF NOT EXISTS memories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                content TEXT NOT NULL,
                keywords TEXT NOT NULL,
                created_at REAL NOT NULL,
                weight REAL NOT NULL DEFAULT 1.0,
                last_used_at REAL
            );
            CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id, id);
            """
        )
        connection.commit()
        self._connection = connection

    def _conn(self) -> sqlite3.Connection:
        if self._connection is None:
            self.initialize()
        return self._connection

    def add_turn(self, request_id: str, role: str, content: str) -> int:
        with self._lock:
            cursor = self._conn().execute(
                "INSERT INTO turns (session_id, request_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)",
                (self.session_id, request_id, role, content, time.time()),
            )
            self._conn().commit()
            return int(cursor.lastrowid)

    def recent_turns(self, limit: int = 12) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn().execute(
                "SELECT id, request_id, role, content, created_at FROM turns "
                "WHERE session_id = ? ORDER BY id DESC LIMIT ?",
                (self.session_id, limit),
            ).fetchall()
        return [
            {"id": row[0], "request_id": row[1], "role": row[2], "content": row[3], "created_at": row[4]}
            for row in reversed(rows)
        ]

    def unsummarized_turns(self, limit: int = 200) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn().execute(
                "SELECT id, request_id, role, content FROM turns "
                "WHERE session_id = ? AND summarized = 0 ORDER BY id ASC LIMIT ?",
                (self.session_id, limit),
            ).fetchall()
        return [
            {"id": row[0], "request_id": row[1], "role": row[2], "content": row[3]} for row in rows
        ]

    def mark_summarized(self, turn_ids: Iterable[int]) -> None:
        ids = list(turn_ids)
        if not ids:
            return
        placeholders = ",".join("?" for _ in ids)
        with self._lock:
            self._conn().execute(
                f"UPDATE turns SET summarized = 1 WHERE id IN ({placeholders})", ids
            )
            self._conn().commit()

    def add_memory(self, kind: str, content: str, keywords: str | None = None) -> int:
        keyword_text = keywords if keywords is not None else " ".join(extract_keywords(content))
        with self._lock:
            cursor = self._conn().execute(
                "INSERT INTO memories (session_id, kind, content, keywords, created_at) VALUES (?, ?, ?, ?, ?)",
                (self.session_id, kind, content, keyword_text, time.time()),
            )
            self._conn().commit()
            return int(cursor.lastrowid)

    def search(self, query: str, limit: int = 5) -> list[MemoryRecord]:
        query_keywords = set(extract_keywords(query, limit=40))
        if not query_keywords:
            return []
        with self._lock:
            rows = self._conn().execute(
                "SELECT id, kind, content, keywords, created_at, weight FROM memories WHERE session_id = ?",
                (self.session_id,),
            ).fetchall()
        scored: list[tuple[float, MemoryRecord]] = []
        for row in rows:
            memory_keywords = set(row[3].split())
            overlap = len(query_keywords & memory_keywords)
            if overlap == 0:
                continue
            score = overlap * float(row[5]) + 0.1
            scored.append((score, MemoryRecord(row[0], row[1], row[2], row[3], row[4], row[5])))
        scored.sort(key=lambda item: item[0], reverse=True)
        selected = [item[1] for item in scored[:limit]]
        if selected:
            with self._lock:
                self._conn().executemany(
                    "UPDATE memories SET last_used_at = ? WHERE id = ?",
                    [(time.time(), record.id) for record in selected],
                )
                self._conn().commit()
        return selected

    def counts(self) -> dict[str, int]:
        with self._lock:
            turns = self._conn().execute(
                "SELECT COUNT(*) FROM turns WHERE session_id = ?", (self.session_id,)
            ).fetchone()[0]
            memories = self._conn().execute(
                "SELECT COUNT(*) FROM memories WHERE session_id = ?", (self.session_id,)
            ).fetchone()[0]
        return {"turns": int(turns), "memories": int(memories)}

    def close(self) -> None:
        with self._lock:
            if self._connection is not None:
                self._connection.close()
                self._connection = None


SUMMARY_INSTRUCTION = (
    "你在为 Minecraft 里的 AI 伙伴整理长期记忆。"
    "把下面的对话压缩成不超过 120 字的记忆，保留玩家目标、已完成或失败的动作、"
    "重要地点、承诺与偏好。只输出记忆正文，不要列表符号。"
)


class MemoryWriter:
    """把较早的对话压缩成摘要写入长期记忆，原始记录保留在 turns 表。"""

    def __init__(self, store: MemoryStore, llm: Any, config: MemoryConfig) -> None:
        self.store = store
        self.llm = llm
        self.config = config

    async def maybe_summarize(self) -> str | None:
        turns = self.store.unsummarized_turns(limit=self.config.summarize_threshold)
        if len(turns) < self.config.summarize_threshold:
            return None
        transcript = "\n".join(f"{turn['role']}: {turn['content']}" for turn in turns)
        messages = [
            {"role": "system", "content": SUMMARY_INSTRUCTION},
            {"role": "user", "content": transcript[:4000]},
        ]
        parts: list[str] = []
        async for delta in self.llm.stream_chat(messages):
            if delta.kind == "text":
                parts.append(delta.text)
        summary = "".join(parts).strip()
        if not summary:
            return None
        summary = summary[: self.config.summary_max_chars]
        self.store.add_memory("summary", summary)
        self.store.mark_summarized(turn["id"] for turn in turns)
        return summary


class ContextBuilder:
    """按预算组装上下文：人格、相关长期记忆、最近对话。"""

    def __init__(self, store: MemoryStore, config: MemoryConfig, system_prompt: str) -> None:
        self.store = store
        self.config = config
        self.system_prompt = system_prompt

    def build(self, user_text: str) -> list[dict[str, str]]:
        system_parts = [self.system_prompt] if self.system_prompt else []
        memories = self.store.search(user_text, limit=self.config.retrieve_limit)
        if memories:
            lines = "\n".join(f"- {record.content}" for record in memories)
            system_parts.append(f"关于过去的可靠记忆（只在相关时使用）：\n{lines}")
        messages: list[dict[str, str]] = []
        if system_parts:
            messages.append({"role": "system", "content": "\n\n".join(system_parts)})
        budget = self.config.context_token_budget
        recent = self.store.recent_turns(limit=self.config.recent_turns)
        kept: list[dict[str, str]] = []
        for turn in reversed(recent):
            cost = estimate_tokens(turn["content"])
            if cost > budget:
                break
            budget -= cost
            kept.append({"role": turn["role"], "content": turn["content"]})
        messages.extend(reversed(kept))
        messages.append({"role": "user", "content": user_text})
        return messages
