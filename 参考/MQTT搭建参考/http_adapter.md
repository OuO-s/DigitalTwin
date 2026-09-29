```py
"""HTTP 适配器：设备经 REST 上行，指令经 REST 下行。

M1 阶段已可用：POST /api/v1/ingest 即可注入一条真实/测试消息，
与 MQTT 适配器产生的消息走完全相同的 Hub 路径。
"""

import time

from adapters.base import ProtocolAdapter


class HttpAdapter(ProtocolAdapter):
    def __init__(self, hub):
        self.hub = hub

    def connect(self, config=None):
        pass  # REST 无长连接，占位

    def subscribe(self, device_list=None):
        pass

    def normalize(self, raw):
        return raw

    def send_command(self, device_id, cmd):
        # TODO(M1): 缓存待下发指令供设备轮询；当前仅占位
        return {"ok": True, "deviceId": device_id, "cmd": cmd}

    def ingest(self, msg):
        """校验并入库一条上行消息，返回错误信息（无错误返回 None）。"""
        if not isinstance(msg, dict):
            return "消息必须是 JSON 对象"
        if "twinId" not in msg:
            return "缺少字段 twinId"
        if "type" not in msg:
            return "缺少字段 type"
        msg.setdefault("ts", int(time.time() * 1000))
        self.hub.ingest(msg)
        return None

```

