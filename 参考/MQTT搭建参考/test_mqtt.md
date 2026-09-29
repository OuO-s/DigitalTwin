```python
"""MQTT 实时链路与指令闭环的校验。

    python tools/test_mqtt.py

这个脚本验证的是**协议路径真的走通了**，而不只是「界面上有数据」：

  ① 仿真网关的数据确实经 MQTT 到达平台（对比网关发布数与适配器接收数）
  ② **外部设备**能按主题约定把数据喂进平台 —— 这正是接真设备时的场景
  ③ 指令经 MQTT 下发、设备执行、回执经 MQTT 回来（完整闭环）
  ④ 设备不支持的指令会被拒绝并说明原因
  ⑤ 权限：viewer 不能下发指令

前置：后端运行中（会自带内嵌 Broker 与仿真网关）。
"""

import asyncio
import json
import os
import sys
import urllib.error
import urllib.request

import websockets

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))
import topics  # noqa: E402
import paho.mqtt.client as mqtt  # noqa: E402

BASE = os.environ.get("CHECK_URL", "http://127.0.0.1:8000")
WS = "ws://127.0.0.1:8765"
BROKER = ("127.0.0.1", int(os.environ.get("TWIN_MQTT_PORT", "1883")))
ADMIN = ("admin", os.environ.get("TWIN_ADMIN_PASSWORD", "allrank8888"))

errors = 0


def check(cond, msg):
    global errors
    if cond:
        print(f"  [OK] {msg}")
    else:
        print(f"  [!!] {msg}")
        errors += 1


def req(method, path, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method)
    if body is not None:
        r.add_header("Content-Type", "application/json")
    if token:
        r.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(r, timeout=20) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except ValueError:
            return e.code, {}
    except Exception as exc:  # noqa: BLE001
        return 0, {"err": str(exc)}


st, body = req("POST", "/api/v1/auth/login",
               {"username": ADMIN[0], "password": ADMIN[1]})
if not body.get("ok"):
    print(f"  登录失败（HTTP {st}）：{body.get('err')}")
    sys.exit(1)
admin_token = body["token"]

# ---- ① 链路状态 ----
print("=== (1) MQTT 链路状态 ===")
st, h = req("GET", "/api/v1/health")
mqtt_info = h.get("mqtt") or {}
check(mqtt_info.get("connected"), f"适配器已连上 Broker {mqtt_info.get('broker')}")
check(mqtt_info.get("embeddedBroker"), "使用内嵌 Broker（演示环境开箱即用）")

gw = h.get("gateway") or {}
print(f"    网关发布 {gw.get('published', 0)} 条 ｜ 适配器接收 {mqtt_info.get('received', 0)} 条"
      f" ｜ 丢弃 {mqtt_info.get('dropped', 0)} 条")

# 关键断言：网关发布数 ≈ 适配器接收数。
# 若仿真网关绕过 MQTT 直接写 Hub，这里 published 会很小而 twins 照旧有数据。
check(gw.get("published", 0) > 100, f"仿真网关确实在发布（{gw.get('published')} 条）")
delta = abs(gw.get("published", 0) - mqtt_info.get("received", 0))
check(delta < 100, f"发布数与接收数一致（差 {delta} 条，仅在建消息在途）")
check(mqtt_info.get("dropped", 0) == 1 or mqtt_info.get("dropped", 0) < 5,
      f"丢弃 {mqtt_info.get('dropped', 0)} 条（主题约定与解析匹配）")


async def external_device_test():
    """② 模拟一台**外部设备**：按主题约定直接往 Broker 发数据。"""
    print("\n=== (2) 外部设备经 MQTT 接入（接真设备的真实场景）===")
    ext_id = "ext-sensor-01"

    pub = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="ext-device")
    pub.connect(*BROKER, 10)
    pub.loop_start()
    await asyncio.sleep(0.8)

    payload = {"ts": 1789000000000, "state": "running", "temp": 26.5, "ext": True}
    pub.publish(topics.upstream_topic(ext_id, "status"),
                json.dumps(payload), qos=1)
    await asyncio.sleep(1.5)

    async with websockets.connect(f"{WS}?token={admin_token}") as ws:
        # 该设备只发了一条，且发生在连上 WS **之前**，所以要查**快照**而不是实时流。
        # （最早写成在实时流里等，必然等不到——那是测试的问题，不是链路的问题。）
        snap = json.loads(await ws.recv())
        found = next((t for t in snap.get("data", []) if t.get("twinId") == ext_id), None)

    check(found is not None, f"外部设备 {ext_id} 的数据经 MQTT 进入了平台（快照可见）")
    if found:
        check(found["type"] == "status", f"类型由主题解析得到：{found['type']}")
        check(found["data"].get("ext") is True and found["data"].get("temp") == 26.5,
              f"负载原样保留：{found['data']}")
        check(found["ts"] == 1789000000000, "设备时间戳被采用（而非服务端时间）")

    pub.loop_stop()
    pub.disconnect()


asyncio.run(external_device_test())


async def command_loop_test():
    """③④⑤ 指令闭环与权限。"""
    print("\n=== (3) 指令闭环（HTTP → MQTT → 设备 → 回执 → MQTT → WebSocket）===")

    async with websockets.connect(f"{WS}?token={admin_token}") as ws:
        await ws.recv()

        async def send_and_wait(cmd, token):
            st, r = req("POST", "/api/v1/command",
                        {"twinId": "robot-001", "cmd": cmd}, token=token)
            if st != 200:
                return st, r, None
            try:
                for _ in range(300):
                    m = json.loads(await asyncio.wait_for(ws.recv(), timeout=6))
                    if m.get("type") == "ack" and (m.get("data") or {}).get("cmd") == cmd:
                        return st, r, m
            except asyncio.TimeoutError:
                pass
            return st, r, None

        st, r, ack = await send_and_wait("pause", admin_token)
        check(st == 200, f"下发 pause → HTTP {st}（经 {r.get('via')}）")
        check(ack is not None, "收到设备回执")
        if ack:
            check(ack["data"].get("ok") is True, f"设备执行成功，ref={ack['data'].get('ref')}")

        st, r, ack = await send_and_wait("resume", admin_token)
        check(ack is not None and ack["data"].get("ok") is True, "下发 resume 并收到成功回执")

        print("\n=== (4) 设备不支持的指令应被拒绝并说明原因 ===")
        st, r, ack = await send_and_wait("fly", admin_token)
        check(ack is not None, "收到回执")
        if ack:
            d = ack["data"]
            check(d.get("ok") is False, "回执标记为失败")
            check("fly" in str(d.get("err", "")), f"说明了原因：{d.get('err')}")

        print("\n=== (5) 权限：viewer 不能下发指令 ===")
        req("POST", "/api/v1/auth/users",
            {"username": "v-for-cmd", "password": "allrank8888", "role": "viewer"},
            token=admin_token)
        st, b = req("POST", "/api/v1/auth/login",
                    {"username": "v-for-cmd", "password": "allrank8888"})
        viewer_token = b.get("token") if b.get("ok") else None
        if viewer_token:
            st, r = req("POST", "/api/v1/command",
                        {"twinId": "robot-001", "cmd": "pause"}, token=viewer_token)
            check(st == 403, f"viewer 下发指令被拒（HTTP {st}）")
        else:
            check(False, "未能创建/登录 viewer 账号")
        req("DELETE", "/api/v1/auth/users/v-for-cmd", token=admin_token)


asyncio.run(command_loop_test())

print("\n" + ("[PASS] MQTT 链路与指令闭环校验通过" if errors == 0 else f"[FAIL] {errors} 项失败"))
sys.exit(1 if errors else 0)

```

