```python
"""Flask 侧的鉴权装饰器。

**权限判定必须落在服务端**：前端藏起按钮只是体验优化，任何人都能直接调接口。
本模块是唯一的强制点。
"""

from functools import wraps

from flask import jsonify, request


def bearer_token():
    """从 Authorization 头取 Bearer 令牌；兜底支持 ?token= （供无法设头的场景）。"""
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:].strip()
    return request.args.get("token")


def device_token():
    """设备上行令牌：优先 X-Device-Token 头，兼容 Authorization: Device <token>。"""
    tok = request.headers.get("X-Device-Token")
    if tok:
        return tok.strip()
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Device "):
        return auth[7:].strip()
    return None


def make_guard(auth_service):
    """构造 require_role 装饰器。"""

    def require_role(role="viewer"):
        def deco(fn):
            @wraps(fn)
            def wrapper(*args, **kwargs):
                session = auth_service.session(bearer_token())
                if not session:
                    return jsonify({"ok": False, "err": "未认证或会话已过期"}), 401
                if not auth_service.has_role(session, role):
                    return jsonify({
                        "ok": False,
                        "err": f"权限不足：该操作需要「{role}」及以上角色",
                    }), 403
                # 传给视图函数，便于记录操作人
                request.session = session
                return fn(*args, **kwargs)
            return wrapper
        return deco

    return require_role

```

