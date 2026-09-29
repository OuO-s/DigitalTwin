```python
"""认证服务：登录、令牌校验、登录限流、管理员初始化。

设计要点：
  · **不在代码里写死默认口令**。首次启动生成随机口令并打印到控制台，
    否则「admin/admin」会跟着产品一路进客户现场。
  · 会话令牌只在库里存哈希，与口令同等对待——库泄露也不应能直接冒用会话。
  · 登录失败按「用户名 + 来源 IP」限流，防暴力破解。
  · 角色判定放在服务端，前端隐藏按钮只是体验，不是安全边界。
"""

import logging
import os
import secrets
import threading
import time

from auth.store import ROLE_LEVEL, AuthStore, verify_password

log = logging.getLogger(__name__)


class LoginThrottle:
    """登录失败限流：同一用户名/IP 连续失败达阈值后短时封禁。"""

    def __init__(self, max_attempts=5, window=300, lockout=300):
        self.max_attempts = max_attempts
        self.window = window
        self.lockout = lockout
        self._hits = {}  # key -> [失败时间戳]
        self._lock = threading.Lock()

    def retry_after(self, key):
        """若处于封禁中，返回剩余秒数；否则返回 0。"""
        now = time.time()
        with self._lock:
            hits = [t for t in self._hits.get(key, []) if now - t < self.window]
            self._hits[key] = hits
            if len(hits) < self.max_attempts:
                return 0
            return max(1, int(self.lockout - (now - hits[-1])))

    def fail(self, key):
        with self._lock:
            self._hits.setdefault(key, []).append(time.time())

    def success(self, key):
        with self._lock:
            self._hits.pop(key, None)


class AuthService:
    def __init__(self, store: AuthStore):
        self.store = store
        self.throttle = LoginThrottle()

    # ---- 登录 ----
    def login(self, username, password, client_key=""):
        key = f"{username}|{client_key}"
        wait = self.throttle.retry_after(key)
        if wait:
            return {"ok": False, "error": f"失败次数过多，请 {wait} 秒后重试", "retryAfter": wait}

        user = self.store.user(username)
        # 用户不存在时也要走一次哈希运算，避免通过响应时间判断用户名是否存在
        stored = user["password_hash"] if user else \
            "pbkdf2_sha256$600000$" + "00" * 16 + "$" + "00" * 32
        ok = verify_password(password, stored) and user is not None

        if not ok:
            self.throttle.fail(key)
            log.warning("登录失败：%s（来源 %s）", username, client_key or "未知")
            return {"ok": False, "error": "用户名或密码错误"}

        self.throttle.success(key)
        token, expires = self.store.create_session(user["username"], user["role"])
        return {
            "ok": True,
            "token": token,
            "expiresAt": expires,
            "user": {"username": user["username"], "role": user["role"],
                     "mustChangePassword": user["mustChange"]},
        }

    def logout(self, token):
        self.store.drop_session(token)

    # ---- 校验 ----
    def session(self, token):
        return self.store.session(token)

    @staticmethod
    def has_role(session, role):
        """角色分级：admin > operator > viewer。"""
        if not session:
            return False
        return ROLE_LEVEL.get(session.get("role"), 0) >= ROLE_LEVEL.get(role, 99)

    # ---- 改密 ----
    def change_password(self, username, old_password, new_password):
        user = self.store.user(username)
        if not user or not verify_password(old_password, user["password_hash"]):
            return {"ok": False, "error": "原密码错误"}
        if len(new_password) < 8:
            return {"ok": False, "error": "新密码至少 8 位"}
        self.store.set_password(username, new_password, must_change=False)
        self.store.drop_user_sessions(username)  # 改密后旧会话全部失效
        return {"ok": True}


def bootstrap_admin(store: AuthStore):
    """首次启动创建管理员。**不写死默认口令**，而是生成随机口令并提示。"""
    if store.users():
        return None

    env_password = os.environ.get("TWIN_ADMIN_PASSWORD")
    generated = not env_password
    password = env_password or secrets.token_urlsafe(12)
    store.create_user("admin", password, role="admin", must_change=generated)
    return {"username": "admin", "password": password, "generated": generated}

```

