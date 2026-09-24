from __future__ import annotations

import json
import sqlite3
import threading
from abc import ABC, abstractmethod
from pathlib import Path


class TimeSeriesStore(ABC):
    @abstractmethod
    def append(self, twin_id: str, kind: str, ts: int, payload: dict) -> None: ...

    @abstractmethod
    def recent(self, twin_id: str, limit: int = 120) -> list[dict]: ...


class SQLiteTimeSeriesStore(TimeSeriesStore):
    """小规模演示/部署用 SQLite 实现；所有连接访问均由同一把锁保护。"""

    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(path, check_same_thread=False)
        with self._lock:
            self._db.execute(
                "CREATE TABLE IF NOT EXISTS telemetry ("
                "id INTEGER PRIMARY KEY, twin_id TEXT NOT NULL, type TEXT NOT NULL, "
                "ts INTEGER NOT NULL, payload TEXT NOT NULL)"
            )
            self._db.execute("CREATE INDEX IF NOT EXISTS idx_telemetry_twin_ts ON telemetry(twin_id, ts)")
            self._db.commit()

    def append(self, twin_id: str, kind: str, ts: int, payload: dict) -> None:
        with self._lock:
            self._db.execute(
                "INSERT INTO telemetry(twin_id,type,ts,payload) VALUES(?,?,?,?)",
                (twin_id, kind, ts, json.dumps(payload, ensure_ascii=False)),
            )
            self._db.commit()

    def recent(self, twin_id: str, limit: int = 120) -> list[dict]:
        with self._lock:
            rows = self._db.execute(
                "SELECT type,ts,payload FROM telemetry WHERE twin_id=? ORDER BY ts DESC LIMIT ?",
                (twin_id, max(1, min(limit, 1000))),
            ).fetchall()
        return [{"type": kind, "ts": ts, "payload": json.loads(payload)} for kind, ts, payload in reversed(rows)]

