from __future__ import annotations

import asyncio
import json

from fastapi import WebSocket

from .storage import TimeSeriesStore


class TwinHub:
    def __init__(self, store: TimeSeriesStore):
        self.store = store
        self._clients: set[WebSocket] = set()
        self._lock = asyncio.Lock()
        self.published_count = 0
        self.last_published_ts = 0

    async def connect(self, ws: WebSocket):
        await ws.accept()
        async with self._lock:
            self._clients.add(ws)

    async def disconnect(self, ws: WebSocket):
        async with self._lock:
            self._clients.discard(ws)

    async def publish(self, event: dict):
        self.store.append(event["twinId"], event["type"], event["ts"], event["payload"])
        self.published_count += 1
        self.last_published_ts = event["ts"]
        wire = json.dumps(event, ensure_ascii=False)
        async with self._lock:
            clients = list(self._clients)
        for client in clients:
            try:
                await client.send_text(wire)
            except Exception:
                await self.disconnect(client)
