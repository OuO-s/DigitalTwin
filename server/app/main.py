from __future__ import annotations

import asyncio
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

from .adapters import DemoAdapter
from .config import DB_PATH, ROOT, campus_layout_config, floorplan_config, site_config
from .hub import TwinHub
from .storage import SQLiteTimeSeriesStore

store = SQLiteTimeSeriesStore(DB_PATH)
hub = TwinHub(store)
adapter = DemoAdapter()


@asynccontextmanager
async def lifespan(app: FastAPI):
    await adapter.start(hub.publish)
    yield
    await adapter.stop()


app = FastAPI(title="智萃空间数字孪生 API", version="0.1.0", lifespan=lifespan)


@app.get("/api/v1/health")
async def health():
    return {
        "ok": True,
        "gateway": {"source": "simulation", "messages": hub.published_count, "lastMessageTs": hub.last_published_ts},
        "mqtt": {"connected": False, "messages": 0},
    }


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
    return {
        "source": "demo",
        "siteId": "zhicui-lingang",
        "buildingId": "building-06",
        "floorId": "f07",
        "roomCount": len(floor["rooms"]),
        "equipmentCount": len(equipment),
        "onlineCount": sum(x["status"] == "online" for x in equipment),
        "warningCount": sum(x["status"] == "warning" for x in equipment),
        "occupancy": sum(x.get("occupancy", 0) for x in floor["rooms"]),
        "energyKwh": 18.6,
        "temperature": 23.4,
        "alerts": [
            {"id": "alert-01", "level": "warning", "title": "会议室湿度偏高", "detail": "会议室环境传感器 · 69%RH", "target": "room-704", "targetKind": "room", "time": "刚刚"},
            {"id": "alert-02", "level": "info", "title": "7 楼设备在线", "detail": "模拟数据运行中", "time": "09:41"},
        ],
    }


@app.get("/api/v1/telemetry/{twin_id}")
async def get_telemetry(twin_id: str, limit: int = 120):
    return {"twinId": twin_id, "items": store.recent(twin_id, limit)}


@app.websocket("/ws/twin")
async def twin_socket(ws: WebSocket):
    await hub.connect(ws)
    try:
        await ws.send_json({"type": "connected", "ts": int(time.time() * 1000), "source": "demo"})
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        await hub.disconnect(ws)


app.mount("/", StaticFiles(directory=ROOT / "web", html=True), name="web")
