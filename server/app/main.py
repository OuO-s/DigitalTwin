from __future__ import annotations

import asyncio
import logging
import os
import secrets
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

from .adapters import DemoAdapter
from .alert_engine import AlertEngine, load_rules
from .alert_store import AlertStore
from .config import ALERT_DB_PATH, ALERT_RULES_PATH, DB_PATH, ROOT, campus_layout_config, floorplan_config, site_config
from .hub import TwinHub
from .http_adapter import HttpAdapter
from .models import CommandRequest
from .mqtt_adapter import MqttAdapter
from .mqtt_settings import MqttSettings, enabled
from .storage import SQLiteTimeSeriesStore

log = logging.getLogger(__name__)
store = SQLiteTimeSeriesStore(DB_PATH)
hub = TwinHub(store)
alert_store = AlertStore(ALERT_DB_PATH)
alert_engine = AlertEngine(alert_store, load_rules(ALERT_RULES_PATH), hub.broadcast_alert)
hub.alert_engine = alert_engine
mqtt_settings = MqttSettings.from_env()
mqtt_enabled = enabled("TWIN_MQTT_ENABLED")
http_device_token = os.getenv("TWIN_HTTP_DEVICE_TOKEN") or None
http_enabled = http_device_token is not None
mqtt_adapter = MqttAdapter(mqtt_settings) if mqtt_enabled else None
http_adapter = HttpAdapter()
adapter = mqtt_adapter or (None if http_enabled else DemoAdapter())
sim_gateway = None


async def start_realtime_links():
    """外部 Broker 已部署时，按适配器 → 仿真网关的顺序装配。"""
    global sim_gateway
    await http_adapter.connect(hub.publish)
    if adapter:
        await adapter.connect(hub.publish)
    if mqtt_enabled and enabled("TWIN_SIM_GATEWAY"):
        from server.gateway.sim_gateway import SimGateway

        sim_gateway = SimGateway(
            host=mqtt_settings.host, port=mqtt_settings.port,
            username=os.getenv("TWIN_SIM_MQTT_USERNAME") or mqtt_settings.username,
            password=os.getenv("TWIN_SIM_MQTT_PASSWORD") or mqtt_settings.password,
            tls=mqtt_settings.tls, ca_cert=mqtt_settings.ca_cert,
            pose_rate=float(os.getenv("TWIN_SIM_POSE_HZ", "5")),
        )
        sim_gateway.start()
    elif mqtt_enabled:
        log.info("MQTT 已启用；仿真网关未启动，等待外部设备")


@asynccontextmanager
async def lifespan(app: FastAPI):
    alert_engine.start()
    await start_realtime_links()
    yield
    if sim_gateway:
        await asyncio.to_thread(sim_gateway.stop)
    if adapter:
        await adapter.stop()
    await http_adapter.stop()
    await alert_engine.stop()


app = FastAPI(title="智萃空间数字孪生 API", version="0.1.0", lifespan=lifespan)


@app.middleware("http")
async def prevent_stale_frontend(request, call_next):
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.get("/api/v1/health")
async def health():
    return {
        "ok": True,
        "gateway": sim_gateway.stats if sim_gateway else ({"source": "demo", "published": 0} if not mqtt_enabled and not http_enabled else None),
        "mqtt": {"enabled": mqtt_enabled, **(mqtt_adapter.stats if mqtt_adapter else {"connected": False, "received": 0, "dropped": 0, "sent": 0})},
        "http": {"enabled": http_enabled, **http_adapter.stats},
        "hub": {"published": hub.published_count, "twinCount": len(hub.snapshot()), "lastMessageTs": hub.last_published_ts},
        "alerts": alert_engine.state(),
    }


@app.post("/api/v1/ingest", status_code=202)
async def ingest_http(request: Request, x_device_token: str | None = Header(default=None)):
    """供不支持 MQTT 的设备上报；设备令牌与人员指令令牌分开。"""
    global adapter, http_enabled
    if not http_device_token:
        raise HTTPException(status_code=503, detail="HTTP 设备接入未启用；请配置 TWIN_HTTP_DEVICE_TOKEN")
    token = x_device_token or (request.headers.get("Authorization", "")[7:].strip()
                               if request.headers.get("Authorization", "").startswith("Device ") else None)
    if not token or not secrets.compare_digest(token, http_device_token):
        raise HTTPException(status_code=401, detail="设备令牌无效或缺失")
    try:
        raw = await request.json()
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="请求体必须是 JSON") from exc
    if isinstance(adapter, DemoAdapter):
        demo_adapter = adapter
        adapter = None
        await demo_adapter.stop()
    http_enabled = True
    error = await http_adapter.ingest(raw)
    if error:
        raise HTTPException(status_code=400, detail=error)
    return {"ok": True}


@app.get("/api/v1/twins")
async def get_twins():
    return {"twins": hub.snapshot()}


@app.post("/api/v1/command", status_code=202)
async def send_command(body: CommandRequest, authorization: str | None = Header(default=None)):
    """只负责发送；设备执行结果随后经 MQTT ack → WebSocket 返回。"""
    command_token = os.getenv("TWIN_COMMAND_TOKEN")
    if not command_token:
        raise HTTPException(status_code=503, detail="指令接口未启用；请配置 TWIN_COMMAND_TOKEN")
    if not authorization or not secrets.compare_digest(authorization, f"Bearer {command_token}"):
        raise HTTPException(status_code=403, detail="无权下发指令")
    if http_adapter.owns(body.twinId):
        raise HTTPException(status_code=501, detail="该设备经 HTTP 上报；HTTP 下行尚未实现")
    if not mqtt_adapter:
        raise HTTPException(status_code=503, detail="MQTT 未启用")
    command_id = uuid.uuid4().hex[:12]
    result = await mqtt_adapter.send_command(body.twinId, {"cmd": body.cmd, "id": command_id})
    if not result["ok"]:
        raise HTTPException(status_code=503, detail=result["err"])
    log.info("下发指令 %s 至设备 %s（%s）", body.cmd, body.twinId, command_id)
    return {"ok": True, "id": command_id, "via": "MqttAdapter", "topic": result["topic"], "note": "指令已发布；执行回执由设备异步返回"}


@app.get("/api/v1/site")
async def get_site():
    return site_config()


@app.get("/api/v1/campus-layout")
async def get_campus_layout():
    return campus_layout_config()


@app.get("/api/v1/floorplans/{floor_id}")
async def get_floorplan(floor_id: str):
    floor = floorplan_config()
    if floor_id not in ("f07", "building-06-f07"):
        raise HTTPException(status_code=404, detail="floor not found")
    return floor


@app.get("/api/v1/summary")
async def get_summary():
    floor = floorplan_config()
    equipment = floor["equipments"]
    active_alerts = alert_store.active()
    return {
        "source": "demo",
        "siteId": "zhicui-lingang",
        "buildingId": "building-06",
        "floorId": "f07",
        "roomCount": len(floor["rooms"]),
        "equipmentCount": len(equipment),
        "onlineCount": sum(x["status"] == "online" for x in equipment),
        "warningCount": len(active_alerts),
        "occupancy": sum(x.get("occupancy", 0) for x in floor["rooms"]),
        "energyKwh": 18.6,
        "temperature": 23.4,
        "alerts": active_alerts,
    }


@app.get("/api/v1/alerts")
async def get_alerts(active: bool = False, limit: int = Query(100, ge=1, le=1000),
                     twinId: str | None = None, level: str | None = None,
                     since: int | None = None):
    if active:
        alerts = alert_store.active()
        if twinId:
            alerts = [item for item in alerts if item["twinId"] == twinId]
        if level:
            alerts = [item for item in alerts if item["level"] == level]
        return {"alerts": alerts[:limit]}
    return {"active": alert_store.active(),
            "history": alert_store.history(limit, twinId, level, since)}


@app.get("/api/v1/alerts/rules")
async def get_alert_rules():
    return {"rules": alert_engine.rules, "state": alert_engine.state()}


@app.get("/api/v1/alerts/stats")
async def get_alert_stats(since: int | None = None):
    return alert_store.stats(since)


@app.post("/api/v1/alerts/{alert_id}/ack")
async def acknowledge_alert(alert_id: int):
    """确认表示已查看，不改变触发或恢复状态。"""
    alert = alert_store.acknowledge(alert_id, "工作台")
    if alert is None:
        raise HTTPException(status_code=409, detail="告警不存在或已确认")
    await hub.broadcast_alert("acknowledged", alert)
    return {"ok": True, "alert": alert}


@app.get("/api/v1/telemetry/{twin_id}")
async def get_telemetry(twin_id: str, limit: int = 120):
    return {"twinId": twin_id, "items": store.recent(twin_id, limit)}


@app.websocket("/ws/twin")
async def twin_socket(ws: WebSocket):
    await hub.connect(ws)
    try:
        source = "mqtt+http" if mqtt_enabled and http_enabled else "mqtt" if mqtt_enabled else "http" if http_enabled else "demo"
        await hub.send_client(ws, {"type": "connected", "ts": int(time.time() * 1000), "source": source})
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await hub.disconnect(ws)


app.mount("/", StaticFiles(directory=ROOT / "web", html=True), name="web")
