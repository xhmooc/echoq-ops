/** 文案规范化与合规检查：与 Python 的 ops/content.py 同名逻辑保持一致。 */
import { platformMeta, specOf } from "./platform";

const RISK_PATTERNS: Array<[RegExp, string]> = [
  [/扣\s*个?\s*1/, "诱导互动：扣1"],
  [/评论区.{0,6}(留言|回复|扣|打)/, "诱导互动：评论区索取"],
  [/(私信|私我|si我|s我).{0,8}(发|要|领|给)/, "诱导互动：私信索取"],
  [/关注后.{0,8}(发|领|给|私)/, "诱导互动：关注换资源"],
  [/(点赞|收藏).{0,8}(关注|转发).{0,8}(换|领|送)/, "诱导互动：三连换资源"],
  [/(加|扫码).{0,6}(微信|vx|VX|v信|QQ)/, "站外引流"],
  [/二维码/, "站外引流"],
  [/(免费领|领取资料|资料包|后台回复)/, "诱导领取"],
];

export function escapeHtml(text: string): string {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface ComplianceIssue {
  label: string;
  match: string;
}

export function complianceIssues(text: string): ComplianceIssue[] {
  const issues: ComplianceIssue[] = [];
  for (const [pattern, label] of RISK_PATTERNS) {
    const match = String(text || "").match(pattern);
    if (match) issues.push({ label, match: match[0] });
  }
  return issues;
}

const BREAK_SENTENCE = "。！？!?；;\n";
const BREAK_CLAUSE = "，,、：:— ";

function shrinkText(text: string, limit: number): string {
  if (text.length <= limit) return text.trim();
  const window = text.slice(0, Math.max(1, limit));
  for (const seps of [BREAK_SENTENCE, BREAK_CLAUSE]) {
    let index = -1;
    for (const char of seps) index = Math.max(index, window.lastIndexOf(char));
    if (index >= Math.max(4, Math.floor(limit / 2))) {
      return window.slice(0, index + 1).replace(/[，,、：:— \n]+$/, "");
    }
  }
  const space = window.lastIndexOf(" ");
  if (space >= Math.max(4, Math.floor(limit / 2))) return window.slice(0, space).trim();
  return window.trim();
}

export function normalizeTitle(title: string, fallback = "", limit?: number): string {
  let value = String(title || "").trim().replace(/\s+/g, " ");
  value = value.replace(/^[《》"' ]+|[《》"' ]+$/g, "");
  if (!value) value = String(fallback || "").trim();
  return shrinkText(value, Math.trunc(limit || 20)).replace(/^[，,、：:— ]+|[，,、：:— ]+$/g, "");
}

export function normalizeTopics(raw: unknown, keyword = "", maxTopics = 6): string[] {
  const items: string[] = [];
  const limit = Math.max(1, maxTopics);
  const addText = (value: unknown): void => {
    const text = String(value ?? "").trim().replace(/^#+/, "");
    for (const part of text.split(/[,，;；\s#]+/)) {
      const clean = part.trim().replace(/^#+/, "");
      if (clean.length > 1 && clean.length <= 16 && !items.includes(clean) && items.length < limit) {
        items.push(clean);
      }
    }
  };
  if (typeof raw === "string") addText(raw);
  else if (Array.isArray(raw)) raw.forEach(addText);
  if (!items.length && keyword) addText(keyword);
  return items.slice(0, limit);
}

export function stripTagLines(desc: string): string {
  const kept = String(desc || "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*(#[^\s#]+#?\s*)+\s*$/.test(line));
  return kept.join("\n").trim();
}

export function formatTopic(topic: string, style = "hashtag"): string {
  const text = String(topic || "").trim().replace(/^#+|\#+$/g, "").trim();
  if (!text || style === "none") return "";
  return style === "topic" ? `#${text}#` : `#${text}`;
}

export function appendTopics(desc: string, topics: string[], platform = ""): string {
  let body = String(desc || "").trim();
  if (!topics.length) return body;
  const style = platform ? platformMeta(platform).topic_style : "hashtag";
  const tags = topics.map((topic) => formatTopic(topic, style)).filter(Boolean);
  if (!tags.length) return body;
  const missing = tags.filter((tag, index) => !body.includes(`#${topics[index].replace(/^#+|\#+$/g, "")}`));
  if (missing.length) body = `${body}\n\n${missing.join(" ")}`;
  return body;
}

function truncateBody(text: string, limit: number): string {
  if (text.length <= limit) return text.trim();
  return shrinkText(text, limit);
}

export function normalizeDesc(desc: string, topics: string[], limit?: number, platform = ""): string {
  const body = String(desc || "").trim().replace(/\n{3,}/g, "\n\n");
  const maxLength = Math.trunc(limit || 1000);
  const style = platform ? platformMeta(platform).topic_style : "hashtag";
  const tagText = topics.map((topic) => formatTopic(topic, style)).filter(Boolean).join(" ");
  const reserve = tagText ? tagText.length + 2 : 0;
  return appendTopics(truncateBody(body, Math.max(1, maxLength - reserve)), topics, platform);
}

/** 草稿保存前统一套用平台规格，返回落库需要的字段。 */
export function normalizeDraftFields(
  platform: string,
  input: { title: string; desc: string; topics?: unknown; images?: string[] },
  contentType = ""
): { title: string; desc: string; topics: string[]; images: string[]; spec_key: string } {
  const spec = specOf(platform, contentType);
  const topics = normalizeTopics(input.topics);
  const title = normalizeTitle(input.title, "", spec.title_max);
  const body = stripTagLines(normalizeDesc(input.desc, topics, spec.desc_max, platform));
  return {
    title,
    desc: normalizeDesc(body, topics, spec.desc_max, platform),
    topics,
    images: (input.images || []).map(String),
    spec_key: spec.key,
  };
}
