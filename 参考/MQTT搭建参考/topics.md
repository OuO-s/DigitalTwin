```python
"""MQTT 主题约定 —— 平台侧（适配器）与设备侧（仿真网关）**共用同一份定义**。

两边各写一套字符串最容易出现「主题对不上、消息收不到」这类静默故障，
所以统一放这里，改一处两边一起变。

    twin/{twinId}/{type}

| 方向 | 主题 | 说明 |
|---|---|---|
| 设备 → 平台 | `twin/{id}/pose`   | 位姿流（高频） |
| 设备 → 平台 | `twin/{id}/joint`  | 关节状态 |
| 设备 → 平台 | `twin/{id}/status` | 状态事件 |
| 设备 → 平台 | `twin/{id}/ack`    | 指令回执 |
| 平台 → 设备 | `twin/{id}/command`| 指令下发 |

**上行与下行分列在不同 type 下**，所以适配器只订阅上行主题即可，
自己发出的指令不会回环到自己。
"""

UPSTREAM_TYPES = ("pose", "joint", "status", "ack")
DOWNSTREAM_TYPE = "command"

# 适配器订阅的通配主题：只覆盖上行，不含 command
UPSTREAM_WILDCARD = "twin/+/+"


def upstream_topic(twin_id, type_):
    """设备 → 平台。"""
    return f"twin/{twin_id}/{type_}"


def upstream_topics():
    """需要订阅的上行主题列表（逐类显式订阅，避免收 到自己的下行指令）。"""
    return [f"twin/+/{t}" for t in UPSTREAM_TYPES]


def command_topic(twin_id):
    """平台 → 设备。"""
    return f"twin/{twin_id}/{DOWNSTREAM_TYPE}"


def ack_topic(twin_id):
    return upstream_topic(twin_id, "ack")


def parse_topic(topic):
    """`twin/{id}/{type}` → (twin_id, type)；不符合约定返回 None。"""
    parts = (topic or "").split("/")
    if len(parts) != 3 or parts[0] != "twin":
        return None
    twin_id, type_ = parts[1], parts[2]
    if not twin_id or not type_:
        return None
    return twin_id, type_


def is_upstream(topic):
    parsed = parse_topic(topic)
    return bool(parsed) and parsed[1] in UPSTREAM_TYPES

```

