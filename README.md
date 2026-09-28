# 智萃空间数字孪生

面向智萃科技中心的数字孪生演示平台。从园区鸟瞰进入 6 号楼和 7 楼，可查看空间、设备、告警与演示能耗。

## 本地运行

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m uvicorn server.app.main:app --reload
```

浏览器打开 `http://127.0.0.1:8000`。前端为原生 ES Modules；Three.js 与 OrbitControls 本地化，不从 CDN 加载。

首次启动会创建默认管理员：用户名 `admin`，密码 `allrank8888`。可在首次启动前设置 `TWIN_ADMIN_PASSWORD`（至少 8 位）覆盖默认密码。已有账户不会因重启而重置。账户、会话和设备令牌保存在 `data/auth.sqlite3`，应与业务数据一同备份并保护文件权限。

登录后点击右上角头像可修改密码；管理员可创建用户、分配角色、重置密码、删除用户，以及创建或撤销 HTTP 设备令牌。角色分为 `viewer`（查看）、`operator`（查看与下发设备指令）、`admin`（全部权限）。重置密码会生成仅显示一次的临时密码。修改密码、调整角色或删除用户会使其现有会话失效；系统禁止删除或降级最后一位管理员。

角色矩阵、登录会话、HTTP 设备令牌与 MQTT Broker 凭据的边界见 [用户权限与设备令牌](docs/AUTH.md)。默认管理员密码仅供本地演示，接入其他网络前须修改。

## 园区场景

园区鸟瞰由 Three.js 几何模型重新绘制，目标七栋楼、道路、绿地、水景和连廊均为矢量/网格模型，不铺设在线或离线实景底图。场景强调园区空间关系，支持旋转、缩放、连续切景、楼层展开、房间聚焦、道路流动光带、建筑扫描效果和热度着色。

园区按用户 2026-09 红框标注的卫星图重绘，聚焦**被四条道路围合的七栋楼**：1、4、6 号楼号取自影像注记，其余楼号待核对；楼间设一层高的风雨连廊（影像中连接楼栋的浅色带状体量）。定位参考坐标为 `(121.912090, 30.867637)`，场景局部原点取七栋楼群几何中心，`x` 向东、`z` 向南。比例尺由 6 号楼 7 层手绘图外轮廓（28.4m×38.0m）与影像屋顶像素反算，约 0.34 米/像素；影像可确定相对位置与屋顶轮廓，绝对经纬度、楼号与实测尺寸仍需现场总图或 GPS 复核。7 楼按用户手绘图配置房间、桌椅及 3D 打印机，点击房间进入室内视角。

场景可继续点击设备进入设备聚焦视角。聚焦设备时房间和整层保留为可点击背景；点击背景房间返回房间，点击背景整层返回 7 楼。

## 空间与数据

- `server/assets/campus-layout.json`：目标七栋楼、连廊、道路、步道和绿地示意数据，单位为米。楼栋带 `confidence` 字段（`primary` / `image-label` / `unverified-numbering`）。
- `server/assets/floorplans/building-06-f07.json`：7 楼房间和设备示意数据，几何单位为毫米。
- `server/app/`：FastAPI REST/WebSocket、TwinHub、演示/MQTT/HTTP 适配器与 SQLite 时序接口。
- `web/src/`：TwinStore、Three.js 场景和驾驶舱交互。

园区布局和 7 楼数据均可配置替换。默认设备读数、能耗、热度和告警均为**演示数据**，不代表真实运行状态。配置外部 Broker 后可接收真实设备遥测；设备指令需 `operator` 或 `admin` 登录，真实设备控制仍需现场协议确认。

MQTT 的外部 Broker、仿真网关、设备报文、健康计数器及联调脚本见 [MQTT 外设接入与联调](docs/MQTT_INTEGRATION.md)。不支持 MQTT 的设备可按 [HTTP 设备上行接入](docs/HTTP_INTEGRATION.md)配置 `X-Device-Token` 并向 `/api/v1/ingest` 上报。

生产接入边界和待办见 [部署约束与生产化清单](docs/DEPLOYMENT_CONSTRAINTS.md)。

服务端告警规则、离线扫描、历史、统计和确认接口见 [告警引擎](docs/ALERTS.md)；MQTT 断线和消息异常的故障提示见 [MQTT 外设接入与联调](docs/MQTT_INTEGRATION.md#broker-故障提示与告警边界)。

## 接口

- `GET /api/v1/health`
- `POST /api/v1/auth/login`、`POST /api/v1/auth/logout`、`GET /api/v1/auth/me`、`POST /api/v1/auth/change-password`
- `GET/POST /api/v1/users`、`PATCH /api/v1/users/{username}/role`、`POST /api/v1/users/{username}/reset-password`、`DELETE /api/v1/users/{username}`：仅管理员。
- `GET/POST /api/v1/device-tokens`、`DELETE /api/v1/device-tokens/{label}`：仅管理员，明文令牌仅创建时返回。
- `GET /api/v1/site`
- `GET /api/v1/campus-layout`
- `GET /api/v1/floorplans/f07`
- `GET /api/v1/summary`
- `GET /api/v1/alerts?active=1`
- `GET /api/v1/alerts/rules`
- `GET /api/v1/alerts/stats`
- `POST /api/v1/alerts/{id}/ack`
- `GET /api/v1/telemetry/{twinId}?limit=120`
- `GET /api/v1/twins`
- `POST /api/v1/ingest`：HTTP 设备上行，需管理员创建的设备令牌（`X-Device-Token`）；现有 `TWIN_HTTP_DEVICE_TOKEN` 环境变量仍可用。
- `POST /api/v1/command`：需操作员及以上的 Bearer 会话令牌；执行回执异步推送。
- `WS /ws/twin?token=<会话令牌>`：需查看者及以上角色；消息形状 `{twinId,type,ts,payload}`，连接后先推送状态快照。MQTT 主题契约为 `twin/{id}/{type}`。

除健康检查、登录和设备上行外，REST 数据接口都需要 `Authorization: Bearer <会话令牌>`。生产环境应使用 HTTPS/WSS，避免密码和会话令牌在传输中暴露。
