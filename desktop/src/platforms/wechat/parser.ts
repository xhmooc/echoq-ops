/**
 * 公众号后台响应解析：移植 ops/platforms/wechat_mp.py 里的纯函数部分。
 *
 * 这里只做「把平台返回的结构归一化」，不发请求，方便单独验证解析结果。
 */

const COUNT_UNITS: Record<string, number> = {
  万: 10000,
  w: 10000,
  W: 10000,
  亿: 100000000,
  k: 1000,
  K: 1000,
  千: 1000,
};

export type Json = Record<string, unknown>;

export function pick(payload: unknown, ...keys: string[]): unknown {
  if (!payload || typeof payload !== "object") return "";
  const record = payload as Json;
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return "";
}

export function parseCount(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === "number") return Math.trunc(value);
  let text = String(value).trim().replace(/,/g, "").replace(/\+/g, "");
  if (!text) return 0;
  const match = /^(\d+(?:\.\d+)?)\s*([万wW亿kK千]?)$/.exec(text);
  if (!match) {
    const digits = text.replace(/[^\d.]/g, "");
    if (!digits) return 0;
    const number = Number.parseFloat(digits);
    return Number.isFinite(number) ? Math.trunc(number) : 0;
  }
  const number = Number.parseFloat(match[1]);
  return Math.trunc(number * (COUNT_UNITS[match[2]] || 1));
}

function countOrNull(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && !value.trim()) return null;
  try {
    return parseCount(value);
  } catch {
    return null;
  }
}

export function toTimestamp(value: unknown): number {
  if (value === undefined || value === null || value === "" || value === 0) return 0;
  if (typeof value === "number") {
    return value > 10_000_000_000 ? Math.trunc(value / 1000) : Math.trunc(value);
  }
  const text = String(value).trim();
  return /^\d+$/.test(text) ? Number.parseInt(text, 10) : 0;
}

function regexFirst(text: string, patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const match = pattern.exec(text || "");
    if (match && match[1]) return match[1].trim();
  }
  return "";
}

export function tokenFromUrl(url: string): string {
  try {
    return new URL(url || "https://mp.weixin.qq.com/").searchParams.get("token") || "";
  } catch {
    return "";
  }
}

export interface AccountInfo {
  nickname: string;
  fakeid: string;
  token: string;
  ticket: string;
  user_name: string;
  svr_time: string;
  avatar: string;
}

/** 从后台首页 HTML 里取账号头像：字段名和页面结构在不同版本里不一致，逐种兜底。 */
export function avatarFromHtml(html: string): string {
  const raw = regexFirst(html || "", [
    /"head_img"\s*:\s*"([^"]+)"/,
    /"hd_head_img"\s*:\s*"([^"]+)"/,
    /"headimgurl"\s*:\s*"([^"]+)"/,
    /"headimg"\s*:\s*"([^"]+)"/,
    /wx\.cgiData\.headimg\s*=\s*["']([^"']+)["']/,
    /class="[^"]*weui-desktop-account__thumb[^"]*"[^>]*src="([^"]+)"/,
    /src="([^"]+)"[^>]*class="[^"]*weui-desktop-account__thumb/,
  ]);
  const url = raw.replace(/\\\//g, "/").trim();
  return /^https?:\/\//i.test(url) ? url : "";
}

/** 从后台首页 HTML / URL 里提取账号身份与 token，正则与 Python 版保持一致。 */
export function parseAccount(html: string, pageUrl = ""): AccountInfo {
  const nickname = regexFirst(html, [
    /"nick_name"\s*:\s*"([^"]+)"/,
    /'nick_name'\s*:\s*'([^']+)'/,
    /nick_name\s*[:=]\s*["']([^"']+)/,
    /"nickname"\s*:\s*"([^"]+)"/,
  ]);
  const fakeid = regexFirst(html, [
    /"fakeid"\s*:\s*"([^"]+)"/,
    /'fakeid'\s*:\s*'([^']+)'/,
    /fakeid\s*[:=]\s*["']([^"']+)["']/,
  ]);
  const token =
    tokenFromUrl(pageUrl) ||
    regexFirst(html, [
      /["']token["']\s*:\s*["']?(\d{4,})/,
      /wx\.(?:cgiData|data)\.token\s*=\s*["']?(\d{4,})/,
      /token\s*=\s*["'](\d{4,})/,
      /token=(\d{4,})/,
      /token\s*[:=]\s*["']?(\d{4,})/,
    ]);
  const ticket = regexFirst(html, [
    /wx\.data\.ticket\s*=\s*["']([^"']+)'/,
    /wx\.cgiData\.ticket\s*=\s*["']([^"']+)'/,
    /"ticket"\s*:\s*"([^"]+)"/,
    /ticket\s*[:=]\s*["']([^"']+)'/,
  ]);
  const userName = regexFirst(html, [
    /wx\.data\.user_name\s*=\s*["']([^"']+)'/,
    /wx\.cgiData\.user_name\s*=\s*["']([^"']+)'/,
    /"user_name"\s*:\s*"([^"]+)"/,
  ]);
  const svrTime = regexFirst(html, [
    /wx\.cgiData\.time\s*=\s*["']?(\d{10,13})/,
    /"svr_time"\s*:\s*"?(\d{10,13})/,
    /svr_time\s*[:=]\s*["']?(\d{10,13})/,
    /\btime\s*[:=]\s*["']?(\d{10,13})/,
  ]);
  return {
    nickname,
    fakeid,
    token,
    ticket,
    user_name: userName,
    svr_time: svrTime,
    avatar: avatarFromHtml(html),
  };
}

/** 在多层响应里找字段（素材上传常把结果塞进 data/content）。 */
export function findField(payload: unknown, keys: string[], depth = 0): string {
  if (depth > 4 || payload === null || payload === undefined) return "";
  if (typeof payload === "object" && !Array.isArray(payload)) {
    const record = payload as Json;
    for (const key of keys) {
      const value = record[key];
      if (
        (typeof value === "string" || typeof value === "number") &&
        String(value).trim()
      ) {
        return String(value).trim();
      }
    }
    for (const key of ["data", "result", "file", "image", "img"]) {
      const found = findField(record[key], keys, depth + 1);
      if (found) return found;
    }
    const content = record.content;
    if (typeof content === "string" && content.trim().startsWith("{")) {
      try {
        const found = findField(JSON.parse(content), keys, depth + 1);
        if (found) return found;
      } catch {
        /* 不是 JSON，忽略 */
      }
    }
  }
  return "";
}

export function asDict(value: unknown): Json {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Json;
  if (typeof value === "string" && value.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      return {};
    }
  }
  return {};
}

export interface PublishedArticle {
  remote_note_id: string;
  title: string;
  desc: string;
  cover: string;
  note_type: string;
  visibility: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  collects: number | null;
  shares: number | null;
  published_at: number;
  url: string;
  raw: Json;
}

export function normalizeArticle(item: Json): PublishedArticle {
  let remoteId = String(
    pick(item, "aid", "appmsgid", "app_msg_id", "msg_id", "id", "fileid") || ""
  );
  const link = String(pick(item, "link", "url", "content_url") || "");
  if (!remoteId && link) {
    const match = /\/s\/([A-Za-z0-9_-]+)/.exec(link);
    remoteId = match ? match[1] : link;
  }
  return {
    remote_note_id: remoteId,
    title: String(pick(item, "title", "name") || "").trim(),
    desc: String(pick(item, "digest", "desc", "summary") || "").trim(),
    cover: String(pick(item, "cover", "cover_url", "cover_url_1", "cdn_url") || ""),
    note_type: "article",
    visibility: "公开",
    views: countOrNull(pick(item, "read_num", "readNum", "read_count")),
    likes: countOrNull(pick(item, "like_num", "likeNum", "like_count")),
    comments: countOrNull(pick(item, "comment_count", "commentCount", "comment_num", "commentNum")),
    collects: countOrNull(pick(item, "old_like_num", "oldLikeNum", "wow_num")),
    shares: countOrNull(pick(item, "share_num", "shareNum")),
    published_at: toTimestamp(
      pick(item, "create_time", "createTime", "update_time", "send_time", "sent_time")
    ),
    url: link,
    raw: item,
  };
}

/** 兼容 publish_page -> publish_list -> appmsgex 与 freepublish -> publish_info。 */
export function publishedItems(payload: unknown): PublishedArticle[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Json;
  const page = asDict(root.publish_page || root.publishPage);
  if (Object.keys(page).length) {
    const list = (page.publish_list || page.list || []) as unknown;
    if (Array.isArray(list) && list.length) {
      const articles: PublishedArticle[] = [];
      for (const entry of list) {
        if (!entry || typeof entry !== "object") continue;
        const record = entry as Json;
        const info = Object.keys(asDict(record.publish_info || record.publishInfo)).length
          ? asDict(record.publish_info || record.publishInfo)
          : record;
        const sent = asDict(info.sent_info || record.sent_info);
        const fallback = { ...record, ...sent, ...info };
        const groups =
          info.appmsgex ||
          info.appmsg_info ||
          info.appmsg_list ||
          record.appmsgex ||
          record.appmsg_info;
        const candidates = Array.isArray(groups) && groups.length ? groups : [info];
        for (const candidate of candidates) {
          const merged = { ...fallback, ...asDict(candidate) };
          const article = normalizeArticle(merged);
          if (article.remote_note_id) articles.push(article);
        }
      }
      return articles;
    }
  }
  const items =
    root.app_msg_list || root.appmsg_list || root.publish_list || root.list || [];
  if (!Array.isArray(items)) return [];
  return items
    .filter((item): item is Json => Boolean(item) && typeof item === "object")
    .map(normalizeArticle)
    .filter((article) => Boolean(article.remote_note_id));
}
