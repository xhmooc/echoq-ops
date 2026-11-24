/**
 * 抖音创作者中心适配器（Electron 版）。
 *
 * 移植自 ops/platforms/douyin.py。Python 版用 Playwright 起浏览器；Node 版
 * 没有引入新的浏览器内核，而是复用 Electron 自带的 Chromium：每次操作开一个
 * 独立 partition 的隐藏窗口，把登录态里的 Cookie 写进该 partition，再按
 * 抖音创作者中心的真实页面流程完成登录检查与发布。
 *
 * 已实现：
 * - checkSession：打开创作者中心，登录墙判定 + 读取昵称/抖音号/头像；
 * - publish：视频 / 图文上传、文案填写、可见范围、提交并尽量取回作品 ID。
 *
 * 受限：
 * - 视频时长校验依赖 ffprobe/OpenCV，Node 侧未引入，只校验格式与大小；
 * - 作品回读（fetchPublished）暂未迁移，需要时再按创作者列表接口补齐。
 */
import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, session as electronSession } from "electron";
import { DATA_DIR } from "../../core/config";
import { log } from "../../core/log";

export type DouyinFailureKind = "auth" | "rate" | "content" | "platform" | "network";

export class DouyinFailure extends Error {
  constructor(
    public kind: DouyinFailureKind,
    message: string,
    public detail = ""
  ) {
    super(message);
    this.name = "DouyinFailure";
  }
}

export const DOUYIN_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const CREATOR_HOME = "https://creator.douyin.com/";
export const CREATOR_MICRO_HOME = "https://creator.douyin.com/creator-micro/home";
export const CREATOR_UPLOAD = "https://creator.douyin.com/creator-micro/content/upload";

/** 抖音把这些 Cookie 视为有效登录态；页面跳转仍以创作者中心为准。 */
export const DOUYIN_AUTH_COOKIES = new Set([
  "sessionid",
  "sessionid_ss",
  "sid_guard",
  "uid_tt",
]);

const VIDEO_MAX_BYTES = 4 * 1024 * 1024 * 1024;
const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const VIDEO_SUFFIXES = new Set([".mp4", ".mov", ".webm", ".avi", ".mkv", ".flv", ".wmv", ".m4v"]);
const IMAGE_SUFFIXES = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"]);

const VISIBILITY_LABELS: Record<number, string> = {
  0: "公开",
  1: "仅自己可见",
  2: "好友可见",
};

const TEXT_SCRIPT = "(document.body && document.body.innerText) || ''";

const USER_INFO_SCRIPT = `(async () => {
  const urls = [
    'https://creator.douyin.com/web/api/media/user/info/?aid=2906',
    'https://creator.douyin.com/web/api/media/user/info/'
  ];
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        credentials: 'include',
        headers: { accept: 'application/json' }
      });
      if (!response.ok) continue;
      const data = await response.json();
      if (data) return data;
    } catch (error) {
      /* 继续尝试下一个地址 */
    }
  }
  return null;
})()`;

const VIDEO_INPUT_SELECTORS = [
  "input.upload-btn-input[accept*=video]",
  "input.upload-btn-input",
  "input[type=file][accept*=video]",
  "input[type=file]",
];

const IMAGE_INPUT_SELECTORS = [
  "input.upload-btn-input[accept*=image]",
  "input.upload-btn-input",
  "input[type=file][accept*=image]",
  "input[type=file][accept*=png]",
  "input[type=file]",
];

const EDITOR_READY_SCRIPT = `(() => Boolean(document.querySelector(
  'div.zone-container[contenteditable], input[placeholder*="填写作品标题"]'
)))()`;

const LATEST_ID_SCRIPT = `(async () => {
  const urls = [
    'https://creator.douyin.com/web/api/media/aweme/post/?status=0&count=10&cursor=0&aid=2906',
    'https://creator.douyin.com/web/api/media/aweme/list/?status=0&count=10&cursor=0&aid=2906',
    'https://creator.douyin.com/web/api/creator/item/list/?status=0&count=10&cursor=0&aid=2906'
  ];
  const pickList = (payload) => {
    if (!payload || typeof payload !== 'object') return [];
    for (const key of ['aweme_list', 'awemeList', 'item_list', 'itemList', 'items']) {
      if (Array.isArray(payload[key])) return payload[key];
    }
    const data = payload.data;
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') {
      for (const key of ['aweme_list', 'awemeList', 'item_list', 'itemList', 'items', 'list']) {
        if (Array.isArray(data[key])) return data[key];
      }
    }
    return [];
  };
  for (const url of urls) {
    try {
      const response = await fetch(url, { credentials: 'include', headers: { accept: 'application/json' } });
      if (!response.ok) continue;
      const payload = await response.json();
      for (const item of pickList(payload)) {
        if (!item || typeof item !== 'object') continue;
        const id = String(item.aweme_id || item.awemeId || item.item_id || item.itemId || '');
        if (/^\\d+$/.test(id)) return id;
      }
    } catch (error) {
      /* 继续尝试下一个接口 */
    }
  }
  return '';
})()`;

const SUBMIT_SCRIPT = `(() => {
  const browse = Array.from(document.querySelectorAll('button, div[role="button"]'));
  const depth = (el) => { let value = 0; let node = el; while (node && node.parentElement) { value += 1; node = node.parentElement; } return value; };
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };
  const usable = (el) => {
    const text = (el.innerText || '').trim();
    if (!text || text.length > 20) return false;
    if (text.includes('定时')) return false;
    return visible(el);
  };
  let target = browse.find((el) => usable(el) && ((el.innerText || '').trim() === '发布' || (el.innerText || '').trim() === '立即发布'));
  if (!target) target = browse.find((el) => usable(el) && (el.innerText || '').includes('发布'));
  if (!target) return '';
  const text = (target.innerText || '').trim();
  target.scrollIntoView({ block: 'center' });
  target.click();
  return text.slice(0, 20);
})()`;

const ERROR_TIP_SCRIPT = `(() => {
  const selectors = ['[class*="toast"]', '[class*="error"]', '[class*="tip"]'];
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    const text = el && el.innerText ? el.innerText.trim() : '';
    if (text) return text.slice(0, 120);
  }
  return '';
})()`;

export type DouyinElectronSession = ReturnType<typeof electronSession.fromPartition>;

export interface DouyinUserInfo {
  nickname: string;
  userId: string;
  platformId: string;
  avatar: string;
}

export interface DouyinCheckResult {
  ok: boolean;
  nickname?: string;
  red_id?: string;
  user_id?: string;
  avatar?: string;
  message?: string;
}

export interface DouyinPublishPayload {
  title?: string;
  desc?: string;
  images?: string[];
  topics?: string[];
  video?: string;
  content_type?: string;
  type?: number;
}

interface CookieSeed {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
}

interface PreparedMedia {
  isImage: boolean;
  files: string[];
}

// ---------------------------------------------------------------- 通用工具

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstUrl(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.length ? firstUrl(value[0]) : "";
  const record = asRecord(value);
  if (!Object.keys(record).length) return "";
  const list = record.url_list ?? record.urlList;
  if (Array.isArray(list) && list.length) return String(list[0] || "");
  return String(record.url || record.uri || "");
}

function withTimeout<T>(task: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DouyinFailure("network", message)), timeoutMs);
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function jsLiteral(value: unknown): string {
  return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function jsString(value: string): string {
  return jsLiteral(value);
}

function classifyFailure(message: string): DouyinFailureKind {
  const text = String(message || "").toLowerCase();
  if (/频繁|风控|限流|操作过快|请稍后再试|rate\s*limit|429/.test(text)) return "rate";
  if (/登录|login|passport|会话|cookie|扫码|未登录/.test(text)) return "auth";
  if (/改版|找不到|没有找到|不存在|按钮|选择器|页面结构/.test(text)) return "platform";
  return "network";
}

// ---------------------------------------------------------------- Cookie

function parseCookieHeader(header: string): CookieSeed[] {
  return String(header || "")
    .split(";")
    .map((pair): CookieSeed | null => {
      const index = pair.indexOf("=");
      if (index <= 0) return null;
      return {
        name: pair.slice(0, index).trim(),
        value: pair.slice(index + 1).trim(),
        domain: ".douyin.com",
        path: "/",
        expires: -1,
        httpOnly: false,
        secure: true,
        sameSite: "Lax",
      };
    })
    .filter((item): item is CookieSeed => Boolean(item && item.name));
}

function cookieSeedOf(item: unknown): CookieSeed | null {
  const record = asRecord(item);
  const name = String(record.name || "").trim();
  if (!name) return null;
  return {
    name,
    value: String(record.value ?? ""),
    domain: String(record.domain || ".douyin.com"),
    path: String(record.path || "/"),
    expires: Number(record.expires ?? record.expirationDate ?? -1),
    httpOnly: Boolean(record.httpOnly),
    secure: Boolean(record.secure),
    sameSite: String(record.sameSite || "Lax"),
  };
}

/**
 * 从整份登录态里取出 Cookie。
 *
 * 兼容三种形态：
 * - Python 版 session：{ storage_state: { cookies }, cookies, cookie_header, ... }
 * - 简化对象：{ cookie: "a=1; b=2" }
 * - 直接字符串 Cookie。
 */
function cookiesFromSession(session: Record<string, unknown> | string): CookieSeed[] {
  if (typeof session === "string") {
    const text = session.trim();
    if (text.startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === "object") {
          return cookiesFromSession(parsed as Record<string, unknown>);
        }
      } catch {
        /* 按 Cookie 头继续解析 */
      }
    }
    return parseCookieHeader(text);
  }
  const record = asRecord(session);
  const storageState = asRecord(record.storage_state ?? record.storageState);
  const lists = [record.cookies, storageState.cookies];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    const seeds = list
      .map(cookieSeedOf)
      .filter((item): item is CookieSeed => Boolean(item));
    if (seeds.length) return seeds;
  }
  const header = record.cookie_header ?? record.cookieHeader ?? record.cookie;
  if (typeof header === "string" && header.trim()) return parseCookieHeader(header);
  return [];
}

function cookieUrl(domain: string): string {
  const host = String(domain || "")
    .replace(/^\./, "")
    .trim();
  return /^[a-z0-9.-]+$/i.test(host) ? `https://${host}/` : "https://creator.douyin.com/";
}

function sameSiteOf(value: string): "unspecified" | "no_restriction" | "lax" | "strict" | undefined {
  switch (String(value || "").trim().toLowerCase()) {
    case "lax":
      return "lax";
    case "strict":
      return "strict";
    case "none":
    case "no_restriction":
      return "no_restriction";
    default:
      return undefined;
  }
}

function isDouyinDomain(domain: string): boolean {
  return /(^|\.)douyin\.com$/i.test(String(domain || "").trim());
}

export async function douyinCookieItems(
  ses: DouyinElectronSession
): Promise<Array<{ name: string; value: string; domain: string }>> {
  try {
    const all = await ses.cookies.get({});
    return all
      .filter((item) => isDouyinDomain(String(item.domain || "")))
      .map((item) => ({
        name: String(item.name || ""),
        value: String(item.value || ""),
        domain: String(item.domain || ".douyin.com"),
      }))
      .filter((item) => item.name);
  } catch {
    return [];
  }
}

export async function sessionCookieHeader(ses: DouyinElectronSession): Promise<string> {
  const items = await douyinCookieItems(ses);
  return items.map((item) => `${item.name}=${item.value}`).join("; ");
}

async function injectCookies(ses: DouyinElectronSession, session: Record<string, unknown> | string): Promise<void> {
  const seeds = cookiesFromSession(session);
  if (!seeds.length) {
    throw new DouyinFailure("auth", "抖音登录态为空，请重新扫码登录");
  }
  let stored = 0;
  for (const item of seeds) {
    const params: Electron.CookiesSetDetails = {
      url: cookieUrl(item.domain),
      name: item.name,
      value: item.value,
      path: item.path || "/",
      secure: item.secure,
      httpOnly: item.httpOnly,
    };
    // 只把根域 Cookie 标记为 .douyin.com；子域 Cookie 用 host-only 写入，
    // 避免被 Electron 规范化成 .creator.douyin.com 后反而匹配不到。
    if (/^\.?douyin\.com$/i.test(item.domain.trim())) params.domain = ".douyin.com";
    if (Number.isFinite(item.expires) && item.expires > 0) params.expirationDate = item.expires;
    const sameSite = sameSiteOf(item.sameSite);
    if (sameSite) params.sameSite = sameSite;
    try {
      await ses.cookies.set(params);
      stored += 1;
    } catch {
      /* 单条 Cookie 失败不影响其它 Cookie，最后统一判断 */
    }
  }
  if (!stored) {
    throw new DouyinFailure("auth", "抖音登录态写入浏览器失败，请重新扫码登录");
  }
}

// ---------------------------------------------------------------- 窗口与页面

export function newDouyinPartition(scope: string): string {
  return `douyin-${scope}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createDouyinWindow(
  partition: string,
  visible: boolean,
  title: string,
  /** 创建成全透明窗口：对页面算“可见”（抖音才肯加载二维码），但用户看不到。 */
  invisible = false
): BrowserWindow {
  if (!app.isReady()) {
    throw new DouyinFailure("platform", "桌面环境尚未就绪，请稍后重试");
  }
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: visible,
    opacity: invisible ? 0 : 1,
    title,
    autoHideMenuBar: true,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  win.removeMenu();
  // 抖音页面偶尔会跳到 bitbrowser:// 等自定义协议；在应用内拦掉，避免系统弹
  // 「获取打开此链接的应用」窗口。
  const isWebUrl = (url: string): boolean => /^https?:/i.test(url);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) void win.loadURL(url).catch(() => undefined);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (isWebUrl(url)) return;
    event.preventDefault();
    log.warn(`抖音窗口已拦截非网页协议: ${url.slice(0, 120)}`);
  });
  win.webContents.on("will-redirect", (event, url) => {
    if (isWebUrl(url)) return;
    event.preventDefault();
    log.warn(`抖音窗口已拦截非网页协议跳转: ${url.slice(0, 120)}`);
  });
  // 页面的反爬脚本会通过隐藏 iframe 探测本机安装的自定义协议（实测触发过
  // bitbrowser://），will-navigate 不覆盖子框架，这里一并拦截。
  win.webContents.on("will-frame-navigate", (details) => {
    if (isWebUrl(details.url)) return;
    details.preventDefault();
    log.warn(`抖音窗口已拦截子框架非网页协议: ${details.url.slice(0, 120)}`);
  });
  win.webContents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
  return win;
}

export async function prepareDouyinSession(
  partition: string,
  proxy: string
): Promise<DouyinElectronSession> {
  const ses = electronSession.fromPartition(partition, { cache: false });
  ses.setUserAgent(DOUYIN_UA);
  if (proxy) {
    const value = proxy.includes("://") ? proxy : `http://${proxy}`;
    try {
      await ses.setProxy({ proxyRules: value });
    } catch (error) {
      throw new DouyinFailure(
        "network",
        "抖音代理设置失败，请检查代理地址",
        errorText(error)
      );
    }
  }
  return ses;
}

export async function loadDouyinPage(
  win: BrowserWindow,
  url: string,
  timeoutMs: number
): Promise<void> {
  try {
    await withTimeout(win.loadURL(url), timeoutMs, "抖音页面加载超时，请检查网络或代理");
  } catch (error) {
    if (error instanceof DouyinFailure) throw error;
    throw new DouyinFailure("network", "抖音页面打开失败，请检查网络或代理", errorText(error));
  }
}

export async function execPage<T>(win: BrowserWindow, script: string): Promise<T> {
  if (!win || win.isDestroyed()) {
    throw new DouyinFailure("network", "抖音页面已关闭，请重试");
  }
  return (await win.webContents.executeJavaScript(script, true)) as T;
}

export async function readPageText(win: BrowserWindow): Promise<string> {
  try {
    const text = await execPage<string>(win, TEXT_SCRIPT);
    return typeof text === "string" ? text : "";
  } catch {
    return "";
  }
}

export function destroyWindow(win: BrowserWindow | null): void {
  if (!win) return;
  try {
    if (!win.isDestroyed()) win.destroy();
  } catch {
    /* 窗口可能已经销毁 */
  }
}

export async function cleanupPartition(partition: string): Promise<void> {
  try {
    await electronSession.fromPartition(partition).clearStorageData();
  } catch {
    /* 清理失败不影响结果 */
  }
}

export async function isLoginWall(win: BrowserWindow): Promise<boolean> {
  if (!win || win.isDestroyed()) return false;
  const url = win.webContents.getURL().toLowerCase();
  if (url.includes("creator-micro")) return false;
  if (url.includes("login") || url.includes("passport")) return true;
  const text = await readPageText(win);
  return /扫码登录|手机号登录|二维码失效|二维码已失效/.test(text);
}

async function clickByText(
  win: BrowserWindow,
  texts: string[],
  exact: boolean,
  excludes: string[] = []
): Promise<string> {
  const script = `(() => {
    const texts = ${jsLiteral(texts)};
    const excludes = ${jsLiteral(excludes)};
    const exact = ${exact};
    const depth = (el) => { let value = 0; let node = el; while (node && node.parentElement) { value += 1; node = node.parentElement; } return value; };
    const visible = (el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return false;
      const style = getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none';
    };
    const nodes = Array.from(document.querySelectorAll('button, div[role="button"], a, span, div, li, input[type="button"], input[type="submit"]'));
    const matches = [];
    for (const el of nodes) {
      const raw = (el.innerText || el.value || '').trim();
      if (!raw || raw.length > 40) continue;
      if (excludes.some((word) => raw.includes(word))) continue;
      const hit = texts.some((text) => exact ? raw === text : raw.includes(text));
      if (hit && visible(el)) matches.push(el);
    }
    if (!matches.length) return '';
    matches.sort((left, right) => depth(right) - depth(left));
    const target = matches[0];
    target.scrollIntoView({ block: 'center' });
    target.click();
    return ((target.innerText || target.value || '').trim()).slice(0, 40);
  })()`;
  try {
    const value = await execPage<string>(win, script);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

function fillTitleScript(text: string): string {
  return `(() => {
    const selectors = ['input[placeholder*="填写作品标题"]', 'input[placeholder*="作品标题"]'];
    let target = null;
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (el && el.getBoundingClientRect().width > 0) { target = el; break; }
    }
    if (!target) {
      const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
      target = inputs.find((el) => /标题/.test(el.placeholder || '')) || null;
    }
    if (!target) return false;
    target.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(target, ${jsString(text)});
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`;
}

function fillEditorScript(text: string): string {
  return `(() => {
    const selectors = [
      'div.zone-container[contenteditable="true"]',
      'div.zone-container[contenteditable]',
      'div[contenteditable="true"]',
      'textarea'
    ];
    let target = null;
    for (const selector of selectors) {
      const list = Array.from(document.querySelectorAll(selector));
      target = list.find((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }) || null;
      if (target) break;
    }
    if (!target) return false;
    target.focus();
    if (target.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(target, ${jsString(text)});
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(target);
    selection.removeAllRanges();
    selection.addRange(range);
    let ok = false;
    try {
      ok = document.execCommand('insertText', false, ${jsString(text)});
    } catch (error) {
      ok = false;
    }
    if (!ok || (target.innerText || '').trim() !== ${jsString(text)}.trim()) {
      target.textContent = ${jsString(text)};
      target.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${jsString(text)}, inputType: 'insertText' }));
    }
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`;
}

// ---------------------------------------------------------------- CDP（文件输入 + 响应捕获）

interface CdpDebugger {
  isAttached(): boolean;
  attach(protocolVersion?: string): void;
  detach(): void;
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

interface NetworkCapture {
  responses: Array<Record<string, unknown>>;
  stop(): void;
}

function attachDebugger(win: BrowserWindow): CdpDebugger {
  const dbg = win.webContents.debugger as unknown as CdpDebugger;
  try {
    if (!dbg.isAttached()) dbg.attach("1.3");
  } catch (error) {
    throw new DouyinFailure(
      "platform",
      "抖音发布页初始化失败（浏览器调试接口不可用），请重试",
      errorText(error)
    );
  }
  return dbg;
}

async function setFileInputFiles(
  dbg: CdpDebugger,
  selectors: string[],
  files: string[]
): Promise<boolean> {
  try {
    const doc = (await dbg.sendCommand("DOM.getDocument", { depth: 1 })) as {
      root?: { nodeId?: number };
    };
    const rootId = Number(doc?.root?.nodeId || 0);
    if (rootId) {
      for (const selector of selectors) {
        const found = (await dbg.sendCommand("DOM.querySelector", {
          nodeId: rootId,
          selector,
        })) as { nodeId?: number };
        if (found?.nodeId) {
          await dbg.sendCommand("DOM.setFileInputFiles", { files, nodeId: found.nodeId });
          return true;
        }
      }
    }
    // DOM.querySelector 找不到时退回 Runtime 取对象引用，覆盖隐藏 input。
    const evaluated = (await dbg.sendCommand("Runtime.evaluate", {
      expression: `(() => {
        const selectors = ${JSON.stringify(selectors)};
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          if (el) return el;
        }
        return null;
      })()`,
      returnByValue: false,
    })) as { result?: { objectId?: string } };
    const objectId = evaluated?.result?.objectId;
    if (objectId) {
      await dbg.sendCommand("DOM.setFileInputFiles", { files, objectId });
      return true;
    }
  } catch (error) {
    log.warn(`抖音上传入口定位失败: ${errorText(error)}`);
  }
  return false;
}

async function startNetworkCapture(dbg: CdpDebugger): Promise<NetworkCapture> {
  const responses: Array<Record<string, unknown>> = [];
  const targets = new Map<string, string>();
  const handler = (...args: unknown[]): void => {
    const method = String(args[1] || "");
    const params = asRecord(args[2]);
    if (method === "Network.requestWillBeSent") {
      const requestId = String(params.requestId || "");
      const request = asRecord(params.request);
      const url = String(request.url || "");
      // 作品列表接口也会带 /media/aweme，必须排除，否则会把旧作品 ID 当成发布结果。
      const isList = /\/aweme\/(post|list)\/|\/item\/list\//.test(url);
      if (!isList && /\/aweme\/create|\/aweme\/publish|\/media\/aweme/.test(url)) {
        targets.set(requestId, url);
      }
      return;
    }
    if (method === "Network.loadingFinished") {
      const requestId = String(params.requestId || "");
      if (!targets.has(requestId)) return;
      targets.delete(requestId);
      void dbg
        .sendCommand("Network.getResponseBody", { requestId })
        .then((result) => {
          const body = String((result as { body?: string })?.body || "");
          if (!body) return;
          try {
            const payload: unknown = JSON.parse(body);
            if (payload && typeof payload === "object") {
              responses.push(payload as Record<string, unknown>);
            }
          } catch {
            /* 非 JSON 响应忽略 */
          }
        })
        .catch(() => undefined);
    }
  };
  dbg.on("message", handler);
  try {
    await dbg.sendCommand("Network.enable");
  } catch {
    /* 捕获失败不影响发布，作品 ID 会走接口兜底 */
  }
  return {
    responses,
    stop: () => {
      try {
        if (dbg.isAttached()) dbg.detach();
      } catch {
        /* 已分离 */
      }
    },
  };
}

// ---------------------------------------------------------------- 用户信息

function userInfoFromPayload(payload: unknown): DouyinUserInfo {
  const record = asRecord(payload);
  const nested = asRecord(record.data);
  // 创作者中心的 user/info 有时把 user 放在根节点，有时包在 data 里。
  const base = Object.keys(nested).length ? nested : record;
  let user = asRecord(base.user);
  if (!Object.keys(user).length) user = asRecord(base.user_info ?? base.userInfo);
  if (!Object.keys(user).length) user = base;
  return {
    nickname: String(user.nickname || user.name || record.nickname || "").trim(),
    platformId: String(user.unique_id || user.uniqueId || user.short_id || "").trim(),
    userId: String(user.sec_uid || user.secUid || user.uid || "").trim(),
    avatar: firstUrl(
      user.avatar_larger ??
        user.avatarLarger ??
        user.avatar_thumb ??
        user.avatar_medium ??
        user.avatar_300x300 ??
        user.avatar_168x168 ??
        user.avatar_url ??
        user.avatarUri
    ),
  };
}

export async function readDouyinUserInfo(win: BrowserWindow): Promise<DouyinUserInfo> {
  const empty: DouyinUserInfo = { nickname: "", userId: "", platformId: "", avatar: "" };
  if (!win || win.isDestroyed()) return empty;
  try {
    const payload = await execPage<unknown>(win, USER_INFO_SCRIPT);
    return userInfoFromPayload(payload);
  } catch {
    return empty;
  }
}

// ---------------------------------------------------------------- 校验

function captionOf(payload: DouyinPublishPayload): string {
  const title = String(payload.title || "").trim();
  const desc = String(payload.desc || "").trim();
  return title && desc ? `${title}\n${desc}` : title || desc;
}

function withinDataDir(file: string): boolean {
  const base = path.resolve(DATA_DIR);
  const target = path.resolve(file);
  return target === base || target.startsWith(base + path.sep);
}

function checkMediaFile(
  raw: string,
  suffixes: Set<string>,
  maxBytes: number,
  label: string,
  problems: string[]
): void {
  const target = path.resolve(raw);
  if (!withinDataDir(target)) {
    problems.push(`抖音${label}必须位于应用数据目录内`);
    return;
  }
  const suffix = path.extname(target).toLowerCase();
  if (!suffixes.has(suffix)) {
    problems.push(`抖音不支持该${label}格式：${suffix || "未知"}`);
    return;
  }
  try {
    const stat = fs.statSync(target);
    if (!stat.isFile()) {
      problems.push(`抖音${label}文件不存在`);
      return;
    }
    if (stat.size > maxBytes) {
      problems.push(label === "视频" ? "抖音视频不能超过 4GB" : "抖音单张图片不能超过 20MB");
    }
  } catch {
    problems.push(`抖音${label}文件不存在`);
  }
}

function validatePayload(
  payload: DouyinPublishPayload
): { problems: string[]; media: PreparedMedia } {
  const problems: string[] = [];
  const title = String(payload.title || "").trim();
  const caption = captionOf(payload);
  const images = (Array.isArray(payload.images) ? payload.images : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  const video = String(payload.video || "").trim();
  const contentType = String(payload.content_type || "").trim();
  const isImage =
    contentType === "image_text" ||
    contentType === "image" ||
    (!contentType && !video && images.length > 0);

  if (!caption) problems.push("抖音文案（标题+正文）不能为空");
  if (caption.length > 1000) {
    problems.push(`抖音文案（标题+正文）最多 1000 字，当前 ${caption.length} 字`);
  }
  if (title.length > 55) {
    problems.push(`抖音标题最多 55 字，当前 ${title.length} 字`);
  }

  const files: string[] = [];
  if (isImage) {
    if (images.length < 2 || images.length > 35) {
      problems.push(`抖音图文需要 2-35 张图片，当前 ${images.length} 张`);
    }
    for (const item of images.slice(0, 35)) {
      checkMediaFile(item, IMAGE_SUFFIXES, IMAGE_MAX_BYTES, "图片", problems);
      files.push(path.resolve(item));
    }
  } else {
    const source = video || images[0] || "";
    if (!source) {
      problems.push("抖音视频发布需要 1 个视频文件");
    } else {
      checkMediaFile(source, VIDEO_SUFFIXES, VIDEO_MAX_BYTES, "视频", problems);
      files.push(path.resolve(source));
    }
  }

  const rawType = payload.type;
  if (rawType !== undefined && rawType !== null && String(rawType).trim() !== "") {
    const value = Number(rawType);
    if (!Number.isInteger(value) || !(value in VISIBILITY_LABELS)) {
      problems.push("抖音可见范围只支持公开、仅自己可见、好友可见");
    }
  }

  return { problems, media: { isImage, files } };
}

// ---------------------------------------------------------------- 登录检查

export async function checkSession(
  session: Record<string, unknown>,
  proxy = ""
): Promise<DouyinCheckResult> {
  const partition = newDouyinPartition("check");
  let win: BrowserWindow | null = null;
  try {
    const ses = await prepareDouyinSession(partition, proxy);
    await injectCookies(ses, session);
    win = createDouyinWindow(partition, false, "抖音 · 登录检查");
    try {
      await loadDouyinPage(win, CREATOR_HOME, 60_000);
    } catch (error) {
      log.warn(`抖音登录检查打开创作者中心失败: ${errorText(error)}`);
      return { ok: false, message: "抖音创作者中心打开失败，请稍后重试" };
    }
    await sleep(1000);
    if (await isLoginWall(win)) {
      return { ok: false, message: "抖音登录态已失效，请重新扫码登录" };
    }
    if (!win.webContents.getURL().includes("creator-micro")) {
      try {
        await loadDouyinPage(win, CREATOR_MICRO_HOME, 45_000);
        await sleep(1200);
      } catch {
        /* 跳转失败交给下面的登录墙判定 */
      }
    }
    if (!win.webContents.getURL().includes("creator-micro")) {
      if (await isLoginWall(win)) {
        return { ok: false, message: "抖音登录态已失效，请重新扫码登录" };
      }
      return {
        ok: false,
        message: "抖音创作者中心跳转异常，暂时无法确认登录态，请稍后重试",
      };
    }
    const info = await readDouyinUserInfo(win);
    if (!info.nickname && !info.userId) {
      return {
        ok: false,
        message: "抖音未返回账号信息，暂时无法确认登录态，请稍后重试",
      };
    }
    return {
      ok: true,
      message: "登录态正常",
      nickname: info.nickname || String(session.nickname || ""),
      red_id: info.platformId || String(session.platform_id || ""),
      user_id: info.userId || String(session.user_id || ""),
      avatar: info.avatar || String(session.avatar || ""),
    };
  } catch (error) {
    if (error instanceof DouyinFailure) {
      return { ok: false, message: error.message };
    }
    log.error(`抖音登录态检查异常: ${errorText(error)}`);
    return { ok: false, message: "抖音登录态检查失败，请稍后重试（详见日志）" };
  } finally {
    destroyWindow(win);
    await cleanupPartition(partition);
  }
}

// ---------------------------------------------------------------- 发布

export async function publish(
  session: Record<string, unknown>,
  payload: DouyinPublishPayload,
  proxy = ""
): Promise<{
  ok: boolean;
  message: string;
  result?: unknown;
  kind?: string;
  remote_note_id?: string;
}> {
  const { problems, media } = validatePayload(payload);
  if (problems.length) {
    return {
      ok: false,
      message: problems.join("；"),
      result: { stage: "validate" },
      kind: "content",
    };
  }

  const partition = newDouyinPartition("publish");
  let win: BrowserWindow | null = null;
  let capture: NetworkCapture | null = null;
  try {
    const ses = await prepareDouyinSession(partition, proxy);
    await injectCookies(ses, session);
    win = createDouyinWindow(partition, false, "抖音 · 发布");
    const dbg = attachDebugger(win);
    capture = await startNetworkCapture(dbg);

    try {
      await loadDouyinPage(win, CREATOR_UPLOAD, 60_000);
    } catch (error) {
      throw new DouyinFailure(
        "network",
        "抖音发布页打开失败，请检查网络或稍后重试",
        errorText(error)
      );
    }
    await sleep(1500);
    if (await isLoginWall(win)) {
      throw new DouyinFailure("auth", "抖音登录态已失效，请重新扫码登录");
    }
    if (!win.webContents.getURL().includes("creator-micro")) {
      throw new DouyinFailure("auth", "抖音登录态已失效，请重新扫码登录");
    }

    if (media.isImage) {
      await prepareImageText(win, dbg, media.files, payload);
    } else {
      await prepareVideo(win, dbg, media.files[0], payload);
    }
    await selectVisibility(win, payload);
    // 记录发布前的最近作品，超时兜底时只有出现新 ID 才认定成功，避免把旧作品当成本次结果。
    const baselineId = await latestAwemeId(win);
    const awemeId = await submit(win, capture.responses, baselineId);
    const contentType = media.isImage ? "image_text" : "video";
    const message = awemeId
      ? `抖音发布成功（作品 ID ${awemeId}）`
      : "抖音发布成功";
    return {
      ok: true,
      message,
      result: {
        aweme_id: awemeId,
        stage: "published",
        content_type: contentType,
        response: capture.responses.length
          ? capture.responses[capture.responses.length - 1]
          : null,
      },
      remote_note_id: awemeId || undefined,
    };
  } catch (error) {
    let failure: DouyinFailure;
    if (error instanceof DouyinFailure) {
      failure = error;
    } else {
      const raw = errorText(error);
      log.error(`抖音发布异常: ${raw}`);
      failure = new DouyinFailure(
        classifyFailure(raw),
        "抖音发布失败，请稍后重试（详见日志）"
      );
    }
    if (failure.detail) {
      log.warn(`抖音发布失败[${failure.kind}]: ${failure.message} / ${failure.detail}`);
    }
    return {
      ok: false,
      message: failure.message,
      result: { stage: "publish" },
      kind: failure.kind,
    };
  } finally {
    capture?.stop();
    destroyWindow(win);
    await cleanupPartition(partition);
  }
}

async function fillCaption(win: BrowserWindow, payload: DouyinPublishPayload): Promise<void> {
  const title = String(payload.title || "").trim();
  const desc = String(payload.desc || "").trim();
  let filled = false;
  if (title) {
    filled = Boolean(await execPage<boolean>(win, fillTitleScript(title.slice(0, 55))));
  }
  const body = filled ? desc : captionOf(payload);
  if (body) {
    const ok = await execPage<boolean>(win, fillEditorScript(body));
    filled = filled || Boolean(ok);
  }
  if (!filled) {
    throw new DouyinFailure(
      "platform",
      "抖音发布页没有找到文案输入框，平台页面可能已改版",
      "填写作品标题 / zone-container 均不存在"
    );
  }
}

async function waitUpload(win: BrowserWindow, timeoutMs = 900_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await readPageText(win);
    if (/上传失败|格式不支持|文件过大/.test(text)) {
      throw new DouyinFailure(
        "content",
        "抖音素材上传失败：文件格式或大小不符合平台要求"
      );
    }
    const uploading = text.includes("上传中") || text.includes("处理中");
    if (!uploading) {
      const ready = await execPage<boolean>(win, EDITOR_READY_SCRIPT).catch(() => false);
      if (ready) return;
    }
    await sleep(3000);
  }
  throw new DouyinFailure(
    "platform",
    "抖音素材上传超时，请检查网络或稍后重试",
    `${Math.floor(timeoutMs / 1000)} 秒内未出现文案编辑器`
  );
}

async function prepareVideo(
  win: BrowserWindow,
  dbg: CdpDebugger,
  file: string,
  payload: DouyinPublishPayload
): Promise<void> {
  const ok = await setFileInputFiles(dbg, VIDEO_INPUT_SELECTORS, [file]);
  if (!ok) {
    throw new DouyinFailure(
      "platform",
      "抖音发布页没有找到上传入口，平台页面可能已改版",
      "input[type=file] 不存在"
    );
  }
  // 抖音在上传完成后才渲染标题/正文。
  await waitUpload(win);
  await fillCaption(win, payload);
}

async function prepareImageText(
  win: BrowserWindow,
  dbg: CdpDebugger,
  files: string[],
  payload: DouyinPublishPayload
): Promise<void> {
  const tab =
    (await clickByText(win, ["发布图文"], true)) ||
    (await clickByText(win, ["图文"], true)) ||
    (await clickByText(win, ["发布图文"], false));
  if (tab) await sleep(1000);
  const ok = await setFileInputFiles(dbg, IMAGE_INPUT_SELECTORS, files);
  if (!ok) {
    throw new DouyinFailure(
      "platform",
      "抖音发布页没有找到上传入口，平台页面可能已改版",
      "input[type=file] 不存在"
    );
  }
  await waitUpload(win);
  await fillCaption(win, payload);
}

async function selectVisibility(
  win: BrowserWindow,
  payload: DouyinPublishPayload
): Promise<void> {
  const value = Number(payload.type ?? 0);
  const label = VISIBILITY_LABELS[value] || "";
  if (!value || !label) return;
  try {
    const trigger = await clickByText(win, ["谁可以看", "公开"], false);
    if (!trigger) return;
    await sleep(800);
    const option = await clickByText(win, [label], true);
    if (option) await sleep(800);
  } catch (error) {
    log.warn(`抖音可见范围设置失败，将使用平台默认值: ${errorText(error)}`);
  }
}

function findAwemeId(payload: unknown, depth = 0): string {
  if (depth > 6 || payload === null || payload === undefined) return "";
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const found = findAwemeId(item, depth + 1);
      if (found) return found;
    }
    return "";
  }
  const record = asRecord(payload);
  if (!Object.keys(record).length) return "";
  for (const key of ["aweme_id", "awemeId", "item_id", "itemId"]) {
    const value = String(record[key] ?? "");
    if (/^\d+$/.test(value)) return value;
  }
  for (const value of Object.values(record)) {
    const found = findAwemeId(value, depth + 1);
    if (found) return found;
  }
  return "";
}

async function resolveAwemeId(
  win: BrowserWindow,
  responses: Array<Record<string, unknown>>,
  baselineId: string
): Promise<string> {
  const fromResponse = findAwemeId(responses);
  if (fromResponse) return fromResponse;
  const latest = await latestAwemeId(win);
  return latest && latest !== baselineId ? latest : "";
}

async function submit(
  win: BrowserWindow,
  responses: Array<Record<string, unknown>>,
  baselineId: string
): Promise<string> {
  const clicked = await execPage<string>(win, SUBMIT_SCRIPT).catch(() => "");
  if (!clicked) {
    throw new DouyinFailure(
      "platform",
      "抖音发布页没有找到「发布」按钮，平台页面可能已改版",
      "发布按钮不存在"
    );
  }

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (win.isDestroyed()) {
      throw new DouyinFailure("network", "抖音发布页已关闭，请重试");
    }
    if (win.webContents.getURL().includes("content/manage")) {
      await sleep(800);
      return resolveAwemeId(win, responses, baselineId);
    }
    const text = await readPageText(win);
    if (/发布成功|作品已发布|已发布/.test(text)) {
      // 等接口响应体回填，再取作品 ID。
      await sleep(1000);
      return resolveAwemeId(win, responses, baselineId);
    }
    if (/发布失败|请勿重复|内容违规|审核/.test(text)) {
      let reason = await execPage<string>(win, ERROR_TIP_SCRIPT).catch(() => "");
      if (!reason) reason = text.replace(/\s+/g, " ").slice(0, 80);
      const kind: DouyinFailureKind = /违规|敏感|审核/.test(reason)
        ? "content"
        : classifyFailure(reason);
      throw new DouyinFailure(kind, `抖音发布失败：${reason || "平台未返回原因"}`);
    }
    await sleep(2000);
  }

  // 超时但接口已返回作品 ID 时按成功处理，避免重复发布。
  const awemeId = await resolveAwemeId(win, responses, baselineId);
  if (awemeId) return awemeId;
  throw new DouyinFailure(
    "network",
    "抖音发布结果未确认，请到创作者中心检查后再重试"
  );
}

async function latestAwemeId(win: BrowserWindow): Promise<string> {
  const value = await execPage<string>(win, LATEST_ID_SCRIPT).catch(() => "");
  return /^\d+$/.test(String(value || "")) ? String(value) : "";
}
