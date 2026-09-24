from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class TwinEvent(BaseModel):
    twinId: str
    type: Literal["pose", "joint", "status", "ack"]
    ts: int
    payload: dict[str, Any]


class AlertEnvelope(BaseModel):
    type: Literal["alert", "rules"]
    ts: int
    payload: dict[str, Any]


class CommandRequest(BaseModel):
    twinId: str
    command: str
    payload: dict[str, Any] = Field(default_factory=dict)

