/** 设置读写：与 Python 的 ops/db.py settings 表同语义。 */
import { execute, queryAll, queryOne } from "./db";

export const DEFAULT_SETTINGS: Record<string, string> = {
  publish_daily_limit: "3",
  publish_min_interval_sec: "2700",
  publish_jitter_sec: "300",
  job_max_attempts: "4",
  worker_auto_start: "1",
  worker_poll_sec: "20",
  health_check_hours: "6",
  write_gap_sec: "45",
  comment_sync_hours: "12",
  focus_keywords: "面试,求职,秋招,简历,自我介绍,面试技巧,offer,应届生",
  product_name: "应声面试 Pro",
  product_pitch:
    "面试时贴在最上层，把问题实时转成文字并给出可直接说出口的回答；识别在本地跑。",
  card_style: "warm",
  card_layout: "balanced",
  card_palette: "",
  card_theme: "warm",
  draft_style: "story",
  llm_model: "deepseek-chat",
};

export const SETTING_KEYS = new Set([
  "publish_daily_limit",
  "publish_min_interval_sec",
  "publish_jitter_sec",
  "job_max_attempts",
  "worker_auto_start",
  "worker_poll_sec",
  "health_check_hours",
  "write_gap_sec",
  "comment_sync_hours",
  "focus_keywords",
  "product_name",
  "product_pitch",
  "card_style",
  "card_layout",
  "card_palette",
  "card_theme",
  "card_brand",
  "card_column",
  "card_issue",
  "theme_color",
  "draft_style",
]);

export function getSetting(key: string, fallback = ""): string {
  const row = queryOne<{ value: string }>("SELECT value FROM settings WHERE key = ?", key);
  if (row) return row.value;
  return DEFAULT_SETTINGS[key] ?? fallback;
}

export function getIntSetting(key: string, fallback = 0): number {
  const value = Number.parseFloat(getSetting(key, String(fallback)));
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

export function setSetting(key: string, value: unknown): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  execute(
    "INSERT INTO settings(key, value) VALUES(?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    key,
    text
  );
}

export function allSettings(): Record<string, string> {
  const values: Record<string, string> = { ...DEFAULT_SETTINGS };
  for (const row of queryAll<{ key: string; value: string }>("SELECT key, value FROM settings")) {
    values[row.key] = row.value;
  }
  return values;
}
