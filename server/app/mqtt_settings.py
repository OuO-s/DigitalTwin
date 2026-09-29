"""外部 Broker 连接参数；口令只从进程环境读取。"""

from __future__ import annotations

import os
from dataclasses import dataclass


def enabled(name: str) -> bool:
    return os.getenv(name, "0").lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class MqttSettings:
    host: str
    port: int
    username: str | None
    password: str | None
    tls: bool
    ca_cert: str | None
    client_id: str

    @classmethod
    def from_env(cls) -> "MqttSettings":
        return cls(
            host=os.getenv("TWIN_MQTT_HOST", "127.0.0.1"),
            port=int(os.getenv("TWIN_MQTT_PORT", "1883")),
            username=os.getenv("TWIN_MQTT_USERNAME") or None,
            password=os.getenv("TWIN_MQTT_PASSWORD") or None,
            tls=enabled("TWIN_MQTT_TLS"),
            ca_cert=os.getenv("TWIN_MQTT_CA_CERT") or None,
            client_id=os.getenv("TWIN_MQTT_CLIENT_ID", f"zhicui-platform-{os.getpid()}"),
        )
