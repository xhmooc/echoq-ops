/** 定时任务：CRUD、下次执行时间计算与运行记录查询。 */
import { now } from "../core/config";
import { execute, getDb, queryAll, queryOne } from "../core/db";
import { DEFAULT_PLATFORM, isPlatformReady, normalizePlatform, platformLabel } from "../core/platform";
import { getSetting } from "../core/settings";

export const KINDS: Record<string, string> = {
  publish: "定时发布",
  mine: "定时找选题",
  draft: "定时生成草稿",
  chain: "找选题→写草稿→发布",
};
const TRIGGERS = new Set(["time_point", "interval"]);
const WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const WHATS = new Set(["publish", "chain", "mine"]);
const WHEN_PRESETS: Record<string, Record<string, unknown>> = {
  morning: { trigger_type: "time_point", time_of_day: "09:00", weekdays: [] },
  noon: { trigger_type: "time_point", time_of_day: "12:00", weekdays: [] },
  evening: { trigger_type: "time_point", time_of_day: "20:00", weekdays: [] },
  workdays: { trigger_type: "time_point", time_of_day: "20:00", weekdays: [0, 1, 2, 3, 4] },
  every6h: { trigger_type: "interval", interval_minutes: 360 },
};

export function normalizeHhmm(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) return "09:00";
  const parts = text.replace(/：/g, ":").split(":");
  if (parts.length !== 2 || !parts.every((part) => /^\d+$/.test(part.trim()))) {
    throw new Error(`时间点格式应为 HH:MM：${text}`);
  }
  const hour = Number(parts[0]);
  const minute = Number(parts[1]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`时间点超出范围：${text}`);
  }
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function normalizeWeekdays(value: unknown): number[] {
  if (value === null || value === undefined || value === "") return [];
  let raw: unknown = value;
  if (typeof raw === "string") {
    const text = raw.trim();
    if (!text) return [];
    try {
      raw = JSON.parse(text);
    } catch {
      raw = text.replace(/，/g, ",").split(",").filter((item) => item.trim());
    }
  }
  if (!Array.isArray(raw)) throw new Error("星期几必须是数组");
  const days: number[] = [];
  for (const item of raw) {
    const day = Number(item);
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      throw new Error(`星期几必须是 0-6 的整数：${String(item)}`);
    }
    if (!days.includes(day)) days.push(day);
  }
  return days.sort((a, b) => a - b);
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

export function computeNext(schedule: Record<string, unknown>, base?: number): number {
  const current = now();
  const start = base === undefined ? current : Math.max(Math.trunc(base), 0);
  if (String(schedule.trigger_type || "time_point") === "interval") {
    const minutes = Math.max(5, Number(schedule.interval_minutes || 360));
    let nextAt = start + minutes * 60;
    while (nextAt <= current) nextAt += minutes * 60;
    return nextAt;
  }
  const [hour, minute] = normalizeHhmm(schedule.time_of_day).split(":").map(Number);
  const weekdays = normalizeWeekdays(schedule.weekdays);
  // 按本机时区计算，不再硬编码 UTC+8，跨时区机器不会整体偏移。
  for (let offset = 0; offset < 15; offset += 1) {
    const moment = new Date();
    moment.setDate(moment.getDate() + offset);
    moment.setHours(hour, minute, 0, 0);
    const pyWeekday = (moment.getDay() + 6) % 7;
    if (weekdays.length && !weekdays.includes(pyWeekday)) continue;
    const targetSeconds = Math.floor(moment.getTime() / 1000);
    if (targetSeconds <= current + 5) continue;
    return targetSeconds;
  }
  return current + 3600;
}

export function triggerLabel(schedule: Record<string, unknown>): string {
  if (String(schedule.trigger_type || "time_point") === "interval") {
    const minutes = Math.max(5, Number(schedule.interval_minutes || 360));
    return minutes % 60 === 0 ? `每 ${minutes / 60} 小时` : `每 ${minutes} 分钟`;
  }
  const timeOfDay = String(schedule.time_of_day || "09:00");
  const weekdays = normalizeWeekdays(schedule.weekdays);
  if (!weekdays.length || weekdays.length === 7) return `每天 ${timeOfDay}`;
  if (weekdays.join(",") === "0,1,2,3,4") return `工作日 ${timeOfDay}`;
  return `${weekdays.map((day) => WEEKDAYS[day]).join("、")} ${timeOfDay}`;
}

export function serializeSchedule(row: Record<string, unknown>): Record<string, unknown> {
  const platform = String(row.platform || DEFAULT_PLATFORM);
  return {
    id: row.id,
    name: row.name,
    platform,
    platform_name: platformLabel(platform),
    kind: row.kind,
    kind_label: KINDS[String(row.kind)] || row.kind,
    enabled: Boolean(row.enabled),
    auto: Boolean(row.auto),
    trigger_type: row.trigger_type,
    trigger_label: triggerLabel(row),
    time_of_day: row.time_of_day,
    weekdays: normalizeWeekdays(row.weekdays),
    interval_minutes: row.interval_minutes,
    config: jsonField<Record<string, unknown>>(row.config, {}),
    next_run_at: row.next_run_at,
    last_run_at: row.last_run_at,
    last_status: row.last_status,
    last_message: row.last_message,
    running: Boolean(row.running),
    failures: row.failures,
    paused_reason: row.paused_reason,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listSchedules(limit = 200, offset = 0): Record<string, unknown>[] {
  return queryAll<Record<string, unknown>>(
    "SELECT * FROM schedules ORDER BY id DESC LIMIT ? OFFSET ?",
    Math.max(1, limit),
    Math.max(0, Math.trunc(offset))
  ).map(serializeSchedule);
}

export function countSchedules(): number {
  const row = queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM schedules");
  return Number(row?.n || 0);
}

function cleanFields(payload: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if ("name" in payload) {
    const name = String(payload.name || "").trim();
    if (!name) throw new Error("任务名称不能为空");
    fields.name = name.slice(0, 60);
  }
  if ("kind" in payload) {
    const kind = String(payload.kind || "").trim();
    if (!KINDS[kind]) throw new Error("任务类型只支持 publish / mine / draft / chain");
    fields.kind = kind;
  }
  if ("platform" in payload) fields.platform = normalizePlatform(payload.platform);
  if ("trigger_type" in payload) {
    const trigger = String(payload.trigger_type || "").trim();
    if (!TRIGGERS.has(trigger)) throw new Error("触发方式只支持 time_point / interval");
    fields.trigger_type = trigger;
  }
  if ("time_of_day" in payload) fields.time_of_day = normalizeHhmm(payload.time_of_day);
  if ("weekdays" in payload) fields.weekdays = JSON.stringify(normalizeWeekdays(payload.weekdays));
  if ("interval_minutes" in payload) {
    const minutes = Number(payload.interval_minutes || 0);
    if (!Number.isFinite(minutes)) throw new Error("间隔必须是整数分钟");
    if (minutes && minutes < 5) throw new Error("间隔至少 5 分钟");
    fields.interval_minutes = Math.max(5, Math.trunc(minutes) || 360);
  }
  if ("auto" in payload) fields.auto = payload.auto ? 1 : 0;
  if ("enabled" in payload) fields.enabled = payload.enabled ? 1 : 0;
  if ("config" in payload) {
    const config = payload.config || {};
    if (typeof config !== "object" || Array.isArray(config)) throw new Error("config 必须是 JSON 对象");
    fields.config = JSON.stringify(config);
  }
  return fields;
}

function getRow(scheduleId: number): Record<string, unknown> {
  const row = queryOne<Record<string, unknown>>("SELECT * FROM schedules WHERE id = ?", scheduleId);
  if (!row) throw Object.assign(new Error(`定时任务不存在: ${scheduleId}`), { status: 404 });
  return row;
}

export function createSchedule(payload: Record<string, unknown>): Record<string, unknown> {
  const fields = cleanFields(payload);
  if (!fields.name) throw new Error("任务名称不能为空");
  if (!fields.kind) throw new Error("请选择任务类型");
  const trigger = String(fields.trigger_type || "time_point");
  if (trigger === "interval" && !fields.interval_minutes) fields.interval_minutes = 360;
  const enabled = Number(fields.enabled ?? 1);
  const stamp = now();
  const merged = {
    trigger_type: trigger,
    time_of_day: fields.time_of_day || "09:00",
    weekdays: fields.weekdays || "[]",
    interval_minutes: fields.interval_minutes || 360,
  };
  const scheduleId = execute(
    "INSERT INTO schedules(name, platform, kind, enabled, auto, trigger_type, time_of_day, " +
      "weekdays, interval_minutes, config, next_run_at, last_run_at, last_status, " +
      "last_message, running, failures, paused_reason, created_at, updated_at) " +
      "VALUES(?,?,?,?,?,?,?,?,?,?,?,0,'','',0,0,'',?,?)",
    fields.name,
    fields.platform || DEFAULT_PLATFORM,
    fields.kind,
    enabled,
    Number(fields.auto || 0),
    trigger,
    merged.time_of_day,
    merged.weekdays,
    merged.interval_minutes,
    fields.config || "{}",
    enabled ? computeNext(merged, stamp) : 0,
    stamp,
    stamp
  );
  return serializeSchedule(getRow(scheduleId));
}

export function updateSchedule(scheduleId: number, payload: Record<string, unknown>): Record<string, unknown> {
  const row = getRow(scheduleId);
  const fields = cleanFields(payload);
  if (!Object.keys(fields).length) return serializeSchedule(row);
  const merged: Record<string, unknown> = { ...row, ...fields };
  const stamp = now();
  const reenable = Number(fields.enabled) === 1 && !Number(row.enabled);
  const triggerChanged = ["trigger_type", "time_of_day", "weekdays", "interval_minutes"].some(
    (key) => key in fields
  );
  if (reenable) {
    fields.paused_reason = "";
    fields.failures = 0;
    fields.next_run_at = computeNext(merged, stamp);
  } else if (triggerChanged && Number(merged.enabled)) {
    fields.next_run_at = computeNext(merged, stamp);
  }
  fields.updated_at = stamp;
  const assignments = Object.keys(fields)
    .map((key) => `${key} = ?`)
    .join(", ");
  execute(`UPDATE schedules SET ${assignments} WHERE id = ?`, ...Object.values(fields), scheduleId);
  return serializeSchedule(getRow(scheduleId));
}

export function deleteSchedule(scheduleId: number): void {
  getRow(scheduleId);
  getDb().transaction(() => {
    execute("DELETE FROM schedule_runs WHERE schedule_id = ?", scheduleId);
    execute("DELETE FROM schedules WHERE id = ?", scheduleId);
  })();
}

function focusKeywords(): string[] {
  const raw = getSetting("focus_keywords", "");
  const items = raw
    .replace(/，/g, ",")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items.slice(0, 5).length ? items.slice(0, 5) : ["生活方式"];
}

export function quickCreateSchedule(payload: Record<string, unknown>): Record<string, unknown> {
  const what = String(payload.what || "chain").trim();
  if (!WHATS.has(what)) throw new Error("请选择要做什么：发一篇已写好的 / 找选题→写草稿→发布 / 只帮我找选题");
  let trigger: Record<string, unknown>;
  const when = payload.when ?? "morning";
  if (typeof when === "string") {
    if (!WHEN_PRESETS[when]) throw new Error("请选择什么时候执行");
    trigger = { ...WHEN_PRESETS[when] };
  } else if (when && typeof when === "object" && !Array.isArray(when)) {
    trigger = { ...(when as Record<string, unknown>) };
    if (!TRIGGERS.has(String(trigger.trigger_type || "time_point"))) {
      throw new Error("触发方式不正确");
    }
  } else {
    throw new Error("什么时候的配置不正确");
  }
  const tone = String(payload.tone || getSetting("draft_style", "story"));
  const style = String(payload.card_style || getSetting("card_style", "memo"));
  const platform = normalizePlatform(payload.platform);
  if (!isPlatformReady(platform) && (what === "publish" || what === "chain")) {
    throw new Error(`${platformLabel(platform)}的发布接入位已预留，暂时只能创建「找选题」任务。`);
  }
  const account = queryOne<{ id: number }>(
    "SELECT id FROM accounts WHERE enabled=1 AND platform=? ORDER BY id LIMIT 1",
    platform
  );
  const accountId = account?.id ?? null;
  let config: Record<string, unknown>;
  if (what === "publish") {
    config = { limit: 1, visibility: 1, account_ids: accountId ? [accountId] : [] };
  } else if (what === "mine") {
    config = {
      mode: "keyword",
      keywords: focusKeywords(),
      per_kw: 20,
      limit: 30,
      detail_limit: 5,
      min_score: 0,
      product: false,
      account_id: accountId,
    };
  } else {
    config = {
      keywords: focusKeywords(),
      per_kw: 20,
      limit: 30,
      detail_limit: 5,
      min_score: 0,
      product: false,
      account_id: accountId,
      account_ids: accountId ? [accountId] : [],
      from_pool: 1,
      tone,
      with_cards: true,
      card_style: style,
      use_llm: true,
      publish: true,
      visibility: 1,
    };
  }
  const short: Record<string, string> = { publish: "发一篇", chain: "找选题→写草稿→发布", mine: "找选题" };
  let name = String(payload.name || "").trim();
  if (!name) {
    const merged = { ...trigger, weekdays: trigger.weekdays || [], interval_minutes: trigger.interval_minutes || 360 };
    name = `${triggerLabel(merged)} · ${short[what]}`.slice(0, 60);
  }
  return createSchedule({
    name,
    platform,
    kind: what,
    trigger_type: trigger.trigger_type || "time_point",
    time_of_day: trigger.time_of_day || "09:00",
    weekdays: trigger.weekdays || [],
    interval_minutes: trigger.interval_minutes || 360,
    auto: false,
    enabled: true,
    config,
  });
}

export function serializeRun(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    schedule_id: row.schedule_id,
    schedule_name: row.schedule_name,
    kind: row.kind,
    kind_label: KINDS[String(row.kind)] || row.kind,
    trigger: row.trigger,
    status: row.status,
    started_at: row.started_at,
    finished_at: row.finished_at,
    message: row.message,
    error: row.error,
    output: jsonField<Record<string, unknown>>(row.output, {}),
    created_at: row.created_at,
  };
}

export function listRuns(scheduleId: number | null, limit = 50, offset = 0): Record<string, unknown>[] {
  const rows = scheduleId
    ? queryAll<Record<string, unknown>>(
        "SELECT * FROM schedule_runs WHERE schedule_id = ? ORDER BY id DESC LIMIT ? OFFSET ?",
        scheduleId,
        Math.max(1, limit),
        Math.max(0, Math.trunc(offset))
      )
    : queryAll<Record<string, unknown>>(
        "SELECT * FROM schedule_runs ORDER BY id DESC LIMIT ? OFFSET ?",
        Math.max(1, limit),
        Math.max(0, Math.trunc(offset))
      );
  return rows.map(serializeRun);
}

export function countRuns(scheduleId: number | null): number {
  const row = scheduleId
    ? queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM schedule_runs WHERE schedule_id = ?", scheduleId)
    : queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM schedule_runs");
  return Number(row?.n || 0);
}
