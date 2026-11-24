/**
 * 已发表回读：拉「已发表」列表并写回 published_notes。
 *
 * 与 Python 版一致，接口顺序会随平台改版变化，所以按候选接口逐个尝试；
 * 平台没返回的指标留 NULL，不能写成 0。
 */
import { getDb, execute } from "../../core/db";
import { now } from "../../core/config";
import { log } from "../../core/log";
import { PlatformFailure, WeChatClient } from "./client";
import { parseAccount, publishedItems, type PublishedArticle } from "./parser";
import { ensureTokenAsync } from "./publish";

const ENDPOINTS = [
  { path: "/cgi-bin/appmsgpublish", extra: { sub: "list" } },
  { path: "/cgi-bin/appmsg", extra: { action: "list_ex", type: "9", query: "" } },
  { path: "/cgi-bin/freepublish", extra: { t: "freepublish/list" } },
] as const;

export interface FetchResult {
  ok: boolean;
  message: string;
  items: PublishedArticle[];
  next_cursor: number | null;
  kind?: string;
  /** 平台可能轮换 Cookie/token，成功时带回归档。 */
  state?: Record<string, unknown>;
}

export async function fetchPublished(
  session: Record<string, unknown>,
  options: { cursor?: number; limit?: number; proxy?: string } = {}
): Promise<FetchResult> {
  const begin = Math.max(0, Math.trunc(options.cursor || 0));
  const count = Math.max(1, Math.min(50, Math.trunc(options.limit || 30)));
  const client = new WeChatClient(session, options.proxy || "");
  try {
    await ensureTokenAsync(client);
    let fakeid = String(session.fakeid || "");
    let lastMessage = "";
    for (const endpoint of ENDPOINTS) {
      const params: Record<string, string> = {
        begin: String(begin),
        count: String(count),
        token: client.token,
        lang: "zh_CN",
        f: "json",
        ajax: "1",
        ...endpoint.extra,
      };
      if (endpoint.path === "/cgi-bin/appmsg" && fakeid) params.fakeid = fakeid;
      const response = await client.get(endpoint.path, params);
      if (response.url.includes("login")) {
        throw new PlatformFailure("auth", "公众号登录态已失效，请重新扫码登录");
      }
      let payload: unknown;
      try {
        payload = JSON.parse(response.text);
      } catch {
        lastMessage = "公众号后台返回非 JSON，接口可能已改版";
        continue;
      }
      if (!payload || typeof payload !== "object") {
        lastMessage = "公众号后台返回非 JSON，接口可能已改版";
        continue;
      }
      const base = ((payload as Record<string, unknown>).base_resp || {}) as Record<string, unknown>;
      const ret = Number(base.ret || 0);
      if (ret !== 0) {
        const errmsg = String(base.err_msg || "");
        if (/登录|invalid session/.test(errmsg) || [-6, 200003].includes(ret)) {
          throw new PlatformFailure("auth", "公众号登录态已失效，请重新扫码登录");
        }
        if (/频繁|频率|次数/.test(errmsg) || [200013, 45009].includes(ret)) {
          throw new PlatformFailure("rate", `公众号操作受限：${errmsg || "请稍后再试"}`);
        }
        lastMessage = errmsg || `ret=${ret}`;
        continue;
      }
      const articles = publishedItems(payload);
      const nextCursor = articles.length >= count ? begin + count : null;
      if (!fakeid) {
        // 新版首页可能不带 fakeid，从列表页 HTML 里补一次。
        try {
          const home = await client.get("/cgi-bin/home", { t: "home/index", lang: "zh_CN" });
          fakeid = parseAccount(home.text, home.url).fakeid;
        } catch {
          /* 补不到也不影响列表 */
        }
      }
      return {
        ok: true,
        message: "成功",
        items: articles.slice(0, count),
        next_cursor: nextCursor,
        state: {
          ...session,
          cookies: client.cookiesSnapshot(),
          cookie_header: client.cookieHeader(),
          token: client.token,
          fakeid,
        },
      };
    }
    throw new PlatformFailure(
      "platform",
      "没有找到公众号已发表列表接口，平台可能已改版",
      lastMessage
    );
  } catch (error) {
    if (error instanceof PlatformFailure) {
      return { ok: false, message: error.message, items: [], next_cursor: null, kind: error.kind };
    }
    log.error(`公众号回读异常: ${error instanceof Error ? error.stack : String(error)}`);
    return {
      ok: false,
      message: "拉取公众号文章列表失败，请稍后重试",
      items: [],
      next_cursor: null,
    };
  } finally {
    client.close();
  }
}

/** 把回读结果落库；同账号同文章按 remote_note_id 覆盖更新。 */
export function savePublished(
  accountId: number,
  platform: string,
  articles: PublishedArticle[]
): number {
  const stamp = now();
  const write = getDb().transaction(() => {
    let count = 0;
    for (const item of articles) {
      if (!item.remote_note_id) continue;
      execute(
        "INSERT INTO published_notes(platform, account_id, remote_note_id, title, desc, cover, " +
          "note_type, visibility, views, likes, comments, collects, published_at, url, raw, " +
          "synced_at, metrics_synced_at, created_at, updated_at) " +
          "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) " +
          "ON CONFLICT(account_id, remote_note_id) DO UPDATE SET " +
          "title=excluded.title, desc=excluded.desc, cover=excluded.cover, " +
          "note_type=excluded.note_type, visibility=excluded.visibility, views=excluded.views, " +
          "likes=excluded.likes, comments=excluded.comments, collects=excluded.collects, " +
          "published_at=excluded.published_at, url=excluded.url, raw=excluded.raw, " +
          "synced_at=excluded.synced_at, metrics_synced_at=excluded.metrics_synced_at, " +
          "updated_at=excluded.updated_at",
        platform,
        accountId,
        item.remote_note_id,
        item.title.slice(0, 300),
        item.desc.slice(0, 5000),
        item.cover,
        item.note_type,
        item.visibility,
        item.views,
        item.likes,
        item.comments,
        item.collects,
        item.published_at,
        item.url.slice(0, 500),
        JSON.stringify(item.raw).slice(0, 8000),
        stamp,
        stamp,
        stamp,
        stamp
      );
      count += 1;
    }
    execute(
      "UPDATE accounts SET published_synced_at=?, published_sync_error='', updated_at=? WHERE id=?",
      stamp,
      stamp,
      accountId
    );
    return count;
  });
  return write();
}

export function markSyncError(accountId: number, message: string): void {
  execute(
    "UPDATE accounts SET published_sync_error=?, published_synced_at=?, updated_at=? WHERE id=?",
    message.slice(0, 500),
    now(),
    now(),
    accountId
  );
}

export function listPublished(accountId: number, limit = 50): Record<string, unknown>[] {
  const db = getDb();
  return db
    .prepare(
      "SELECT * FROM published_notes WHERE account_id = ? ORDER BY published_at DESC, id DESC LIMIT ?"
    )
    .all(accountId, limit) as Record<string, unknown>[];
}
