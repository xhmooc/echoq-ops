/** 首页总览：账号、今日发布、选题、草稿、队列与待处理事项。 */
import { now } from "../core/config";
import { queryAll, queryOne } from "../core/db";
import { listRecords, queueReasons } from "./queue";

function scalar(sql: string, ...args: unknown[]): number {
  const row = queryOne<Record<string, number>>(sql, ...args);
  if (!row) return 0;
  const value = Object.values(row)[0];
  return Number(value || 0);
}

function dayStart(): number {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

export function overview(): Record<string, unknown> {
  const accounts = queryAll<{ status: string; enabled: number }>(
    "SELECT status, enabled FROM accounts"
  );
  const byStatus: Record<string, number> = {};
  for (const account of accounts) {
    const key = account.status || "unknown";
    byStatus[key] = (byStatus[key] || 0) + 1;
  }
  const today = scalar(
    "SELECT COUNT(*) FROM records WHERE success = 1 AND created_at >= ? AND message NOT LIKE '模拟发布%'",
    dayStart()
  );
  const unread = scalar("SELECT COUNT(*) FROM notification_events WHERE read = 0");
  const abnormal = scalar(
    "SELECT COUNT(*) FROM published_notes WHERE health_state IN ('zero_views','risky','removed')"
  );
  const draftStatuses: Record<string, number> = {};
  for (const status of ["draft", "queued", "published", "failed"]) {
    draftStatuses[status] = scalar("SELECT COUNT(*) FROM drafts WHERE status=?", status);
  }
  const jobStatuses: Record<string, number> = {};
  for (const status of [
    "pending",
    "retry",
    "running",
    "pending_confirm",
    "success",
    "failed",
    "cancelled",
  ]) {
    jobStatuses[status] = scalar("SELECT COUNT(*) FROM jobs WHERE status=?", status);
  }
  return {
    accounts: {
      total: accounts.length,
      healthy: byStatus.healthy || 0,
      expired: byStatus.expired || 0,
      unknown: byStatus.unknown || 0,
      disabled: accounts.filter((item) => !item.enabled).length,
    },
    today_published: today,
    topics: {
      pool: scalar("SELECT COUNT(*) FROM topics WHERE status='pool'"),
      used: scalar("SELECT COUNT(*) FROM topics WHERE status='used'"),
    },
    drafts: {
      ...draftStatuses,
      ready: scalar(
        "SELECT COUNT(*) FROM drafts WHERE status='draft' AND compliance='[]' AND images != '[]'"
      ),
    },
    jobs: jobStatuses,
    needs_action: {
      pending_confirm: scalar("SELECT COUNT(*) FROM jobs WHERE status='pending_confirm'"),
      unread_notifications: unread,
      abnormal_notes: abnormal,
      expired_accounts: byStatus.expired || 0,
    },
    queue: queueReasons(),
    worker: { running: false, last_tick_at: 0 },
    scheduler: { running: false, last_tick_at: 0 },
    schedules: {
      total: scalar("SELECT COUNT(*) FROM schedules"),
      enabled: scalar("SELECT COUNT(*) FROM schedules WHERE enabled=1"),
      paused: scalar("SELECT COUNT(*) FROM schedules WHERE enabled=0 AND paused_reason != ''"),
      running: scalar("SELECT COUNT(*) FROM schedules WHERE running=1"),
    },
    records: listRecords(8, 0),
    dry_run: String(process.env.OPS_DRY_RUN || "").toLowerCase() in ["1", "true", "yes", "on"],
    server_time: now(),
  };
}
