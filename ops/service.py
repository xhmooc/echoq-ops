# encoding: utf-8
"""运营台业务门面。

Web API 与 CLI 都调用这里，避免两套逻辑。所有耗时网络操作都在调用方
用 ``asyncio.to_thread`` 或 CLI 直接同步执行。
"""

from __future__ import annotations

import os
import threading
import uuid
from typing import Any, Callable

from loguru import logger

from vendor.apis.xhs_pc_apis import XHS_Apis

from ops import config, db, security
from ops.accounts import AccountManager, QrLoginRegistry, day_start
from ops.backup import BackupService
from ops.illustrator import render_cards
from ops.content import (
    DraftService,
    compliance_issues,
    convert_copy,
    generate_from_brief,
    normalize_title,
    rewrite_copy,
)
from ops.notify import NotifyCenter
from ops.publisher import PublishQueue
from ops.platforms import DEFAULT_PLATFORM, get_platform, list_platforms, normalize, platform_label
from ops.published import PublishedService
from ops.proxies import ProxyPool
from ops.scheduler import ScheduleEngine
from ops.topics import TopicMiner
from ops.worker import (
    Worker,
    current_published,
    current_scheduler,
    current_worker,
    start_background,
)

SETTING_KEYS = {
    "publish_daily_limit",
    "publish_min_interval_sec",
    "publish_jitter_sec",
    "job_max_attempts",
    "worker_auto_start",
    "worker_poll_sec",
    "health_check_hours",
    "write_gap_sec",
    "comment_sync_hours",
    "focus_keywords",
    "product_name",
    "product_pitch",
    "card_style",
    "card_layout",
    "card_palette",
    "card_theme",
    "card_brand",
    "card_column",
    "card_issue",
    "theme_color",
    "draft_style",
}


class TaskCenter:
    """把耗时生成任务移出请求线程，并用同一个 key 挡住连点重复提交。"""

    def __init__(self, keep: int = 50) -> None:
        self._tasks: dict[str, dict[str, Any]] = {}
        self._running: dict[str, str] = {}
        self._guard = threading.Lock()
        self._keep = keep

    def submit(
        self,
        kind: str,
        key: str,
        fn: Callable[[], Any],
        *,
        timeout_sec: float = 900,
    ) -> dict[str, Any]:
        with self._guard:
            self._expire_locked()
            running_id = self._running.get(key)
            if running_id and self._tasks.get(running_id, {}).get("status") == "running":
                return {**self._tasks[running_id], "existed": True}
            task_id = uuid.uuid4().hex[:12]
            now = db.now()
            task = {
                "id": task_id,
                "kind": kind,
                "status": "running",
                "message": "正在处理，完成后会自动刷新",
                "result": None,
                "error": "",
                "created_at": now,
                "finished_at": 0,
                # 任务级看门狗：线程卡死或网络挂起时，轮询也能拿到明确失败。
                "deadline_at": now + max(1, int(timeout_sec)),
            }
            self._tasks[task_id] = task
            self._running[key] = task_id
            self._prune()
        threading.Thread(
            target=self._run, args=(task_id, key, kind, fn), name=f"task-{kind}", daemon=True
        ).start()
        return dict(task)

    def _expire_locked(self) -> None:
        """把超过截止时间仍在 running 的任务标记为失败，避免前端无限轮询。"""
        now = db.now()
        for task in self._tasks.values():
            if task["status"] != "running":
                continue
            deadline = int(task.get("deadline_at") or 0)
            if not deadline or now < deadline:
                continue
            task.update(
                status="failed",
                error="处理超时，请重试；已保留当前输入",
                message="处理超时，请重试",
                finished_at=now,
            )
            for key, task_id in list(self._running.items()):
                if task_id == task["id"]:
                    self._running.pop(key, None)
            logger.warning(f"后台任务 {task['id']} 超时，已标记失败: {task['kind']}")

    def _run(self, task_id: str, key: str, kind: str, fn: Callable[[], Any]) -> None:
        try:
            result = fn()
            message = "处理完成"
            if isinstance(result, list):
                if kind == "published":
                    ok_count = sum(1 for item in result if isinstance(item, dict) and item.get("ok"))
                    message = f"已同步 {len(result)} 个账号，成功 {ok_count} 个"
                else:
                    message = f"已生成 {len(result)} 篇草稿"
            task = {"status": "success", "result": result, "message": message}
        except (ValueError, RuntimeError) as exc:
            task = {"status": "failed", "error": str(exc), "message": str(exc)}
        except Exception:  # noqa: BLE001
            error_id = uuid.uuid4().hex[:8]
            logger.exception(f"后台任务 {task_id} 执行失败[{error_id}]")
            task = {
                "status": "failed",
                "error": f"处理失败，请稍后重试（错误编号 {error_id}）",
                "message": "处理失败，请稍后重试",
            }
        with self._guard:
            current = self._tasks.get(task_id)
            if current is not None and current["status"] == "running":
                current.update(task)
                current["finished_at"] = db.now()
            elif current is not None:
                # 已被看门狗标记超时，迟到结果不再覆盖失败状态。
                logger.warning(f"后台任务 {task_id} 已结束，忽略迟到结果")
            if self._running.get(key) == task_id:
                self._running.pop(key, None)

    def _prune(self) -> None:
        if len(self._tasks) <= self._keep:
            return
        finished = sorted(
            (item for item in self._tasks.values() if item["status"] != "running"),
            key=lambda item: item["created_at"],
        )
        for item in finished[: max(0, len(self._tasks) - self._keep)]:
            self._tasks.pop(item["id"], None)

    def get(self, task_id: str) -> dict[str, Any]:
        with self._guard:
            self._expire_locked()
            task = self._tasks.get(task_id)
            if task is None:
                raise KeyError(f"任务不存在或已过期: {task_id}")
            return dict(task)


class OpsService:
    def __init__(self) -> None:
        db.init_db()
        # 启动检查：密钥必须在数据目录之外且权限已收紧，否则给出可执行的告警。
        try:
            security.ensure_key()
        except OSError as exc:
            logger.error(f"Cookie 加密密钥初始化失败: {exc}")
        key_state = security.key_status()
        if key_state["warning"]:
            logger.warning(f"密钥检查: {key_state['warning']}")
        self.accounts = AccountManager()
        self.topics = TopicMiner()
        self.drafts = DraftService()
        self.notify = NotifyCenter()
        self.queue = PublishQueue(self.accounts, self.drafts, self.notify)
        # 回收上次进程遗留的 running 任务：已提交的转人工确认，未提交的重新排队。
        try:
            self.queue.recover_interrupted()
        except Exception:  # noqa: BLE001
            logger.exception("回收中断的发布任务失败")
        self.published = PublishedService(self.accounts)
        self.proxies = ProxyPool()
        self.backups = BackupService()
        self.qr = QrLoginRegistry()
        self.tasks = TaskCenter()
        # 定时调度：任务定义与运行记录都落库，启动时先清理残留的中断状态。
        self.schedules = ScheduleEngine(self)
        self.schedules.recover()

    # ------------------------------------------------------------ 概览

    def overview(self) -> dict[str, Any]:
        accounts = self.accounts.list_accounts()
        by_status: dict[str, int] = {}
        for account in accounts:
            by_status[account["status"]] = by_status.get(account["status"], 0) + 1
        today = db.scalar(
            "SELECT COUNT(*) FROM records WHERE success = 1 AND created_at >= ? "
            "AND message NOT LIKE '模拟发布%'",
            (day_start(),),
            0,
        )
        worker = current_worker()
        scheduler = current_scheduler()
        return {
            "accounts": {
                "total": len(accounts),
                "healthy": by_status.get("healthy", 0),
                "expired": by_status.get("expired", 0),
                "unknown": by_status.get("unknown", 0),
                "disabled": sum(1 for item in accounts if not item["enabled"]),
            },
            "today_published": int(today),
            "topics": {
                "pool": int(db.scalar("SELECT COUNT(*) FROM topics WHERE status='pool'", (), 0)),
                "used": int(db.scalar("SELECT COUNT(*) FROM topics WHERE status='used'", (), 0)),
            },
            "drafts": {
                **{
                    status: int(db.scalar("SELECT COUNT(*) FROM drafts WHERE status=?", (status,), 0))
                    for status in ("draft", "queued", "published", "failed")
                },
                "ready": int(
                    db.scalar(
                        "SELECT COUNT(*) FROM drafts WHERE status='draft' "
                        "AND compliance='[]' AND images != '[]'",
                        (),
                        0,
                    )
                ),
            },
            "jobs": {
                status: int(db.scalar("SELECT COUNT(*) FROM jobs WHERE status=?", (status,), 0))
                for status in (
                    "pending",
                    "retry",
                    "running",
                    "pending_confirm",
                    "success",
                    "failed",
                    "cancelled",
                )
            },
            "needs_action": {
                "pending_confirm": int(
                    db.scalar(
                        "SELECT COUNT(*) FROM jobs WHERE status='pending_confirm'", (), 0
                    )
                    or 0
                ),
                "unread_notifications": self.notify.unread_count(),
                "abnormal_notes": int(
                    db.scalar(
                        "SELECT COUNT(*) FROM published_notes WHERE health_state IN "
                        "('zero_views','risky','removed')",
                        (),
                        0,
                    )
                    or 0
                ),
                "expired_accounts": by_status.get("expired", 0),
            },
            "queue": self.queue.queue_reasons(),
            "worker": {
                "running": bool(worker and worker.is_alive()),
                "last_tick_at": int(worker.last_tick_at) if worker else 0,
            },
            "scheduler": {
                "running": bool(scheduler and scheduler.is_alive()),
                "last_tick_at": int(scheduler.last_tick_at) if scheduler else 0,
            },
            "schedules": {
                "total": int(db.scalar("SELECT COUNT(*) FROM schedules", (), 0)),
                "enabled": int(db.scalar("SELECT COUNT(*) FROM schedules WHERE enabled=1", (), 0)),
                "paused": int(
                    db.scalar(
                        "SELECT COUNT(*) FROM schedules WHERE enabled=0 AND paused_reason != ''",
                        (),
                        0,
                    )
                ),
                "running": int(db.scalar("SELECT COUNT(*) FROM schedules WHERE running=1", (), 0)),
            },
            "records": self.queue.list_records(limit=8),
            "dry_run": config.DRY_RUN,
        }

    # ------------------------------------------------------------ 平台

    def platforms(self) -> list[dict[str, Any]]:
        return list_platforms()

    # ------------------------------------------------------------ 已发布内容

    def sync_published(
        self, account_ids: list[int] | None = None, pages: int = 2
    ) -> list[dict[str, Any]]:
        return self.published.sync_many(account_ids, pages=pages)

    def sync_published_async(
        self, account_ids: list[int] | None = None, pages: int = 2
    ) -> dict[str, Any]:
        """同步走后台任务，接口立即返回任务 id；同参数在跑时复用。"""
        ids = sorted({int(item) for item in account_ids or [] if item})
        key = f"published:{','.join(str(item) for item in ids) or 'all'}:{int(pages)}"
        return self.tasks.submit(
            "published",
            key,
            lambda: self.sync_published(ids or None, pages=pages),
            timeout_sec=1800,
        )

    # ------------------------------------------------------------ 账号

    def add_account_cookie(
        self, name: str, cookie: str, proxy: str = "", platform: str = DEFAULT_PLATFORM
    ) -> dict[str, Any]:
        return self.accounts.add_cookie(name, cookie, proxy, platform=platform)

    def import_env_account(self) -> dict[str, Any]:
        """把 .env 里已有的 COOKIES 导入账号矩阵，省去重复粘贴。"""
        cookie = (os.getenv("COOKIES") or "").strip().strip("'\"")
        if not cookie:
            raise ValueError(".env 中没有 COOKIES，请先 run.cmd login 或手动添加账号")
        return self.accounts.add_cookie("", cookie, "")

    def start_qr(self, proxy: str = "", platform: str = DEFAULT_PLATFORM) -> dict[str, Any]:
        session_id, image = self.qr.start(proxy, platform)
        return {"session_id": session_id, "qr": image, "platform": normalize(platform)}

    def poll_qr(self, session_id: str) -> dict[str, Any]:
        return self.qr.poll(session_id)

    def confirm_qr_account(self, session_id: str, name: str = "") -> dict[str, Any]:
        session = self.qr.get(session_id)
        platform = str(getattr(session, "platform", DEFAULT_PLATFORM) or DEFAULT_PLATFORM)
        payload = session.poll()
        if payload.get("status") != "confirmed":
            raise ValueError(payload.get("message") or "扫码尚未完成")
        if platform == DEFAULT_PLATFORM:
            cookie = getattr(session, "cookie", "")
            if not cookie:
                raise ValueError("扫码已完成，但没有拿到有效登录态，请重试")
            account = self.accounts.add_cookie(
                name or payload.get("nickname") or "扫码账号", cookie
            )
        else:
            account = get_platform(platform, self.accounts).save_qr_account(
                session, self.accounts, name
            )
        self.qr.drop(session_id)
        return account

    def open_qr_window(self, session_id: str) -> dict[str, Any]:
        """用户明确要求后才打开人工验证窗口；无头扫码本身不会弹窗。"""
        session = self.qr.get(session_id)
        opener = getattr(session, "open_window", None)
        if opener is None:
            raise ValueError("当前扫码方式不需要人工验证窗口")
        return opener()

    # ------------------------------------------------------------ 选题

    def _read_account(self, account_id: int | None = None):
        if account_id:
            return self.accounts.get_row(account_id)
        row = db.query_one(
            "SELECT * FROM accounts WHERE enabled = 1 AND status = 'healthy' ORDER BY id LIMIT 1"
        )
        if row is None:
            row = db.query_one(
                "SELECT * FROM accounts WHERE enabled = 1 AND status != 'expired' ORDER BY id LIMIT 1"
            )
        if row is None:
            raise RuntimeError("没有可用账号，请先在「账号」页添加并检查登录")
        return row

    def mine(
        self,
        mode: str,
        *,
        keywords: list[str] | None = None,
        user_urls: list[str] | None = None,
        per_kw: int = 20,
        limit: int = 30,
        sort_type_choice: int = 0,
        detail_limit: int = 5,
        product: bool = False,
        account_id: int | None = None,
    ) -> dict[str, Any]:
        row = self._read_account(account_id)
        self.topics.last_errors = []
        with self.accounts.session(row["id"], lane="sync", wait=30) as auth:
            api = XHS_Apis(auth).bootstrap()
            if mode == "keyword":
                return self.topics.mine_keywords(
                    api,
                    keywords or [],
                    per_kw=per_kw,
                    sort_type_choice=sort_type_choice,
                    detail_limit=detail_limit,
                    product=product,
                )
            if mode == "competitor":
                return self.topics.mine_competitor(
                    api, user_urls or [], limit_per_user=limit, detail_limit=detail_limit
                )
            if mode == "channel":
                return self.topics.mine_channel(
                    api,
                    keywords or [],
                    limit=limit,
                    detail_limit=detail_limit,
                )
            if mode == "trending":
                return self.topics.mine_trending(api, limit=limit)
            raise ValueError("mode 只支持 keyword / competitor / channel / trending")

    def import_library(self, path: str) -> dict[str, Any]:
        return self.topics.import_library(path)

    def delete_topics(self, topic_ids: list[int]) -> dict[str, Any]:
        deleted = self.topics.delete_topics(topic_ids)
        return {"deleted": deleted, "total": self.topics.count_topics()}

    # ------------------------------------------------------------ 草稿

    def _decorate(self, draft: dict[str, Any]) -> dict[str, Any]:
        topic = None
        if draft.get("topic_id"):
            topic = db.query_one("SELECT * FROM topics WHERE id = ?", (draft["topic_id"],))
        draft["keyword"] = topic["keyword"] if topic else ""
        draft["angle"] = topic["angle"] if topic else ""
        adapter = get_platform(draft.get("platform"), self.accounts)
        spec_problems = adapter.validate(draft, draft.get("content_type") or "")
        draft["spec_problems"] = spec_problems
        draft["can_publish"] = (
            draft["status"] != "published"
            and adapter.ready
            and not draft.get("compliance")
            and not spec_problems
        )
        draft["jobs"] = self.queue.list_draft_jobs(draft["id"])
        return draft

    def preview(
        self,
        brief: str,
        *,
        topic: str = "",
        tone: str = "",
        tags: bool = True,
        product: bool = False,
        use_llm: bool = True,
        platform: str = DEFAULT_PLATFORM,
    ) -> dict[str, Any]:
        """按自由需求生成一版文案，不落库，供创作页预览后确认。"""
        copy = generate_from_brief(
            brief,
            topic=topic,
            tone=tone,
            tags=tags,
            product=product,
            use_llm=use_llm,
            platform=platform,
        )
        copy["can_save"] = bool(copy["title"]) and bool(copy["desc"]) and not copy["compliance"]
        return copy

    def check_copy(
        self, title: str, desc: str, topics: Any = None, platform: str = DEFAULT_PLATFORM
    ) -> dict[str, Any]:
        """编辑时的实时合规检查，前端用于即时提示。"""
        spec = get_platform(platform).spec()
        return {
            "issues": compliance_issues(f"{title}\n{desc}"),
            "title_length": len(normalize_title(title, limit=spec.title_max)),
            "desc_length": len(desc or ""),
            "platform": normalize(platform),
            "title_max": spec.title_max,
            "desc_max": spec.desc_max,
        }

    def save_copy(
        self,
        *,
        title: str,
        desc: str,
        topics: Any = None,
        images: list[str] | None = None,
        visibility: int = 0,
        media_type: str = "image",
        account_id: int | None = None,
        topic_id: int | None = None,
        enqueue: bool = False,
        account_ids: list[int] | None = None,
        scheduled_at: Any = 0,
        platform: str = DEFAULT_PLATFORM,
        content_type: str = "",
        body_md: str = "",
        body_html: str = "",
        wx_theme: str = "",
    ) -> dict[str, Any]:
        """创作页「保存并发布」：先落库再按需入队。"""
        draft = self.drafts.create_manual(
            title=title,
            desc=desc,
            topics=topics,
            images=images,
            visibility=visibility,
            media_type=media_type,
            account_id=account_id,
            topic_id=topic_id,
            platform=platform,
            content_type=content_type,
            body_md=body_md,
            body_html=body_html,
            wx_theme=wx_theme,
        )
        draft = self._decorate(draft)
        if enqueue:
            if draft["compliance"]:
                raise ValueError("文案命中合规红线，请先修改")
            jobs = self.enqueue([draft["id"]], account_ids=account_ids, scheduled_at=scheduled_at)
            draft["jobs"] = jobs
        return draft

    def list_drafts(
        self, status: str = "", limit: int = 200, offset: int = 0, platform: str = ""
    ) -> list[dict[str, Any]]:
        return [
            self._decorate(item)
            for item in self.drafts.list(status, limit, offset, platform)
        ]

    def count_drafts(self, status: str = "", platform: str = "") -> int:
        return self.drafts.count(status, platform)

    def delete_drafts(self, draft_ids: list[int]) -> dict[str, Any]:
        deleted = self.drafts.delete_many(draft_ids)
        return {"deleted": deleted, "total": self.drafts.count()}

    def get_draft(self, draft_id: int) -> dict[str, Any]:
        return self._decorate(self.drafts.get(draft_id))

    def create_drafts(
        self,
        topic_ids: list[int],
        *,
        account_id: int | None = None,
        tone: str = "",
        product: bool | None = None,
        variants: int = 1,
        use_llm: bool = True,
        with_cards: bool = False,
        platform: str = DEFAULT_PLATFORM,
        content_type: str = "",
    ) -> list[dict[str, Any]]:
        created = []
        variants = max(1, min(3, int(variants or 1)))
        for topic_id in topic_ids:
            topic = self.topics.get_topic(topic_id)
            for _ in range(variants):
                draft = self.drafts.create_from_topic(
                    topic,
                    tone=tone,
                    product=product,
                    account_id=account_id,
                    platform=platform,
                    content_type=content_type,
                    use_llm=use_llm,
                )
                if with_cards:
                    draft = self.generate_cards(draft["id"])
                created.append(self._decorate(draft))
            self.topics.update_topic(topic_id, {"status": "used"})
        return created

    def create_drafts_async(
        self,
        topic_ids: list[int],
        *,
        account_id: int | None = None,
        tone: str = "",
        product: bool | None = None,
        variants: int = 1,
        use_llm: bool = True,
        with_cards: bool = False,
        platform: str = DEFAULT_PLATFORM,
        content_type: str = "",
    ) -> dict[str, Any]:
        """批量生成移出请求线程；同样的参数在跑时直接复用同一个任务。"""
        ids = sorted({int(item) for item in topic_ids if item})
        if not ids:
            raise ValueError("没有选中要生成草稿的选题")
        key = (
            f"drafts:{','.join(str(item) for item in ids)}|{tone}|{variants}|"
            f"{int(bool(with_cards))}|{product}|{int(bool(use_llm))}|{account_id}|"
            f"{platform}|{content_type}"
        )
        # 看门狗按篇数估算：每篇文案预算 + （可选）整组配图预算，另留 2 分钟余量。
        budget = 120 + len(ids) * max(1, variants) * (config.LLM_TOTAL_BUDGET_SEC + 15)
        if with_cards:
            budget += len(ids) * config.RENDER_TIMEOUT_SEC
        return self.tasks.submit(
            "drafts",
            key,
            lambda: self.create_drafts(
                ids,
                account_id=account_id,
                tone=tone,
                product=product,
                variants=variants,
                use_llm=use_llm,
                with_cards=with_cards,
                platform=platform,
                content_type=content_type,
            ),
            timeout_sec=budget,
        )

    def task(self, task_id: str) -> dict[str, Any]:
        return self.tasks.get(task_id)

    def update_draft(self, draft_id: int, fields: dict[str, Any]) -> dict[str, Any]:
        return self._decorate(self.drafts.update(draft_id, fields))

    def switch_draft_platform(
        self,
        draft_id: int,
        target_platform: str = "",
        content_type: str = "",
    ) -> dict[str, Any]:
        """同一篇草稿换平台：保留正文与全部图片，不新建副本。"""
        return self._decorate(
            self.drafts.switch_platform(draft_id, target_platform, content_type)
        )

    def convert_draft(
        self,
        draft_id: int,
        *,
        target_platform: str = "",
        tone: str = "",
        use_llm: bool = True,
    ) -> dict[str, Any]:
        """把草稿转成另一个平台的文案：公众号长文 ↔ 小红书笔记。"""
        source = self.drafts.get(draft_id)
        target = normalize(target_platform or (
            DEFAULT_PLATFORM if source["platform"] == "wechat_mp" else "wechat_mp"
        ))
        copy = convert_copy(
            source["title"],
            source["desc"],
            body_md=source.get("body_md") or "",
            body_html=source.get("body_html") or "",
            source_platform=source["platform"],
            target_platform=target,
            tone=tone,
            use_llm=use_llm,
        )
        images = list(source.get("images") or [])
        spec = get_platform(target).spec()
        if spec.media_type == "video":
            images = []
        elif spec.max_images:
            images = images[: spec.max_images]
        draft = self.drafts.create_manual(
            title=copy["title"],
            desc=copy["desc"],
            topics=copy["topics"],
            images=images,
            account_id=source.get("account_id"),
            source_note=f"convert:{draft_id}",
            platform=target,
            body_md=copy.get("body_md", ""),
            body_html=copy.get("body_html", ""),
        )
        draft["engine"] = copy["engine"]
        draft["llm_error"] = copy.get("llm_error", "")
        draft["retryable"] = bool(copy.get("retryable"))
        return self._decorate(draft)

    def rewrite_draft(
        self,
        draft_id: int,
        *,
        angle: str = "",
        tone: str = "",
        with_cards: bool = False,
        use_llm: bool = True,
        platform: str = "",
    ) -> dict[str, Any]:
        """基于已有草稿洗稿，产出新草稿并标注来源；平台默认沿用原草稿。"""
        source = self.drafts.get(draft_id)
        target = normalize(platform or source["platform"])
        copy = rewrite_copy(
            source["title"],
            source["desc"],
            angle=angle,
            tone=tone,
            use_llm=use_llm,
            platform=target,
        )
        draft = self.drafts.create_manual(
            title=copy["title"],
            desc=copy["desc"],
            topics=copy["topics"],
            account_id=source.get("account_id"),
            source_note=f"draft:{draft_id}",
            platform=target,
            content_type=source.get("content_type") or "",
        )
        draft["engine"] = copy["engine"]
        draft["llm_error"] = copy.get("llm_error", "")
        draft["retryable"] = bool(copy.get("retryable"))
        if with_cards:
            draft = self.generate_cards(draft["id"])
        return self._decorate(draft)

    def rewrite_text(
        self,
        text: str,
        *,
        title: str = "",
        angle: str = "",
        tone: str = "",
        with_cards: bool = False,
        use_llm: bool = True,
        platform: str = DEFAULT_PLATFORM,
    ) -> dict[str, Any]:
        """基于一段粘贴文案洗稿。"""
        target = normalize(platform)
        lines = [line.strip() for line in (text or "").splitlines() if line.strip()]
        if not lines:
            raise ValueError("待洗稿的文案为空")
        source_title = title.strip()
        source_desc = text.strip()
        if not source_title:
            spec = get_platform(target).spec()
            source_title = lines[0][: spec.title_max]
            if len(lines) > 1:
                source_desc = "\n".join(lines[1:])
        copy = rewrite_copy(
            source_title,
            source_desc,
            angle=angle,
            tone=tone,
            use_llm=use_llm,
            platform=target,
        )
        draft = self.drafts.create_manual(
            title=copy["title"],
            desc=copy["desc"],
            topics=copy["topics"],
            source_note="text",
            platform=target,
        )
        draft["engine"] = copy["engine"]
        draft["llm_error"] = copy.get("llm_error", "")
        draft["retryable"] = bool(copy.get("retryable"))
        if with_cards:
            draft = self.generate_cards(draft["id"])
        return self._decorate(draft)

    def generate_cards(
        self,
        draft_id: int,
        style: str | None = None,
        layout: str | None = None,
        palette: str | None = None,
    ) -> dict[str, Any]:
        draft = self.get_draft(draft_id)
        paths = render_cards(draft, style, layout, palette)
        return self.update_draft(draft_id, {"images": paths})

    # ------------------------------------------------------------ 发布

    def enqueue(
        self,
        draft_ids: list[int],
        *,
        account_id: int | None = None,
        account_ids: list[int] | None = None,
        scheduled_at: Any = 0,
    ) -> list[dict[str, Any]]:
        """一稿一号默认投递；传 account_ids 时走一稿多号。"""
        target_accounts = [int(item) for item in (account_ids or []) if item]
        jobs: list[dict[str, Any]] = []
        for draft_id in draft_ids:
            if target_accounts:
                jobs.extend(
                    self.queue.enqueue_targets(
                        int(draft_id), target_accounts, scheduled_at=scheduled_at
                    )
                )
            else:
                jobs.append(
                    self.queue.enqueue(
                        int(draft_id), account_id=account_id, scheduled_at=scheduled_at
                    )
                )
        return jobs

    # ------------------------------------------------------------ 设置

    def settings_public(self) -> dict[str, Any]:
        from ops.llm import LLMClient

        values = db.all_settings()
        values.pop("llm_api_key", None)
        fingerprint = ""
        if config.KEY_PATH.exists():
            fingerprint = security.fingerprint(config.KEY_PATH.read_text(encoding="ascii", errors="ignore"))
        return {
            "values": values,
            "llm": LLMClient().describe(),
            "data_dir": str(config.DATA_DIR),
            "db_path": str(config.DB_PATH),
            "key_fingerprint": fingerprint,
        }

    def update_settings(self, fields: dict[str, Any]) -> dict[str, Any]:
        for key, value in fields.items():
            if key not in SETTING_KEYS:
                continue
            db.set_setting(key, str(value))
        return self.settings_public()

    # ------------------------------------------------------------ 定时

    def list_schedules(self, limit: int = 200, offset: int = 0) -> list[dict[str, Any]]:
        return self.schedules.list(limit, offset)

    def count_schedules(self) -> int:
        return self.schedules.count()

    def create_schedule(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self.schedules.create(payload)

    def quick_create_schedule(self, payload: dict[str, Any]) -> dict[str, Any]:
        return self.schedules.quick_create(payload)

    def update_schedule(self, schedule_id: int, payload: dict[str, Any]) -> dict[str, Any]:
        return self.schedules.update(schedule_id, payload)

    def delete_schedule(self, schedule_id: int) -> None:
        self.schedules.delete(schedule_id)

    def run_schedule(self, schedule_id: int, trigger: str = "manual") -> dict[str, Any]:
        return self.schedules.run(schedule_id, trigger)

    def list_schedule_runs(
        self, schedule_id: int | None = None, limit: int = 50, offset: int = 0
    ) -> list[dict[str, Any]]:
        return self.schedules.list_runs(schedule_id, limit, offset)

    def count_schedule_runs(self, schedule_id: int | None = None) -> int:
        return self.schedules.count_runs(schedule_id)

    def confirm_schedule_run(self, run_id: int) -> dict[str, Any]:
        return self.schedules.confirm_run(run_id)

    def rerun_schedule_stage(self, run_id: int, stage: str = "") -> dict[str, Any]:
        return self.schedules.rerun_stage(run_id, stage)

    # ------------------------------------------------------------ 后台

    def start_worker(self, force: bool = False) -> dict[str, Any]:
        if not force and db.get_int_setting("worker_auto_start", 1) != 1:
            return {"running": False, "message": "配置里关闭了自动启动"}
        worker = start_background(self.accounts, self.queue, self)
        return {"running": worker.is_alive(), "message": "后台任务已启动"}

    def worker_status(self) -> dict[str, Any]:
        worker: Worker | None = current_worker()
        scheduler = current_scheduler()
        collector = current_published()
        return {
            "running": bool(worker and worker.is_alive()),
            "last_tick_at": int(worker.last_tick_at) if worker else 0,
            "last_result": worker.last_result if worker else {},
            "scheduler": {
                "running": bool(scheduler and scheduler.is_alive()),
                "last_tick_at": int(scheduler.last_tick_at) if scheduler else 0,
                "last_result": scheduler.last_result if scheduler else {},
            },
            "published": {
                "running": bool(collector and collector.is_alive()),
                "last_tick_at": int(collector.last_tick_at) if collector else 0,
                "last_result": collector.last_result if collector else {},
                "interval_hours": collector.interval_hours if collector else 0,
            },
        }

    def tick_now(self) -> dict[str, Any]:
        # 手动触发：直接跑一次队列与到期定时任务，不受等待时间限制；后台线程
        # 仍在时可并发，任务领取用条件更新保证不会重复执行。
        result = {
            "schedules": self.schedules.tick(limit=5),
            "published": self.queue.run_due(limit=5, due_only=False),
            "health": None,
        }
        account_id = self.accounts.due_for_health_check()
        if account_id:
            result["health"] = self.accounts.check_health(account_id)
        return result


__all__ = ["OpsService", "SETTING_KEYS"]
