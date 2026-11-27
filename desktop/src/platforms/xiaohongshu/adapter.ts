/**
 * 小红书适配器（Node 版）。
 *
 * 已实现：
 * - checkSession：PC user/me 验证 Cookie；
 * - fetchPublished：Creator 作品列表，按 normalize_note 字段归一化；
 * - fetchComments：PC 评论列表（只读，含二级回复）；
 * - mine：关键词 / 竞品 / 频道 / 热榜四种选题挖掘；
 * - publish：图文笔记（permit → ROS 上传 → post_note）。
 *
 * 受限：
 * - 发布与选题检索已按 Python 抓包对齐，但需要真实登录态联网回归；
 *   失败返回中文错误，不写假数据。视频发布暂未迁移。
 */
import { now } from "../../core/config";
import { queryAll } from "../../core/db";
import { log } from "../../core/log";
import { validateDraft } from "../../core/platform";
import { getSetting } from "../../core/settings";
import type { AccountRow } from "../../core/accounts";
import { ingest } from "../../services/topics";
import {
  creatorDeleteNote,
  creatorNavigate,
  creatorPostedNotesPage,
  generateSearchId,
  pcCommentsPage,
  pcHomefeed,
  pcNoteInfo,
  pcSearchNotes,
  pcTrendingQueries,
  pcUserMe,
  pcUserPostedNotes,
} from "./api";
import { publishImageNote, XhsPublishError } from "./publish";
import { deleteXhsNoteViaUi } from "./deleteUi";
import {
  creatorCookieMap,
  hasCreatorLogin,
  hasPcLogin,
  parseCookie,
  persistCookies,
  readSession,
  sessionCookie,
  type CookieMap,
} from "./session";
import type {
  CommentsPage,
  NormalizedComment,
  NormalizedNote,
  PublishOutcome,
  PublishedPage,
  SessionCheckResult,
} from "./types";

const VISIBILITY_TEXT: Record<number, string> = {
  0: "公开",
  1: "仅自己可见",
  2: "好友可见",
  3: "仅关注者可见",
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function pick(source: unknown, ...keys: string[]): unknown {
  const record = asRecord(source);
  for (const key of keys) {
    const value = record[key];
    if (value !== null && value !== undefined && value !== "") return value;
  }
  return undefined;
}

function coverUrl(item: Record<string, unknown>): string {
  let cover = pick(item, "cover", "cover_url", "coverUrl", "image", "first_image");
  if (cover && typeof cover === "object" && !Array.isArray(cover)) {
    cover = pick(cover, "url", "url_default", "urlDefault", "origin_url");
  }
  if (!cover) {
    const images =
      (item.images_list as unknown) ||
      (item.images as unknown) ||
      (item.image_list as unknown) ||
      [];
    if (Array.isArray(images) && images.length) {
      const first = images[0];
      if (first && typeof first === "object") {
        cover = pick(first, "url", "url_default", "origin_url");
      } else {
        cover = first;
      }
    }
  }
  return String(cover || "");
}

function parseCount(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return Math.trunc(value);
  const text = String(value).trim().replace(/,/g, "").replace(/\+/g, "");
  if (!text) return 0;
  const units: Record<string, number> = {
    "": 1,
    万: 10000,
    w: 10000,
    W: 10000,
    亿: 100000000,
    k: 1000,
    K: 1000,
    千: 1000,
  };
  const match = /^(\d+(?:\.\d+)?)\s*([万wW亿kK千]?)$/.exec(text);
  if (!match) {
    const digits = text.replace(/[^\d.]/g, "");
    if (!digits) return 0;
    const number = Number.parseFloat(digits);
    return Number.isFinite(number) ? Math.trunc(number) : 0;
  }
  const number = Number.parseFloat(match[1]);
  return Number.isFinite(number)
    ? Math.trunc(number * (units[match[2]] || 1))
    : 0;
}

function countOrNone(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && !value.trim()) return null;
  return parseCount(value);
}

function timestamp(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") {
    const number = Math.trunc(value);
    return number > 10_000_000_000 ? Math.floor(number / 1000) : number;
  }
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return timestamp(Number(text));
  const parsed = Date.parse(text.replace(" ", "T"));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

export function normalizeNote(item: Record<string, unknown>): NormalizedNote {
  const stats = asRecord(item.interact_info || item.interactInfo);
  const noteId = String(pick(item, "note_id", "noteId", "id") || "");
  const title = String(pick(item, "title", "display_title", "displayTitle") || "").trim();
  const desc = String(pick(item, "desc", "description", "content") || "").trim();
  const rawType = String(pick(item, "type", "note_type", "noteType") || "normal");
  const views = pick(item, "view_count", "views", "read_count", "readCount", "viewCount");
  let likes = pick(item, "liked_count", "likes", "like_count", "likeCount");
  if (likes === undefined) likes = pick(stats, "liked_count", "likedCount");
  let collects = pick(item, "collected_count", "collects", "collectedCount");
  if (collects === undefined) collects = pick(stats, "collected_count", "collectedCount");
  let comments = pick(
    item,
    "comments_count",
    "comment_count",
    "comments",
    "commentCount"
  );
  if (comments === undefined) comments = pick(stats, "comment_count", "commentCount");
  let visibility = pick(
    item,
    "visibility",
    "permission",
    "permission_text",
    "status_text"
  );
  if (visibility === undefined) {
    const rawCode = item.permission_code;
    const code =
      rawCode === null || rawCode === undefined || rawCode === ""
        ? -1
        : Number(rawCode);
    visibility = Number.isFinite(code) ? VISIBILITY_TEXT[code] || "" : "";
  }
  if (typeof visibility === "number") visibility = VISIBILITY_TEXT[visibility] || "";
  const publishedAt = timestamp(
    pick(
      item,
      "visible_time",
      "post_time",
      "publish_time",
      "create_time",
      "time",
      "published_at"
    )
  );
  let url = String(pick(item, "note_url", "url", "link") || "");
  if (!url && noteId) {
    const token = String(pick(item, "xsec_token") || "");
    const source = String(pick(item, "xsec_source") || "");
    const suffix = token
      ? `?xsec_token=${token}${source ? `&xsec_source=${source}` : ""}`
      : "";
    url = `https://www.xiaohongshu.com/explore/${noteId}${suffix}`;
  }
  return {
    remote_note_id: noteId,
    title,
    desc,
    cover: coverUrl(item),
    note_type: rawType === "video" || rawType === "视频" ? "video" : "image",
    visibility: String(visibility || ""),
    views: countOrNone(views),
    likes: countOrNone(likes),
    collects: countOrNone(collects),
    comments: countOrNone(comments),
    published_at: publishedAt,
    url,
    raw: item,
  };
}

export function normalizeComment(
  item: Record<string, unknown>,
  parentCommentId = ""
): NormalizedComment {
  let user = asRecord(item.user_info || item.user);
  if (!Object.keys(user).length) user = {};
  const commentId = String(pick(item, "id", "comment_id", "commentId") || "");
  return {
    remote_comment_id: commentId,
    author: String(
      pick(user, "nickname", "nick_name", "name") || pick(item, "nickname") || ""
    ),
    author_id: String(pick(user, "user_id", "userId") || ""),
    content: String(pick(item, "content", "text") || ""),
    likes: countOrNone(pick(item, "like_count", "likes", "likeCount")),
    commented_at: timestamp(
      pick(item, "create_time", "created_at", "time", "comment_time")
    ),
    is_reply: Boolean(parentCommentId),
    parent_comment_id: parentCommentId,
  };
}

function friendlyError(message: unknown, fallback: string): string {
  const text = String(message || "").toLowerCase();
  // 限流优先于登录判断：限流响应里常同时带 cookie/session 字样。
  if (["403", "风控", "频繁", "rate limit", "too many", "429"].some((word) => text.includes(word))) {
    return "平台限制了本次请求，请稍后重试";
  }
  if (
    ["401", "登录", "login", "guest", "cookie", "会话", "未登录"].some((word) =>
      text.includes(word)
    )
  ) {
    return "登录态已失效，请重新登录该账号";
  }
  if (["timeout", "超时", "timed out"].some((word) => text.includes(word))) {
    return "平台响应超时，请稍后重试";
  }
  return fallback;
}

function loginState(account: AccountRow): {
  session: Record<string, unknown>;
  cookieMap: CookieMap;
} {
  const session = readSession(account);
  return { session, cookieMap: parseCookie(sessionCookie(session)) };
}

export async function checkSession(account: AccountRow): Promise<SessionCheckResult> {
  const { session, cookieMap } = loginState(account);
  if (!hasPcLogin(cookieMap)) {
    return {
      ok: false,
      message: "小红书登录态不完整（缺少 a1 或 web_session），请重新登录",
    };
  }
  try {
    const result = await pcUserMe(cookieMap, account.proxy);
    if (result.updated) persistCookies(account, session, result.cookieMap);
    const data = asRecord(result.payload?.data);
    if (!result.success || data.guest) {
      return { ok: false, message: "小红书登录态已失效，请重新登录该账号" };
    }
    return {
      ok: true,
      message: "登录态正常",
      nickname: String(data.nickname || account.nickname || account.name || ""),
      red_id: String(data.red_id || account.red_id || ""),
      user_id: String(data.user_id || account.user_id || ""),
      avatar: String(
        data.avatar ||
          data.image ||
          data.images ||
          data.imageb ||
          data.head_img ||
          data.headImgUrl ||
          ""
      ),
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.error(`小红书账号 ${account.id} 登录态检查失败: ${reason}`);
    return {
      ok: false,
      message: reason.includes("小红书") || reason.includes("代理")
        ? reason
        : "登录态检查失败，请稍后重试（详见日志）",
    };
  }
}

export async function publish(
  account: AccountRow,
  payload: Record<string, unknown>
): Promise<PublishOutcome> {
  const title = String(payload.title || "").trim();
  const desc = String(payload.desc || "").trim();
  const images = Array.isArray(payload.images) ? payload.images : [];
  const problems = validateDraft(
    "xiaohongshu",
    {
      title,
      desc,
      images,
      media_type: String(payload.media_type || ""),
    },
    String(payload.content_type || "")
  );
  if (problems.length) {
    return {
      ok: false,
      message: problems.join("；"),
      result: { stage: "validate", account_id: account.id },
      kind: "content",
    };
  }
  if (String(payload.media_type || "image") === "video") {
    return {
      ok: false,
      message: "小红书视频发布尚未迁移，请先发图文笔记",
      result: { stage: "validate", account_id: account.id },
      kind: "content",
    };
  }
  const { cookieMap } = loginState(account);
  if (!hasCreatorLogin(cookieMap)) {
    return {
      ok: false,
      message: "小红书登录态已失效，请重新登录该账号",
      result: { stage: "auth", account_id: account.id },
      kind: "auth",
    };
  }
  const creatorMap = creatorCookieMap(cookieMap);
  // Creator 导航返回的是派生 Cookie，只用于本次发布，不能写回 PC 登录态。
  const navigated = await creatorNavigate(creatorMap, account.proxy);
  const topics = (Array.isArray(payload.topics) ? payload.topics : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  try {
    return await publishImageNote(account, navigated.cookieMap, {
      title,
      desc,
      images: images.map((item) => String(item)),
      topics,
      privacyType: Number(payload.type ?? 1),
    });
  } catch (error) {
    const reason =
      error instanceof XhsPublishError
        ? error
        : new XhsPublishError(
            "platform",
            "发布请求异常，请稍后重试（详见日志）"
          );
    log.error(
      `小红书账号 ${account.id} 发布失败: ${
        error instanceof Error ? error.stack : String(error)
      }`
    );
    return {
      ok: false,
      message: reason.message,
      result: { stage: "publish", account_id: account.id },
      kind: reason.kind,
    };
  }
}

export async function deletePublished(
  account: AccountRow,
  noteId: string
): Promise<{ ok: boolean; message: string }> {
  const remoteId = String(noteId || "").trim();
  if (!remoteId) return { ok: false, message: "缺少小红书笔记 ID，无法删除" };
  const { cookieMap } = loginState(account);
  if (!hasCreatorLogin(cookieMap)) {
    return { ok: false, message: "小红书登录态已失效，请重新登录该账号" };
  }
  try {
    const navigated = await creatorNavigate(creatorCookieMap(cookieMap), account.proxy);
    const result = await creatorDeleteNote(navigated.cookieMap, remoteId, account.proxy);
    if (result.success) return { ok: true, message: "小红书笔记已删除" };
    // 公开删除接口已下线（返回 404 / No message available），改用创作中心页面删除。
    if (result.status === 404 || /no message|not found|404/i.test(result.message)) {
      return await deleteXhsNoteViaUi(navigated.cookieMap, remoteId, account.proxy);
    }
    return { ok: false, message: result.message || "小红书删除失败" };
  } catch (error) {
    log.error(
      `小红书账号 ${account.id} 删除笔记 ${remoteId} 失败: ${
        error instanceof Error ? error.stack : String(error)
      }`
    );
    return {
      ok: false,
      message: error instanceof Error ? error.message : "小红书删除请求异常",
    };
  }
}

export async function fetchPublished(
  account: AccountRow,
  cursor: unknown = 0,
  limit = 30
): Promise<PublishedPage> {
  const pageNumber = Math.max(0, Math.trunc(Number(cursor) || 0));
  const size = Math.max(1, Math.trunc(Number(limit) || 30));
  const { cookieMap } = loginState(account);
  if (!hasCreatorLogin(cookieMap)) {
    return {
      ok: false,
      message: "小红书登录态已失效，请重新登录该账号",
      items: [],
      next_cursor: null,
    };
  }
  try {
    const creatorMap = creatorCookieMap(cookieMap);
    const navigated = await creatorNavigate(creatorMap, account.proxy);
    const result = await creatorPostedNotesPage(
      navigated.cookieMap,
      pageNumber,
      account.proxy
    );
    if (!result.success) {
      return {
        ok: false,
        message: friendlyError(result.message, "拉取作品列表失败，请稍后重试"),
        items: [],
        next_cursor: null,
      };
    }
    const data = asRecord(result.payload?.data);
    const notes = Array.isArray(data.notes) ? data.notes : [];
    const items = notes
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
      .map((item) => normalizeNote(item));
    const rawNext = Number(data.page);
    const nextPage = Number.isFinite(rawNext) ? Math.trunc(rawNext) : -1;
    return {
      ok: true,
      message: result.message || "成功",
      items: items.slice(0, size),
      next_cursor: nextPage === -1 ? null : nextPage,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.error(`小红书账号 ${account.id} 拉取已发布作品失败: ${reason}`);
    return {
      ok: false,
      message: reason.includes("小红书") || reason.includes("代理")
        ? reason
        : "拉取作品列表失败，请稍后重试",
      items: [],
      next_cursor: null,
    };
  }
}

export async function fetchComments(
  account: AccountRow,
  note: Record<string, unknown>,
  pages = 3
): Promise<CommentsPage> {
  const { session, cookieMap } = loginState(account);
  if (!hasPcLogin(cookieMap)) {
    return {
      ok: false,
      message: "小红书登录态已失效，请重新登录该账号",
      items: [],
    };
  }
  const remoteId = String(note.remote_note_id || "");
  let noteId = remoteId;
  let token = "";
  const url = String(note.url || "") || (remoteId ? `https://www.xiaohongshu.com/explore/${remoteId}` : "");
  try {
    const parsed = new URL(url);
    noteId = parsed.pathname.replace(/\/+$/, "").split("/").pop() || remoteId;
    token = parsed.searchParams.get("xsec_token") || "";
  } catch {
    /* 地址异常时沿用 remote_note_id */
  }
  const items: NormalizedComment[] = [];
  let cursor = "";
  try {
    const total = Math.max(1, Math.min(10, Math.trunc(Number(pages) || 3)));
    for (let index = 0; index < total; index += 1) {
      const result = await pcCommentsPage(
        cookieMap,
        noteId,
        cursor,
        token,
        account.proxy
      );
      if (result.updated) persistCookies(account, session, result.cookieMap);
      if (!result.success) {
        log.warn(`小红书账号 ${account.id} 读取评论失败: ${result.message}`);
        return { ok: false, message: "评论读取失败，请稍后重试", items };
      }
      const data = asRecord(result.payload?.data);
      const comments = Array.isArray(data.comments) ? data.comments : [];
      for (const raw of comments) {
        if (!raw || typeof raw !== "object") continue;
        const entry = raw as Record<string, unknown>;
        const parent = normalizeComment(entry);
        if (!parent.remote_comment_id) continue;
        items.push(parent);
        const replies = Array.isArray(entry.sub_comments) ? entry.sub_comments : [];
        for (const reply of replies) {
          if (!reply || typeof reply !== "object") continue;
          items.push(
            normalizeComment(
              reply as Record<string, unknown>,
              parent.remote_comment_id
            )
          );
        }
      }
      if (!comments.length || !data.has_more) break;
      const nextCursor = String(data.cursor || "");
      if (!nextCursor || nextCursor === cursor) break;
      cursor = nextCursor;
    }
    return { ok: true, message: "成功", items };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.error(`小红书账号 ${account.id} 读取评论异常: ${reason}`);
    return {
      ok: false,
      message: reason.includes("小红书") || reason.includes("代理")
        ? reason
        : "评论读取失败，请稍后重试",
      items,
    };
  }
}

// ---------------------------------------------------------------- 选题挖掘

export interface MineConfig {
  mode: string;
  keywords?: string[];
  user_urls?: string[];
  per_kw?: number;
  limit?: number;
  sort_type_choice?: number;
  detail_limit?: number;
  product?: boolean;
}

type MineSource = "keyword" | "competitor" | "channel" | "trending";

interface MinedCandidate {
  source: MineSource;
  source_ref: string;
  keyword: string;
  title: string;
  angle: string;
  tone: string;
  product: number;
  liked: number;
  collected: number;
  comments: number;
  shares: number;
  published_at: number;
  xsec_token: string;
  raw: Record<string, unknown>;
}

const SCORE_WEIGHTS = { engagement: 0.45, fresh: 0.15, fit: 0.2, novelty: 0.2 } as const;
const SIMILARITY_THRESHOLD = 0.78;
const TITLE_PUNCT_RE = /[\s\p{P}\p{S}_]+/gu;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cleanList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  return String(value || "")
    .replace(/，/g, ",")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function noteCard(item: Record<string, unknown>): Record<string, unknown> {
  const card = item.note_card;
  return card && typeof card === "object" && !Array.isArray(card)
    ? (card as Record<string, unknown>)
    : item;
}

function noteIdOf(item: Record<string, unknown>): string {
  return String(item.id || item.note_id || noteCard(item).note_id || "");
}

function noteTitleOf(item: Record<string, unknown>): string {
  const card = noteCard(item);
  return String(
    card.display_title ||
      card.title ||
      item.display_title ||
      item.title ||
      ""
  ).trim();
}

function firstSentence(text: string, limit = 62): string {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  const head = cleaned
    .split(/[。！？!?\n]/)
    .map((part) => part.trim())
    .find(Boolean) || "";
  return head.length > limit ? `${head.slice(0, limit).replace(/\s+$/, "")}…` : head;
}

function walkWords(node: unknown, out: string[], depth = 0): void {
  if (depth > 6) return;
  if (Array.isArray(node)) {
    for (const item of node) walkWords(item, out, depth + 1);
    return;
  }
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  for (const key of ["query", "title", "word", "text", "name", "keyword"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 1 && value.length < 40) {
      out.push(value);
    }
  }
  for (const value of Object.values(record)) walkWords(value, out, depth + 1);
}

function normalizeTitle(text: string): string {
  return String(text || "").toLowerCase().replace(TITLE_PUNCT_RE, "");
}

function titleSimilarity(left: string, right: string): number {
  const a = normalizeTitle(left);
  const b = normalizeTitle(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (text: string): Set<string> => {
    const out = new Set<string>();
    for (let index = 0; index < text.length - 1; index += 1) {
      out.add(text.slice(index, index + 2));
    }
    return out;
  };
  const gramsA = grams(a);
  const gramsB = grams(b);
  const union = new Set([...gramsA, ...gramsB]);
  if (!union.size) return 0;
  let intersection = 0;
  for (const gram of gramsA) {
    if (gramsB.has(gram)) intersection += 1;
  }
  return Math.max(
    intersection / union.size,
    intersection / Math.min(gramsA.size, gramsB.size)
  );
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function focusKeywords(): string[] {
  const raw = getSetting("focus_keywords", "").replace(/，/g, ",");
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function scoreCandidate(
  candidate: MinedCandidate,
  maxSimilarity: number,
  focus: string[]
): { score: number; detail: Record<string, unknown> } {
  const stamp = now();
  const weighted =
    candidate.liked +
    candidate.collected * 2 +
    candidate.comments * 3 +
    candidate.shares * 2;
  const engagement = weighted
    ? Math.min(1, Math.log10(1 + Math.max(0, weighted)) / 5)
    : 0;
  let ageDays: number | null = null;
  let fresh = 0.5;
  if (candidate.published_at) {
    ageDays = Math.max(0, (stamp - candidate.published_at) / 86400);
    fresh = Math.exp(-ageDays / 14);
  }
  const haystack = `${candidate.title} ${candidate.keyword}`;
  const hits = focus.filter((word) => word && haystack.includes(word)).length;
  const fit = Math.min(1, 0.35 + 0.2 * hits + (candidate.product ? 0.15 : 0));
  const novelty = Math.max(0, 1 - maxSimilarity);
  const score =
    100 *
    (SCORE_WEIGHTS.engagement * engagement +
      SCORE_WEIGHTS.fresh * fresh +
      SCORE_WEIGHTS.fit * fit +
      SCORE_WEIGHTS.novelty * novelty);
  const detail: Record<string, unknown> = {
    engagement: round(engagement),
    fresh: round(fresh),
    fit: round(fit),
    novelty: round(novelty),
    weighted_interactions: weighted,
    focus_hits: hits,
    max_similarity: round(maxSimilarity),
    age_days: ageDays === null ? null : round(ageDays, 1),
    product: Boolean(candidate.product),
  };
  return { score: Math.round(score * 10) / 10, detail };
}

function candidateFromNote(
  item: Record<string, unknown>,
  source: MineSource,
  keyword: string,
  angle: string,
  product: boolean
): MinedCandidate | null {
  const card = noteCard(item);
  const noteId = noteIdOf(item);
  const title = noteTitleOf(item);
  if (!noteId || !title) return null;
  const interact = asRecord(card.interact_info || card.interact);
  const xsecToken = String(item.xsec_token || "");
  const suffix = xsecToken
    ? `?xsec_token=${encodeURIComponent(xsecToken)}&xsec_source=pc_search`
    : "";
  return {
    source,
    source_ref: noteId,
    keyword,
    title,
    angle,
    tone: "",
    product: product ? 1 : 0,
    liked: parseCount(interact.liked_count),
    collected: parseCount(interact.collected_count),
    comments: parseCount(interact.comment_count),
    shares: parseCount(interact.share_count),
    published_at: timestamp(card.time ?? card.create_time ?? 0),
    xsec_token: xsecToken,
    // 直接把可打开的原文链接一起存下来，选题页无需再回查平台。
    raw: { note_id: noteId, title, xsec_token: xsecToken, url: `https://www.xiaohongshu.com/explore/${noteId}${suffix}` },
  };
}

async function searchSomeNote(
  cookieMap: CookieMap,
  query: string,
  requireNum: number,
  sortTypeChoice: number,
  proxy: string
): Promise<Record<string, unknown>[]> {
  const notes: Record<string, unknown>[] = [];
  const searchId = generateSearchId();
  for (let page = 1; page <= 20; page += 1) {
    const result = await pcSearchNotes(
      cookieMap,
      query,
      page,
      sortTypeChoice,
      searchId,
      proxy
    );
    if (!result.success) throw new Error(result.message || "搜索失败");
    const data = asRecord(result.payload?.data);
    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) break;
    for (const item of items) {
      if (item && typeof item === "object") {
        notes.push(item as Record<string, unknown>);
      }
    }
    if (notes.length >= requireNum || !data.has_more) break;
    await sleep(300);
  }
  return notes.slice(0, requireNum);
}

function parseUserUrl(url: string): {
  userId: string;
  xsecToken: string;
  xsecSource: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("竞品主页链接格式不正确");
  }
  const parts = parsed.pathname.replace(/\/+$/, "").split("/");
  return {
    userId: parts[parts.length - 1] || "",
    xsecToken: parsed.searchParams.get("xsec_token") || "",
    xsecSource: parsed.searchParams.get("xsec_source") || "pc_search",
  };
}

async function userAllNotes(
  cookieMap: CookieMap,
  userUrl: string,
  proxy: string
): Promise<Record<string, unknown>[]> {
  const { userId, xsecToken, xsecSource } = parseUserUrl(userUrl);
  if (!userId) throw new Error("主页链接里没有用户 ID");
  const notes: Record<string, unknown>[] = [];
  let cursor = "";
  for (let page = 0; page < 20; page += 1) {
    const result = await pcUserPostedNotes(
      cookieMap,
      userId,
      cursor,
      xsecToken,
      xsecSource,
      proxy
    );
    if (!result.success) throw new Error(result.message || "拉取失败");
    const data = asRecord(result.payload?.data);
    const batch = Array.isArray(data.notes) ? data.notes : [];
    for (const item of batch) {
      if (item && typeof item === "object") {
        notes.push(item as Record<string, unknown>);
      }
    }
    cursor = data.cursor === undefined ? "" : String(data.cursor);
    if (!batch.length || !data.has_more || !cursor) break;
    await sleep(300);
  }
  return notes;
}

async function homefeedByNum(
  cookieMap: CookieMap,
  category: string,
  requireNum: number,
  proxy: string,
  userId: string
): Promise<Record<string, unknown>[]> {
  const notes: Record<string, unknown>[] = [];
  let cursorScore = "";
  let refreshType = 1;
  let noteIndex = 0;
  for (let page = 0; page < 20; page += 1) {
    const result = await pcHomefeed(
      cookieMap,
      category,
      cursorScore,
      refreshType,
      noteIndex,
      userId,
      proxy
    );
    if (!result.success) throw new Error(result.message || "频道推荐失败");
    const data = asRecord(result.payload?.data);
    const items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) break;
    for (const item of items) {
      if (item && typeof item === "object") {
        notes.push(item as Record<string, unknown>);
      }
    }
    cursorScore = String(data.cursor_score || "");
    refreshType = 3;
    noteIndex += 20;
    if (notes.length > requireNum) break;
  }
  return notes.slice(0, requireNum);
}

/** 给互动最高的若干条补正文与真实互动；失败只记错误，不影响入池。 */
async function enrichCandidates(
  cookieMap: CookieMap,
  candidates: MinedCandidate[],
  detailLimit: number,
  proxy: string,
  userId: string
): Promise<string[]> {
  const errors: string[] = [];
  if (detailLimit <= 0) return errors;
  const ranked = [...candidates]
    .sort(
      (left, right) =>
        right.liked +
        right.collected * 2 +
        right.comments * 3 -
        (left.liked + left.collected * 2 + left.comments * 3)
    )
    .slice(0, detailLimit);
  for (const candidate of ranked) {
    try {
      const result = await pcNoteInfo(
        cookieMap,
        candidate.source_ref,
        candidate.xsec_token,
        userId,
        proxy
      );
      if (!result.success) continue;
      const data = asRecord(result.payload?.data);
      const items = Array.isArray(data.items) ? data.items : [];
      const first = items[0];
      if (!first || typeof first !== "object") continue;
      const card = noteCard(first as Record<string, unknown>);
      const desc = String(card.desc || "").trim();
      if (desc && !candidate.angle) candidate.angle = firstSentence(desc);
      const interact = asRecord(card.interact_info);
      const liked = parseCount(interact.liked_count);
      const collected = parseCount(interact.collected_count);
      const comments = parseCount(interact.comment_count);
      const shares = parseCount(interact.share_count);
      if (liked) candidate.liked = Math.max(candidate.liked, liked);
      if (collected) candidate.collected = Math.max(candidate.collected, collected);
      if (comments) candidate.comments = Math.max(candidate.comments, comments);
      if (shares) candidate.shares = Math.max(candidate.shares, shares);
      const published = timestamp(card.time ?? card.create_time ?? 0);
      if (published) candidate.published_at = published;
      candidate.raw.desc = desc.slice(0, 300);
      await sleep(300);
    } catch (error) {
      errors.push(`详情 ${candidate.source_ref}: ${errorText(error)}`);
    }
  }
  return errors;
}

/**
 * 选题挖掘入口：keyword / competitor / channel / trending。
 * 结果统一入选题池，返回 {inserted, skipped, errors, items, dedupes}。
 */
export async function mine(
  account: AccountRow,
  config: MineConfig
): Promise<Record<string, unknown>> {
  const mode = String(config.mode || "keyword");
  if (!["keyword", "competitor", "channel", "trending"].includes(mode)) {
    throw new Error("mode 只支持 keyword / competitor / channel / trending");
  }
  const { session, cookieMap } = loginState(account);
  if (!hasPcLogin(cookieMap)) {
    throw new Error("小红书登录态已失效，请重新登录该账号");
  }
  const errors: string[] = [];
  const proxy = account.proxy;
  let userId = String(session.user_id || account.user_id || "");
  if (!userId) {
    try {
      const me = await pcUserMe(cookieMap, proxy);
      const data = asRecord(me.payload?.data);
      userId = String(data.user_id || "");
      if (me.updated) persistCookies(account, session, me.cookieMap);
    } catch {
      /* 频道与详情需要 xy-direction；拿不到时由接口自身报错 */
    }
  }

  const candidates: MinedCandidate[] = [];
  const seen = new Set<string>();
  const push = (candidate: MinedCandidate | null): void => {
    if (!candidate || seen.has(candidate.source_ref)) return;
    seen.add(candidate.source_ref);
    candidates.push(candidate);
  };

  if (mode === "keyword") {
    const keywords = cleanList(config.keywords);
    if (!keywords.length) throw new Error("关键词挖掘需要至少一个关键词");
    const perKw = Math.max(1, Math.trunc(Number(config.per_kw || 20)));
    const sortTypeChoice = Number(config.sort_type_choice || 0);
    const product = Boolean(config.product);
    for (const keyword of keywords) {
      try {
        const notes = await searchSomeNote(
          cookieMap,
          keyword,
          perKw,
          sortTypeChoice,
          proxy
        );
        for (const item of notes) {
          const model = item.model_type;
          if (model !== undefined && model !== null && model !== "note") continue;
          push(candidateFromNote(item, "keyword", keyword, "", product));
        }
      } catch (error) {
        errors.push(`搜索 ${keyword}: ${errorText(error)}`);
      }
      await sleep(600);
    }
  } else if (mode === "competitor") {
    const urls = cleanList(config.user_urls);
    if (!urls.length) throw new Error("竞品挖掘需要至少一个主页链接");
    const limitPerUser = Math.max(1, Math.trunc(Number(config.limit || 30)));
    for (const url of urls) {
      try {
        const notes = await userAllNotes(cookieMap, url, proxy);
        for (const item of notes.slice(0, limitPerUser)) {
          push(
            candidateFromNote(item, "competitor", "", "竞品高互动笔记", false)
          );
        }
      } catch (error) {
        errors.push(`竞品 ${url}: ${errorText(error)}`);
      }
      await sleep(600);
    }
  } else if (mode === "channel") {
    const categories = cleanList(config.keywords);
    if (!categories.length) throw new Error("频道挖掘需要至少一个频道名");
    const limit = Math.max(1, Math.trunc(Number(config.limit || 30)));
    for (const category of categories) {
      try {
        const notes = await homefeedByNum(
          cookieMap,
          category,
          limit,
          proxy,
          userId
        );
        for (const item of notes.slice(0, limit)) {
          push(
            candidateFromNote(
              item,
              "channel",
              category,
              "频道推荐里正在起量的题",
              false
            )
          );
        }
      } catch (error) {
        errors.push(`频道 ${category}: ${errorText(error)}`);
      }
      await sleep(600);
    }
  } else {
    const limit = Math.max(1, Math.trunc(Number(config.limit || 30)));
    try {
      const result = await pcTrendingQueries(cookieMap, proxy);
      if (!result.success) throw new Error(result.message || "热榜接口失败");
      const words: string[] = [];
      walkWords(result.payload, words);
      for (const raw of words) {
        if (candidates.length >= limit) break;
        const word = raw.trim();
        if (word.length < 2) continue;
        push({
          source: "trending",
          source_ref: word,
          keyword: word,
          title: `${word}，普通人怎么接住这个话题`,
          angle: `热榜词「${word}」的内容结构参考`,
          tone: "informative",
          product: 0,
          liked: 0,
          collected: 0,
          comments: 0,
          shares: 0,
          published_at: 0,
          xsec_token: "",
          raw: { word },
        });
      }
    } catch (error) {
      errors.push(errorText(error));
    }
  }

  if (mode !== "trending") {
    const detailLimit = Math.max(
      0,
      Math.trunc(Number(config.detail_limit ?? 5))
    );
    errors.push(
      ...(await enrichCandidates(
        cookieMap,
        candidates,
        detailLimit,
        proxy,
        userId
      ))
    );
  }

  const poolTitles = queryAll<{ title: string }>("SELECT title FROM topics").map(
    (row) => String(row.title || "")
  );
  const focus = focusKeywords();
  const scored: Record<string, unknown>[] = [];
  let similarSkipped = 0;
  for (const candidate of candidates) {
    const title = candidate.title.trim();
    if (!title) {
      similarSkipped += 1;
      continue;
    }
    let maxSimilarity = 0;
    for (const existing of poolTitles) {
      maxSimilarity = Math.max(maxSimilarity, titleSimilarity(title, existing));
    }
    if (maxSimilarity >= SIMILARITY_THRESHOLD) {
      similarSkipped += 1;
      continue;
    }
    const { score, detail } = scoreCandidate(candidate, maxSimilarity, focus);
    scored.push({
      source: candidate.source,
      source_ref: candidate.source_ref,
      keyword: candidate.keyword,
      category: "",
      title,
      angle: candidate.angle,
      tone: candidate.tone,
      product: candidate.product,
      score,
      score_detail: detail,
      raw: candidate.raw,
    });
    poolTitles.push(title);
  }

  const result = ingest(scored);
  return {
    inserted: Number(result.inserted || 0),
    skipped: Number(result.skipped || 0) + similarSkipped,
    errors: errors.slice(-10),
    items: result.items,
    dedupes: result.dedupes,
  };
}
