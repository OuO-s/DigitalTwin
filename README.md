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

打开页面即可进入工作台，无需登录。

## 园区场景

园区鸟瞰由 Three.js 几何模型重新绘制，目标七栋楼、道路、绿地、水景和连廊均为矢量/网格模型，不铺设在线或离线实景底图。场景强调园区空间关系，支持旋转、缩放、连续切景、楼层展开、房间聚焦、道路流动光带、建筑扫描效果和热度着色。

园区按用户 2026-09 红框标注的卫星图重绘，聚焦**被四条道路围合的七栋楼**：1、4、6 号楼号取自影像注记，其余楼号待核对；楼间设一层高的风雨连廊（影像中连接楼栋的浅色带状体量）。定位参考坐标为 `(121.912090, 30.867637)`，场景局部原点取七栋楼群几何中心，`x` 向东、`z` 向南。比例尺由早期 6 号楼 7 层手绘图外轮廓（28.4m×38.0m）与影像屋顶像素反算，约 0.34 米/像素；当前楼层示意范围已扩展至 28.4m×54.0m。影像可确定相对位置与屋顶轮廓，绝对经纬度、楼号与实测尺寸仍需现场总图或 GPS 复核。7 楼按用户手绘图配置房间与桌椅；休闲区按最新布局扩展，包含长桌、沙发、茶几和茶水吧。楼层南侧设置人形机器人与机械臂演示区，西侧工位配置纸张打印机，东侧工位配置 3D 打印机；点击房间或设备可进入对应视角。

场景可继续点击设备进入设备聚焦视角。聚焦设备时房间和整层保留为可点击背景；点击背景房间返回房间，点击背景整层返回 7 楼。

7 楼中央通道的 `robot-01` 默认沿路线巡逻。点击场景中的机器人，或点击楼层右上角的“巡检机器人”入口，可打开面板暂停或恢复巡逻。机器人头顶标识只在选中并显示面板时出现；其他设备进入设备聚焦视角时复用同一标识。机器人演示区的 `eq-robot-01` 是独立的人形服务机器人。巡逻及暂停状态目前只在浏览器中模拟，刷新页面后恢复默认巡逻，不会向实体设备下发指令。交互与数据配置见 [楼层场景交互](docs/SCENE_INTERACTION.md)。

## 空间与数据

- `server/assets/campus-layout.json`：目标七栋楼、连廊、道路、步道和绿地示意数据，单位为米。楼栋带 `confidence` 字段（`primary` / `image-label` / `unverified-numbering`）。
- `server/assets/floorplans/building-06-f07.json`：7 楼房间和设备示意数据，几何单位为毫米。
- `server/app/`：FastAPI REST/WebSocket、TwinHub、演示/MQTT/HTTP 适配器与 SQLite 时序接口。
- `web/src/`：TwinStore、Three.js 场景和驾驶舱交互。

园区布局和 7 楼数据均可配置替换。默认设备读数、能耗、热度和告警均为**演示数据**，不代表真实运行状态。配置外部 Broker 后可接收真实设备遥测；设备指令需服务端配置 `TWIN_COMMAND_TOKEN`，真实设备控制仍需现场协议确认。

MQTT 的外部 Broker、仿真网关、设备报文、健康计数器及联调脚本见 [MQTT 外设接入与联调](docs/MQTT_INTEGRATION.md)。不支持 MQTT 的设备可按 [HTTP 设备上行接入](docs/HTTP_INTEGRATION.md)配置 `X-Device-Token` 并向 `/api/v1/ingest` 上报。

生产接入边界和待办见 [部署约束与生产化清单](docs/DEPLOYMENT_CONSTRAINTS.md)。

`参考/` 存放早期方案与外部示例，可能包含当前版本未实现的登录、设备控制和部署流程；实际使用请以本 README、`docs/` 与当前代码为准。

服务端告警规则、离线扫描、历史、统计和确认接口见 [告警引擎](docs/ALERTS.md)；MQTT 断线和消息异常的故障提示见 [MQTT 外设接入与联调](docs/MQTT_INTEGRATION.md#broker-故障提示与告警边界)。

## 接口

- `GET /api/v1/health`
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
- `POST /api/v1/ingest`：HTTP 设备上行，需配置 `TWIN_HTTP_DEVICE_TOKEN`，并在请求头传入 `X-Device-Token`。
- `POST /api/v1/command`：需服务端配置 `TWIN_COMMAND_TOKEN`，请求使用对应 Bearer 令牌；执行回执异步推送。
- `WS /ws/twin`：消息形状 `{twinId,type,ts,payload}`，连接后先推送状态快照。MQTT 主题契约为 `twin/{id}/{type}`。
