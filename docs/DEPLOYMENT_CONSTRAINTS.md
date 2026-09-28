# 部署约束与生产化清单

本项目当前交付的是可离线展示的数字孪生演示版。下表区分已经具备的结构和生产部署前必须完成的工作；《选型部署参考.md》中的其他项目实测数字不代表本平台的性能。

| 领域 | 当前实现 | 生产接入前的工作 |
| --- | --- | --- |
| 前端 | 原生 ES Modules、本地 Three.js 与 OrbitControls；无 CDN 依赖；渲染画质按设备能力和持续帧率在低、中、高档调整 | 在目标浏览器和 ARM 设备上实测 WebGL、交互帧率和启动耗时；确定最低浏览器版本 |
| 服务 | FastAPI ASGI 提供 REST、WebSocket 和静态资源；开发时使用 `uvicorn --reload` | 使用生产 ASGI 进程管理方案，配置环境变量端口、日志、健康检查和自动重启；上线前检查端口占用 |
| 消息 | `TwinHub` 接收 MQTT 与 HTTP 两种上行；仿真网关经外部 Broker 接入；Broker 不可达时 REST/页面继续运行 | 在目标环境配置 EMQX 或 Mosquitto 的设备身份、主题 ACL、TLS 和实际网关协议；HTTP 设备需独立凭据、HTTPS 与按设备 ID 授权 |
| 安全 | REST 与 WebSocket 使用 SQLite 会话和 `viewer/operator/admin` 角色；HTTP 上行使用可撤销设备令牌；默认管理员为 `admin / allrank8888` | 部署前修改默认密码，配置 TLS、设备 ID 级授权、操作审计和密钥管理；按现场需要保护静态图纸与 OpenAPI 文档 |
| 时序 | `TimeSeriesStore` 接口和 SQLite 实现 | 增加按时间和每设备条数限制的热窗、降采样、备份与恢复；确认磁盘配额和数据保留周期 |
| 运维 | `/api/v1/health` 已提供 MQTT 与 HTTP 接收/丢弃、MQTT 下发、仿真网关发布/回执和 Hub 发布计数 | 增加 WS 广播、存储写入/错误计数与监控告警；检查一段时间内的**计数器增量**，避免只有进程存活却停止收数 |
| 交付 | 可在开发机本地运行 | 在目标 ARM 设备上验证 Python 依赖、容器或 systemd 启动、重启恢复、离线安装、NTP 时间同步及数据卷备份 |

HTTP、WebSocket 和 MQTT 监听地址及端口应由环境变量配置，并在现场先探测端口占用。FastAPI 是 ASGI 应用，《选型部署参考.md》中针对 Flask 开发服务器的 gunicorn/uwsgi 建议不能直接照搬；需要选用兼容 ASGI 的生产运行方式。进程应由 systemd 或容器重启策略管理，不依赖手工后台命令。

`100 台设备 × 20 Hz` 仅作为后续容量验证场景，**不是现有吞吐指标**。验证时应覆盖 Broker、归一化适配器、Hub、WebSocket、SQLite 热窗和磁盘写入链路，并在目标设备上记录丢包、延迟、CPU、内存及磁盘增长。通过单机验证后，再确定是否继续使用 SQLite 或替换存储实现。

跨系统协议以共享的站点、楼栋、楼层、房间、设备标识，`twin/{id}/{type}` 主题和 REST/WebSocket 信封为边界。接入真实设备前需固定版本、校验消息，并补齐设备级指令权限与回执闭环。

具体的 [MQTT 故障信号](MQTT_INTEGRATION.md#broker-故障提示与告警边界)、[业务告警](ALERTS.md)及 [用户权限](AUTH.md)分别维护在对应文档中。
