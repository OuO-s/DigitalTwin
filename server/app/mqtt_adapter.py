"""MQTT 平台适配器：只收上行，归一化后交给 TwinHub。"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Awaitable, Callable
from threading import Lock

import paho.mqtt.client as mqtt

from server import topics

from .adapters import ProtocolAdapter
from .mqtt_contract import normalize_mqtt
from .mqtt_settings import MqttSettings

log = logging.getLogger(__name__)


class MqttAdapter(ProtocolAdapter):
    def __init__(self, settings: MqttSettings):
        self.settings = settings
        self._client: mqtt.Client | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._publish: Callable[[dict], Awaitable[None]] | None = None
        self._connected = False
        self._lock = Lock()
        self._stats = {"received": 0, "dropped": 0, "sent": 0, "hubErrors": 0}

    @property
    def is_connected(self) -> bool:
        return self._connected

    @property
    def stats(self) -> dict:
        with self._lock:
            counts = dict(self._stats)
        return {"connected": self._connected, "broker": f"{self.settings.host}:{self.settings.port}", **counts}

    async def connect(self, publish):
        self._loop = asyncio.get_running_loop()
        self._publish = publish
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=self.settings.client_id)
        if self.settings.username:
            client.username_pw_set(self.settings.username, self.settings.password)
        if self.settings.tls:
            client.tls_set(ca_certs=self.settings.ca_cert)
        client.reconnect_delay_set(min_delay=1, max_delay=30)
        client.on_connect = self._on_connect
        client.on_connect_fail = self._on_connect_fail
        client.on_disconnect = self._on_disconnect
        client.on_message = self._on_message
        self._client = client
        try:
            # 首次连接也由网络线程处理；Broker 不在时 REST/WebSocket 仍能启动。
            client.connect_async(self.settings.host, self.settings.port, keepalive=30)
            client.loop_start()
        except Exception as exc:
            log.warning("MQTT 连接线程未能启动（%s:%s）：%s", self.settings.host, self.settings.port, exc)
            self._client = None
            return False
        return True

    def subscribe(self, device_list=None):
        if not self._client or not self._connected:
            return []
        wanted = ([topics.upstream_topic(device_id, type_) for device_id in device_list for type_ in topics.UPSTREAM_TYPES]
                  if device_list else topics.upstream_topics())
        for topic in wanted:
            result, _ = self._client.subscribe(topic, qos=1)
            if result != mqtt.MQTT_ERR_SUCCESS:
                log.warning("订阅失败：%s（错误码 %s）", topic, result)
        return wanted

    def normalize(self, raw):
        if not topics.is_upstream(raw.get("topic", "")):
            return None
        try:
            payload = json.loads(raw["payload"].decode("utf-8"))
            return normalize_mqtt(raw["topic"], payload)
        except (KeyError, UnicodeDecodeError, ValueError, TypeError, OverflowError):
            return None

    async def send_command(self, device_id, command):
        if not self._connected or not self._client:
            return {"ok": False, "err": "MQTT 未连接，指令未发出"}
        try:
            topic = topics.command_topic(device_id)
        except ValueError as exc:
            return {"ok": False, "err": str(exc)}
        if not isinstance(command, dict) or not isinstance(command.get("cmd"), str) or not isinstance(command.get("id"), str):
            return {"ok": False, "err": "指令须包含字符串 cmd 和 id"}
        # 不再包装 command：设备端应直接读到字符串 cmd。
        body = {**command, "ts": int(time.time() * 1000)}
        info = self._client.publish(topic, json.dumps(body, ensure_ascii=False), qos=1)
        if info.rc != mqtt.MQTT_ERR_SUCCESS:
            return {"ok": False, "err": f"MQTT 发布失败：{info.rc}"}
        try:
            await asyncio.to_thread(info.wait_for_publish, timeout=3)
        except (RuntimeError, ValueError) as exc:
            return {"ok": False, "err": f"MQTT 发布未确认：{exc}"}
        if not info.is_published():
            return {"ok": False, "err": "MQTT 发布超时"}
        with self._lock:
            self._stats["sent"] += 1
        return {"ok": True, "topic": topic, "id": command["id"]}

    def _on_connect(self, client, userdata, flags, reason_code, properties):
        if reason_code == 0:
            self._connected = True
            wanted = self.subscribe()
            log.info("MQTT 已连接并订阅：%s", ", ".join(wanted))
        else:
            self._connected = False
            log.warning("MQTT 连接被拒：%s", reason_code)

    def _on_connect_fail(self, client, userdata):
        self._connected = False
        log.warning("MQTT Broker 不可达：%s:%s；平台继续运行", self.settings.host, self.settings.port)

    def _on_disconnect(self, client, userdata, flags, reason_code, properties):
        self._connected = False
        if reason_code != 0:
            log.warning("MQTT 已断开（%s），等待自动重连", reason_code)

    def _on_message(self, client, userdata, message):
        event = self.normalize({"topic": message.topic, "payload": message.payload})
        if event is None or self._loop is None or self._publish is None:
            with self._lock:
                self._stats["dropped"] += 1
            return
        try:
            future = asyncio.run_coroutine_threadsafe(self._publish(event), self._loop)
        except RuntimeError:
            with self._lock:
                self._stats["dropped"] += 1
            return
        with self._lock:
            self._stats["received"] += 1
        future.add_done_callback(self._on_ingest_done)

    def _on_ingest_done(self, future):
        try:
            error = future.exception()
        except asyncio.CancelledError:
            return
        if error is not None:
            with self._lock:
                self._stats["hubErrors"] += 1
            log.error("MQTT 消息进入 Hub 失败", exc_info=(type(error), error, error.__traceback__))

    async def stop(self):
        self._connected = False
        if self._client:
            await asyncio.to_thread(self._client.disconnect)
            await asyncio.to_thread(self._client.loop_stop)
            self._client = None
