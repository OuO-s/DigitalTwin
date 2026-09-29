"""告警引擎关键行为的确定性校验：python tools/check_alerts.py。"""

from __future__ import annotations

import asyncio
import sys
import tempfile
import time
from contextlib import closing
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from server.app.alert_engine import AlertEngine  # noqa: E402
from server.app.alert_store import AlertStore  # noqa: E402


async def check() -> None:
    rules = [
        {"id": "humidity", "name": "湿度高", "twinId": "sensor-1", "field": "humidity",
         "op": "gt", "threshold": 68, "for": 0.02, "level": "warning", "message": "湿度 {value}"},
        {"id": "offline", "name": "设备离线", "twinId": "*", "field": "@offline",
         "threshold": 0.04, "for": 0, "level": "critical", "message": "离线 {value}"},
    ]
    events = []

    async def on_event(action, alert):
        events.append((action, alert["id"]))

    def message(value):
        return {"twinId": "sensor-1", "type": "status", "ts": int(time.time() * 1000),
                "payload": {"humidity": value}}

    with tempfile.TemporaryDirectory() as directory, closing(AlertStore(Path(directory) / "alerts.sqlite3")) as store:
        engine = AlertEngine(store, rules, on_event, scan_interval=60)
        engine.start()
        await engine.evaluate_message(message(69))
        assert store.active() == [], "防抖期间不应立即触发"
        await asyncio.sleep(0.06)
        await engine.evaluate_message(message(70))
        assert len(store.active()) == 1, "持续越界应触发"
        await engine.evaluate_message(message(71))
        assert len(store.history()) == 1, "同一规则和设备不应重复触发"
        raised = store.active()[0]
        acknowledged = store.acknowledge(raised["id"], "操作员")
        assert acknowledged["acknowledged"] and acknowledged["active"], "确认不能恢复告警"
        assert store.acknowledge(raised["id"], "操作员") is None, "不能重复确认"
        await engine.evaluate_message(message(60))
        assert store.active() == [] and store.history()[0]["resolvedAt"], "回到阈值内应自动恢复"

        await engine.evaluate_message(message(69))
        await asyncio.sleep(0.08)
        await engine.evaluate_offline()
        assert {item["ruleId"] for item in store.active()} == {"offline"}, "静默应触发离线告警"
        await engine.evaluate_message(message(60))
        assert store.active() == [], "恢复上报应恢复离线告警"

        await engine.evaluate_message(message(70))
        await asyncio.sleep(0.06)
        await engine.evaluate_message(message(70))
        assert len(store.active()) == 1, f"新的越界周期应产生新告警：{store.active()}"
        await engine.stop()
        restored = AlertEngine(store, rules, on_event, scan_interval=60)
        restored.start()
        await restored.evaluate_message(message(70))
        assert len(store.active()) == 1, "重启后不能重复产生已有活动告警"
        await restored.evaluate_message(message(60))
        assert store.active() == [], "重启后应能恢复原活动告警"
        assert store.stats()["total"] == 3, "统计应覆盖三次触发"
        assert any(action == "fired" for action, _ in events)
        assert any(action == "resolved" for action, _ in events)
        await restored.stop()
    print("告警引擎校验通过：防抖、去重、确认、恢复、离线、重启与统计")


if __name__ == "__main__":
    asyncio.run(check())
