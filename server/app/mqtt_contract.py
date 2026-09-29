from __future__ import annotations

import time

from server import topics
from .models import TwinEvent

UPLINK_TYPES = frozenset(topics.UPSTREAM_TYPES)


def normalize_mqtt(topic: str, payload: dict, received_at_ms: int | None = None) -> dict:
    """从 twin/{id}/{type} 主题解析身份字段，负载不重复包装 twinId/type。"""
    parsed = topics.parse_topic(topic)
    if not parsed or parsed[1] not in UPLINK_TYPES or not isinstance(payload, dict):
        raise ValueError(f"unsupported twin topic: {topic}")
    if "twinId" in payload or "type" in payload or "payload" in payload or "data" in payload:
        raise ValueError("MQTT 负载不应重复包装身份或信封")
    body = dict(payload)
    timestamp = body.pop("ts", None)
    if timestamp is not None and (isinstance(timestamp, bool) or not isinstance(timestamp, (int, float))):
        raise ValueError("ts 必须为毫秒数")
    return TwinEvent.model_validate({
        "twinId": parsed[0],
        "type": parsed[1],
        "ts": int(timestamp if timestamp is not None else received_at_ms or time.time() * 1000),
        "payload": body,
    }).model_dump()
