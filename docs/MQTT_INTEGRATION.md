# MQTT 外设接入与联调

## 协议路径

```text
外部设备 / 仿真网关 ── MQTT Broker ── MqttAdapter ── TwinHub ── SQLite + WebSocket
                                                     ▲
HTTP POST /api/v1/command ── MqttAdapter ── Broker ── 设备 ── ack ──┘
```

`server/topics.py` 是平台与仿真网关共用的主题定义：上行为 `twin/{id}/pose|joint|status|ack`，下行为 `twin/{id}/command`。平台只订阅四类上行，断线重连后自动重新订阅。设备负载不写 `twinId`、`type` 或二次封装的 `payload`；可写毫秒级 `ts`，缺省由平台补。归一化后的 Hub/WebSocket 消息使用 `{twinId,type,ts,payload}`，字段契约见 `shared/twin_message_schema.json`。

不支持 MQTT 的设备可使用并行的 [HTTP 设备上行适配器](HTTP_INTEGRATION.md)，进入同一个 Hub；MQTT 与 HTTP 使用相同的消息字段校验。

仿真网关仅 import `server/topics.py`，不依赖 Hub、适配器或存储。它只监听自身五台示意设备的 `command`。默认每秒发布设备状态，并以 5 Hz 发布一台示意小车的位姿；频率可通过 `TWIN_SIM_POSE_HZ` 调整至 0.2–20 Hz。该小车只进入遥测/快照，不驱动 7 楼的可视巡检机器人 `robot-01`；后者目前由浏览器按 `patrolRoute` 本地模拟，面板中的暂停/恢复也只改变浏览器状态。

## 本机联调

1. 安装依赖：`python -m venv .venv`，然后使用虚拟环境里的 `python -m pip install -r requirements.txt`。
2. 启动独立 Broker：`docker compose up -d mqtt`。仓库的 `compose.yaml` 仅供**本机联调**，1883 端口只绑定 `127.0.0.1`，容器内允许匿名连接。正式环境请换成启用身份认证、ACL 和 TLS 的外部 EMQX/Mosquitto。
3. 在启动 FastAPI 的终端设置：

   ```powershell
   $env:TWIN_MQTT_ENABLED = "1"
   $env:TWIN_MQTT_HOST = "127.0.0.1"
   $env:TWIN_MQTT_PORT = "1883"
   $env:TWIN_SIM_GATEWAY = "1"
   $env:TWIN_COMMAND_TOKEN = "<在两终端使用相同的随机令牌>"
   .\.venv\Scripts\python.exe -m uvicorn server.app.main:app --host 127.0.0.1 --port 8000
   ```

4. 在另一终端设置同一 `TWIN_COMMAND_TOKEN`，运行 `.\.venv\Scripts\python.exe tools\test_mqtt.py`。脚本会通过独立 MQTT 客户端模拟外部设备，检查发布/接收计数增量、Hub 与 WebSocket 快照、未经授权的指令拒绝，以及 `pause` / `resume` / 不支持指令的 ack。

访问 `GET /api/v1/health`：`gateway.published` 是仿真网关收到 PUBACK 的上行数，`mqtt.received` 是适配器从 Broker 收到并投递给 Hub 的上行数。没有其他设备发布时，两者的**时间窗口增量**应接近；少量在途消息会造成瞬时差异。`mqtt.dropped` 统计不合法主题或负载，`mqtt.hubErrors` 统计 Hub 写入失败。`GET /api/v1/twins` 返回最新状态；`GET /api/v1/telemetry/{twinId}` 返回 SQLite 中的近期记录。

## 外部设备接入

将 `TWIN_SIM_GATEWAY` 设为 `0` 或不设置，平台只监听真实设备。设备与 Broker 建立 MQTT 连接后发布：

```text
topic:   twin/eq-hvac-01/status
payload: {"ts":1790000000000,"state":"online","temperature":23.4}
```

设备需使用与楼层配置 `server/assets/floorplans/building-06-f07.json` 一致的 ID，界面才能把实时读数映射到对应设备。未知 ID 仍会进入 Hub、WebSocket 和遥测存储，但不会自动出现在楼层模型中。`pose` 必须提供 `x,y,z,yaw,roll,pitch`，`joint` 必须提供数值数组 `joints`，`status` 必须提供字符串 `state`，`ack` 必须提供字符串 `ref` 与布尔值 `ok`。这些基础校验失败的消息会被丢弃并计数。

`POST /api/v1/command` 需 `Authorization: Bearer <TWIN_COMMAND_TOKEN>`，请求体为 `{"twinId":"eq-printer-6","cmd":"pause"}`。接口只确认指令发布成功，返回 `id`；设备应订阅自己的 `twin/{id}/command`，直接读取负载里的 `cmd`、`id`，再向 `twin/{id}/ack` 发布 `{"ref":"<id>","ok":true,"err":null}`。ack 经相同适配器与 Hub 送至 WebSocket。未设置 `TWIN_COMMAND_TOKEN` 时接口禁用。仿真网关的 `pause` / `resume` 仅修改模拟打印机状态；真实设备下发前应由现场协议确认。

## Broker 故障提示与告警边界

启用 MQTT 后，Broker 不可达不会阻止 FastAPI 的 REST、WebSocket 和页面启动。Paho 网络线程会自动重连；平台不会在断线时退回演示适配器，以免模拟数据掩盖真实链路故障。当前可观察到的故障信号如下：

| 情况 | 日志与健康状态 | 实际影响 |
| --- | --- | --- |
| Broker 不可达、拒绝连接或连接中断 | 服务端记录 MQTT 警告；`/api/v1/health` 的 `mqtt.connected=false` | REST/页面继续运行，设备上行暂停，指令接口返回 503；恢复连接后重新订阅上行主题 |
| 仿真网关单独断线 | 网关警告；`gateway.connected=false` | 仿真设备不再发布；平台 MQTT 客户端可能仍显示已连接 |
| 上行主题或负载不合约 | `mqtt.dropped` 增长 | 该条消息不进入 Hub；应核对主题、JSON 和 [消息 Schema](../shared/twin_message_schema.json) |
| Hub 写入失败 | `mqtt.hubErrors` 增长，服务端记录错误 | 该条消息的后续存储或广播可能失败 |
| 指令 MQTT 发布失败或超时 | `/api/v1/command` 返回 503 | 不能视为设备已经执行；即使接口返回 202，也仍需等匹配 `id` 的设备 `ack` |

`mqtt.connected=true` 只说明 Broker 已连接，不能单独证明设备持续上报或主题权限正确；还应检查 `mqtt.received`、`hub.published` 的时间窗口增量，以及 Broker 的订阅权限。平台目前**没有单独的 Broker 断线业务告警规则**；[告警引擎](ALERTS.md)的设备离线规则只对已经收到过消息的设备定时评估。因此日志警告、连接健康状态与告警中心的设备告警是三个不同的信号。

默认未启用 MQTT 时沿用原演示适配器。设置 `TWIN_MQTT_ENABLED=1` 后不再由演示适配器直写 Hub，避免绕过 MQTT 的假阳性。网页和数据接口无需登录；MQTT Broker 凭据与指令接口令牌分别配置。

## 生产配置

生产连接可配置 `TWIN_MQTT_HOST`、`TWIN_MQTT_PORT`、`TWIN_MQTT_USERNAME`、`TWIN_MQTT_PASSWORD`、`TWIN_MQTT_TLS=1`、`TWIN_MQTT_CA_CERT` 与 `TWIN_MQTT_CLIENT_ID`。仿真网关可另用 `TWIN_SIM_MQTT_USERNAME` / `TWIN_SIM_MQTT_PASSWORD`；这些值只从环境读取，不写入前端。设备与平台应使用不同凭据及主题 ACL。设备证书与审计仍按 [部署约束](DEPLOYMENT_CONSTRAINTS.md)后续实施。
