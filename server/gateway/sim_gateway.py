"""独立设备行为：只通过 MQTT 发遥测、收 command、回 ack。"""

from __future__ import annotations

import json
import logging
import math
import os
import threading
import time

import paho.mqtt.client as mqtt

from server import topics

log = logging.getLogger(__name__)

DEVICE_IDS = ("eq-printer-6", "eq-hvac-01", "eq-sensor-01", "eq-light-01", "eq-access-01")


class SimGateway:
    """只 import 共享主题约定，不 import Hub、存储或 MQTT 适配器。"""

    def __init__(self, host="127.0.0.1", port=1883, username=None, password=None,
                 tls=False, ca_cert=None, pose_rate=5.0):
        self.host = host
        self.port = port
        self.username = username
        self.password = password
        self.tls = tls
        self.ca_cert = ca_cert
        self.pose_rate = max(0.2, min(float(pose_rate), 20.0))
        self._client: mqtt.Client | None = None
        self._connected = threading.Event()
        self._stop = threading.Event()
        self._paused = threading.Event()
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self._stats = {"published": 0, "commands": 0, "acks": 0, "failed": 0}
        self._started = time.monotonic()

    @property
    def stats(self) -> dict:
        with self._lock:
            counts = dict(self._stats)
        return {"connected": self._connected.is_set(), **counts}

    def start(self) -> bool:
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"zhicui-sim-{os.getpid()}")
        if self.username:
            client.username_pw_set(self.username, self.password)
        if self.tls:
            client.tls_set(ca_certs=self.ca_cert)
        client.reconnect_delay_set(min_delay=1, max_delay=30)
        client.on_connect = self._on_connect
        client.on_connect_fail = self._on_connect_fail
        client.on_disconnect = self._on_disconnect
        client.on_message = self._on_message
        client.on_publish = self._on_publish
        self._client = client
        try:
            client.connect_async(self.host, self.port, keepalive=30)
            client.loop_start()
        except Exception as exc:
            log.warning("仿真网关无法启动 MQTT：%s", exc)
            self._client = None
            return False
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="sim-mqtt-gateway", daemon=True)
        self._thread.start()
        return True

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=3)
            self._thread = None
        self._connected.clear()
        if self._client:
            self._client.disconnect()
            self._client.loop_stop()
            self._client = None

    def _on_connect(self, client, userdata, flags, reason_code, properties):
        if reason_code == 0:
            self._connected.set()
            for device_id in DEVICE_IDS:
                client.subscribe(topics.command_topic(device_id), qos=1)
            log.info("仿真网关已连接，只监听自身设备的 command")
        else:
            self._connected.clear()
            log.warning("仿真网关连接被拒：%s", reason_code)

    def _on_connect_fail(self, client, userdata):
        self._connected.clear()
        log.warning("仿真网关无法连接 Broker：%s:%s", self.host, self.port)

    def _on_disconnect(self, client, userdata, flags, reason_code, properties):
        self._connected.clear()
        if reason_code != 0:
            log.warning("仿真网关断开，等待自动重连：%s", reason_code)

    def _on_publish(self, client, userdata, mid, reason_code, properties):
        with self._lock:
            if reason_code == 0:
                self._stats["published"] += 1
            else:
                self._stats["failed"] += 1

    def _publish(self, twin_id: str, type_: str, data: dict):
        if not self._connected.is_set() or not self._client:
            return
        result = self._client.publish(topics.upstream_topic(twin_id, type_), json.dumps(data, ensure_ascii=False), qos=1)
        if result.rc != mqtt.MQTT_ERR_SUCCESS:
            with self._lock:
                self._stats["failed"] += 1

    def _run(self):
        interval = 1.0 / self.pose_rate
        next_status = 0.0
        while not self._stop.wait(interval):
            if not self._connected.is_set():
                continue
            elapsed = time.monotonic() - self._started
            now = int(time.time() * 1000)
            self._publish("sim-cart-01", "pose", {
                "ts": now, "x": round(3 + math.sin(elapsed * 0.4) * 2, 3),
                "y": round(4 + math.cos(elapsed * 0.4) * 2, 3), "z": 0,
                "yaw": round(elapsed * 0.4, 3), "roll": 0, "pitch": 0,
            })
            if elapsed >= next_status:
                self._emit_status(now, elapsed)
                next_status = elapsed + 1.0

    def _emit_status(self, now: int, elapsed: float):
        self._publish("eq-printer-6", "status", {"ts": now, "state": "paused" if self._paused.is_set() else "running", "count": 6})
        self._publish("eq-hvac-01", "status", {"ts": now, "state": "online", "temperature": round(23.4 + math.sin(elapsed / 12) * 0.8, 1)})
        self._publish("eq-sensor-01", "status", {"ts": now, "state": "warning", "humidity": round(69 + math.sin(elapsed / 8) * 2, 1)})
        self._publish("eq-light-01", "status", {"ts": now, "state": "online", "brightness": 76})
        self._publish("eq-access-01", "status", {"ts": now, "state": "online", "locked": True})

    def _on_message(self, client, userdata, message):
        parsed = topics.parse_topic(message.topic)
        if not parsed or parsed[1] != topics.DOWNSTREAM_TYPE or parsed[0] not in DEVICE_IDS:
            return
        try:
            body = json.loads(message.payload.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            body = None
        if not isinstance(body, dict):
            return
        cmd, ref = body.get("cmd"), body.get("id")
        with self._lock:
            self._stats["commands"] += 1
        if not isinstance(ref, str) or not ref:
            ref = "missing-id"
        if cmd == "ping":
            ok, err = True, None
        elif parsed[0] == "eq-printer-6" and cmd == "pause":
            self._paused.set()
            ok, err = True, None
        elif parsed[0] == "eq-printer-6" and cmd == "resume":
            self._paused.clear()
            ok, err = True, None
        else:
            ok, err = False, f"设备不支持指令「{cmd}」"
        self._publish(parsed[0], "ack", {"ts": int(time.time() * 1000), "ref": ref, "ok": ok, "err": err, "cmd": cmd})
        with self._lock:
            self._stats["acks"] += 1
