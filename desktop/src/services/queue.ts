/** 发布队列与发布记录：入队、取消、重试、人工确认。 */
import { now } from "../core/config";
import { execute, getDb, queryAll, queryOne } from "../core/db";
import { DEFAULT_PLATFORM, isPlatformReady, normalizePlatform, platformLabel } from "../core/platform";
import { getIntSetting } from "../core/settings";

interface JobRow {
  id: number;
  draft_id: number;
  account_id: number | null;
  platform: string;
  status: string;
  attempts: number;
  max_attempts: number;
  next_run_at: number;
  scheduled_at: number;
  last_error: string;
  blocked_reason?: string;
  blocked_at?: number;
  result_state?: string;
  confirm_deadline?: number;
  submitted_at?: number;
  created_at: number;
  updated_at: number;
}

export function parseWhen(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") {
    const number = Math.trunc(value);
    return number > 10_000_000_000 ? Math.floor(number / 1000) : number;
  }
  const text = String(value).trim();
  if (!text) return 0;
  if (/^\d+$/.test(text)) return parseWhen(Number(text));
  // 兼容 2026/11/24 10:00 一类写法，并按本机时区解析，避免整体偏移。
  const normalized = text.replace(/[／/]/g, "-").replace(/\s+/g, " ").trim();
  const dateOnly = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(normalized);
  if (dateOnly) {
    const stamp = new Date(
      Number(dateOnly[1]),
      Number(dateOnly[2]) - 1,
      Number(dateOnly[3]),
      0,
      0,
      0,
      0
    ).getTime();
    return Number.isFinite(stamp) ? Math.floor(stamp / 1000) : 0;
  }
  const local = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(
    normalized
  );
  if (local) {
    const stamp = new Date(
      Number(local[1]),
      Number(local[2]) - 1,
      Number(local[3]),
      Number(local[4]),
      Number(local[5]),
      Number(local[6] || 0),
      0
    ).getTime();
    return Number.isFinite(stamp) ? Math.floor(stamp / 1000) : 0;
  }
  const stamp = Date.parse(normalized.replace(" ", "T"));
  if (Number.isFinite(stamp)) return Math.floor(stamp / 1000);
  // 宁可报错，也不要静默返回 0 变成立即发布。
  throw Object.assign(
    new Error(`无法识别的时间：${text}，请使用 2026-11-24 10:00 这种格式`),
    { status: 400 }
  );
}

export function serializeJob(row: JobRow | undefined): Record<string, unknown> | null {
  if (!row) return null;
  const draft = queryOne<{ title: string; status: string }>(
    "SELECT title, status FROM drafts WHERE id = ?",
    row.draft_id
  );
  const account = row.account_id
    ? queryOne<{ name: string; nickname: string }>(
        "SELECT name, nickname FROM accounts WHERE id = ?",
        row.account_id
      )
    : undefined;
  return {
    id: row.id,
    draft_id: row.draft_id,
    draft_title: draft ? draft.title : "(草稿已删除)",
    draft_status: draft ? draft.status : "",
    platform: row.platform || DEFAULT_PLATFORM,
    platform_name: platformLabel(row.platform),
    account_id: row.account_id,
    account_name: account ? account.nickname || account.name : "",
    status: row.status,
    result_state: row.result_state || "normal",
    confirm_deadline: Number(row.confirm_deadline || 0),
    blocked_reason: row.blocked_reason || "",
    blocked_at: Number(row.blocked_at || 0),
    submitted_at: Number(row.submitted_at || 0),
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    next_run_at: row.next_run_at,
    scheduled_at: row.scheduled_at,
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function buildJobFilters(status: string, reason: string) {
  const where: string[] = [];
  const args: unknown[] = [];
  if (status === "waiting") {
    where.push("status IN ('pending','retry')");
  } else if (status) {
    where.push("status = ?");
    args.push(status);
  }
  if (reason) {
    where.push(
      "CASE WHEN IFNULL(blocked_reason,'') = '' THEN '等待执行' ELSE blocked_reason END = ?"
    );
    args.push(reason);
  }
  return { sql: where.length ? ` WHERE ${where.join(" AND ")}` : "", args };
}

export function listJobs(limit = 100, offset = 0, status = "", reason = ""): Record<string, unknown>[] {
  const filter = buildJobFilters(status, reason);
  const rows = queryAll<JobRow>(
    `SELECT * FROM jobs${filter.sql} ORDER BY id DESC LIMIT ? OFFSET ?`,
    ...filter.args,
    Math.max(1, limit),
    Math.max(0, Math.trunc(offset))
  );
  return rows.map((row) => serializeJob(row)).filter(Boolean) as Record<string, unknown>[];
}

export function countJobs(status = "", reason = ""): number {
  const filter = buildJobFilters(status, reason);
  const row = queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM jobs${filter.sql}`, ...filter.args);
  return Number(row?.n || 0);
}

export function listDraftJobs(draftId: number): Record<string, unknown>[] {
  return queryAll<JobRow>("SELECT * FROM jobs WHERE draft_id = ? ORDER BY id", draftId)
    .map((row) => serializeJob(row))
    .filter(Boolean) as Record<string, unknown>[];
}

export function queueReasons(): Record<string, unknown> {
  const rows = queryAll<{ reason: string; total: number; next_at: number }>(
    "SELECT CASE WHEN IFNULL(blocked_reason,'') = '' THEN '等待执行' ELSE blocked_reason END AS reason, " +
      "COUNT(*) AS total, MIN(next_run_at) AS next_at FROM jobs " +
      "WHERE status IN ('pending','retry') GROUP BY reason ORDER BY total DESC"
  );
  const pending = queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM jobs WHERE status='pending_confirm'"
  );
  const waiting = queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM jobs WHERE status IN ('pending','retry')"
  );
  return {
    groups: rows.map((row) => ({
      reason: row.reason,
      count: Number(row.total || 0),
      next_at: Number(row.next_at || 0),
    })),
    pending_confirm: Number(pending?.n || 0),
    waiting: Number(waiting?.n || 0),
  };
}

export function getJobRow(jobId: number): JobRow {
  const row = queryOne<JobRow>("SELECT * FROM jobs WHERE id = ?", jobId);
  if (!row) throw Object.assign(new Error(`任务不存在: ${jobId}`), { status: 404 });
  return row;
}

function getDraftRow(draftId: number): { id: number; status: string; platform: string } {
  const row = queryOne<{ id: number; status: string; platform: string }>(
    "SELECT id, status, platform FROM drafts WHERE id = ?",
    draftId
  );
  if (!row) throw Object.assign(new Error(`草稿不存在: ${draftId}`), { status: 404 });
  return row;
}

function ensurePlatform(draft: { platform: string }): string {
  const platform = normalizePlatform(draft.platform);
  if (!isPlatformReady(platform)) {
    throw new Error(`${platformLabel(platform)} 的发布接入位已预留，暂时只能保存草稿。`);
  }
  return platform;
}

function checkAccountPlatform(accountId: number, platform: string): void {
  const row = queryOne<{ platform: string }>("SELECT platform FROM accounts WHERE id = ?", accountId);
  if (!row) throw new Error(`账号不存在: ${accountId}`);
  const accountPlatform = row.platform || DEFAULT_PLATFORM;
  if (accountPlatform !== platform) {
    throw new Error(
      `草稿属于${platformLabel(platform)}，但账号属于${platformLabel(accountPlatform)}；请选择同平台账号。`
    );
  }
}

function enqueueOne(
  draftId: number,
  accountId: number | null,
  scheduled: number,
  nextRun: number,
  stamp: number,
  platform: string
): { row: JobRow; existed: boolean; alreadyDone: boolean } {
  const maxAttempts = getIntSetting("job_max_attempts", 4);
  const reason = scheduled > stamp + 60 ? "已排期，等待到点" : "";
  getDb()
    .prepare(
      "INSERT INTO jobs(draft_id, account_id, platform, status, attempts, max_attempts, " +
        "next_run_at, scheduled_at, last_error, blocked_reason, blocked_at, created_at, updated_at) " +
        "VALUES(?,?,?, 'pending', 0, ?, ?, ?, '', ?, ?, ?, ?) ON CONFLICT DO NOTHING"
    )
    .run(
      draftId,
      accountId,
      platform,
      maxAttempts,
      nextRun,
      scheduled,
      reason,
      reason ? stamp : 0,
      stamp,
      stamp
    );
  const row = queryOne<JobRow>(
    "SELECT * FROM jobs WHERE draft_id = ? AND account_id IS ?",
    draftId,
    accountId
  );
  if (!row) throw new Error("写入发布队列失败，请重试");
  if (row.status === "success") return { row, existed: true, alreadyDone: true };
  const existed = ["pending", "retry", "running", "pending_confirm"].includes(row.status);
  if (!existed) {
    getDb()
      .prepare(
        "UPDATE jobs SET status='pending', attempts=0, scheduled_at=?, next_run_at=?, " +
          "last_error='', blocked_reason='', blocked_at=0, result_state='normal', " +
          "confirm_deadline=0, submitted_at=0, updated_at=? WHERE id=?"
      )
      .run(scheduled, nextRun, stamp, row.id);
  }
  return { row, existed, alreadyDone: false };
}

export function enqueue(
  draftId: number,
  accountId: number | null = null,
  scheduledAt: unknown = 0
): Record<string, unknown> {
  const draft = getDraftRow(draftId);
  if (draft.status === "published") throw new Error("该草稿已发布");
  const platform = ensurePlatform(draft);
  if (accountId !== null) checkAccountPlatform(accountId, platform);
  const active = queryOne<JobRow>(
    "SELECT * FROM jobs WHERE draft_id = ? AND status IN ('pending','retry','running','pending_confirm') ORDER BY id LIMIT 1",
    draftId
  );
  // 只有同一账号（或再次请求「任意账号」）才视为已存在；不能因为存在一条
  // 未指定账号的活跃任务，就吞掉指定账号的入队，否则多账号投放会少发。
  if (active && (accountId === null || active.account_id === accountId)) {
    return { ...serializeJob(active), existed: true };
  }
  if (active) throw new Error("该草稿已在发布队列中，请先在队列里取消");
  const scheduled = parseWhen(scheduledAt);
  const stamp = now();
  const nextRun = scheduled ? Math.max(stamp, scheduled) : stamp;
  const result = getDb().transaction(() => {
    const outcome = enqueueOne(draftId, accountId, scheduled, nextRun, stamp, platform);
    if (outcome.alreadyDone) throw new Error("该草稿已经发布成功，无需重复入队");
    execute(
      "UPDATE drafts SET status='queued', account_id=COALESCE(?, account_id), updated_at=? " +
        "WHERE id=? AND status != 'published'",
      accountId,
      stamp,
      draftId
    );
    return outcome;
  })();
  return { ...serializeJob(getJobRow(result.row.id)), existed: result.existed };
}

export function enqueueTargets(
  draftId: number,
  accountIds: number[],
  scheduledAt: unknown = 0
): Record<string, unknown>[] {
  const draft = getDraftRow(draftId);
  if (draft.status === "published") throw new Error("该草稿已发布");
  const platform = ensurePlatform(draft);
  const targets = [...new Set(accountIds.filter((item) => Number.isFinite(item) && item > 0))];
  if (!targets.length) throw new Error("请至少选择一个账号");
  targets.forEach((accountId) => checkAccountPlatform(accountId, platform));
  const scheduled = parseWhen(scheduledAt);
  const stamp = now();
  const nextRun = scheduled ? Math.max(stamp, scheduled) : stamp;
  const jobIds = getDb().transaction(() => {
    const ids: number[] = [];
    for (const accountId of targets) {
      const outcome = enqueueOne(draftId, accountId, scheduled, nextRun, stamp, platform);
      if (outcome.alreadyDone) continue;
      ids.push(outcome.row.id);
    }
    if (!ids.length) throw new Error("所选账号都已经发布过这篇草稿");
    execute(
      "UPDATE drafts SET status='queued', updated_at=? WHERE id=? AND status != 'published'",
      stamp,
      draftId
    );
    return ids;
  })();
  return jobIds
    .map((jobId) => serializeJob(getJobRow(jobId)))
    .filter(Boolean) as Record<string, unknown>[];
}

/** 批量入队：与 Python 的 service.enqueue 语义一致。 */
export function enqueueMany(
  draftIds: number[],
  accountId: number | null = null,
  accountIds: number[] = [],
  scheduledAt: unknown = 0
): Record<string, unknown>[] {
  const ids = [...new Set(draftIds.filter((item) => Number.isFinite(item) && item > 0))];
  if (!ids.length) throw new Error("请至少选择一篇草稿");
  const targets = [...new Set(accountIds.filter((item) => Number.isFinite(item) && item > 0))];
  const jobs: Record<string, unknown>[] = [];
  for (const draftId of ids) {
    if (targets.length) jobs.push(...enqueueTargets(draftId, targets, scheduledAt));
    else jobs.push(enqueue(draftId, accountId, scheduledAt));
  }
  return jobs;
}

export function cancelJob(jobId: number): Record<string, unknown> | null {
  const job = getJobRow(jobId);
  if (job.status === "pending_confirm") {
    throw new Error("结果待确认的任务不能直接取消，请先确认已发布或未发布");
  }
  if (!["pending", "retry"].includes(job.status)) throw new Error("只有等待中的任务可以取消");
  execute(
    "UPDATE jobs SET status='cancelled', blocked_reason='', blocked_at=0, updated_at=? WHERE id=?",
    now(),
    jobId
  );
  const other = queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM jobs WHERE draft_id=? AND id!=? AND status IN ('pending','retry','running','pending_confirm')",
    job.draft_id,
    jobId
  );
  if (!Number(other?.n || 0)) {
    const success = queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM jobs WHERE draft_id=? AND status='success'",
      job.draft_id
    );
    execute(
      "UPDATE drafts SET status=?, updated_at=? WHERE id=?",
      Number(success?.n || 0) ? "published" : "draft",
      now(),
      job.draft_id
    );
  }
  return serializeJob(getJobRow(jobId));
}

export function retryJob(jobId: number): Record<string, unknown> | null {
  const job = getJobRow(jobId);
  if (job.status === "pending_confirm") {
    throw new Error("结果待确认的任务不会自动重试，请先人工确认发布结果");
  }
  if (!["failed", "cancelled"].includes(job.status)) throw new Error("只有失败或已取消的任务可以重试");
  const stamp = now();
  execute(
    "UPDATE jobs SET status='pending', attempts=0, next_run_at=?, last_error='', " +
      "blocked_reason='', blocked_at=0, result_state='normal', confirm_deadline=0, " +
      "submitted_at=0, updated_at=? WHERE id=?",
    stamp,
    stamp,
    jobId
  );
  execute("UPDATE drafts SET status='queued', updated_at=? WHERE id=?", stamp, job.draft_id);
  return serializeJob(getJobRow(jobId));
}

export function confirmJob(jobId: number, published: boolean): Record<string, unknown> | null {
  const job = getJobRow(jobId);
  if (job.status !== "pending_confirm") throw new Error("只有结果待确认的任务需要人工确认");
  const stamp = now();
  const account = job.account_id
    ? queryOne<{ id: number; last_publish_at: number }>(
        "SELECT id, last_publish_at FROM accounts WHERE id=?",
        job.account_id
      )
    : undefined;
  const countQuota = (job.platform || DEFAULT_PLATFORM) !== "wechat_mp";
  getDb().transaction(() => {
    if (published) {
      execute(
        "UPDATE jobs SET status='success', result_state='normal', confirm_deadline=0, " +
          "last_error='', blocked_reason='', updated_at=? WHERE id=?",
        stamp,
        jobId
      );
      if (account) {
        execute(
          "UPDATE accounts SET status='healthy', health_state='healthy', last_error=?, " +
            "last_publish_at=?, updated_at=? WHERE id=?",
          "",
          countQuota ? stamp : account.last_publish_at,
          stamp,
          account.id
        );
      }
      execute(
        "INSERT INTO records(job_id, draft_id, account_id, platform, success, message, " +
          "remote_note_id, result, created_at) VALUES(?,?,?,?,1,?,'',?,?)",
        jobId,
        job.draft_id,
        job.account_id,
        job.platform || DEFAULT_PLATFORM,
        "人工确认已发布（平台自动回执缺失）",
        JSON.stringify({ manual_confirmed: true }),
        stamp
      );
    } else {
      execute(
        "UPDATE jobs SET status='failed', result_state='normal', confirm_deadline=0, " +
          "last_error=?, blocked_reason='', updated_at=? WHERE id=?",
        "人工确认未发布",
        stamp,
        jobId
      );
      execute(
        "INSERT INTO records(job_id, draft_id, account_id, platform, success, message, " +
          "remote_note_id, result, created_at) VALUES(?,?,?,?,0,?,'',?,?)",
        jobId,
        job.draft_id,
        job.account_id,
        job.platform || DEFAULT_PLATFORM,
        "人工确认未发布，可重新入队",
        JSON.stringify({ manual_confirmed: false }),
        stamp
      );
    }
    settleDraft(job.draft_id, stamp);
  })();
  return serializeJob(getJobRow(jobId));
}

function settleDraft(draftId: number, stamp: number): void {
  const remaining = queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM jobs WHERE draft_id=? AND status IN ('pending','retry','running','pending_confirm')",
    draftId
  );
  if (Number(remaining?.n || 0)) return;
  const success = queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE draft_id=? AND status='success'", draftId);
  const failed = queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE draft_id=? AND status='failed'", draftId);
  const status = Number(success?.n || 0) ? "published" : Number(failed?.n || 0) ? "failed" : "draft";
  execute("UPDATE drafts SET status=?, updated_at=? WHERE id=?", status, stamp, draftId);
}

export function listRecords(limit = 100, offset = 0): Record<string, unknown>[] {
  const rows = queryAll<Record<string, unknown>>(
    "SELECT r.*, d.title AS draft_title, a.name AS account_name, a.nickname AS account_nickname " +
      "FROM records r LEFT JOIN drafts d ON d.id = r.draft_id " +
      "LEFT JOIN accounts a ON a.id = r.account_id ORDER BY r.id DESC LIMIT ? OFFSET ?",
    Math.max(1, limit),
    Math.max(0, Math.trunc(offset))
  );
  return rows.map((row) => ({
    id: row.id,
    job_id: row.job_id,
    draft_id: row.draft_id,
    draft_title: row.draft_title || "(已删除)",
    platform: row.platform || DEFAULT_PLATFORM,
    platform_name: platformLabel(String(row.platform || "")),
    account_id: row.account_id,
    account_name: row.account_nickname || row.account_name || "",
    success: Boolean(row.success),
    message: row.message,
    remote_note_id: row.remote_note_id,
    created_at: row.created_at,
  }));
}

export function countRecordsSummary(): { total: number; success_total: number; failed_total: number } {
  const row = queryOne<{ total: number; success_total: number; failed_total: number }>(
    "SELECT COUNT(*) AS total, SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS success_total, " +
      "SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failed_total FROM records"
  );
  return {
    total: Number(row?.total || 0),
    success_total: Number(row?.success_total || 0),
    failed_total: Number(row?.failed_total || 0),
  };
}
