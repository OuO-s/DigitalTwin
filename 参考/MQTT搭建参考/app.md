```python
"""后端入口：Flask（REST + 静态托管）+ WebSocket + Mock 适配器。

启动方式：
    pip install -r requirements.txt
    python app.py

然后浏览器打开 http://localhost:8000 即可看到 Mock 数据经
WS → 前端占位渲染 的完整链路。
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
import uuid

from flask import Flask, jsonify, request, send_from_directory

# 控制台编码可能表示不了 ⚠/✓ 这类符号（Windows 默认 GBK），
# 不加这层的话**一句日志就能让服务起不来** —— 启动路径上一句 print 抛异常，
# app.run() 根本执行不到。日志失败绝不应该拖垮服务。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors="replace")
    except (AttributeError, ValueError):
        pass

from adapters.http_adapter import HttpAdapter
from adapters.mqtt_adapter import MqttAdapter
from auth.guard import bearer_token, device_token, make_guard
from auth.service import AuthService, bootstrap_admin
from auth.store import AuthStore
from hub import Hub
from ws_server import WsServer

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.normpath(os.path.join(BASE_DIR, "..", "frontend"))

# HTTP（本服务，同时托管前端）与 WebSocket 端口；前端 Config.js 的 wsUrl 跟 TWIN_WS_PORT 对应
HTTP_PORT = int(os.environ.get("TWIN_HTTP_PORT", "8000"))
WS_PORT = int(os.environ.get("TWIN_WS_PORT", "8765"))

app = Flask(__name__)

# 鉴权（M2）：用户与会话独立库，权限判定全在服务端
auth_store = AuthStore(path=os.path.join(BASE_DIR, "data", "auth.db"))
auth_service = AuthService(auth_store)
require_role = make_guard(auth_service)

# 时序存储（R9）：不可用时降级为「仅实时」，不影响主链路
store = None
try:
    from storage.sqlite_store import SqliteStore
    store = SqliteStore(path=os.path.join(BASE_DIR, "data", "history.db"))
except Exception as exc:  # noqa: BLE001
    print(f"[app] 时序存储不可用，历史回放将不可用：{exc}")

hub = Hub(store=store)
http_adapter = HttpAdapter(hub)
ws_server = WsServer(hub, port=WS_PORT, auth_service=auth_service)

# ---- 告警引擎（M3）：挂在 Hub 的入站钩子上 ----
from alerts.engine import AlertEngine, load_rules  # noqa: E402
from alerts.store import AlertStore  # noqa: E402

alert_store = AlertStore(path=os.path.join(BASE_DIR, "data", "alerts.db"))
alert_engine = AlertEngine(
    hub, alert_store,
    load_rules(os.path.join(BASE_DIR, "alerts", "rules.json")),
    # 触发/恢复都实时推给前端，不必等轮询
    on_event=lambda action, alert: hub.broadcast_alert(action, alert),
)
hub.on_ingest = alert_engine.evaluate_message

# ---- 多人协同（R10）：共享放置规则表 + 操作日志 ----
# 规则放服务端才能协同：放浏览器 localStorage 里的话「A 改规则、B 立刻看到」不成立。
from collab.store import CollabStore  # noqa: E402


def _load_seed_rules():
    path = os.path.join(FRONTEND_DIR, "assets", "rules", "office-rules.json")
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError) as exc:
        print(f"[app] 默认规则表载入失败（{path}）：{exc}")
        return {}


collab_store = CollabStore(path=os.path.join(BASE_DIR, "data", "collab.db"),
                           seed_rules=_load_seed_rules())

# ---- 实时设备链路：MQTT Broker + 适配器 + 仿真网关 ----
# 方案要求仿真网关「用与真实设备完全相同的协议」模拟，所以数据源**必须经 MQTT**，
# 而不是直接往 Hub 里塞——否则适配器、主题约定、报文解析一次都没被验证过。
MQTT_HOST = os.environ.get("TWIN_MQTT_HOST", "127.0.0.1")
MQTT_PORT = int(os.environ.get("TWIN_MQTT_PORT", "1883"))
USE_EMBEDDED_BROKER = os.environ.get("TWIN_MQTT_EMBEDDED", "1") != "0"

embedded_broker = None
mqtt_adapter = MqttAdapter(hub, host=MQTT_HOST, port=MQTT_PORT)
sim_gateway = None


def start_realtime_links():
    """按顺序拉起 Broker → 适配器 → 仿真网关。返回是否成功。"""
    global embedded_broker, sim_gateway

    if USE_EMBEDDED_BROKER:
        from bus.embedded_broker import EmbeddedBroker
        embedded_broker = EmbeddedBroker(MQTT_HOST, MQTT_PORT)
        if embedded_broker.start():
            print(f"[app] 内嵌 MQTT Broker：{MQTT_HOST}:{MQTT_PORT}")
        else:
            print("[app] 内嵌 Broker 未就绪，将直接连已有 Broker")

    ok = mqtt_adapter.connect({"host": MQTT_HOST, "port": MQTT_PORT})
    if not ok:
        print("[app] [!] MQTT 适配器未连上 —— 实时设备链路不可用。"
              "请确认 Broker 可用，或用 TWIN_MQTT_HOST/PORT 指定。")
        return False

    from gateway.sim_gateway import SimGateway
    sim_gateway = SimGateway(host=MQTT_HOST, port=MQTT_PORT)
    if not sim_gateway.start():
        print("[app] [!] 仿真网关未启动")
        return False

    print("[app] 仿真网关已启动：设备数据经 MQTT 发布（robot-001 / ac-001 / "
          "printer-001 / water-001），指令经 MQTT 下发")
    return True


def _print_bootstrap():
    """首次启动打印随机管理员口令与设备令牌（不写死默认口令）。"""
    admin = bootstrap_admin(auth_store)
    if admin:
        print("\n" + "=" * 62)
        print("  首次启动：已创建管理员账号（口令随机生成，仅显示这一次）")
        print(f"    用户名：{admin['username']}")
        print(f"    密　码：{admin['password']}")
        print("  请登录后立即修改；也可用环境变量 TWIN_ADMIN_PASSWORD 预设。")
        print("=" * 62)

    if not auth_store.device_tokens():
        token = auth_store.create_device_token("default")
        print("  设备上行令牌（设备调用 /api/v1/ingest 用，仅显示这一次）：")
        print(f"    {token}")
        print("=" * 62 + "\n")


# ---- REST：健康检查 ----
@app.route("/api/v1/health")
def health():
    return jsonify({
        "ok": True,
        "twinCount": len(hub.snapshot()),
        "mqtt": {
            "connected": mqtt_adapter.is_connected,
            "broker": f"{MQTT_HOST}:{MQTT_PORT}",
            "embeddedBroker": embedded_broker is not None,
            **mqtt_adapter.stats,
        },
        "gateway": sim_gateway.stats if sim_gateway else None,
    })


# ---- REST：HTTP 适配器上行（真实设备经此注入） ----
@app.route("/api/v1/ingest", methods=["POST"])
def ingest():
    # 设备上行用「设备令牌」鉴权（方案 7.3 的 HTTP Token），与用户会话分开——
    # 设备不该拿到人的账号，人的会话也不该被设备复用
    if not auth_store.verify_device_token(device_token()):
        return jsonify({"ok": False, "err": "设备令牌无效或缺失（需 X-Device-Token 头）"}), 401
    msg = request.get_json(force=True)
    err = http_adapter.ingest(msg)
    if err:
        return jsonify({"ok": False, "err": err}), 400
    return jsonify({"ok": True}), 202


# ---- REST：查询当前所有孪生对象状态 ----
@app.route("/api/v1/twins")
@require_role("viewer")
def twins():
    return jsonify({"twins": hub.snapshot()})


# ---- REST：指令下发（R6 双向映射） ----
# 走真实协议路径：发布到 twin/{id}/command，由设备侧执行并回 twin/{id}/ack。
# **回执是异步的**（设备处理需要时间，且现场设备可能不在线），所以本接口只保证
# 「指令已发出」，回执经 MQTT → 适配器 → Hub → WebSocket 推给前端。
COMMAND_ADAPTERS = [mqtt_adapter]


@app.route("/api/v1/command", methods=["POST"])
@require_role("operator")
def command():
    body = request.get_json(force=True, silent=True) or {}
    twin_id = (body.get("twinId") or "").strip()
    cmd = body.get("cmd")
    if not twin_id or not cmd:
        return jsonify({"ok": False, "err": "缺少 twinId 或 cmd"}), 400

    cmd_id = uuid.uuid4().hex[:8]
    for adapter in COMMAND_ADAPTERS:
        if not adapter.handles(twin_id):
            continue
        result = adapter.send_command(twin_id, {"cmd": cmd, "id": cmd_id})
        status = 200 if result.get("ok") else 503
        return jsonify({
            "ok": bool(result.get("ok")),
            "id": cmd_id,
            "via": type(adapter).__name__,
            "detail": result,
            "note": "指令已发出；执行回执经 WebSocket 推送",
        }), status

    return jsonify({"ok": False, "err": f"没有适配器负责设备 {twin_id}"}), 503


# ---- REST：鉴权（M2） ----
@app.route("/api/v1/auth/login", methods=["POST"])
def auth_login():
    body = request.get_json(force=True, silent=True) or {}
    result = auth_service.login(
        (body.get("username") or "").strip(),
        body.get("password") or "",
        client_key=request.remote_addr or "",
    )
    if result.get("ok"):
        collab_store.log(result["user"]["username"], "auth.login")
    return jsonify(result), (200 if result.get("ok") else 401)


@app.route("/api/v1/auth/logout", methods=["POST"])
def auth_logout():
    auth_service.logout(bearer_token())
    return jsonify({"ok": True})


@app.route("/api/v1/auth/me")
@require_role("viewer")
def auth_me():
    return jsonify({"ok": True, "user": request.session})


@app.route("/api/v1/auth/change-password", methods=["POST"])
@require_role("viewer")
def auth_change_password():
    body = request.get_json(force=True, silent=True) or {}
    result = auth_service.change_password(
        request.session["username"],
        body.get("oldPassword") or "",
        body.get("newPassword") or "",
    )
    return jsonify(result), (200 if result.get("ok") else 400)


@app.route("/api/v1/auth/users", methods=["GET", "POST"])
@require_role("admin")
def auth_users():
    if request.method == "GET":
        return jsonify({"ok": True, "users": auth_store.users()})

    body = request.get_json(force=True, silent=True) or {}
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""
    role = body.get("role") or "viewer"
    if not username:
        return jsonify({"ok": False, "err": "用户名不能为空"}), 400
    if len(password) < 8:
        return jsonify({"ok": False, "err": "密码至少 8 位"}), 400
    if auth_store.user(username):
        return jsonify({"ok": False, "err": "用户已存在"}), 409
    try:
        auth_store.create_user(username, password, role=role)
    except ValueError as exc:
        return jsonify({"ok": False, "err": str(exc)}), 400
    return jsonify({"ok": True, "username": username, "role": role}), 201


@app.route("/api/v1/auth/users/<username>", methods=["DELETE"])
@require_role("admin")
def auth_delete_user(username):
    # 不允许删掉最后一个管理员，否则谁也进不来了
    if username == request.session["username"]:
        return jsonify({"ok": False, "err": "不能删除当前登录的账号"}), 400
    target = auth_store.user(username)
    if target and target["role"] == "admin" and auth_store.count_admins() <= 1:
        return jsonify({"ok": False, "err": "至少需保留一个管理员"}), 400
    return jsonify({"ok": auth_store.delete_user(username)})


@app.route("/api/v1/auth/device-tokens", methods=["GET", "POST"])
@require_role("admin")
def auth_device_tokens():
    if request.method == "GET":
        return jsonify({"ok": True, "tokens": auth_store.device_tokens()})

    body = request.get_json(force=True, silent=True) or {}
    label = (body.get("label") or "").strip()
    if not label:
        return jsonify({"ok": False, "err": "缺少 label"}), 400
    raw = auth_store.create_device_token(label)
    # 明文令牌只在这里返回一次，库里只存哈希
    return jsonify({"ok": True, "label": label, "token": raw}), 201


@app.route("/api/v1/auth/device-tokens/<label>", methods=["DELETE"])
@require_role("admin")
def auth_revoke_device_token(label):
    return jsonify({"ok": auth_store.revoke_device_token(label)})


# ---- REST：glTF 优化（M2「模型转换服务」的落地形态） ----
# 方案原意是「用 Blender/Assimp 转换我们加载不了的格式」，但实测这两者都导入不了
# 客户最常用的 .max/.skp/.dwg（私有格式无开放实现），装 500MB 依赖换不来格式覆盖。
# 真正痛的是 **ARM 上的大模型加载**，所以改做服务端优化：
# Draco 几何压缩能把体积压到约 1/10（实测 725KB → 75KB）。
CONVERT_DIR = os.path.join(BASE_DIR, "convert")
MAX_CONVERT_BYTES = 64 * 1024 * 1024
CONVERT_TIMEOUT = 120


def _find_node():
    """定位 node 可执行文件；Windows 上常不在 PATH 里。"""
    found = shutil.which("node") or shutil.which("node.exe")
    if found:
        return found
    for cand in (
        r"C:\Program Files\nodejs\node.exe",
        r"C:\Program Files (x86)\nodejs\node.exe",
        "/usr/bin/node",
        "/usr/local/bin/node",
    ):
        if os.path.exists(cand):
            return cand
    return None


@app.route("/api/v1/convert/gltf", methods=["POST"])
@require_role("operator")
def convert_gltf():
    """对上传的 GLB 做服务端优化，返回优化后的文件与报告。

    请求体直接是 GLB 字节（避免 multipart 再包一层）；
    报告放在 X-Convert-Report 响应头里（URL 编码，保证 ASCII 安全），
    这样二进制负载不用为了塞进 JSON 而做 base64 膨胀。
    """
    node = _find_node()
    if not node:
        return jsonify({
            "ok": False,
            "err": "服务端未安装 Node.js，模型优化不可用（该功能依赖 gltf-transform）",
        }), 503

    script = os.path.join(CONVERT_DIR, "optimize.mjs")
    if not os.path.exists(script):
        return jsonify({"ok": False, "err": "服务端缺少转换脚本"}), 503

    level = request.args.get("level", "standard")
    if level not in ("light", "standard", "aggressive"):
        return jsonify({"ok": False, "err": f"未知优化级别「{level}」"}), 400

    data = request.get_data()
    if not data:
        return jsonify({"ok": False, "err": "请求体为空"}), 400
    if len(data) > MAX_CONVERT_BYTES:
        return jsonify({
            "ok": False,
            "err": f"文件过大（{len(data) / 1048576:.1f} MB），上限 {MAX_CONVERT_BYTES // 1048576} MB",
        }), 413
    # glTF 是二进制容器，靠魔数判断比靠扩展名可靠
    if not data.startswith(b"glTF"):
        return jsonify({"ok": False, "err": "只支持 .glb（glTF 二进制）；.gltf 请先转为 .glb"}), 400

    with tempfile.TemporaryDirectory(prefix="twin-convert-") as tmp:
        in_path = os.path.join(tmp, "in.glb")
        out_path = os.path.join(tmp, "out.glb")
        with open(in_path, "wb") as fh:
            fh.write(data)

        try:
            proc = subprocess.run(
                [node, script, in_path, out_path, "--level", level],
                capture_output=True, timeout=CONVERT_TIMEOUT, cwd=CONVERT_DIR,
            )
        except subprocess.TimeoutExpired:
            return jsonify({"ok": False, "err": f"优化超时（>{CONVERT_TIMEOUT}s）"}), 504

        stdout = proc.stdout.decode("utf-8", "replace").strip()
        report_line = stdout.splitlines()[-1] if stdout else ""
        try:
            report = json.loads(report_line)
        except ValueError:
            detail = proc.stderr.decode("utf-8", "replace")[-400:]
            return jsonify({"ok": False, "err": f"优化器输出异常：{detail or '无输出'}"}), 500

        if not report.get("ok"):
            return jsonify(report), 422
        if not os.path.exists(out_path):
            return jsonify({"ok": False, "err": "优化器未产出文件"}), 500

        with open(out_path, "rb") as fh:
            optimized = fh.read()

    resp = app.make_response(optimized)
    resp.headers["Content-Type"] = "model/gltf-binary"
    resp.headers["X-Convert-Report"] = urllib.parse.quote(json.dumps(report, ensure_ascii=False))
    return resp


# ---- REST：多人协同（R10） ----
@app.route("/api/v1/rules")
@require_role("viewer")
def rules_get():
    """取共享放置规则表（含版本号，保存时要回传）。"""
    return jsonify(collab_store.get())


@app.route("/api/v1/rules", methods=["PUT"])
@require_role("operator")
def rules_put():
    """保存规则（乐观锁）。

    版本不匹配说明期间有人改过，返回 **409** 并带上最新内容——
    让前端提示「已被他人修改，请刷新」，而不是悄悄覆盖掉别人的改动。
    """
    body = request.get_json(force=True, silent=True) or {}
    rules = body.get("rules")
    if not isinstance(rules, dict):
        return jsonify({"ok": False, "err": "缺少 rules"}), 400

    user = request.session["username"]
    result = collab_store.save(rules, body.get("version"), user)
    if not result.get("ok"):
        return jsonify(result), 409

    collab_store.log(user, "rules.update", f"版本 {result['version']}")
    # 推给所有客户端，别人那边立刻跟着更新
    hub.broadcast_event("rules", {"version": result["version"], "updatedBy": user})
    return jsonify(result)


@app.route("/api/v1/presence")
@require_role("viewer")
def presence():
    return jsonify({"users": hub.presence()})


@app.route("/api/v1/activity")
@require_role("viewer")
def activity():
    """操作日志 + 当前在线用户。"""
    return jsonify({
        "activity": collab_store.recent_activity(min(_int_arg("limit", 50), 500)),
        "presence": hub.presence(),
    })


# ---- REST：告警与报表（M3） ----
@app.route("/api/v1/alerts")
@require_role("viewer")
def alerts_list():
    """告警列表。默认返回历史（含已恢复），?active=1 只返回未恢复的。"""
    if request.args.get("active") == "1":
        return jsonify({"alerts": alert_store.active()})
    return jsonify({
        "active": alert_store.active(),
        "history": alert_store.history(
            limit=min(_int_arg("limit", 100), 1000),
            twin_id=request.args.get("twinId"),
            level=request.args.get("level"),
        ),
    })


@app.route("/api/v1/alerts/rules")
@require_role("viewer")
def alerts_rules():
    return jsonify({"rules": alert_engine.rules, "state": alert_engine.state()})


@app.route("/api/v1/alerts/stats")
@require_role("viewer")
def alerts_stats():
    """报表聚合：按级别 / 设备 / 规则统计，并给出平均恢复时长。"""
    since = _int_arg("since", 0)
    return jsonify(alert_store.stats(since=since or None))


@app.route("/api/v1/alerts/<int:alert_id>/ack", methods=["POST"])
@require_role("operator")
def alerts_ack(alert_id):
    """确认告警。确认只表示「人已看到」，不改变触发/恢复状态。"""
    ok = alert_store.acknowledge(alert_id, request.session["username"])
    if not ok:
        return jsonify({"ok": False, "err": "告警不存在或已确认过"}), 409
    return jsonify({"ok": True, "id": alert_id, "by": request.session["username"]})


# ---- REST：历史数据与回放（R9） ----
def _no_store():
    return jsonify({"ok": False, "err": "时序存储不可用（服务端未启用历史记录）"}), 503


def _int_arg(name, default):
    try:
        return int(request.args.get(name, default))
    except (TypeError, ValueError):
        return default


@app.route("/api/v1/history/twins")
@require_role("viewer")
def history_twins():
    """各孪生对象的历史概览：条数与时间范围。"""
    if store is None:
        return _no_store()
    return jsonify({"twins": store.twins(), "range": store.range()})


@app.route("/api/v1/history/series")
@require_role("viewer")
def history_series():
    """单个孪生对象的时间序列（已降采样）。"""
    if store is None:
        return _no_store()
    twin_id = request.args.get("twinId", "")
    if not twin_id:
        return jsonify({"ok": False, "err": "缺少参数 twinId"}), 400
    rng = store.range()
    now = rng["lastTs"] or _now_ms()
    # 默认区间收敛到实际有数据的范围：否则「最近 10 分钟」会把只有 17 秒的数据
    # 全压进 1~2 个降采样桶里，返回寥寥几个点，看起来像降采样坏了
    start = _int_arg("from", max(rng["firstTs"] or 0, now - 10 * 60 * 1000))
    end = _int_arg("to", now)
    max_points = min(_int_arg("maxPoints", 2000), 20000)
    return jsonify({
        "twinId": twin_id, "from": start, "to": end,
        "points": store.series(twin_id, start, end, max_points),
    })


@app.route("/api/v1/history/replay")
@require_role("viewer")
def history_replay():
    """回放数据：区间内所有孪生的时间序列，供前端拖动时间轴重现。"""
    if store is None:
        return _no_store()
    rng = store.range()
    if not rng["lastTs"]:
        return jsonify({"from": 0, "to": 0, "series": {}, "range": rng})
    start = _int_arg("from", max(rng["firstTs"] or 0, rng["lastTs"] - 10 * 60 * 1000))
    end = _int_arg("to", rng["lastTs"])
    max_points = min(_int_arg("maxPoints", 1500), 20000)
    series = store.replay(start, end, max_points)
    return jsonify({
        "from": start, "to": end, "series": series,
        "range": rng,
        "counts": {k: len(v) for k, v in series.items()},
    })


@app.route("/api/v1/history/stats")
@require_role("viewer")
def history_stats():
    if store is None:
        return _no_store()
    return jsonify({"ok": True, "range": store.range(), **(store.stats() or {})})


def _now_ms():
    import time as _t
    return int(_t.time() * 1000)


# ---- 静态托管前端 ----
@app.route("/")
def index():
    return send_from_directory(FRONTEND_DIR, "index.html")


@app.route("/<path:path>")
def static_files(path):
    return send_from_directory(FRONTEND_DIR, path)


if __name__ == "__main__":
    import atexit

    if store:
        atexit.register(store.close)  # 退出前把缓冲落盘
        print(f"[app] 时序存储：{store.path}（回放接口 /api/v1/history/replay）")

    _print_bootstrap()

    # 先启动实时链路（Broker → MQTT 适配器 → 仿真网关），再开 WS 与 Web 服务
    start_realtime_links()
    alert_engine.start()

    ws_server.start()
    print(f"[app] 前端入口：http://localhost:{HTTP_PORT}")
    app.run(host="0.0.0.0", port=HTTP_PORT, threaded=True)

```

