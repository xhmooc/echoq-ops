/**
 * 发布执行器（Node 版），语义对齐 ops/publisher.py。
 *
 * 状态机：
 * pending/retry --条件更新领取--> running
 *   running --成功--> success（写 records，草稿置 published，刷新账号发布计数）
 *   running --可重试失败--> retry（attempts+1，指数退避，账号/内容类错误有专门处置）
 *   running --最终失败--> failed（写 records 与站内通知）
 *   running --网络中断/结果未知--> pending_confirm（绝不自动重发）
 * 账号不可用时任务回到 pending/retry 并写 blocked_reason，而不是抛异常。
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ASSETS_DIR, DESIGN_DIR, UPLOAD_DIR, now } from "../core/config";
import { execute, getDb, queryAll, queryOne } from "../core/db";
import { log } from "../core/log";
import { getIntSetting } from "../core/settings";
import {
  DEFAULT_PLATFORM,
  normalizePlatform,
  platformLabel,
  validateDraft,
} from "../core/platform";
import {
  availability,
  decryptSession,
  getAccount,
  publishedToday,
  type AccountRow,
} from "../core/accounts";
import { getJobRow } from "./queue";
import { publishDraft, type PublishPayload } from "../platforms/wechat/publish";
import { publish as publishXiaohongshu } from "../platforms/xiaohongshu/adapter";
import { publish as publishDouyin } from "../platforms/douyin/adapter";

interface JobLike {
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

interface DraftLike {
  id: number;
  account_id: number | null;
  platform: string;
  content_type: string;
  title: string;
  desc: string;
  body_md: string;
  body_html: string;
  wx_theme: string;
  media_type: string;
  visibility: number;
  images: string;
  topics: string;
  status: string;
  compliance: string;
}

type PublishPayloadLike = Record<string, unknown>;

// 分类顺序：限流 → 登录 → 内容 → 平台 → 网络。只看人类可读的错误文案，
// 不拼接原始响应 JSON，避免错误码/字段名（如 14012、sessionid）造成误判。
const RATE_HINTS = [
  "频繁",
  "风控",
  "限流",
  "稍后重试",
  "请求过于频繁",
  "406",
  "429",
  "code=-1",
  "rate limit",
  "too many requests",
];
const AUTH_HINTS = [
  "登录",
  "未登录",
  "无登录信息",
  "登录态",
  "登录已失效",
  "重新登录",
  "web_session",
  "cookie 已失效",
];
const CONTENT_HINTS = [
  "requires noteInfo",
  "图片不存在",
  "文件不存在",
  "未找到话题",
  "标题",
  "参数错误",
  "-9059",
];
const PLATFORM_HINTS = [
  "平台页面",
  "页面结构",
  "接口变更",
  "接口可能已改版",
  "平台可能已改版",
  "找不到发布按钮",
  "找不到上传",
  "upstream_changed",
];

const HEX24 = /^[0-9a-f]{24}$/;

let loopTimer: NodeJS.Timeout | null = null;
let loopStartedAt = 0;
let lastTickAt = 0;
let lastResult: Record<string, unknown> = {};
let ticking = false;

function jobRow(jobId: number): JobLike {
  return getJobRow(jobId) as unknown as JobLike;
}

function draftRow(draftId: number): DraftLike | undefined {
  return queryOne<DraftLike>("SELECT * FROM drafts WHERE id = ?", draftId);
}

function jsonValue<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "object") return value as T;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

function safeJson(value: unknown, max = 4000): string {
  try {
    return JSON.stringify(value ?? {}).slice(0, max);
  } catch {
    return "{}";
  }
}

function hashNumber(text: string): number {
  let value = 0;
  for (const char of text) value = (value * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(value);
}

function dayOfYear(at: number): number {
  const start = new Date(new Date(at * 1000).getFullYear(), 0, 0);
  return Math.floor((at * 1000 - start.getTime()) / 86400000);
}

function accountLabel(row: AccountRow): string {
  return row.nickname || row.name || `账号 ${row.id}`;
}

function classifyError(message: string): string {
  const text = String(message || "").toLowerCase();
  if (RATE_HINTS.some((hint) => text.includes(hint))) return "rate";
  // 401 只在独立出现时视为登录失效，避免错误码/URL 里的 401 片段误判。
  if (AUTH_HINTS.some((hint) => text.includes(hint)) || /(^|\D)401(\D|$)/.test(text)) {
    return "auth";
  }
  if (CONTENT_HINTS.some((hint) => text.includes(hint))) return "content";
  if (PLATFORM_HINTS.some((hint) => text.includes(hint))) return "platform";
  return "network";
}

function findNoteId(payload: unknown, depth = 0): string {
  if (depth > 6) return "";
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = findNoteId(item, depth + 1);
      if (found) return found;
    }
    return "";
  }
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Record<string, unknown>;
  for (const key of ["remote_note_id", "note_id", "noteId", "aweme_id", "awemeId", "draft_id", "id"]) {
    const value = String(record[key] || "");
    if (!value) continue;
    if (HEX24.test(value) || (/^\d+$/.test(value) && value.length >= 6)) return value;
  }
  for (const value of Object.values(record)) {
    const found = findNoteId(value, depth + 1);
    if (found) return found;
  }
  return "";
}

function notify(
  event: string,
  title: string,
  message: string,
  options: { level?: string; linkView?: string; linkId?: number } = {}
): void {
  const level = ["info", "warn", "error"].includes(options.level || "")
    ? String(options.level)
    : "warn";
  const linkView = options.linkView || "";
  const linkId = Math.trunc(Number(options.linkId || 0));
  const stamp = now();
  try {
    const duplicate = queryOne<{ id: number }>(
      "SELECT id FROM notification_events WHERE event=? AND link_view=? AND link_id=? " +
        "AND created_at >= ? LIMIT 1",
      event,
      linkView,
      linkId,
      stamp - 1800
    );
    if (duplicate) return;
    execute(
      "INSERT INTO notification_events(level, event, title, message, link_view, link_id, read, created_at) " +
        "VALUES(?,?,?,?,?,?,0,?)",
      level,
      event,
      title.slice(0, 160),
      message.slice(0, 1000),
      linkView,
      linkId,
      stamp
    );
  } catch (error) {
    log.error(`写入站内通知失败: ${String(error)}`);
  }
}

/** 风控冷却：24 小时内阶梯 15 分钟 / 1 小时 / 3 小时。 */
function noteRisk(accountId: number, kind: string, reason: string, source = "publish"): number {
  const stamp = now();
  const row = getAccount(accountId);
  const recent = Number(
    queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM risk_events WHERE account_id=? AND started_at >= ?",
      accountId,
      stamp - 86400
    )?.n || 0
  );
  const steps = [900, 3600, 10800];
  const base = steps[Math.min(recent, steps.length - 1)];
  const until = Math.min(
    Math.max(Number(row.cooldown_until || 0), stamp) + base,
    stamp + 3 * 3600
  );
  execute(
    "UPDATE accounts SET health_state='risk', cooldown_until=?, last_error=?, " +
      "probe_success_count=0, updated_at=? WHERE id=?",
    until,
    reason.slice(0, 500),
    stamp,
    accountId
  );
  execute(
    "INSERT INTO risk_events(account_id, type, reason, source, started_at) VALUES(?,?,?,?,?)",
    accountId,
    kind,
    reason.slice(0, 500),
    source,
    stamp
  );
  const clock = new Date(until * 1000).toTimeString().slice(0, 5);
  notify(
    "risk_cooldown",
    `账号进入风控冷却：${accountLabel(row)}`,
    `${reason}；预计 ${clock} 后恢复。`,
    { linkView: "accounts", linkId: accountId }
  );
  return until;
}

function settleDraft(draftId: number, stamp: number): void {
  const pending = Number(
    queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM jobs WHERE draft_id=? " +
        "AND status IN ('pending','retry','running','pending_confirm')",
      draftId
    )?.n || 0
  );
  if (pending) {
    execute("UPDATE drafts SET status='queued', updated_at=? WHERE id=?", stamp, draftId);
    return;
  }
  const success = Number(
    queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM jobs WHERE draft_id=? AND status='success'", draftId)
      ?.n || 0
  );
  execute(
    "UPDATE drafts SET status=?, updated_at=? WHERE id=?",
    success ? "published" : "failed",
    stamp,
    draftId
  );
}

function draftTitle(draftId: number): string {
  const row = queryOne<{ title: string }>("SELECT title FROM drafts WHERE id=?", draftId);
  return String(row?.title || `草稿 #${draftId}`);
}

function draftPayload(draft: DraftLike): PublishPayloadLike {
  const mediaType = draft.media_type || "image";
  const images = jsonValue<string[]>(draft.images, []);
  const payload: PublishPayloadLike = {
    title: draft.title,
    desc: draft.desc,
    body_md: draft.body_md || "",
    body_html: draft.body_html || "",
    wx_theme: draft.wx_theme || "",
    media_type: mediaType,
    images,
    type: Number(draft.visibility || 0),
    topics: jsonValue<string[]>(draft.topics, []),
    platform: draft.platform || DEFAULT_PLATFORM,
    content_type: draft.content_type || "image_text",
  };
  if (mediaType === "video" && images.length) payload.video = images[0];
  return payload;
}

function claim(jobId: number): boolean {
  const result = getDb()
    .prepare(
      "UPDATE jobs SET status='running', blocked_reason='', blocked_at=0, " +
        "submitted_at=0, updated_at=? WHERE id=? AND status IN ('pending','retry')"
    )
    .run(now(), jobId);
  return Number(result.changes) === 1;
}

function waitReason(kind: string): string {
  const mapping: Record<string, string> = {
    rate: "平台限流，等待冷却",
    auth: "账号登录失效，等待换号或重登",
    network: "网络异常，等待重试",
  };
  return (mapping[kind] || "等待重试").slice(0, 120);
}

function succeed(
  job: JobLike,
  account: AccountRow,
  message: string,
  result: unknown,
  countQuota: boolean
): Record<string, unknown> {
  const stamp = now();
  const noteId = findNoteId(result);
  getDb().transaction(() => {
    execute(
      "UPDATE jobs SET status='success', last_error='', blocked_reason='', " +
        "blocked_at=0, result_state='normal', confirm_deadline=0, updated_at=? WHERE id=?",
      stamp,
      job.id
    );
    settleDraft(job.draft_id, stamp);
    if (countQuota) {
      execute(
        "UPDATE accounts SET last_publish_at=?, status='healthy', health_state='healthy', " +
          "cooldown_until=0, last_error='', updated_at=? WHERE id=?",
        stamp,
        stamp,
        account.id
      );
    } else {
      execute(
        "UPDATE accounts SET status='healthy', health_state='healthy', last_error='', " +
          "updated_at=? WHERE id=?",
        stamp,
        account.id
      );
    }
    execute(
      "INSERT INTO records(job_id, draft_id, account_id, platform, success, message, " +
        "remote_note_id, result, created_at) VALUES(?,?,?,?,1,?,?,?,?)",
      job.id,
      job.draft_id,
      account.id,
      job.platform || DEFAULT_PLATFORM,
      message.slice(0, 500),
      noteId,
      safeJson(result),
      stamp
    );
  })();
  log.info(`草稿 ${job.draft_id} 已发布到账号 ${account.id}（${noteId}）`);
  return {
    job_id: job.id,
    status: "success",
    message,
    remote_note_id: noteId,
  };
}

function pendingConfirm(
  job: JobLike,
  account: AccountRow | null,
  message: string,
  result: unknown
): Record<string, unknown> {
  const stamp = now();
  const deadline = stamp + 24 * 3600;
  getDb().transaction(() => {
    execute(
      "UPDATE jobs SET status='pending_confirm', result_state='pending_confirm', " +
        "confirm_deadline=?, last_error=?, blocked_reason='', blocked_at=0, " +
        "updated_at=? WHERE id=?",
      deadline,
      `结果待确认：${message}`.slice(0, 500),
      stamp,
      job.id
    );
    settleDraft(job.draft_id, stamp);
  })();
  log.warn(`任务 ${job.id} 进入结果待确认：${message}`);
  notify(
    "publish_pending",
    `发布结果待确认：${draftTitle(job.draft_id)}`,
    `${message}；请到平台核对后确认已发布或未发布。`,
    { linkView: "library", linkId: job.id }
  );
  return {
    job_id: job.id,
    status: "pending_confirm",
    message,
    confirm_deadline: deadline,
  };
}

interface FailOptions {
  final?: boolean;
  result?: unknown;
  allowPending?: boolean;
}

function fail(
  job: JobLike,
  message: string,
  kind: string,
  account: AccountRow | null,
  options: FailOptions = {}
): Record<string, unknown> {
  const stamp = now();
  const attempts = Number(job.attempts) + 1;
  const maxAttempts = Number(job.max_attempts || 4);
  let final = Boolean(options.final);
  if (kind === "content" || kind === "platform") final = true;
  if (attempts >= maxAttempts) final = true;

  if (kind === "rate" && account) {
    try {
      noteRisk(account.id, "rate_limited", message, "publish");
    } catch (error) {
      log.error(`账号 ${account.id} 记录风控事件失败: ${String(error)}`);
    }
  }
  if (kind === "auth" && account) {
    execute(
      "UPDATE accounts SET status='expired', health_state='expired', last_error=?, updated_at=? WHERE id=?",
      message.slice(0, 500),
      stamp,
      account.id
    );
    notify(
      "account_expired",
      `账号登录失效：${accountLabel(account)}`,
      message,
      { linkView: "accounts", linkId: account.id }
    );
  }

  if (final && options.allowPending) {
    return pendingConfirm(job, account, message, options.result);
  }

  if (final) {
    getDb().transaction(() => {
      execute(
        "UPDATE jobs SET status='failed', attempts=?, last_error=?, blocked_reason='', " +
          "blocked_at=0, result_state='normal', confirm_deadline=0, updated_at=? WHERE id=?",
        attempts,
        message.slice(0, 500),
        stamp,
        job.id
      );
      settleDraft(job.draft_id, stamp);
      execute(
        "INSERT INTO records(job_id, draft_id, account_id, platform, success, message, " +
          "remote_note_id, result, created_at) VALUES(?,?,?,?,0,?,'',?,?)",
        job.id,
        job.draft_id,
        account ? account.id : null,
        job.platform || DEFAULT_PLATFORM,
        message.slice(0, 500),
        safeJson(options.result || {}),
        stamp
      );
    })();
    log.error(`草稿 ${job.draft_id} 发布失败（${kind}）: ${message}`);
    notify(
      "publish_failed",
      `发布失败：${draftTitle(job.draft_id)}`,
      message,
      { level: "error", linkView: "records", linkId: job.id }
    );
    return {
      job_id: job.id,
      status: "failed",
      message,
      attempts,
    };
  }

  let wait = Math.min(3600, 60 * 2 ** (attempts - 1));
  if (kind === "rate") wait = Math.max(wait, 900);
  wait += hashNumber(`${job.id}:${attempts}`) % 120;
  execute(
    "UPDATE jobs SET status='retry', attempts=?, next_run_at=?, last_error=?, " +
      "blocked_reason=?, blocked_at=?, updated_at=? WHERE id=?",
    attempts,
    stamp + wait,
    `[${kind}] ${message}`.slice(0, 500),
    waitReason(kind),
    stamp,
    stamp,
    job.id
  );
  return {
    job_id: job.id,
    status: "retry",
    message,
    next_run_at: stamp + wait,
    attempts,
  };
}

function defer(job: JobLike, seconds: number, note: string): void {
  const stamp = now();
  execute(
    "UPDATE jobs SET status=?, next_run_at=?, last_error=?, blocked_reason=?, " +
      "blocked_at=?, updated_at=? WHERE id=?",
    Number(job.attempts) > 0 ? "retry" : "pending",
    // 上限与风控冷却的最长 3 小时对齐，避免冷却期内每 5 分钟空转一次。
    stamp + Math.max(30, Math.min(seconds, 3 * 3600)),
    note.slice(0, 500),
    note.slice(0, 120) || "等待可用账号",
    stamp,
    stamp,
    job.id
  );
}

interface ResolvedAccount {
  account: AccountRow | null;
  reason: string;
  nextAt: number;
}

function pickAccount(platform: string, countQuota: boolean): ResolvedAccount {
  const moment = now();
  const rows = queryAll<AccountRow>(
    "SELECT * FROM accounts WHERE enabled = 1 AND status != 'expired' AND platform = ? ORDER BY id",
    platform
  );
  const reasons: Array<[number, string]> = [];
  const usable: Array<[number, number, number, AccountRow]> = [];
  const rotation = dayOfYear(moment);
  for (const row of rows) {
    const [ok, reason, nextAt] = availability(row, moment, countQuota);
    if (!ok) {
      reasons.push([nextAt, reason]);
      continue;
    }
    usable.push([
      publishedToday(row.id),
      Number(row.last_publish_at || 0),
      (row.id - rotation) % 997,
      row,
    ]);
  }
  if (!usable.length) {
    if (reasons.length) {
      reasons.sort((left, right) => left[0] - right[0]);
      return { account: null, reason: reasons[0][1], nextAt: reasons[0][0] };
    }
    return {
      account: null,
      reason: "没有可用账号，请先添加并检查登录",
      nextAt: moment,
    };
  }
  usable.sort((left, right) =>
    left[0] - right[0] || left[1] - right[1] || left[2] - right[2]
  );
  return { account: usable[0][3], reason: "", nextAt: moment };
}

function resolveAccount(
  job: JobLike,
  draft: DraftLike,
  platform: string,
  countQuota: boolean
): ResolvedAccount {
  const preferred = Number(job.account_id || draft.account_id || 0);
  if (preferred) {
    const row = queryOne<AccountRow>("SELECT * FROM accounts WHERE id = ?", preferred);
    if (row && (row.platform || DEFAULT_PLATFORM) === platform) {
      const [ok, reason, nextAt] = availability(row, undefined, countQuota);
      if (ok) return { account: row, reason: "", nextAt };
      if (row.status === "expired" || reason.includes("上限")) {
        execute("UPDATE jobs SET account_id=NULL, updated_at=? WHERE id=?", now(), job.id);
      } else {
        return { account: null, reason, nextAt };
      }
    }
  }
  return pickAccount(platform, countQuota);
}

/** 草稿里存的是 /assets、/designs、/uploads 这类 Web 路径，校验前映射回本地文件。 */
function assetFile(src: string): string {
  const value = String(src || "").trim();
  if (!value || /^(https?:)?\/\//.test(value) || value.startsWith("data:")) return "";
  const clean = value.split("?")[0].split("#")[0];
  if (clean.startsWith("/uploads/")) return path.join(UPLOAD_DIR, path.basename(clean));
  if (clean.startsWith("/assets/")) {
    const parts = clean.replace(/^\/+/, "").split("/");
    return parts.length >= 3 ? path.join(ASSETS_DIR, ...parts.slice(1)) : "";
  }
  if (clean.startsWith("/designs/")) {
    const parts = clean.replace(/^\/+/, "").split("/");
    return parts.length >= 2 ? path.join(DESIGN_DIR, ...parts.slice(1)) : "";
  }
  return clean;
}

async function executeJob(job: JobLike): Promise<Record<string, unknown>> {
  const draft = draftRow(job.draft_id);
  if (!draft) return fail(job, "草稿已删除", "content", null, { final: true });

  const compliance = jsonValue<Array<{ label?: string }>>(draft.compliance, []);
  if (compliance.length) {
    const labels = compliance.map((issue) => String(issue.label || "")).join("、");
    return fail(job, `文案命中合规红线：${labels}`, "content", null, { final: true });
  }

  const platform = normalizePlatform(draft.platform);
  const payload = draftPayload(draft);
  const draftOnly = platform === "wechat_mp";

  const problems = validateDraft(
    platform,
    {
      title: String(payload.title || ""),
      desc: String(payload.desc || ""),
      images: (payload.images as unknown[]) || [],
      media_type: String(payload.media_type || ""),
    },
    String(payload.content_type || "")
  );
  if (problems.length) {
    return fail(job, problems.join("；"), "content", null, { final: true });
  }

  const files = (payload.images as string[]).map(String);
  const missing = files.filter((file) => {
    const local = assetFile(file);
    if (!local) return true;
    try {
      return !fs.statSync(local).isFile();
    } catch {
      return true;
    }
  });
  if (files.length && missing.length) {
    return fail(
      job,
      `素材文件不存在: ${missing.slice(0, 2).join("、")}`,
      "content",
      null,
      { final: true }
    );
  }
  if (payload.video) {
    let videoOk = false;
    const videoFile = assetFile(String(payload.video));
    try {
      videoOk = Boolean(videoFile) && fs.statSync(videoFile).isFile();
    } catch {
      videoOk = false;
    }
    if (!videoOk) {
      return fail(job, "视频文件不存在", "content", null, { final: true });
    }
  }

  const resolved = resolveAccount(job, draft, platform, !draftOnly);
  if (!resolved.account) {
    const seconds = Math.max(60, resolved.nextAt - now());
    defer(job, seconds, resolved.reason);
    return { job_id: job.id, status: "waiting", message: resolved.reason };
  }
  const account = resolved.account;
  const stamp = now();
  execute("UPDATE jobs SET account_id=?, updated_at=? WHERE id=?", account.id, stamp, job.id);
  execute("UPDATE drafts SET account_id=?, updated_at=? WHERE id=?", account.id, stamp, draft.id);
  if (!draftOnly) {
    execute(
      "INSERT INTO rate_events(account_id, action, created_at) VALUES(?, 'publish', ?)",
      account.id,
      stamp
    );
  }

  const dryRun = ["1", "true", "yes", "on"].includes(
    String(process.env.OPS_DRY_RUN || "").trim().toLowerCase()
  );
  if (dryRun) {
    const fakeId = randomBytes(12).toString("hex");
    return succeed(
      job,
      account,
      `模拟发布成功（未真正发送到${platformLabel(platform)}）`,
      { note_id: fakeId, simulated: true, platform },
      !draftOnly
    );
  }

  execute(
    "UPDATE jobs SET submitted_at=?, updated_at=? WHERE id=?",
    now(),
    now(),
    job.id
  );

  if (platform === "xiaohongshu") {
    let outcome;
    try {
      outcome = await publishXiaohongshu(account, payload);
    } catch (error) {
      const kind = (error as { kind?: string }).kind;
      if (kind === "platform") {
        return fail(job, (error as Error).message, "platform", account, {
          result: { stage: "publish", action: "publish" },
        });
      }
      throw error;
    }
    if (outcome.ok) {
      return succeed(job, account, outcome.message || "发布成功", outcome.result, !draftOnly);
    }
    const kind = outcome.kind || classifyError(outcome.message || "发布失败");
    return fail(job, outcome.message || "发布失败", kind, account, {
      result: outcome.result,
      allowPending: kind === "network",
    });
  }

  if (platform === "douyin") {
    let outcome;
    try {
      outcome = await publishDouyin(
        decryptSession(account),
        {
          title: String(payload.title || ""),
          desc: String(payload.desc || ""),
          images: (payload.images as string[]) || [],
          topics: (payload.topics as string[]) || [],
          video: String(payload.video || ""),
          content_type: String(payload.content_type || ""),
          type: Number(payload.type || 0),
        },
        account.proxy || ""
      );
    } catch (error) {
      const kind = (error as { kind?: string }).kind;
      return fail(job, (error as Error).message || "抖音发布失败", kind || "network", account, {
        result: { stage: "publish", action: "publish" },
        allowPending: (kind || "network") === "network",
      });
    }
    if (outcome.ok) {
      return succeed(job, account, outcome.message || "发布成功", outcome.result, !draftOnly);
    }
    const kind = outcome.kind || classifyError(outcome.message || "发布失败");
    return fail(job, outcome.message || "发布失败", kind, account, {
      result: outcome.result,
      allowPending: kind === "network",
    });
  }

  const wechatPayload: PublishPayload = {
    title: String(payload.title || ""),
    desc: String(payload.desc || ""),
    body_html: String(payload.body_html || ""),
    wx_theme: String(payload.wx_theme || ""),
    images: (payload.images as string[]) || [],
    content_type: String(payload.content_type || ""),
  };
  const outcome = await publishDraft(decryptSession(account), wechatPayload, account.proxy);
  if (outcome.ok) {
    return succeed(job, account, outcome.message || "发布成功", outcome.result, !draftOnly);
  }
  const kind = outcome.kind || classifyError(outcome.message || "发布失败");
  return fail(job, outcome.message || "发布失败", kind, account, {
    result: outcome.result,
    allowPending: kind === "network",
  });
}

export async function runJob(jobId: number): Promise<Record<string, unknown>> {
  if (!claim(jobId)) {
    return { job_id: jobId, status: "skipped", message: "任务已被领取" };
  }
  let job: JobLike;
  try {
    job = jobRow(jobId);
  } catch {
    return { job_id: jobId, status: "failed", message: "任务不存在或已被删除" };
  }
  try {
    return await executeJob(job);
  } catch (error) {
    log.error(`发布任务 ${jobId} 执行异常: ${error instanceof Error ? error.stack : String(error)}`);
    return pendingConfirm(
      job,
      null,
      "发布过程中断，平台是否已发布未知；请到平台核对后确认",
      { exception: error instanceof Error ? error.name : "UnknownError" }
    );
  }
}

export async function runDue(limit = 3): Promise<Record<string, unknown>> {
  const stamp = now();
  const rows = queryAll<{ id: number }>(
    "SELECT id FROM jobs WHERE status IN ('pending','retry') AND next_run_at <= ? " +
      "ORDER BY next_run_at ASC LIMIT ?",
    stamp,
    Math.max(1, limit)
  );
  const results: Record<string, unknown>[] = [];
  for (const row of rows) {
    results.push(await runJob(Number(row.id)));
  }
  return { ran: results.length, results };
}

export async function tick(): Promise<Record<string, unknown>> {
  if (ticking) {
    return { tick_at: lastTickAt, skipped: "上一轮发布尚未结束" };
  }
  ticking = true;
  lastTickAt = now();
  const previous = lastTickAt;
  try {
    const published = await runDue(2);
    lastResult = { tick_at: previous, published };
    return lastResult;
  } catch (error) {
    log.error(`发布队列轮询失败: ${String(error)}`);
    lastResult = { tick_at: previous, publish_error: String(error) };
    return lastResult;
  } finally {
    ticking = false;
  }
}

/** 启动时回收上次进程遗留的 running 任务。 */
export function recoverInterrupted(): Record<string, number> {
  const stamp = now();
  const submitted = queryAll<{ id: number }>(
    "SELECT id FROM jobs WHERE status='running' AND IFNULL(submitted_at, 0) > 0"
  );
  const unsent = queryAll<{ id: number }>(
    "SELECT id FROM jobs WHERE status='running' AND IFNULL(submitted_at, 0) = 0"
  );
  getDb().transaction(() => {
    for (const row of submitted) {
      execute(
        "UPDATE jobs SET status='pending_confirm', result_state='pending_confirm', " +
          "confirm_deadline=?, last_error=?, blocked_reason='', blocked_at=0, updated_at=? WHERE id=?",
        stamp + 24 * 3600,
        "服务重启：内容已提交但未收到平台回执，请到平台核对",
        stamp,
        row.id
      );
    }
    for (const row of unsent) {
      execute(
        "UPDATE jobs SET status='pending', next_run_at=?, blocked_reason=?, blocked_at=?, " +
          "submitted_at=0, updated_at=? WHERE id=?",
        stamp,
        "服务重启，等待重试",
        stamp,
        stamp,
        row.id
      );
    }
  })();
  if (submitted.length || unsent.length) {
    log.warn(
      `启动回收中断任务：待确认 ${submitted.length} 条，重新排队 ${unsent.length} 条`
    );
  }
  return { pending_confirm: submitted.length, requeued: unsent.length };
}

export function startLoop(): void {
  if (loopTimer) return;
  const recovered = recoverInterrupted();
  loopStartedAt = now();
  const poll = Math.max(5, getIntSetting("worker_poll_sec", 20));
  loopTimer = setInterval(() => {
    void tick();
  }, poll * 1000);
  loopTimer.unref();
  log.info(`发布执行器已启动：轮询 ${poll} 秒，回收中断任务 ${JSON.stringify(recovered)}`);
}

export function stopLoop(): void {
  if (!loopTimer) return;
  clearInterval(loopTimer);
  loopTimer = null;
  log.info("发布执行器已停止");
}

export function workerStatus(): Record<string, unknown> {
  const counts = queryOne<Record<string, number>>(
    "SELECT " +
      "SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending, " +
      "SUM(CASE WHEN status='retry' THEN 1 ELSE 0 END) AS retry, " +
      "SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running, " +
      "SUM(CASE WHEN status='pending_confirm' THEN 1 ELSE 0 END) AS pending_confirm " +
      "FROM jobs"
  );
  return {
    running: Boolean(loopTimer),
    started_at: loopStartedAt,
    last_tick_at: lastTickAt,
    last_result: lastResult,
    poll_sec: Math.max(5, getIntSetting("worker_poll_sec", 20)),
    jobs: {
      pending: Number(counts?.pending || 0),
      retry: Number(counts?.retry || 0),
      running: Number(counts?.running || 0),
      pending_confirm: Number(counts?.pending_confirm || 0),
    },
  };
}
