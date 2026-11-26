/** 草稿：序列化、列表、创建、修改、切平台与删除。 */
import fs from "node:fs";
import path from "node:path";
import { now, ASSETS_DIR, DESIGN_DIR, UPLOAD_DIR } from "../core/config";
import { execute, getDb, queryAll, queryOne } from "../core/db";
import {
  complianceIssues,
  normalizeDraftFields,
  normalizeTitle,
  normalizeTopics,
  normalizeDesc,
  stripTagLines,
} from "../core/contentText";
import {
  DEFAULT_PLATFORM,
  normalizePlatform,
  platformLabel,
  specForMedia,
  specOf,
  validateDraft,
} from "../core/platform";
import { listDraftJobs } from "./queue";

interface DraftRow {
  id: number;
  topic_id: number | null;
  account_id: number | null;
  platform: string;
  content_type: string;
  title: string;
  desc: string;
  body_md: string;
  body_html: string;
  wx_theme: string;
  media_type: string;
  visibility: number;
  images: string;
  topics: string;
  content_json?: string;
  status: string;
  compliance: string;
  source_note: string;
  created_at: number;
  updated_at: number;
}

function jsonField<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "object") return value as T;
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

export function serializeDraft(row: DraftRow): Record<string, unknown> {
  const platform = row.platform || DEFAULT_PLATFORM;
  const spec = specOf(platform, row.content_type);
  return {
    id: row.id,
    topic_id: row.topic_id,
    account_id: row.account_id,
    platform,
    platform_name: platformLabel(platform),
    platform_ready: true,
    content_type: row.content_type || spec.key,
    content_type_label: spec.label,
    spec,
    title: row.title,
    desc: row.desc,
    body_md: row.body_md || "",
    body_html: row.body_html || "",
    wx_theme: row.wx_theme || "",
    media_type: row.media_type,
    visibility: row.visibility,
    images: jsonField<string[]>(row.images, []),
    topics: jsonField<string[]>(row.topics, []),
    content_json: jsonField<Record<string, unknown>>(row.content_json, {}),
    status: row.status,
    compliance: jsonField<unknown[]>(row.compliance, []),
    source_note: row.source_note,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function decorateDraft(draft: Record<string, unknown>): Record<string, unknown> {
  const topic = draft.topic_id
    ? queryOne<{ keyword: string; angle: string }>(
        "SELECT keyword, angle FROM topics WHERE id = ?",
        draft.topic_id as number
      )
    : undefined;
  draft.keyword = topic?.keyword || "";
  draft.angle = topic?.angle || "";
  const platform = String(draft.platform || DEFAULT_PLATFORM);
  const problems = validateDraft(
    platform,
    {
      title: String(draft.title || ""),
      desc: String(draft.desc || ""),
      images: (draft.images as unknown[]) || [],
      media_type: String(draft.media_type || ""),
    },
    String(draft.content_type || "")
  );
  draft.spec_problems = problems;
  const compliance = (draft.compliance as unknown[]) || [];
  draft.can_publish =
    draft.status !== "published" && compliance.length === 0 && problems.length === 0;
  draft.jobs = listDraftJobs(Number(draft.id));
  return draft;
}

export function getDraftRow(draftId: number): DraftRow {
  const row = queryOne<DraftRow>("SELECT * FROM drafts WHERE id = ?", draftId);
  if (!row) throw Object.assign(new Error(`草稿不存在: ${draftId}`), { status: 404 });
  return row;
}

export function getDraft(draftId: number): Record<string, unknown> {
  return decorateDraft(serializeDraft(getDraftRow(draftId)));
}

export function listDrafts(status = "", limit = 200, offset = 0, platform = ""): Record<string, unknown>[] {
  let sql = "SELECT * FROM drafts WHERE 1 = 1";
  const args: unknown[] = [];
  if (status) {
    sql += " AND status = ?";
    args.push(status);
  }
  if (platform) {
    sql += " AND platform = ?";
    args.push(platform);
  }
  sql += " ORDER BY id DESC LIMIT ? OFFSET ?";
  args.push(Math.max(1, limit), Math.max(0, Math.trunc(offset)));
  const rows = queryAll<DraftRow>(sql, ...args);
  return rows.map((row) => {
    const item = serializeDraft(row);
    const job = queryOne<{ status: string }>(
      "SELECT status FROM jobs WHERE draft_id = ? ORDER BY id DESC LIMIT 1",
      row.id
    );
    item.job_status = job?.status || "";
    return decorateDraft(item);
  });
}

export function countDrafts(status = "", platform = ""): number {
  let sql = "SELECT COUNT(*) AS n FROM drafts WHERE 1 = 1";
  const args: unknown[] = [];
  if (status) {
    sql += " AND status = ?";
    args.push(status);
  }
  if (platform) {
    sql += " AND platform = ?";
    args.push(platform);
  }
  const row = queryOne<{ n: number }>(sql, ...args);
  return Number(row?.n || 0);
}

export interface ManualDraftInput {
  title: string;
  desc: string;
  topics?: unknown;
  images?: string[];
  visibility?: number;
  media_type?: string;
  account_id?: number | null;
  topic_id?: number | null;
  source_note?: string;
  platform?: string;
  content_type?: string;
  body_md?: string;
  body_html?: string;
  wx_theme?: string;
}

export function createManual(input: ManualDraftInput): Record<string, unknown> {
  const platform = normalizePlatform(input.platform || DEFAULT_PLATFORM);
  const spec = input.content_type
    ? specOf(platform, input.content_type)
    : specForMedia(platform, input.media_type || "image");
  const normalized = normalizeDraftFields(
    platform,
    { title: input.title, desc: input.desc, topics: input.topics, images: input.images },
    spec.key
  );
  if (!normalized.title) throw new Error("标题不能为空");
  if (!normalized.desc) throw new Error("正文不能为空");
  const body = stripTagLines(normalized.desc);
  const stamp = now();
  const draftId = execute(
    "INSERT INTO drafts(topic_id, account_id, platform, content_type, title, desc, body_md, " +
      "body_html, wx_theme, media_type, visibility, images, topics, status, compliance, " +
      "source_note, created_at, updated_at) " +
      "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?,?,?)",
    input.topic_id ?? null,
    input.account_id ?? null,
    platform,
    spec.key,
    normalized.title,
    normalizeDesc(body, normalized.topics, spec.desc_max, platform),
    String(input.body_md || ""),
    String(input.body_html || ""),
    String(input.wx_theme || ""),
    spec.media_type === "video" ? "video" : "image",
    Math.trunc(Number(input.visibility || 0)),
    JSON.stringify(normalized.images),
    JSON.stringify(normalized.topics),
    JSON.stringify(complianceIssues(`${normalized.title}\n${body}`)),
    String(input.source_note || ""),
    stamp,
    stamp
  );
  return getDraft(draftId);
}

export function updateDraft(draftId: number, fields: Record<string, unknown>): Record<string, unknown> {
  const current = getDraft(draftId);
  const platform = String(current.platform);
  const spec = specOf(platform, String(current.content_type || ""));
  const allowed = [
    "title",
    "desc",
    "body_md",
    "body_html",
    "wx_theme",
    "media_type",
    "visibility",
    "images",
    "topics",
    "account_id",
    "status",
    "content_json",
  ];
  const updates: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (allowed.includes(key)) updates[key] = value;
  }
  if (!Object.keys(updates).length) return current;
  if ("title" in updates) {
    updates.title = normalizeTitle(String(updates.title), String(current.title || ""), spec.title_max);
  }
  const topicsChanged = "topics" in updates;
  const topics = topicsChanged
    ? normalizeTopics(updates.topics)
    : normalizeTopics(current.topics);
  if (topicsChanged) updates.topics = JSON.stringify(topics);
  if ("desc" in updates) {
    let body = String(updates.desc || "");
    if (topicsChanged) body = stripTagLines(body);
    updates.desc = normalizeDesc(body, topics, spec.desc_max, platform);
  } else if (topicsChanged) {
    updates.desc = normalizeDesc(
      stripTagLines(String(current.desc || "")),
      topics,
      spec.desc_max,
      platform
    );
  }
  if ("images" in updates) updates.images = JSON.stringify((updates.images as unknown[]) || []);
  if ("content_json" in updates) {
    const value = updates.content_json;
    updates.content_json = typeof value === "string" ? value : JSON.stringify(value || {});
  }
  if ("visibility" in updates) updates.visibility = Math.trunc(Number(updates.visibility || 0));
  if ("account_id" in updates && (updates.account_id === "" || updates.account_id === null)) {
    updates.account_id = null;
  }
  const title = String(updates.title ?? current.title ?? "");
  const desc = String(updates.desc ?? current.desc ?? "");
  updates.compliance = JSON.stringify(complianceIssues(`${title}\n${desc}`));
  updates.updated_at = now();
  const assignments = Object.keys(updates)
    .map((key) => `${key} = ?`)
    .join(", ");
  execute(`UPDATE drafts SET ${assignments} WHERE id = ?`, ...Object.values(updates), draftId);
  return getDraft(draftId);
}

export function switchPlatform(
  draftId: number,
  targetPlatform: string,
  contentType = ""
): Record<string, unknown> {
  const current = getDraft(draftId);
  const target = normalizePlatform(targetPlatform || String(current.platform));
  const nextType = String(contentType || "").trim();
  if (target === current.platform && (!nextType || nextType === current.content_type)) {
    return current;
  }
  if (current.status === "published") {
    throw new Error("已发布的草稿不能切换平台，可以另存为新草稿");
  }
  const spec = nextType
    ? specOf(target, nextType)
    : target === current.platform
      ? specOf(target, String(current.content_type || ""))
      : specForMedia(target, String(current.media_type || "image"));
  const topics = normalizeTopics(current.topics);
  const title = normalizeTitle(String(current.title || ""), "", spec.title_max);
  if (!title) throw new Error("标题为空，先补一个标题再切换平台");
  const desc = normalizeDesc(
    stripTagLines(String(current.desc || "")),
    topics,
    spec.desc_max,
    target
  );
  let visibility = Math.trunc(Number(current.visibility || 0));
  if (target === "wechat_mp") visibility = visibility === 1 ? 1 : 0;
  const previous =
    current.content_json && typeof current.content_json === "object"
      ? (current.content_json as Record<string, unknown>)
      : {};
  const preserved: Record<string, unknown> = {};
  for (const key of ["photo", "model", "model_hash", "renders", "wechat_square", "motion", "design_version"]) {
    if (previous[key]) preserved[key] = previous[key];
  }
  execute(
    "UPDATE drafts SET platform=?, content_type=?, media_type=?, title=?, desc=?, " +
      "visibility=?, account_id=NULL, content_json=?, compliance=?, updated_at=? WHERE id=?",
    target,
    spec.key,
    spec.media_type === "video" ? "video" : "image",
    title,
    desc,
    visibility,
    JSON.stringify(preserved),
    JSON.stringify(complianceIssues(`${title}\n${desc}`)),
    now(),
    draftId
  );
  return getDraft(draftId);
}

function removeDraftFiles(draftId: number, images: unknown[]): void {
  const targets = new Set<string>([
    path.join(ASSETS_DIR, `draft-${draftId}`),
    path.join(DESIGN_DIR, `draft-${draftId}`),
  ]);
  const roots = [UPLOAD_DIR, ASSETS_DIR, DESIGN_DIR].map((item) => path.resolve(item) + path.sep);
  for (const item of images) {
    const resolved = path.resolve(String(item));
    if (roots.some((root) => resolved.startsWith(root))) targets.add(resolved);
  }
  for (const target of targets) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch {
      /* 文件占用不影响删除草稿 */
    }
  }
}

export function deleteDraft(draftId: number): boolean {
  const row = queryOne<{ topic_id: number | null; images: string }>(
    "SELECT topic_id, images FROM drafts WHERE id = ?",
    draftId
  );
  if (!row) return false;
  const images = jsonField<unknown[]>(row.images, []);
  getDb().transaction(() => {
    execute("DELETE FROM records WHERE draft_id = ?", draftId);
    execute("DELETE FROM jobs WHERE draft_id = ?", draftId);
    execute("DELETE FROM drafts WHERE id = ?", draftId);
    if (row.topic_id) {
      const others = queryOne<{ n: number }>(
        "SELECT COUNT(*) AS n FROM drafts WHERE topic_id = ?",
        row.topic_id
      );
      if (!Number(others?.n || 0)) {
        execute(
          "UPDATE topics SET status='pool', updated_at=? WHERE id=? AND status='used'",
          now(),
          row.topic_id
        );
      }
    }
  })();
  removeDraftFiles(draftId, images);
  return true;
}

export function deleteDrafts(draftIds: number[]): Record<string, unknown> {
  const ids = [...new Set(draftIds.filter((item) => Number.isFinite(item) && item > 0))];
  if (!ids.length) throw new Error("没有选中要删除的草稿");
  const deleted = ids.filter((id) => deleteDraft(id)).length;
  return { deleted, total: countDrafts() };
}

export function markPublished(draftId: number): void {
  execute("UPDATE drafts SET status='published', updated_at=? WHERE id=?", now(), draftId);
}

export function markFailed(draftId: number): void {
  execute("UPDATE drafts SET status='failed', updated_at=? WHERE id=?", now(), draftId);
}
