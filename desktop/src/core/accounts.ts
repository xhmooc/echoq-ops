/**
 * 账号矩阵（Node 侧）：读 Python 版写下的 accounts 表，并回写扫码登录态。
 *
 * cookie_enc 里对非小红书平台存的是整份 JSON 登录态（Cookie + token +
 * fakeid 等），与 ops/accounts.py::add_session 的格式完全一致。
 */
import { decrypt, encrypt } from "./fernet";
import { execute, getDb, queryAll, queryOne } from "./db";
import { now } from "./config";
import { platformMeta, platformLabel } from "./platform";
import { getIntSetting } from "./settings";

export interface AccountRow {
  id: number;
  platform: string;
  name: string;
  nickname: string;
  red_id: string;
  user_id: string;
  avatar?: string;
  cookie_enc: string;
  proxy: string;
  proxy_group?: string;
  profile_key?: string;
  enabled: number;
  status: string;
  health_state?: string;
  cooldown_until?: number;
  probe_success_count?: number;
  exit_checked_at?: number;
  group_name?: string;
  tags?: string;
  last_error?: string;
  health_checked_at?: number;
  last_publish_at?: number;
  published_synced_at?: number;
  published_sync_error?: string;
  exit_ip?: string;
  exit_country?: string;
  exit_timezone?: string;
  daily_limit?: number;
  min_interval_sec?: number;
  created_at: number;
  updated_at: number;
}

const STATUS_TEXT: Record<string, string> = {
  healthy: "正常",
  expired: "登录失效",
  unknown: "待检查",
  disabled: "已停用",
};

const HEALTH_TEXT: Record<string, string> = {
  unknown: "未判断",
  healthy: "健康",
  expired: "登录失效",
  risk: "风控冷却",
  probing: "冷却后探测中",
};

export const PLATFORM_LABEL: Record<string, string> = {
  xiaohongshu: "小红书",
  wechat_mp: "微信公众号",
  douyin: "抖音",
};

export type WechatSession = Record<string, unknown>;

export function listAccounts(platform = ""): Record<string, unknown>[] {
  const rows = platform
    ? queryAll<AccountRow>(
        "SELECT * FROM accounts WHERE platform = ? ORDER BY id",
        platform
      )
    : queryAll<AccountRow>("SELECT * FROM accounts ORDER BY id");
  const counts = publishedTodayMap();
  return rows.map((row) => serialize(row, counts.get(row.id) || 0));
}

export function getAccount(id: number): AccountRow {
  const row = queryOne<AccountRow>("SELECT * FROM accounts WHERE id = ?", id);
  if (!row) throw new Error(`账号不存在: ${id}`);
  return row;
}

export function serialize(row: AccountRow, todayCount?: number): Record<string, unknown> {
  let tags: unknown = [];
  try {
    tags = JSON.parse(row.tags || "[]");
  } catch {
    tags = [];
  }
  const platform = row.platform || "xiaohongshu";
  return {
    id: row.id,
    platform,
    platform_name: PLATFORM_LABEL[platform] || platform,
    platform_ready: true,
    name: row.name,
    nickname: row.nickname,
    red_id: row.red_id,
    user_id: row.user_id,
    avatar: row.avatar || "",
    proxy: row.proxy,
    proxy_group: row.proxy_group || "",
    profile_key: row.profile_key || "",
    enabled: Boolean(row.enabled),
    status: row.status,
    status_text: STATUS_TEXT[row.status] || row.status,
    health_state: row.health_state || "unknown",
    health_state_text: HEALTH_TEXT[row.health_state || "unknown"] || row.health_state,
    cooldown_until: Number(row.cooldown_until || 0),
    probe_success_count: Number(row.probe_success_count || 0),
    probe_target: 2,
    group_name: row.group_name || "",
    tags: Array.isArray(tags) ? tags.map(String) : [],
    last_error: row.last_error || "",
    health_checked_at: Number(row.health_checked_at || 0),
    last_publish_at: Number(row.last_publish_at || 0),
    published_synced_at: Number(row.published_synced_at || 0),
    published_sync_error: row.published_sync_error || "",
    exit_ip: row.exit_ip || "",
    exit_country: row.exit_country || "",
    exit_timezone: row.exit_timezone || "",
    exit_checked_at: Number(row.exit_checked_at || 0),
    daily_limit: Number(row.daily_limit || 0),
    min_interval_sec: Number(row.min_interval_sec || 0),
    created_at: Number(row.created_at || 0),
    updated_at: Number(row.updated_at || 0),
    published_today: todayCount === undefined ? publishedToday(row.id) : todayCount,
  };
}

/** 一次 GROUP BY 拿到全部账号的今日发布数，避免逐个账号 COUNT（N+1）。 */
export function publishedTodayMap(): Map<number, number> {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const counts = new Map<number, number>();
  for (const row of queryAll<{ account_id: number; n: number }>(
    "SELECT account_id, COUNT(*) AS n FROM records WHERE success = 1 AND created_at >= ? " +
      "AND message NOT LIKE '模拟发布%' AND IFNULL(result, '') NOT LIKE '%simulated%' GROUP BY account_id",
    Math.floor(start.getTime() / 1000)
  )) {
    counts.set(Number(row.account_id), Number(row.n || 0));
  }
  return counts;
}

export function publishedToday(accountId: number): number {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const row = queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM records WHERE account_id = ? AND success = 1 " +
      "AND created_at >= ? AND message NOT LIKE '模拟发布%' " +
      "AND IFNULL(result, '') NOT LIKE '%simulated%'",
    accountId,
    Math.floor(start.getTime() / 1000)
  );
  return Number(row?.n || 0);
}

export function decryptSession(row: AccountRow): WechatSession {
  const raw = decrypt(row.cookie_enc);
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as WechatSession;
    }
  } catch {
    /* 旧格式是明文 Cookie 字符串 */
  }
  return { cookie: raw };
}

/** 与 ops/accounts.py::add_session 同语义：同平台同 user_id/red_id 视为同一账号。 */
export function upsertSession(
  platform: string,
  name: string,
  session: WechatSession,
  identity: {
    nickname?: string;
    redId?: string;
    userId?: string;
    proxy?: string;
    avatar?: string;
  }
): Record<string, unknown> {
  const stamp = now();
  const payload = { ...session, platform, login_at: session.login_at ?? stamp };
  const encrypted = encrypt(JSON.stringify(payload));
  const nickname = identity.nickname || "";
  const redId = identity.redId || "";
  const userId = identity.userId || "";
  const avatar = identity.avatar || "";

  const write = getDb().transaction(() => {
    let existing: { id: number } | undefined;
    if (userId) {
      existing = queryOne<{ id: number }>(
        "SELECT id FROM accounts WHERE platform = ? AND user_id = ?",
        platform,
        userId
      );
    }
    if (!existing && redId) {
      existing = queryOne<{ id: number }>(
        "SELECT id FROM accounts WHERE platform = ? AND red_id = ?",
        platform,
        redId
      );
    }
    if (existing) {
      execute(
        "UPDATE accounts SET name=?, nickname=?, red_id=?, user_id=?, avatar=?, cookie_enc=?, " +
          "proxy=?, enabled=1, status='healthy', health_state='healthy', cooldown_until=0, " +
          "last_error='', health_checked_at=?, updated_at=? WHERE id=?",
        name || nickname || "未命名账号",
        nickname,
        redId,
        userId,
        avatar,
        encrypted,
        identity.proxy || "",
        stamp,
        stamp,
        existing.id
      );
      return existing.id;
    }
    return execute(
      "INSERT INTO accounts(platform, name, nickname, red_id, user_id, avatar, cookie_enc, proxy, " +
        "enabled, status, health_state, health_checked_at, created_at, updated_at) " +
        "VALUES(?,?,?,?,?,?,?,?,1,'healthy','healthy',?,?,?)",
      platform,
      name || nickname || "未命名账号",
      nickname,
      redId,
      userId,
      avatar,
      encrypted,
      identity.proxy || "",
      stamp,
      stamp,
      stamp
    );
  });

  const id = write();
  return serialize(getAccount(id));
}

export function saveSession(accountId: number, session: WechatSession): void {
  const payload = { ...session, updated_at: now() };
  execute(
    "UPDATE accounts SET cookie_enc=?, updated_at=? WHERE id=?",
    encrypt(JSON.stringify(payload)),
    now(),
    accountId
  );
}

export function listAccountsFiltered(platform = "", group = ""): Record<string, unknown>[] {
  const clauses: string[] = [];
  const args: unknown[] = [];
  if (platform) {
    clauses.push("platform = ?");
    args.push(platform);
  }
  if (group) {
    clauses.push("IFNULL(group_name,'') = ?");
    args.push(group);
  }
  const sql = `SELECT * FROM accounts${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""} ORDER BY id`;
  const counts = publishedTodayMap();
  return queryAll<AccountRow>(sql, ...args).map((row) =>
    serialize(row, counts.get(row.id) || 0)
  );
}

export function updateAccount(accountId: number, fields: Record<string, unknown>): Record<string, unknown> {
  const row = getAccount(accountId);
  const allowed = [
    "name",
    "enabled",
    "daily_limit",
    "min_interval_sec",
    "proxy",
    "proxy_group",
    "status",
    "group_name",
    "tags",
  ];
  const updates: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (allowed.includes(key)) updates[key] = value;
  }
  if (!Object.keys(updates).length) return serialize(row);
  if ("enabled" in updates) updates.enabled = updates.enabled ? 1 : 0;
  if ("tags" in updates) {
    let tags = updates.tags;
    if (typeof tags === "string") {
      tags = tags.replace(/，/g, ",").split(",").map((item) => item.trim()).filter(Boolean);
    }
    updates.tags = JSON.stringify((Array.isArray(tags) ? tags : []).slice(0, 8).map((item) => String(item).slice(0, 20)));
  }
  if ("group_name" in updates) updates.group_name = String(updates.group_name || "").slice(0, 30);
  if ("proxy" in updates) updates.proxy = String(updates.proxy || "").trim().slice(0, 500);
  updates.updated_at = now();
  const assignments = Object.keys(updates)
    .map((key) => `${key} = ?`)
    .join(", ");
  execute(`UPDATE accounts SET ${assignments} WHERE id = ?`, ...Object.values(updates), accountId);
  const item = serialize(getAccount(accountId));
  item.published_today = publishedToday(accountId);
  return item;
}

export function deleteAccount(accountId: number): void {
  getAccount(accountId);
  getDb().transaction(() => {
    execute("UPDATE jobs SET account_id = NULL WHERE account_id = ?", accountId);
    execute("UPDATE drafts SET account_id = NULL WHERE account_id = ?", accountId);
    execute(
      "DELETE FROM published_metrics_daily WHERE note_id IN (SELECT id FROM published_notes WHERE account_id = ?)",
      accountId
    );
    execute("DELETE FROM published_notes WHERE account_id = ?", accountId);
    execute("DELETE FROM note_comments WHERE account_id = ?", accountId);
    execute("DELETE FROM risk_events WHERE account_id = ?", accountId);
    execute("DELETE FROM rate_events WHERE account_id = ?", accountId);
    execute("DELETE FROM accounts WHERE id = ?", accountId);
  })();
}

export function accountGroups(): string[] {
  return queryAll<{ group_name: string }>(
    "SELECT DISTINCT group_name FROM accounts WHERE IFNULL(group_name,'') != '' ORDER BY group_name"
  ).map((row) => String(row.group_name));
}

export function limits(row: AccountRow): [number, number, number] {
  const platform = row.platform || "xiaohongshu";
  const meta = platformMeta(platform);
  const limit =
    Number(row.daily_limit || 0) ||
    (platform === "xiaohongshu"
      ? getIntSetting("publish_daily_limit", 3)
      : meta.default_daily_limit);
  const interval =
    Number(row.min_interval_sec || 0) ||
    (platform === "xiaohongshu"
      ? getIntSetting("publish_min_interval_sec", 2700)
      : meta.default_min_interval_sec);
  const jitter = getIntSetting("publish_jitter_sec", 300);
  return [Math.max(1, limit), Math.max(0, interval), Math.max(0, jitter)];
}

export function availability(
  row: AccountRow,
  at?: number,
  countQuota = true
): [boolean, string, number] {
  const moment = at || now();
  if (!row.enabled) return [false, "账号已停用", moment];
  if (row.status === "expired") return [false, "登录已失效", moment];
  const cooldown = Number(row.cooldown_until || 0);
  if (cooldown > moment) {
    const wait = cooldown - moment;
    return [false, `风控冷却中，还需 ${Math.max(1, Math.floor(wait / 60))} 分钟`, cooldown];
  }
  if (cooldown && row.health_state === "risk") {
    return [false, "冷却已结束，等待登录探测", moment + 120];
  }
  if (row.health_state === "probing") {
    const count = Number(row.probe_success_count || 0);
    if (count < 2) {
      const nextAt = Math.max(moment, Number(row.health_checked_at || 0) + 300);
      return [false, `冷却后探测中（${count}/2），暂不发布`, nextAt];
    }
  }
  const gap = Math.max(0, getIntSetting("write_gap_sec", 45));
  if (gap) {
    const last = queryOne<{ t: number }>(
      "SELECT MAX(created_at) AS t FROM rate_events WHERE account_id=? AND action IN ('publish','health_check','sync')",
      row.id
    );
    const lastAction = Number(last?.t || 0);
    if (lastAction && lastAction + gap > moment) {
      const wait = lastAction + gap - moment;
      return [false, `刚操作过账号，还需 ${Math.max(1, wait)} 秒`, lastAction + gap];
    }
  }
  if (!countQuota) return [true, "", moment];
  const [limit, interval, jitter] = limits(row);
  const used = publishedToday(row.id);
  if (used >= limit) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return [false, `今日已达上限 ${limit} 篇`, Math.floor(start.getTime() / 1000) + 86400];
  }
  let offset = 0;
  if (jitter) {
    const day = new Date();
    day.setHours(0, 0, 0, 0);
    offset = Math.abs(hashNumber(`${row.id}:${Math.floor(day.getTime() / 1000)}`)) % (jitter + 1);
  }
  const lastPublish = Number(row.last_publish_at || 0);
  const nextAt = lastPublish + interval + offset;
  if (lastPublish && nextAt > moment) {
    return [false, `间隔未到，还需 ${Math.floor((nextAt - moment) / 60)} 分钟`, nextAt];
  }
  return [true, "", moment];
}

function hashNumber(text: string): number {
  let value = 0;
  for (const char of text) value = (value * 31 + char.charCodeAt(0)) | 0;
  return value;
}

export function clearCooldown(accountId: number, manual = false): void {
  const stamp = now();
  execute(
    "UPDATE accounts SET cooldown_until=0, health_state=?, probe_success_count=0, updated_at=? WHERE id=?",
    manual ? "healthy" : "probing",
    stamp,
    accountId
  );
  execute(
    "UPDATE risk_events SET ended_at=? WHERE account_id=? AND ended_at=0",
    stamp,
    accountId
  );
  if (manual) {
    execute(
      "INSERT INTO risk_events(account_id, type, reason, source, started_at, ended_at) " +
        "VALUES(?,?,?,'manual',?,?)",
      accountId,
      "manual_release",
      "人工解除冷却",
      stamp,
      stamp
    );
  }
}

/** 小红书允许粘贴 Cookie 接入（公众号/抖音必须扫码）。 */
export function addCookie(
  name: string,
  cookie: string,
  proxy = "",
  platform = "xiaohongshu"
): Record<string, unknown> {
  if (platform !== "xiaohongshu") {
    throw new Error(`${platformLabel(platform)} 的登录态由浏览器扫码产生，请使用「扫码登录」`);
  }
  const value = String(cookie || "").trim();
  if (!value) throw new Error("请粘贴完整的 Cookie");
  return upsertSession(platform, name || "小红书账号", { cookie: value }, { proxy });
}

export function markChecked(accountId: number, ok: boolean, message = ""): void {
  execute(
    "UPDATE accounts SET status=?, health_state=?, last_error=?, health_checked_at=?, " +
      "updated_at=? WHERE id=?",
    ok ? "healthy" : "expired",
    ok ? "healthy" : "expired",
    ok ? "" : message,
    now(),
    now(),
    accountId
  );
}

/** 巡检/登录成功后回写昵称、抖音号与头像；空值不覆盖已有值。 */
export function saveProfile(
  accountId: number,
  profile: { nickname?: string; red_id?: string; user_id?: string; avatar?: string }
): void {
  const row = getAccount(accountId);
  execute(
    "UPDATE accounts SET nickname=?, red_id=?, user_id=?, avatar=?, updated_at=? WHERE id=?",
    profile.nickname || row.nickname || "",
    profile.red_id || row.red_id || "",
    profile.user_id || row.user_id || "",
    profile.avatar || row.avatar || "",
    now(),
    accountId
  );
}
