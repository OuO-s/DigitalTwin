```python
"""仿真网关：用与真实设备**完全相同**的 MQTT 协议模拟设备行为。

## 为什么它必须走 MQTT，而不能直接往 Hub 里塞数据

如果模拟器直接调 `hub.ingest()`，那么平台侧的 **MQTT 适配器、主题约定、报文解析**
就一次都没被验证过——而客户设备到位时坏掉的，恰恰可能是这一段。
这与方案对仿真网关的定义一致：

    「用与真实设备完全相同的协议与消息格式模拟……客户设备到位后，
      仅切换数据源，渲染与孪生引擎零改动。」

本模块**只通过 MQTT 与平台通信**，因此整条协议路径都被真实地走了一遍。
它也**不知道 Hub 的存在**——就像一台真设备一样。

## 模拟的设备

    robot-001    巡检/配送机器人，20Hz 位姿 + 1Hz 状态（电量/运行态）
    ac-001       空调，1Hz 状态（温度在阈值附近波动）
    printer-001  打印机，1Hz 状态
    water-001    饮水机，1Hz 状态

## 指令

订阅 `twin/{id}/command`，执行后回 `twin/{id}/ack`（含下发时带的 id，便于平台侧对上号）。
"""

import json
import logging
import math
import threading
import time
import uuid

import paho.mqtt.client as mqtt

import topics

log = logging.getLogger(__name__)

# 巡游环路（开放办公区内，单位：米）——与办公室图纸一致
PATH_X0, PATH_X1 = 1.8, 14.2
PATH_Y0, PATH_Y1 = 5.0, 9.0
ROBOT_SPEED = 1.5  # m/s


class SimGateway:
    def __init__(self, host="127.0.0.1", port=1883, pose_rate=20.0):
        self.host = host
        self.port = port
        self.pose_rate = pose_rate
        self._t = 0.0
        self._paused = threading.Event()
        self._stop = threading.Event()
        self._thread = None
        self._client = None
        self.stats = {"published": 0, "commands": 0, "acks": 0}

    # ---- 生命周期 ----
    def start(self):
        self._client = mqtt.Client(
            mqtt.CallbackAPIVersion.VERSION2, client_id="twin-sim-gateway")
        self._client.on_connect = self._on_connect
        self._client.on_message = self._on_message
        self._client.reconnect_delay_set(min_delay=1, max_delay=30)
        try:
            self._client.connect(self.host, self.port, keepalive=30)
            self._client.loop_start()
        except Exception as exc:  # noqa: BLE001
            log.warning("仿真网关无法连接 MQTT（%s:%s）：%s", self.host, self.port, exc)
            return False

        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        log.info("仿真网关已启动（20Hz 位姿 + 1Hz 设备状态，全部经 MQTT 发布）")
        return True

    def stop(self):
        self._stop.set()
        if self._client:
            self._client.loop_stop()
            self._client.disconnect()

    # ---- MQTT ----
    def _on_connect(self, client, userdata, flags, reason_code, properties=None):
        if reason_code == 0 or str(reason_code) == "Success":
            # 订阅所有设备的指令主题——就像真设备监听自己的指令一样
            client.subscribe("twin/+/" + topics.DOWNSTREAM_TYPE, qos=1)
            log.info("仿真网关已连接 MQTT，正在监听指令主题")

    def _publish(self, twin_id, type_, data):
        if not self._client:
            return
        payload = json.dumps(data, ensure_ascii=False)
        self._client.publish(topics.upstream_topic(twin_id, type_), payload, qos=0)
        self.stats["published"] += 1

    # ---- 设备行为 ----
    def _run(self):
        interval = 1.0 / self.pose_rate
        counter = 0
        while not self._stop.is_set():
            if not self._paused.is_set():
                self._t += interval
                self._emit_pose()
                counter += 1
                if counter % 20 == 0:      # 1Hz 设备状态
                    self._emit_equipments()
            time.sleep(interval)

    def _emit_pose(self):
        w = PATH_X1 - PATH_X0
        h = PATH_Y1 - PATH_Y0
        s = (self._t * ROBOT_SPEED) % (2 * (w + h))

        if s < w:
            x, y, yaw = PATH_X0 + s, PATH_Y0, 0.0
        elif s < w + h:
            x, y, yaw = PATH_X1, PATH_Y0 + (s - w), math.pi / 2
        elif s < 2 * w + h:
            x, y, yaw = PATH_X1 - (s - w - h), PATH_Y1, math.pi
        else:
            x, y, yaw = PATH_X0, PATH_Y1 - (s - 2 * w - h), -math.pi / 2

        self._publish("robot-001", "pose", {
            "ts": int(time.time() * 1000),
            "x": round(x, 3), "y": round(y, 3), "z": 0.0,
            "yaw": round(yaw, 3), "roll": 0.0, "pitch": 0.0,
        })

    def _emit_equipments(self):
        now = int(time.time() * 1000)

        # 机器人状态：电量缓慢下降、运行态随暂停指令变化。
        # 有电量这类可监测字段，告警规则才有东西可评估（之前只发位姿）。
        battery = round(max(0.0, 100.0 - self._t * 0.05), 1)
        self._publish("robot-001", "status", {
            "ts": now,
            "state": "paused" if self._paused.is_set() else "running",
            "battery": battery,
            "speed": 0.0 if self._paused.is_set() else ROBOT_SPEED,
            "task": "巡检",
        })

        # 空调温度在阈值附近波动：既能看到告警触发，也能看到自动恢复
        # （真实空调的温控就是这么来回摆的，比造一个单调越界的数据更接近实际）
        self._publish("ac-001", "status", {
            "ts": now, "state": "running", "mode": "cool",
            "temp": round(25.0 + math.sin(self._t * 0.08) * 3.0, 1), "fan": "auto",
        })

        busy = int(self._t) % 30 < 4
        self._publish("printer-001", "status", {
            "ts": now,
            "state": "running" if busy else "idle",
            "job": "打印中" if busy else "待机",
            "pages": int(self._t / 30) * 12,
            "toner": round(max(0.0, 82.0 - self._t * 0.01), 1),
        })

        self._publish("water-001", "status", {
            "ts": now, "state": "running",
            "temp": round(92.0 + math.sin(self._t * 0.3), 1),
            "filter": round(max(0.0, 64.0 - self._t * 0.005), 1),
        })

    # ---- 指令 ----
    def _on_message(self, client, userdata, msg):
        parsed = topics.parse_topic(msg.topic)
        if not parsed or parsed[1] != topics.DOWNSTREAM_TYPE:
            return
        twin_id, _ = parsed

        try:
            body = json.loads(msg.payload.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return
        cmd = (body or {}).get("cmd")
        ref = (body or {}).get("id") or uuid.uuid4().hex[:8]
        self.stats["commands"] += 1

        # 「设备」执行指令——只有它会动的那个设备认这两个命令
        if twin_id == "robot-001" and cmd == "pause":
            self._paused.set()
            ok, err = True, None
        elif twin_id == "robot-001" and cmd == "resume":
            self._paused.clear()
            ok, err = True, None
        else:
            ok, err = False, f"设备不支持指令「{cmd}」"

        log.info("仿真设备 %s 收到指令 %s → %s", twin_id, cmd, "成功" if ok else err)
        self._publish(twin_id, "ack", {"ref": ref, "ok": ok, "err": err,
                                       "cmd": cmd, "ts": int(time.time() * 1000)})
        self.stats["acks"] += 1

    @property
    def paused(self):
        return self._paused.is_set()

```

