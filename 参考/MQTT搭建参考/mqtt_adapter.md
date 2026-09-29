```python
"""MQTT 适配器：连接 Broker、订阅设备上行主题、把报文翻译为统一孪生消息。

这是「协议适配器」接口的 MQTT 实现。设备侧（仿真网关或真实设备）发布到
`twin/{id}/{type}`，本适配器翻译后交给 Hub —— 与 HTTP 适配器走的是同一条下游通路。

**消息封装约定**：信封里已经有的信息不重复放在负载里——
`twinId` 与 `type` 来自主题，`ts` 由设备在负载里给（缺省用服务端时间）。
负载本身即 `data`，于是设备端不必自己拼一个完整的孪生消息。

    topic:   twin/robot-001/pose
    payload: {"ts": 1755748800123, "x": 12.34, "y": 5.67, "yaw": 1.57, ...}
    ↓ 归一化
    {"twinId": "robot-001", "ts": 1755748800123, "type": "pose",
     "data": {"x": 12.34, "y": 5.67, ...}}
"""

import json
import logging
import threading
import time

import paho.mqtt.client as mqtt

import topics
from adapters.base import ProtocolAdapter

log = logging.getLogger(__name__)


class MqttAdapter(ProtocolAdapter):
    def __init__(self, hub, host="127.0.0.1", port=1883, client_id="twin-platform"):
        self.hub = hub
        self.host = host
        self.port = port
        self.client_id = client_id
        self._client = None
        self._connected = threading.Event()
        self._subscriptions = []
        self.stats = {"received": 0, "dropped": 0, "sent": 0}

    # ---- ProtocolAdapter 接口 ----
    def connect(self, config=None):
        cfg = config or {}
        self.host = cfg.get("host", self.host)
        self.port = int(cfg.get("port", self.port))

        self._client = mqtt.Client(
            mqtt.CallbackAPIVersion.VERSION2, client_id=self.client_id)
        # 鉴权（方案 7.3）：客户现场多为「账号密码」，需要证书时再开 tls
        if cfg.get("username"):
            self._client.username_pw_set(cfg["username"], cfg.get("password"))
        if cfg.get("tls"):
            self._client.tls_set()

        self._client.on_connect = self._on_connect
        self._client.on_message = self._on_message
        self._client.on_disconnect = self._on_disconnect
        # 断线自动重连：现场网络抖动很常见，不该让平台侧跟着断
        self._client.reconnect_delay_set(min_delay=1, max_delay=30)

        try:
            self._client.connect(self.host, self.port, keepalive=30)
            self._client.loop_start()
        except Exception as exc:  # noqa: BLE001
            # Broker 不可用不应让整个服务起不来：其余链路照常工作
            log.warning("MQTT 连接失败（%s:%s）：%s —— 实时设备链路不可用，其余功能不受影响",
                        self.host, self.port, exc)
            return False

        self._connected.wait(timeout=5)
        return self._connected.is_set()

    def subscribe(self, device_list=None):
        if not self._client:
            return
        # 显式逐类订阅上行主题（不含 command），自己发出的指令不会回环回来
        wanted = ([topics.upstream_topic(d, t)
                   for d in device_list for t in topics.UPSTREAM_TYPES]
                  if device_list else topics.upstream_topics())
        for topic in wanted:
            self._client.subscribe(topic, qos=1)
            self._subscriptions.append(topic)
        log.info("MQTT 已订阅：%s", "、".join(wanted))

    def normalize(self, raw):
        """原始报文 → 统一孪生消息；无法解析时返回 None（丢弃而非抛错）。"""
        parsed = topics.parse_topic(raw.get("topic", ""))
        if not parsed:
            return None
        twin_id, type_ = parsed

        try:
            payload = json.loads(raw["payload"].decode("utf-8"))
        except (UnicodeDecodeError, ValueError, KeyError, AttributeError):
            return None
        if not isinstance(payload, dict):
            return None

        ts = payload.pop("ts", None)
        return {
            "twinId": twin_id,
            "ts": int(ts) if isinstance(ts, (int, float)) else int(time.time() * 1000),
            "type": type_,
            "data": payload,
        }

    def send_command(self, device_id, cmd):
        """指令下发：发布到 twin/{id}/command，由设备侧执行并回 ack。

        `cmd` 本身就是指令体（如 `{"cmd": "pause", "id": "..."}`），**直接作为负载发布**，
        不要再包一层——多包一层的话设备侧读到的 `cmd` 会是个字典而不是命令名。
        （这个 bug 在接仿真网关跑通真实协议路径时才暴露出来。）
        """
        if not self.is_connected:
            return {"ok": False, "err": "MQTT 未连接，指令未发出"}

        payload = json.dumps(
            {**cmd, "ts": int(time.time() * 1000)}, ensure_ascii=False)
        topic = topics.command_topic(device_id)
        info = self._client.publish(topic, payload, qos=1)
        try:
            info.wait_for_publish(timeout=3)
        except (ValueError, RuntimeError):
            pass
        if info.is_published():
            self.stats["sent"] += 1
        return {"ok": info.is_published(), "topic": topic, "cmd": cmd}

    # ---- 内部 ----
    @property
    def is_connected(self):
        return self._connected.is_set()

    def handles(self, twin_id):
        """本适配器是否负责该设备。

        MQTT 是通用设备总线，主题本身带设备标识，因此只要连上就都能发。
        日后接入多适配器（如 Kafka 只收某类设备）时，应在此做显式归属判断。
        """
        return self.is_connected

    def _on_connect(self, client, userdata, flags, reason_code, properties=None):
        if reason_code == 0 or str(reason_code) == "Success":
            self._connected.set()
            log.info("MQTT 已连接 %s:%s", self.host, self.port)
            self.subscribe()
        else:
            log.warning("MQTT 连接被拒：%s", reason_code)

    def _on_disconnect(self, client, userdata, flags, reason_code, properties=None):
        self._connected.clear()
        log.warning("MQTT 断开（%s），paho 将自动重连", reason_code)

    def _on_message(self, client, userdata, msg):
        msg_in = self.normalize({"topic": msg.topic, "payload": msg.payload})
        if not msg_in:
            self.stats["dropped"] += 1
            return
        self.stats["received"] += 1
        self.hub.ingest(msg_in)

    def stop(self):
        if self._client:
            self._client.loop_stop()
            self._client.disconnect()
            self._connected.clear()

```

