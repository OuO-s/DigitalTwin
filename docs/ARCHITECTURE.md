# 平台架构

```text
站点地图 / 楼层语义 JSON
       │
       ▼
Three.js Viewer ◀──── TwinStore ──── REST / WebSocket
                                         ▲
设备 ─ MQTT ─ ProtocolAdapter ─ TwinHub ┼─ TimeSeriesStore (SQLite)
                                         └─ Alert rules
```

## 窄腰契约

- 设备 MQTT：`twin/{id}/pose|joint|status|ack` 上行，`twin/{id}/command` 下行。主题提供 id/type，负载仅放业务数据，可选毫秒时间戳。
- 图纸语义：`meta{unit:mm,source,storeyHeight}`、`walls`、`doors`、`windows`、`rooms`、`equipments`。楼层配置当前采用同一语义方向的 JSON 源。
- WebSocket 孪生事件：`{twinId,type,ts,payload}`；告警/规则更新使用独立信封，避免混入设备 TwinStore。

## 实时与存储

演示适配器和后续 MQTT 适配器都向 TwinHub 发布归一化事件。Hub 向 WebSocket 客户端广播并写入 `TimeSeriesStore`；SQLite 是当前轻量实现，保留接口以便以后替换。生产部署应连接外部 EMQX/Mosquitto，不把 Broker 嵌入 Web 进程。

## 图形与地理参考

- 天地图影像以用户给定锚点为准，栅格中心向西偏移 100 米；元数据描述实际 WGS84 bbox 和偏移，前端据此放置纹理而不改变地理配准。浏览器运行不携带服务端 Key。
- 场景本地坐标以站点点位为原点，东为 +X，北为 -Z；房间几何以毫米保存，渲染时转为米。
- 当前影像范围约 800m。6 号楼定位点采用用户给定坐标；栅格中心偏移仅改变取景覆盖范围，不改写楼栋定位坐标。

## 后续生产接入

1. 将手绘示意楼层 JSON 换成实测 DXF/IFC 归一化结果。
2. 配置外部 MQTT Broker、设备身份认证和上行 topic 订阅。
3. 增加服务端鉴权、告警规则与历史回放；指令只在设备协议/权限确认后开放。
