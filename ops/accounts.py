# encoding: utf-8
"""账号矩阵：接入、巡检、Cookie 维持、限速与轮换。

一个账号 = 一份完整 PC Cookie。Creator 发布视图由 ``XHSUnifiedAuth`` 从同一份
登录态派生，不单独存第二份 Cookie。网络调用按「发布 / 只读」两条通道串行化：
发布用 ``publish`` 通道，登录态检查、选题挖掘、已发布内容同步用 ``sync`` 通道，
两者互不等待，平台列表接口抖动时不会把真实发布堵在锁上。
"""

from __future__ import annotations

import io
import json
import os
import threading
import time
from contextlib import contextmanager
from datetime import datetime
from typing import Any, Iterator

from loguru import logger

from vendor.apis.xhs_creator_apis import XHS_Creator_Apis
from vendor.apis.xhs_pc_apis import XHS_Apis
from vendor.xhs_utils.xhs_auth import XHSUnifiedAuth
from vendor.xhs_utils.xhs_core.cookies import cookie_header
from vendor.xhs_utils.xhs_pc import XHSPcAuth

from ops import config, db, security
from ops.notify import NotifyCenter
from ops.platforms import DEFAULT_PLATFORM, get_platform, normalize, platform_label

STATUS_TEXT = {
    "healthy": "正常",
    "expired": "登录失效",
    "unknown": "待检查",
    "disabled": "已停用",
}

HEALTH_TEXT = {
    "unknown": "未判断",
    "healthy": "健康",
    "expired": "登录失效",
    "risk": "风控冷却",
    "probing": "冷却后探测中",
}

# 冷却结束后必须连续探测成功这么多次才恢复发布，探测间隔 5 分钟。
PROBE_SUCCESS_TARGET = 2
PROBE_INTERVAL_SEC = 300


def _proxies(proxy: str | None) -> dict[str, str] | None:
    value = (proxy or "").strip()
    if not value:
        return None
    if "://" not in value:
        value = "http://" + value
    return {"http": value, "https": value}


def day_start(ts: int | None = None) -> int:
    moment = datetime.fromtimestamp(ts or time.time())
    start = moment.replace(hour=0, minute=0, second=0, microsecond=0)
    return int(start.timestamp())


def _clean_cookie(cookie: str) -> str:
    text = (cookie or "").strip().strip("'\"")
    if text.upper().startswith("COOKIES="):
        text = text.split("=", 1)[1].strip().strip("'\"")
    return text


def export_cookie(pc_auth: XHSPcAuth) -> str:
    """把 Auth 当前完整 Cookie（含 host-only）序列化为可落库字符串。"""
    values: dict[str, str] = dict(pc_auth.profile.cookie_map)
    for bucket in (pc_auth.host_cookies_snapshot() or {}).values():
        for name, value in dict(bucket).items():
            values.setdefault(name, value)
    return cookie_header(values)


def render_qr_png(url: str) -> bytes:
    import qrcode

    qr = qrcode.QRCode(box_size=8, border=3)
    qr.add_data(url)
    qr.make(fit=True)
    image = qr.make_image(fill_color="black", back_color="white")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _find_user_info(payload: Any) -> dict[str, Any]:
    data = (payload or {}).get("data") if isinstance(payload, dict) else None
    return data if isinstance(data, dict) else {}


class AccountManager:
    """账号 CRUD、健康巡检、Cookie 回写、限速与轮换。"""

    def __init__(self) -> None:
        self._locks: dict[tuple[int, str], threading.Lock] = {}
        self._locks_guard = threading.Lock()

    # ------------------------------------------------------------ 查询

    def _lock_for(self, account_id: int, lane: str = "publish") -> threading.Lock:
        key = (int(account_id), lane)
        with self._locks_guard:
            lock = self._locks.get(key)
            if lock is None:
                lock = threading.Lock()
                self._locks[key] = lock
            return lock

    def get_row(self, account_id: int):
        row = db.query_one("SELECT * FROM accounts WHERE id = ?", (account_id,))
        if row is None:
            raise KeyError(f"账号不存在: {account_id}")
        return row

    def list_accounts(self, platform: str = "", group: str = "") -> list[dict[str, Any]]:
        clauses: list[str] = []
        args: list[Any] = []
        if platform:
            clauses.append("platform = ?")
            args.append(normalize(platform))
        if group:
            clauses.append("IFNULL(group_name,'') = ?")
            args.append(group)
        sql = "SELECT * FROM accounts"
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY id"
        rows = db.query(sql, tuple(args))
        start = day_start()
        counts = {
            row["account_id"]: row["n"]
            for row in db.query(
                "SELECT account_id, COUNT(*) AS n FROM records "
                "WHERE success = 1 AND created_at >= ? "
                "AND message NOT LIKE '模拟发布%' "
                "AND IFNULL(result, '') NOT LIKE '%simulated%' GROUP BY account_id",
                (start,),
            )
            if row["account_id"] is not None
        }
        result = []
        for row in rows:
            item = self._serialize(row)
            item["published_today"] = int(counts.get(row["id"], 0))
            result.append(item)
        return result

    def _serialize(self, row) -> dict[str, Any]:
        platform = row["platform"] or DEFAULT_PLATFORM
        try:
            tags = json.loads(row["tags"] or "[]")
        except (TypeError, ValueError):
            tags = []
        if not isinstance(tags, list):
            tags = []
        health_state = row["health_state"] or "unknown"
        return {
            "id": row["id"],
            "platform": platform,
            "platform_name": platform_label(platform),
            "platform_ready": get_platform(platform).ready,
            "name": row["name"],
            "nickname": row["nickname"],
            "red_id": row["red_id"],
            "user_id": row["user_id"],
            "proxy": row["proxy"],
            "proxy_group": row["proxy_group"] or "",
            "profile_key": row["profile_key"] or "",
            "enabled": bool(row["enabled"]),
            "status": row["status"],
            "status_text": STATUS_TEXT.get(row["status"], row["status"]),
            "health_state": health_state,
            "health_state_text": HEALTH_TEXT.get(health_state, health_state),
            "cooldown_until": int(row["cooldown_until"] or 0),
            "probe_success_count": int(row["probe_success_count"] or 0),
            "probe_target": PROBE_SUCCESS_TARGET,
            "group_name": row["group_name"] or "",
            "tags": [str(item) for item in tags],
            "last_error": row["last_error"],
            "health_checked_at": row["health_checked_at"],
            "last_publish_at": row["last_publish_at"],
            "published_synced_at": row["published_synced_at"],
            "published_sync_error": row["published_sync_error"],
            "exit_ip": row["exit_ip"] or "",
            "exit_country": row["exit_country"] or "",
            "exit_timezone": row["exit_timezone"] or "",
            "exit_checked_at": int(row["exit_checked_at"] or 0),
            "daily_limit": row["daily_limit"],
            "min_interval_sec": row["min_interval_sec"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    # ------------------------------------------------------------ 接入

    def add_cookie(
        self, name: str, cookie: str, proxy: str = "", platform: str = DEFAULT_PLATFORM
    ) -> dict[str, Any]:
        platform = self._require_ready(platform)
        if platform != DEFAULT_PLATFORM:
            adapter = get_platform(platform)
            raise ValueError(
                f"{adapter.name} 的登录态由浏览器扫码产生，不能只粘贴 Cookie；"
                "请使用「扫码登录」。"
            )
        text = _clean_cookie(cookie)
        if not text:
            raise ValueError("Cookie 为空")
        auth = XHSPcAuth.from_cookie(text, proxies=_proxies(proxy))
        try:
            api = XHS_Apis(auth).bootstrap()
            success, message, payload = api.get_user_me()
            if not success:
                raise RuntimeError(f"会话校验失败: {message}")
            info = _find_user_info(payload)
            if info.get("guest"):
                raise RuntimeError("当前是访客态，Cookie 无效或已过期")
            nickname = str(info.get("nickname") or "")
            red_id = str(info.get("red_id") or "")
            user_id = str(info.get("user_id") or auth.user_id or "")
            cookie_text = export_cookie(auth)
        finally:
            auth.close()
        return self._upsert(
            platform=platform,
            name=name or nickname or "未命名账号",
            cookie=cookie_text,
            nickname=nickname,
            red_id=red_id,
            user_id=user_id,
            proxy=proxy,
        )

    def add_pc_auth(
        self, auth: XHSPcAuth, name: str = "", proxy: str = "", platform: str = DEFAULT_PLATFORM
    ) -> dict[str, Any]:
        platform = self._require_ready(platform)
        try:
            api = XHS_Apis(auth).bootstrap()
            success, message, payload = api.get_user_me()
            if not success:
                raise RuntimeError(f"会话校验失败: {message}")
            info = _find_user_info(payload)
            if info.get("guest"):
                raise RuntimeError("当前是访客态，Cookie 无效或已过期")
            return self._upsert(
                platform=platform,
                name=name or str(info.get("nickname") or "未命名账号"),
                cookie=export_cookie(auth),
                nickname=str(info.get("nickname") or ""),
                red_id=str(info.get("red_id") or ""),
                user_id=str(info.get("user_id") or auth.user_id or ""),
                proxy=proxy,
            )
        finally:
            auth.close()

    @staticmethod
    def _require_ready(platform: str) -> str:
        key = normalize(platform)
        adapter = get_platform(key)
        if not adapter.ready:
            raise ValueError(f"{adapter.name} 暂未开放接入。")
        return key

    def add_session(
        self,
        platform: str,
        name: str,
        session: dict[str, Any],
        *,
        nickname: str = "",
        red_id: str = "",
        user_id: str = "",
        proxy: str = "",
    ) -> dict[str, Any]:
        """保存浏览器扫码得到的登录态（Cookie + storage_state + token）。

        公众号/抖音没有可直接粘贴的单一 Cookie：公众号还需要后台 token，抖音
        需要完整的 storage_state。这里统一以 JSON 加密落库，具体字段由平台
        适配器解释。
        """
        platform = self._require_ready(platform)
        if not isinstance(session, dict) or not session:
            raise ValueError("登录态为空，请重新扫码")
        session = dict(session)
        session.setdefault("platform", platform)
        session.setdefault("login_at", db.now())
        encrypted = security.encrypt(json.dumps(session, ensure_ascii=False, default=str))
        stamp = db.now()
        account_id = 0
        with db.transaction() as conn:
            existing = None
            if user_id:
                existing = conn.execute(
                    "SELECT id FROM accounts WHERE platform = ? AND user_id = ?",
                    (platform, user_id),
                ).fetchone()
            if existing is None and red_id:
                existing = conn.execute(
                    "SELECT id FROM accounts WHERE platform = ? AND red_id = ?",
                    (platform, red_id),
                ).fetchone()
            if existing is not None:
                account_id = int(existing["id"])
                conn.execute(
                    "UPDATE accounts SET name=?, nickname=?, red_id=?, user_id=?, cookie_enc=?, "
                    "proxy=?, enabled=1, status='healthy', health_state='healthy', "
                    "cooldown_until=0, last_error='', health_checked_at=?, "
                    "updated_at=? WHERE id=?",
                    (
                        name,
                        nickname,
                        red_id,
                        user_id,
                        encrypted,
                        proxy or "",
                        stamp,
                        stamp,
                        account_id,
                    ),
                )
            else:
                cursor = conn.execute(
                    "INSERT INTO accounts(platform, name, nickname, red_id, user_id, cookie_enc, "
                    "proxy, enabled, status, health_state, health_checked_at, created_at, updated_at) "
                    "VALUES(?,?,?,?,?,?,?,1,'healthy','healthy',?,?,?)",
                    (
                        platform,
                        name,
                        nickname,
                        red_id,
                        user_id,
                        encrypted,
                        proxy or "",
                        stamp,
                        stamp,
                        stamp,
                    ),
                )
                account_id = int(cursor.lastrowid)
        self._ensure_profile(account_id)
        item = self._serialize(self.get_row(account_id))
        item["published_today"] = self.published_today(account_id)
        return item

    def session_blob(self, account: Any) -> dict[str, Any]:
        """解密并解析非小红书平台的登录态；小红书仍返回 ``{"cookie": ...}``。"""
        row = account if hasattr(account, "keys") else self.get_row(int(account))
        raw = security.decrypt(row["cookie_enc"])
        try:
            value = json.loads(raw)
        except (TypeError, ValueError):
            return {"cookie": raw}
        if isinstance(value, dict):
            return value
        return {"cookie": raw}

    def save_session(self, account_id: int, session: dict[str, Any]) -> None:
        """登录态发生轮换（Cookie/token 更新）时回写，保持下次可用。"""
        payload = dict(session or {})
        payload.setdefault("updated_at", db.now())
        db.execute(
            "UPDATE accounts SET cookie_enc=?, updated_at=? WHERE id=?",
            (
                security.encrypt(json.dumps(payload, ensure_ascii=False, default=str)),
                db.now(),
                int(account_id),
            ),
        )

    def _upsert(
        self,
        *,
        platform: str,
        name: str,
        cookie: str,
        nickname: str,
        red_id: str,
        user_id: str,
        proxy: str,
    ) -> dict[str, Any]:
        stamp = db.now()
        encrypted = security.encrypt(cookie)
        with db.transaction() as conn:
            existing = None
            if user_id:
                existing = conn.execute(
                    "SELECT id FROM accounts WHERE platform = ? AND user_id = ?",
                    (platform, user_id),
                ).fetchone()
            if existing:
                account_id = int(existing["id"])
                conn.execute(
                    "UPDATE accounts SET name=?, nickname=?, red_id=?, cookie_enc=?, "
                    "proxy=?, status='healthy', health_state='healthy', cooldown_until=0, "
                    "last_error='', health_checked_at=?, updated_at=? WHERE id=?",
                    (
                        name,
                        nickname,
                        red_id,
                        encrypted,
                        proxy or "",
                        stamp,
                        stamp,
                        account_id,
                    ),
                )
                updated = True
            else:
                cursor = conn.execute(
                    "INSERT INTO accounts(platform, name, nickname, red_id, user_id, cookie_enc, "
                    "proxy, enabled, status, health_state, health_checked_at, created_at, updated_at) "
                    "VALUES(?,?,?,?,?,?,?,1,'healthy','healthy',?,?,?)",
                    (
                        platform,
                        name,
                        nickname,
                        red_id,
                        user_id,
                        encrypted,
                        proxy or "",
                        stamp,
                        stamp,
                        stamp,
                    ),
                )
                account_id = int(cursor.lastrowid)
                updated = False
        self._ensure_profile(account_id)
        item = self._serialize(self.get_row(account_id))
        item["published_today"] = self.published_today(account_id)
        item["updated_existing"] = updated
        return item

    def update_account(self, account_id: int, fields: dict[str, Any]) -> dict[str, Any]:
        allowed = {
            "name",
            "enabled",
            "daily_limit",
            "min_interval_sec",
            "proxy",
            "proxy_group",
            "status",
            "group_name",
            "tags",
        }
        updates = {key: value for key, value in fields.items() if key in allowed}
        if not updates:
            return self._serialize(self.get_row(account_id))
        if "enabled" in updates:
            updates["enabled"] = 1 if updates["enabled"] else 0
        if "tags" in updates:
            tags = updates["tags"]
            if isinstance(tags, str):
                tags = [item.strip() for item in tags.replace("，", ",").split(",") if item.strip()]
            if not isinstance(tags, list):
                tags = []
            updates["tags"] = json.dumps([str(item)[:20] for item in tags][:8], ensure_ascii=False)
        if "group_name" in updates:
            updates["group_name"] = str(updates["group_name"] or "")[:30]
        if "proxy" in updates:
            updates["proxy"] = str(updates["proxy"] or "").strip()[:500]
        updates["updated_at"] = db.now()
        assignments = ", ".join(f"{key} = ?" for key in updates)
        db.execute(
            f"UPDATE accounts SET {assignments} WHERE id = ?",
            (*updates.values(), account_id),
        )
        item = self._serialize(self.get_row(account_id))
        item["published_today"] = self.published_today(account_id)
        return item

    def delete_account(self, account_id: int) -> None:
        with db.transaction() as conn:
            conn.execute("UPDATE jobs SET account_id = NULL WHERE account_id = ?", (account_id,))
            conn.execute("UPDATE drafts SET account_id = NULL WHERE account_id = ?", (account_id,))
            # 已发布内容是账号的附属缓存，账号删除后不应留下孤儿行；
            # records 保留作审计，rate_events 只用于限速计算，一并清掉。
            conn.execute(
                "DELETE FROM published_metrics_daily WHERE note_id IN "
                "(SELECT id FROM published_notes WHERE account_id = ?)",
                (account_id,),
            )
            conn.execute("DELETE FROM published_notes WHERE account_id = ?", (account_id,))
            conn.execute("DELETE FROM note_comments WHERE account_id = ?", (account_id,))
            conn.execute("DELETE FROM risk_events WHERE account_id = ?", (account_id,))
            conn.execute("DELETE FROM rate_events WHERE account_id = ?", (account_id,))
            conn.execute("DELETE FROM accounts WHERE id = ?", (account_id,))

    # ------------------------------------------------------------ 会话

    def _profile_path(self, row) -> Any:
        key = row["profile_key"] or f"profile-{row['id']}"
        return config.PROFILE_DIR / key

    def _ensure_profile(self, account_id: int) -> str:
        """每个账号一个独立目录；未来放浏览器 Profile / 调试文件。"""
        row = db.query_one("SELECT * FROM accounts WHERE id=?", (int(account_id),))
        if row is None:
            return ""
        key = row["profile_key"] or f"profile-{int(account_id)}"
        path = config.PROFILE_DIR / key
        path.mkdir(parents=True, exist_ok=True)
        if not row["profile_key"]:
            db.execute(
                "UPDATE accounts SET profile_key=?, updated_at=? WHERE id=?",
                (key, db.now(), int(account_id)),
            )
        return key

    @staticmethod
    def _acquire_process_lock(path: Any) -> None:
        """跨进程占用保护：同一账号不能同时被两个进程打开。"""
        path.parent.mkdir(parents=True, exist_ok=True)
        for _ in range(2):
            try:
                fd = os.open(str(path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(fd, str(os.getpid()).encode())
                os.close(fd)
                return
            except FileExistsError:
                try:
                    age = time.time() - path.stat().st_mtime
                except FileNotFoundError:
                    continue
                if age > 600:  # 崩溃残留，超过 10 分钟自动接管
                    try:
                        path.unlink()
                    except OSError:
                        pass
                    continue
                raise TimeoutError("账号正被另一个进程使用，请稍后再试")
        raise TimeoutError("账号正被另一个进程使用，请稍后再试")

    @staticmethod
    def _release_process_lock(path: Any) -> None:
        try:
            path.unlink()
        except OSError:
            pass

    def _auth_from_row(self, row) -> XHSPcAuth:
        cookie = security.decrypt(row["cookie_enc"])
        return XHSPcAuth.from_cookie(cookie, proxies=_proxies(row["proxy"]))

    @contextmanager
    def session(
        self,
        account_id: int,
        *,
        lane: str = "publish",
        wait: float = 180,
    ) -> Iterator[XHSPcAuth]:
        """打开账号会话，退出时自动回写最新 Cookie 并关闭连接。

        ``lane`` 把「发布」和「只读」拆成两把锁：内容回收、登录态检查、选题
        挖掘走 ``sync``，不会占用发布的锁；``wait=0`` 表示拿不到就立即放弃，
        由调用方降级为「稍后重试」。
        """
        row = self.get_row(account_id)
        lock = self._lock_for(account_id, lane)
        if not lock.acquire(timeout=max(0.0, float(wait))):
            raise TimeoutError(f"账号 {account_id} 正被占用")
        lock_path = self._profile_path(row) / ".lock"
        auth: XHSPcAuth | None = None
        try:
            self._acquire_process_lock(lock_path)
            auth = self._auth_from_row(row)
            yield auth
        finally:
            if auth is not None:
                try:
                    self.save_cookies(account_id, auth)
                except Exception as exc:  # noqa: BLE001
                    logger.warning(f"回写账号 {account_id} Cookie 失败: {exc}")
                finally:
                    auth.close()
            self._release_process_lock(lock_path)
            lock.release()

    def creator_api(self, auth: XHSPcAuth) -> XHS_Creator_Apis:
        """从 PC 会话派生 Creator 发布视图。"""
        unified = XHSUnifiedAuth(pc_auth=auth)
        return XHS_Creator_Apis(unified.creator).bootstrap()

    def save_cookies(self, account_id: int, auth: XHSPcAuth) -> None:
        cookie = export_cookie(auth)
        if not cookie:
            return
        db.execute(
            "UPDATE accounts SET cookie_enc=?, updated_at=? WHERE id=?",
            (security.encrypt(cookie), db.now(), account_id),
        )

    # ------------------------------------------------------------ 巡检

    def check_health(self, account_id: int) -> dict[str, Any]:
        """登录态检查：网络部分交给平台适配器，库里状态由这里统一维护。"""
        row = self.get_row(account_id)
        stamp = db.now()
        self.mark_action(account_id, "health_check")
        adapter = get_platform(row["platform"], self)
        try:
            result = adapter.check_session(row)
        except NotImplementedError as exc:
            return {"ok": False, "id": account_id, "message": str(exc)}
        if result.get("ok"):
            nickname = str(result.get("nickname") or row["nickname"])
            red_id = str(result.get("red_id") or row["red_id"])
            user_id = str(result.get("user_id") or row["user_id"])
            recovering = (row["health_state"] or "") in {"risk", "probing"} or int(
                row["cooldown_until"] or 0
            ) > 0
            probe_count = 0
            if recovering:
                probe_count = int(row["probe_success_count"] or 0) + 1
                if probe_count < PROBE_SUCCESS_TARGET:
                    # 冷却刚结束不能一次探测就恢复发布：保持 probing，5 分钟后再探。
                    db.execute(
                        "UPDATE accounts SET status='healthy', health_state='probing', "
                        "cooldown_until=0, probe_success_count=?, last_error='', "
                        "nickname=?, red_id=?, user_id=?, health_checked_at=?, updated_at=? "
                        "WHERE id=?",
                        (probe_count, nickname, red_id, user_id, stamp, stamp, account_id),
                    )
                    return {
                        "ok": True,
                        "id": account_id,
                        "nickname": nickname,
                        "red_id": red_id,
                        "probing": True,
                        "probe_success_count": probe_count,
                        "probe_target": PROBE_SUCCESS_TARGET,
                        "message": (
                            f"登录探测通过（{probe_count}/{PROBE_SUCCESS_TARGET}），"
                            "继续观察后再恢复发布"
                        ),
                    }
            db.execute(
                "UPDATE accounts SET status='healthy', health_state='healthy', "
                "cooldown_until=0, probe_success_count=0, last_error='', nickname=?, "
                "red_id=?, user_id=?, health_checked_at=?, updated_at=? WHERE id=?",
                (nickname, red_id, user_id, stamp, stamp, account_id),
            )
            # 连续探测达标即视为恢复，把未结束的风控事件一并闭环。
            db.execute(
                "UPDATE risk_events SET ended_at=? WHERE account_id=? AND ended_at=0",
                (stamp, account_id),
            )
            return {
                "ok": True,
                "id": account_id,
                "nickname": nickname,
                "red_id": red_id,
                "message": (
                    f"连续探测 {probe_count}/{PROBE_SUCCESS_TARGET} 次通过，已恢复"
                    if recovering
                    else (result.get("message") or "登录态正常")
                ),
            }
        message = str(result.get("message") or "登录态已失效")
        if result.get("transient"):
            # 网络抖动/平台改版不代表账号失效，保留原状态，下一轮再检查。
            db.execute(
                "UPDATE accounts SET last_error=?, health_checked_at=?, updated_at=? WHERE id=?",
                (message[:500], stamp, stamp, account_id),
            )
            return {"ok": False, "id": account_id, "message": message, "transient": True}
        db.execute(
            "UPDATE accounts SET status='expired', health_state='expired', last_error=?, "
            "health_checked_at=?, updated_at=? WHERE id=?",
            (message[:500], stamp, stamp, account_id),
        )
        try:
            NotifyCenter().emit(
                "account_expired",
                f"账号登录失效：{row['nickname'] or row['name']}",
                message,
                link_view="accounts",
                link_id=account_id,
            )
        except Exception:  # noqa: BLE001
            logger.exception("发送账号失效通知失败")
        return {"ok": False, "id": account_id, "message": message}

    def due_for_health_check(self) -> int | None:
        hours = max(1, db.get_int_setting("health_check_hours", 6))
        now = db.now()
        cutoff = now - hours * 3600
        probe_cutoff = now - PROBE_INTERVAL_SEC
        row = db.query_one(
            "SELECT id FROM accounts WHERE enabled = 1 AND status != 'expired' "
            "AND (health_checked_at = 0 OR health_checked_at < ? "
            "OR (health_state = 'probing' AND health_checked_at <= ?) "
            "OR (health_state = 'risk' AND cooldown_until <= ?)) "
            "ORDER BY CASE WHEN health_state IN ('risk','probing') THEN 0 ELSE 1 END, "
            "health_checked_at ASC LIMIT 1",
            (cutoff, probe_cutoff, now),
        )
        return int(row["id"]) if row else None

    # ------------------------------------------------------------ 风控与账号环境

    def mark_action(self, account_id: int, action: str) -> None:
        """记录一次平台动作；所有写动作共用同一份间隔预算。"""
        db.execute(
            "INSERT INTO rate_events(account_id, action, created_at) VALUES(?,?,?)",
            (int(account_id), action, db.now()),
        )

    def note_risk(
        self, account_id: int, kind: str, reason: str, source: str = "publish"
    ) -> int:
        """命中平台风控：按 24 小时内次数阶梯冷却，并留下审计事件。"""
        now = db.now()
        row = self.get_row(account_id)
        recent = int(
            db.scalar(
                "SELECT COUNT(*) FROM risk_events WHERE account_id=? "
                "AND started_at >= ?",
                (int(account_id), now - 86400),
                0,
            )
            or 0
        )
        steps = (900, 3600, 10800)
        base = steps[min(recent, len(steps) - 1)]
        until = min(max(int(row["cooldown_until"] or 0), now) + base, now + 3 * 3600)
        db.execute(
            "UPDATE accounts SET health_state='risk', cooldown_until=?, last_error=?, "
            "probe_success_count=0, updated_at=? WHERE id=?",
            (until, str(reason)[:500], now, int(account_id)),
        )
        db.execute(
            "INSERT INTO risk_events(account_id, type, reason, source, started_at) "
            "VALUES(?,?,?,?,?)",
            (int(account_id), kind, str(reason)[:500], source, now),
        )
        try:
            NotifyCenter().emit(
                "risk_cooldown",
                f"账号进入风控冷却：{row['nickname'] or row['name']}",
                f"{reason}；预计 {time.strftime('%H:%M', time.localtime(until))} 后恢复。",
                link_view="accounts",
                link_id=int(account_id),
            )
        except Exception:  # noqa: BLE001
            logger.exception("发送风控通知失败")
        logger.warning(f"账号 {account_id} 进入风控冷却，截止 {until}: {reason}")
        return until

    def clear_cooldown(self, account_id: int, manual: bool = False) -> dict[str, Any]:
        """解除冷却。

        人工解除代表管理员已确认账号可用，直接恢复 healthy；自动解除（manual
        = False）进入 probing，必须连续探测成功才恢复发布。
        """
        now = db.now()
        state = "healthy" if manual else "probing"
        db.execute(
            "UPDATE accounts SET cooldown_until=0, health_state=?, probe_success_count=0, "
            "updated_at=? WHERE id=?",
            (state, now, int(account_id)),
        )
        db.execute(
            "UPDATE risk_events SET ended_at=? WHERE account_id=? AND ended_at=0",
            (now, int(account_id)),
        )
        if manual:
            db.execute(
                "INSERT INTO risk_events(account_id, type, reason, source, started_at, ended_at) "
                "VALUES(?,?,?,'manual',?,?)",
                (int(account_id), "manual_release", "人工解除冷却", now, now),
            )
        return self.diagnose(int(account_id))

    def proxy_test(self, account_id: int) -> dict[str, Any]:
        """测试账号实际出口；出口变化会留痕并提醒。"""
        from ops.proxies import probe

        row = self.get_row(account_id)
        proxy = str(row["proxy"] or "").strip()
        if not proxy:
            raise ValueError("该账号使用直连，没有可测试的代理")
        result = probe(proxy)
        now = db.now()
        old_ip = str(row["exit_ip"] or "")
        changed = bool(old_ip and old_ip != result["exit_ip"])
        db.execute(
            "UPDATE accounts SET exit_ip=?, exit_country=?, exit_timezone=?, "
            "exit_checked_at=?, updated_at=? WHERE id=?",
            (
                result["exit_ip"],
                result["country"],
                result["timezone"],
                now,
                now,
                int(account_id),
            ),
        )
        if changed:
            db.execute(
                "INSERT INTO risk_events(account_id, type, reason, source, started_at) "
                "VALUES(?,?,?,'proxy',?)",
                (
                    int(account_id),
                    "exit_changed",
                    f"出口从 {old_ip} 变为 {result['exit_ip']}",
                    now,
                ),
            )
            try:
                NotifyCenter().emit(
                    "risk_cooldown",
                    f"账号出口已变化：{row['nickname'] or row['name']}",
                    f"出口从 {old_ip} 变为 {result['exit_ip']}，建议先确认登录态再发布。",
                    link_view="accounts",
                    link_id=int(account_id),
                )
            except Exception:  # noqa: BLE001
                logger.exception("发送出口变化通知失败")
        return {
            **result,
            "changed": changed,
            "previous_ip": old_ip,
            "message": (
                f"出口已变化：{old_ip} → {result['exit_ip']}"
                if changed
                else f"代理可用，出口 {result['exit_ip']}"
            ),
        }

    # ------------------------------------------------------------ 限速

    def published_today(self, account_id: int) -> int:
        """今日真实发布数：模拟发布（演练/干跑）不占真实限额。"""
        return int(
            db.scalar(
                "SELECT COUNT(*) FROM records WHERE success = 1 AND account_id = ? "
                "AND created_at >= ? AND message NOT LIKE '模拟发布%' "
                "AND IFNULL(result, '') NOT LIKE '%simulated%' "
                "AND REPLACE(IFNULL(result, ''), ' ', '') NOT LIKE '%\"action\":\"draft\"%'",
                (account_id, day_start()),
                0,
            )
        )

    @staticmethod
    def _limits(row) -> tuple[int, int, int]:
        platform = row["platform"] or DEFAULT_PLATFORM
        adapter = get_platform(platform)
        # 小红书沿用全局设置（历史行为）；其它平台用自己的默认值，避免被
        # 小红书的「每天 3 篇、45 分钟」直接套用。
        if platform == DEFAULT_PLATFORM:
            limit = int(row["daily_limit"] or 0) or db.get_int_setting("publish_daily_limit", 3)
            interval = int(row["min_interval_sec"] or 0) or db.get_int_setting(
                "publish_min_interval_sec", 2700
            )
        else:
            limit = int(row["daily_limit"] or 0) or adapter.default_daily_limit
            interval = int(row["min_interval_sec"] or 0) or adapter.default_min_interval_sec
        jitter = db.get_int_setting("publish_jitter_sec", 300)
        return max(1, limit), max(0, interval), max(0, jitter)

    def availability(
        self, row, at: int | None = None, count_quota: bool = True
    ) -> tuple[bool, str, int]:
        """返回 (可用, 原因, 下次可用时间戳)。

        抖动按「账号 + 自然日」稳定取值，重算结果一致，便于解释和测试。
        ``count_quota=False`` 用于公众号「只存草稿」：草稿不是发布动作，不占
        任何发布额度，也不应该被上次发布的时间挡住。
        """
        moment = at or db.now()
        if not row["enabled"]:
            return False, "账号已停用", moment
        if row["status"] == "expired":
            return False, "登录已失效", moment
        cooldown = int(row["cooldown_until"] or 0)
        if cooldown > moment:
            wait = cooldown - moment
            return False, f"风控冷却中，还需 {max(1, wait // 60)} 分钟", cooldown
        if cooldown and row["health_state"] == "risk":
            # 冷却到点先做轻量探测，探测通过才恢复发布。
            return False, "冷却已结束，等待登录探测", moment + 120
        if row["health_state"] == "probing":
            count = int(row["probe_success_count"] or 0)
            if count < PROBE_SUCCESS_TARGET:
                next_at = max(
                    moment, int(row["health_checked_at"] or 0) + PROBE_INTERVAL_SEC
                )
                return (
                    False,
                    f"冷却后探测中（{count}/{PROBE_SUCCESS_TARGET}），暂不发布",
                    next_at,
                )
        # 发布 / 巡检 / 同步共享同一个账号级写间隔，避免连续动作触发风控。
        gap = max(0, db.get_int_setting("write_gap_sec", 45))
        if gap:
            last_action = int(
                db.scalar(
                    "SELECT MAX(created_at) FROM rate_events WHERE account_id=? "
                    "AND action IN ('publish','health_check','sync')",
                    (int(row["id"]),),
                    0,
                )
                or 0
            )
            if last_action and last_action + gap > moment:
                wait = last_action + gap - moment
                return False, f"刚操作过账号，还需 {max(1, wait)} 秒", last_action + gap
        if not count_quota:
            return True, "", moment
        limit, interval, jitter = self._limits(row)
        used = self.published_today(row["id"])
        if used >= limit:
            return False, f"今日已达上限 {limit} 篇", day_start(moment) + 86400
        offset = 0
        if jitter:
            offset = hash((row["id"], day_start(moment))) % (jitter + 1)
        next_at = int(row["last_publish_at"] or 0) + interval + offset
        if row["last_publish_at"] and next_at > moment:
            wait = next_at - moment
            return False, f"间隔未到，还需 {wait // 60} 分钟", next_at
        return True, "", moment

    def diagnose(self, account_id: int) -> dict[str, Any]:
        """一屏诊断：这个号现在能做什么、为什么不能做。"""
        self._ensure_profile(int(account_id))
        row = self.get_row(int(account_id))
        item = self._serialize(row)
        item["published_today"] = self.published_today(int(account_id))
        limit, interval, jitter = self._limits(row)
        ok, reason, next_at = self.availability(row)
        adapter = get_platform(row["platform"] or DEFAULT_PLATFORM, self)
        synced = int(
            db.scalar(
                "SELECT COUNT(*) FROM published_notes WHERE account_id=?",
                (int(account_id),),
                0,
            )
            or 0
        )
        risky = int(
            db.scalar(
                "SELECT COUNT(*) FROM published_notes WHERE account_id=? "
                "AND health_state IN ('zero_views','risky','removed')",
                (int(account_id),),
                0,
            )
            or 0
        )
        jobs = {
            status: int(
                db.scalar(
                    "SELECT COUNT(*) FROM jobs WHERE account_id=? AND status=?",
                    (int(account_id), status),
                    0,
                )
                or 0
            )
            for status in (
                "pending",
                "retry",
                "running",
                "pending_confirm",
                "success",
                "failed",
            )
        }
        records = []
        for record in db.query(
            "SELECT * FROM records WHERE account_id=? ORDER BY id DESC LIMIT 5",
            (int(account_id),),
        ):
            payload = db.json_field(record["result"], {})
            evidence = payload.get("evidence") if isinstance(payload, dict) else None
            records.append(
                {
                    "id": record["id"],
                    "success": bool(record["success"]),
                    "message": record["message"],
                    "created_at": record["created_at"],
                    "remote_note_id": record["remote_note_id"],
                    # 发布失败现场（截图 / DOM），只在存在时返回。
                    "evidence": evidence if isinstance(evidence, dict) else {},
                }
            )
        risk_events = [
            {
                "id": risk["id"],
                "type": risk["type"],
                "reason": risk["reason"],
                "source": risk["source"],
                "started_at": risk["started_at"],
                "ended_at": risk["ended_at"],
            }
            for risk in db.query(
                "SELECT * FROM risk_events WHERE account_id=? ORDER BY id DESC LIMIT 8",
                (int(account_id),),
            )
        ]
        checklist = [
            {
                "key": "login",
                "label": "登录态",
                "ok": row["status"] == "healthy",
                "hint": STATUS_TEXT.get(row["status"], row["status"]),
            },
            {
                "key": "enabled",
                "label": "账号启用",
                "ok": bool(row["enabled"]),
                "hint": "已启用" if row["enabled"] else "已停用",
            },
            {
                "key": "risk",
                "label": "风控状态",
                "ok": int(row["cooldown_until"] or 0) <= db.now(),
                "hint": (
                    "冷却中"
                    if int(row["cooldown_until"] or 0) > db.now()
                    else "未在冷却"
                ),
            },
            {
                "key": "platform",
                "label": "发布能力",
                "ok": adapter.ready and bool(adapter.features.get("publish")),
                "hint": "已接入" if adapter.ready else "接入位",
            },
            {
                "key": "quota",
                "label": "今日额度",
                "ok": item["published_today"] < limit,
                "hint": f"{item['published_today']} / {limit} 篇",
            },
            {
                "key": "sync",
                "label": "内容同步",
                "ok": not row["published_sync_error"],
                "hint": row["published_sync_error"] or "正常",
            },
        ]
        lanes = [
            {
                "key": "read",
                "label": "浏览 / 同步",
                "ok": row["status"] == "healthy",
                "hint": "能查看笔记",
            },
            {
                "key": "publish",
                "label": "创作者发布",
                "ok": row["status"] == "healthy" and adapter.ready,
                "hint": "能查看笔记 ≠ 能发布，发布前请在平台上确认创作者身份",
            },
        ]
        return {
            "account": item,
            "publish": {
                "available": ok,
                "reason": reason or ("可以发布" if ok else "暂不可发布"),
                "next_available_at": next_at,
                "daily_limit": limit,
                "used_today": item["published_today"],
                "min_interval_sec": interval,
                "jitter_sec": jitter,
            },
            "environment": {
                "profile_key": item["profile_key"],
                "proxy": item["proxy"],
                "proxy_group": item["proxy_group"],
                "exit_ip": item["exit_ip"],
                "exit_country": item["exit_country"],
                "exit_timezone": item["exit_timezone"],
                "exit_checked_at": item["exit_checked_at"],
                "lanes": lanes,
            },
            "sync": {
                "synced_at": row["published_synced_at"],
                "error": row["published_sync_error"],
                "published_total": synced,
                "abnormal_total": risky,
            },
            "jobs": jobs,
            "recent_records": records,
            "risk_events": risk_events,
            "checklist": checklist,
        }

    def batch(
        self,
        action: str,
        account_ids: list[int],
        *,
        group_name: str = "",
        tags: list[str] | None = None,
    ) -> dict[str, Any]:
        """批量启停 / 巡检 / 分组 / 打标签 / 解冷却。"""
        ids = list(dict.fromkeys(int(item) for item in account_ids if item))
        if not ids:
            raise ValueError("请至少选择一个账号")
        for account_id in ids:
            self.get_row(account_id)
        now = db.now()
        if action in {"enable", "disable"}:
            db.execute_many(
                "UPDATE accounts SET enabled=?, updated_at=? WHERE id=?",
                [(1 if action == "enable" else 0, now, account_id) for account_id in ids],
            )
            return {"action": action, "count": len(ids), "message": "账号状态已更新"}
        if action == "group":
            db.execute_many(
                "UPDATE accounts SET group_name=?, updated_at=? WHERE id=?",
                [(str(group_name or "")[:30], now, account_id) for account_id in ids],
            )
            return {"action": action, "count": len(ids), "message": "分组已更新"}
        if action == "tag":
            payload = json.dumps(
                [str(item)[:20] for item in (tags or [])][:8], ensure_ascii=False
            )
            db.execute_many(
                "UPDATE accounts SET tags=?, updated_at=? WHERE id=?",
                [(payload, now, account_id) for account_id in ids],
            )
            return {"action": action, "count": len(ids), "message": "标签已更新"}
        if action == "clear_cooldown":
            for account_id in ids:
                self.clear_cooldown(account_id, manual=True)
            return {"action": action, "count": len(ids), "message": "已解除冷却"}
        if action == "check":
            results = [self.check_health(account_id) for account_id in ids]
            ok = sum(1 for item in results if item.get("ok"))
            return {
                "action": action,
                "count": len(ids),
                "ok_count": ok,
                "results": results,
                "message": f"已检查 {len(ids)} 个账号，正常 {ok} 个",
            }
        raise ValueError("不支持的批量操作")

    def groups(self) -> list[str]:
        rows = db.query(
            "SELECT DISTINCT group_name FROM accounts WHERE IFNULL(group_name,'') != '' "
            "ORDER BY group_name"
        )
        return [str(row["group_name"]) for row in rows]

    def pick_account(
        self,
        at: int | None = None,
        exclude: set[int] | None = None,
        platform: str = "",
        count_quota: bool = True,
    ):
        """按「今日已发少 → 上次发布早 → 日期轮换」选账号。

        传 ``platform`` 时只在该平台的账号里轮换，避免把小红书草稿投到
        公众号/抖音账号。
        """
        moment = at or db.now()
        skip = exclude or set()
        target = normalize(platform) if platform else ""
        sql = "SELECT * FROM accounts WHERE enabled = 1 AND status != 'expired'"
        args: tuple[Any, ...] = ()
        if target:
            sql += " AND platform = ?"
            args = (target,)
        sql += " ORDER BY id"
        candidates = []
        reasons: list[tuple[int, str]] = []
        for row in db.query(sql, args):
            if row["id"] in skip:
                continue
            ok, reason, next_at = self.availability(row, moment, count_quota=count_quota)
            if not ok:
                reasons.append((next_at, reason))
                continue
            candidates.append(
                (
                    self.published_today(row["id"]),
                    int(row["last_publish_at"] or 0),
                    (row["id"] - datetime.fromtimestamp(moment).timetuple().tm_yday) % 997,
                    row,
                )
            )
        if not candidates:
            if reasons:
                next_at, reason = min(reasons, key=lambda item: item[0])
                return None, reason, next_at
            return None, "没有可用账号，请先添加并检查登录", moment
        candidates.sort(key=lambda item: (item[0], item[1], item[2]))
        return candidates[0][3], "", moment


# ---------------------------------------------------------------- 扫码登录

class QrLoginSession:
    """一次网页扫码登录的临时会话（不落库，确认后由调用方保存账号）。"""

    TTL = 300
    platform = DEFAULT_PLATFORM

    def __init__(self, proxy: str = "") -> None:
        from vendor.apis.xhs_pc_login_apis import XHSLoginApi

        self.proxy = proxy
        self.proxies = _proxies(proxy)
        self.login = XHSLoginApi(proxies=self.proxies)
        self.lock = threading.Lock()
        self.created_at = time.time()
        self.status = "starting"
        self.message = "正在生成二维码"
        self.user_info: dict[str, Any] = {}
        self.cookie = ""
        self.qr_png = b""
        self._start()

    def _start(self) -> None:
        cookies = self.login.generate_init_cookies()
        success, message, qr = self.login.generate_qrcode(cookies)
        if not success:
            raise RuntimeError(message)
        self.cookies = qr["cookies"]
        self.qr_id = qr["qr_id"]
        self.code = qr["code"]
        self.qr_url = qr["qr_url"]
        success, message, cookies = self.login.check_qrcode_status(
            self.qr_id, self.code, self.cookies
        )
        self.cookies = cookies
        if success:
            raise RuntimeError("二维码在展示前已被确认，请重试")
        if message != "请扫描二维码":
            raise RuntimeError(f"二维码状态异常: {message}")
        self.login.ensure_webprofile(self.cookies)
        self.qr_png = render_qr_png(self.qr_url)
        self.status = "waiting"
        self.message = "请用小红书 App 扫码"

    def poll(self) -> dict[str, Any]:
        with self.lock:
            if self.status in {"confirmed", "expired", "error"}:
                return self.payload()
            if time.time() - self.created_at > self.TTL:
                self.status = "expired"
                self.message = "二维码已过期，请重新生成"
                return self.payload()
            try:
                success, message, cookies = self.login.check_qrcode_status(
                    self.qr_id, self.code, self.cookies
                )
                self.cookies = cookies
                self.message = message
                if success:
                    self._confirm()
                elif message == "请确认登录":
                    self.status = "scanned"
                elif message == "二维码已过期":
                    self.status = "expired"
                else:
                    self.status = "waiting"
            except Exception as exc:  # noqa: BLE001
                self.status = "error"
                self.message = f"{exc.__class__.__name__}: {exc}"
            return self.payload()

    def _confirm(self) -> None:
        success, info, cookies = self.login.get_user_info(self.cookies)
        if not success or info.get("guest") is not False:
            self.status = "error"
            self.message = "登录确认后会话校验失败，请重试"
            return
        self.cookies = cookies
        self.user_info = info if isinstance(info, dict) else {}
        values: dict[str, str] = dict(self.login.profile.cookie_map)
        for bucket in (self.login.host_cookies_snapshot() or {}).values():
            for name, value in dict(bucket).items():
                values.setdefault(name, value)
        self.cookie = cookie_header(values)
        self.status = "confirmed"
        self.message = f"登录成功：{self.user_info.get('nickname', '')}"

    def payload(self) -> dict[str, Any]:
        return {
            "platform": self.platform,
            "status": self.status,
            "message": self.message,
            "nickname": str(self.user_info.get("nickname") or ""),
            "red_id": str(self.user_info.get("red_id") or ""),
        }

    def account_payload(self) -> dict[str, Any]:
        return {
            "cookie": self.cookie,
            "nickname": str(self.user_info.get("nickname") or ""),
            "platform_id": str(self.user_info.get("red_id") or ""),
            "user_id": str(self.user_info.get("user_id") or ""),
        }

    def close(self) -> None:
        try:
            self.login.close()
        except Exception:  # noqa: BLE001
            pass


class QrLoginRegistry:
    """扫码会话管理，进程内内存保存；按平台分发到对应适配器。"""

    def __init__(self) -> None:
        self._sessions: dict[str, Any] = {}
        self._guard = threading.Lock()
        self._counter = 0

    def start(self, proxy: str = "", platform: str = DEFAULT_PLATFORM) -> tuple[str, str]:
        key = normalize(platform)
        if key == DEFAULT_PLATFORM:
            session: Any = QrLoginSession(proxy)
        else:
            adapter = get_platform(key)
            session = adapter.start_qr(proxy)
            session.platform = key
        with self._guard:
            self._cleanup_locked()
            self._counter += 1
            session_id = f"qr{int(time.time())}{self._counter}"
            self._sessions[session_id] = session
        return session_id, security.b64_png(session.qr_png)

    def get(self, session_id: str) -> Any:
        with self._guard:
            session = self._sessions.get(session_id)
        if session is None:
            raise KeyError("扫码会话不存在或已过期")
        return session

    def drop(self, session_id: str) -> None:
        with self._guard:
            session = self._sessions.pop(session_id, None)
        if session is not None:
            session.close()

    def poll(self, session_id: str) -> dict[str, Any]:
        session = self.get(session_id)
        payload = session.poll()
        payload.setdefault("platform", getattr(session, "platform", DEFAULT_PLATFORM))
        if payload["status"] in {"confirmed", "expired", "error"}:
            payload["cookie"] = getattr(session, "cookie", "") if payload["status"] == "confirmed" else ""
        return payload

    def _cleanup_locked(self) -> None:
        expired = [
            key
            for key, session in self._sessions.items()
            if time.time() - session.created_at
            > int(getattr(session, "TTL", 300) or 300) + 60
        ]
        for key in expired:
            session = self._sessions.pop(key, None)
            if session is not None:
                session.close()
