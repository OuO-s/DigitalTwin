"""HTTP 上行适配器：REST 设备消息归一化后走同一个 TwinHub。"""

from __future__ import annotations

import time

from pydantic import ValidationError

from .adapters import ProtocolAdapter
from .models import TwinEvent


class HttpAdapter(ProtocolAdapter):
    def __init__(self):
        self._publish = None
        self._devices: set[str] = set()
        self.received = 0
        self.rejected = 0
        self.last_received_ts = 0

    async def connect(self, publish):
        # REST 没有长连接，保留与其他协议适配器相同的装配接口。
        self._publish = publish

    def subscribe(self, device_list=None):
        return []

    def normalize(self, raw):
        if not isinstance(raw, dict):
            raise ValueError("消息必须是 JSON 对象")
        if "twinId" not in raw:
            raise ValueError("缺少字段 twinId")
        if "type" not in raw:
            raise ValueError("缺少字段 type")
        if "payload" in raw and "data" in raw:
            raise ValueError("payload 与 data 只能提供一个")
        if "payload" not in raw and "data" not in raw:
            raise ValueError("缺少字段 payload 或 data")
        event = dict(raw)
        if "data" in event:
            event["payload"] = event.pop("data")
        event.setdefault("ts", int(time.time() * 1000))
        try:
            return TwinEvent.model_validate(event).model_dump()
        except ValidationError as exc:
            detail = "; ".join(error["msg"] for error in exc.errors())
            raise ValueError(detail) from exc

    async def ingest(self, raw):
        """返回错误字符串；成功时发布给 Hub，并返回 None。"""
        try:
            event = self.normalize(raw)
        except ValueError as exc:
            self.rejected += 1
            return str(exc)
        if self._publish is None:
            return "HTTP 适配器尚未启动"
        await self._publish(event)
        self._devices.add(event["twinId"])
        self.received += 1
        self.last_received_ts = event["ts"]
        return None

    def owns(self, device_id):
        return device_id in self._devices

    async def send_command(self, device_id, command):
        # 参考实现的下行仅为占位；不把未送达设备的命令报告为成功。
        return {"ok": False, "err": "HTTP 设备下行尚未实现"}

    @property
    def stats(self):
        return {"received": self.received, "rejected": self.rejected,
                "deviceCount": len(self._devices), "lastReceivedTs": self.last_received_ts}

    async def stop(self):
        self._publish = None
