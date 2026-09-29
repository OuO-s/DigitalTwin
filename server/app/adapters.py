from __future__ import annotations

import asyncio
import math
import random
import time
from abc import ABC, abstractmethod


class ProtocolAdapter(ABC):
    @abstractmethod
    async def connect(self, publish): ...

    @abstractmethod
    def subscribe(self, device_list=None): ...

    @abstractmethod
    def normalize(self, raw): ...

    @abstractmethod
    async def send_command(self, device_id, command): ...

    @abstractmethod
    async def stop(self): ...


class DemoAdapter(ProtocolAdapter):
    """用同一 TwinEvent 形状推送可替换的演示遥测。"""

    def __init__(self):
        self._task: asyncio.Task | None = None
        self._running = False
        self._temperature = 23.4
        self._started = time.monotonic()

    async def connect(self, publish):
        if self._task and not self._task.done():
            return
        self._running = True

        async def loop():
            while self._running:
                self._temperature = max(22.6, min(24.4, self._temperature + random.uniform(-0.18, 0.18)))
                await publish({
                    "twinId": "eq-hvac-01",
                    "type": "status",
                    "ts": int(time.time() * 1000),
                    "payload": {"state": "online", "temperature": round(self._temperature, 1), "source": "demo"},
                })
                await publish({
                    "twinId": "eq-sensor-01",
                    "type": "status",
                    "ts": int(time.time() * 1000),
                    "payload": {"state": "online", "humidity": round(69 + 2 * math.sin((time.monotonic() - self._started) / 8), 1), "source": "demo"},
                })
                await asyncio.sleep(4)

        self._task = asyncio.create_task(loop())

    def subscribe(self, device_list=None):
        return []

    def normalize(self, raw):
        return raw

    async def send_command(self, device_id, command):
        return {"ok": False, "err": "演示适配器不下发指令"}

    async def stop(self):
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
