# 智萃空间数字孪生

智萃科技中心 6 号楼数字孪生首版。当前展示范围是临港园区实景、6 号楼示意外观和 7 楼示意平面；设备读数、能耗和告警均为**演示数据**，不代表真实运行状态。

## 本地运行

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m uvicorn server.app.main:app --reload
```

浏览器打开 `http://127.0.0.1:8000`。前端为原生 ES Modules，Three.js 与 OrbitControls 保存在 `web/lib/`，运行时不从 CDN 加载。

## 重新获取天地图影像

影像以 WGS84 锚点 `(121.912090, 30.867637)` 为准，栅格中心向西平移约 100 米；场景仍严格将 6 号楼锚点放在原坐标。默认 z18、地面覆盖范围约 800 米。Key 只通过环境变量传入：

```powershell
$env:TIANDITU_KEY = "<你的天地图 Key>"
python server\fetch_map.py --zoom 18 --extent 800
Remove-Item Env:\TIANDITU_KEY
```

生成文件写到 `web/assets/maps/site.png` 与 `site.json`。下载脚本检测影像占位瓦片并记录坐标边界与影像来源；前端不持有 Key。

## 模块

- `web/src/`：TwinStore、API/WebSocket 客户端、Three.js 场景及驾驶舱界面。
- `server/app/`：REST/WebSocket、TwinHub、协议适配器与 SQLite 时序接口。
- `server/assets/`：站点参数和毫米制楼层语义数据；7 楼数据标记为示意。
- `server/fetch_map.py`：天地图 WMTS 下载、拼接、坐标元数据生成。

## 数据接口

- `GET /api/v1/health`、`/api/v1/site`、`/api/v1/floorplans/f07`、`/api/v1/summary`
- `GET /api/v1/telemetry/{twinId}?limit=120`
- `WS /ws/twin`：孪生消息 `{twinId,type,ts,payload}`。
- MQTT 约定为 `twin/{id}/{type}`，上行类型 `pose|joint|status|ack`。设备负载本身不重复包含 twinId/type；真实 Broker 适配仍需部署配置。

## 精度边界

楼栋点位使用提供的坐标。因尚无总平面图和 7 楼 CAD，外墙尺寸、房间布局、面积、设备位置均为示意模型；获取实测资料后替换 `server/assets/floorplans/building-06-f07.json` 即可。
