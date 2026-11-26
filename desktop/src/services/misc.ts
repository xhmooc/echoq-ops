/** 外围能力：代理、通知、备份列表、设置公开视图。 */
import fs from "node:fs";
import path from "node:path";
import { ProxyAgent, fetch } from "undici";
import { BACKUP_DIR, DATA_DIR, DB_PATH, KEY_PATH, now } from "../core/config";
import { execute, queryAll, queryOne } from "../core/db";
import { DEFAULT_SETTINGS, allSettings, getSetting, SETTING_KEYS, setSetting } from "../core/settings";

// ---------------------------------------------------------------- 代理

function cleanProxyUrl(value: unknown): string {
  let url = String(value || "").trim();
  if (!url) throw new Error("代理地址不能为空");
  if (!url.includes("://")) url = `http://${url}`;
  if (!/^(http|https|socks5|socks5h):\/\//i.test(url)) {
    throw new Error("代理地址只支持 http / https / socks5");
  }
  return url;
}

function serializeProxy(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    enabled: Boolean(row.enabled),
    country: row.country,
    timezone: row.timezone,
    exit_ip: row.exit_ip,
    last_check_at: row.last_check_at,
    last_status: row.last_status,
    last_latency_ms: row.last_latency_ms,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listProxies(): Record<string, unknown>[] {
  return queryAll<Record<string, unknown>>("SELECT * FROM proxies ORDER BY id").map(serializeProxy);
}

export function addProxy(payload: Record<string, unknown>): Record<string, unknown> {
  const url = cleanProxyUrl(payload.url);
  const stamp = now();
  const id = execute(
    "INSERT INTO proxies(name, url, enabled, created_at, updated_at) VALUES(?,?,1,?,?)",
    String(payload.name || url).slice(0, 60),
    url,
    stamp,
    stamp
  );
  return serializeProxy(queryOne<Record<string, unknown>>("SELECT * FROM proxies WHERE id=?", id) || {});
}

export function updateProxy(proxyId: number, payload: Record<string, unknown>): Record<string, unknown> {
  const row = queryOne<Record<string, unknown>>("SELECT * FROM proxies WHERE id=?", proxyId);
  if (!row) throw Object.assign(new Error(`代理不存在: ${proxyId}`), { status: 404 });
  const updates: Record<string, unknown> = {};
  if ("name" in payload) updates.name = String(payload.name || "").slice(0, 60);
  if ("url" in payload) updates.url = cleanProxyUrl(payload.url);
  if ("enabled" in payload) updates.enabled = payload.enabled ? 1 : 0;
  if (!Object.keys(updates).length) return serializeProxy(row);
  updates.updated_at = now();
  const assignments = Object.keys(updates)
    .map((key) => `${key} = ?`)
    .join(", ");
  execute(`UPDATE proxies SET ${assignments} WHERE id = ?`, ...Object.values(updates), proxyId);
  return serializeProxy(queryOne<Record<string, unknown>>("SELECT * FROM proxies WHERE id=?", proxyId) || {});
}

export function deleteProxy(proxyId: number): void {
  const row = queryOne<{ url: string }>("SELECT url FROM proxies WHERE id=?", proxyId);
  if (!row) throw Object.assign(new Error(`代理不存在: ${proxyId}`), { status: 404 });
  execute(
    "UPDATE accounts SET proxy='', proxy_group='', updated_at=? WHERE proxy=?",
    now(),
    row.url
  );
  execute("DELETE FROM proxies WHERE id=?", proxyId);
}

async function probeProxy(value: unknown): Promise<Record<string, unknown>> {
  const url = cleanProxyUrl(value);
  if (/^socks/i.test(url)) {
    throw new Error("Node 版暂不支持 socks5 代理测试，请改用 http/https 代理");
  }
  const started = Date.now();
  const dispatcher = new ProxyAgent(url);
  try {
    const response = await fetch("https://ipinfo.io/json", {
      dispatcher,
      signal: AbortSignal.timeout(12_000),
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error("代理已连接，但出口查询返回异常");
    const payload = (await response.json()) as Record<string, unknown>;
    const ip = String(payload.ip || "");
    if (!ip) throw new Error("代理已连接，但没拿到出口 IP");
    return {
      url,
      exit_ip: ip,
      country: String(payload.country || "未知"),
      timezone: String(payload.timezone || ""),
      latency_ms: Date.now() - started,
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("代理")) throw error;
    throw new Error("代理连接失败，请检查地址、账号密码与网络");
  } finally {
    void dispatcher.close().catch(() => undefined);
  }
}

export async function testProxy(proxyId: number | null, url = ""): Promise<Record<string, unknown>> {
  let target = url;
  if (proxyId) {
    const row = queryOne<{ url: string }>("SELECT url FROM proxies WHERE id=?", proxyId);
    if (!row) throw Object.assign(new Error(`代理不存在: ${proxyId}`), { status: 404 });
    target = row.url;
  }
  const result = await probeProxy(target);
  const stamp = now();
  const status = `出口 ${result.exit_ip} · ${result.latency_ms}ms`;
  if (proxyId) {
    execute(
      "UPDATE proxies SET exit_ip=?, country=?, timezone=?, last_check_at=?, " +
        "last_status=?, last_latency_ms=?, updated_at=? WHERE id=?",
      result.exit_ip,
      result.country,
      result.timezone,
      stamp,
      status,
      result.latency_ms,
      stamp,
      proxyId
    );
  }
  return { ...result, ok: true, message: `代理可用，出口 ${result.exit_ip}` };
}

// ---------------------------------------------------------------- 通知

const EVENT_TEXT: Record<string, string> = {
  publish_failed: "发布失败",
  publish_pending: "发布结果待确认",
  account_expired: "账号登录失效",
  note_abnormal: "作品数据异常",
  sync_failed: "内容同步失败",
  risk_cooldown: "账号进入风控冷却",
  backup_done: "备份完成",
};

function jsonList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  try {
    const items = JSON.parse(String(value || "[]"));
    return Array.isArray(items) ? items.map(String) : [];
  } catch {
    return [];
  }
}

export function unreadCount(): number {
  return Number(queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM notification_events WHERE read = 0")?.n || 0);
}

export function listNotifications(limit = 20, offset = 0, unreadOnly = false): Record<string, unknown> {
  const where = unreadOnly ? "WHERE read = 0" : "";
  const size = Math.max(1, Math.min(100, Math.trunc(limit || 20)));
  const rows = queryAll<Record<string, unknown>>(
    `SELECT * FROM notification_events ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
    size,
    Math.max(0, Math.trunc(offset))
  );
  const total = Number(
    queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM notification_events ${where}`)?.n || 0
  );
  return {
    items: rows.map((row) => ({
      id: row.id,
      event: row.event,
      event_text: EVENT_TEXT[String(row.event)] || row.event,
      level: row.level,
      title: row.title,
      message: row.message,
      link_view: row.link_view,
      link_id: row.link_id,
      read: Boolean(row.read),
      created_at: row.created_at,
    })),
    total,
    unread: unreadCount(),
  };
}

export function markNotificationsRead(ids: number[] | null): Record<string, unknown> {
  let updated = 0;
  if (ids === null) {
    updated = queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM notification_events WHERE read = 0")?.n || 0;
    execute("UPDATE notification_events SET read = 1 WHERE read = 0");
  } else {
    const clean = [...new Set(ids.filter((item) => Number.isFinite(item) && item > 0))];
    if (clean.length) {
      const marks = clean.map(() => "?").join(",");
      execute(`UPDATE notification_events SET read = 1 WHERE id IN (${marks})`, ...clean);
      updated = clean.length;
    }
  }
  return { updated, unread: unreadCount() };
}

function serializeChannel(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    channel: row.channel,
    name: row.name,
    target: row.target,
    events: jsonList(row.events).length ? jsonList(row.events) : ["all"],
    enabled: Boolean(row.enabled),
    created_at: row.created_at,
    last_sent_at: row.last_sent_at,
    last_status: row.last_status,
  };
}

export function listChannels(): Record<string, unknown>[] {
  return queryAll<Record<string, unknown>>("SELECT * FROM notifications ORDER BY id").map(
    serializeChannel
  );
}

function cleanEvents(raw: unknown): string[] {
  let events = raw || ["all"];
  if (typeof events === "string") {
    events = events.split(",").map((item) => item.trim());
  }
  const list = (Array.isArray(events) ? events : ["all"])
    .map(String)
    .filter((item) => item in EVENT_TEXT || item === "all");
  return list.length ? list : ["all"];
}

export function addChannel(payload: Record<string, unknown>): Record<string, unknown> {
  const channel = String(payload.channel || "webhook").trim().toLowerCase();
  if (!["webhook", "bark", "dingtalk"].includes(channel)) {
    throw new Error("暂只支持通用 Webhook / Bark / 钉钉机器人");
  }
  const target = String(payload.target || "").trim();
  if (!/^https?:\/\//i.test(target)) throw new Error("推送地址必须以 http:// 或 https:// 开头");
  const stamp = now();
  const id = execute(
    "INSERT INTO notifications(channel, name, target, events, enabled, created_at, updated_at) " +
      "VALUES(?,?,?,?,1,?,?)",
    channel,
    String(payload.name || "默认渠道").slice(0, 60),
    target.slice(0, 500),
    JSON.stringify(cleanEvents(payload.events)),
    stamp,
    stamp
  );
  return serializeChannel(queryOne<Record<string, unknown>>("SELECT * FROM notifications WHERE id=?", id) || {});
}

export function updateChannel(channelId: number, payload: Record<string, unknown>): Record<string, unknown> {
  const row = queryOne<Record<string, unknown>>("SELECT * FROM notifications WHERE id=?", channelId);
  if (!row) throw Object.assign(new Error(`通知渠道不存在: ${channelId}`), { status: 404 });
  const updates: Record<string, unknown> = {};
  if ("name" in payload) updates.name = String(payload.name || "").slice(0, 60);
  if ("target" in payload) {
    const target = String(payload.target || "").trim();
    if (!/^https?:\/\//i.test(target)) throw new Error("推送地址必须以 http:// 或 https:// 开头");
    updates.target = target.slice(0, 500);
  }
  if ("enabled" in payload) updates.enabled = payload.enabled ? 1 : 0;
  if ("events" in payload) updates.events = JSON.stringify(cleanEvents(payload.events));
  if (!Object.keys(updates).length) return serializeChannel(row);
  updates.updated_at = now();
  const assignments = Object.keys(updates)
    .map((key) => `${key} = ?`)
    .join(", ");
  execute(`UPDATE notifications SET ${assignments} WHERE id = ?`, ...Object.values(updates), channelId);
  return serializeChannel(
    queryOne<Record<string, unknown>>("SELECT * FROM notifications WHERE id=?", channelId) || {}
  );
}

export function deleteChannel(channelId: number): void {
  execute("DELETE FROM notifications WHERE id=?", channelId);
}

export async function testChannel(channelId: number): Promise<Record<string, unknown>> {
  const row = queryOne<Record<string, unknown>>("SELECT * FROM notifications WHERE id=?", channelId);
  if (!row) throw Object.assign(new Error(`通知渠道不存在: ${channelId}`), { status: 404 });
  const channel = serializeChannel(row);
  const target = String(channel.target || "");
  const kind = String(channel.channel || "webhook");
  const title = "应声运营 · 测试通知";
  const text = "收到这条说明通知渠道可用。";
  const started = Date.now();
  try {
    let response: Awaited<ReturnType<typeof fetch>>;
    if (kind === "dingtalk") {
      response = await fetch(target, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ msgtype: "text", text: { content: `${title}\n${text}` } }),
        signal: AbortSignal.timeout(8000),
      });
    } else if (kind === "bark") {
      response = await fetch(
        `${target.replace(/\/+$/, "")}/${encodeURIComponent(title)}/${encodeURIComponent(text)}`,
        { signal: AbortSignal.timeout(8000) }
      );
    } else {
      response = await fetch(target, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "test",
          event_text: "测试通知",
          level: "info",
          title,
          message: text,
          at: now(),
          source: "EchoQ-Ops",
        }),
        signal: AbortSignal.timeout(8000),
      });
    }
    const latency = Date.now() - started;
    const ok = response.status >= 200 && response.status < 300;
    const message = ok ? `ok ${latency}ms` : `HTTP ${response.status}`;
    execute("UPDATE notifications SET last_sent_at=?, last_status=? WHERE id=?", now(), message, channelId);
    return { ok, message };
  } catch {
    execute("UPDATE notifications SET last_sent_at=?, last_status=? WHERE id=?", now(), "网络不可达或超时", channelId);
    return { ok: false, message: "网络不可达或超时" };
  }
}

// ---------------------------------------------------------------- 备份

export function listBackups(): Record<string, unknown>[] {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const files = fs
    .readdirSync(BACKUP_DIR)
    .filter((name) => name.endsWith(".eqbak"))
    .map((name) => {
      const target = path.join(BACKUP_DIR, name);
      const stat = fs.statSync(target);
      return { name, size: stat.size, created_at: Math.floor(stat.mtimeMs / 1000), label: name.includes("prerestore") ? "恢复前自动备份" : "手动备份" };
    })
    .sort((left, right) => right.created_at - left.created_at);
  return files;
}

export function deleteBackup(name: string): Record<string, unknown> {
  if (name.includes("/") || name.includes("\\") || !name.endsWith(".eqbak")) {
    throw new Error("备份文件名不合法");
  }
  const target = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(target)) throw Object.assign(new Error(`备份不存在: ${name}`), { status: 404 });
  fs.unlinkSync(target);
  return { deleted: true };
}

export function backupPath(name: string): string {
  if (name.includes("/") || name.includes("\\") || !name.endsWith(".eqbak")) {
    throw new Error("备份文件名不合法");
  }
  const target = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(target)) throw Object.assign(new Error(`备份不存在: ${name}`), { status: 404 });
  return target;
}

// ---------------------------------------------------------------- 设置

export function settingsPublic(): Record<string, unknown> {
  const values = allSettings();
  delete values.llm_api_key;
  return {
    values,
    llm: {
      configured: false,
      // Node 版当前只有离线模板，前端据此显示「离线模板」而不是误报「账号不可用」。
      offline_only: true,
      base_url: `${String(process.env.OPS_CLOUD_BASE_URL || "http://127.0.0.1:8787").replace(/\/+$/, "")}/v1`,
      model: getSetting("llm_model", "deepseek-chat") || "deepseek-chat",
      timeout_sec: 45,
      logged_in: false,
      subscription: {},
      remaining_units: null,
      reason: "Node 版尚未接入云端账号，文案生成暂用本地模式",
    },
    data_dir: DATA_DIR,
    db_path: DB_PATH,
    key_fingerprint: keyFingerprint(),
  };
}

function keyFingerprint(): string {
  if (!fs.existsSync(KEY_PATH)) return "";
  const text = fs.readFileSync(KEY_PATH, "utf8").trim();
  if (!text) return "";
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

export function updateSettings(fields: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(fields)) {
    if (SETTING_KEYS.has(key)) setSetting(key, String(value));
  }
  return settingsPublic();
}

export { DEFAULT_SETTINGS };
