from __future__ import annotations

import time

UPLINK_TYPES = {"pose", "joint", "status", "ack"}


def normalize_mqtt(topic: str, payload: dict, received_at_ms: int | None = None) -> dict:
    """从 twin/{id}/{type} 主题解析身份字段，负载不重复包装 twinId/type。"""
    parts = topic.strip("/").split("/")
    if len(parts) != 3 or parts[0] != "twin" or not parts[1] or parts[2] not in UPLINK_TYPES:
        raise ValueError(f"unsupported twin topic: {topic}")
    body = dict(payload)
    timestamp = body.pop("ts", None)
    return {
        "twinId": parts[1],
        "type": parts[2],
        "ts": int(timestamp if timestamp is not None else received_at_ms or time.time() * 1000),
        "payload": body,
    }

