/**
 * 公众号扫码登录（Electron 版）。
 *
 * 原 Python 实现用 Playwright 起无头浏览器；Electron 本身就带 Chromium，
 * 这里直接用一个隐藏 BrowserWindow 打开公众平台：二维码从 DOM 的 data URL
 * 读取，登录态通过 partition 的 cookie jar 取回。少一个浏览器内核，也避免
 * 打包时再带一份 Chromium。
 */
import { BrowserWindow, session as electronSession } from "electron";
import { MP_HOME, now } from "../../core/config";
import { log } from "../../core/log";
import { PlatformFailure } from "./client";
import { avatarFromHtml, parseAccount, tokenFromUrl, type AccountInfo } from "./parser";

const QR_TTL = 300;
const NEEDS_ACTION_WINDOW = 120;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const QR_SCRIPT = `(() => {
  const selectors = [
    'img.login__type__container__scan__qrcode',
    '.login__type__container__scan__qrcode img',
    '#js_qrcode img',
    'img[src^="data:image"]',
  ];
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (!el) continue;
    if (el.tagName === 'IMG' && el.src) return el.src;
    if (el.tagName === 'CANVAS' && el.toDataURL) return el.toDataURL('image/png');
    const bg = getComputedStyle(el).backgroundImage || '';
    const match = bg.match(/url\\("?(data:image[^")]+)"?\\)/);
    if (match) return match[1];
  }
  return '';
})()`;

const TEXT_SCRIPT = "(document.body && document.body.innerText) || ''";
const HTML_SCRIPT = "document.documentElement.outerHTML";

export interface QrPayload {
  readonly platform: "wechat_mp";
  status: string;
  message: string;
  nickname: string;
  avatar: string;
  red_id: string;
  requires_window: boolean;
  window_open: boolean;
  notice: string;
  deadline: number;
  mode: "visible" | "headless";
  browser: Record<string, unknown>;
  qr?: string;
}

export class WechatQrSession {
  readonly id: string;
  readonly platform = "wechat_mp";
  readonly createdAt = Date.now();
  status = "starting";
  message = "正在打开微信公众平台";
  nickname = "";
  avatar = "";
  fakeid = "";
  token = "";
  qrDataUrl = "";
  accountState: Record<string, unknown> = {};
  needsActionUntil = 0;

  private win: BrowserWindow | null = null;
  private partition: string;
  private visible = false;
  private closed = false;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private homeSince = 0;
  private alreadyLoggedIn = false;
  private proxy: string;
  private notice = "";

  constructor(id: string, proxy = "") {
    this.id = id;
    this.proxy = proxy;
    this.partition = `wechat-login-${id}`;
  }

  async start(): Promise<QrPayload> {
    try {
      const ses = electronSession.fromPartition(this.partition, { cache: false });
      ses.setUserAgent(UA);
      if (this.proxy) {
        const value = this.proxy.includes("://") ? this.proxy : `http://${this.proxy}`;
        await ses.setProxy({ proxyRules: value });
      }
      this.win = new BrowserWindow({
        width: 460,
        height: 680,
        show: false,
        title: "微信公众号 · 扫码登录",
        autoHideMenuBar: true,
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
        if (!this.closed) {
          this.status = "error";
          this.message = "扫码窗口已关闭，请重新发起扫码";
        }
      });
      await this.win.loadURL(MP_HOME);
      await wait(1200);
      if (tokenFromUrl(this.win.webContents.getURL())) {
        await this.confirm();
        this.alreadyLoggedIn = true;
        this.status = "confirmed";
        this.message = `已登录：${this.nickname || "公众号"}`;
        return this.payload();
      }
      this.qrDataUrl = await this.waitQr(30_000);
      if (!this.qrDataUrl) {
        throw new PlatformFailure(
          "platform",
          "公众号登录页没有出现二维码，平台可能要求安全验证或页面已改版"
        );
      }
      this.status = "waiting";
      this.message = "请用微信扫描二维码登录公众平台";
      this.timer = setInterval(() => void this.pollOnce(), 1200);
      return this.payload();
    } catch (error) {
      this.status = "error";
      this.message =
        error instanceof PlatformFailure
          ? error.message
          : `打开发布平台失败：${error instanceof Error ? error.message : String(error)}`;
      log.error(`公众号扫码初始化失败: ${this.message}`);
      this.closeBrowser();
      return this.payload();
    }
  }

  private async waitQr(timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.win || this.win.isDestroyed()) return "";
      const src = (await this.exec(QR_SCRIPT).catch(() => "")) as string;
      if (src) {
        const dataUrl = await this.toDataUrl(src);
        if (dataUrl) return dataUrl;
      }
      await wait(700);
    }
    return "";
  }

  /**
   * 公众平台的二维码常是 `scanloginqrcode?action=getqrcode` 这样的接口地址，
   * 必须带登录分区的 Cookie 才能取到；用分区自己的 fetch 下载再转 data URL。
   */
  private async toDataUrl(src: string): Promise<string> {
    if (src.startsWith("data:")) return src;
    if (!/^https?:/i.test(src) || !this.win || this.win.isDestroyed()) return "";
    try {
      const response = await this.win.webContents.session.fetch(src, { cache: "no-store" });
      if (!response.ok) return "";
      const buffer = Buffer.from(await response.arrayBuffer());
      // 小于 500 字节多半是错误页或占位图，继续轮询等真正的二维码。
      if (buffer.length < 500) return "";
      const type = (response.headers.get("content-type") || "image/png").split(";")[0];
      return `data:${type};base64,${buffer.toString("base64")}`;
    } catch (error) {
      log.warn(`公众号二维码下载失败: ${error instanceof Error ? error.message : String(error)}`);
      return "";
    }
  }

  private async exec(script: string): Promise<unknown> {
    if (!this.win || this.win.isDestroyed()) return "";
    return this.win.webContents.executeJavaScript(script, true);
  }

  private async confirm(): Promise<void> {
    if (!this.win || this.win.isDestroyed()) return;
    const pageUrl = this.win.webContents.getURL();
    const html = String((await this.exec(HTML_SCRIPT).catch(() => "")) || "");
    const info: AccountInfo = parseAccount(html, pageUrl);
    this.nickname = info.nickname;
    this.avatar = info.avatar;
    this.fakeid = info.fakeid;
    this.token = info.token;
    /* 头像兜底：扫码落地页常不带头像字段，用拿到的 token 再访问一次后台首页补拉。 */
    if (!this.avatar && this.token && this.win && !this.win.isDestroyed()) {
      try {
        await this.win.loadURL(
          `https://mp.weixin.qq.com/cgi-bin/home?t=home/index&lang=zh_CN&token=${this.token}`
        );
        await wait(1200);
        const again = String((await this.exec(HTML_SCRIPT).catch(() => "")) || "");
        const avatar = avatarFromHtml(again);
        if (avatar) this.avatar = avatar;
      } catch {
        /* 拉不到头像不阻塞登录 */
      }
    }
    const ses = this.win.webContents.session;
    const all = await ses.cookies.get({});
    const cookies = all
      .filter((item) => /weixin|qq\.com/i.test(item.domain || ""))
      .map((item) => ({
        name: item.name,
        value: item.value,
        domain: item.domain || ".weixin.qq.com",
        path: item.path || "/",
        expires: item.expirationDate ? Math.floor(item.expirationDate) : -1,
        httpOnly: Boolean(item.httpOnly),
        secure: Boolean(item.secure),
        sameSite: item.sameSite || "Lax",
      }));
    const cookieHeader = cookies.map((item) => `${item.name}=${item.value}`).join("; ");
    this.accountState = {
      cookies,
      cookie_header: cookieHeader,
      token: this.token,
      fakeid: this.fakeid,
      ticket: info.ticket,
      user_name: info.user_name,
      svr_time: info.svr_time,
      nickname: this.nickname,
      avatar: this.avatar,
      platform_id: this.fakeid,
      user_id: this.fakeid,
      login_at: now(),
      expires_at: now() + 4 * 3600,
    };
    if (this.token) {
      this.status = "confirmed";
      this.message = `登录成功：${this.nickname || "公众号"}`;
      this.stopTimer();
      this.closeBrowser();
    } else {
      this.status = "error";
      this.message = "登录成功但没有拿到后台 token，请重试";
    }
  }

  private async pollOnce(): Promise<void> {
    if (this.polling || this.closed) return;
    if (this.status === "confirmed" || this.status === "expired" || this.status === "error") {
      this.stopTimer();
      return;
    }
    if ((Date.now() - this.createdAt) / 1000 > QR_TTL) {
      this.status = "expired";
      this.message = "二维码已过期，请重新生成";
      this.closeBrowser();
      return;
    }
    this.polling = true;
    try {
      await this.inspect();
    } catch (error) {
      this.status = "error";
      this.message = `登录状态检查失败：${error instanceof Error ? error.message : "未知错误"}`;
      this.closeBrowser();
    } finally {
      this.polling = false;
    }
  }

  private async inspect(): Promise<void> {
    if (!this.win || this.win.isDestroyed()) {
      this.status = "error";
      this.message = "扫码窗口已关闭，请重新发起扫码";
      return;
    }
    const pageUrl = this.win.webContents.getURL();
    if (tokenFromUrl(pageUrl)) {
      await this.confirm();
      return;
    }
    if (pageUrl.includes("/cgi-bin/home")) {
      const html = String((await this.exec(HTML_SCRIPT).catch(() => "")) || "");
      if (parseAccount(html, pageUrl).token) {
        await this.confirm();
        return;
      }
    }
    const body = String((await this.exec(TEXT_SCRIPT).catch(() => "")) || "");
    if (/选择公众号|请选择公众号|请选择要登录的公众号|选择账号|请选择账号/.test(body)) {
      this.handleAccountSelection();
      return;
    }
    const cookieNames = new Set(
      (await this.win.webContents.session.cookies.get({})).map((item) => item.name)
    );
    if (["slave_sid", "bizuin", "data_ticket"].some((name) => cookieNames.has(name))) {
      if (this.homeSince <= 0) this.homeSince = Date.now();
      const waited = (Date.now() - this.homeSince) / 1000;
      if (!pageUrl.includes("/cgi-bin/home")) {
        if (waited < 6) {
          this.status = "scanned";
          this.message = "已登录，正在跳转公众平台后台…";
          return;
        }
        await this.win
          .loadURL("https://mp.weixin.qq.com/cgi-bin/home?t=home/index&lang=zh_CN")
          .catch(() => undefined);
        await wait(1000);
      }
      if (waited < 30) {
        this.status = "scanned";
        this.message = "已登录，正在等待公众平台后台 token…";
        return;
      }
      this.status = "error";
      this.message = "登录成功但 30 秒内没有拿到后台 token，请重试";
      this.closeBrowser();
      return;
    }
    if (/二维码已失效|二维码已过期/.test(body)) {
      this.status = "expired";
      this.message = "二维码已失效，请重新生成";
      this.closeBrowser();
      return;
    }
    if (/扫描成功|请在手机上确认/.test(body)) {
      this.status = "scanned";
      this.message = "已扫码，请在手机上确认";
      return;
    }
    this.status = "waiting";
    this.message = "请用微信扫描二维码登录公众平台";
  }

  private handleAccountSelection(): void {
    if (!this.visible) {
      this.status = "needs_action";
      this.message =
        "检测到多个公众号，需要人工选择目标号。点击「打开验证窗口」后选完会自动继续";
      this.notice = this.message;
      this.needsActionUntil = 0;
      return;
    }
    const remaining = Math.floor(this.needsActionUntil / 1000 - Date.now() / 1000);
    if (remaining <= 0) {
      this.status = "error";
      this.message = "验证窗口等待超时，请重新扫码";
      this.closeBrowser();
      return;
    }
    this.status = "needs_action";
    this.message = `请在验证窗口中选择公众号（剩余 ${remaining} 秒）`;
    this.notice = this.message;
  }

  openWindow(): QrPayload {
    if (this.closed) throw new Error("扫码会话已结束，请重新发起扫码");
    if (!this.win || this.win.isDestroyed()) throw new Error("扫码窗口已关闭，请重新发起扫码");
    if (this.status !== "needs_action") throw new Error("当前步骤不需要人工验证窗口");
    this.visible = true;
    this.needsActionUntil = Date.now() + NEEDS_ACTION_WINDOW * 1000;
    this.win.show();
    this.win.focus();
    this.message = `验证窗口已打开，请在 ${NEEDS_ACTION_WINDOW} 秒内选择目标公众号`;
    this.notice = this.message;
    return this.payload();
  }

  payload(): QrPayload {
    const needsWindow = this.status === "needs_action" && !this.visible;
    const windowOpen = this.status === "needs_action" && this.visible;
    return {
      platform: "wechat_mp",
      status: this.status,
      message: this.message,
      nickname: this.nickname,
      avatar: this.avatar,
      red_id: this.fakeid,
      requires_window: needsWindow,
      window_open: windowOpen,
      notice: this.notice,
      deadline: windowOpen ? Math.floor(this.needsActionUntil / 1000) : 0,
      mode: this.visible ? "visible" : "headless",
      browser: { engine: "electron", headless: !this.visible },
      qr: this.qrDataUrl || undefined,
    };
  }

  accountPayload(): Record<string, unknown> {
    return { ...this.accountState };
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private closeBrowser(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopTimer();
    try {
      if (this.win && !this.win.isDestroyed()) this.win.close();
    } catch {
      /* 窗口可能已经销毁 */
    }
    this.win = null;
    electronSession.fromPartition(this.partition).clearStorageData().catch(() => undefined);
  }

  close(): void {
    this.closeBrowser();
  }
}

export class QrRegistry {
  private sessions = new Map<string, WechatQrSession>();

  async start(proxy = ""): Promise<{ session_id: string; qr: string; platform: string }> {
    this.cleanup();
    const id = `wx${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const session = new WechatQrSession(id, proxy);
    this.sessions.set(id, session);
    const payload = await session.start();
    return { session_id: id, qr: payload.qr || "", platform: "wechat_mp" };
  }

  get(id: string): WechatQrSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error("扫码会话不存在或已过期，请重新发起扫码");
    return session;
  }

  poll(id: string): QrPayload {
    const session = this.get(id);
    const payload = session.payload();
    // 每次轮询把最新二维码带上，前端第一次没拿到也能补上。
    return payload;
  }

  drop(id: string): void {
    const session = this.sessions.get(id);
    session?.close();
    this.sessions.delete(id);
  }

  private cleanup(): void {
    const deadline = Date.now() - (QR_TTL + 60) * 1000;
    for (const [id, session] of this.sessions) {
      if (session.createdAt < deadline) {
        session.close();
        this.sessions.delete(id);
      }
    }
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
