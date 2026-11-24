/**
 * 小红书 HTTP 接口（PC 端 + 创作平台）。
 *
 * 已实现：
 * - PC  /api/sns/web/v2/user/me            登录态检查
 * - PC  /api/sns/web/v2/comment/page       一级评论 + 二级回复（只读）
 * - PC  /api/sns/web/v2/search/notes       关键词搜索（选题挖掘）
 * - PC  /api/sns/web/v1/homefeed           频道推荐（选题挖掘）
 * - PC  /api/sns/web/v1/user_posted        竞品账号笔记（选题挖掘）
 * - PC  /api/sns/web/v1/search/trending/query 站内热榜
 * - PC  /api/sns/web/v1/feed               笔记详情（补全正文与互动）
 * - Creator /api/galaxy/v2/creator/note/user/posted  已发布作品列表
 * - Creator /api/media/v1/upload/creator/permit      上传许可
 * - Creator /web_api/sns/v2/note           图文笔记发布
 *
 * 受限：
 * - 发布链路（permit → OSS PUT → post_note）已按 Python 抓包对齐，
 *   但需真实登录态联网回归；失败返回中文提示，不写假数据。
 */
import { randomInt, randomUUID } from "node:crypto";
import { fetch } from "undici";
import { mergeSetCookies, type CookieMap } from "./session";
import {
  creatorRapParam,
  creatorSignedGetHeaders,
  creatorSignedHeaders,
  makeDispatcher,
  pcSignedGetHeaders,
  pcSignedHeaders,
} from "./sign";

export interface XhsHttpResult {
  success: boolean;
  message: string;
  payload: Record<string, unknown> | null;
  cookieMap: CookieMap;
  updated: boolean;
  status: number;
  /** 本轮签名使用的 x-t（上传许可的 q-sign-time 需要它）。 */
  xt?: string;
}

const EDITH_ORIGIN = "https://edith.xiaohongshu.com";
const SEARCH_ORIGIN = "https://so.xiaohongshu.com";
const CREATOR_ORIGIN = "https://creator.xiaohongshu.com";
const PUBLISH_REFERER =
  "https://creator.xiaohongshu.com/publish/publish?source=official&from=tab_switch";

const SORT_MAP: Record<number, string> = {
  1: "time_descending",
  2: "popularity_descending",
  3: "comment_descending",
  4: "collect_descending",
};

function setCookieHeaders(headers: unknown): string[] {
  const candidate = headers as {
    get?: (name: string) => string | null;
    getSetCookie?: () => string[];
  };
  if (typeof candidate.getSetCookie === "function") return candidate.getSetCookie();
  const raw = candidate.get ? candidate.get("set-cookie") : null;
  return raw ? [raw] : [];
}

function timeoutMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out|abort/i.test(text)) return "小红书平台响应超时，请稍后重试";
  return `小红书请求失败：${text.slice(0, 200)}`;
}

async function doGet(
  url: string,
  headers: Record<string, string>,
  cookieMap: CookieMap,
  proxy: string
): Promise<XhsHttpResult> {
  const dispatcher = makeDispatcher(proxy);
  try {
    let response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers,
        dispatcher,
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new Error(timeoutMessage(error));
    }
    const text = await response.text();
    let payload: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      payload = null;
    }
    const merged = mergeSetCookies(cookieMap, setCookieHeaders(response.headers));
    const success = Boolean(payload && payload.success);
    let message = String(payload?.msg || payload?.message || "");
    if (!message) {
      message = success ? "成功" : `平台请求失败（HTTP ${response.status}）`;
    }
    return {
      success,
      message,
      payload,
      cookieMap: merged.map,
      updated: merged.changed,
      status: response.status,
      xt: String(headers["x-t"] || ""),
    };
  } finally {
    if (dispatcher) void dispatcher.close().catch(() => undefined);
  }
}

async function doPost(
  url: string,
  headers: Record<string, string>,
  body: string,
  cookieMap: CookieMap,
  proxy: string
): Promise<XhsHttpResult> {
  const dispatcher = makeDispatcher(proxy);
  try {
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body,
        dispatcher,
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new Error(timeoutMessage(error));
    }
    const text = await response.text();
    let payload: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      payload = null;
    }
    const merged = mergeSetCookies(cookieMap, setCookieHeaders(response.headers));
    const success = Boolean(payload && payload.success);
    let message = String(payload?.msg || payload?.message || "");
    if (!message) {
      message = success ? "成功" : `平台请求失败（HTTP ${response.status}）`;
    }
    return {
      success,
      message,
      payload,
      cookieMap: merged.map,
      updated: merged.changed,
      status: response.status,
      xt: String(headers["x-t"] || ""),
    };
  } finally {
    if (dispatcher) void dispatcher.close().catch(() => undefined);
  }
}

export async function pcUserMe(
  cookieMap: CookieMap,
  proxy = ""
): Promise<XhsHttpResult> {
  const api = "/api/sns/web/v2/user/me";
  const headers = await pcSignedGetHeaders(cookieMap, api, "", proxy);
  return doGet(`https://edith.xiaohongshu.com${api}`, headers, cookieMap, proxy);
}

export async function pcCommentsPage(
  cookieMap: CookieMap,
  noteId: string,
  cursor: string,
  xsecToken: string,
  proxy = ""
): Promise<XhsHttpResult> {
  const params = new URLSearchParams();
  params.set("note_id", noteId);
  params.set("cursor", cursor);
  params.set("top_comment_id", "");
  params.set("image_formats", "jpg,webp,avif");
  params.set("xsec_token", xsecToken);
  const api = `/api/sns/web/v2/comment/page?${params.toString()}`;
  const headers = await pcSignedGetHeaders(cookieMap, api, "", proxy);
  return doGet(`https://edith.xiaohongshu.com${api}`, headers, cookieMap, proxy);
}

const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

function intToBase36(value: bigint): string {
  if (value <= 0n) return "0";
  let result = "";
  let current = value;
  while (current > 0n) {
    result = BASE36[Number(current % 36n)] + result;
    current /= 36n;
  }
  return result;
}

/** 与 vendor/xhs_utils/xhs_pc/params.py::generate_search_id 一致。 */
export function generateSearchId(root?: string): string {
  if (root) return root;
  const timestamp = BigInt(Date.now());
  const randomPart = BigInt(Math.ceil(0x7ffffffe * randomInt(0, 0x7fffffff) / 0x7fffffff));
  return intToBase36((timestamp << 64n) + randomPart);
}

/** POST /api/sns/web/v2/search/notes（搜索页域名）。 */
export async function pcSearchNotes(
  cookieMap: CookieMap,
  keyword: string,
  page: number,
  sortTypeChoice = 0,
  searchId = "",
  proxy = ""
): Promise<XhsHttpResult> {
  const api = "/api/sns/web/v2/search/notes";
  const body = JSON.stringify({
    keyword,
    page: Math.max(1, Math.trunc(page)),
    page_size: 20,
    search_id: generateSearchId(searchId),
    sort: SORT_MAP[sortTypeChoice] || "general",
    note_type: 0,
    ext_flags: [],
    geo: "",
    image_formats: ["jpg", "webp", "avif"],
    session_id: randomUUID(),
  });
  const headers = await pcSignedHeaders(cookieMap, api, body, proxy, {
    method: "POST",
    rap: true,
  });
  return doPost(`${SEARCH_ORIGIN}${api}`, headers, body, cookieMap, proxy);
}

/** POST /api/sns/web/v1/homefeed（需要 xy-direction）。 */
export async function pcHomefeed(
  cookieMap: CookieMap,
  category: string,
  cursorScore: string,
  refreshType: number,
  noteIndex: number,
  userId: string,
  proxy = ""
): Promise<XhsHttpResult> {
  const api = "/api/sns/web/v1/homefeed";
  const body = JSON.stringify({
    cursor_score: cursorScore,
    num: 20,
    refresh_type: refreshType,
    note_index: noteIndex,
    unread_begin_note_id: "",
    unread_end_note_id: "",
    unread_note_count: 0,
    category,
    search_key: "",
    need_num: 10,
    image_formats: ["jpg", "webp", "avif"],
    need_filter_image: false,
  });
  const headers = await pcSignedHeaders(cookieMap, api, body, proxy, {
    method: "POST",
    rap: true,
    xyUserId: userId,
  });
  return doPost(`${EDITH_ORIGIN}${api}`, headers, body, cookieMap, proxy);
}

/** GET /api/sns/web/v1/user_posted（竞品账号笔记）。 */
export async function pcUserPostedNotes(
  cookieMap: CookieMap,
  userId: string,
  cursor: string,
  xsecToken: string,
  xsecSource: string,
  proxy = ""
): Promise<XhsHttpResult> {
  const params = new URLSearchParams();
  params.set("num", "30");
  params.set("cursor", cursor);
  params.set("user_id", userId);
  params.set("image_formats", "jpg,webp,avif");
  params.set("xsec_token", xsecToken);
  params.set("xsec_source", xsecSource);
  const api = `/api/sns/web/v1/user_posted?${params.toString()}`;
  const headers = await pcSignedHeaders(cookieMap, api, "", proxy, {
    method: "GET",
    rap: true,
  });
  return doGet(`${EDITH_ORIGIN}${api}`, headers, cookieMap, proxy);
}

/** GET /api/sns/web/v1/search/trending/query（站内热榜）。 */
export async function pcTrendingQueries(
  cookieMap: CookieMap,
  proxy = ""
): Promise<XhsHttpResult> {
  const params = new URLSearchParams();
  params.set("source", "UserPage");
  params.set("search_type", "trend");
  params.set("last_query", "");
  params.set("last_query_time", "0");
  params.set("word_request_situation", "FIRST_ENTER");
  params.set("hint_word", "");
  params.set("hint_word_type", "");
  params.set("hint_word_request_id", "");
  const api = `/api/sns/web/v1/search/trending/query?${params.toString()}`;
  const headers = await pcSignedGetHeaders(cookieMap, api, "", proxy);
  return doGet(`${EDITH_ORIGIN}${api}`, headers, cookieMap, proxy);
}

/** POST /api/sns/web/v1/feed（笔记详情，用于补全正文与互动）。 */
export async function pcNoteInfo(
  cookieMap: CookieMap,
  noteId: string,
  xsecToken: string,
  userId: string,
  proxy = ""
): Promise<XhsHttpResult> {
  const api = "/api/sns/web/v1/feed";
  const body = JSON.stringify({
    source_note_id: noteId,
    image_formats: ["jpg", "webp", "avif"],
    extra: { need_body_topic: "1" },
    xsec_source: "pc_search",
    xsec_token: xsecToken,
  });
  const headers = await pcSignedHeaders(cookieMap, api, body, proxy, {
    method: "POST",
    rap: true,
    xyUserId: userId,
  });
  return doPost(`${EDITH_ORIGIN}${api}`, headers, body, cookieMap, proxy);
}

/**
 * Creator 发布页导航：把 PC 登录态换成创作平台的 host Cookie。
 * 失败不阻断后续接口，由作品列表请求自己暴露问题。
 */
export async function creatorNavigate(
  cookieMap: CookieMap,
  proxy = ""
): Promise<{ cookieMap: CookieMap; updated: boolean }> {
  const url =
    "https://creator.xiaohongshu.com/publish/publish?source=official&from=tab_switch";
  const dispatcher = makeDispatcher(proxy);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36",
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9," +
          "image/avif,image/webp,image/apng,*/*;q=0.8",
        "accept-language": "zh-CN,zh;q=0.9",
        "upgrade-insecure-requests": "1",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
        cookie: Object.entries(cookieMap)
          .map(([name, value]) => `${name}=${value}`)
          .join("; "),
      },
      dispatcher,
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    await response.arrayBuffer();
    const merged = mergeSetCookies(cookieMap, setCookieHeaders(response.headers));
    return { cookieMap: merged.map, updated: merged.changed };
  } catch {
    return { cookieMap, updated: false };
  } finally {
    if (dispatcher) void dispatcher.close().catch(() => undefined);
  }
}

export async function creatorPostedNotesPage(
  cookieMap: CookieMap,
  page: number,
  proxy = ""
): Promise<XhsHttpResult> {
  const api = `/api/galaxy/v2/creator/note/user/posted?tab=0&page=${Math.trunc(page)}`;
  const headers = await creatorSignedGetHeaders(cookieMap, api, proxy);
  return doGet(
    `https://creator.xiaohongshu.com${api}`,
    headers,
    cookieMap,
    proxy
  );
}

/**
 * 申请媒体上传许可：GET /api/media/v1/upload/creator/permit。
 * 发布页用 0101/publish_permit_image 档位，失败可按调用方重试。
 */
export async function creatorPermit(
  creatorCookie: CookieMap,
  scene: "image" | "video",
  proxy = ""
): Promise<XhsHttpResult> {
  const params = new URLSearchParams();
  params.set("biz_name", "spectrum");
  params.set("scene", scene);
  params.set("file_count", "1");
  params.set("version", "1");
  params.set("source", "web");
  const api = `/api/media/v1/upload/creator/permit?${params.toString()}`;
  const headers = await creatorSignedHeaders(creatorCookie, api, "", proxy, {
    method: "GET",
    mnsProfile:
      scene === "video" ? "publish_permit_video" : "publish_permit_image",
    b1Profile: "login",
    referer: PUBLISH_REFERER,
    secFetchSite: "same-origin",
  });
  return doGet(`${CREATOR_ORIGIN}${api}`, headers, creatorCookie, proxy);
}

/** POST /web_api/sns/v1/search/topic（发布时解析话题）。 */
export async function creatorTopic(
  creatorCookie: CookieMap,
  keyword: string,
  proxy = ""
): Promise<XhsHttpResult> {
  const api = "/web_api/sns/v1/search/topic";
  const body = JSON.stringify({
    keyword,
    suggest_topic_request: { title: "", desc: `#${keyword}` },
    page: { page_size: 20, page: 1 },
  });
  const headers = await creatorSignedHeaders(creatorCookie, api, body, proxy, {
    method: "POST",
    b1Profile: "login",
    referer: "https://creator.xiaohongshu.com/",
    secFetchSite: "same-site",
  });
  return doPost(`${EDITH_ORIGIN}${api}`, headers, body, creatorCookie, proxy);
}

/** POST /web_api/sns/v2/note（发布图文笔记，带 Creator RAP 指纹）。 */
export async function creatorPostNote(
  creatorCookie: CookieMap,
  body: string,
  proxy = ""
): Promise<XhsHttpResult> {
  const api = "/web_api/sns/v2/note";
  const headers = await creatorSignedHeaders(creatorCookie, api, body, proxy, {
    method: "POST",
    b1Profile: "login",
    referer: "https://creator.xiaohongshu.com/",
    secFetchSite: "same-site",
  });
  headers["x-rap-param"] = await creatorRapParam(api, body);
  return doPost(`${EDITH_ORIGIN}${api}`, headers, body, creatorCookie, proxy);
}

/**
 * 把图片/视频二进制 PUT 到 ROS 上传域名。
 * 上传域名不会收到创作者登录 Cookie，鉴权全部在 authorization 头里。
 */
export async function creatorUploadBinary(
  uploadHost: string,
  fileId: string,
  buffer: Buffer,
  headers: Record<string, string>,
  proxy = ""
): Promise<{ videoId: string }> {
  const dispatcher = makeDispatcher(proxy);
  try {
    const host = uploadHost.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    // 上传域名来自服务端响应，必须限制在小红书自有域名内，防止被引导到任意地址。
    const hostname = host.split("/")[0].split(":")[0].toLowerCase();
    const trusted = ["xiaohongshu.com", "xhscdn.com", "xhs.cn", "rednotecdn.com"];
    if (!trusted.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))) {
      throw new Error(`小红书上传域名不受信任：${hostname || "空"}`);
    }
    const url = `https://${host}/spectrum/${fileId}`;
    let response;
    try {
      response = await fetch(url, {
        method: "PUT",
        headers,
        body: buffer,
        dispatcher,
        signal: AbortSignal.timeout(120_000),
      });
    } catch (error) {
      throw new Error(timeoutMessage(error));
    }
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `媒体上传失败（HTTP ${response.status}）：${text.slice(0, 150) || "平台未返回原因"}`
      );
    }
    return { videoId: String(response.headers.get("x-ros-video-id") || "") };
  } finally {
    if (dispatcher) void dispatcher.close().catch(() => undefined);
  }
}
