# encoding: utf-8
"""通知中心：先站内，再按需推到通用 Webhook。

设计原则：
- 所有异常先写 ``notification_events``，页面一定能看到；
- 站外推送失败只更新渠道的 ``last_status``，不影响业务主流程；
- 同一事件 + 同一对象在 30 分钟内只提醒一次，避免刷屏。
"""

from __future__ import annotations

import json
import threading
import time
from typing import Any
from urllib.parse import quote

import requests
from loguru import logger

from ops import db

EVENT_TEXT = {
    "publish_failed": "发布失败",
    "publish_pending": "发布结果待确认",
    "account_expired": "账号登录失效",
    "note_abnormal": "作品数据异常",
    "sync_failed": "内容同步失败",
    "risk_cooldown": "账号进入风控冷却",
    "backup_done": "备份完成",
}

DEDUPE_SEC = 1800
WEBHOOK_TIMEOUT = 8


def _json_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item) for item in value]
    try:
        items = json.loads(value or "[]")
    except (TypeError, ValueError):
        return []
    return [str(item) for item in items] if isinstance(items, list) else []


class NotifyCenter:
    """站内消息与站外渠道的统一入口。"""

    # ------------------------------------------------------------ 站内

    def emit(
        self,
        event: str,
        title: str,
        message: str = "",
        *,
        level: str = "warn",
        link_view: str = "",
        link_id: int = 0,
        dedupe: bool = True,
        dedupe_sec: int | None = None,
    ) -> dict[str, Any] | None:
        """写一条站内消息并按渠道推送；重复事件返回 None。"""
        if dedupe and self._recent_duplicate(
            event, link_view, link_id, dedupe_sec or DEDUPE_SEC
        ):
            return None
        now = db.now()
        event_id = db.execute(
            "INSERT INTO notification_events(level, event, title, message, link_view, "
            "link_id, read, created_at) VALUES(?,?,?,?,?,?,0,?)",
            (
                level if level in {"info", "warn", "error"} else "warn",
                event,
                title[:160],
                message[:1000],
                link_view,
                int(link_id or 0),
                now,
            ),
        )
        item = {
            "id": event_id,
            "event": event,
            "event_text": EVENT_TEXT.get(event, event),
            "title": title[:160],
            "message": message[:1000],
            "level": level,
            "link_view": link_view,
            "link_id": int(link_id or 0),
            "created_at": now,
        }
        threading.Thread(
            target=self._dispatch, args=(item,), name="ops-notify", daemon=True
        ).start()
        return item

    def _recent_duplicate(
        self, event: str, link_view: str, link_id: int, window: int = DEDUPE_SEC
    ) -> bool:
        row = db.query_one(
            "SELECT id FROM notification_events WHERE event=? AND link_view=? "
            "AND link_id=? AND created_at >= ? LIMIT 1",
            (event, link_view, int(link_id or 0), db.now() - max(1, int(window))),
        )
        return row is not None

    def list_events(
        self, limit: int = 20, offset: int = 0, unread_only: bool = False
    ) -> dict[str, Any]:
        where = "WHERE read = 0" if unread_only else ""
        rows = db.query(
            f"SELECT * FROM notification_events {where} ORDER BY id DESC LIMIT ? OFFSET ?",
            (max(1, min(100, int(limit or 20))), max(0, int(offset or 0))),
        )
        total = int(
            db.scalar(f"SELECT COUNT(*) FROM notification_events {where}", (), 0) or 0
        )
        return {
            "items": [
                {
                    "id": row["id"],
                    "event": row["event"],
                    "event_text": EVENT_TEXT.get(row["event"], row["event"]),
                    "level": row["level"],
                    "title": row["title"],
                    "message": row["message"],
                    "link_view": row["link_view"],
                    "link_id": row["link_id"],
                    "read": bool(row["read"]),
                    "created_at": row["created_at"],
                }
                for row in rows
            ],
            "total": total,
            "unread": self.unread_count(),
        }

    def unread_count(self) -> int:
        return int(
            db.scalar("SELECT COUNT(*) FROM notification_events WHERE read = 0", (), 0)
            or 0
        )

    def mark_read(self, ids: list[int] | None = None) -> int:
        if ids is None:
            return self._mark_all()
        clean = [int(item) for item in ids if item]
        if not clean:
            return 0
        placeholders = ",".join("?" for _ in clean)
        with db.transaction() as conn:
            cursor = conn.execute(
                f"UPDATE notification_events SET read = 1 WHERE id IN ({placeholders})",
                tuple(clean),
            )
            return int(cursor.rowcount or 0)

    def _mark_all(self) -> int:
        with db.transaction() as conn:
            cursor = conn.execute(
                "UPDATE notification_events SET read = 1 WHERE read = 0"
            )
            return int(cursor.rowcount or 0)

    # ------------------------------------------------------------ 渠道

    def list_channels(self) -> list[dict[str, Any]]:
        return [self._serialize(row) for row in db.query("SELECT * FROM notifications ORDER BY id")]

    def _serialize(self, row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "channel": row["channel"],
            "name": row["name"],
            "target": row["target"],
            "events": _json_list(row["events"]) or ["all"],
            "enabled": bool(row["enabled"]),
            "created_at": row["created_at"],
            "last_sent_at": row["last_sent_at"],
            "last_status": row["last_status"],
        }

    def add_channel(self, payload: dict[str, Any]) -> dict[str, Any]:
        channel = str(payload.get("channel") or "webhook").strip().lower()
        if channel not in {"webhook", "bark", "dingtalk"}:
            raise ValueError("暂只支持通用 Webhook / Bark / 钉钉机器人")
        target = str(payload.get("target") or "").strip()
        if not target.lower().startswith(("http://", "https://")):
            raise ValueError("推送地址必须以 http:// 或 https:// 开头")
        events = payload.get("events") or ["all"]
        if isinstance(events, str):
            events = [item.strip() for item in events.split(",") if item.strip()]
        events = [item for item in events if item in EVENT_TEXT or item == "all"] or ["all"]
        now = db.now()
        channel_id = db.execute(
            "INSERT INTO notifications(channel, name, target, events, enabled, "
            "created_at, updated_at) VALUES(?,?,?,?,1,?,?)",
            (
                channel,
                str(payload.get("name") or "默认渠道")[:60],
                target[:500],
                json.dumps(events, ensure_ascii=False),
                now,
                now,
            ),
        )
        return self._serialize(
            db.query_one("SELECT * FROM notifications WHERE id=?", (channel_id,))
        )

    def update_channel(self, channel_id: int, payload: dict[str, Any]) -> dict[str, Any]:
        row = db.query_one("SELECT * FROM notifications WHERE id=?", (channel_id,))
        if row is None:
            raise KeyError(f"通知渠道不存在: {channel_id}")
        updates: dict[str, Any] = {}
        if "name" in payload:
            updates["name"] = str(payload.get("name") or "")[:60]
        if "target" in payload:
            target = str(payload.get("target") or "").strip()
            if not target.lower().startswith(("http://", "https://")):
                raise ValueError("推送地址必须以 http:// 或 https:// 开头")
            updates["target"] = target[:500]
        if "enabled" in payload:
            updates["enabled"] = 1 if payload.get("enabled") else 0
        if "events" in payload:
            events = payload.get("events") or ["all"]
            if isinstance(events, str):
                events = [item.strip() for item in events.split(",") if item.strip()]
            events = [item for item in events if item in EVENT_TEXT or item == "all"] or ["all"]
            updates["events"] = json.dumps(events, ensure_ascii=False)
        if not updates:
            return self._serialize(row)
        updates["updated_at"] = db.now()
        assignments = ", ".join(f"{key} = ?" for key in updates)
        db.execute(
            f"UPDATE notifications SET {assignments} WHERE id = ?",
            (*updates.values(), channel_id),
        )
        return self._serialize(
            db.query_one("SELECT * FROM notifications WHERE id=?", (channel_id,))
        )

    def delete_channel(self, channel_id: int) -> None:
        db.execute("DELETE FROM notifications WHERE id=?", (channel_id,))

    def test_channel(self, channel_id: int) -> dict[str, Any]:
        row = db.query_one("SELECT * FROM notifications WHERE id=?", (channel_id,))
        if row is None:
            raise KeyError(f"通知渠道不存在: {channel_id}")
        ok, message = self._send(
            self._serialize(row),
            {
                "event": "test",
                "event_text": "测试通知",
                "title": "应声运营 · 测试通知",
                "message": "收到这条说明通知渠道可用。",
                "level": "info",
                "created_at": db.now(),
            },
        )
        return {"ok": ok, "message": message}

    # ------------------------------------------------------------ 推送

    def _dispatch(self, item: dict[str, Any]) -> None:
        for channel in self.list_channels():
            if not channel["enabled"]:
                continue
            events = channel["events"]
            if "all" not in events and item["event"] not in events:
                continue
            try:
                ok, message = self._send(channel, item)
            except Exception:  # noqa: BLE001
                logger.exception(f"通知渠道 {channel['id']} 推送异常")
                ok, message = False, "推送异常（详见日志）"
            db.execute(
                "UPDATE notifications SET last_sent_at=?, last_status=? WHERE id=?",
                (
                    db.now(),
                    ("ok" if ok else message[:200]),
                    channel["id"],
                ),
            )

    def _send(self, channel: dict[str, Any], item: dict[str, Any]) -> tuple[bool, str]:
        target = channel["target"]
        kind = channel["channel"]
        title = str(item.get("title") or "")
        text = str(item.get("message") or "")
        started = time.time()
        try:
            if kind == "dingtalk":
                payload = {"msgtype": "text", "text": {"content": f"{title}\n{text}"}}
                response = requests.post(
                    target, json=payload, timeout=WEBHOOK_TIMEOUT
                )
            elif kind == "bark":
                # Bark 兼容：把标题和正文拼到路径上，也接受完整 URL。
                url = target.rstrip("/")
                response = requests.get(
                    f"{url}/{quote(title)}/{quote(text)}",
                    timeout=WEBHOOK_TIMEOUT,
                )
            else:
                response = requests.post(
                    target,
                    json={
                        "event": item.get("event"),
                        "event_text": item.get("event_text"),
                        "level": item.get("level"),
                        "title": title,
                        "message": text,
                        "at": int(item.get("created_at") or time.time()),
                        "source": "EchoQ-Ops",
                    },
                    timeout=WEBHOOK_TIMEOUT,
                )
        except requests.RequestException as exc:
            logger.warning(f"通知渠道 {channel['id']} 请求失败: {exc.__class__.__name__}")
            return False, "网络不可达或超时"
        latency = int((time.time() - started) * 1000)
        if 200 <= response.status_code < 300:
            return True, f"ok {latency}ms"
        return False, f"HTTP {response.status_code}"


__all__ = ["NotifyCenter", "EVENT_TEXT"]
