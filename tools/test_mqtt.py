"""外部 MQTT 设备、平台适配器、指令与回执的端到端核对。

运行前：启动外部 Broker 和 FastAPI，并设置 TWIN_MQTT_ENABLED=1、
TWIN_SIM_GATEWAY=1、TWIN_COMMAND_TOKEN。
脚本本身作为另一台设备接入 Broker。
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid

import paho.mqtt.client as mqtt
import websockets

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from server import topics  # noqa: E402

BASE = os.getenv("CHECK_URL", "http://127.0.0.1:8000").rstrip("/")
WS = BASE.replace("http://", "ws://").replace("https://", "wss://") + "/ws/twin"
HOST = os.getenv("TWIN_MQTT_HOST", "127.0.0.1")
PORT = int(os.getenv("TWIN_MQTT_PORT", "1883"))
TOKEN = os.getenv("TWIN_COMMAND_TOKEN", "")


def request(method, path, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=8) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as exc:
        return exc.code, json.load(exc)


def check(condition, message):
    if not condition:
        raise AssertionError(message)
    print(f"[OK] {message}")


def external_client():
    connected = threading.Event()
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"external-check-{uuid.uuid4().hex[:8]}")
    username = os.getenv("TWIN_SIM_MQTT_USERNAME") or os.getenv("TWIN_MQTT_USERNAME")
    password = os.getenv("TWIN_SIM_MQTT_PASSWORD") or os.getenv("TWIN_MQTT_PASSWORD")
    if username:
        client.username_pw_set(username, password)
    if os.getenv("TWIN_MQTT_TLS", "0") == "1":
        client.tls_set(ca_certs=os.getenv("TWIN_MQTT_CA_CERT") or None)

    def on_connect(client, userdata, flags, reason_code, properties):
        if reason_code == 0:
            connected.set()

    client.on_connect = on_connect
    client.connect(HOST, PORT, keepalive=10)
    client.loop_start()
    check(connected.wait(5), "外部设备已连接 Broker")
    return client


async def wait_ack(socket, ref):
    async def read():
        while True:
            event = json.loads(await socket.recv())
            if event.get("type") == "ack" and event.get("payload", {}).get("ref") == ref:
                return event
    return await asyncio.wait_for(read(), timeout=8)


async def main():
    check(bool(TOKEN), "已配置 TWIN_COMMAND_TOKEN")
    _, health = request("GET", "/api/v1/health")
    check(health["mqtt"]["connected"], "平台 MQTT 适配器已连接")
    check(health["gateway"] and health["gateway"]["connected"], "仿真网关已通过 MQTT 连接")
    before = (health["gateway"]["published"], health["mqtt"]["received"])
    await asyncio.sleep(2.5)
    _, health = request("GET", "/api/v1/health")
    after = (health["gateway"]["published"], health["mqtt"]["received"])
    published, received = after[0] - before[0], after[1] - before[1]
    print(f"网关发布增量 {published}；适配器接收增量 {received}")
    check(published > 0 and abs(published - received) <= 3, "网关发布数与适配器接收数可对账")

    client = external_client()
    try:
        external_id = f"ext-sensor-{uuid.uuid4().hex[:8]}"
        ts = int(time.time() * 1000)
        payload = {"ts": ts, "state": "online", "temperature": 26.5, "ext": True}
        info = client.publish(topics.upstream_topic(external_id, "status"), json.dumps(payload), qos=1)
        info.wait_for_publish(timeout=5)
        check(info.is_published(), "外部设备已发布一条上行消息")
        found = None
        for _ in range(30):
            _, twins = request("GET", "/api/v1/twins")
            found = next((event for event in twins["twins"] if event["twinId"] == external_id), None)
            if found:
                break
            await asyncio.sleep(0.1)
        check(found is not None, "外部设备数据进入 Hub")
        check(found["type"] == "status" and found["payload"]["ext"] and found["ts"] == ts,
              "身份和类型由主题解析，负载与时间戳保留")

        async with websockets.connect(WS) as socket:
            snapshot = json.loads(await asyncio.wait_for(socket.recv(), timeout=5))
            check(snapshot["type"] == "snapshot" and any(item["twinId"] == external_id for item in snapshot["data"]),
                  "新 WebSocket 连接可收到外部设备快照")
            status, _ = request("POST", "/api/v1/command", {"twinId": "eq-printer-6", "cmd": "pause"})
            check(status == 403, "未授权请求不能下发指令")
            for cmd, expected in (("pause", True), ("resume", True), ("fly", False)):
                status, result = request("POST", "/api/v1/command", {"twinId": "eq-printer-6", "cmd": cmd}, TOKEN)
                check(status == 202 and result["ok"], f"{cmd} 指令已直接发布到 MQTT")
                ack = await wait_ack(socket, result["id"])
                check(ack["payload"]["ok"] is expected, f"{cmd} 收到对应 id 的设备 ack")
                if not expected:
                    check("fly" in ack["payload"]["err"], "不支持的指令带失败原因")
        _, health = request("GET", "/api/v1/health")
        check(health["gateway"]["commands"] >= 3 and health["mqtt"]["sent"] >= 3,
              "网关指令计数和适配器下发计数已增长")
        print("[PASS] MQTT 上行、快照、指令与 ack 链路通过")
    finally:
        client.disconnect()
        client.loop_stop()


if __name__ == "__main__":
    asyncio.run(main())
