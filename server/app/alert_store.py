"""告警事件的独立 SQLite 存储。"""

from __future__ import annotations

import sqlite3
import threading
import time
from pathlib import Path


class AlertStore:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        with self._lock:
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.executescript("""
                CREATE TABLE IF NOT EXISTS alerts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    rule_id TEXT NOT NULL,
                    rule_name TEXT NOT NULL,
                    twin_id TEXT NOT NULL,
                    level TEXT NOT NULL,
                    message TEXT NOT NULL,
                    value REAL,
                    started_at INTEGER NOT NULL,
                    resolved_at INTEGER,
                    acknowledged_at INTEGER,
                    acknowledged_by TEXT
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_alert_open
                    ON alerts(rule_id, twin_id) WHERE resolved_at IS NULL;
                CREATE INDEX IF NOT EXISTS idx_alert_twin_time
                    ON alerts(twin_id, started_at DESC);
                CREATE INDEX IF NOT EXISTS idx_alert_time ON alerts(started_at DESC);
            """)

    @staticmethod
    def _record(row: sqlite3.Row) -> dict:
        item = dict(row)
        result = {
            "id": item["id"], "ruleId": item["rule_id"], "ruleName": item["rule_name"],
            "twinId": item["twin_id"], "level": item["level"], "message": item["message"],
            "value": item["value"], "startedAt": item["started_at"],
            "resolvedAt": item["resolved_at"], "acknowledgedAt": item["acknowledged_at"],
            "acknowledgedBy": item["acknowledged_by"],
        }
        result["active"] = result["resolvedAt"] is None
        result["acknowledged"] = result["acknowledgedAt"] is not None
        return result

    def raise_alert(self, rule: dict, twin_id: str, value: float, message: str) -> dict:
        now = int(time.time() * 1000)
        with self._lock:
            cursor = self._db.execute(
                "INSERT INTO alerts(rule_id,rule_name,twin_id,level,message,value,started_at) "
                "VALUES(?,?,?,?,?,?,?)",
                (rule["id"], rule["name"], twin_id, rule["level"], message, value, now),
            )
            self._db.commit()
            row = self._db.execute("SELECT * FROM alerts WHERE id=?", (cursor.lastrowid,)).fetchone()
        return self._record(row)

    def resolve(self, alert_id: int) -> dict | None:
        now = int(time.time() * 1000)
        with self._lock:
            cursor = self._db.execute(
                "UPDATE alerts SET resolved_at=? WHERE id=? AND resolved_at IS NULL", (now, alert_id)
            )
            self._db.commit()
            row = self._db.execute("SELECT * FROM alerts WHERE id=?", (alert_id,)).fetchone() if cursor.rowcount else None
        return self._record(row) if row else None

    def acknowledge(self, alert_id: int, user: str) -> dict | None:
        now = int(time.time() * 1000)
        with self._lock:
            cursor = self._db.execute(
                "UPDATE alerts SET acknowledged_at=?,acknowledged_by=? "
                "WHERE id=? AND acknowledged_at IS NULL", (now, user, alert_id)
            )
            self._db.commit()
            row = self._db.execute("SELECT * FROM alerts WHERE id=?", (alert_id,)).fetchone() if cursor.rowcount else None
        return self._record(row) if row else None

    def active(self) -> list[dict]:
        with self._lock:
            rows = self._db.execute(
                "SELECT * FROM alerts WHERE resolved_at IS NULL ORDER BY "
                "CASE level WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, started_at DESC"
            ).fetchall()
        return [self._record(row) for row in rows]

    def history(self, limit: int = 100, twin_id: str | None = None,
                level: str | None = None, since: int | None = None) -> list[dict]:
        sql = "SELECT * FROM alerts WHERE 1=1"
        args: list = []
        if twin_id:
            sql += " AND twin_id=?"
            args.append(twin_id)
        if level:
            sql += " AND level=?"
            args.append(level)
        if since is not None:
            sql += " AND started_at>=?"
            args.append(since)
        sql += " ORDER BY started_at DESC,id DESC LIMIT ?"
        args.append(max(1, min(limit, 1000)))
        with self._lock:
            rows = self._db.execute(sql, args).fetchall()
        return [self._record(row) for row in rows]

    def stats(self, since: int | None = None) -> dict:
        where = " WHERE started_at>=?" if since is not None else ""
        args = [since] if since is not None else []
        with self._lock:
            rows = self._db.execute("SELECT * FROM alerts" + where, args).fetchall()
        records = [self._record(row) for row in rows]
        by_level: dict[str, int] = {}
        by_twin: dict[str, int] = {}
        by_rule: dict[tuple[str, str], int] = {}
        durations = []
        for item in records:
            by_level[item["level"]] = by_level.get(item["level"], 0) + 1
            by_twin[item["twinId"]] = by_twin.get(item["twinId"], 0) + 1
            key = (item["ruleId"], item["ruleName"])
            by_rule[key] = by_rule.get(key, 0) + 1
            if item["resolvedAt"] is not None:
                durations.append(item["resolvedAt"] - item["startedAt"])
        return {
            "total": len(records),
            "active": sum(item["active"] for item in records),
            "acknowledged": sum(item["acknowledged"] for item in records),
            "byLevel": by_level,
            "byTwin": [{"twinId": key, "count": count} for key, count in sorted(by_twin.items(), key=lambda pair: -pair[1])],
            "byRule": [{"ruleId": key[0], "ruleName": key[1], "count": count} for key, count in sorted(by_rule.items(), key=lambda pair: -pair[1])],
            "avgDurationSec": round(sum(durations) / len(durations) / 1000, 1) if durations else None,
        }

    def close(self) -> None:
        with self._lock:
            self._db.close()
