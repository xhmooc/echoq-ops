/**
 * EchoQ-Cloud 账号与中转 Key 客户端（对应 Python 版 ops/cloud.py）。
 *
 * 上游 DeepSeek / DashScope 的 Key 只保存在云端；本地登录后拿到的是按账号
 * 签发的两把中转 Key（文案 `eqk_llm_...`、配图 `eqk_img_...`），所有生成请求
 * 统一走云端 /v1/* 中转。
 *
 * 本地只在 DATA_DIR/cloud_state.json 保存登录票据与这两把 Key，落盘前用
 * Fernet 加密；读盘时解密失败（换机器 / 删了 secret.key）按未登录处理。
 */
import fs from "node:fs";
import path from "node:path";
import { request } from "undici";
import { DATA_DIR, now } from "../core/config";
import { decrypt, encrypt } from "../core/fernet";
import { log } from "../core/log";

type KeyKind = "llm" | "image";

/** 云端服务基地址：与 Python 的 config.CLOUD_BASE_URL 一致，去掉末尾斜杠。 */
const CLOUD_BASE_URL = (process.env.OPS_CLOUD_BASE_URL || "http://127.0.0.1:8787").replace(
  /\/+$/,
  ""
);
const STATE_PATH = path.join(DATA_DIR, "cloud_state.json");
const STATE_TMP_PATH = path.join(DATA_DIR, "cloud_state.json.tmp");
/** Python 版 TIMEOUT=(5, 20)：连接 5 秒、读取 20 秒。 */
const HEADERS_TIMEOUT = 5_000;
const BODY_TIMEOUT = 20_000;

const APP_VERSION = process.env.OPS_VERSION || "0.1.0";
const APP_CHANNEL = (process.env.OPS_CHANNEL || "stable").trim().toLowerCase();
const APP_PLATFORM = (process.env.OPS_PLATFORM || "win-x64").trim();
const DEFAULT_MODEL = process.env.OPS_LLM_MODEL || "deepseek-chat";

const KINDS: Record<KeyKind, string> = { llm: "文案 Key", image: "配图 Key" };
const STATE_LABELS: Record<string, string> = {
  trialing: "已开通",
  active: "生效中",
  scheduled: "待生效",
  past_due: "宽限期",
  expired: "已过期",
  none: "未订阅",
};

/** 云端返回的可读错误；status / code 供接口层决定 HTTP 状态码。 */
export class CloudError extends Error {
  status: number;
  code: string;

  constructor(message: string, options: { status?: number; code?: string } = {}) {
    super(message);
    this.name = "CloudError";
    this.status = options.status || 0;
    this.code = options.code || "";
  }
}

interface KeyState {
  plain: string;
  masked: string;
  prefix: string;
  created_at: string;
  last_used_at: string;
}

interface CloudState {
  base_url: string;
  token: string;
  expires_at: string;
  user: Record<string, unknown>;
  account_state: string;
  subscription: Record<string, unknown>;
  keys: Record<string, KeyState>;
  updated_at: number;
}

// ---------------------------------------------------------------- 工具

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function errorName(error: unknown): string {
  if (error instanceof Error) return error.name || "Error";
  return String(error);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 同步小睡：仅用于文件被占用时的重试退避。 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function emptyKey(): KeyState {
  return { plain: "", masked: "", prefix: "", created_at: "", last_used_at: "" };
}

function emptyState(): CloudState {
  return {
    base_url: CLOUD_BASE_URL,
    token: "",
    expires_at: "",
    user: {},
    account_state: "",
    subscription: {},
    keys: {},
    updated_at: 0,
  };
}

// ---------------------------------------------------------------- 本地状态

function tryDecrypt(value: string): string {
  if (!value) return "";
  try {
    return decrypt(value);
  } catch {
    // 密钥换过（换了机器 / 删了 secret.key）时旧票据作废，重新登录即可。
    log.warn("云端登录票据解密失败，已按未登录处理；请重新登录");
    return "";
  }
}

function loadState(): CloudState {
  const state = emptyState();
  if (!fs.existsSync(STATE_PATH)) return state;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    log.warn(`云端登录状态文件损坏，已忽略: ${STATE_PATH}`);
    return state;
  }
  if (!isRecord(raw)) return state;

  state.base_url = String(raw.base_url || CLOUD_BASE_URL);
  state.token = tryDecrypt(String(raw.token || ""));
  state.expires_at = String(raw.expires_at || "");
  state.user = isRecord(raw.user) ? raw.user : {};
  state.account_state = String(raw.account_state || "");
  state.subscription = isRecord(raw.subscription) ? raw.subscription : {};
  const stamp = Number(raw.updated_at || 0);
  state.updated_at = Number.isFinite(stamp) ? Math.trunc(stamp) : 0;

  if (isRecord(raw.keys)) {
    for (const [kind, item] of Object.entries(raw.keys)) {
      if (!(kind in KINDS) || !isRecord(item)) continue;
      state.keys[kind] = {
        plain: tryDecrypt(String(item.secret || "")),
        masked: String(item.masked || ""),
        prefix: String(item.prefix || ""),
        created_at: String(item.created_at || ""),
        last_used_at: String(item.last_used_at || ""),
      };
    }
  }
  return state;
}

/** 原子写；票据与 Key 加密后再落盘。 */
function saveState(state: CloudState): void {
  const payload: Record<string, unknown> = {
    base_url: state.base_url,
    token: state.token ? encrypt(state.token) : "",
    expires_at: state.expires_at,
    user: state.user,
    account_state: state.account_state,
    subscription: state.subscription,
    keys: {} as Record<string, Record<string, string>>,
    updated_at: state.updated_at,
  };
  const keys: Record<string, Record<string, string>> = {};
  for (const [kind, item] of Object.entries(state.keys)) {
    keys[kind] = {
      secret: item.plain ? encrypt(item.plain) : "",
      masked: item.masked,
      prefix: item.prefix,
      created_at: item.created_at,
      last_used_at: item.last_used_at,
    };
  }
  payload.keys = keys;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    fs.writeFileSync(STATE_TMP_PATH, JSON.stringify(payload, null, 2), "utf8");
    fs.chmodSync(STATE_TMP_PATH, 0o600);
  } catch {
    // 权限设置失败不影响写入；Windows 上也常被忽略。
  }
  // Windows 上杀毒/索引偶尔会短暂占用目标文件，rename 报 EPERM/EBUSY；
  // 重试几次，仍失败就退化成直接覆盖，避免整次刷新因落盘失败而报错。
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      fs.renameSync(STATE_TMP_PATH, STATE_PATH);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code || "";
      if (!["EPERM", "EACCES", "EBUSY"].includes(code)) throw error;
      if (attempt === 3) {
        try {
          fs.writeFileSync(STATE_PATH, fs.readFileSync(STATE_TMP_PATH, "utf8"), "utf8");
          fs.unlinkSync(STATE_TMP_PATH);
        } catch {
          /* 落盘失败时保持旧文件，交由调用方的错误提示 */
        }
        return;
      }
      sleepSync(50 * (attempt + 1));
    }
  }
}

function clearState(): void {
  saveState(emptyState());
}

// ---------------------------------------------------------------- HTTP

interface RequestAuth {
  token?: string;
  apiKey?: string;
}

async function apiRequest(
  method: "GET" | "POST",
  endpoint: string,
  payload?: Record<string, unknown>,
  auth: RequestAuth = {}
): Promise<Record<string, unknown>> {
  const url = `${CLOUD_BASE_URL}${endpoint}`;
  const headers: Record<string, string> = { Accept: "application/json" };
  const bearer = auth.apiKey || auth.token || "";
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (payload !== undefined) headers["Content-Type"] = "application/json";

  let statusCode = 0;
  let text = "";
  try {
    const response = await request(url, {
      method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
      headersTimeout: HEADERS_TIMEOUT,
      bodyTimeout: BODY_TIMEOUT,
    });
    statusCode = response.statusCode;
    text = await response.body.text();
  } catch (error) {
    log.warn(`云端请求失败 ${method} ${endpoint}: ${errorName(error)}: ${errorMessage(error)}`);
    throw new CloudError("连不上账号服务，请检查网络或稍后重试", { code: "network" });
  }

  let body: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(text);
    if (isRecord(parsed)) body = parsed;
  } catch {
    body = {};
  }

  if (statusCode >= 400 || body.ok === false) {
    const error = body.error;
    let message: string;
    let code: string;
    if (isRecord(error)) {
      // 新版 EchoQ-Cloud 统一返回 { ok:false, error:{ code, message } }。
      message = String(error.message || `账号服务返回 HTTP ${statusCode}`).trim();
      code = String(error.code || "");
    } else {
      message = String(error || `账号服务返回 HTTP ${statusCode}`).trim();
      code = String(body.code || "");
    }
    if (auth.token && statusCode === 401) {
      // 票据被服务端作废（重装 / 换密钥）时立刻清掉本地登录态，
      // 否则界面会一直显示「已登录」，所有 AI 请求都报成模型故障。
      clearState();
      throw new CloudError("登录已失效，请重新登录", { status: 401, code: "token_expired" });
    }
    throw new CloudError(message, { status: statusCode, code });
  }
  return isRecord(body.data) ? body.data : {};
}

// ---------------------------------------------------------------- 状态

function maskPhone(value: string): string {
  const text = String(value || "");
  return text.length >= 8 ? `${text.slice(0, 3)}****${text.slice(-4)}` : text;
}

function maskEmail(value: string): string {
  const text = String(value || "");
  const at = text.indexOf("@");
  if (at < 0) return text;
  const name = text.slice(0, at);
  const domain = text.slice(at + 1);
  const keep = name.length > 2 ? name.slice(0, 2) : name.slice(0, 1);
  return `${keep}***@${domain}`;
}

function isMasked(value: string): boolean {
  return value.includes("•") || value.includes("*");
}

/** 剩余天数：无时区的时间按 UTC 处理，与 Python 版一致。 */
function daysLeft(endsAt: unknown): number | null {
  const text = String(endsAt || "").replace("Z", "+00:00");
  if (!text) return null;
  const normalized = /[+-]\d{2}:\d{2}$/.test(text) ? text : `${text}Z`;
  const end = Date.parse(normalized);
  if (!Number.isFinite(end)) return null;
  return Math.max(0, Math.floor((end - Date.now()) / 86_400_000));
}

function blockedReasonFor(state: CloudState, kind: KeyKind): string {
  if (!state.token) return "请先登录 EchoQ 账号后再使用 AI 生成";
  const accountState = String(state.account_state || "");
  if (accountState === "banned") return "账号已被封禁，请联系客服";
  if (accountState === "deleted") return "账号已注销";
  const key = state.keys[kind];
  if (!key || !key.plain) {
    return `本机还没有${KINDS[kind] || "中转 Key"}，请在账号面板点一次「重置」`;
  }
  const subscription = state.subscription || {};
  const subState = String(subscription.state || "");
  if (accountState === "past_due" || ["expired", "none", "past_due"].includes(subState)) {
    return "订阅已到期，请续费后继续生成";
  }
  const remaining = subscription.remaining_units;
  if (typeof remaining === "number" && Number.isInteger(remaining) && remaining <= 0) {
    return "本期额度已用完，续费或等下个周期恢复";
  }
  return "";
}

/** 给页面的公开状态：不含 token，也不含任何完整 Key。 */
export function status(): Record<string, unknown> {
  const state = loadState();
  const user = state.user || {};
  const subscription = state.subscription || {};
  const keys: Record<string, unknown> = {};
  for (const kind of Object.keys(KINDS) as KeyKind[]) {
    const item = state.keys[kind] || emptyKey();
    keys[kind] = {
      kind,
      kind_name: KINDS[kind],
      ready: Boolean(item.plain),
      masked: item.masked || "",
      prefix: item.prefix || "",
      last_used_at: item.last_used_at || "",
    };
  }
  const days =
    subscription.days_left == null ? daysLeft(subscription.ends_at) : subscription.days_left;
  return {
    base_url: CLOUD_BASE_URL,
    logged_in: Boolean(state.token),
    user: {
      display_name: String(user.display_name || ""),
      phone: maskPhone(String(user.phone || "")),
      email: maskEmail(String(user.email || "")),
    },
    account_state: state.account_state || "",
    subscription: {
      state: subscription.state || "",
      state_name: STATE_LABELS[String(subscription.state || "")] || "未订阅",
      plan_name: subscription.plan_name || subscription.plan_code || "",
      remaining_units: subscription.remaining_units ?? null,
      quota_units: subscription.quota_units ?? null,
      used_units: subscription.used_units ?? null,
      ends_at: subscription.ends_at || "",
      days_left: days ?? null,
    },
    keys,
    expires_at: state.expires_at || "",
    updated_at: state.updated_at || 0,
    generation_allowed: !blockedReasonFor(state, "llm"),
    image_allowed: !blockedReasonFor(state, "image"),
  };
}

export function loggedIn(): boolean {
  return Boolean(loadState().token);
}

export function keyFor(kind: KeyKind = "llm"): string {
  const item = loadState().keys[kind] || emptyKey();
  return String(item.plain || "");
}

export function blockedReason(kind: KeyKind = "llm"): string {
  return blockedReasonFor(loadState(), kind);
}

/** 取中转 Key；未登录 / 无 Key / 订阅失效时抛出可直接展示的错误。 */
export function requireKey(kind: KeyKind = "llm"): string {
  const state = loadState();
  const reason = blockedReasonFor(state, kind);
  if (reason) {
    const code = state.token ? "subscription_required" : "login_required";
    throw new CloudError(reason, {
      status: code === "login_required" ? 401 : 402,
      code,
    });
  }
  return String((state.keys[kind] || emptyKey()).plain || "");
}

// ---------------------------------------------------------------- 登录

function recordKind(record: Record<string, unknown>): KeyKind {
  const raw = String(record.kind || "")
    .trim()
    .toLowerCase();
  if (raw === "llm" || raw === "image") return raw;
  return String(record.scopes || "").includes("image") ? "image" : "llm";
}

/** 合并 Key 掩码 + 当次签发的明文，兼容新旧两种云端返回。 */
function mergeKeys(state: CloudState, data: Record<string, unknown>): KeyKind[] {
  const issued: KeyKind[] = [];
  const listed = data.keys;

  if (Array.isArray(listed)) {
    for (const record of listed) {
      if (!isRecord(record)) continue;
      const kind = recordKind(record);
      const current = state.keys[kind] || emptyKey();
      const value = String(record.key || "");
      const plain = isMasked(value) ? "" : value;
      const prefix = String(record.prefix || current.prefix || "");
      state.keys[kind] = {
        plain: plain || current.plain || "",
        masked: String(
          record.masked || (prefix ? `${prefix}••••••••••••` : current.masked || "")
        ),
        prefix,
        created_at: String(record.created_at || current.created_at || ""),
        last_used_at: String(record.last_used_at || ""),
      };
      if (plain) issued.push(kind);
    }
    return issued;
  }

  const remoteList = isRecord(listed) ? listed : {};
  let issuedMap: Record<string, unknown> = isRecord(data.new_keys) ? data.new_keys : {};
  if (!Object.keys(issuedMap).length && data.new_key) {
    issuedMap = { llm: String(data.new_key || "") };
  }
  for (const kind of Object.keys(KINDS) as KeyKind[]) {
    const remote = isRecord(remoteList[kind])
      ? (remoteList[kind] as Record<string, unknown>)
      : {};
    const current = state.keys[kind] || emptyKey();
    const plain = String(issuedMap[kind] || current.plain || "");
    if (issuedMap[kind]) issued.push(kind);
    if (!plain && !remote.masked) continue;
    state.keys[kind] = {
      plain,
      masked: String(remote.masked || current.masked || ""),
      prefix: String(remote.prefix || current.prefix || ""),
      created_at: String(remote.created_at || current.created_at || ""),
      last_used_at: String(remote.last_used_at || ""),
    };
  }
  return issued;
}

function applyLogin(state: CloudState, data: Record<string, unknown>): KeyKind[] {
  const token = String(data.token || "");
  if (token) state.token = token;
  state.expires_at = String(data.expires_at || state.expires_at || "");

  const user = isRecord(data.user) ? data.user : {};
  const account = isRecord(data.account) ? data.account : {};
  if (Object.keys(account).length) {
    // 新版返回 account{user_id,email,phone,display_name,status}。
    state.user = {
      id: account.user_id || account.id || state.user.id || null,
      display_name: String(account.display_name || ""),
      phone: String(account.phone || ""),
      email: String(account.email || ""),
    };
    const statusValue = String(account.account_state ?? account.status ?? "")
      .trim()
      .toLowerCase();
    state.account_state =
      statusValue === "" || ["active", "trial", "past_due"].includes(statusValue)
        ? ""
        : ["banned", "disabled", "blocked"].includes(statusValue)
          ? "banned"
          : statusValue;
  } else if (Object.keys(user).length) {
    state.user = { ...user };
    state.account_state = String(user.account_state ?? state.account_state ?? "");
  }

  let subscription = data.subscription;
  if (!isRecord(subscription)) subscription = account.subscription;
  if (isRecord(subscription) && Object.keys(subscription).length) {
    const merged: Record<string, unknown> = { ...subscription };
    const planCode = String(merged.plan_code || "");
    if (!merged.plan_name) merged.plan_name = planCode === "trial" ? "专业版" : planCode;
    if (merged.days_left == null) merged.days_left = daysLeft(merged.ends_at);
    state.subscription = merged;
  }

  const issued = mergeKeys(state, data);
  state.updated_at = now();
  return issued;
}

export async function sendSms(phone: string): Promise<Record<string, unknown>> {
  const data = await apiRequest("POST", "/api/auth/sms/send", {
    phone: String(phone || "").trim(),
  });
  const resend = Number(data.resend_in || 60);
  return {
    sent: data.ok === undefined ? true : Boolean(data.ok),
    resend_in: Number.isFinite(resend) ? Math.trunc(resend) : 60,
    // 仅本地开发环境（SMS_DEV_MODE=1）会返回，方便直接填验证码。
    dev_code: String(data.dev_code || ""),
  };
}

export async function login(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const phone = String(payload.phone || "").trim();
  const code = String(payload.code || "").trim();
  const email = String(payload.email || "").trim();
  const password = String(payload.password || "");
  const displayName = String(payload.display_name || "").trim();

  let data: Record<string, unknown>;
  if (phone) {
    data = await apiRequest("POST", "/api/auth/sms/login", {
      phone,
      code,
      display_name: displayName,
    });
  } else if (email) {
    data = await apiRequest("POST", "/api/auth/email/login", { email, password });
  } else {
    throw new CloudError("请填写手机号或邮箱", { code: "invalid_input" });
  }

  const state = loadState();
  const issued = applyLogin(state, data);
  saveState(state);
  log.info(
    `云端登录成功: user=${String(state.user.id ?? "")} subscription=${String(
      state.subscription.state ?? ""
    )} issued=${issued.length ? issued.join(",") : "-"}`
  );
  return { status: status(), is_new: Boolean(data.is_new), issued };
}

export async function refresh(): Promise<Record<string, unknown>> {
  const state = loadState();
  if (!state.token) {
    throw new CloudError("请先登录账号", { status: 401, code: "login_required" });
  }
  let data: Record<string, unknown>;
  try {
    data = await apiRequest("GET", "/api/me", undefined, { token: state.token });
  } catch (error) {
    if (error instanceof CloudError && error.status === 401) {
      clearState();
      throw new CloudError("登录已过期，请重新登录", { status: 401, code: "token_expired" });
    }
    throw error;
  }
  const issued = applyLogin(state, data);
  saveState(state);
  return { status: status(), issued };
}

export async function logout(): Promise<Record<string, unknown>> {
  const state = loadState();
  const token = String(state.token || "");
  if (token) {
    try {
      await apiRequest("POST", "/api/auth/logout", {}, { token });
    } catch (error) {
      // 云端不可达时也要允许本地退出，避免票据卡在过期状态。
      log.warn(`云端退出失败，已清理本地登录状态: ${errorMessage(error)}`);
    }
  }
  clearState();
  return { status: status() };
}

export async function resetKey(kind: string): Promise<Record<string, unknown>> {
  const target: KeyKind = String(kind || "").trim().toLowerCase() === "image" ? "image" : "llm";
  let state = loadState();
  if (!state.token) {
    throw new CloudError("请先登录账号", { status: 401, code: "login_required" });
  }
  const data = await apiRequest("POST", "/api/keys/reset", { kind: target }, { token: state.token });
  const plain = String(data.key || "");
  const record = isRecord(data.record) ? data.record : {};

  state = loadState();
  const item = state.keys[target] || emptyKey();
  const prefix = String(record.prefix || "");
  state.keys[target] = {
    plain: plain || item.plain || "",
    masked: prefix ? `${prefix}••••••••••••` : item.masked || "",
    prefix: prefix || item.prefix || "",
    created_at: String(record.created_at || ""),
    last_used_at: "",
  };
  saveState(state);
  log.info(`已重置${KINDS[target]}`);
  return {
    kind: target,
    kind_name: KINDS[target],
    masked: state.keys[target].masked || "",
    notice: String(data.notice || `${KINDS[target]}已重置`),
    status: status(),
  };
}

// ---------------------------------------------------------------- 版本更新

function normalizeLatest(latest: unknown): Record<string, unknown> | null {
  if (!isRecord(latest) || !latest.version) return null;
  const download = latest.download;
  return {
    version: String(latest.version || ""),
    notes: String(latest.notes || ""),
    published_at: String(latest.published_at || ""),
    min_supported: String(latest.min_supported || ""),
    download: isRecord(download) && download.url ? download : null,
  };
}

/**
 * 查询云端最新发布版本。
 *
 * 更新检查是锦上添花：连不上、返回异常或尚未发布时都返回 checked=false
 * 或 latest=null，调用方静默跳过，不能因此影响正常使用。
 */
export async function updateInfo(current = ""): Promise<Record<string, unknown>> {
  const version = (current || APP_VERSION).trim();
  const params = new URLSearchParams({
    product: "ops",
    channel: APP_CHANNEL,
    platform: APP_PLATFORM,
    current: version,
  });
  const empty: Record<string, unknown> = {
    checked: false,
    current: version,
    channel: APP_CHANNEL,
    platform: APP_PLATFORM,
    update_available: false,
    mandatory: false,
    latest: null,
    checked_at: 0,
  };

  let body: Record<string, unknown> | null = null;
  try {
    const response = await request(`${CLOUD_BASE_URL}/api/app/version?${params.toString()}`, {
      headers: { Accept: "application/json" },
      headersTimeout: HEADERS_TIMEOUT,
      bodyTimeout: BODY_TIMEOUT,
    });
    const text = await response.body.text();
    const parsed = JSON.parse(text);
    body = isRecord(parsed) ? parsed : null;
  } catch (error) {
    log.info(`更新检查跳过（${errorName(error)}）`);
    return { ...empty, reason: "暂时连不上更新服务" };
  }
  if (!body || body.ok === false) {
    return { ...empty, reason: "更新服务返回异常" };
  }
  return {
    checked: true,
    current: String(body.current || version),
    channel: String(body.channel || APP_CHANNEL),
    platform: String(body.platform || APP_PLATFORM),
    update_available: Boolean(body.update_available),
    mandatory: Boolean(body.mandatory),
    latest: normalizeLatest(body.latest),
    checked_at: intValue(body.checked_at),
  };
}

function intValue(value: unknown): number {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

// ---------------------------------------------------------------- 体检

/**
 * 云端体检：把「连不上 / 没登录 / Key 失效 / 模型不在白名单」分开报。
 *
 * 只做只读探测，不改数据；唯一副作用是票据失效时会清掉本地登录态。
 */
export async function doctor(model = ""): Promise<Record<string, unknown>> {
  const modelName = (model || DEFAULT_MODEL).trim();
  const items: Record<string, unknown>[] = [];
  const report: Record<string, unknown> = {
    base_url: CLOUD_BASE_URL,
    version: APP_VERSION,
    model: modelName,
    logged_in: false,
    items,
    checked_at: 0,
  };
  const add = (key: string, name: string, ok: boolean, detail = ""): void => {
    items.push({ key, name, ok: Boolean(ok), detail });
  };

  // 1. 云端可达（公开接口，不需要登录）
  const params = new URLSearchParams({
    product: "ops",
    channel: APP_CHANNEL,
    platform: APP_PLATFORM,
    current: APP_VERSION,
  });
  try {
    const response = await request(`${CLOUD_BASE_URL}/api/app/version?${params.toString()}`, {
      headers: { Accept: "application/json" },
      headersTimeout: HEADERS_TIMEOUT,
      bodyTimeout: BODY_TIMEOUT,
    });
    await response.body.text();
    add(
      "reach",
      "云端可达",
      response.statusCode === 200,
      `HTTP ${response.statusCode} · ${CLOUD_BASE_URL}`
    );
  } catch (error) {
    add("reach", "云端可达", false, `${errorName(error)} · ${CLOUD_BASE_URL}`);
  }

  // 2. 登录态（顺带校验票据，失效会被清掉）
  let statusInfo: Record<string, unknown> = {};
  let refreshed = false;
  try {
    const result = await refresh();
    statusInfo = isRecord(result.status) ? result.status : {};
    refreshed = true;
  } catch (error) {
    add("login", "账号登录", false, errorMessage(error) || errorName(error));
  }
  if (refreshed) {
    const logged = Boolean(statusInfo.logged_in);
    report.logged_in = logged;
    const user = isRecord(statusInfo.user) ? statusInfo.user : {};
    const detail =
      String(user.display_name || user.phone || user.email || "") || "未登录，请先登录";
    add("login", "账号登录", logged, detail);
  }

  if (report.logged_in) {
    // 3. Key 能通过中转，4. 模型在白名单
    let key = "";
    try {
      key = keyFor("llm");
    } catch (error) {
      add("key", "文案 Key", false, errorMessage(error));
    }
    if (!key) {
      add("key", "文案 Key", false, "本机没有可用的文案 Key，请重新登录或重置");
    } else {
      try {
        const response = await request(`${CLOUD_BASE_URL}/v1/models`, {
          headers: { Accept: "application/json", Authorization: `Bearer ${key}` },
          headersTimeout: HEADERS_TIMEOUT,
          bodyTimeout: BODY_TIMEOUT,
        });
        const text = await response.body.text();
        const body: Record<string, unknown> =
          response.statusCode === 200 ? (JSON.parse(text) as Record<string, unknown>) : {};
        const models = Array.isArray(body.data)
          ? body.data.filter(isRecord).map((item) => String(item.id || ""))
          : [];
        add("key", "文案 Key", models.length > 0, `HTTP ${response.statusCode}`);
        add(
          "model",
          `模型 ${modelName}`,
          models.includes(modelName),
          models.length ? `白名单: ${models.join("、")}` : "未取到模型清单"
        );
      } catch (error) {
        add("key", "文案 Key", false, errorName(error));
        add("model", `模型 ${modelName}`, false, "Key 不可用，无法核对白名单");
      }
    }

    // 5. 订阅与额度
    add(
      "plan",
      "订阅额度",
      Boolean(statusInfo.generation_allowed),
      statusInfo.generation_allowed ? "可正常生成" : "订阅到期或额度用尽"
    );
  } else {
    add("key", "文案 Key", false, "登录后再检查");
    add("model", `模型 ${modelName}`, false, "登录后再检查");
    add("plan", "订阅额度", false, "登录后再检查");
  }

  report.ok = items.every((item) => item.ok === true);
  report.checked_at = now();
  return report;
}
