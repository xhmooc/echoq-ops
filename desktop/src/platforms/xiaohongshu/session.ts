/**
 * 小红书登录态与 Cookie 处理。
 *
 * 账号的 cookie_enc 由 Python 版写入：小红书是 {"cookie": "完整 Cookie"}，
 * 旧格式也可能是裸 Cookie 字符串。这里只做解析、补全与回写，不改动
 * 账号表以外的结构。
 */
import { randomUUID } from "node:crypto";
import type { AccountRow } from "../../core/accounts";
import { decryptSession, saveSession } from "../../core/accounts";

export type CookieMap = Record<string, string>;

/** Python 版 Creator 视图会保留的登录 Cookie 白名单。 */
const CREATOR_SHARED_COOKIES = [
  "abRequestId",
  "ets",
  "a1",
  "webId",
  "unread",
  "gid",
  "web_session",
  "id_token",
  "x-rednote-datactry",
  "x-rednote-holderctry",
  "websectiga",
  "sec_poison_id",
  "_gray_did",
  "customer-sso-sid",
  "x-user-id-creator.xiaohongshu.com",
  "customerClientId",
  "access-token-creator.xiaohongshu.com",
  "galaxy_creator_session_id",
  "galaxy.creator.beaker.session.id",
];

const CREATOR_AUTH_KEYS = [
  "customer-sso-sid",
  "access-token-creator.xiaohongshu.com",
  "galaxy_creator_session_id",
  "web_session",
];

export function readSession(account: AccountRow): Record<string, unknown> {
  return decryptSession(account);
}

export function sessionCookie(session: Record<string, unknown>): string {
  const direct = session.cookie;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const header = session.cookie_header;
  if (typeof header === "string" && header.trim()) return header.trim();
  const items = session.cookies;
  if (Array.isArray(items)) {
    const parts: string[] = [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const name = String(row.name || "");
      if (!name) continue;
      parts.push(`${name}=${String(row.value || "")}`);
    }
    if (parts.length) return parts.join("; ");
  }
  return "";
}

export function parseCookie(cookie: string): CookieMap {
  const result: CookieMap = {};
  for (const part of String(cookie || "").split(";")) {
    const item = part.trim();
    if (!item) continue;
    const index = item.indexOf("=");
    if (index <= 0) continue;
    const name = item.slice(0, index).trim();
    if (name) result[name] = item.slice(index + 1);
  }
  return result;
}

export function cookieHeader(map: CookieMap): string {
  return Object.entries(map)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

export function hasPcLogin(map: CookieMap): boolean {
  return Boolean(map.a1 && map.web_session);
}

export function hasCreatorLogin(map: CookieMap): boolean {
  return Boolean(map.a1) && CREATOR_AUTH_KEYS.some((key) => Boolean(map[key]));
}

/**
 * 从完整 PC Cookie 派生 Creator Cookie。
 * 与 vendor/xhs_utils/xhs_creator/auth.py::from_pc_auth 的取值保持一致。
 */
export function creatorCookieMap(full: CookieMap): CookieMap {
  const result: CookieMap = {};
  for (const name of CREATOR_SHARED_COOKIES) {
    const value = full[name];
    if (value !== undefined && value !== "") result[name] = value;
  }
  if (!result._gray_did) result._gray_did = randomUuid();
  result.webBuild = "1.26.0";
  result.xsecappid = "ugc";
  result.loadts = String(Date.now());
  return result;
}

export interface SetCookieMerge {
  map: CookieMap;
  changed: boolean;
}

/** 把 Set-Cookie 头合并回 Cookie 映射；同名后写覆盖。 */
export function mergeSetCookies(map: CookieMap, headers: string[]): SetCookieMerge {
  const next: CookieMap = { ...map };
  let changed = false;
  for (const header of headers) {
    const pair = String(header || "").split(";")[0] || "";
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (!name) continue;
    if (next[name] !== value) {
      next[name] = value;
      changed = true;
    }
  }
  return { map: next, changed };
}

export function persistCookies(
  account: AccountRow,
  session: Record<string, unknown>,
  map: CookieMap
): void {
  saveSession(account.id, { ...session, cookie: cookieHeader(map) });
}

function randomUuid(): string {
  return randomUUID();
}
