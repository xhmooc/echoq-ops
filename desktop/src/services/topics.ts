/** 选题池：列表、手工添加、文本导入、更新与删除。 */
import fs from "node:fs";
import path from "node:path";
import { now } from "../core/config";
import { execute, getDb, queryAll, queryOne } from "../core/db";

export const SOURCE_LABELS: Record<string, string> = {
  keyword: "关键词",
  competitor: "竞品",
  channel: "频道",
  trending: "热榜",
  library: "题库",
  manual: "手动",
};

const DIMENSION_META: Array<[string, string, number]> = [
  ["engagement", "互动热度", 45],
  ["fresh", "新鲜度", 15],
  ["fit", "赛道匹配", 20],
  ["novelty", "新颖度", 20],
];

interface TopicRow {
  id: number;
  source: string;
  source_ref: string;
  keyword: string;
  category: string;
  title: string;
  angle: string;
  tone: string;
  product: number;
  score: number;
  score_detail: string;
  status: string;
  raw: string;
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

export function explainScore(detail: Record<string, unknown>, score: number): Record<string, unknown>[] {
  const weighted = Number(detail.weighted_interactions || 0);
  const hits = Number(detail.focus_hits || 0);
  const similarity = Number(detail.max_similarity || 0);
  const ageDays = detail.age_days;
  const notes: Record<string, string> = {
    engagement: weighted ? `点赞+收藏×2+评论×3+转发×2 = ${weighted.toLocaleString()}` : "没有互动数据，按 0 计",
    fresh: ageDays !== null && ageDays !== undefined ? `发布约 ${Number(ageDays).toFixed(0)} 天前` : "未拿到发布时间，按中间值 50%",
    fit: `命中 ${hits} 个关注词${detail.product ? "，且带产品" : ""}`,
    novelty: `与池内最高相似度 ${(similarity * 100).toFixed(0)}%，越不像同题分越高`,
  };
  const rows = DIMENSION_META.map(([key, label, weight]) => {
    const value = Number(detail[key] || 0);
    return {
      key,
      label,
      value: Math.round(value * 10000) / 10000,
      weight,
      points: Math.round(100 * (weight / 100) * value * 10) / 10,
      note: notes[key],
    };
  });
  rows.push({ key: "total", label: "合计", weight: 100, points: Math.round(score * 10) / 10 } as never);
  return rows;
}

export function serializeTopic(row: TopicRow): Record<string, unknown> {
  const detail = jsonField<Record<string, unknown>>(row.score_detail, {});
  return {
    id: row.id,
    source: row.source,
    source_label: SOURCE_LABELS[row.source] || row.source,
    source_ref: row.source_ref,
    keyword: row.keyword,
    category: row.category,
    title: row.title,
    angle: row.angle,
    tone: row.tone,
    product: Boolean(row.product),
    score: row.score,
    score_detail: detail,
    score_explain: explainScore(detail, Number(row.score || 0)),
    heat: Math.trunc(Number(detail.weighted_interactions || 0)),
    status: row.status,
    raw: jsonField<Record<string, unknown>>(row.raw, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function buildFilters(status: string, query: string, source: string, category: string, minScore: number) {
  let sql = " WHERE 1 = 1";
  const args: unknown[] = [];
  if (status) {
    sql += " AND status = ?";
    args.push(status);
  }
  if (query) {
    sql += " AND (title LIKE ? OR keyword LIKE ? OR category LIKE ?)";
    args.push(`%${query}%`, `%${query}%`, `%${query}%`);
  }
  if (source) {
    sql += " AND source = ?";
    args.push(source);
  }
  if (category) {
    sql += " AND category = ?";
    args.push(category);
  }
  if (minScore) {
    sql += " AND score >= ?";
    args.push(minScore);
  }
  return { sql, args };
}

export function countTopics(
  status = "",
  query = "",
  source = "",
  category = "",
  minScore = 0
): number {
  const where = buildFilters(status, query, source, category, minScore);
  const row = queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM topics${where.sql}`, ...where.args);
  return Number(row?.n || 0);
}

export function listTopics(
  status = "",
  query = "",
  limit = 200,
  source = "",
  category = "",
  minScore = 0,
  sort = "score",
  offset = 0
): Record<string, unknown>[] {
  const order =
    {
      score: "score DESC, id DESC",
      score_asc: "score ASC, id DESC",
      newest: "id DESC",
      heat:
        "CAST(COALESCE(json_extract(score_detail, '$.weighted_interactions'), 0) AS INTEGER) DESC, score DESC",
    }[sort] || "score DESC, id DESC";
  const where = buildFilters(status, query, source, category, minScore);
  const rows = queryAll<TopicRow>(
    `SELECT * FROM topics${where.sql} ORDER BY ${order} LIMIT ? OFFSET ?`,
    ...where.args,
    Math.max(1, limit),
    Math.max(0, Math.trunc(offset))
  );
  return rows.map(serializeTopic);
}

export function getTopic(topicId: number): Record<string, unknown> {
  const row = queryOne<TopicRow>("SELECT * FROM topics WHERE id = ?", topicId);
  if (!row) throw Object.assign(new Error(`选题不存在: ${topicId}`), { status: 404 });
  return serializeTopic(row);
}

export function listDedupes(limit = 50): Record<string, unknown>[] {
  const rows = queryAll<Record<string, unknown>>(
    "SELECT * FROM topic_dedupes ORDER BY id DESC LIMIT ?",
    Math.max(1, limit)
  );
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    source: row.source,
    source_label: SOURCE_LABELS[String(row.source)] || row.source,
    kept_topic_id: row.kept_topic_id,
    kept_title: row.kept_title,
    similarity: Math.round(Number(row.similarity || 0) * 1000) / 1000,
    created_at: row.created_at,
  }));
}

function insertCandidate(candidate: Record<string, unknown>): Record<string, unknown> | null {
  const title = String(candidate.title || "").trim();
  if (!title) return null;
  const existing = queryOne<{ id: number }>(
    "SELECT id FROM topics WHERE title = ? LIMIT 1",
    title
  );
  if (existing) return null;
  const stamp = now();
  const detail = (candidate.score_detail as Record<string, unknown>) || {};
  const id = execute(
    "INSERT INTO topics(source, source_ref, keyword, category, title, angle, tone, product, " +
      "score, score_detail, status, raw, created_at, updated_at) " +
      "VALUES(?,?,?,?,?,?,?,?,?,?,'pool',?,?,?)",
    String(candidate.source || "manual"),
    String(candidate.source_ref || ""),
    String(candidate.keyword || ""),
    String(candidate.category || ""),
    title,
    String(candidate.angle || ""),
    String(candidate.tone || ""),
    candidate.product ? 1 : 0,
    Number(candidate.score || 0),
    JSON.stringify(detail),
    JSON.stringify(candidate.raw || {}),
    stamp,
    stamp
  );
  return getTopic(id);
}

export function ingest(candidates: Record<string, unknown>[]): Record<string, unknown> {
  const items: Record<string, unknown>[] = [];
  let skipped = 0;
  for (const candidate of candidates) {
    const inserted = insertCandidate(candidate);
    if (inserted) items.push(inserted);
    else skipped += 1;
  }
  return { inserted: items.length, skipped, errors: [], items, dedupes: [] };
}

export function addManual(payload: {
  title: string;
  angle?: string;
  keyword?: string;
  category?: string;
  tone?: string;
  product?: boolean;
}): Record<string, unknown> {
  const result = ingest([
    {
      source: "manual",
      keyword: payload.keyword || "",
      category: payload.category || "",
      title: payload.title,
      angle: payload.angle || "",
      tone: payload.tone || "",
      product: Boolean(payload.product),
      raw: {},
    },
  ]);
  if (!Number(result.inserted)) throw new Error("选题重复或标题为空，未入池");
  return (result.items as Record<string, unknown>[])[0];
}

export function importText(text: string): Record<string, unknown> {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("导入内容为空");
  const rows: Record<string, unknown>[] = [];
  if (raw.startsWith("[")) {
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new Error("JSON 解析失败，请检查格式");
    }
    const list = Array.isArray(payload) ? payload : ((payload as Record<string, unknown>)?.items as unknown[]) || [];
    for (const item of list) {
      if (item && typeof item === "object" && String((item as Record<string, unknown>).title || "").trim()) {
        rows.push(item as Record<string, unknown>);
      }
    }
  } else {
    for (const line of raw.split(/\r?\n/)) {
      const clean = line.trim();
      if (!clean || clean.startsWith("#")) continue;
      const parts = clean.split(/[,，\t]/).map((part) => part.trim());
      if (!parts[0] || ["title", "标题"].includes(parts[0].toLowerCase())) continue;
      rows.push({
        title: parts[0],
        angle: parts[1] || "",
        keyword: parts[2] || "",
        category: parts[3] || "",
        tone: parts[4] || "",
        product: parts[5] ? ["1", "true", "是", "yes"].includes(parts[5]) : false,
      });
    }
  }
  if (!rows.length) throw new Error("没有解析到可导入的选题");
  return ingest(
    rows.map((item) => ({
      source: String(item.source || "manual"),
      title: String(item.title || ""),
      angle: String(item.angle || ""),
      keyword: String(item.keyword || ""),
      category: String(item.category || ""),
      tone: String(item.tone || ""),
      product: Boolean(item.product),
      raw: { imported: true },
    }))
  );
}

/** 导入题库 JSON：字段与 xhs-promo/topics/library.json 一致。 */
export function importLibrary(filePath: string): Record<string, unknown> {
  const raw = fs.readFileSync(filePath, "utf8");
  let items: unknown;
  try {
    items = JSON.parse(raw);
  } catch {
    throw new Error(`题库文件不是合法 JSON：${path.basename(filePath)}`);
  }
  if (!Array.isArray(items)) throw new Error("题库文件格式不正确（应为数组）");
  const candidates = items
    .map((item, index) => {
      const record = (item || {}) as Record<string, unknown>;
      const title = String(record.title || record.topic || "").trim();
      if (!title) return null;
      return {
        source: "library",
        source_ref: `${path.basename(filePath)}#${String(record.id ?? index)}`,
        keyword: String(record.col || record.topic || ""),
        title,
        angle: String(record.angle || ""),
        tone: String(record.tone || ""),
        product: Boolean(record.product),
        raw: record,
      };
    })
    .filter(Boolean) as Record<string, unknown>[];
  if (!candidates.length) throw new Error("题库里没有可导入的选题");
  return ingest(candidates);
}

export function updateTopic(topicId: number, fields: Record<string, unknown>): Record<string, unknown> {
  const allowed = ["title", "angle", "tone", "category", "keyword", "product", "status"];
  const updates: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (allowed.includes(key)) updates[key] = value;
  }
  if (!Object.keys(updates).length) return getTopic(topicId);
  if ("product" in updates) updates.product = updates.product ? 1 : 0;
  if ("status" in updates && !["pool", "used", "dropped"].includes(String(updates.status))) {
    throw new Error("status 只能是 pool / used / dropped");
  }
  updates.updated_at = now();
  const assignments = Object.keys(updates)
    .map((key) => `${key} = ?`)
    .join(", ");
  execute(`UPDATE topics SET ${assignments} WHERE id = ?`, ...Object.values(updates), topicId);
  return getTopic(topicId);
}

export function deleteTopics(topicIds: number[]): number {
  const ids = [...new Set(topicIds.filter((item) => Number.isFinite(item) && item > 0))];
  if (!ids.length) throw new Error("没有选中要删除的选题");
  const marks = ids.map(() => "?").join(",");
  const tx = getDb().transaction(() => {
    getDb().prepare(`DELETE FROM topic_dedupes WHERE kept_topic_id IN (${marks})`).run(...ids);
    return getDb().prepare(`DELETE FROM topics WHERE id IN (${marks})`).run(...ids).changes;
  });
  return Number(tx());
}
