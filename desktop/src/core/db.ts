/**
 * SQLite 访问层：沿用 Python 版的库结构，空机器第一次启动时自动建库。
 *
 * 迁移期需要与 Python 版共存：WAL + busy_timeout 让两个进程轮流写入而不
 * 报 database is locked。建表全部用 CREATE TABLE IF NOT EXISTS，旧库只
 * 补缺失列，不动已有数据。
 */
import fs from "node:fs";
import Database from "better-sqlite3";
import { DB_PATH, ensureDirs } from "./config";
import { log } from "./log";

let database: Database.Database | null = null;

interface CachedStatement {
  all(...args: unknown[]): unknown[];
  get(...args: unknown[]): unknown;
  run(...args: unknown[]): { lastInsertRowid: number | bigint; changes: number | bigint };
}

// 热路径复用已编译语句，避免每次查询重新 prepare。
const statements = new Map<string, CachedStatement>();

function prepare(sql: string): CachedStatement {
  let statement = statements.get(sql);
  if (!statement) {
    statement = getDb().prepare(sql) as unknown as CachedStatement;
    statements.set(sql, statement);
  }
  return statement;
}

/**
 * 完整表结构（对齐 Python 版 ops/db.py 的最终形态）。
 *
 * 列顺序、默认值、可空性与线上库一致；新增列直接写进建表语句，
 * 旧库由 migrate() 的补列逻辑处理。
 */
const SCHEMA = `
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
  avatar TEXT NOT NULL DEFAULT '',
  profile_key TEXT NOT NULL DEFAULT '',
  proxy_group TEXT NOT NULL DEFAULT '',
  exit_ip TEXT NOT NULL DEFAULT '',
  exit_country TEXT NOT NULL DEFAULT '',
  exit_timezone TEXT NOT NULL DEFAULT '',
  exit_checked_at INTEGER NOT NULL DEFAULT 0,
  health_state TEXT NOT NULL DEFAULT 'unknown',
  cooldown_until INTEGER NOT NULL DEFAULT 0,
  probe_success_count INTEGER NOT NULL DEFAULT 0,
  group_name TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
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
  content_json TEXT NOT NULL DEFAULT '{}',
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
  submitted_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  blocked_reason TEXT NOT NULL DEFAULT '',
  blocked_at INTEGER NOT NULL DEFAULT 0,
  result_state TEXT NOT NULL DEFAULT 'normal',
  confirm_deadline INTEGER NOT NULL DEFAULT 0,
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

-- 外观账本（M1 出图 2.0）：记录每账号每次选用的风格/版式/调色板。
CREATE TABLE IF NOT EXISTS design_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER,
  draft_id INTEGER NOT NULL,
  platform TEXT NOT NULL DEFAULT '',
  style TEXT NOT NULL DEFAULT '',
  layout TEXT NOT NULL DEFAULT '',
  palette TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_design_ledger_account ON design_ledger(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_design_ledger_draft ON design_ledger(draft_id);

-- M3 自定义出图模板：schema 列存编辑器整份 JSON（pages{cover,content,ending}）。
CREATE TABLE IF NOT EXISTS custom_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  schema TEXT NOT NULL DEFAULT '{}',
  preview TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

/** 旧库缺列时补上；SQLite 的 ADD COLUMN 没有 IF NOT EXISTS。 */
const WANTED_COLUMNS: Record<string, Record<string, string>> = {
  accounts: {
    platform: "TEXT NOT NULL DEFAULT 'xiaohongshu'",
    avatar: "TEXT NOT NULL DEFAULT ''",
    published_synced_at: "INTEGER NOT NULL DEFAULT 0",
    published_sync_error: "TEXT NOT NULL DEFAULT ''",
    profile_key: "TEXT NOT NULL DEFAULT ''",
    proxy_group: "TEXT NOT NULL DEFAULT ''",
    exit_ip: "TEXT NOT NULL DEFAULT ''",
    exit_country: "TEXT NOT NULL DEFAULT ''",
    exit_timezone: "TEXT NOT NULL DEFAULT ''",
    exit_checked_at: "INTEGER NOT NULL DEFAULT 0",
    health_state: "TEXT NOT NULL DEFAULT 'unknown'",
    cooldown_until: "INTEGER NOT NULL DEFAULT 0",
    probe_success_count: "INTEGER NOT NULL DEFAULT 0",
    group_name: "TEXT NOT NULL DEFAULT ''",
    tags: "TEXT NOT NULL DEFAULT '[]'",
  },
  drafts: {
    platform: "TEXT NOT NULL DEFAULT 'xiaohongshu'",
    content_type: "TEXT NOT NULL DEFAULT 'image_text'",
    source_note: "TEXT NOT NULL DEFAULT ''",
    content_json: "TEXT NOT NULL DEFAULT '{}'",
    body_md: "TEXT NOT NULL DEFAULT ''",
    body_html: "TEXT NOT NULL DEFAULT ''",
    wx_theme: "TEXT NOT NULL DEFAULT ''",
  },
  jobs: {
    platform: "TEXT NOT NULL DEFAULT 'xiaohongshu'",
    blocked_reason: "TEXT NOT NULL DEFAULT ''",
    blocked_at: "INTEGER NOT NULL DEFAULT 0",
    result_state: "TEXT NOT NULL DEFAULT 'normal'",
    confirm_deadline: "INTEGER NOT NULL DEFAULT 0",
    submitted_at: "INTEGER NOT NULL DEFAULT 0",
  },
  published_notes: {
    health_state: "TEXT NOT NULL DEFAULT 'unknown'",
    health_checked_at: "INTEGER NOT NULL DEFAULT 0",
    health_note: "TEXT NOT NULL DEFAULT ''",
    metrics_synced_at: "INTEGER NOT NULL DEFAULT 0",
    comment_synced_at: "INTEGER NOT NULL DEFAULT 0",
  },
  records: { platform: "TEXT NOT NULL DEFAULT 'xiaohongshu'" },
  schedules: { platform: "TEXT NOT NULL DEFAULT 'xiaohongshu'" },
  topics: { category: "TEXT NOT NULL DEFAULT ''" },
};

const PLATFORM_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_accounts_platform ON accounts(platform)",
  "CREATE INDEX IF NOT EXISTS idx_drafts_platform ON drafts(platform)",
  "CREATE INDEX IF NOT EXISTS idx_jobs_platform ON jobs(platform)",
  "CREATE INDEX IF NOT EXISTS idx_records_platform ON records(platform, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_schedules_platform ON schedules(platform)",
];

function tableColumns(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name?: string }[];
  return new Set(rows.map((row) => String(row.name || "")));
}

function ensureColumns(db: Database.Database): void {
  for (const [table, columns] of Object.entries(WANTED_COLUMNS)) {
    const existing = tableColumns(db, table);
    if (!existing.size) continue;
    for (const [name, ddl] of Object.entries(columns)) {
      if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
    }
  }
}

/** 唯一索引上线前先清理历史重复：同一草稿同一账号只保留最新一条。 */
function dedupeJobs(db: Database.Database): void {
  const duplicates = db
    .prepare(
      "SELECT draft_id, IFNULL(account_id, -1) AS account_key, COUNT(*) AS total " +
        "FROM jobs GROUP BY draft_id, account_key HAVING total > 1"
    )
    .all() as { draft_id: number; account_key: number }[];
  for (const row of duplicates) {
    const keep = db
      .prepare(
        "SELECT id FROM jobs WHERE draft_id = ? AND IFNULL(account_id, -1) = ? " +
          "ORDER BY id DESC LIMIT 1"
      )
      .get(row.draft_id, row.account_key) as { id: number } | undefined;
    if (!keep) continue;
    db.prepare(
      "DELETE FROM jobs WHERE draft_id = ? AND IFNULL(account_id, -1) = ? AND id != ?"
    ).run(row.draft_id, row.account_key, keep.id);
  }
}

/** 建表与迁移放在同一个事务里，失败整体回滚，不留半套结构。 */
function migrate(db: Database.Database): void {
  const run = db.transaction(() => {
    db.exec(SCHEMA);
    ensureColumns(db);
    dedupeJobs(db);
    // 唯一约束只覆盖“活跃任务”：失败的旧任务不能阻止同一草稿重新入队。
    db.exec("DROP INDEX IF EXISTS idx_jobs_draft_account");
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_draft_account " +
        "ON jobs(draft_id, IFNULL(account_id, -1)) " +
        "WHERE status IN ('pending', 'retry', 'running', 'pending_confirm')"
    );
    for (const statement of PLATFORM_INDEXES) db.exec(statement);
    // 旧账号补一个稳定的 Profile 标识；已有值的不动。
    db.exec(
      "UPDATE accounts SET profile_key = 'profile-' || id " +
        "WHERE IFNULL(profile_key, '') = ''"
    );
    // 旧草稿的 content_type 跟着 media_type 走：视频草稿标成 video。
    db.exec(
      "UPDATE drafts SET content_type = 'video' " +
        "WHERE media_type = 'video' AND content_type = 'image_text'"
    );
  });
  run();
}

export function getDb(): Database.Database {
  if (database) return database;
  ensureDirs();
  const fresh = !fs.existsSync(DB_PATH);
  database = new Database(DB_PATH);
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = NORMAL");
  database.pragma("busy_timeout = 10000");
  database.pragma("foreign_keys = ON");
  migrate(database);
  log.info(fresh ? `已创建并初始化数据库 ${DB_PATH}` : `已打开数据库 ${DB_PATH}`);
  return database;
}

export function queryAll<T = Record<string, unknown>>(
  sql: string,
  ...args: unknown[]
): T[] {
  return prepare(sql).all(...args) as T[];
}

export function queryOne<T = Record<string, unknown>>(
  sql: string,
  ...args: unknown[]
): T | undefined {
  return prepare(sql).get(...args) as T | undefined;
}

export function execute(sql: string, ...args: unknown[]): number {
  const result = prepare(sql).run(...args);
  return Number(result.lastInsertRowid || 0);
}

export function closeDb(): void {
  statements.clear();
  database?.close();
  database = null;
}
