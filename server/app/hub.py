from __future__ import annotations

import asyncio
import json
import logging
import time

from fastapi import WebSocket

from .storage import TimeSeriesStore

log = logging.getLogger(__name__)


class TwinHub:
    def __init__(self, store: TimeSeriesStore):
        self.store = store
        self._clients: set[WebSocket] = set()
        self._send_locks: dict[WebSocket, asyncio.Lock] = {}
        self._lock = asyncio.Lock()
        self.published_count = 0
        self.last_published_ts = 0
        self._latest: dict[str, dict] = {}
        self.alert_engine = None

    async def connect(self, ws: WebSocket):
        await ws.accept()
        send_lock = asyncio.Lock()
        await send_lock.acquire()
        async with self._lock:
            self._clients.add(ws)
            self._send_locks[ws] = send_lock
            snapshot = list(self._latest.values())
        try:
            await ws.send_json({"type": "snapshot", "ts": int(time.time() * 1000), "data": snapshot})
        finally:
            send_lock.release()

    async def disconnect(self, ws: WebSocket):
        async with self._lock:
            self._clients.discard(ws)
            self._send_locks.pop(ws, None)

    async def send_client(self, ws: WebSocket, event: dict):
        send_lock = self._send_locks.get(ws)
        if send_lock:
            async with send_lock:
                await ws.send_json(event)

    async def publish(self, event: dict):
        self.store.append(event["twinId"], event["type"], event["ts"], event["payload"])
        self.published_count += 1
        self.last_published_ts = event["ts"]
        async with self._lock:
            self._latest[event["twinId"]] = event
        if self.alert_engine:
            try:
                await self.alert_engine.evaluate_message(event)
            except Exception:
                log.exception("告警评估失败；设备消息继续广播")
        await self._broadcast(event)

    async def broadcast_alert(self, action: str, alert: dict):
        """告警使用没有 twinId 的独立信封。"""
        await self._broadcast({"type": "alert", "action": action, "ts": int(time.time() * 1000), "alert": alert})

    async def _broadcast(self, event: dict):
        wire = json.dumps(event, ensure_ascii=False)
        async with self._lock:
            clients = [(client, self._send_locks[client]) for client in self._clients]
        for client, send_lock in clients:
            try:
                async with send_lock:
                    await client.send_text(wire)
            except Exception:
                await self.disconnect(client)

    def snapshot(self) -> list[dict]:
        return list(self._latest.values())
