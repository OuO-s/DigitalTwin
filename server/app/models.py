from __future__ import annotations

import math
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class TwinEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    twinId: str = Field(min_length=1, max_length=128, pattern=r"^[^/+#\x00]+$")
    type: Literal["pose", "joint", "status", "ack"]
    ts: int = Field(ge=0, strict=True)
    payload: dict[str, Any]

    @model_validator(mode="after")
    def validate_payload(self):
        data = self.payload
        if self.type == "pose":
            fields = ("x", "y", "z", "yaw", "roll", "pitch")
            if any(isinstance(data.get(key), bool) or not isinstance(data.get(key), (int, float))
                   or not math.isfinite(data[key]) for key in fields):
                raise ValueError("pose 必须包含有限数值 x/y/z/yaw/roll/pitch")
        elif self.type == "joint":
            joints = data.get("joints")
            if not isinstance(joints, list) or any(isinstance(value, bool) or not isinstance(value, (int, float))
                                                    or not math.isfinite(value) for value in joints):
                raise ValueError("joint 必须包含数值数组 joints")
        elif self.type == "status":
            if not isinstance(data.get("state"), str) or not data["state"]:
                raise ValueError("status 必须包含非空字符串 state")
        elif self.type == "ack":
            if not isinstance(data.get("ref"), str) or not data["ref"] or not isinstance(data.get("ok"), bool):
                raise ValueError("ack 必须包含字符串 ref 和布尔值 ok")
        return self


class AlertEnvelope(BaseModel):
    type: Literal["alert", "rules"]
    ts: int
    payload: dict[str, Any]


class CommandRequest(BaseModel):
    twinId: str = Field(min_length=1, max_length=128)
    cmd: str = Field(min_length=1, max_length=64)
