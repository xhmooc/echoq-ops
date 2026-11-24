/**
 * 抖音扫码登录（Electron 版）。
 *
 * 与公众号扫码同构：用隐藏的 BrowserWindow + 独立 session partition 打开
 * creator.douyin.com，二维码优先从页面 DOM 的 data URL 读取，读不到时用
 * capturePage 截二维码区域或整页。扫码完成后页面进入 creator-micro，再调用
 * 创作者账号接口读取昵称 / 抖音号 / 头像，并把 partition 里的 Cookie 交回。
 */
import type { BrowserWindow } from "electron";
import {
  CREATOR_HOME,
  CREATOR_MICRO_HOME,
  DOUYIN_AUTH_COOKIES,
  DOUYIN_UA,
  DouyinFailure,
  createDouyinWindow,
  destroyWindow,
  execPage,
  loadDouyinPage,
  prepareDouyinSession,
  readDouyinUserInfo,
  readPageText,
  sessionCookieHeader,
  sleep,
  type DouyinElectronSession,
  type DouyinUserInfo,
} from "./adapter";

const QR_TTL_MS = 300 * 1000;
const NEEDS_ACTION_MS = 180 * 1000;

const QR_SCRIPT = `(() => {
  const selectors = [
    'div#animate_qrcode_container img[src^="data:image"]',
    'div[class*="animate_qrcode_container"] img[src^="data:image"]',
    'div[class*="scan_qrcode_login_content"] img[src^="data:image"]',
    'img[aria-label="二维码"]'
  ];
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (!el) continue;
    if (el.tagName === 'IMG' && el.src) return el.src;
    if (el.tagName === 'CANVAS' && el.toDataURL) return el.toDataURL('image/png');
    const background = getComputedStyle(el).backgroundImage || '';
    if (background.includes('data:image')) {
      const match = /url\\(["']?(data:image[^"')]+)/.exec(background);
      if (match) return match[1];
    }
  }
  const canvases = Array.from(document.querySelectorAll('canvas'));
  for (const canvas of canvases) {
    if (canvas.width < 80 || canvas.height < 80) continue;
    try {
      return canvas.toDataURL('image/png');
    } catch (error) {
      /* 跨域画布读不到，继续找 */
    }
  }
  return '';
})()`;

const QR_RECT_SCRIPT = `(() => {
  const selectors = [
    'div#animate_qrcode_container',
    'div[class*="animate_qrcode_container"]',
    'div[class*="scan_qrcode_login_content"]',
    'div[class*="qrcode"]'
  ];
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width >= 80 && rect.height >= 80) {
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }
  }
  return null;
})()`;

const LOGIN_TAB_SCRIPT = `(() => {
  const texts = ['扫码登录', '二维码登录'];
  const nodes = Array.from(document.querySelectorAll('div, span, button, a'));
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  };
  for (const el of nodes) {
    const text = (el.innerText || '').trim();
    if (!texts.includes(text)) continue;
    if (!visible(el)) continue;
    el.click();
    return true;
  }
  return false;
})()`;

export interface DouyinQrPayload extends Record<string, unknown> {
  platform: "douyin";
  sid: string;
  status: string;
  message: string;
  nickname: string;
  red_id: string;
  user_id: string;
  avatar: string;
  requires_window: boolean;
  window_open: boolean;
  notice: string;
  deadline: number;
  mode: "visible" | "headless";
  headless: boolean;
  qr_image?: string;
  qr?: string;
}

interface QrRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export class DouyinQrSession {
  readonly id: string;
  readonly platform = "douyin";
  readonly createdAt = Date.now();

  status: "starting" | "waiting" | "confirmed" | "expired" | "failed" = "starting";
  message = "正在打开抖音创作者中心";
  nickname = "";
  platformId = "";
  userId = "";
  avatar = "";
  cookieHeader = "";

  private qrImage = "";
  private notice = "";
  private visible = false;
  private closed = false;
  private needsAction = false;
  private needsActionUntil = 0;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private creatorSince = 0;
  private lastNavigateAt = 0;
  private win: BrowserWindow | null = null;
  private ses: DouyinElectronSession | null = null;
  private readonly partition: string;
  private readonly proxy: string;

  constructor(proxy = "") {
    this.id = `dy${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    this.partition = `douyin-login-${this.id}`;
    this.proxy = proxy;
  }

  async start(): Promise<Record<string, unknown>> {
    try {
      this.ses = await prepareDouyinSession(this.partition, this.proxy);
      this.win = createDouyinWindow(this.partition, false, "抖音 · 扫码登录");
      this.win.on("closed", this.onWindowClosed);
      await loadDouyinPage(this.win, CREATOR_HOME, 60_000);
      await sleep(1200);

      if (this.win.webContents.getURL().includes("creator-micro")) {
        const info = await readDouyinUserInfo(this.win);
        if (info.nickname || info.userId) {
          await this.complete(info);
          return this.payload();
        }
      }

      await execPage<boolean>(this.win, LOGIN_TAB_SCRIPT).catch(() => false);
      await sleep(800);

      const qr = await this.waitQr(30_000);
      if (!qr) {
        // 截不到二维码时不直接失败：保留窗口，让用户点「打开登录窗口」手动扫码。
        this.status = "waiting";
        this.message = "未能自动截取抖音二维码，请点击「打开登录窗口」用抖音 App 扫码登录";
        this.notice = this.message;
        this.needsAction = true;
        this.startTimer();
        return this.payload();
      }
      this.qrImage = qr;
      this.status = "waiting";
      this.message = "请用抖音 App 扫码登录";
      this.startTimer();
      return this.payload();
    } catch (error) {
      this.status = "failed";
      this.message =
        error instanceof DouyinFailure
          ? error.message
          : `打开抖音登录页失败：${error instanceof Error ? error.message : String(error)}`;
      this.notice = this.message;
      this.qrImage = "";
      this.stopTimer();
      this.closeBrowser();
      return this.payload();
    }
  }

  /** 同步返回当前状态；页面检查由 start 内部的定时器完成，轮询幂等。 */
  poll(): Record<string, unknown> {
    return this.payload();
  }

  openWindow(): Record<string, unknown> {
    if (this.closed || !this.win || this.win.isDestroyed()) {
      throw new Error("扫码窗口已关闭，请重新发起扫码");
    }
    if (this.status === "confirmed") {
      throw new Error("扫码登录已完成，无需再打开窗口");
    }
    this.visible = true;
    this.needsAction = false;
    this.needsActionUntil = Date.now() + NEEDS_ACTION_MS;
    this.win.show();
    this.win.focus();
    this.message = "已打开抖音登录窗口，请在 3 分钟内完成扫码或安全验证";
    this.notice = this.message;
    return this.payload();
  }

  accountPayload(): {
    cookie_header: string;
    user_agent?: string;
    nickname?: string;
    red_id?: string;
    user_id?: string;
    avatar?: string;
  } {
    return {
      cookie_header: this.cookieHeader,
      user_agent: DOUYIN_UA,
      nickname: this.nickname,
      red_id: this.platformId,
      user_id: this.userId,
      avatar: this.avatar,
    };
  }

  close(): void {
    this.closeBrowser();
  }

  // ------------------------------------------------------------ 内部

  private readonly onWindowClosed = (): void => {
    this.win = null;
    if (!this.closed) {
      this.closed = true;
      this.status = "failed";
      this.message = "扫码窗口已关闭，请重新发起扫码";
      this.notice = this.message;
      this.stopTimer();
      if (this.ses) void this.ses.clearStorageData().catch(() => undefined);
    }
  };

  private startTimer(): void {
    this.stopTimer();
    this.timer = setInterval(() => void this.pollOnce(), 1200);
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async pollOnce(): Promise<void> {
    if (this.polling || this.closed) return;
    if (this.status === "confirmed" || this.status === "expired" || this.status === "failed") {
      this.stopTimer();
      return;
    }
    if (Date.now() - this.createdAt > QR_TTL_MS) {
      this.status = "failed";
      this.message = "二维码已过期，请重新生成";
      this.notice = this.message;
      this.closeBrowser();
      return;
    }
    this.polling = true;
    try {
      await this.inspect();
    } catch (error) {
      this.status = "failed";
      this.message = `登录状态检查失败：${
        error instanceof Error ? error.message : String(error)
      }`;
      this.notice = this.message;
      this.closeBrowser();
    } finally {
      this.polling = false;
    }
  }

  private async inspect(): Promise<void> {
    const win = this.win;
    if (!win || win.isDestroyed()) {
      this.status = "failed";
      this.message = "扫码窗口已关闭，请重新发起扫码";
      this.notice = this.message;
      this.stopTimer();
      return;
    }
    const url = win.webContents.getURL();
    const text = await readPageText(win);

    if (/二维码已失效|二维码已过期/.test(text)) {
      this.status = "expired";
      this.message = "二维码已失效，请重新生成";
      this.notice = this.message;
      this.closeBrowser();
      return;
    }

    if (/login|passport/i.test(url)) {
      this.status = "waiting";
      this.message = "请用抖音 App 扫码登录";
      this.needsAction = false;
      return;
    }

    if (url.includes("creator-micro")) {
      const info = await readDouyinUserInfo(win);
      if (info.nickname || info.userId) {
        await this.complete(info);
        return;
      }
      if (!this.creatorSince) this.creatorSince = Date.now();
      if (Date.now() - this.creatorSince > 30_000) {
        this.status = "failed";
        this.message = "已进入创作者中心但没有读到账号信息，请重新扫码";
        this.notice = this.message;
        this.closeBrowser();
        return;
      }
      this.status = "waiting";
      this.message = "已登录，正在读取账号信息…";
      return;
    }
    this.creatorSince = 0;

    const cookies = await win.webContents.session.cookies.get({}).catch(() => []);
    const hasAuth = cookies.some((item) => DOUYIN_AUTH_COOKIES.has(String(item.name || "")));
    if (hasAuth && Date.now() - this.lastNavigateAt > 15_000) {
      this.lastNavigateAt = Date.now();
      await loadDouyinPage(win, CREATOR_MICRO_HOME, 45_000).catch(() => undefined);
      await sleep(1200);
      this.status = "waiting";
      this.message = "已登录，正在跳转创作者中心…";
      return;
    }

    const verify = ["安全验证", "短信验证", "身份验证", "请完成验证"].find((word) =>
      text.includes(word)
    );
    if (verify) {
      this.needsAction = true;
      this.status = "waiting";
      this.message = this.visible
        ? `请在登录窗口中完成${verify}，完成后会自动继续`
        : `抖音要求完成${verify}，需要人工操作。点击「打开登录窗口」完成验证`;
      this.notice = this.message;
      return;
    }

    this.needsAction = false;
    if (/扫描成功|请在手机上确认/.test(text)) {
      this.status = "waiting";
      this.message = "已扫码，请在手机上确认";
      return;
    }

    this.status = "waiting";
    this.message = "请用抖音 App 扫码登录";
  }

  private async complete(info: DouyinUserInfo): Promise<void> {
    const win = this.win;
    if (!win || win.isDestroyed()) {
      throw new DouyinFailure("network", "扫码窗口已关闭，请重新发起扫码");
    }
    const header = await sessionCookieHeader(win.webContents.session);
    if (!header) {
      throw new DouyinFailure("auth", "登录成功但没有读取到抖音 Cookie，请重新扫码");
    }
    this.nickname = info.nickname;
    this.platformId = info.platformId;
    this.userId = info.userId || info.platformId;
    this.avatar = info.avatar;
    this.cookieHeader = header;
    this.status = "confirmed";
    this.message = `登录成功：${info.nickname || "抖音账号"}`;
    this.notice = "";
    this.stopTimer();
    this.closeBrowser();
  }

  private async waitQr(timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;
    while (Date.now() < deadline) {
      const qr = await this.grabQr(false);
      if (qr) return qr;
      attempt += 1;
      if (attempt % 4 === 0) {
        const shot = await this.grabQr(true);
        if (shot) return shot;
      }
      await sleep(700);
    }
    return this.grabQr(true);
  }

  /** 先读 DOM 里的二维码原图；取不到时截二维码区域，最后退化为整页截图。 */
  private async grabQr(fullFallback: boolean): Promise<string> {
    const win = this.win;
    if (!win || win.isDestroyed()) return "";
    const src = await execPage<string>(win, QR_SCRIPT).catch(() => "");
    if (typeof src === "string" && src) {
      const dataUrl = await this.toDataUrl(src);
      if (dataUrl) return dataUrl;
    }
    const rect = await execPage<QrRect | null>(win, QR_RECT_SCRIPT).catch(() => null);
    if (rect && rect.width >= 80 && rect.height >= 80) {
      try {
        const padding = 8;
        const x = Math.max(0, Math.round(rect.x - padding));
        const y = Math.max(0, Math.round(rect.y - padding));
        const image = await win.webContents.capturePage({
          x,
          y,
          width: Math.round(rect.width + padding * 2),
          height: Math.round(rect.height + padding * 2),
        });
        if (!image.isEmpty()) return image.toDataURL();
      } catch {
        /* 截图失败继续尝试其它方式 */
      }
    }
    if (fullFallback) {
      try {
        const image = await win.webContents.capturePage();
        if (!image.isEmpty()) return image.toDataURL();
      } catch {
        /* 页面可能已经关闭 */
      }
    }
    return "";
  }

  /**
   * 二维码有时是 `data:image`，有时是接口地址；后者必须带登录分区的 Cookie
   * 才能取到，用分区自己的 fetch 下载再转 data URL。
   */
  private async toDataUrl(src: string): Promise<string> {
    if (src.startsWith("data:")) return src;
    if (!/^https?:/i.test(src) || !this.win || this.win.isDestroyed()) return "";
    try {
      const response = await this.win.webContents.session.fetch(src, { cache: "no-store" });
      if (!response.ok) return "";
      const buffer = Buffer.from(await response.arrayBuffer());
      // 太小多半是错误页或占位图，继续轮询等真正的二维码。
      if (buffer.length < 500) return "";
      const type = (response.headers.get("content-type") || "image/png").split(";")[0];
      return `data:${type};base64,${buffer.toString("base64")}`;
    } catch {
      return "";
    }
  }

  payload(): DouyinQrPayload {
    const needsWindow = this.needsAction && !this.visible;
    const windowOpen = Boolean(this.visible && this.win && !this.win.isDestroyed());
    const qrImage = this.qrImage || undefined;
    return {
      platform: "douyin",
      sid: this.id,
      session_id: this.id,
      status: this.status === "starting" ? "waiting" : this.status,
      message: this.message,
      nickname: this.nickname,
      red_id: this.platformId,
      user_id: this.userId,
      avatar: this.avatar,
      requires_window: needsWindow,
      window_open: windowOpen,
      notice: this.notice,
      deadline: windowOpen && this.needsActionUntil ? Math.floor(this.needsActionUntil / 1000) : 0,
      mode: this.visible ? "visible" : "headless",
      headless: !this.visible,
      browser: { engine: "electron", headless: !this.visible },
      qr_image: qrImage,
      qr: qrImage,
    };
  }

  private closeBrowser(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopTimer();
    destroyWindow(this.win);
    this.win = null;
    if (this.ses) {
      void this.ses.clearStorageData().catch(() => undefined);
    }
  }
}

export class DouyinQrRegistry {
  private sessions = new Map<string, DouyinQrSession>();

  async start(
    proxy = ""
  ): Promise<{ session_id: string; qr: string; platform: string }> {
    this.cleanup();
    const session = new DouyinQrSession(proxy);
    this.sessions.set(session.id, session);
    const payload = await session.start();
    const qr = String(payload.qr_image || payload.qr || "");
    return { session_id: session.id, qr, platform: "douyin" };
  }

  get(id: string): DouyinQrSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error("扫码会话不存在或已过期，请重新发起扫码");
    return session;
  }

  poll(id: string): Record<string, unknown> {
    return this.get(id).poll();
  }

  drop(id: string): void {
    const session = this.sessions.get(id);
    session?.close();
    this.sessions.delete(id);
  }

  private cleanup(): void {
    const deadline = Date.now() - (QR_TTL_MS + 60_000);
    for (const [id, session] of this.sessions) {
      if (session.createdAt < deadline) {
        session.close();
        this.sessions.delete(id);
      }
    }
  }
}
