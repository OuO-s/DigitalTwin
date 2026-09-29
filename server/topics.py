"""平台适配器与仿真网关共用的 MQTT 主题约定。"""

UPSTREAM_TYPES = ("pose", "joint", "status", "ack")
DOWNSTREAM_TYPE = "command"
UPSTREAM_WILDCARD = "twin/+/+"


def _device_id(twin_id: str) -> str:
    if not isinstance(twin_id, str) or not twin_id or any(char in twin_id for char in "/+#\x00"):
        raise ValueError("无效的 twinId")
    return twin_id


def upstream_topic(twin_id: str, type_: str) -> str:
    if type_ not in UPSTREAM_TYPES:
        raise ValueError(f"无效的上行类型：{type_}")
    return f"twin/{_device_id(twin_id)}/{type_}"


def upstream_topics() -> list[str]:
    return [f"twin/+/{type_}" for type_ in UPSTREAM_TYPES]


def command_topic(twin_id: str) -> str:
    return f"twin/{_device_id(twin_id)}/{DOWNSTREAM_TYPE}"


def ack_topic(twin_id: str) -> str:
    return upstream_topic(twin_id, "ack")


def parse_topic(topic: str) -> tuple[str, str] | None:
    parts = (topic or "").split("/")
    if len(parts) != 3 or parts[0] != "twin" or not parts[1] or not parts[2]:
        return None
    if any(char in parts[1] for char in "+#\x00"):
        return None
    return parts[1], parts[2]


def is_upstream(topic: str) -> bool:
    parsed = parse_topic(topic)
    return bool(parsed) and parsed[1] in UPSTREAM_TYPES
