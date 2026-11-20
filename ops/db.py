# encoding: utf-8
"""SQLite 存储层。

每个线程一个连接（发布 worker 与 HTTP 服务线程分离），开启 WAL 与
busy_timeout，避免并发写入时 ``database is locked``。
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from contextlib import contextmanager
from typing import Any, Iterable, Iterator, Sequence

from loguru import logger

from ops import config

_local = threading.local()

SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL DEFAULT 'xiaohongshu',
    name TEXT NOT NULL,
    nickname TEXT NOT NULL DEFAULT '',
    red_id TEXT NOT NULL DEFAULT '',
    user_id TEXT NOT NULL DEFAULT '',
    cookie_enc TEXT NOT NULL,
    proxy TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'unknown',
    last_error TEXT NOT NULL DEFAULT '',
    health_checked_at INTEGER NOT NULL DEFAULT 0,
    published_synced_at INTEGER NOT NULL DEFAULT 0,
    published_sync_error TEXT NOT NULL DEFAULT '',
    last_publish_at INTEGER NOT NULL DEFAULT 0,
    daily_limit INTEGER NOT NULL DEFAULT 0,
    min_interval_sec INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    source_ref TEXT NOT NULL DEFAULT '',
    keyword TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    angle TEXT NOT NULL DEFAULT '',
    tone TEXT NOT NULL DEFAULT '',
    product INTEGER NOT NULL DEFAULT 0,
    score REAL NOT NULL DEFAULT 0,
    score_detail TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pool',
    raw TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_topics_score ON topics(score DESC);

CREATE TABLE IF NOT EXISTS topic_dedupes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '',
    kept_topic_id INTEGER NOT NULL,
    kept_title TEXT NOT NULL DEFAULT '',
    similarity REAL NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_topic_dedupes ON topic_dedupes(id DESC);

CREATE TABLE IF NOT EXISTS drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id INTEGER,
    account_id INTEGER,
    platform TEXT NOT NULL DEFAULT 'xiaohongshu',
    content_type TEXT NOT NULL DEFAULT 'image_text',
    title TEXT NOT NULL DEFAULT '',
    desc TEXT NOT NULL DEFAULT '',
    body_md TEXT NOT NULL DEFAULT '',
    body_html TEXT NOT NULL DEFAULT '',
    wx_theme TEXT NOT NULL DEFAULT '',
    media_type TEXT NOT NULL DEFAULT 'image',
    visibility INTEGER NOT NULL DEFAULT 0,
    images TEXT NOT NULL DEFAULT '[]',
    topics TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'draft',
    compliance TEXT NOT NULL DEFAULT '[]',
    source_note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY(topic_id) REFERENCES topics(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    draft_id INTEGER NOT NULL,
    account_id INTEGER,
    platform TEXT NOT NULL DEFAULT 'xiaohongshu',
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 4,
    next_run_at INTEGER NOT NULL,
    scheduled_at INTEGER NOT NULL DEFAULT 0,
    -- 已把内容提交到平台的时间；用于区分「提交后中断」与「尚未提交」。
    submitted_at INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(draft_id, account_id),
    FOREIGN KEY(draft_id) REFERENCES drafts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(status, next_run_at);

CREATE TABLE IF NOT EXISTS records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER,
    draft_id INTEGER,
    account_id INTEGER,
    platform TEXT NOT NULL DEFAULT 'xiaohongshu',
    success INTEGER NOT NULL,
    message TEXT NOT NULL DEFAULT '',
    remote_note_id TEXT NOT NULL DEFAULT '',
    result TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_records_account ON records(account_id, created_at);

CREATE TABLE IF NOT EXISTS published_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL DEFAULT 'xiaohongshu',
    account_id INTEGER NOT NULL,
    remote_note_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    desc TEXT NOT NULL DEFAULT '',
    cover TEXT NOT NULL DEFAULT '',
    note_type TEXT NOT NULL DEFAULT 'image',
    visibility TEXT NOT NULL DEFAULT '',
    -- 平台没返回的指标存 NULL，页面才能区分「0 阅读」和「平台没给」。
    views INTEGER,
    likes INTEGER,
    comments INTEGER,
    collects INTEGER,
    published_at INTEGER NOT NULL DEFAULT 0,
    url TEXT NOT NULL DEFAULT '',
    raw TEXT NOT NULL DEFAULT '{}',
    synced_at INTEGER NOT NULL,
    metrics_synced_at INTEGER NOT NULL DEFAULT 0,
    comment_synced_at INTEGER NOT NULL DEFAULT 0,
    health_state TEXT NOT NULL DEFAULT 'unknown',
    health_checked_at INTEGER NOT NULL DEFAULT 0,
    health_note TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(account_id, remote_note_id)
);
CREATE INDEX IF NOT EXISTS idx_published_account
    ON published_notes(account_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_published_platform
    ON published_notes(platform, published_at DESC);

CREATE TABLE IF NOT EXISTS rate_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate ON rate_events(account_id, action, created_at);

CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT 'xiaohongshu',
    kind TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    auto INTEGER NOT NULL DEFAULT 0,
    trigger_type TEXT NOT NULL DEFAULT 'time_point',
    time_of_day TEXT NOT NULL DEFAULT '09:00',
    weekdays TEXT NOT NULL DEFAULT '[]',
    interval_minutes INTEGER NOT NULL DEFAULT 360,
    config TEXT NOT NULL DEFAULT '{}',
    next_run_at INTEGER NOT NULL DEFAULT 0,
    last_run_at INTEGER NOT NULL DEFAULT 0,
    last_status TEXT NOT NULL DEFAULT '',
    last_message TEXT NOT NULL DEFAULT '',
    running INTEGER NOT NULL DEFAULT 0,
    failures INTEGER NOT NULL DEFAULT 0,
    paused_reason TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS schedule_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    schedule_id INTEGER NOT NULL,
    schedule_name TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT '',
    trigger TEXT NOT NULL DEFAULT 'auto',
    status TEXT NOT NULL DEFAULT 'running',
    started_at INTEGER NOT NULL,
    finished_at INTEGER NOT NULL DEFAULT 0,
    message TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    output TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_schedule_runs ON schedule_runs(schedule_id, id DESC);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- 指标按日快照：当前值仍在 published_notes，这张表只留历史趋势。
CREATE TABLE IF NOT EXISTS published_metrics_daily (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id INTEGER NOT NULL,
    day TEXT NOT NULL,
    views INTEGER,
    likes INTEGER,
    comments INTEGER,
    collects INTEGER,
    captured_at INTEGER NOT NULL,
    UNIQUE(note_id, day)
);
CREATE INDEX IF NOT EXISTS idx_metrics_note ON published_metrics_daily(note_id, day);

-- 评论只读缓存：严格只读，不回复、不点赞、不删除。
CREATE TABLE IF NOT EXISTS note_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL,
    account_id INTEGER NOT NULL DEFAULT 0,
    remote_note_id TEXT NOT NULL,
    remote_comment_id TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    author_id TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    likes INTEGER,
    is_reply INTEGER NOT NULL DEFAULT 0,
    parent_comment_id TEXT NOT NULL DEFAULT '',
    commented_at INTEGER NOT NULL DEFAULT 0,
    synced_at INTEGER NOT NULL,
    UNIQUE(platform, remote_note_id, remote_comment_id)
);
CREATE INDEX IF NOT EXISTS idx_comments_note
    ON note_comments(platform, remote_note_id, commented_at DESC);

-- 通知渠道（先支持通用 Webhook，其余类型按同一契约扩展）。
CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL DEFAULT 'webhook',
    name TEXT NOT NULL DEFAULT '',
    target TEXT NOT NULL DEFAULT '',
    events TEXT NOT NULL DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_sent_at INTEGER NOT NULL DEFAULT 0,
    last_status TEXT NOT NULL DEFAULT ''
);

-- 站内消息中心：所有需要用户处理的事都先落这里。
CREATE TABLE IF NOT EXISTS notification_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT NOT NULL DEFAULT 'info',
    event TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL DEFAULT '',
    link_view TEXT NOT NULL DEFAULT '',
    link_id INTEGER NOT NULL DEFAULT 0,
    read INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notification_events
    ON notification_events(created_at DESC);

-- 风控与审计时间线：触发原因、冷却区间、人工解除都留痕。
CREATE TABLE IF NOT EXISTS risk_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_risk_account ON risk_events(account_id, started_at DESC);

-- 简化代理池：一个条目就是一条可测试、可绑定账号的代理。
CREATE TABLE IF NOT EXISTS proxies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    country TEXT NOT NULL DEFAULT '',
    timezone TEXT NOT NULL DEFAULT '',
    exit_ip TEXT NOT NULL DEFAULT '',
    last_check_at INTEGER NOT NULL DEFAULT 0,
    last_status TEXT NOT NULL DEFAULT '',
    last_latency_ms INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
"""


def connect() -> sqlite3.Connection:
    conn = getattr(_local, "conn", None)
    if conn is not None:
        return conn
    config.ensure_dirs()
    conn = sqlite3.connect(config.DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=10000")
    conn.execute("PRAGMA foreign_keys=ON")
    _local.conn = conn
    return conn


def close() -> None:
    conn = getattr(_local, "conn", None)
    if conn is not None:
        conn.close()
        _local.conn = None


def init_db() -> None:
    """建表与迁移放在同一个事务里，失败时整体回滚，不留半套结构。"""
    config.ensure_dirs()
    conn = connect()
    conn.execute("BEGIN IMMEDIATE")
    try:
        for statement in SCHEMA.split(";"):
            if statement.strip():
                conn.execute(statement)
        # 旧库的结构升级顺序有讲究：先重建 jobs（旧版唯一约束），再补新列，
        # 否则重建时会把刚补上的 platform 列丢掉。
        # 先重建可能带 NOT NULL 指标列的 published_notes，再补新列；
        # 反过来会让刚补上的新列在重建时被丢掉。
        _migrate_jobs_multi_account(conn)
        _migrate_published_metrics(conn)
        _migrate_columns(conn)
        _dedupe_jobs(conn)
        # 新版纸感接管默认配图模板；只迁移一次，之后用户仍可改选其它模板。
        style_migrated = conn.execute(
            "SELECT value FROM settings WHERE key = 'card_style_v2_migrated'"
        ).fetchone()
        if style_migrated is None:
            conn.execute(
                "INSERT INTO settings(key, value) VALUES('card_style', 'paper') "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
            )
            conn.execute(
                "INSERT INTO settings(key, value) VALUES('card_style_v2_migrated', '1') "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
            )
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_draft_account "
            "ON jobs(draft_id, IFNULL(account_id, -1))"
        )
        # 平台索引必须等 platform 列补完再建，旧库才不会是「无此列」。
        for statement in (
            "CREATE INDEX IF NOT EXISTS idx_accounts_platform ON accounts(platform)",
            "CREATE INDEX IF NOT EXISTS idx_drafts_platform ON drafts(platform)",
            "CREATE INDEX IF NOT EXISTS idx_jobs_platform ON jobs(platform)",
            "CREATE INDEX IF NOT EXISTS idx_records_platform ON records(platform, created_at)",
            "CREATE INDEX IF NOT EXISTS idx_schedules_platform ON schedules(platform)",
        ):
            conn.execute(statement)
        conn.commit()
    except Exception:
        conn.rollback()
        raise


def _migrate_columns(conn: sqlite3.Connection) -> None:
    """给旧库补新列：SQLite 的 ADD COLUMN 没有 IF NOT EXISTS。

    现有数据全部归到小红书，不需要人工迁移；平台的 ``content_type`` 还会按
    旧的 ``media_type`` 回填，视频草稿不会被误标成图文。
    """
    wanted = {
        "accounts": {
            "platform": "TEXT NOT NULL DEFAULT 'xiaohongshu'",
            "published_synced_at": "INTEGER NOT NULL DEFAULT 0",
            "published_sync_error": "TEXT NOT NULL DEFAULT ''",
            # 账号环境：独立 Profile、出口记录、健康态与风控冷却。
            "profile_key": "TEXT NOT NULL DEFAULT ''",
            "proxy_group": "TEXT NOT NULL DEFAULT ''",
            "exit_ip": "TEXT NOT NULL DEFAULT ''",
            "exit_country": "TEXT NOT NULL DEFAULT ''",
            "exit_timezone": "TEXT NOT NULL DEFAULT ''",
            "exit_checked_at": "INTEGER NOT NULL DEFAULT 0",
            "health_state": "TEXT NOT NULL DEFAULT 'unknown'",
            "cooldown_until": "INTEGER NOT NULL DEFAULT 0",
            "probe_success_count": "INTEGER NOT NULL DEFAULT 0",
            "group_name": "TEXT NOT NULL DEFAULT ''",
            "tags": "TEXT NOT NULL DEFAULT '[]'",
        },
        "drafts": {
            "platform": "TEXT NOT NULL DEFAULT 'xiaohongshu'",
            "content_type": "TEXT NOT NULL DEFAULT 'image_text'",
            "source_note": "TEXT NOT NULL DEFAULT ''",
            # 新版设计卡的内容模型与素材缓存；旧模板不读取。
            "content_json": "TEXT NOT NULL DEFAULT '{}'",
            # 公众号富文本：Markdown 原稿与渲染后的 HTML，其它平台留空。
            "body_md": "TEXT NOT NULL DEFAULT ''",
            "body_html": "TEXT NOT NULL DEFAULT ''",
            # 公众号正文排版主题；内容与样式分开存，发布时再套。
            "wx_theme": "TEXT NOT NULL DEFAULT ''",
        },
        "jobs": {
            "platform": "TEXT NOT NULL DEFAULT 'xiaohongshu'",
            # 等待原因与待确认结果：让「为什么还没发」在队列里直接可见。
            "blocked_reason": "TEXT NOT NULL DEFAULT ''",
            "blocked_at": "INTEGER NOT NULL DEFAULT 0",
            "result_state": "TEXT NOT NULL DEFAULT 'normal'",
            "confirm_deadline": "INTEGER NOT NULL DEFAULT 0",
            "submitted_at": "INTEGER NOT NULL DEFAULT 0",
        },
        "published_notes": {
            "health_state": "TEXT NOT NULL DEFAULT 'unknown'",
            "health_checked_at": "INTEGER NOT NULL DEFAULT 0",
            "health_note": "TEXT NOT NULL DEFAULT ''",
            "metrics_synced_at": "INTEGER NOT NULL DEFAULT 0",
            "comment_synced_at": "INTEGER NOT NULL DEFAULT 0",
        },
        "records": {"platform": "TEXT NOT NULL DEFAULT 'xiaohongshu'"},
        "schedules": {"platform": "TEXT NOT NULL DEFAULT 'xiaohongshu'"},
        "topics": {"category": "TEXT NOT NULL DEFAULT ''"},
    }
    for table, columns in wanted.items():
        existing = {
            row["name"] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()
        }
        for name, ddl in columns.items():
            if name not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}")
    # 旧账号补一个稳定的 Profile 标识；已有值的不动。
    for row in conn.execute(
        "SELECT id FROM accounts WHERE IFNULL(profile_key, '') = ''"
    ).fetchall():
        conn.execute(
            "UPDATE accounts SET profile_key = ? WHERE id = ?",
            (f"profile-{int(row['id'])}", int(row["id"])),
        )
    # 旧草稿的 content_type 跟着 media_type 走：视频草稿标成 video。
    conn.execute(
        "UPDATE drafts SET content_type='video' "
        "WHERE media_type='video' AND content_type='image_text'"
    )


def _migrate_published_metrics(conn: sqlite3.Connection) -> None:
    """把旧的 ``views/likes/comments/collects NOT NULL`` 改成可空。

    旧库把平台没返回的指标写成了 0，无法和真实 0 区分；结构升级后新同步的
    记录会写 NULL。旧记录需要重新同步一次才能拿到空值语义。
    """
    info = conn.execute("PRAGMA table_info(published_notes)").fetchall()
    if not info:
        return
    metrics = {"views", "likes", "comments", "collects"}
    if not any(row["name"] in metrics and row["notnull"] for row in info):
        return
    # ALTER TABLE RENAME 会把索引一起带走，先删掉，重建后再补。
    conn.execute("DROP INDEX IF EXISTS idx_published_account")
    conn.execute("DROP INDEX IF EXISTS idx_published_platform")
    conn.execute("ALTER TABLE published_notes RENAME TO published_notes_legacy")
    conn.execute(
        """
        CREATE TABLE published_notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            platform TEXT NOT NULL DEFAULT 'xiaohongshu',
            account_id INTEGER NOT NULL,
            remote_note_id TEXT NOT NULL,
            title TEXT NOT NULL DEFAULT '',
            desc TEXT NOT NULL DEFAULT '',
            cover TEXT NOT NULL DEFAULT '',
            note_type TEXT NOT NULL DEFAULT 'image',
            visibility TEXT NOT NULL DEFAULT '',
            views INTEGER,
            likes INTEGER,
            comments INTEGER,
            collects INTEGER,
            published_at INTEGER NOT NULL DEFAULT 0,
            url TEXT NOT NULL DEFAULT '',
            raw TEXT NOT NULL DEFAULT '{}',
            synced_at INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(account_id, remote_note_id)
        )
        """
    )
    conn.execute(
        "INSERT INTO published_notes(id, platform, account_id, remote_note_id, title, desc, "
        "cover, note_type, visibility, views, likes, comments, collects, published_at, url, "
        "raw, synced_at, created_at, updated_at) "
        "SELECT id, platform, account_id, remote_note_id, title, desc, cover, note_type, "
        "visibility, views, likes, comments, collects, published_at, url, raw, synced_at, "
        "created_at, updated_at FROM published_notes_legacy"
    )
    conn.execute("DROP TABLE published_notes_legacy")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_published_account "
        "ON published_notes(account_id, published_at DESC)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_published_platform "
        "ON published_notes(platform, published_at DESC)"
    )
    logger.info("published_notes 指标列已改为可空，旧记录需重新同步以获得空值语义")


def _migrate_jobs_multi_account(conn: sqlite3.Connection) -> None:
    """把旧的「一稿一条队列」约束升级为「一稿一账号一条」。

    旧库的 jobs 表在 draft_id 上有单列唯一索引；一稿多号需要允许同一
    draft_id 对应多个 account_id。检测到旧约束时重建表并搬运数据。
    受调用方事务保护，失败会整体回滚。
    """
    for index in conn.execute("PRAGMA index_list(jobs)").fetchall():
        if not index["unique"]:
            continue
        columns = [
            row["name"]
            for row in conn.execute(f"PRAGMA index_info('{index['name']}')").fetchall()
        ]
        if columns != ["draft_id"]:
            continue
        conn.execute("ALTER TABLE jobs RENAME TO jobs_legacy")
        conn.execute(
            """
            CREATE TABLE jobs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                draft_id INTEGER NOT NULL,
                account_id INTEGER,
                status TEXT NOT NULL DEFAULT 'pending',
                attempts INTEGER NOT NULL DEFAULT 0,
                max_attempts INTEGER NOT NULL DEFAULT 4,
                next_run_at INTEGER NOT NULL,
                scheduled_at INTEGER NOT NULL DEFAULT 0,
                last_error TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                UNIQUE(draft_id, account_id),
                FOREIGN KEY(draft_id) REFERENCES drafts(id) ON DELETE CASCADE
            )
            """
        )
        conn.execute(
            "INSERT INTO jobs(id, draft_id, account_id, status, attempts, max_attempts, "
            "next_run_at, scheduled_at, last_error, created_at, updated_at) "
            "SELECT id, draft_id, account_id, status, attempts, max_attempts, "
            "next_run_at, scheduled_at, last_error, created_at, updated_at FROM jobs_legacy"
        )
        conn.execute("DROP TABLE jobs_legacy")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(status, next_run_at)")
        return


def _dedupe_jobs(conn: sqlite3.Connection) -> None:
    """唯一索引上线前先清理历史重复：同一草稿同一账号只保留最新一条。

    ``UNIQUE(draft_id, account_id)`` 在 SQLite 里对 NULL 不生效，所以旧库里
    可能有多条 account_id 为 NULL 的待发布任务；这里一并合并。
    """
    duplicates = conn.execute(
        "SELECT draft_id, IFNULL(account_id, -1) AS account_key, COUNT(*) AS total "
        "FROM jobs GROUP BY draft_id, account_key HAVING total > 1"
    ).fetchall()
    removed = 0
    for row in duplicates:
        keep = conn.execute(
            "SELECT id FROM jobs WHERE draft_id = ? AND IFNULL(account_id, -1) = ? "
            "ORDER BY id DESC LIMIT 1",
            (row["draft_id"], row["account_key"]),
        ).fetchone()
        cursor = conn.execute(
            "DELETE FROM jobs WHERE draft_id = ? AND IFNULL(account_id, -1) = ? AND id != ?",
            (row["draft_id"], row["account_key"], keep["id"]),
        )
        removed += cursor.rowcount
    if removed:
        logger.warning(f"发布队列清理重复任务 {removed} 条（同草稿同账号只保留最新一条）")


@contextmanager
def transaction() -> Iterator[sqlite3.Connection]:
    """事务边界保护：嵌套调用复用外层事务，内层不提交。

    同一线程只有一个连接。若在 ``with transaction()`` 里再调用
    ``db.execute()``（内部也会走 ``transaction()``），旧实现会在内层提前
    提交，导致外层后半段脱离事务。这里用线程内深度计数，只有最外层负责
    提交/回滚。
    """
    conn = connect()
    depth = int(getattr(_local, "txn_depth", 0) or 0)
    if depth:
        _local.txn_depth = depth + 1
        try:
            yield conn
        finally:
            _local.txn_depth = depth
        return
    _local.txn_depth = 1
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        _local.txn_depth = 0


def query(sql: str, args: Sequence[Any] = ()) -> list[sqlite3.Row]:
    return list(connect().execute(sql, args).fetchall())


def query_one(sql: str, args: Sequence[Any] = ()) -> sqlite3.Row | None:
    return connect().execute(sql, args).fetchone()


def scalar(sql: str, args: Sequence[Any] = (), default: Any = None) -> Any:
    row = query_one(sql, args)
    if row is None:
        return default
    value = row[0]
    return default if value is None else value


def execute(sql: str, args: Sequence[Any] = ()) -> int:
    with transaction() as conn:
        cursor = conn.execute(sql, args)
        return int(cursor.lastrowid or 0)


def execute_many(sql: str, rows: Iterable[Sequence[Any]]) -> None:
    with transaction() as conn:
        conn.executemany(sql, list(rows))


def now() -> int:
    return int(time.time())


# ---------------------------------------------------------------- settings

def get_setting(key: str, default: str | None = None) -> str:
    fallback = config.DEFAULT_SETTINGS.get(key, default if default is not None else "")
    row = query_one("SELECT value FROM settings WHERE key = ?", (key,))
    return row["value"] if row else fallback


def get_int_setting(key: str, default: int = 0) -> int:
    try:
        return int(float(get_setting(key, str(default))))
    except (TypeError, ValueError):
        return default


def set_setting(key: str, value: Any) -> None:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    with transaction() as conn:
        conn.execute(
            "INSERT INTO settings(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, text),
        )


def all_settings() -> dict[str, str]:
    values = dict(config.DEFAULT_SETTINGS)
    for row in query("SELECT key, value FROM settings"):
        values[row["key"]] = row["value"]
    return values


# ---------------------------------------------------------------- helpers

def row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row is not None else None


def json_field(value: Any, default: Any) -> Any:
    if value in (None, ""):
        return default
    if isinstance(value, (list, dict)):
        return value
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return default
