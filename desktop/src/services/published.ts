/** 已发布内容：平台缓存 + 本地发布记录合并查询，以及指标/评论只读视图。 */
import { execute, getDb, queryAll, queryOne } from "../core/db";
import { now } from "../core/config";
import { decryptSession, getAccount } from "../core/accounts";
import { deletePublished as deleteXhsNote } from "../platforms/xiaohongshu/adapter";
import { deletePublished as deleteDouyinNote } from "../platforms/douyin/adapter";
import { deleteDraft as deleteWechatDraft } from "../platforms/wechat/publish";
import {
  DEFAULT_PLATFORM,
  listPlatforms,
  normalizePlatform,
  platformLabel,
  platformMeta,
} from "../core/platform";

const SYNC_INTERVAL_HOURS = 6;
const SYNC_PAGE_LIMIT = 30;
const LOCAL_RECORD_LIMIT = 500;
const PUBLISHED_QUERY_LIMIT = Math.max(100, Number(process.env.OPS_PUBLISHED_QUERY_LIMIT || 2000));

function firstImage(value: unknown): string {
  try {
    const items = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(items) && items.length ? String(items[0] || "") : "";
  } catch {
    return "";
  }
}

function visibilityLabel(value: unknown): string {
  return Math.trunc(Number(value || 0)) === 1 ? "仅自己可见" : "公开";
}

function safeSyncError(text: unknown): string {
  const value = String(text || "").trim();
  if (!value) return "";
  const lowered = value.toLowerCase();
  if (["error", "exception", "traceback", "http://", "https://", "curl"].some((token) => lowered.includes(token))) {
    return "同步失败，请稍后重试（详见日志）";
  }
  return value.slice(0, 200);
}

export function commentsMode(platform: string): "read" | "probe" | "none" {
  return platformMeta(platform).comments_mode;
}

function noteUrl(platform: string, remoteId: string): string {
  if (platform === "xiaohongshu" && remoteId) return `https://www.xiaohongshu.com/explore/${remoteId}`;
  return "";
}

function syncedItem(row: Record<string, unknown>, local: Record<string, unknown> = {}): Record<string, unknown> {
  const platform = String(row.platform || DEFAULT_PLATFORM);
  const mode = commentsMode(platform);
  return {
    id: row.id,
    platform,
    platform_name: platformLabel(platform),
    account_id: row.account_id,
    account_name: row.account_nickname || row.account_name || "",
    remote_note_id: row.remote_note_id,
    title: row.title,
    desc: row.desc,
    cover: row.cover,
    cover_kind: "remote",
    note_type: row.note_type,
    visibility: row.visibility || "平台未返回",
    views: row.views,
    likes: row.likes,
    comments: row.comments,
    collects: row.collects,
    metrics_available: ["views", "likes", "comments", "collects"].some((name) => row[name] !== null),
    published_at: row.published_at,
    url: row.url || noteUrl(platform, String(row.remote_note_id || "")),
    source: "platform",
    needs_sync: false,
    synced_at: row.synced_at,
    metrics_synced_at: Number(row.metrics_synced_at || 0),
    comment_synced_at: Number(row.comment_synced_at || 0),
    health_state: row.health_state || "unknown",
    health_note: row.health_note || "",
    health_checked_at: Number(row.health_checked_at || 0),
    comments_supported: mode === "read" ? true : mode === "probe" ? null : false,
    comments_mode: mode,
    local_draft_id: local.draft_id ?? null,
    local_draft_title: local.draft_title || "",
  };
}

function localItem(row: Record<string, unknown>): Record<string, unknown> {
  const platform = String(row.platform || DEFAULT_PLATFORM);
  const mode = commentsMode(platform);
  return {
    id: null,
    platform,
    platform_name: platformLabel(platform),
    account_id: row.account_id,
    account_name: row.account_nickname || row.account_name || "",
    remote_note_id: row.remote_note_id,
    title: row.draft_title || "(草稿已删除)",
    desc: row.draft_desc || "",
    cover: firstImage(row.draft_images),
    cover_kind: "local",
    note_type: row.draft_media || "image",
    visibility: visibilityLabel(row.draft_visibility),
    views: null,
    likes: null,
    comments: null,
    collects: null,
    metrics_available: false,
    published_at: row.created_at,
    url: noteUrl(platform, String(row.remote_note_id || "")),
    source: "local_record",
    needs_sync: true,
    synced_at: 0,
    metrics_synced_at: 0,
    comment_synced_at: 0,
    health_state: "unknown",
    health_note: "尚未同步到平台数据",
    health_checked_at: 0,
    comments_supported: mode === "read" ? true : mode === "probe" ? null : false,
    comments_mode: mode,
    local_draft_id: row.draft_id,
    local_draft_title: row.draft_title || "",
  };
}

export function accountsStatus(platform = ""): Record<string, unknown>[] {
  let sql = "SELECT * FROM accounts";
  const args: unknown[] = [];
  if (platform) {
    sql += " WHERE platform = ?";
    args.push(normalizePlatform(platform));
  }
  sql += " ORDER BY id";
  return queryAll<Record<string, unknown>>(sql, ...args).map((row) => {
    const key = String(row.platform || DEFAULT_PLATFORM);
    const count = queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM published_notes WHERE account_id = ?",
      row.id
    );
    return {
      account_id: row.id,
      account_name: row.nickname || row.name,
      platform: key,
      platform_name: platformLabel(key),
      enabled: Boolean(row.enabled),
      ready: platformMeta(key).status === "ready",
      synced_at: row.published_synced_at,
      sync_error: safeSyncError(row.published_sync_error),
      cached_count: Number(count?.n || 0),
    };
  });
}

export function sourcesMeta(): Record<string, unknown> {
  const platforms: Record<string, unknown> = {};
  for (const item of listPlatforms()) {
    platforms[String(item.key)] = {
      name: item.name,
      ready: item.ready,
      data_sources: item.data_sources,
    };
  }
  return {
    from_platform: [
      "封面、标题、发布时间、笔记类型",
      "阅读/播放、点赞、评论、收藏",
      "原帖链接（由远端笔记 ID 拼接）",
      "可见范围（平台返回时使用，缺失时显示「平台未返回」）",
    ],
    local_only: [
      "草稿关联（local_draft_id / local_draft_title）",
      "发布账号与发布执行时间",
      "模拟发布标记（模拟记录不会出现在已发布内容里）",
    ],
    merge_rule:
      "同一账号的同一 remote_note_id 只出现一次；平台同步优先，未同步的真实记录以 source=local_record 占位。",
    sync: {
      interval_hours: SYNC_INTERVAL_HOURS,
      max_pages_per_run: 20,
      page_size: SYNC_PAGE_LIMIT,
      manual: "POST /api/published/sync",
      failure: "同步失败写入账号的 sync_error，页面展示最近一次错误；已缓存内容不受影响。",
      truncation: `列表查询上限 ${PUBLISHED_QUERY_LIMIT} 条，超过时 meta.truncated=true 并给出提示。`,
    },
    platforms,
  };
}

export interface PublishedQuery {
  account_id?: number;
  platform?: string;
  since?: number;
  until?: number;
  keyword?: string;
  health?: string;
  limit?: number;
  offset?: number;
  include_local?: boolean;
}

export function listNotes(query: PublishedQuery): Record<string, unknown> {
  const platform = query.platform ? normalizePlatform(query.platform) : "";
  const limit = Math.max(1, Math.min(100, Math.trunc(query.limit || 20)));
  const offset = Math.max(0, Math.trunc(query.offset || 0));
  const since = Math.max(0, Math.trunc(query.since || 0));
  const until = Math.max(0, Math.trunc(query.until || 0));
  const keyword = String(query.keyword || "").trim().toLowerCase();
  const includeLocal = query.include_local !== false;

  let sql =
    "SELECT p.*, a.name AS account_name, a.nickname AS account_nickname, a.platform AS account_platform " +
    "FROM published_notes p LEFT JOIN accounts a ON a.id = p.account_id WHERE 1=1";
  const args: unknown[] = [];
  if (query.account_id) {
    sql += " AND p.account_id = ?";
    args.push(query.account_id);
  }
  if (platform) {
    sql += " AND p.platform = ?";
    args.push(platform);
  }
  if (since) {
    sql += " AND p.published_at >= ?";
    args.push(since);
  }
  if (until) {
    sql += " AND p.published_at <= ?";
    args.push(until);
  }
  sql += " ORDER BY p.published_at DESC, p.id DESC LIMIT ?";
  args.push(PUBLISHED_QUERY_LIMIT + 1);
  const syncedRows = queryAll<Record<string, unknown>>(sql, ...args);
  const syncedTruncated = syncedRows.length > PUBLISHED_QUERY_LIMIT;
  const merged = new Map<string, Record<string, unknown>>();
  const localMap = new Map<string, Record<string, unknown>>();

  if (syncedRows.length) {
    const keys = syncedRows
      .slice(0, PUBLISHED_QUERY_LIMIT)
      .map((row) => String(row.remote_note_id || ""));
    const placeholders = keys.map(() => "?").join(",");
    const localRows = queryAll<Record<string, unknown>>(
      "SELECT r.account_id, r.remote_note_id, r.draft_id, d.title AS draft_title " +
        "FROM records r LEFT JOIN drafts d ON d.id = r.draft_id " +
        `WHERE r.success = 1 AND r.remote_note_id IN (${placeholders}) AND r.message NOT LIKE '模拟发布%' ORDER BY r.id DESC`,
      ...keys
    );
    for (const row of localRows) {
      const key = `${row.account_id}|${row.remote_note_id}`;
      if (!localMap.has(key)) {
        localMap.set(key, { draft_id: row.draft_id, draft_title: row.draft_title || "" });
      }
    }
  }

  for (const row of syncedRows.slice(0, PUBLISHED_QUERY_LIMIT)) {
    const key = `${row.account_id}|${row.remote_note_id}`;
    merged.set(key, syncedItem(row, localMap.get(key) || {}));
  }

  let localTruncated = false;
  if (includeLocal) {
    let localSql =
      "SELECT r.id, r.account_id, r.platform, r.draft_id, r.remote_note_id, r.created_at, " +
      "d.title AS draft_title, d.desc AS draft_desc, d.visibility AS draft_visibility, " +
      "d.images AS draft_images, d.media_type AS draft_media, a.name AS account_name, " +
      "a.nickname AS account_nickname FROM records r " +
      "LEFT JOIN drafts d ON d.id = r.draft_id LEFT JOIN accounts a ON a.id = r.account_id " +
      "WHERE r.success = 1 AND r.remote_note_id != '' AND r.message NOT LIKE '模拟发布%' " +
      "AND IFNULL(r.result, '') NOT LIKE '%simulated%'";
    const localArgs: unknown[] = [];
    if (query.account_id) {
      localSql += " AND r.account_id = ?";
      localArgs.push(query.account_id);
    }
    if (platform) {
      localSql += " AND r.platform = ?";
      localArgs.push(platform);
    }
    if (since) {
      localSql += " AND r.created_at >= ?";
      localArgs.push(since);
    }
    if (until) {
      localSql += " AND r.created_at <= ?";
      localArgs.push(until);
    }
    localSql += " ORDER BY r.id DESC LIMIT ?";
    localArgs.push(LOCAL_RECORD_LIMIT + 1);
    const localRows = queryAll<Record<string, unknown>>(localSql, ...localArgs);
    localTruncated = localRows.length > LOCAL_RECORD_LIMIT;
    for (const row of localRows.slice(0, LOCAL_RECORD_LIMIT)) {
      const key = `${row.account_id}|${row.remote_note_id}`;
      if (merged.has(key)) continue;
      merged.set(key, localItem(row));
    }
  }

  let items = [...merged.values()];
  if (keyword) {
    items = items.filter((item) =>
      `${item.title || ""} ${item.desc || ""}`.toLowerCase().includes(keyword)
    );
  }
  const health = String(query.health || "").trim();
  if (health) {
    const attention = new Set(["zero_views", "risky", "removed"]);
    items =
      health === "attention"
        ? items.filter((item) => attention.has(String(item.health_state)))
        : items.filter((item) => item.health_state === health);
  }
  items.sort((left, right) => {
    const diff = Number(right.published_at || 0) - Number(left.published_at || 0);
    if (diff) return diff;
    return String(right.remote_note_id || "").localeCompare(String(left.remote_note_id || ""));
  });
  const total = items.length;
  const truncated = syncedTruncated || localTruncated;
  const notice = truncated
    ? `当前筛选结果超过 ${PUBLISHED_QUERY_LIMIT} 条平台缓存 / ${LOCAL_RECORD_LIMIT} 条本地记录，列表只统计最近部分内容；请缩窄账号或时间范围后再查看。`
    : "";
  return {
    items: items.slice(offset, offset + limit),
    total,
    limit,
    offset,
    filters: {
      account_id: query.account_id || 0,
      platform,
      since,
      until,
      keyword,
      health,
      include_local: includeLocal,
    },
    meta: {
      accounts: accountsStatus(platform),
      sources: sourcesMeta(),
      sync_interval_hours: SYNC_INTERVAL_HOURS,
      truncated,
      total_exact: !truncated,
      query_limit: PUBLISHED_QUERY_LIMIT,
      truncated_sources: [
        ...(syncedTruncated ? ["platform"] : []),
        ...(localTruncated ? ["local_record"] : []),
      ],
      notice,
    },
  };
}

export async function deletePublishedContent(input: {
  platform: unknown;
  account_id: unknown;
  remote_note_id: unknown;
}): Promise<{ ok: boolean; message: string }> {
  const platform = normalizePlatform(input.platform);
  const accountId = Math.trunc(Number(input.account_id || 0));
  const remoteId = String(input.remote_note_id || "").trim();
  if (!accountId) return { ok: false, message: "缺少账号 ID，无法删除" };
  if (!remoteId) return { ok: false, message: "缺少平台内容 ID，无法删除" };
  const account = getAccount(accountId);
  let result: { ok: boolean; message: string };
  if (platform === "xiaohongshu") {
    result = await deleteXhsNote(account, remoteId);
  } else if (platform === "douyin") {
    result = await deleteDouyinNote(decryptSession(account), remoteId, account.proxy || "");
  } else if (platform === "wechat_mp") {
    result = await deleteWechatDraft(decryptSession(account), remoteId, account.proxy || "");
  } else {
    return { ok: false, message: `暂不支持删除 ${platformLabel(platform)} 的内容` };
  }
  if (!result.ok) return result;
  const stamp = now();
  getDb().transaction(() => {
    execute(
      "DELETE FROM published_notes WHERE platform=? AND account_id=? AND remote_note_id=?",
      platform,
      accountId,
      remoteId
    );
    execute(
      "DELETE FROM note_comments WHERE platform=? AND remote_note_id=?",
      platform,
      remoteId
    );
    execute(
      "DELETE FROM records WHERE platform=? AND account_id=? AND remote_note_id=?",
      platform,
      accountId,
      remoteId
    );
    execute(
      "UPDATE accounts SET published_synced_at=?, updated_at=? WHERE id=?",
      stamp,
      stamp,
      accountId
    );
  })();
  return result;
}

function noteRow(noteId: number): Record<string, unknown> {
  const row = queryOne<Record<string, unknown>>("SELECT * FROM published_notes WHERE id=?", noteId);
  if (!row) throw Object.assign(new Error(`作品不存在: ${noteId}`), { status: 404 });
  return row;
}

/** 落库一批只读评论（同平台同笔记按远端评论 ID 覆盖更新）。 */
export function saveComments(noteId: number, comments: Record<string, unknown>[]): number {
  const note = noteRow(noteId);
  const platform = String(note.platform || DEFAULT_PLATFORM);
  const remoteNoteId = String(note.remote_note_id || "");
  const accountId = Number(note.account_id || 0);
  const stamp = now();
  const write = getDb().transaction(() => {
    let count = 0;
    for (const item of comments) {
      const remoteId = String(item.remote_comment_id || "");
      if (!remoteId) continue;
      execute(
        "INSERT INTO note_comments(platform, account_id, remote_note_id, remote_comment_id, author, " +
          "author_id, content, likes, is_reply, parent_comment_id, commented_at, synced_at) " +
          "VALUES(?,?,?,?,?,?,?,?,?,?,?,?) " +
          "ON CONFLICT(platform, remote_note_id, remote_comment_id) DO UPDATE SET " +
          "author=excluded.author, author_id=excluded.author_id, content=excluded.content, " +
          "likes=excluded.likes, is_reply=excluded.is_reply, " +
          "parent_comment_id=excluded.parent_comment_id, commented_at=excluded.commented_at, " +
          "synced_at=excluded.synced_at",
        platform,
        accountId,
        remoteNoteId,
        remoteId,
        String(item.author || ""),
        String(item.author_id || ""),
        String(item.content || "").slice(0, 4000),
        item.likes === null || item.likes === undefined ? null : Number(item.likes),
        item.is_reply ? 1 : 0,
        String(item.parent_comment_id || ""),
        Number(item.commented_at || 0),
        stamp
      );
      count += 1;
    }
    execute(
      "UPDATE published_notes SET comment_synced_at=? WHERE id=?",
      stamp,
      noteId
    );
    return count;
  });
  return write();
}

export function metrics(noteId: number, days = 30): Record<string, unknown> {
  const note = noteRow(noteId);
  const span = Math.max(1, Math.min(90, Math.trunc(days || 30)));
  const today = new Date();
  const start = new Date(today.getTime() - (span - 1) * 86400_000);
  const rows = queryAll<Record<string, unknown>>(
    "SELECT * FROM published_metrics_daily WHERE note_id=? AND day >= ? ORDER BY day",
    noteId,
    fmtDay(start)
  );
  const byDay = new Map<string, Record<string, unknown>>();
  for (const row of rows) byDay.set(String(row.day), row);
  const series: Record<string, unknown>[] = [];
  let missing = 0;
  for (let offset = 0; offset < span; offset += 1) {
    const day = new Date(start.getTime() + offset * 86400_000);
    const key = fmtDay(day);
    const row = byDay.get(key);
    if (!row && key === fmtDay(today)) {
      if (["views", "likes", "comments", "collects"].some((name) => note[name] !== null)) {
        series.push({ day: key, views: note.views, likes: note.likes, comments: note.comments, collects: note.collects });
        continue;
      }
    }
    if (!row) {
      missing += 1;
      series.push({ day: key, views: null, likes: null, comments: null, collects: null });
    } else {
      series.push({ day: key, views: row.views, likes: row.likes, comments: row.comments, collects: row.collects });
    }
  }
  return {
    note: {
      id: note.id,
      title: note.title,
      remote_note_id: note.remote_note_id,
      platform: note.platform,
      platform_name: platformLabel(String(note.platform || "")),
      url: note.url,
    },
    days: span,
    series,
    missing_days: missing,
    current: {
      views: note.views,
      likes: note.likes,
      comments: note.comments,
      collects: note.collects,
      captured_at: Number(note.metrics_synced_at || note.synced_at || 0),
    },
    hint: "平台未返回的日期显示为断点，不按 0 处理。",
  };
}

function fmtDay(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function listComments(noteId: number, limit = 20, offset = 0): Record<string, unknown> {
  const note = noteRow(noteId);
  const platform = String(note.platform || DEFAULT_PLATFORM);
  const mode = commentsMode(platform);
  const size = Math.max(1, Math.min(100, Math.trunc(limit || 20)));
  const start = Math.max(0, Math.trunc(offset));
  const rows = queryAll<Record<string, unknown>>(
    "SELECT * FROM note_comments WHERE platform=? AND remote_note_id=? " +
      "ORDER BY commented_at DESC, id DESC LIMIT ? OFFSET ?",
    platform,
    note.remote_note_id,
    size,
    start
  );
  const total = Number(
    queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM note_comments WHERE platform=? AND remote_note_id=?",
      platform,
      note.remote_note_id
    )?.n || 0
  );
  const onlyFeatured = platform === "wechat_mp";
  let emptyText = "";
  if (!total) {
    if (mode === "probe") emptyText = "还没有缓存公众号精选留言；点「探测并同步」确认是否有留言权限。";
    else if (mode === "none") emptyText = `${platformLabel(platform)} 暂不支持评论同步`;
    else emptyText = "平台未展示评论";
  }
  return {
    note_id: note.id,
    title: note.title,
    platform,
    platform_name: platformLabel(platform),
    supported: mode === "read" ? true : mode === "probe" ? null : false,
    comments_mode: mode,
    only_featured: onlyFeatured,
    notice: onlyFeatured
      ? "公众号只能读取精选留言，不是全量评论；首次点「探测并同步」会确认权限。"
      : mode === "read"
        ? "严格只读：不回复、不点赞、不删除。"
        : "",
    items: rows.map((row) => ({
      id: row.id,
      remote_comment_id: row.remote_comment_id,
      author: row.author,
      content: row.content,
      likes: row.likes,
      is_reply: Boolean(row.is_reply),
      parent_comment_id: row.parent_comment_id,
      commented_at: row.commented_at,
      synced_at: row.synced_at,
    })),
    total,
    limit: size,
    offset: start,
    synced_at: Number(note.comment_synced_at || 0),
    empty_text: emptyText,
  };
}
