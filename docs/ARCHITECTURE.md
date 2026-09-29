# 平台架构

```text
站点 + 园区示意布局 + 楼层语义 JSON
                  │
                  ▼
Three.js 园区/楼层场景 ◀── TwinStore ──── REST / WebSocket
                                               ▲
设备 ─ MQTT ─ MqttAdapter ───┐
设备 ─ HTTP ─ HttpAdapter ───┴─ TwinHub ─ TimeSeriesStore (SQLite)
```

## 场景数据

- `server/assets/site.json` 保存园区名称、用户给出的 WGS84 参考点及 6 号楼的场景偏移与配准来源。
- `server/assets/campus-layout.json` 保存米制的目标七栋楼、风雨连廊、道路、绿地、水景和步道。场景由 Three.js 网格重新绘制，不加载实景瓦片或底图。
- `server/assets/floorplans/building-06-f07.json` 保存毫米制房间与设备位置，可由实测 CAD/IFC 转换数据替换。
- 同一楼层文件中的 `patrolRoute` 定义巡检机器人 `robot-01` 的路线和速度；机器人演示区的 `eq-robot-01` 属于 `equipments`，是另一台人形服务机器人。前端 `TwinStore` 保存巡逻暂停状态，`TwinScene` 按帧更新位置和选中标识。具体交互见 [楼层场景交互](SCENE_INTERACTION.md)。
- 园区空间布局按用户红框标注的卫星图逐栋重绘：七栋楼被四条道路围合，楼栋由一层高的风雨连廊连接。局部原点取七栋楼群几何中心，比例尺约 0.34 米/像素，由 6 号楼 7 层手绘图轮廓反算。绝对坐标、楼号与实测轮廓仍需总图/GPS 复核（见 `CALIBRATION.md`）。

## 窄腰契约

- 设备 MQTT：`twin/{id}/pose|joint|status|ack` 上行，`twin/{id}/command` 下行。主题提供 id/type，负载仅放业务数据，可选毫秒时间戳。
- WebSocket 孪生事件：`{twinId,type,ts,payload}`；连接时发送 `snapshot`。完整字段约定见 `../shared/twin_message_schema.json`。
- 园区和楼层模型属性均通过配置加载；演示状态与正式状态沿用相同的事件归一化形状。

## 实时与存储

演示适配器仅在未启用外部接入时直写 Hub；MQTT 与 HTTP 适配器可以同时向 TwinHub 发布归一化事件。Hub 向 WebSocket 客户端广播并写入 `TimeSeriesStore`；SQLite 是当前轻量实现，保留接口以便以后替换。MQTT 从 `server/topics.py` 获取主题，仿真网关只通过外部 Broker 通信，不直接调用 Hub。联调步骤见 [MQTT 外设接入与联调](MQTT_INTEGRATION.md)及 [HTTP 设备上行接入](HTTP_INTEGRATION.md)。生产部署应连接外部 EMQX/Mosquitto，不把 Broker 嵌入 Web 进程。

部署边界、现有能力与生产化待办见 [部署约束与生产化清单](DEPLOYMENT_CONSTRAINTS.md)。

MQTT 故障信号与业务告警分别见 [MQTT 接入与故障提示](MQTT_INTEGRATION.md)和 [告警引擎](ALERTS.md)。

## 后续生产接入

1. 用园区总平面、楼栋实测坐标和 7 楼 CAD/IFC 替换示意配置。
2. 在外部 Broker 配置设备身份认证、主题 ACL 与 TLS，并核对现场协议。
3. 为现有告警规则增加在线编辑与多进程扫描协调；扩展历史回放，并在接入真实设备前实现按设备授权和指令审计。
