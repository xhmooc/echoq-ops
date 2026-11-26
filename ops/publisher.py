# encoding: utf-8
"""批量发布队列。

一次草稿只允许一条队列记录（``jobs.draft_id`` 唯一），领取用条件更新完成，
多进程/多线程都不会重复发布。失败分五类处理：
- 账号失效：标记账号过期，换号重试；
- 内容错误：直接失败，不浪费重试次数；
- 平台改版：直接失败，等人工更新适配器，不自动重试；
- 限流：至少退避 15 分钟后重试；
- 网络：指数退避重试。
"""

from __future__ import annotations

import json
import re
import time
import uuid
from pathlib import Path
from typing import Any

from loguru import logger

from ops import config, db
from ops.accounts import AccountManager
from ops.content import DraftService
from ops.notify import NotifyCenter
from ops.platforms import DEFAULT_PLATFORM, get_platform, normalize, platform_label

AUTH_HINTS = ("登录", "未登录", "401", "web_session", "无登录信息", "session")
RATE_HINTS = ("频繁", "风控", "限流", "稍后", "406", "429", "code=-1", "code\":-1")
CONTENT_HINTS = (
    "requires noteInfo",
    "图片不存在",
    "文件不存在",
    "未找到话题",
    "标题",
    "参数错误",
    "-9059",
)
PLATFORM_HINTS = (
    "平台页面",
    "页面结构",
    "接口变更",
    "接口可能已改版",
    "平台可能已改版",
    "找不到发布按钮",
    "找不到上传",
    "upstream_changed",
)

_HEX24 = re.compile(r"^[0-9a-f]{24}$")


def parse_when(value: Any) -> int:
    """接受 epoch 秒、毫秒或 "YYYY-MM-DD HH:MM[:SS]" 字符串。"""
    if value in (None, "", 0, "0"):
        return 0
    if isinstance(value, (int, float)):
        number = int(value)
        return number // 1000 if number > 10_000_000_000 else number
    text = str(value).strip()
    if text.isdigit():
        return parse_when(int(text))
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return int(time.mktime(time.strptime(text, fmt)))
        except ValueError:
            continue
    raise ValueError(f"无法识别的时间: {value}")


def classify_error(message: str, result: Any) -> str:
    text = f"{message} {json.dumps(result, ensure_ascii=False, default=str)[:800]}"
    for hint in AUTH_HINTS:
        if hint in text:
            return "auth"
    for hint in CONTENT_HINTS:
        if hint in text:
            return "content"
    for hint in RATE_HINTS:
        if hint in text:
            return "rate"
    if any(hint in text for hint in PLATFORM_HINTS):
        return "platform"
    return "network"


def find_note_id(payload: Any, depth: int = 0) -> str:
    """从发布结果里找远端内容 ID，兼容小红书/抖音/公众号。"""
    if depth > 6:
        return ""
    if isinstance(payload, dict):
        for key in ("remote_note_id", "note_id", "noteId", "aweme_id", "awemeId", "id"):
            value = str(payload.get(key) or "")
            if not value:
                continue
            if _HEX24.match(value) or (value.isdigit() and len(value) >= 6):
                return value
        for value in payload.values():
            found = find_note_id(value, depth + 1)
            if found:
                return found
    elif isinstance(payload, list):
        for item in payload:
            found = find_note_id(item, depth + 1)
            if found:
                return found
    return ""


class PublishQueue:
    def __init__(
        self,
        accounts: AccountManager | None = None,
        drafts: DraftService | None = None,
        notify: NotifyCenter | None = None,
    ) -> None:
        self.accounts = accounts or AccountManager()
        self.drafts = drafts or DraftService()
        self.notify = notify or NotifyCenter()

    # ------------------------------------------------------------ 队列

    def _enqueue_one(
        self,
        conn,
        draft_id: int,
        account_id: int | None,
        scheduled: int,
        next_run: int,
        now: int,
        platform: str = DEFAULT_PLATFORM,
    ):
        """在已有事务里写入/复用一条队列任务，返回 (row, existed, already_done)。"""
        max_attempts = db.get_int_setting("job_max_attempts", 4)
        reason = "已排期，等待到点" if scheduled > now + 60 else ""
        conn.execute(
            "INSERT INTO jobs(draft_id, account_id, platform, status, attempts, max_attempts, "
            "next_run_at, scheduled_at, last_error, blocked_reason, blocked_at, "
            "created_at, updated_at) "
            "VALUES(?,?,?, 'pending', 0, ?, ?, ?, '', ?, ?, ?, ?) ON CONFLICT DO NOTHING",
            (
                draft_id,
                account_id,
                platform,
                max_attempts,
                next_run,
                scheduled,
                reason,
                now if reason else 0,
                now,
                now,
            ),
        )
        row = conn.execute(
            "SELECT * FROM jobs WHERE draft_id = ? AND account_id IS ?",
            (draft_id, account_id),
        ).fetchone()
        if row["status"] == "success":
            return row, True, True
        existed = row["status"] in {"pending", "retry", "running", "pending_confirm"}
        if not existed:
            conn.execute(
                "UPDATE jobs SET status='pending', attempts=0, scheduled_at=?, "
                "next_run_at=?, last_error='', blocked_reason='', blocked_at=0, "
                "result_state='normal', confirm_deadline=0, submitted_at=0, "
                "updated_at=? WHERE id=?",
                (scheduled, next_run, now, row["id"]),
            )
        return row, existed, False

    def enqueue(
        self,
        draft_id: int,
        account_id: int | None = None,
        scheduled_at: Any = 0,
    ) -> dict[str, Any]:
        draft = self.drafts.get(draft_id)
        if draft["status"] == "published":
            raise ValueError("该草稿已发布")
        platform = self._ready_platform(draft)
        if account_id is not None:
            self._check_account_platform(int(account_id), platform)
        active = db.query_one(
            "SELECT * FROM jobs WHERE draft_id = ? "
            "AND status IN ('pending','retry','running','pending_confirm') ORDER BY id LIMIT 1",
            (draft_id,),
        )
        if active and (account_id is None or active["account_id"] in (None, account_id)):
            return {**self.serialize(active), "existed": True}
        if active:
            raise ValueError("该草稿已在发布队列中，请先在队列里取消")
        scheduled = parse_when(scheduled_at)
        now = db.now()
        next_run = max(now, scheduled) if scheduled else now
        with db.transaction() as conn:
            row, existed, already_done = self._enqueue_one(
                conn, draft_id, account_id, scheduled, next_run, now, platform
            )
            if already_done:
                raise ValueError("该草稿已经发布成功，无需重复入队")
            conn.execute(
                "UPDATE drafts SET status='queued', account_id=COALESCE(?, account_id), "
                "updated_at=? WHERE id=? AND status != 'published'",
                (account_id, now, draft_id),
            )
            job_id = int(row["id"])
        return {**self.serialize(self._get_job(job_id)), "existed": existed}

    def enqueue_targets(
        self,
        draft_id: int,
        account_ids: list[int],
        scheduled_at: Any = 0,
    ) -> list[dict[str, Any]]:
        """一稿多号：同一草稿一次性投递到多个指定账号，重复投递保持幂等。"""
        draft = self.drafts.get(draft_id)
        if draft["status"] == "published":
            raise ValueError("该草稿已发布")
        platform = self._ready_platform(draft)
        targets = list(dict.fromkeys(int(item) for item in account_ids if item))
        if not targets:
            raise ValueError("请至少选择一个账号")
        for account_id in targets:
            self._check_account_platform(account_id, platform)
        scheduled = parse_when(scheduled_at)
        now = db.now()
        next_run = max(now, scheduled) if scheduled else now
        job_ids: list[int] = []
        with db.transaction() as conn:
            for account_id in targets:
                row, _, already_done = self._enqueue_one(
                    conn, draft_id, account_id, scheduled, next_run, now, platform
                )
                if already_done:
                    continue
                job_ids.append(int(row["id"]))
            if not job_ids:
                raise ValueError("所选账号都已经发布过这篇草稿")
            conn.execute(
                "UPDATE drafts SET status='queued', updated_at=? "
                "WHERE id=? AND status != 'published'",
                (now, draft_id),
            )
        return [
            item
            for item in (self.serialize(self._get_job(job_id)) for job_id in job_ids)
            if item
        ]

    def _ready_platform(self, draft: dict[str, Any]) -> str:
        """草稿所属平台必须已经接入发布，否则只允许保存、不能入队。"""
        platform = normalize(draft.get("platform"))
        adapter = get_platform(platform, self.accounts)
        if not adapter.ready:
            raise ValueError(
                f"{adapter.name} 的发布接入位已预留，暂时只能保存草稿；"
                "接好登录与发布后即可直接使用。"
            )
        return platform

    @staticmethod
    def _check_account_platform(account_id: int, platform: str) -> None:
        row = db.query_one("SELECT platform FROM accounts WHERE id = ?", (account_id,))
        if row is None:
            raise ValueError(f"账号不存在: {account_id}")
        account_platform = row["platform"] or DEFAULT_PLATFORM
        if account_platform != platform:
            raise ValueError(
                f"草稿属于{platform_label(platform)}，但账号属于"
                f"{platform_label(account_platform)}；请选择同平台账号。"
            )

    def cancel(self, job_id: int) -> dict[str, Any]:
        job = self._get_job(job_id)
        if job["status"] == "pending_confirm":
            raise ValueError("结果待确认的任务不能直接取消，请先确认已发布或未发布")
        if job["status"] not in {"pending", "retry"}:
            raise ValueError("只有等待中的任务可以取消")
        db.execute(
            "UPDATE jobs SET status='cancelled', blocked_reason='', blocked_at=0, "
            "updated_at=? WHERE id=?",
            (db.now(), job_id),
        )
        other = db.scalar(
            "SELECT COUNT(*) FROM jobs WHERE draft_id=? AND id!=? "
            "AND status IN ('pending','retry','running','pending_confirm')",
            (job["draft_id"], job_id),
            0,
        )
        if not other:
            success = db.scalar(
                "SELECT COUNT(*) FROM jobs WHERE draft_id=? AND status='success'",
                (job["draft_id"],),
                0,
            )
            db.execute(
                "UPDATE drafts SET status=?, updated_at=? WHERE id=?",
                ("published" if success else "draft", db.now(), job["draft_id"]),
            )
        return self.serialize(self._get_job(job_id))

    def retry(self, job_id: int) -> dict[str, Any]:
        job = self._get_job(job_id)
        if job["status"] == "pending_confirm":
            raise ValueError("结果待确认的任务不会自动重试，请先人工确认发布结果")
        if job["status"] not in {"failed", "cancelled"}:
            raise ValueError("只有失败或已取消的任务可以重试")
        db.execute(
            "UPDATE jobs SET status='pending', attempts=0, next_run_at=?, "
            "last_error='', blocked_reason='', blocked_at=0, "
            "result_state='normal', confirm_deadline=0, submitted_at=0, "
            "updated_at=? WHERE id=?",
            (db.now(), db.now(), job_id),
        )
        db.execute(
            "UPDATE drafts SET status='queued', updated_at=? WHERE id=?",
            (db.now(), job["draft_id"]),
        )
        return self.serialize(self._get_job(job_id))

    def confirm(self, job_id: int, published: bool) -> dict[str, Any]:
        """人工确认「结果待确认」的任务：已发布记成功，未发布允许重试。

        这是唯一能把 pending_confirm 带出等待态的动作，队列不会自动重试，
        因此不会重复发布到平台。
        """
        job = self._get_job(job_id)
        if job["status"] != "pending_confirm":
            raise ValueError("只有结果待确认的任务需要人工确认")
        now = db.now()
        account = (
            db.query_one("SELECT * FROM accounts WHERE id=?", (job["account_id"],))
            if job["account_id"]
            else None
        )
        if published:
            count_quota = (job["platform"] or DEFAULT_PLATFORM) != "wechat_mp"
            with db.transaction() as conn:
                conn.execute(
                    "UPDATE jobs SET status='success', result_state='normal', "
                    "confirm_deadline=0, last_error='', blocked_reason='', updated_at=? "
                    "WHERE id=?",
                    (now, job_id),
                )
                self._settle_draft(conn, job["draft_id"], now)
                if account is not None:
                    conn.execute(
                        "UPDATE accounts SET status='healthy', health_state='healthy', "
                        "last_error=?, last_publish_at=?, updated_at=? WHERE id=?",
                        (
                            "",
                            now if count_quota else account["last_publish_at"],
                            now,
                            account["id"],
                        ),
                    )
                conn.execute(
                    "INSERT INTO records(job_id, draft_id, account_id, platform, success, "
                    "message, remote_note_id, result, created_at) "
                    "VALUES(?,?,?,?,1,?,'',?,?)",
                    (
                        job_id,
                        job["draft_id"],
                        job["account_id"],
                        job["platform"] or DEFAULT_PLATFORM,
                        "人工确认已发布（平台自动回执缺失）",
                        json.dumps({"manual_confirmed": True}, ensure_ascii=False),
                        now,
                    ),
                )
            logger.info(f"任务 {job_id} 已由人工确认发布成功")
        else:
            with db.transaction() as conn:
                conn.execute(
                    "UPDATE jobs SET status='failed', result_state='normal', "
                    "confirm_deadline=0, last_error=?, blocked_reason='', updated_at=? "
                    "WHERE id=?",
                    ("人工确认未发布", now, job_id),
                )
                self._settle_draft(conn, job["draft_id"], now)
                conn.execute(
                    "INSERT INTO records(job_id, draft_id, account_id, platform, success, "
                    "message, remote_note_id, result, created_at) "
                    "VALUES(?,?,?,?,0,?,'',?,?)",
                    (
                        job_id,
                        job["draft_id"],
                        job["account_id"],
                        job["platform"] or DEFAULT_PLATFORM,
                        "人工确认未发布，可重新入队",
                        json.dumps({"manual_confirmed": False}, ensure_ascii=False),
                        now,
                    ),
                )
            logger.info(f"任务 {job_id} 已由人工确认未发布")
        return self.serialize(self._get_job(job_id))

    def queue_reasons(self) -> dict[str, Any]:
        """队列受阻原因聚合：让页面直接回答「为什么还没发」。"""
        rows = db.query(
            "SELECT CASE WHEN IFNULL(blocked_reason,'') = '' THEN '等待执行' "
            "ELSE blocked_reason END AS reason, COUNT(*) AS total, "
            "MIN(next_run_at) AS next_at FROM jobs "
            "WHERE status IN ('pending','retry') GROUP BY reason ORDER BY total DESC"
        )
        pending = int(
            db.scalar(
                "SELECT COUNT(*) FROM jobs WHERE status='pending_confirm'", (), 0
            )
            or 0
        )
        return {
            "groups": [
                {
                    "reason": row["reason"],
                    "count": int(row["total"]),
                    "next_at": int(row["next_at"] or 0),
                }
                for row in rows
            ],
            "pending_confirm": pending,
            "waiting": int(
                db.scalar(
                    "SELECT COUNT(*) FROM jobs WHERE status IN ('pending','retry')", (), 0
                )
                or 0
            ),
        }

    def serialize(self, row) -> dict[str, Any] | None:
        if row is None:
            return None
        draft = db.query_one("SELECT title, status FROM drafts WHERE id = ?", (row["draft_id"],))
        account = (
            db.query_one("SELECT name, nickname FROM accounts WHERE id = ?", (row["account_id"],))
            if row["account_id"]
            else None
        )
        return {
            "id": row["id"],
            "draft_id": row["draft_id"],
            "draft_title": draft["title"] if draft else "(草稿已删除)",
            "draft_status": draft["status"] if draft else "",
            "platform": row["platform"] or DEFAULT_PLATFORM,
            "platform_name": platform_label(row["platform"]),
            "account_id": row["account_id"],
            "account_name": (account["nickname"] or account["name"]) if account else "",
            "status": row["status"],
            "result_state": row["result_state"] or "normal",
            "confirm_deadline": int(row["confirm_deadline"] or 0),
            "blocked_reason": row["blocked_reason"] or "",
            "blocked_at": int(row["blocked_at"] or 0),
            "submitted_at": int(row["submitted_at"] or 0),
            "attempts": row["attempts"],
            "max_attempts": row["max_attempts"],
            "next_run_at": row["next_run_at"],
            "scheduled_at": row["scheduled_at"],
            "last_error": row["last_error"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def list_jobs(
        self,
        limit: int = 100,
        offset: int = 0,
        status: str = "",
        reason: str = "",
    ) -> list[dict[str, Any]]:
        sql = "SELECT * FROM jobs"
        where: list[str] = []
        args: list[Any] = []
        if status == "waiting":
            where.append("status IN ('pending','retry')")
        elif status:
            where.append("status = ?")
            args.append(status)
        if reason:
            where.append(
                "CASE WHEN IFNULL(blocked_reason,'') = '' THEN '等待执行' "
                "ELSE blocked_reason END = ?"
            )
            args.append(reason)
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY id DESC LIMIT ? OFFSET ?"
        args.extend([max(1, limit), max(0, int(offset))])
        rows = db.query(sql, tuple(args))
        return [item for item in (self.serialize(row) for row in rows) if item]

    def count_jobs(self, status: str = "", reason: str = "") -> int:
        sql = "SELECT COUNT(*) FROM jobs"
        where: list[str] = []
        args: list[Any] = []
        if status == "waiting":
            where.append("status IN ('pending','retry')")
        elif status:
            where.append("status = ?")
            args.append(status)
        if reason:
            where.append(
                "CASE WHEN IFNULL(blocked_reason,'') = '' THEN '等待执行' "
                "ELSE blocked_reason END = ?"
            )
            args.append(reason)
        if where:
            sql += " WHERE " + " AND ".join(where)
        return int(db.scalar(sql, tuple(args), 0) or 0)

    def list_draft_jobs(self, draft_id: int) -> list[dict[str, Any]]:
        rows = db.query("SELECT * FROM jobs WHERE draft_id = ? ORDER BY id", (draft_id,))
        return [item for item in (self.serialize(row) for row in rows) if item]

    def _get_job(self, job_id: int):
        row = db.query_one("SELECT * FROM jobs WHERE id = ?", (job_id,))
        if row is None:
            raise KeyError(f"任务不存在: {job_id}")
        return row

    # ------------------------------------------------------------ 执行

    def run_due(self, limit: int = 3, due_only: bool = True) -> dict[str, Any]:
        now = db.now()
        if due_only:
            rows = db.query(
                "SELECT id FROM jobs WHERE status IN ('pending','retry') AND next_run_at <= ? "
                "ORDER BY next_run_at ASC LIMIT ?",
                (now, max(1, limit)),
            )
        else:
            # 手动「立即执行」：等待中的任务不再受退避时间限制，重试中的仍尊重退避。
            rows = db.query(
                "SELECT id FROM jobs WHERE status = 'pending' "
                "OR (status = 'retry' AND next_run_at <= ?) "
                "ORDER BY next_run_at ASC LIMIT ?",
                (now, max(1, limit)),
            )
        results = []
        for row in rows:
            results.append(self.run_job(int(row["id"])))
        return {"ran": len(results), "results": results}

    def _claim(self, job_id: int) -> bool:
        with db.transaction() as conn:
            cursor = conn.execute(
                "UPDATE jobs SET status='running', blocked_reason='', blocked_at=0, "
                "submitted_at=0, updated_at=? WHERE id=? AND status IN ('pending','retry')",
                (db.now(), job_id),
            )
            return cursor.rowcount == 1

    def recover_interrupted(self) -> dict[str, Any]:
        """启动时回收上次进程遗留的 running 任务。

        提交标记是唯一的判断依据：

        - ``submitted_at > 0``：内容已发给平台，结果未知，转人工确认，绝不自动重发；
        - ``submitted_at = 0``：还没提交，直接回到等待队列，下一轮正常重试。
        """
        now = db.now()
        submitted = db.query(
            "SELECT id FROM jobs WHERE status='running' AND IFNULL(submitted_at, 0) > 0"
        )
        unsent = db.query(
            "SELECT id FROM jobs WHERE status='running' AND IFNULL(submitted_at, 0) = 0"
        )
        with db.transaction() as conn:
            for row in submitted:
                conn.execute(
                    "UPDATE jobs SET status='pending_confirm', "
                    "result_state='pending_confirm', confirm_deadline=?, "
                    "last_error=?, blocked_reason='', blocked_at=0, updated_at=? "
                    "WHERE id=?",
                    (
                        now + 24 * 3600,
                        "服务重启：内容已提交但未收到平台回执，请到平台核对",
                        now,
                        int(row["id"]),
                    ),
                )
            for row in unsent:
                conn.execute(
                    "UPDATE jobs SET status='pending', next_run_at=?, "
                    "blocked_reason='服务重启，等待重试', blocked_at=?, "
                    "submitted_at=0, updated_at=? WHERE id=?",
                    (now, now, now, int(row["id"])),
                )
        if submitted or unsent:
            logger.warning(
                f"启动回收中断任务：待确认 {len(submitted)} 条，重新排队 {len(unsent)} 条"
            )
        return {
            "pending_confirm": len(submitted),
            "requeued": len(unsent),
        }

    def run_job(self, job_id: int) -> dict[str, Any]:
        if not self._claim(job_id):
            return {"job_id": job_id, "status": "skipped", "message": "任务已被领取"}
        job = self._get_job(job_id)
        try:
            return self._execute(job)
        except Exception as exc:  # noqa: BLE001
            logger.exception(f"发布任务 {job_id} 执行异常")
            # 执行中断时请求可能已经发到平台，不能当普通失败自动重发。
            return self._pending_confirm(
                job,
                None,
                "发布过程中断，平台是否已发布未知；请到平台核对后确认",
                {"exception": exc.__class__.__name__},
            )

    def _execute(self, job) -> dict[str, Any]:
        draft = db.query_one("SELECT * FROM drafts WHERE id = ?", (job["draft_id"],))
        if draft is None:
            return self._fail(job, "草稿已删除", "content", None)
        draft_item = self.drafts.serialize(draft)

        issues = draft_item.get("compliance") or []
        if issues:
            labels = "、".join(issue.get("label", "") for issue in issues)
            return self._fail(job, f"文案命中合规红线：{labels}", "content", None, final=True)

        platform = normalize(draft_item.get("platform"))
        adapter = get_platform(platform, self.accounts)
        payload = self.drafts.payload(draft_item)
        action = str(payload.get("action") or "")
        # 公众号只写草稿，不占群发额度，也不刷新 last_publish_at。
        draft_only = platform == "wechat_mp"

        # 平台硬规格（标题/正文字数、素材数量）由适配器声明，队列只负责执行。
        problems = adapter.validate(payload, draft_item.get("content_type") or "")
        if problems:
            return self._fail(job, "；".join(problems), "content", None, final=True)

        files = [str(path) for path in payload.get("images") or []]
        missing = [path for path in files if not Path(path).is_file()]
        if files and missing:
            return self._fail(
                job, f"素材文件不存在: {missing[:2]}", "content", None, final=True
            )
        if payload.get("video") and not Path(str(payload["video"])).is_file():
            return self._fail(job, "视频文件不存在", "content", None, final=True)

        account, reason, next_at = self._resolve_account(
            job, draft_item, platform, count_quota=not draft_only
        )
        if account is None:
            self._defer(job, max(60, next_at - db.now()), reason)
            return {"job_id": job["id"], "status": "waiting", "message": reason}

        db.execute(
            "UPDATE jobs SET account_id=?, updated_at=? WHERE id=?",
            (account["id"], db.now(), job["id"]),
        )
        db.execute(
            "UPDATE drafts SET account_id=?, updated_at=? WHERE id=?",
            (account["id"], db.now(), draft_item["id"]),
        )
        if not draft_only:
            db.execute(
                "INSERT INTO rate_events(account_id, action, created_at) VALUES(?, 'publish', ?)",
                (account["id"], db.now()),
            )

        if config.DRY_RUN:
            # 模拟发布：不调用平台接口，只留一条可查记录，用于端到端演练。
            fake_id = uuid.uuid4().hex[:24]
            return self._succeed(
                job,
                account,
                f"模拟发布成功（未真正发送到{adapter.name}）",
                {"note_id": fake_id, "simulated": True, "platform": platform},
                count_quota=not draft_only,
            )

        # 提交标记先落库：进程在提交后崩溃时，启动回收才能判定「结果未知」。
        db.execute(
            "UPDATE jobs SET submitted_at=?, updated_at=? WHERE id=?",
            (db.now(), db.now(), job["id"]),
        )
        publish_payload = {
            **payload,
            "_job_id": job["id"],
            "_account_id": account["id"],
        }
        outcome = adapter.publish(account, publish_payload)
        if outcome.success:
            # 平台明确返回成功即视为成功；没有作品 ID 只影响回链，不再二次猜测。
            return self._succeed(
                job,
                account,
                outcome.message or "发布成功",
                outcome.result,
                count_quota=not draft_only,
            )
        kind = str(getattr(outcome, "kind", "") or "") or classify_error(
            str(outcome.message), outcome.result
        )
        return self._fail(
            job,
            str(outcome.message) or "发布失败",
            kind,
            account,
            result=outcome.result,
            allow_pending=kind == "network",
        )

    def _resolve_account(
        self,
        job,
        draft_item: dict[str, Any],
        platform: str,
        *,
        count_quota: bool = True,
    ):
        preferred = job["account_id"] or draft_item.get("account_id")
        if preferred:
            row = db.query_one("SELECT * FROM accounts WHERE id = ?", (preferred,))
            if row is not None and (row["platform"] or DEFAULT_PLATFORM) == platform:
                ok, reason, next_at = self.accounts.availability(
                    row, count_quota=count_quota
                )
                if ok:
                    return row, "", next_at
                if row["status"] == "expired":
                    db.execute(
                        "UPDATE jobs SET account_id=NULL, updated_at=? WHERE id=?",
                        (db.now(), job["id"]),
                    )
                elif "上限" in reason:
                    db.execute(
                        "UPDATE jobs SET account_id=NULL, updated_at=? WHERE id=?",
                        (db.now(), job["id"]),
                    )
                else:
                    return None, reason, next_at
        account, reason, next_at = self.accounts.pick_account(
            platform=platform, count_quota=count_quota
        )
        return account, reason, next_at

    def _settle_draft(self, conn, draft_id: int, now: int) -> None:
        """一稿多号时，草稿状态取所有队列任务的汇总结果。"""
        pending = conn.execute(
            "SELECT COUNT(*) FROM jobs WHERE draft_id=? "
            "AND status IN ('pending','retry','running','pending_confirm')",
            (draft_id,),
        ).fetchone()[0]
        if pending:
            conn.execute(
                "UPDATE drafts SET status='queued', updated_at=? WHERE id=?",
                (now, draft_id),
            )
            return
        success = conn.execute(
            "SELECT COUNT(*) FROM jobs WHERE draft_id=? AND status='success'",
            (draft_id,),
        ).fetchone()[0]
        if success:
            status = "published"
        else:
            status = "failed"
        conn.execute(
            "UPDATE drafts SET status=?, updated_at=? WHERE id=?",
            (status, now, draft_id),
        )

    def _succeed(
        self, job, account, message: str, result: Any, *, count_quota: bool = True
    ) -> dict[str, Any]:
        now = db.now()
        note_id = find_note_id(result)
        with db.transaction() as conn:
            conn.execute(
                "UPDATE jobs SET status='success', last_error='', blocked_reason='', "
                "blocked_at=0, result_state='normal', confirm_deadline=0, "
                "updated_at=? WHERE id=?",
                (now, job["id"]),
            )
            self._settle_draft(conn, job["draft_id"], now)
            if count_quota:
                conn.execute(
                    "UPDATE accounts SET last_publish_at=?, status='healthy', "
                    "health_state='healthy', cooldown_until=0, last_error='', "
                    "updated_at=? WHERE id=?",
                    (now, now, account["id"]),
                )
            else:
                # 公众号只存草稿不占群发额度，也不刷新「上次发布时间」间隔。
                conn.execute(
                    "UPDATE accounts SET status='healthy', health_state='healthy', "
                    "last_error='', updated_at=? WHERE id=?",
                    (now, account["id"]),
                )
            conn.execute(
                "INSERT INTO records(job_id, draft_id, account_id, platform, success, message, "
                "remote_note_id, result, created_at) VALUES(?,?,?,?,1,?,?,?,?)",
                (
                    job["id"],
                    job["draft_id"],
                    account["id"],
                    job["platform"] or DEFAULT_PLATFORM,
                    message[:500],
                    note_id,
                    json.dumps(result, ensure_ascii=False, default=str)[:4000],
                    now,
                ),
            )
        logger.success(f"草稿 {job['draft_id']} 已发布到账号 {account['id']}（{note_id}）")
        return {
            "job_id": job["id"],
            "status": "success",
            "message": message,
            "remote_note_id": note_id,
        }

    def _fail(
        self,
        job,
        message: str,
        kind: str,
        account,
        *,
        final: bool = False,
        result: Any = None,
        allow_pending: bool = False,
    ) -> dict[str, Any]:
        now = db.now()
        attempts = int(job["attempts"]) + 1
        max_attempts = int(job["max_attempts"] or 4)
        if kind in {"content", "platform"}:
            final = True
        if attempts >= max_attempts:
            final = True

        if kind == "rate" and account is not None:
            # 命中限流统一进入阶梯冷却，手动「立即执行」也会被同一条预算挡住。
            try:
                self.accounts.note_risk(
                    int(account["id"]), "rate_limited", message, source="publish"
                )
            except Exception:  # noqa: BLE001
                logger.exception(f"账号 {account['id']} 记录风控事件失败")

        if kind == "auth" and account is not None:
            db.execute(
                "UPDATE accounts SET status='expired', health_state='expired', "
                "last_error=?, updated_at=? WHERE id=?",
                (message[:500], now, account["id"]),
            )
            self._notify(
                "account_expired",
                f"账号登录失效：{account['nickname'] or account['name']}",
                message,
                link_view="accounts",
                link_id=int(account["id"]),
            )

        if final and allow_pending:
            # 网络中断可能已经发出去了：转人工确认，绝不自动重发。
            return self._pending_confirm(job, account, message, result)

        if final:
            with db.transaction() as conn:
                conn.execute(
                    "UPDATE jobs SET status='failed', attempts=?, last_error=?, "
                    "blocked_reason='', blocked_at=0, result_state='normal', "
                    "confirm_deadline=0, updated_at=? WHERE id=?",
                    (attempts, message[:500], now, job["id"]),
                )
                self._settle_draft(conn, job["draft_id"], now)
                conn.execute(
                    "INSERT INTO records(job_id, draft_id, account_id, platform, success, message, "
                    "remote_note_id, result, created_at) VALUES(?,?,?,?,0,?,'',?,?)",
                    (
                        job["id"],
                        job["draft_id"],
                        account["id"] if account is not None else None,
                        job["platform"] or DEFAULT_PLATFORM,
                        message[:500],
                        json.dumps(result or {}, ensure_ascii=False, default=str)[:4000],
                        now,
                    ),
                )
            logger.error(f"草稿 {job['draft_id']} 发布失败（{kind}）: {message}")
            self._notify(
                "publish_failed",
                f"发布失败：{self._draft_title(job['draft_id'])}",
                message,
                link_view="records",
                link_id=int(job["id"]),
                level="error",
            )
            return {
                "job_id": job["id"],
                "status": "failed",
                "message": message,
                "attempts": attempts,
            }

        wait = min(3600, 60 * (2 ** (attempts - 1)))
        if kind == "rate":
            wait = max(wait, 900)
        wait += hash((job["id"], attempts)) % 120
        db.execute(
            "UPDATE jobs SET status='retry', attempts=?, next_run_at=?, last_error=?, "
            "blocked_reason=?, blocked_at=?, updated_at=? WHERE id=?",
            (
                attempts,
                now + wait,
                f"[{kind}] {message}"[:500],
                self._wait_reason(kind, message),
                now,
                now,
                job["id"],
            ),
        )
        return {
            "job_id": job["id"],
            "status": "retry",
            "message": message,
            "next_run_at": now + wait,
            "attempts": attempts,
        }

    @staticmethod
    def _wait_reason(kind: str, message: str) -> str:
        mapping = {
            "rate": "平台限流，等待冷却",
            "auth": "账号登录失效，等待换号或重登",
            "network": "网络异常，等待重试",
        }
        return mapping.get(kind, "等待重试")[:120]

    def _draft_title(self, draft_id: int) -> str:
        title = db.scalar("SELECT title FROM drafts WHERE id=?", (draft_id,), "")
        return str(title or f"草稿 #{draft_id}")

    def _notify(self, event: str, title: str, message: str, **kwargs: Any) -> None:
        try:
            self.notify.emit(event, title, message, **kwargs)
        except Exception:  # noqa: BLE001
            logger.exception("发送站内通知失败")

    def _pending_confirm(
        self, job, account, message: str, result: Any
    ) -> dict[str, Any]:
        """进入「结果待确认」：不自动重试、不重复提交，等人工核对。"""
        now = db.now()
        deadline = now + 24 * 3600
        with db.transaction() as conn:
            conn.execute(
                "UPDATE jobs SET status='pending_confirm', result_state='pending_confirm', "
                "confirm_deadline=?, last_error=?, blocked_reason='', blocked_at=0, "
                "updated_at=? WHERE id=?",
                (deadline, f"结果待确认：{message}"[:500], now, job["id"]),
            )
            self._settle_draft(conn, job["draft_id"], now)
        logger.warning(f"任务 {job['id']} 进入结果待确认：{message}")
        self._notify(
            "publish_pending",
            f"发布结果待确认：{self._draft_title(job['draft_id'])}",
            f"{message}；请到平台核对后确认已发布或未发布。",
            link_view="library",
            link_id=int(job["id"]),
        )
        return {
            "job_id": job["id"],
            "status": "pending_confirm",
            "message": message,
            "confirm_deadline": deadline,
        }

    def _defer(self, job, seconds: int, note: str) -> None:
        db.execute(
            "UPDATE jobs SET status=?, next_run_at=?, last_error=?, blocked_reason=?, "
            "blocked_at=?, updated_at=? WHERE id=?",
            (
                "retry" if int(job["attempts"]) > 0 else "pending",
                db.now() + max(30, min(seconds, 300)),
                note[:500],
                note[:120] or "等待可用账号",
                db.now(),
                db.now(),
                job["id"],
            ),
        )

    # ------------------------------------------------------------ 记录

    def count_records_summary(self) -> dict[str, int]:
        row = db.query_one(
            "SELECT COUNT(*) AS total, "
            "SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS success_total, "
            "SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failed_total FROM records"
        )
        return {
            "total": int((row["total"] if row else 0) or 0),
            "success_total": int((row["success_total"] if row else 0) or 0),
            "failed_total": int((row["failed_total"] if row else 0) or 0),
        }

    def list_records(self, limit: int = 100, offset: int = 0) -> list[dict[str, Any]]:
        rows = db.query(
            "SELECT r.*, d.title AS draft_title, a.name AS account_name, "
            "a.nickname AS account_nickname FROM records r "
            "LEFT JOIN drafts d ON d.id = r.draft_id "
            "LEFT JOIN accounts a ON a.id = r.account_id "
            "ORDER BY r.id DESC LIMIT ? OFFSET ?",
            (max(1, limit), max(0, int(offset))),
        )
        return [
            {
                "id": row["id"],
                "job_id": row["job_id"],
                "draft_id": row["draft_id"],
                "draft_title": row["draft_title"] or "(已删除)",
                "platform": row["platform"] or DEFAULT_PLATFORM,
                "platform_name": platform_label(row["platform"]),
                "account_id": row["account_id"],
                "account_name": row["account_nickname"] or row["account_name"] or "",
                "success": bool(row["success"]),
                "message": row["message"],
                "remote_note_id": row["remote_note_id"],
                "created_at": row["created_at"],
            }
            for row in rows
        ]


__all__ = [
    "PublishQueue",
    "parse_when",
    "classify_error",
    "find_note_id",
]
