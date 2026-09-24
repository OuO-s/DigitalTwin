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

## 园区场景

园区鸟瞰由 Three.js 几何模型重新绘制，道路、绿地、水景、周边体量均为矢量/网格模型，不铺设在线或离线实景底图。场景强调园区空间关系，支持旋转、缩放、平滑切景、楼栋聚焦、道路流动光带、建筑扫描效果和热度着色。

园区地址锚点为 `(121.912090, 30.867637)`。6 号楼在场景中暂按锚点向西约 100 米布置，以匹配初始视角；楼栋位置及相邻楼栋相对关系仍需用园区总图或现场 GPS 复核。界面会标注这一精度边界。

## 空间与数据

- `server/assets/campus-layout.json`：园区楼栋、道路、步道、绿地和周边示意数据，单位为米。
- `server/assets/floorplans/building-06-f07.json`：7 楼房间和设备示意数据，几何单位为毫米。
- `server/app/`：FastAPI REST/WebSocket、TwinHub、演示适配器与 SQLite 时序接口。
- `web/src/`：TwinStore、Three.js 场景和驾驶舱交互。

园区布局和 7 楼数据均可配置替换。设备读数、能耗、热度和告警均为**演示数据**，不代表真实运行状态；首版不执行真实设备控制。

## 接口

- `GET /api/v1/health`
- `GET /api/v1/site`
- `GET /api/v1/campus-layout`
- `GET /api/v1/floorplans/f07`
- `GET /api/v1/summary`
- `GET /api/v1/telemetry/{twinId}?limit=120`
- `WS /ws/twin`：消息形状 `{twinId,type,ts,payload}`。MQTT 主题契约为 `twin/{id}/{type}`，真实 Broker 适配待部署配置。
