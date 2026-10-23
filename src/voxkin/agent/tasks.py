from __future__ import annotations

import json
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class Task:
    id: int
    objective: str
    stage: str
    status: str
    created_at: float
    updated_at: float


@dataclass(frozen=True)
class Step:
    id: int
    task_id: int
    position: int
    description: str
    tool: str
    arguments: dict[str, Any]
    status: str
    result: str


class TaskStore:
    """通关任务的持久化：任务、步骤与事件，重启后可继续。"""

    def __init__(self, path: Path | str = "data/tasks.db") -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._connection = sqlite3.connect(str(self.path))
        self._connection.row_factory = sqlite3.Row

    def initialize(self) -> None:
        self._connection.executescript(
            """
            create table if not exists tasks (
                id integer primary key autoincrement,
                objective text not null,
                stage text not null default 'S0',
                status text not null default 'active',
                created_at real not null,
                updated_at real not null
            );
            create table if not exists steps (
                id integer primary key autoincrement,
                task_id integer not null,
                position integer not null,
                description text not null,
                tool text not null default '',
                arguments text not null default '{}',
                status text not null default 'pending',
                result text not null default ''
            );
            create table if not exists events (
                id integer primary key autoincrement,
                task_id integer not null,
                kind text not null,
                payload text not null default '{}',
                created_at real not null
            );
            create table if not exists checkpoints (
                task_id integer primary key,
                cursor integer not null default 0,
                payload text not null default '{}',
                updated_at real not null
            );
            """
        )
        self._connection.commit()

    def create_task(self, objective: str, stage: str = "S0") -> Task:
        now = time.time()
        cursor = self._connection.execute(
            "insert into tasks (objective, stage, status, created_at, updated_at) "
            "values (?, ?, 'active', ?, ?)",
            (objective, stage, now, now),
        )
        self._connection.commit()
        return self.get_task(int(cursor.lastrowid))

    def get_task(self, task_id: int) -> Task:
        row = self._connection.execute("select * from tasks where id = ?", (task_id,)).fetchone()
        if row is None:
            raise KeyError(f"任务不存在: {task_id}")
        return Task(
            id=row["id"],
            objective=row["objective"],
            stage=row["stage"],
            status=row["status"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    def latest_active(self) -> Task | None:
        row = self._connection.execute(
            "select * from tasks where status = 'active' order by id desc limit 1"
        ).fetchone()
        if row is None:
            return None
        return Task(
            id=row["id"],
            objective=row["objective"],
            stage=row["stage"],
            status=row["status"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    def latest_resumable(self) -> Task | None:
        row = self._connection.execute(
            "select * from tasks where status in ('active', 'cancelled', 'blocked', 'failed', 'dead') "
            "order by case status when 'active' then 0 else 1 end, updated_at desc, id desc limit 1"
        ).fetchone()
        if row is None:
            return None
        return Task(
            id=row["id"],
            objective=row["objective"],
            stage=row["stage"],
            status=row["status"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    def set_status(self, task_id: int, status: str, stage: str | None = None) -> None:
        if stage is None:
            self._connection.execute(
                "update tasks set status = ?, updated_at = ? where id = ?",
                (status, time.time(), task_id),
            )
        else:
            self._connection.execute(
                "update tasks set status = ?, stage = ?, updated_at = ? where id = ?",
                (status, stage, time.time(), task_id),
            )
        self._connection.commit()

    def add_step(
        self,
        task_id: int,
        position: int,
        description: str,
        tool: str = "",
        arguments: dict[str, Any] | None = None,
    ) -> Step:
        cursor = self._connection.execute(
            "insert into steps (task_id, position, description, tool, arguments) "
            "values (?, ?, ?, ?, ?)",
            (task_id, position, description, tool, json.dumps(arguments or {}, ensure_ascii=False)),
        )
        self._connection.commit()
        return self.get_step(int(cursor.lastrowid))

    def get_step(self, step_id: int) -> Step:
        row = self._connection.execute("select * from steps where id = ?", (step_id,)).fetchone()
        if row is None:
            raise KeyError(f"步骤不存在: {step_id}")
        return Step(
            id=row["id"],
            task_id=row["task_id"],
            position=row["position"],
            description=row["description"],
            tool=row["tool"],
            arguments=json.loads(row["arguments"]),
            status=row["status"],
            result=row["result"],
        )

    def finish_step(self, step_id: int, status: str, result: str = "") -> None:
        self._connection.execute(
            "update steps set status = ?, result = ? where id = ?",
            (status, result, step_id),
        )
        self._connection.commit()

    def steps(self, task_id: int) -> list[Step]:
        rows = self._connection.execute(
            "select id from steps where task_id = ? order by position, id", (task_id,)
        ).fetchall()
        return [self.get_step(row["id"]) for row in rows]

    def save_checkpoint(
        self, task_id: int, cursor: int, payload: dict[str, Any] | None = None
    ) -> None:
        self._connection.execute(
            "insert into checkpoints (task_id, cursor, payload, updated_at) "
            "values (?, ?, ?, ?) on conflict(task_id) do update set "
            "cursor = excluded.cursor, payload = excluded.payload, updated_at = excluded.updated_at",
            (task_id, cursor, json.dumps(payload or {}, ensure_ascii=False), time.time()),
        )
        self._connection.commit()

    def load_checkpoint(self, task_id: int) -> dict[str, Any] | None:
        row = self._connection.execute(
            "select * from checkpoints where task_id = ?", (task_id,)
        ).fetchone()
        if row is None:
            return None
        return {"cursor": row["cursor"], "payload": json.loads(row["payload"])}

    def resume_cursor(self, task_id: int) -> int:
        checkpoint = self.load_checkpoint(task_id)
        return int(checkpoint["cursor"]) if checkpoint else 0

    def log_event(self, task_id: int, kind: str, payload: dict[str, Any] | None = None) -> None:
        self._connection.execute(
            "insert into events (task_id, kind, payload, created_at) values (?, ?, ?, ?)",
            (task_id, kind, json.dumps(payload or {}, ensure_ascii=False), time.time()),
        )
        self._connection.commit()

    def events(self, task_id: int, limit: int = 20) -> list[dict[str, Any]]:
        rows = self._connection.execute(
            "select * from events where task_id = ? order by id desc limit ?",
            (task_id, limit),
        ).fetchall()
        return [
            {
                "kind": row["kind"],
                "payload": json.loads(row["payload"]),
                "created_at": row["created_at"],
            }
            for row in reversed(rows)
        ]

    def close(self) -> None:
        self._connection.close()
