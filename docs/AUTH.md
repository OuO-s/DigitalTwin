# 用户权限与设备令牌

本页记录当前代码已经实现的权限边界。平台用户、HTTP 设备和 MQTT Broker 使用不同的凭据；它们不能互相替代。

## 角色与接口

| 身份 | 当前可执行的操作 |
| --- | --- |
| `viewer` | 查看园区、楼层、设备、遥测、告警和报表；连接 `/ws/twin` |
| `operator` | 拥有 `viewer` 权限；可向 MQTT 设备下发指令、确认告警 |
| `admin` | 拥有 `operator` 权限；可创建、删除用户，调整角色，重置密码，创建或撤销 HTTP 设备令牌 |
| HTTP 设备 | 仅凭设备令牌调用 `POST /api/v1/ingest` 上报；不能使用用户 REST 或 WebSocket 接口 |

`GET /api/v1/health` 和 `POST /api/v1/auth/login` 不需要用户登录。其他业务读取接口要求 `viewer` 及以上角色；敏感写入接口按上表提升权限。用户 REST 请求使用 `Authorization: Bearer <登录会话令牌>`。WebSocket 当前使用 `/ws/twin?token=<登录会话令牌>`，无效、过期或被撤销的会话会被拒绝；连接期间也会定期复核。角色不足时 REST 返回 403，未登录或会话过期时返回 401。

## 首次登录与账户管理

首次启动且账户库为空时，系统创建 `admin`。当前演示默认密码为 `allrank8888`；可在**首次启动前**设置至少 8 位的 `TWIN_ADMIN_PASSWORD`。已有账户不会因修改环境变量或重启而重置。默认密码是公开的，接入局域网或互联网之前必须更换。

登录失败按“用户名 + 来源地址”限制次数：5 分钟内达到 5 次失败后，接口暂时返回 429。登录会话默认有效期为 12 小时；数据库只保存会话令牌的哈希。密码使用带随机盐的 PBKDF2-HMAC-SHA256 保存。用户自行修改密码、管理员重置密码、调整角色或删除用户时，现有会话会失效；最后一位管理员不能被删除或降级。管理员创建用户时若未指定密码，系统生成只显示一次的临时密码，新用户须先修改密码才能访问受角色保护的业务接口。

账户入口位于页面右上角；对应 REST 接口为：

- `POST /api/v1/auth/login`、`POST /api/v1/auth/logout`、`GET /api/v1/auth/me`、`POST /api/v1/auth/change-password`。
- `GET/POST /api/v1/users`、`PATCH /api/v1/users/{username}/role`、`POST /api/v1/users/{username}/reset-password`、`DELETE /api/v1/users/{username}`：仅 `admin`。
- `GET/POST /api/v1/device-tokens`、`DELETE /api/v1/device-tokens/{label}`：仅 `admin`。

## HTTP 设备令牌

管理员可为 HTTP 设备创建有标签的随机令牌，明文只在创建时返回一次，数据库保存哈希；撤销后立即失效。设备可使用 `X-Device-Token: <令牌>` 或 `Authorization: Device <令牌>` 调用 [HTTP 上行接口](HTTP_INTEGRATION.md)。兼容旧配置的 `TWIN_HTTP_DEVICE_TOKEN` 环境变量仍可使用，但它不在后台令牌列表中，不能通过页面撤销；移除该环境变量并重启服务才会停用。

当前设备令牌只验证“是否允许上报”，**尚未绑定可写的 `twinId`**。接入真实设备前，应为每台设备或网关配置独立令牌和 ID 级授权，避免一个设备冒用另一个设备的 ID。HTTP 设备不能使用用户会话令牌；用户也不能拿设备令牌读取业务数据。

## MQTT 权限边界

MQTT 平台客户端使用 `TWIN_MQTT_USERNAME/PASSWORD` 等 Broker 配置；仿真网关可使用独立的 `TWIN_SIM_MQTT_USERNAME/PASSWORD`。这些是 **Broker 凭据**，不会赋予 Web 平台的 `viewer/operator/admin` 角色。平台的 `POST /api/v1/command` 先要求 `operator` 或 `admin` 会话，随后由 MQTT 适配器发布指令；Broker 仍须通过设备级主题 ACL 限制谁能发布上行、订阅或发布下行。详见 [MQTT 接入与故障提示](MQTT_INTEGRATION.md)。

账户和令牌保存在 `data/auth.sqlite3`，应连同其他业务库备份并限制文件访问权限。正式部署还需 HTTPS/WSS、登录与指令审计、设备 ID 级授权，并避免在反向代理日志中记录 WebSocket URL 查询令牌；参见 [部署约束](DEPLOYMENT_CONSTRAINTS.md)。
