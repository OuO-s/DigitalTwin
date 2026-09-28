# HTTP 设备上行接入

不支持 MQTT 的设备可向 `POST /api/v1/ingest` 发送 JSON。`HttpAdapter` 按共享孪生消息契约归一化后交给 `TwinHub`，后续 SQLite、WebSocket、快照和现有设备面板沿用相同路径。实现参考 `MQTT搭建参考/http_adapter.md` 的 M1 上行流程；下行在参考中仍是占位，本项目不会把未送达的 HTTP 指令报告为成功。

## 启用

管理员登录后可通过右上角账户面板生成独立设备令牌，设备在 `X-Device-Token` 头发送。令牌明文只在创建时显示一次；撤销后立即失效。运行期间首次收到有效设备令牌的 HTTP 上报时，平台会停止演示遥测，避免演示数据覆盖真实读数。

已有部署也可以在启动 FastAPI **之前**设置共享设备令牌：

```powershell
$env:TWIN_HTTP_DEVICE_TOKEN = "<自行生成的随机设备令牌>"
.\.venv\Scripts\python.exe -m uvicorn server.app.main:app --host 127.0.0.1 --port 8000
```

没有任何设备令牌时，接入接口返回 503；令牌缺失或错误时返回 401。设备使用 `X-Device-Token` 请求头，也可用 `Authorization: Device <令牌>`。人员指令使用登录会话令牌，并要求 `operator` 或 `admin` 角色。启动时已有 HTTP 令牌且未启用 MQTT 时，平台不会启动直写 Hub 的演示适配器。HTTP 与 MQTT 可以同时启用。

## 设备报文

```http
POST /api/v1/ingest HTTP/1.1
Content-Type: application/json
X-Device-Token: <设备令牌>

{"twinId":"eq-hvac-01","type":"status","ts":1790000000000,"data":{"state":"online","temperature":23.4}}
```

请求也可使用 `payload` 代替 `data`；两者不能同时出现。`ts` 可省略，届时使用服务端毫秒时间。适配器对外统一为 `{twinId,type,ts,payload}`，成功返回 HTTP 202。`twinId` 必须与 [7 楼设备配置](../server/assets/floorplans/building-06-f07.json)中的 ID 一致，读数才会映射到现有设备面板；未知 ID 仍会进入 Hub 和遥测记录。HTTP 与 MQTT 接入的设备应使用互不冲突的 ID。

允许的上行类型与 [消息 Schema](../shared/twin_message_schema.json)相同：`pose`、`joint`、`status`、`ack`。其中 `status` 必须提供非空 `state`；`pose` 必须提供 `x,y,z,yaw,roll,pitch` 数值；`joint` 需要数值数组 `joints`；`ack` 需要字符串 `ref` 和布尔值 `ok`。无效字段返回 400，并增加 `/api/v1/health` 的 `http.rejected`；成功请求增加 `http.received`、更新 `http.lastReceivedTs`。HTTP 与 MQTT 均使用同一个 `TwinEvent` 校验规则。

当前 HTTP 适配器**只支持设备上行**。参考实现的 `send_command()` 仅是 TODO 占位；这里明确返回未实现。已通过 HTTP 上报的设备调用 `POST /api/v1/command` 时返回 501，不会虚报下发成功。需要下行时，应先确定现场设备是否能主动轮询或提供可访问的回调地址，再设计指令缓存、确认、超时与鉴权。

生产部署还需配置 HTTPS、按设备 ID 的写入权限和访问日志。管理员创建的令牌可逐个撤销；目前令牌仍允许上报任意 `twinId`，设备级授权应在接入现场设备前补齐。
