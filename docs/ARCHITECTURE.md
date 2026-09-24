# 平台架构

```text
站点 + 园区示意布局 + 楼层语义 JSON
                  │
                  ▼
Three.js 园区/楼层场景 ◀── TwinStore ──── REST / WebSocket
                                               ▲
设备 ─ MQTT ─ ProtocolAdapter ─ TwinHub ─ TimeSeriesStore (SQLite)
```

## 场景数据

- `server/assets/site.json` 保存园区名称、用户给出的 WGS84 参考点、独立镜头偏移及 6 号楼配准来源。
- `server/assets/campus-layout.json` 保存米制的楼栋、道路、绿地、水景、步道和周边体量。场景由 Three.js 网格重新绘制，不加载实景瓦片或底图。
- `server/assets/floorplans/building-06-f07.json` 保存毫米制房间与设备位置，可由实测 CAD/IFC 转换数据替换。
- 园区空间布局目前为可视化示意。6 号楼按用户红圈卫星图的楼顶定位为局部模型原点；约 100 米的向西平移仅属于镜头参考，不再用于推断楼栋坐标。道路和相邻楼顶按影像走向重绘，绝对坐标、轮廓、楼号仍需总图/GPS 复核。

## 窄腰契约

- 设备 MQTT：`twin/{id}/pose|joint|status|ack` 上行，`twin/{id}/command` 下行。主题提供 id/type，负载仅放业务数据，可选毫秒时间戳。
- WebSocket 孪生事件：`{twinId,type,ts,payload}`；告警/规则更新使用独立信封。
- 园区和楼层模型属性均通过配置加载；演示状态与正式状态沿用相同的事件归一化形状。

## 实时与存储

演示适配器和后续 MQTT 适配器都向 TwinHub 发布归一化事件。Hub 向 WebSocket 客户端广播并写入 `TimeSeriesStore`；SQLite 是当前轻量实现，保留接口以便以后替换。生产部署应连接外部 EMQX/Mosquitto，不把 Broker 嵌入 Web 进程。

## 后续生产接入

1. 用园区总平面、楼栋实测坐标和 7 楼 CAD/IFC 替换示意配置。
2. 配置外部 MQTT Broker、设备身份认证和上行 topic 订阅。
3. 增加服务端鉴权、告警规则与历史回放；仅在设备协议/权限确认后开放指令。
