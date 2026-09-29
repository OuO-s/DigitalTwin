```python
"""用户与会话的持久化（SQLite）。

与业务数据分开一个库文件：认证数据的访问模式、备份策略、保留要求都与
时序数据不同，混在一起以后不好处理。

## 连 `self._lock` 保护**每一次**访问，包括读

一个连接被多个线程共用（Flask 是多线程的，WebSocket 服务还另有一个线程）。
只给写加锁是不够的：**同一条 SQL 的预编译语句是跟着连接走的**，
两个线程同时执行它就会互相踩坏对方的游标，`fetchone()` 于是返回 None。
读会话时这意味着**一个有效令牌被判成「会话不存在」→ 401**，
而前端一见 401 就清会话——表现为「用着用着突然被登出」。

只读、完全不写、12 个线程并发查询的实测：191646 次里 191506 次误判为无效。
"""

import hashlib
import hmac
import logging
import os
import secrets
import sqlite3
import threading
import time

log = logging.getLogger(__name__)

# OWASP 对 PBKDF2-HMAC-SHA256 的建议量级；Python 的 pbkdf2_hmac 走 OpenSSL，
# 60 万次在本机约 0.2s，登录时可接受。
PBKDF2_ITERATIONS = 600_000

ROLES = ("viewer", "operator", "admin")
ROLE_LEVEL = {"viewer": 1, "operator": 2, "admin": 3}

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    username      TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    must_change   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    username   TEXT NOT NULL,
    role       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions (expires_at);
CREATE TABLE IF NOT EXISTS device_tokens (
    token_hash TEXT PRIMARY KEY,
    label      TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
"""


# ---- 口令 ----
def hash_password(password, iterations=PBKDF2_ITERATIONS):
    """返回自带盐与迭代次数的编码串，便于日后调参而不影响旧口令校验。"""
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return f"pbkdf2_sha256${iterations}${salt.hex()}${dk.hex()}"


def verify_password(password, encoded):
    """恒定时间比较，避免通过响应时间旁路猜测口令。"""
    try:
        algo, iters, salt_hex, hash_hex = encoded.split("$")
        if algo != "pbkdf2_sha256":
            return False
        dk = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), int(iters))
        return hmac.compare_digest(dk.hex(), hash_hex)
    except (AttributeError, TypeError, ValueError):
        return False


def new_session_token():
    """返回 (明文令牌, 令牌哈希)。明文只在响应里给一次，库里只存哈希。"""
    raw = secrets.token_urlsafe(32)
    return raw, hashlib.sha256(raw.encode("utf-8")).hexdigest()


def token_hash(raw):
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


class AuthStore:
    def __init__(self, path="data/auth.db", session_ttl=12 * 3600):
        self.path = path
        self.session_ttl = session_ttl
        os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.executescript(SCHEMA)
        self._db.commit()
        self._lock = threading.Lock()

    # ---- 用户 ----
    def create_user(self, username, password, role="viewer", must_change=False):
        if role not in ROLES:
            raise ValueError(f"未知角色：{role}")
        with self._lock:
            self._db.execute(
                "INSERT INTO users (username, password_hash, role, created_at, must_change)"
                " VALUES (?, ?, ?, ?, ?)",
                (username, hash_password(password), role, int(time.time() * 1000),
                 1 if must_change else 0))
            self._db.commit()

    def user(self, username):
        with self._lock:
            row = self._db.execute(
                "SELECT username, password_hash, role, must_change FROM users WHERE username = ?",
                (username,)).fetchone()
        if not row:
            return None
        return {"username": row[0], "password_hash": row[1], "role": row[2],
                "mustChange": bool(row[3])}

    def users(self):
        with self._lock:
            rows = self._db.execute(
                "SELECT username, role, created_at FROM users ORDER BY created_at").fetchall()
        return [{"username": r[0], "role": r[1], "createdAt": r[2]} for r in rows]

    def set_password(self, username, password, must_change=False):
        with self._lock:
            cur = self._db.execute(
                "UPDATE users SET password_hash = ?, must_change = ? WHERE username = ?",
                (hash_password(password), 1 if must_change else 0, username))
            self._db.commit()
            return cur.rowcount > 0

    def set_role(self, username, role):
        if role not in ROLES:
            raise ValueError(f"未知角色：{role}")
        with self._lock:
            cur = self._db.execute(
                "UPDATE users SET role = ? WHERE username = ?", (role, username))
            self._db.commit()
            return cur.rowcount > 0

    def delete_user(self, username):
        with self._lock:
            self._db.execute("DELETE FROM sessions WHERE username = ?", (username,))
            cur = self._db.execute("DELETE FROM users WHERE username = ?", (username,))
            self._db.commit()
            return cur.rowcount > 0

    def count_admins(self):
        with self._lock:
            return self._db.execute(
                "SELECT COUNT(*) FROM users WHERE role = 'admin'").fetchone()[0]

    # ---- 会话 ----
    def create_session(self, username, role, ttl=None):
        raw, h = new_session_token()
        now = int(time.time() * 1000)
        expires = now + int((ttl or self.session_ttl) * 1000)
        with self._lock:
            self._db.execute(
                "INSERT INTO sessions (token_hash, username, role, created_at, expires_at)"
                " VALUES (?, ?, ?, ?, ?)", (h, username, role, now, expires))
            self._db.commit()
        return raw, expires

    def session(self, raw_token):
        """按令牌查会话；顺手清掉过期的。返回 None 表示无效。"""
        if not raw_token:
            return None
        now = int(time.time() * 1000)
        with self._lock:
            row = self._db.execute(
                "SELECT username, role, expires_at FROM sessions WHERE token_hash = ?",
                (token_hash(raw_token),)).fetchone()
            if not row:
                return None
            if row[2] <= now:
                self._db.execute("DELETE FROM sessions WHERE token_hash = ?",
                                 (token_hash(raw_token),))
                self._db.commit()
                return None
        return {"username": row[0], "role": row[1], "expiresAt": row[2]}

    def drop_session(self, raw_token):
        with self._lock:
            self._db.execute("DELETE FROM sessions WHERE token_hash = ?",
                             (token_hash(raw_token),))
            self._db.commit()

    def drop_user_sessions(self, username):
        with self._lock:
            self._db.execute("DELETE FROM sessions WHERE username = ?", (username,))
            self._db.commit()

    # ---- 设备令牌（设备上行鉴权，对应方案 7.3 的「HTTP Token」） ----
    def create_device_token(self, label):
        raw, h = new_session_token()
        with self._lock:
            self._db.execute(
                "INSERT INTO device_tokens (token_hash, label, created_at) VALUES (?, ?, ?)",
                (h, label, int(time.time() * 1000)))
            self._db.commit()
        return raw

    def verify_device_token(self, raw_token):
        if not raw_token:
            return False
        with self._lock:
            row = self._db.execute("SELECT 1 FROM device_tokens WHERE token_hash = ?",
                                   (token_hash(raw_token),)).fetchone()
        return row is not None

    def device_tokens(self):
        with self._lock:
            rows = self._db.execute(
                "SELECT label, created_at FROM device_tokens ORDER BY created_at").fetchall()
        return [{"label": r[0], "createdAt": r[1]} for r in rows]

    def revoke_device_token(self, label):
        with self._lock:
            cur = self._db.execute("DELETE FROM device_tokens WHERE label = ?", (label,))
            self._db.commit()
            return cur.rowcount > 0

    def purge_expired(self):
        now = int(time.time() * 1000)
        with self._lock:
            cur = self._db.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))
            self._db.commit()
            return cur.rowcount

    def close(self):
        try:
            self._db.close()
        except Exception:
            pass

```

