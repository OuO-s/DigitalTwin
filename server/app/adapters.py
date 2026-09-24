from __future__ import annotations

import asyncio
import random
import time
from abc import ABC, abstractmethod


class ProtocolAdapter(ABC):
    @abstractmethod
    async def start(self, publish): ...

    @abstractmethod
    async def stop(self): ...


class DemoAdapter(ProtocolAdapter):
    """用同一 TwinEvent 形状推送可替换的演示遥测。"""

    def __init__(self):
        self._task: asyncio.Task | None = None
        self._running = False
        self._temperature = 23.4

    async def start(self, publish):
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
                    "payload": {"status": "online", "temperature": round(self._temperature, 1), "source": "demo"},
                })
                await asyncio.sleep(4)

        self._task = asyncio.create_task(loop())

    async def stop(self):
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass


class MqttAdapter(ProtocolAdapter):
    """生产适配器接口占位；broker 地址和凭据由部署环境配置。"""

    def __init__(self, broker_url: str | None = None):
        self.broker_url = broker_url

    async def start(self, publish):
        # 订阅 twin/+/pose|joint|status|ack，并从主题解析 twinId/type。
        # 运行环境安装 paho-mqtt 后在此接入外部 EMQX/Mosquitto。
        return None

    async def stop(self):
        return None

