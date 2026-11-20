# encoding: utf-8
"""后台任务：发布队列轮询 + 账号 Cookie 巡检 + 定时调度 + 已发布内容同步。

三条独立线程：
- 发布线程：只跑发布队列与 Cookie 巡检，几十毫秒一次，不能被长任务拖住；
- 调度线程：跑「找选题→写草稿→发布」这类可能持续数分钟的定时任务；
- 回收线程：按间隔同步各账号已发布内容，失败只记录在该账号上。

拆开后，一条链路正在挖题/配图时，发布队列、巡检与内容回收仍然照常工作。
"""

from __future__ import annotations

import threading
import time

from loguru import logger

from ops import db
from ops.accounts import AccountManager
from ops.publisher import PublishQueue


class Worker(threading.Thread):
    """发布队列 + Cookie 巡检线程。"""

    def __init__(
        self,
        accounts: AccountManager,
        queue: PublishQueue,
        service=None,
    ) -> None:
        super().__init__(name="ops-publisher", daemon=True)
        self.accounts = accounts
        self.queue = queue
        self.service = service
        self.stop_event = threading.Event()
        self.last_tick_at = 0
        self.last_result: dict = {}

    def run(self) -> None:
        logger.info("发布线程已启动")
        while not self.stop_event.is_set():
            try:
                self.tick()
            except Exception:  # noqa: BLE001
                logger.exception("发布线程执行异常")
            poll = max(5, db.get_int_setting("worker_poll_sec", 20))
            self.stop_event.wait(poll)
        logger.info("发布线程已退出")

    def tick(self) -> dict:
        self.last_tick_at = int(time.time())
        result: dict = {"published": {}, "health": None}
        try:
            result["published"] = self.queue.run_due(limit=2)
        except Exception as exc:  # noqa: BLE001
            logger.exception("发布队列轮询失败")
            result["publish_error"] = str(exc)

        # 每次只巡检一个账号，避免集中请求。
        account_id = self.accounts.due_for_health_check()
        if account_id:
            result["health"] = self.accounts.check_health(account_id)
        self.last_result = result
        return result

    def stop(self) -> None:
        self.stop_event.set()


class SchedulerThread(threading.Thread):
    """定时任务线程；链路再慢也只影响这里。"""

    def __init__(self, schedules) -> None:
        super().__init__(name="ops-scheduler", daemon=True)
        self.schedules = schedules
        self.stop_event = threading.Event()
        self.last_tick_at = 0
        self.last_result: dict = {}

    def run(self) -> None:
        logger.info("定时任务线程已启动")
        while not self.stop_event.is_set():
            try:
                self.last_tick_at = int(time.time())
                self.last_result = self.schedules.tick(limit=2)
            except Exception:  # noqa: BLE001
                logger.exception("定时任务轮询失败")
            self.stop_event.wait(30)
        logger.info("定时任务线程已退出")

    def stop(self) -> None:
        self.stop_event.set()


class PublishedSyncThread(threading.Thread):
    """已发布内容回收线程：每次只同步一个到期账号，失败不影响其它线程。"""

    def __init__(self, published, interval_hours: int = 6) -> None:
        super().__init__(name="ops-published", daemon=True)
        self.published = published
        self.interval_hours = interval_hours
        self.stop_event = threading.Event()
        self.last_tick_at = 0
        self.last_result: dict = {}

    def run(self) -> None:
        logger.info("已发布内容回收线程已启动")
        while not self.stop_event.is_set():
            try:
                self.tick()
            except Exception:  # noqa: BLE001
                logger.exception("已发布内容回收异常")
            self.stop_event.wait(1800)
        logger.info("已发布内容回收线程已退出")

    def tick(self) -> dict:
        self.last_tick_at = int(time.time())
        due = self.published.due_accounts(self.interval_hours)
        result: dict = {"due": due, "synced": None, "health": None, "comments": None}
        if due:
            result["synced"] = self.published.sync_account(due[0], pages=1)
            if result["synced"].get("ok"):
                result["health"] = self.published.health_check(account_id=due[0])
        # 评论同步低频跑，每次只挑一篇，避免集中请求平台接口。
        note_id = self.published.due_for_comments()
        if note_id:
            try:
                result["comments"] = self.published.sync_comments(note_id, pages=1)
            except Exception as exc:  # noqa: BLE001
                logger.warning(f"定时同步评论失败: {exc}")
                result["comments"] = {"ok": False, "message": str(exc)}
        self.last_result = result
        return result

    def stop(self) -> None:
        self.stop_event.set()


_worker: Worker | None = None
_scheduler: SchedulerThread | None = None
_published: PublishedSyncThread | None = None
_guard = threading.Lock()


def start_background(
    accounts: AccountManager | None = None,
    queue: PublishQueue | None = None,
    service=None,
) -> Worker:
    global _worker, _scheduler, _published
    with _guard:
        if _worker is not None and _worker.is_alive():
            return _worker
        worker = Worker(accounts or AccountManager(), queue or PublishQueue(), service)
        worker.start()
        _worker = worker
        schedules = getattr(service, "schedules", None)
        if schedules is not None and (_scheduler is None or not _scheduler.is_alive()):
            scheduler = SchedulerThread(schedules)
            scheduler.start()
            _scheduler = scheduler
        published = getattr(service, "published", None)
        if published is not None and (_published is None or not _published.is_alive()):
            collector = PublishedSyncThread(published)
            collector.start()
            _published = collector
        return worker


def current_worker() -> Worker | None:
    return _worker


def current_scheduler() -> SchedulerThread | None:
    return _scheduler


def current_published() -> PublishedSyncThread | None:
    return _published


__all__ = [
    "Worker",
    "SchedulerThread",
    "PublishedSyncThread",
    "start_background",
    "current_worker",
    "current_scheduler",
    "current_published",
]
