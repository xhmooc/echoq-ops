# encoding: utf-8
"""已发布内容：平台作品列表的本地缓存 + 本地发布记录兜底。

两个数据源的分工：

- ``published_notes``：从平台作品列表同步回来的内容与互动数据，是「账号下
  已发布内容」的主视图；
- ``records``：本地发布执行日志，只在平台尚未同步时提供占位条目（标记
  ``source=local_record``），同一 ``remote_note_id`` 不会重复出现。

两者用 ``remote_note_id`` 对齐，因此不需要维护两套内容列表。
"""

from __future__ import annotations

import json
import os
import threading
from datetime import datetime, timedelta
from typing import Any

from loguru import logger

from ops import db
from ops.accounts import AccountManager
from ops.notify import NotifyCenter
from ops.platforms import (
    DEFAULT_PLATFORM,
    get_platform,
    list_platforms,
    normalize,
    platform_label,
)

SYNC_INTERVAL_HOURS = 6
SYNC_PAGE_LIMIT = 30
# 单次同步最多翻多少页；大账号可以调大环境变量，或在接口上传 pages。
SYNC_MAX_PAGES = max(1, int(os.getenv("OPS_SYNC_MAX_PAGES", "20") or 20))
LOCAL_RECORD_LIMIT = 500
# 合并查询的硬上限；超过时接口会明确返回 truncated，而不是静默截断。
PUBLISHED_QUERY_LIMIT = max(100, int(os.getenv("OPS_PUBLISHED_QUERY_LIMIT", "2000") or 2000))


def _int_or_none(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _first_image(images: Any) -> str:
    try:
        items = json.loads(images) if isinstance(images, str) else (images or [])
    except (TypeError, ValueError):
        return ""
    if isinstance(items, list) and items:
        return str(items[0] or "")
    return ""


def _visibility_label(value: Any) -> str:
    try:
        return "仅自己可见" if int(value or 0) == 1 else "公开"
    except (TypeError, ValueError):
        return str(value or "")


def _int(value: Any, default: int = 0) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return default


def _safe_sync_error(text: Any) -> str:
    """历史数据里可能残留异常类名 / 内部 URL，对外统一成中文分类。"""
    value = str(text or "").strip()
    if not value:
        return ""
    lowered = value.lower()
    if any(
        token in lowered
        for token in ("error", "exception", "traceback", "http://", "https://", "curl")
    ):
        return "同步失败，请稍后重试（详见日志）"
    return value[:200]


class PublishedService:
    """已发布内容的同步、查询与账号级同步状态。"""

    def __init__(self, accounts: AccountManager | None = None) -> None:
        self.accounts = accounts or AccountManager()
        self._locks: dict[int, threading.Lock] = {}
        self._locks_guard = threading.Lock()
        self._adapters: dict[str, Any] = {}

    def _adapter(self, platform: str):
        key = platform or DEFAULT_PLATFORM
        adapter = self._adapters.get(key)
        if adapter is None:
            adapter = get_platform(key, self.accounts)
            self._adapters[key] = adapter
        return adapter

    def _lock_for(self, account_id: int) -> threading.Lock:
        with self._locks_guard:
            lock = self._locks.get(account_id)
            if lock is None:
                lock = threading.Lock()
                self._locks[account_id] = lock
            return lock

    @staticmethod
    def _comments_mode(adapter) -> str:
        """read=可直接读；probe=需先探测权限；none=不支持。"""
        mode = str(getattr(adapter, "comments_mode", "") or "").strip()
        if mode in {"read", "probe", "none"}:
            return mode
        return "read" if adapter.features.get("fetch_comments") else "none"

    # ------------------------------------------------------------ 同步

    def sync_account(
        self, account_id: int, pages: int = 2, limit: int = SYNC_PAGE_LIMIT
    ) -> dict[str, Any]:
        """同步一个账号；同一账号已有同步在跑时直接返回，不重复打平台接口。"""
        lock = self._lock_for(int(account_id))
        if not lock.acquire(blocking=False):
            return {
                "ok": False,
                "account_id": int(account_id),
                "fetched": 0,
                "saved": 0,
                "message": "该账号正在同步，请稍后再试",
            }
        try:
            return self._sync_account(account_id, pages=pages, limit=limit)
        finally:
            lock.release()

    def _sync_account(
        self, account_id: int, pages: int = 2, limit: int = SYNC_PAGE_LIMIT
    ) -> dict[str, Any]:
        row = db.query_one("SELECT * FROM accounts WHERE id = ?", (int(account_id),))
        if row is None:
            raise KeyError(f"账号不存在: {account_id}")
        # 同账号正在真实发布时先跳过，避免只读同步与发布并发打平台接口；
        # 发布结束后的下一轮同步会自动补上，不占用发布通道的锁。
        busy = db.query_one(
            "SELECT 1 FROM jobs WHERE account_id = ? AND status = 'running' LIMIT 1",
            (int(account_id),),
        )
        if busy is not None:
            return {
                "ok": False,
                "account_id": int(account_id),
                "account_name": row["nickname"] or row["name"],
                "platform": row["platform"] or DEFAULT_PLATFORM,
                "fetched": 0,
                "saved": 0,
                "skipped": True,
                "message": "账号正在发布，稍后自动重试同步",
            }
        platform = row["platform"] or DEFAULT_PLATFORM
        adapter = self._adapter(platform)
        if not adapter.ready:
            message = f"{adapter.name} 的内容回收接入位尚未实现"
            self._mark_error(row["id"], message)
            return {
                "ok": False,
                "account_id": row["id"],
                "account_name": row["nickname"] or row["name"],
                "platform": platform,
                "fetched": 0,
                "saved": 0,
                "message": message,
            }
        # 同步也计入账号级写间隔，避免紧接着发布再打平台接口。
        self.accounts.mark_action(int(account_id), "sync")

        cursor: Any = 0
        fetched = 0
        saved = 0
        pages_used = 0
        message = ""
        ok = True
        exhausted = False
        next_cursor: Any = None
        for _ in range(max(1, min(SYNC_MAX_PAGES, int(pages or 1)))):
            result = adapter.fetch_published(row, cursor=cursor, limit=limit)
            pages_used += 1
            if not result.get("ok"):
                ok = False
                message = str(result.get("message") or "同步失败")
                break
            items = result.get("items") or []
            fetched += len(items)
            if items:
                saved += self._upsert_items(row, platform, items)
            next_cursor = result.get("next_cursor")
            if next_cursor in (None, "") or not items:
                exhausted = True
                break
            cursor = next_cursor

        truncated = bool(ok and not exhausted)
        now = db.now()
        if ok:
            db.execute(
                "UPDATE accounts SET published_synced_at=?, published_sync_error='', "
                "updated_at=? WHERE id=?",
                (now, now, row["id"]),
            )
            message = f"同步完成：拉取 {fetched} 条，写入 {saved} 条"
            if truncated:
                # 不静默截断：告诉调用方还有更多内容，并给出继续同步的办法。
                message += (
                    f"；已拉取 {pages_used} 页，平台还有更多内容未同步，"
                    "可调大 pages 或调大 OPS_SYNC_MAX_PAGES 后再次同步"
                )
        else:
            self._mark_error(row["id"], message)
        logger.info(f"账号 {row['id']} 已发布内容同步: {message}")
        return {
            "ok": ok,
            "account_id": row["id"],
            "account_name": row["nickname"] or row["name"],
            "platform": platform,
            "fetched": fetched,
            "saved": saved,
            "pages": pages_used,
            "truncated": truncated,
            "next_cursor": next_cursor,
            "message": message,
        }

    def sync_many(
        self, account_ids: list[int] | None = None, pages: int = 2
    ) -> list[dict[str, Any]]:
        if account_ids:
            targets = [int(item) for item in account_ids if item]
        else:
            targets = [
                int(row["id"])
                for row in db.query(
                    "SELECT id FROM accounts WHERE enabled = 1 ORDER BY id"
                )
            ]
        results = []
        for account_id in targets:
            try:
                results.append(self.sync_account(account_id, pages=pages))
            except KeyError as exc:
                results.append({"ok": False, "account_id": account_id, "message": str(exc)})
            except Exception:  # noqa: BLE001
                logger.exception(f"账号 {account_id} 同步异常")
                results.append(
                    {
                        "ok": False,
                        "account_id": account_id,
                        "message": "同步失败，请稍后重试（详见日志）",
                    }
                )
        return results

    def due_accounts(self, hours: int = SYNC_INTERVAL_HOURS) -> list[int]:
        """超过同步间隔且仍启用的账号。"""
        cutoff = db.now() - max(1, int(hours)) * 3600
        rows = db.query(
            "SELECT id FROM accounts WHERE enabled = 1 "
            "AND (published_synced_at = 0 OR published_synced_at < ?) ORDER BY id",
            (cutoff,),
        )
        return [int(row["id"]) for row in rows]

    def _mark_error(self, account_id: int, message: str) -> None:
        db.execute(
            "UPDATE accounts SET published_sync_error=?, updated_at=? WHERE id=?",
            (message[:500], db.now(), account_id),
        )
        try:
            account = db.query_one("SELECT * FROM accounts WHERE id=?", (account_id,))
            name = (account["nickname"] or account["name"]) if account else f"账号 {account_id}"
            NotifyCenter().emit(
                "sync_failed",
                f"内容同步失败：{name}",
                message,
                link_view="accounts",
                link_id=int(account_id),
            )
        except Exception:  # noqa: BLE001
            logger.exception("发送同步失败通知异常")

    def _upsert_items(
        self, account_row, platform: str, items: list[dict[str, Any]]
    ) -> int:
        now = db.now()
        saved = 0
        with db.transaction() as conn:
            for item in items:
                remote_id = str(item.get("remote_note_id") or "").strip()
                if not remote_id:
                    continue
                published_at = _int(item.get("published_at")) or now
                conn.execute(
                    "INSERT INTO published_notes(platform, account_id, remote_note_id, "
                    "title, desc, cover, note_type, visibility, views, likes, comments, "
                    "collects, published_at, url, raw, synced_at, metrics_synced_at, "
                    "created_at, updated_at) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
                    "ON CONFLICT(account_id, remote_note_id) DO UPDATE SET "
                    "title=excluded.title, desc=excluded.desc, cover=excluded.cover, "
                    "note_type=excluded.note_type, visibility=excluded.visibility, "
                    "views=excluded.views, likes=excluded.likes, comments=excluded.comments, "
                    "collects=excluded.collects, published_at=excluded.published_at, "
                    "url=excluded.url, raw=excluded.raw, synced_at=excluded.synced_at, "
                    "metrics_synced_at=excluded.metrics_synced_at, "
                    "updated_at=excluded.updated_at",
                    (
                        platform,
                        account_row["id"],
                        remote_id,
                        str(item.get("title") or "")[:300],
                        str(item.get("desc") or "")[:5000],
                        str(item.get("cover") or ""),
                        str(item.get("note_type") or "image"),
                        str(item.get("visibility") or ""),
                        _int_or_none(item.get("views")),
                        _int_or_none(item.get("likes")),
                        _int_or_none(item.get("comments")),
                        _int_or_none(item.get("collects")),
                        published_at,
                        str(item.get("url") or "")[:500],
                        json.dumps(item.get("raw") or {}, ensure_ascii=False, default=str)[:8000],
                        now,
                        now,
                        now,
                        now,
                    ),
                )
                note_row = conn.execute(
                    "SELECT id FROM published_notes WHERE account_id=? AND remote_note_id=?",
                    (account_row["id"], remote_id),
                ).fetchone()
                if note_row is not None:
                    self._snapshot_metrics(conn, int(note_row["id"]), item, now)
                saved += 1
        return saved

    @staticmethod
    def _snapshot_metrics(conn, note_id: int, item: dict[str, Any], now: int) -> None:
        """按日留一个快照；平台没给的指标保留旧值，不补 0。"""
        metrics = {
            "views": _int_or_none(item.get("views")),
            "likes": _int_or_none(item.get("likes")),
            "comments": _int_or_none(item.get("comments")),
            "collects": _int_or_none(item.get("collects")),
        }
        if not any(value is not None for value in metrics.values()):
            return
        day = datetime.fromtimestamp(now).strftime("%Y-%m-%d")
        conn.execute(
            "INSERT INTO published_metrics_daily(note_id, day, views, likes, comments, "
            "collects, captured_at) VALUES(?,?,?,?,?,?,?) "
            "ON CONFLICT(note_id, day) DO UPDATE SET "
            "views=COALESCE(excluded.views, published_metrics_daily.views), "
            "likes=COALESCE(excluded.likes, published_metrics_daily.likes), "
            "comments=COALESCE(excluded.comments, published_metrics_daily.comments), "
            "collects=COALESCE(excluded.collects, published_metrics_daily.collects), "
            "captured_at=excluded.captured_at",
            (
                note_id,
                day,
                metrics["views"],
                metrics["likes"],
                metrics["comments"],
                metrics["collects"],
                now,
            ),
        )

    # ------------------------------------------------------------ 查询

    def list_notes(
        self,
        *,
        account_id: int = 0,
        platform: str = "",
        since: int = 0,
        until: int = 0,
        keyword: str = "",
        health: str = "",
        limit: int = 20,
        offset: int = 0,
        include_local: bool = True,
    ) -> dict[str, Any]:
        platform_key = normalize(platform) if platform else ""
        limit = max(1, min(100, int(limit or 20)))
        offset = max(0, int(offset or 0))
        since = max(0, int(since or 0))
        until = max(0, int(until or 0))
        keyword_text = str(keyword or "").strip().lower()

        merged: dict[tuple[int, str], dict[str, Any]] = {}
        synced_items, synced_truncated = self._query_synced(
            account_id, platform_key, since, until
        )
        for item in synced_items:
            merged[(int(item["account_id"]), item["remote_note_id"])] = item
        local_truncated = False
        if include_local:
            local_items, local_truncated = self._query_local_records(
                account_id, platform_key, since, until, set(merged)
            )
            for item in local_items:
                merged.setdefault((int(item["account_id"]), item["remote_note_id"]), item)

        items = list(merged.values())
        if keyword_text:
            items = [
                item
                for item in items
                if keyword_text
                in f"{item.get('title') or ''} {item.get('desc') or ''}".lower()
            ]
        health_key = str(health or "").strip()
        if health_key:
            attention = {"zero_views", "risky", "removed"}
            if health_key == "attention":
                items = [item for item in items if item.get("health_state") in attention]
            else:
                items = [item for item in items if item.get("health_state") == health_key]
        items.sort(
            key=lambda item: (int(item.get("published_at") or 0), item.get("remote_note_id") or ""),
            reverse=True,
        )
        total = len(items)
        page = items[offset : offset + limit]
        truncated = bool(synced_truncated or local_truncated)
        notice = ""
        if truncated:
            notice = (
                f"当前筛选结果超过 {PUBLISHED_QUERY_LIMIT} 条平台缓存"
                f"{' / ' + str(LOCAL_RECORD_LIMIT) + ' 条本地记录' if local_truncated else ''}，"
                "列表只统计最近部分内容；请缩窄账号或时间范围后再查看。"
            )
        return {
            "items": page,
            "total": total,
            "limit": limit,
            "offset": offset,
            "filters": {
                "account_id": account_id,
                "platform": platform_key,
                "since": since,
                "until": until,
                "keyword": keyword_text,
                "health": health_key,
                "include_local": bool(include_local),
            },
            "meta": {
                "accounts": self.accounts_status(platform_key),
                "sources": self.sources_meta(),
                "sync_interval_hours": SYNC_INTERVAL_HOURS,
                "truncated": truncated,
                "total_exact": not truncated,
                "query_limit": PUBLISHED_QUERY_LIMIT,
                "truncated_sources": [
                    name
                    for name, hit in (
                        ("platform", synced_truncated),
                        ("local_record", local_truncated),
                    )
                    if hit
                ],
                "notice": notice,
            },
        }

    def _query_synced(
        self, account_id: int, platform: str, since: int, until: int
    ) -> tuple[list[dict[str, Any]], bool]:
        sql = (
            "SELECT p.*, a.name AS account_name, a.nickname AS account_nickname, "
            "a.platform AS account_platform "
            "FROM published_notes p LEFT JOIN accounts a ON a.id = p.account_id WHERE 1=1"
        )
        args: list[Any] = []
        if account_id:
            sql += " AND p.account_id = ?"
            args.append(int(account_id))
        if platform:
            sql += " AND p.platform = ?"
            args.append(platform)
        if since:
            sql += " AND p.published_at >= ?"
            args.append(since)
        if until:
            sql += " AND p.published_at <= ?"
            args.append(until)
        # 多取一条用来判断是否真的被截断，不靠「刚好等于上限」猜。
        sql += " ORDER BY p.published_at DESC, p.id DESC LIMIT ?"
        args.append(PUBLISHED_QUERY_LIMIT + 1)
        rows = db.query(sql, tuple(args))
        truncated = len(rows) > PUBLISHED_QUERY_LIMIT
        rows = rows[:PUBLISHED_QUERY_LIMIT]
        local_map = self._local_map(
            [(int(row["account_id"]), row["remote_note_id"]) for row in rows]
        )
        return [self._synced_item(row, local_map) for row in rows], truncated

    def _synced_item(self, row, local_map: dict[tuple[int, str], dict[str, Any]]) -> dict[str, Any]:
        platform = row["platform"] or DEFAULT_PLATFORM
        adapter = self._adapter(platform)
        local = local_map.get((int(row["account_id"]), row["remote_note_id"])) or {}
        return {
            "id": row["id"],
            "platform": platform,
            "platform_name": platform_label(platform),
            "account_id": row["account_id"],
            "account_name": row["account_nickname"] or row["account_name"] or "",
            "remote_note_id": row["remote_note_id"],
            "title": row["title"],
            "desc": row["desc"],
            "cover": row["cover"],
            "cover_kind": "remote",
            "note_type": row["note_type"],
            "visibility": row["visibility"] or "平台未返回",
            "views": row["views"],
            "likes": row["likes"],
            "comments": row["comments"],
            "collects": row["collects"],
            "metrics_available": any(
                row[name] is not None for name in ("views", "likes", "comments", "collects")
            ),
            "published_at": row["published_at"],
            "url": row["url"] or adapter.note_url(row["remote_note_id"]),
            "source": "platform",
            "needs_sync": False,
            "synced_at": row["synced_at"],
            "metrics_synced_at": int(row["metrics_synced_at"] or 0),
            "comment_synced_at": int(row["comment_synced_at"] or 0),
            "health_state": row["health_state"] or "unknown",
            "health_note": row["health_note"] or "",
            "health_checked_at": int(row["health_checked_at"] or 0),
            "comments_supported": (
                True
                if self._comments_mode(adapter) == "read"
                else (None if self._comments_mode(adapter) == "probe" else False)
            ),
            "comments_mode": self._comments_mode(adapter),
            "local_draft_id": local.get("draft_id"),
            "local_draft_title": local.get("draft_title") or "",
        }

    def _query_local_records(
        self,
        account_id: int,
        platform: str,
        since: int,
        until: int,
        exclude: set[tuple[int, str]],
    ) -> tuple[list[dict[str, Any]], bool]:
        """真实发布成功、但平台列表还没同步到的记录，先以本地条目占位。"""
        sql = (
            "SELECT r.id, r.account_id, r.platform, r.draft_id, r.remote_note_id, "
            "r.created_at, d.title AS draft_title, d.desc AS draft_desc, "
            "d.visibility AS draft_visibility, d.images AS draft_images, "
            "d.media_type AS draft_media, a.name AS account_name, "
            "a.nickname AS account_nickname "
            "FROM records r "
            "LEFT JOIN drafts d ON d.id = r.draft_id "
            "LEFT JOIN accounts a ON a.id = r.account_id "
            "WHERE r.success = 1 AND r.remote_note_id != '' "
            "AND r.message NOT LIKE '模拟发布%' "
            "AND IFNULL(r.result, '') NOT LIKE '%simulated%'"
        )
        args: list[Any] = []
        if account_id:
            sql += " AND r.account_id = ?"
            args.append(int(account_id))
        if platform:
            sql += " AND r.platform = ?"
            args.append(platform)
        if since:
            sql += " AND r.created_at >= ?"
            args.append(since)
        if until:
            sql += " AND r.created_at <= ?"
            args.append(until)
        sql += " ORDER BY r.id DESC LIMIT ?"
        args.append(LOCAL_RECORD_LIMIT + 1)
        rows = db.query(sql, tuple(args))
        truncated = len(rows) > LOCAL_RECORD_LIMIT
        rows = rows[:LOCAL_RECORD_LIMIT]
        items = []
        for row in rows:
            key = (int(row["account_id"]), row["remote_note_id"])
            if key in exclude:
                continue
            platform_key = row["platform"] or DEFAULT_PLATFORM
            adapter = self._adapter(platform_key)
            items.append(
                {
                    "id": None,
                    "platform": platform_key,
                    "platform_name": platform_label(platform_key),
                    "account_id": row["account_id"],
                    "account_name": row["account_nickname"] or row["account_name"] or "",
                    "remote_note_id": row["remote_note_id"],
                    "title": row["draft_title"] or "(草稿已删除)",
                    "desc": row["draft_desc"] or "",
                    "cover": _first_image(row["draft_images"]),
                    "cover_kind": "local",
                    "note_type": row["draft_media"] or "image",
                    "visibility": _visibility_label(row["draft_visibility"]),
                    "views": None,
                    "likes": None,
                    "comments": None,
                    "collects": None,
                    "metrics_available": False,
                    "published_at": row["created_at"],
                    "url": adapter.note_url(row["remote_note_id"]),
                    "source": "local_record",
                    "needs_sync": True,
                    "synced_at": 0,
                    "metrics_synced_at": 0,
                    "comment_synced_at": 0,
                    "health_state": "unknown",
                    "health_note": "尚未同步到平台数据",
                    "health_checked_at": 0,
                    "comments_supported": (
                        True
                        if self._comments_mode(adapter) == "read"
                        else (None if self._comments_mode(adapter) == "probe" else False)
                    ),
                    "comments_mode": self._comments_mode(adapter),
                    "local_draft_id": row["draft_id"],
                    "local_draft_title": row["draft_title"] or "",
                }
            )
        return items, truncated

    def _local_map(self, keys: list[tuple[int, str]]) -> dict[tuple[int, str], dict[str, Any]]:
        """给平台条目补本地草稿关联（同一远端 ID 取最新一条成功记录）。"""
        if not keys:
            return {}
        placeholders = ",".join("?" for _ in keys)
        rows = db.query(
            "SELECT r.account_id, r.remote_note_id, r.draft_id, d.title AS draft_title "
            "FROM records r LEFT JOIN drafts d ON d.id = r.draft_id "
            f"WHERE r.success = 1 AND r.remote_note_id IN ({placeholders}) "
            "AND r.message NOT LIKE '模拟发布%' ORDER BY r.id DESC",
            tuple(remote for _, remote in keys),
        )
        mapping: dict[tuple[int, str], dict[str, Any]] = {}
        for row in rows:
            mapping.setdefault(
                (int(row["account_id"]), row["remote_note_id"]),
                {"draft_id": row["draft_id"], "draft_title": row["draft_title"] or ""},
            )
        return mapping

    # ------------------------------------------------------------ 作品健康

    HEALTH_TEXT = {
        "unknown": "未判断",
        "normal": "正常",
        "zero_views": "零浏览",
        "risky": "数据异常",
        "removed": "疑似下架",
    }

    def _note_row(self, note_id: int):
        row = db.query_one("SELECT * FROM published_notes WHERE id=?", (int(note_id),))
        if row is None:
            raise KeyError(f"作品不存在: {note_id}")
        return row

    def health_check(self, account_id: int = 0) -> dict[str, Any]:
        """对已同步作品做规则判断，异常写站内提醒；不改动平台数据。"""
        sql = "SELECT * FROM published_notes"
        args: tuple[Any, ...] = ()
        if account_id:
            sql += " WHERE account_id = ?"
            args = (int(account_id),)
        rows = db.query(sql, args)
        now = db.now()
        counts: dict[str, int] = {}
        for row in rows:
            state, note = self._judge_health(row, now)
            db.execute(
                "UPDATE published_notes SET health_state=?, health_checked_at=?, "
                "health_note=?, updated_at=? WHERE id=?",
                (state, now, note[:300], now, row["id"]),
            )
            counts[state] = counts.get(state, 0) + 1
            if state in {"zero_views", "risky", "removed"}:
                try:
                    NotifyCenter().emit(
                        "note_abnormal",
                        f"作品异常：{row['title'] or row['remote_note_id']}",
                        f"{self.HEALTH_TEXT.get(state, state)}：{note}",
                        link_view="published",
                        link_id=int(row["id"]),
                        dedupe_sec=86400,
                    )
                except Exception:  # noqa: BLE001
                    logger.exception("发送作品异常通知失败")
        return {
            "checked": len(rows),
            "counts": counts,
            "message": f"已检查 {len(rows)} 篇作品",
        }

    def _judge_health(self, row, now: int) -> tuple[str, str]:
        text = f"{row['visibility'] or ''} {row['raw'] or ''}"
        if any(word in text for word in ("已被删除", "已删除", "下架")):
            return "removed", "平台返回了删除或下架状态"
        if any(word in text for word in ("违规", "审核不通过")):
            return "risky", "平台标记为违规、审核未通过或不可公开访问"
        views = row["views"]
        if views is None:
            return "unknown", "平台未返回浏览量，暂无法判断"
        age = now - int(row["published_at"] or now)
        if int(views) == 0 and age > 86400:
            return "zero_views", "发布超过 24 小时仍为 0 浏览"
        # 累计浏览量出现明显回落，通常意味着限流、删除或数据异常。
        snapshots = db.query(
            "SELECT views FROM published_metrics_daily WHERE note_id=? "
            "AND views IS NOT NULL ORDER BY day DESC LIMIT 8",
            (row["id"],),
        )
        if len(snapshots) >= 2:
            latest = int(snapshots[0]["views"] or 0)
            previous = [int(item["views"] or 0) for item in snapshots[1:]]
            avg = sum(previous) / len(previous)
            if avg >= 20 and latest < avg * 0.5:
                drop = int((1 - latest / avg) * 100)
                return "risky", f"浏览量较前期下降 {drop}%"
        if int(views) == 0:
            return "normal", "刚发布，暂不判断"
        return "normal", "数据正常"

    # ------------------------------------------------------------ 指标趋势

    def metrics(self, note_id: int, days: int = 30) -> dict[str, Any]:
        """单篇作品的按日趋势；平台缺数据的日期返回 null（断点，不补 0）。"""
        note = self._note_row(note_id)
        days = max(1, min(90, int(days or 30)))
        today = datetime.now().date()
        start = today - timedelta(days=days - 1)
        rows = db.query(
            "SELECT * FROM published_metrics_daily WHERE note_id=? AND day >= ? "
            "ORDER BY day",
            (int(note_id), start.strftime("%Y-%m-%d")),
        )
        by_day = {row["day"]: row for row in rows}
        series = []
        missing = 0
        for offset in range(days):
            day = start + timedelta(days=offset)
            key = day.strftime("%Y-%m-%d")
            row = by_day.get(key)
            if row is None and key == today.strftime("%Y-%m-%d"):
                # 还没有当天快照时，用当前值补最后一个点，便于看最新状态。
                if any(
                    note[name] is not None
                    for name in ("views", "likes", "comments", "collects")
                ):
                    series.append(
                        {
                            "day": key,
                            "views": note["views"],
                            "likes": note["likes"],
                            "comments": note["comments"],
                            "collects": note["collects"],
                        }
                    )
                    continue
            if row is None:
                missing += 1
                series.append(
                    {
                        "day": key,
                        "views": None,
                        "likes": None,
                        "comments": None,
                        "collects": None,
                    }
                )
            else:
                series.append(
                    {
                        "day": key,
                        "views": row["views"],
                        "likes": row["likes"],
                        "comments": row["comments"],
                        "collects": row["collects"],
                    }
                )
        return {
            "note": {
                "id": note["id"],
                "title": note["title"],
                "remote_note_id": note["remote_note_id"],
                "platform": note["platform"],
                "platform_name": platform_label(note["platform"]),
                "url": note["url"],
            },
            "days": days,
            "series": series,
            "missing_days": missing,
            "current": {
                "views": note["views"],
                "likes": note["likes"],
                "comments": note["comments"],
                "collects": note["collects"],
                "captured_at": int(note["metrics_synced_at"] or note["synced_at"] or 0),
            },
            "hint": "平台未返回的日期显示为断点，不按 0 处理。",
        }

    # ------------------------------------------------------------ 评论（只读）

    def sync_comments(self, note_id: int, pages: int = 3) -> dict[str, Any]:
        """手动/定时同步作品评论；严格只读，不回复、不点赞、不删除。"""
        note = self._note_row(note_id)
        platform = note["platform"] or DEFAULT_PLATFORM
        adapter = self._adapter(platform)
        mode = self._comments_mode(adapter)
        if mode == "none":
            raise ValueError(f"{platform_label(platform)} 暂不支持评论同步")
        account = db.query_one("SELECT * FROM accounts WHERE id=?", (note["account_id"],))
        if account is None:
            raise ValueError("作品所属账号已删除，无法同步评论")
        result = adapter.fetch_comments(account, note, pages=max(1, min(10, int(pages or 3))))
        if not result.get("ok"):
            raise ValueError(str(result.get("message") or "评论同步失败"))
        items = result.get("items") or []
        now = db.now()
        saved = 0
        with db.transaction() as conn:
            for item in items:
                comment_id = str(item.get("remote_comment_id") or "").strip()
                if not comment_id:
                    continue
                conn.execute(
                    "INSERT INTO note_comments(platform, account_id, remote_note_id, "
                    "remote_comment_id, author, author_id, content, likes, is_reply, "
                    "parent_comment_id, commented_at, synced_at) "
                    "VALUES(?,?,?,?,?,?,?,?,?,?,?,?) "
                    "ON CONFLICT(platform, remote_note_id, remote_comment_id) DO UPDATE SET "
                    "author=excluded.author, author_id=excluded.author_id, "
                    "content=excluded.content, likes=excluded.likes, "
                    "is_reply=excluded.is_reply, parent_comment_id=excluded.parent_comment_id, "
                    "commented_at=excluded.commented_at, synced_at=excluded.synced_at",
                    (
                        platform,
                        note["account_id"],
                        note["remote_note_id"],
                        comment_id,
                        str(item.get("author") or "")[:100],
                        str(item.get("author_id") or "")[:100],
                        str(item.get("content") or "")[:2000],
                        _int_or_none(item.get("likes")),
                        1 if item.get("is_reply") else 0,
                        str(item.get("parent_comment_id") or "")[:100],
                        _int(item.get("commented_at")),
                        now,
                    ),
                )
                saved += 1
            conn.execute(
                "UPDATE published_notes SET comment_synced_at=?, updated_at=? WHERE id=?",
                (now, now, note["id"]),
            )
        total = int(
            db.scalar(
                "SELECT COUNT(*) FROM note_comments WHERE platform=? AND remote_note_id=?",
                (platform, note["remote_note_id"]),
                0,
            )
            or 0
        )
        return {
            "ok": True,
            "note_id": note["id"],
            "fetched": len(items),
            "saved": saved,
            "total": total,
            "synced_at": now,
            "message": (
                f"同步完成：拉取 {len(items)} 条，缓存 {total} 条"
                if items
                else "平台暂未展示评论"
            ),
        }

    def list_comments(
        self, note_id: int, limit: int = 20, offset: int = 0
    ) -> dict[str, Any]:
        note = self._note_row(note_id)
        platform = note["platform"] or DEFAULT_PLATFORM
        adapter = self._adapter(platform)
        limit = max(1, min(100, int(limit or 20)))
        offset = max(0, int(offset or 0))
        rows = db.query(
            "SELECT * FROM note_comments WHERE platform=? AND remote_note_id=? "
            "ORDER BY commented_at DESC, id DESC LIMIT ? OFFSET ?",
            (platform, note["remote_note_id"], limit, offset),
        )
        total = int(
            db.scalar(
                "SELECT COUNT(*) FROM note_comments WHERE platform=? AND remote_note_id=?",
                (platform, note["remote_note_id"]),
                0,
            )
            or 0
        )
        supported = bool(adapter.features.get("fetch_comments"))
        only_featured = platform == "wechat_mp"
        mode = self._comments_mode(adapter)
        supported_value: bool | None = (
            True if mode == "read" else (None if mode == "probe" else False)
        )
        if total:
            empty_text = ""
        elif mode == "probe":
            empty_text = (
                "还没有缓存公众号精选留言；点「探测并同步」确认是否有留言权限。"
            )
        elif mode == "none":
            empty_text = f"{platform_label(platform)} 暂不支持评论同步"
        else:
            empty_text = "平台未展示评论"
        return {
            "note_id": note["id"],
            "title": note["title"],
            "platform": platform,
            "platform_name": platform_label(platform),
            "supported": supported_value,
            "comments_mode": mode,
            "only_featured": only_featured,
            "notice": (
                "公众号只能读取精选留言，不是全量评论；首次点「探测并同步」会确认权限。"
                if only_featured
                else ("严格只读：不回复、不点赞、不删除。" if supported else "")
            ),
            "items": [
                {
                    "id": row["id"],
                    "remote_comment_id": row["remote_comment_id"],
                    "author": row["author"],
                    "content": row["content"],
                    "likes": row["likes"],
                    "is_reply": bool(row["is_reply"]),
                    "parent_comment_id": row["parent_comment_id"],
                    "commented_at": row["commented_at"],
                    "synced_at": row["synced_at"],
                }
                for row in rows
            ],
            "total": total,
            "limit": limit,
            "offset": offset,
            "synced_at": int(note["comment_synced_at"] or 0),
            "empty_text": empty_text,
        }

    def due_for_comments(self, hours: int = 0) -> int | None:
        """低频定时评论同步；只挑选支持评论的平台。"""
        interval = int(hours) or db.get_int_setting("comment_sync_hours", 12)
        cutoff = db.now() - max(1, interval) * 3600
        rows = db.query(
            "SELECT p.id, p.platform FROM published_notes p "
            "JOIN accounts a ON a.id = p.account_id "
            "WHERE a.enabled = 1 AND (p.comment_synced_at = 0 OR p.comment_synced_at < ?) "
            "ORDER BY p.comment_synced_at ASC LIMIT 12",
            (cutoff,),
        )
        for row in rows:
            # 自动同步只跑可直接读取的平台；probe（公众号）留给用户手动探测。
            if self._comments_mode(self._adapter(row["platform"])) == "read":
                return int(row["id"])
        return None

    # ------------------------------------------------------------ 状态与来源

    def accounts_status(self, platform: str = "") -> list[dict[str, Any]]:
        sql = "SELECT * FROM accounts"
        args: tuple[Any, ...] = ()
        if platform:
            sql += " WHERE platform = ?"
            args = (normalize(platform),)
        sql += " ORDER BY id"
        result = []
        for row in db.query(sql, args):
            platform_key = row["platform"] or DEFAULT_PLATFORM
            adapter = self._adapter(platform_key)
            count = int(
                db.scalar(
                    "SELECT COUNT(*) FROM published_notes WHERE account_id = ?",
                    (row["id"],),
                    0,
                )
            )
            result.append(
                {
                    "account_id": row["id"],
                    "account_name": row["nickname"] or row["name"],
                    "platform": platform_key,
                    "platform_name": platform_label(platform_key),
                    "enabled": bool(row["enabled"]),
                    "ready": adapter.ready,
                    "synced_at": row["published_synced_at"],
                    "sync_error": _safe_sync_error(row["published_sync_error"]),
                    "cached_count": count,
                }
            )
        return result

    def sources_meta(self) -> dict[str, Any]:
        platforms = {
            item["key"]: {
                "name": item["name"],
                "ready": item["ready"],
                "data_sources": item["data_sources"],
            }
            for item in list_platforms()
        }
        return {
            "from_platform": [
                "封面、标题、发布时间、笔记类型",
                "阅读/播放、点赞、评论、收藏",
                "原帖链接（由远端笔记 ID 拼接）",
                "可见范围（平台返回时使用，缺失时显示「平台未返回」）",
            ],
            "local_only": [
                "草稿关联（local_draft_id / local_draft_title）",
                "发布账号与发布执行时间",
                "模拟发布标记（模拟记录不会出现在已发布内容里）",
            ],
            "merge_rule": "同一账号的同一 remote_note_id 只出现一次；平台同步优先，未同步的真实记录以 source=local_record 占位。",
            "sync": {
                "interval_hours": SYNC_INTERVAL_HOURS,
                "max_pages_per_run": SYNC_MAX_PAGES,
                "page_size": SYNC_PAGE_LIMIT,
                "manual": "POST /api/published/sync",
                "failure": "同步失败写入账号的 sync_error，页面展示最近一次错误；已缓存内容不受影响。",
                "truncation": (
                    f"单次同步默认翻 {SYNC_MAX_PAGES} 页；平台还有更多内容时结果里 "
                    "truncated=true，可调大 pages 或 OPS_SYNC_MAX_PAGES 继续。"
                    f"列表查询上限 {PUBLISHED_QUERY_LIMIT} 条，超过时 meta.truncated=true 并给出提示。"
                ),
            },
            "platforms": platforms,
        }


__all__ = ["PublishedService", "SYNC_INTERVAL_HOURS"]

