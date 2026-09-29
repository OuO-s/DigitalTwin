"""字段消息评估与设备离线扫描组成的告警引擎。"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import time
from pathlib import Path

from .alert_store import AlertStore

log = logging.getLogger(__name__)
OPS = {
    "lt": lambda value, threshold: value < threshold,
    "lte": lambda value, threshold: value <= threshold,
    "gt": lambda value, threshold: value > threshold,
    "gte": lambda value, threshold: value >= threshold,
    "eq": lambda value, threshold: value == threshold,
    "ne": lambda value, threshold: value != threshold,
}


def load_rules(path: Path) -> list[dict]:
    """只启用结构完整的规则，避免错误配置中断设备收数。"""
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        candidates = data["rules"] if isinstance(data, dict) else data
        if not isinstance(candidates, list):
            raise ValueError("rules 必须是数组")
    except (OSError, ValueError, KeyError, TypeError) as exc:
        log.warning("告警规则无法载入（%s）：%s", path, exc)
        return []
    rules = []
    seen = set()
    for item in candidates:
        try:
            if not isinstance(item, dict):
                raise ValueError("规则必须是对象")
            rule = dict(item)
            if not isinstance(rule.get("id"), str) or not rule["id"] or rule["id"] in seen:
                raise ValueError("id 缺失或重复")
            if not isinstance(rule.get("field"), str) or not rule["field"]:
                raise ValueError("field 缺失")
            if not isinstance(rule.get("twinId", "*"), str):
                raise ValueError("twinId 必须是字符串")
            if isinstance(rule.get("threshold"), bool) or not isinstance(rule.get("threshold"), (int, float)) or not math.isfinite(rule["threshold"]):
                raise ValueError("threshold 必须是有限数字")
            if rule["field"] != "@offline" and rule.get("op") not in OPS:
                raise ValueError("op 不受支持")
            if rule["field"] == "@offline" and rule["threshold"] <= 0:
                raise ValueError("离线阈值必须大于零")
            debounce = rule.get("for", 0)
            if isinstance(debounce, bool) or not isinstance(debounce, (int, float)) or not math.isfinite(debounce) or debounce < 0:
                raise ValueError("for 必须是非负秒数")
            if rule.get("level", "warning") not in ("critical", "warning", "info"):
                raise ValueError("level 不受支持")
            rule["name"] = str(rule.get("name") or rule["id"])
            rule["twinId"] = rule.get("twinId", "*")
            rule["level"] = rule.get("level", "warning")
            rule["for"] = debounce
            rule["message"] = str(rule.get("message") or rule["name"])
            rules.append(rule)
            seen.add(rule["id"])
        except ValueError as exc:
            log.warning("跳过无效告警规则 %s：%s", item.get("id") if isinstance(item, dict) else item, exc)
    return rules


def format_message(rule: dict, twin_id: str, value: float) -> str:
    try:
        return rule["message"].format(value=value, threshold=rule["threshold"], twinId=twin_id, name=rule["name"])
    except (KeyError, IndexError, ValueError):
        return rule["message"]


class AlertEngine:
    def __init__(self, store: AlertStore, rules: list[dict], on_event, scan_interval: float = 1.0):
        self.store = store
        self.rules = rules
        self.on_event = on_event
        self.scan_interval = scan_interval
        self._pending: dict[tuple[str, str], float] = {}
        self._active: dict[tuple[str, str], int] = {}
        self._last_seen: dict[str, float] = {}
        self._lock = asyncio.Lock()
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        # 活动告警来自持久化库，重启后继续沿用原记录，不产生重复告警。
        valid_ids = {rule["id"] for rule in self.rules}
        for alert in self.store.active():
            if alert["ruleId"] not in valid_ids:
                self.store.resolve(alert["id"])
                continue
            self._active[(alert["ruleId"], alert["twinId"])] = alert["id"]
            self._last_seen.setdefault(alert["twinId"], time.monotonic())
        self._task = asyncio.create_task(self._scan_loop())
        log.info("告警引擎已启动：%d 条规则", len(self.rules))

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def _scan_loop(self) -> None:
        while True:
            await asyncio.sleep(self.scan_interval)
            try:
                await self.evaluate_offline()
            except Exception:
                log.exception("离线告警扫描失败")

    async def evaluate_message(self, event: dict) -> None:
        twin_id = event.get("twinId")
        if not twin_id or event.get("type") == "ack":
            return
        payload = event.get("payload") or {}
        now = time.monotonic()
        async with self._lock:
            self._last_seen[twin_id] = now
            for rule in self.rules:
                if rule["twinId"] not in ("*", twin_id):
                    continue
                key = (rule["id"], twin_id)
                if rule["field"] == "@offline":
                    await self._resolve(key)
                    continue
                value = payload.get(rule["field"])
                if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                    continue
                if OPS[rule["op"]](value, rule["threshold"]):
                    first = self._pending.setdefault(key, now)
                    if now - first >= rule["for"]:
                        await self._fire(rule, twin_id, value)
                else:
                    self._pending.pop(key, None)
                    await self._resolve(key)

    async def evaluate_offline(self) -> None:
        now = time.monotonic()
        async with self._lock:
            for rule in self.rules:
                if rule["field"] != "@offline":
                    continue
                for twin_id, last in self._last_seen.items():
                    if rule["twinId"] in ("*", twin_id):
                        gap = now - last
                        if gap > rule["threshold"]:
                            await self._fire(rule, twin_id, round(gap, 1))

    async def _fire(self, rule: dict, twin_id: str, value: float) -> None:
        key = (rule["id"], twin_id)
        if key in self._active:
            return
        alert = self.store.raise_alert(rule, twin_id, value, format_message(rule, twin_id, value))
        self._active[key] = alert["id"]
        await self.on_event("fired", alert)

    async def _resolve(self, key: tuple[str, str]) -> None:
        alert_id = self._active.get(key)
        if alert_id is None:
            return
        alert = self.store.resolve(alert_id)
        if alert:
            self._active.pop(key, None)
            await self.on_event("resolved", alert)

    def state(self) -> dict:
        return {"rules": len(self.rules), "active": len(self._active),
                "pending": len(self._pending), "trackedTwins": len(self._last_seen)}
