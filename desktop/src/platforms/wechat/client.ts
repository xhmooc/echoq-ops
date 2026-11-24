/**
 * 公众号后台 HTTP 客户端（Node 版）。
 *
 * 登录态与 Python 版同构：{ cookies, cookie_header, token, ticket, user_name,
 * svr_time, fakeid }。这里负责把 Cookie 带上、跟随跳转、吸收 Set-Cookie，
 * 并在平台返回登录失效/限流时给出可分类的失败原因。
 */
import { randomBytes } from "node:crypto";
import { ProxyAgent, fetch, type Dispatcher } from "undici";
import { MP_ORIGIN } from "../../core/config";

export type FailureKind = "auth" | "rate" | "content" | "platform" | "network";

export class PlatformFailure extends Error {
  constructor(
    public kind: FailureKind,
    message: string,
    public detail = ""
  ) {
    super(message);
    this.name = "PlatformFailure";
  }
}

export interface CookieItem {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string;
}

export interface WxResponse {
  status: number;
  url: string;
  text: string;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
// 平台偶发挂起时不能长期占住发布 worker；超时后按网络异常重试。
const REQUEST_TIMEOUT_MS = 120_000;

function normalizeCookies(source: unknown): CookieItem[] {
  if (!Array.isArray(source)) return [];
  const result: CookieItem[] = [];
  for (const item of source) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const name = String(record.name || "");
    if (!name) continue;
    result.push({
      name,
      value: String(record.value || ""),
      domain: String(record.domain || ".weixin.qq.com"),
      path: String(record.path || "/"),
      expires: Number(record.expires ?? record.expirationDate ?? -1),
      httpOnly: Boolean(record.httpOnly),
      secure: Boolean(record.secure),
      sameSite: String(record.sameSite || "Lax"),
    });
  }
  return result;
}

function parseSetCookie(header: string, fallbackDomain: string): CookieItem | null {
  const parts = header.split(";");
  const pair = parts.shift() || "";
  const index = pair.indexOf("=");
  if (index <= 0) return null;
  const item: CookieItem = {
    name: pair.slice(0, index).trim(),
    value: pair.slice(index + 1).trim(),
    domain: fallbackDomain,
    path: "/",
    expires: -1,
    httpOnly: false,
    secure: false,
    sameSite: "Lax",
  };
  for (const raw of parts) {
    const [key, ...rest] = raw.trim().split("=");
    const value = rest.join("=");
    const name = key.toLowerCase();
    if (name === "domain" && value) item.domain = value;
    else if (name === "path" && value) item.path = value;
    else if (name === "expires" && value) {
      const time = Date.parse(value);
      if (!Number.isNaN(time)) item.expires = Math.floor(time / 1000);
    } else if (name === "max-age" && value) {
      const seconds = Number.parseInt(value, 10);
      if (Number.isFinite(seconds)) item.expires = Math.floor(Date.now() / 1000) + seconds;
    } else if (name === "httponly") item.httpOnly = true;
    else if (name === "secure") item.secure = true;
    else if (name === "samesite" && value) item.sameSite = value;
  }
  return item;
}

export class WeChatClient {
  token: string;
  sessionData: Record<string, unknown>;
  private cookies: CookieItem[];
  private dispatcher: Dispatcher | null = null;

  constructor(session: Record<string, unknown>, proxy = "") {
    this.sessionData = { ...session };
    this.token = String(session.token || "");
    this.cookies = normalizeCookies(session.cookies);
    if (!this.cookies.length && session.cookie_header) {
      for (const pair of String(session.cookie_header).split(";")) {
        const index = pair.indexOf("=");
        if (index <= 0) continue;
        this.cookies.push({
          name: pair.slice(0, index).trim(),
          value: pair.slice(index + 1).trim(),
          domain: ".weixin.qq.com",
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: false,
          sameSite: "Lax",
        });
      }
    }
    if (proxy) {
      const value = proxy.includes("://") ? proxy : `http://${proxy}`;
      this.dispatcher = new ProxyAgent(value);
    }
  }

  cookieHeader(): string {
    return this.cookies.map((item) => `${item.name}=${item.value}`).join("; ");
  }

  cookiesSnapshot(): CookieItem[] {
    return this.cookies.map((item) => ({ ...item }));
  }

  private absorb(response: Awaited<ReturnType<typeof fetch>>, requestUrl: string): void {
    let list: string[] = [];
    try {
      list = (response.headers as unknown as { getSetCookie(): string[] }).getSetCookie();
    } catch {
      list = [];
    }
    let host = ".weixin.qq.com";
    try {
      host = new URL(requestUrl).hostname;
    } catch {
      /* 保持默认 */
    }
    for (const header of list || []) {
      const cookie = parseSetCookie(header, host.startsWith(".") ? host : `.${host}`);
      if (!cookie) continue;
      const index = this.cookies.findIndex((item) => item.name === cookie.name);
      if (index >= 0) this.cookies[index] = cookie;
      else this.cookies.push(cookie);
    }
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    options: { params?: Record<string, string>; body?: Buffer; contentType?: string } = {}
  ): Promise<WxResponse> {
    let url = path.startsWith("http") ? path : MP_ORIGIN + path;
    if (options.params && Object.keys(options.params).length) {
      const search = new URLSearchParams(options.params).toString();
      url += (url.includes("?") ? "&" : "?") + search;
    }
    let body = options.body;
    let currentMethod = method;
    for (let hop = 0; hop < 6; hop += 1) {
      let response: Awaited<ReturnType<typeof fetch>>;
      try {
        response = await fetch(url, {
          method: currentMethod,
          headers: {
            "User-Agent": UA,
            Referer: `${MP_ORIGIN}/`,
            Accept: "*/*",
            "Accept-Language": "zh-CN,zh;q=0.9",
            "X-Requested-With": "XMLHttpRequest",
            Cookie: this.cookieHeader(),
            ...(options.contentType ? { "Content-Type": options.contentType } : {}),
          },
          body: body ? new Uint8Array(body) : undefined,
          redirect: "manual",
          dispatcher: this.dispatcher ?? undefined,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        throw new PlatformFailure(
          "network",
          "公众号请求网络异常，请检查网络或代理",
          error instanceof Error ? error.message : String(error)
        );
      }
      this.absorb(response, url);
      const location = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && location) {
        url = new URL(location, url).toString();
        if (response.status === 303 || (response.status < 303 && currentMethod === "POST")) {
          currentMethod = "GET";
          body = undefined;
        }
        continue;
      }
      const text = await response.text();
      return { status: response.status, url, text };
    }
    throw new PlatformFailure("network", "公众号请求跳转次数过多，请稍后重试");
  }

  get(path: string, params?: Record<string, string>): Promise<WxResponse> {
    return this.request("GET", path, { params });
  }

  postForm(path: string, params: Record<string, string>, data: Record<string, string>): Promise<WxResponse> {
    return this.request("POST", path, {
      params,
      body: Buffer.from(new URLSearchParams(data).toString(), "utf8"),
      contentType: "application/x-www-form-urlencoded; charset=UTF-8",
    });
  }

  postFile(
    path: string,
    params: Record<string, string>,
    field: string,
    filename: string,
    mime: string,
    data: Buffer
  ): Promise<WxResponse> {
    const boundary = `----EchoQ${randomBytes(8).toString("hex")}`;
    const head = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
        `Content-Type: ${mime}\r\n\r\n`,
      "utf8"
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
    return this.request("POST", path, {
      params,
      body: Buffer.concat([head, data, tail]),
      contentType: `multipart/form-data; boundary=${boundary}`,
    });
  }

  close(): void {
    this.dispatcher?.close().catch(() => undefined);
  }
}

/** 统一处理「登录失效 / 限流 / 内容被拒」，与 Python 版分类保持一致。 */
export function responseJson(response: WxResponse, stage: string): Record<string, unknown> {
  if (response.url.includes("login") || response.text.slice(0, 800).includes("请登录")) {
    throw new PlatformFailure("auth", "公众号登录态已失效，请重新扫码登录");
  }
  let payload: unknown = null;
  try {
    payload = JSON.parse(response.text);
  } catch {
    payload = null;
  }
  if (!payload || typeof payload !== "object") {
    const text = response.text.slice(0, 800);
    if (/请输入验证码|安全验证|频繁/.test(text)) {
      throw new PlatformFailure("rate", "公众号要求安全验证或操作过于频繁，请稍后再试");
    }
    throw new PlatformFailure(
      "platform",
      "公众号后台返回了非 JSON 内容，接口可能已改版",
      `${stage} HTTP ${response.status}`
    );
  }
  const record = payload as Record<string, unknown>;
  const base = (record.base_resp || {}) as Record<string, unknown>;
  const ret = Number(base.ret || 0);
  if (ret !== 0) {
    const errmsg = String(base.err_msg || record.errmsg || "").trim();
    if ([200013, 45009].includes(ret) || /频繁|频率|次数/.test(errmsg)) {
      throw new PlatformFailure("rate", `公众号操作受限：${errmsg || "请稍后再试"}`);
    }
    if ([-6, 200003, 40001].includes(ret) || /登录|invalid session/.test(errmsg)) {
      throw new PlatformFailure("auth", "公众号登录态已失效，请重新扫码登录");
    }
    if (/违规|敏感|内容/.test(errmsg)) {
      throw new PlatformFailure("content", `公众号拒绝了内容：${errmsg}`);
    }
    throw new PlatformFailure(
      "platform",
      `公众号接口返回错误：${errmsg || ret}`,
      `${ret} ${errmsg}`
    );
  }
  return record;
}
