/**
 * 小红书扫码登录（Electron 版）。
 *
 * 打开 www.xiaohongshu.com/login，优先从页面 DOM 取二维码原图，取不到时截取
 * 二维码区域或整页；扫码确认后读取 web_session Cookie 与首页用户信息，返回
 * 昵称、小红书号、头像。整体结构与公众号 / 抖音扫码会话保持一致。
 */
import { randomBytes } from "node:crypto";
import { BrowserWindow, session as electronSession } from "electron";
import { log } from "../../core/log";
import { parseCookie } from "./session";
import { pcUserMe } from "./api";

const LOGIN_URL = "https://www.xiaohongshu.com/login";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const QR_TTL_MS = 300 * 1000;

type SessionStatus = "starting" | "waiting" | "confirmed" | "expired" | "error";

export interface XhsQrProfile {
  nickname?: string;
  red_id?: string;
  user_id?: string;
  avatar?: string;
}

const QR_SCRIPT = `(async () => {
  const looksLikeQr = (url) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        if (img.naturalWidth < 120 || img.naturalHeight < 120) return resolve(false);
        if (Math.abs(img.naturalWidth - img.naturalHeight) > 8) return resolve(false);
        const size = 160;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, size, size);
        const data = ctx.getImageData(0, 0, size, size).data;
        let dark = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] < 110 && data[i + 1] < 110 && data[i + 2] < 110) dark += 1;
        }
        resolve(dark / (size * size) > 0.18 && dark / (size * size) < 0.75);
      } catch (error) {
        resolve(false);
      }
    };
    img.onerror = () => resolve(false);
    img.src = url;
  });
  const candidates = [];
  const selectors = [
    'img.qrcode-img', 'div.qrcode img', 'div[class*="qrcode"] img',
    'img[src^="data:image"]'
  ];
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (!el) continue;
    if (el.tagName === 'IMG' && el.src) candidates.push(el.src);
    const background = getComputedStyle(el).backgroundImage || '';
    const match = /url\\(["']?(data:image[^"')]+)/.exec(background);
    if (match) candidates.push(match[1]);
  }
  for (const canvas of Array.from(document.querySelectorAll('canvas'))) {
    if (canvas.width < 120 || Math.abs(canvas.width - canvas.height) > 8) continue;
    try {
      candidates.push(canvas.toDataURL('image/png'));
    } catch (error) {
      /* 跨域画布读不到，继续找 */
    }
  }
  for (const url of candidates) {
    if (await looksLikeQr(url)) return url;
  }
  return '';
})()`;

const PROFILE_SCRIPT = `(() => {
  const state = window.__INITIAL_STATE__ || {};
  const user = (state.user && (state.user.userInfo || state.user.loginUser || state.user)) || {};
  const pick = (...keys) => {
    for (const key of keys) {
      const value = user[key];
      if (typeof value === 'string' && value) return value;
    }
    return '';
  };
  return {
    nickname: pick('nickname', 'nickName', 'name'),
    red_id: pick('redId', 'red_id'),
    user_id: pick('userId', 'user_id', 'id'),
    avatar: pick('image', 'avatar', 'headImg', 'head_img')
  };
})()`;

function sessionId(): string {
  return `xhs${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
}

function extractWebSession(cookie: string): string {
  const match = /(?:^|;\s*)web_session=([^;]*)/.exec(cookie || "");
  return match ? match[1] : "";
}

async function cookieHeader(win: BrowserWindow): Promise<string> {
  if (!win || win.isDestroyed()) return "";
  const cookies = await win.webContents.session.cookies.get({});
  return cookies
    .filter((item) => /xiaohongshu\.com$/i.test(String(item.domain || "").replace(/^\./, "")))
    .map((item) => `${item.name}=${item.value}`)
    .join("; ");
}

export class XhsQrSession {
  readonly id: string;
  readonly createdAt = Date.now();
  private readonly partition: string;
  private readonly proxy: string;
  private win: BrowserWindow | null = null;
  private status: SessionStatus = "starting";
  private message = "正在准备扫码环境";
  private qr = "";
  private profile: XhsQrProfile = {};
  private cookie = "";
  private closed = false;
  /** 打开登录页时小红书会下发游客 web_session，必须和它区分开才触发确认。 */
  private initialSession = "";
  private lastTriedSession = "";
  private verifyTries = 0;
  private windowShown = false;

  constructor(id: string, proxy = "") {
    this.id = id;
    this.proxy = proxy;
    this.partition = `xhs-login-${id}`;
  }

  async start(): Promise<Record<string, unknown>> {
    try {
      const ses = electronSession.fromPartition(this.partition, { cache: false });
      ses.setUserAgent(UA);
      if (this.proxy) {
        const value = this.proxy.includes("://") ? this.proxy : `http://${this.proxy}`;
        await ses.setProxy({ proxyRules: value });
      }
      this.win = new BrowserWindow({
        width: 520,
        height: 720,
        show: false,
        title: "小红书 · 扫码登录",
        autoHideMenuBar: true,
        backgroundColor: "#ffffff",
        webPreferences: {
          partition: this.partition,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      });
      this.win.removeMenu();
      this.win.on("closed", () => {
        this.win = null;
        if (!this.closed && this.status !== "confirmed") {
          this.status = "error";
          this.message = "扫码窗口已关闭，请重新发起扫码";
        }
      });
      await this.win.loadURL(LOGIN_URL);
      this.initialSession = extractWebSession(await cookieHeader(this.win));
      this.status = "waiting";
      this.message = "请用小红书 App 扫码登录";
      // 登录页原生二维码约 1~3 秒渲染完成，等拿到有效二维码再返回，
      // 避免前端先显示占位图/图标，之后又不会刷新图片。
      await this.waitQr(15_000);
      void this.pollLoop();
      return this.payload();
    } catch (error) {
      this.status = "error";
      this.message = `打开小红书登录页失败：${error instanceof Error ? error.message : String(error)}`;
      log.error(`小红书扫码启动失败: ${this.message}`);
      return this.payload();
    }
  }

  payload(): Record<string, unknown> {
    return {
      status: this.status,
      message: this.message,
      qr: this.qr,
      session_id: this.id,
      platform: "xiaohongshu",
      deadline: Math.trunc((this.createdAt + QR_TTL_MS) / 1000),
      requires_window: this.status === "waiting" && !this.qr,
      window_open: Boolean(this.windowShown && this.win && !this.win.isDestroyed()),
      ...this.profile,
    };
  }

  accountPayload(): Record<string, unknown> {
    return {
      cookie_header: this.cookie,
      user_agent: UA,
      ...this.profile,
    };
  }

  openWindow(): Record<string, unknown> {
    if (!this.win || this.win.isDestroyed()) {
      return { ok: false, message: "扫码窗口已关闭，请重新生成二维码" };
    }
    this.win.show();
    this.win.focus();
    this.windowShown = true;
    return { ok: true, message: "已打开扫码窗口" };
  }

  close(): void {
    this.closed = true;
    if (this.win && !this.win.isDestroyed()) {
      try {
        this.win.destroy();
      } catch {
        /* 已销毁时忽略 */
      }
    }
    this.win = null;
  }

  /** 等到页面渲染出真实二维码再返回；只认 DOM 原图，不截整页/图标。 */
  private async waitQr(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !this.closed) {
      if (await this.captureQr()) return;
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    log.warn("小红书登录页未截取到二维码，改为让用户直接扫登录窗口");
  }

  /** 从 DOM 读取经过二维码特征校验的原图，返回是否取到。 */
  private async captureQr(): Promise<boolean> {
    if (!this.win || this.win.isDestroyed()) return false;
    try {
      const data = await this.win.webContents.executeJavaScript(QR_SCRIPT, true);
      if (typeof data === "string" && data.startsWith("data:image")) {
        this.qr = data;
        return true;
      }
    } catch (error) {
      log.warn(`小红书二维码读取失败: ${String(error)}`);
    }
    return false;
  }

  private async pollLoop(): Promise<void> {
    while (!this.closed && Date.now() - this.createdAt < QR_TTL_MS) {
      if (this.status === "confirmed" || this.status === "error") return;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (this.closed || !this.win || this.win.isDestroyed()) return;
      try {
        const cookie = await cookieHeader(this.win);
        const current = extractWebSession(cookie);
        if (current && current !== this.initialSession) {
          if (current !== this.lastTriedSession) {
            this.lastTriedSession = current;
            this.verifyTries = 0;
          }
          // 游客会话也可能轮换，校验不通过就静默重试，不能写成“已扫码”。
          if (this.verifyTries < 8) {
            this.verifyTries += 1;
            const profile = await this.verifyLogin(cookie);
            if (profile) {
              this.cookie = cookie;
              this.profile = profile;
              this.status = "confirmed";
              this.message = "扫码成功";
              return;
            }
          }
        }
        const url = this.win.webContents.getURL();
        if (!this.qr || /login\/?$/.test(url)) {
          await this.captureQr();
        }
      } catch (error) {
        log.warn(`小红书扫码轮询失败: ${String(error)}`);
      }
    }
    if (!this.closed && this.status !== "confirmed") {
      this.status = "expired";
      this.message = "二维码已过期，请重新生成";
    }
  }

  /** 只有接口确认不是游客、且拿到用户信息，才算真正登录成功。 */
  private async verifyLogin(cookie: string): Promise<XhsQrProfile | null> {
    try {
      const result = await pcUserMe(parseCookie(cookie), this.proxy);
      const payload = (result.payload || {}) as { data?: Record<string, unknown> };
      const data = payload.data || {};
      if (!result.success || data.guest || !(data.user_id || data.red_id)) return null;
      const profile: XhsQrProfile = {
        nickname: String(data.nickname || ""),
        red_id: String(data.red_id || ""),
        user_id: String(data.user_id || ""),
        avatar: String(
          data.avatar || data.image || data.images || data.imageb || data.head_img || ""
        ),
      };
      if (!profile.nickname && this.win && !this.win.isDestroyed()) {
        const pageProfile = (await this.win.webContents.executeJavaScript(
          PROFILE_SCRIPT,
          true
        )) as XhsQrProfile;
        profile.nickname = pageProfile?.nickname || "";
        profile.avatar = profile.avatar || pageProfile?.avatar || "";
      }
      return profile;
    } catch (error) {
      log.warn(`小红书扫码确认校验失败: ${String(error)}`);
      return null;
    }
  }
}

export class XhsQrRegistry {
  private sessions = new Map<string, XhsQrSession>();

  async start(proxy = ""): Promise<Record<string, unknown>> {
    const session = new XhsQrSession(sessionId(), proxy);
    this.sessions.set(session.id, session);
    const payload = await session.start();
    return payload;
  }

  get(id: string): XhsQrSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error("扫码会话不存在或已过期，请重新生成二维码");
    return session;
  }

  poll(id: string): Record<string, unknown> {
    return this.get(id).payload();
  }

  drop(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.close();
    this.sessions.delete(id);
  }
}
