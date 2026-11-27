/**
 * 定时调度执行引擎：定时发布 / 定时找选题 / 定时生成草稿 / 找选题→写草稿→发布。
 *
 * 语义对齐 Python 版 ops/scheduler.py：
 * - 用条件更新（running 0 → 1）领取任务，同一任务不会并发执行；
 * - 每次执行写一条 schedule_runs，保存阶段产出，便于「只重跑失败那一环」；
 * - 全自动关闭时只产出待确认草稿，人工确认后才真正入队发布；
 * - 连续失败达到上限自动暂停，并记录暂停原因。
 */
import { now } from "../core/config";
import { execute, getDb, queryAll, queryOne } from "../core/db";
import type { AccountRow } from "../core/accounts";
import { DEFAULT_PLATFORM, normalizePlatform, platformLabel } from "../core/platform";
import { mine as xhsMine } from "../platforms/xiaohongshu/adapter";
import { renderDesignCards, renderDraftCards } from "../render/cards";
import { generateCopy } from "./copy";
import { createManual, getDraft, updateDraft } from "./drafts";
import { enqueue, enqueueTargets } from "./queue";
import { computeNext, KINDS } from "./schedules";
import { getSetting } from "../core/settings";
import { ingest, updateTopic } from "./topics";
import { hotSourceForPlatform, mineHot } from "./topicSources";
import { runJob } from "./worker";

export const STAGE_LABELS: Record<string, string> = {
  mine: "找选题",
  draft: "写草稿（含配图）",
  publish: "发布",
};
const STAGE_ORDER = ["mine", "draft", "publish"] as const;
const MAX_FAILURES = 3;
const RISK_HINTS = ["合规", "风控", "频繁", "限流", "登录", "失效", "过期", "账号"];

interface ScheduleRow {
  id: number;
  name: string;
  platform: string;
  kind: string;
  enabled: number;
  auto: number;
  trigger_type: string;
  time_of_day: string;
  weekdays: string;
  interval_minutes: number;
  config: string;
  next_run_at: number;
  last_run_at: number;
  last_status: string;
  last_message: string;
  running: number;
  failures: number;
  paused_reason: string;
  created_at: number;
  updated_at: number;
}

/** 链路执行到某一环失败，带上是哪一环以及已完成环节的产出。 */
export class StageError extends Error {
  constructor(
    public stage: string,
    message: string,
    public output: Record<string, unknown> = {},
    public pause = ""
  ) {
    super(message);
  }
}

function short(text: unknown, limit = 300): string {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
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

function getScheduleRow(scheduleId: number): ScheduleRow {
  const row = queryOne<ScheduleRow>("SELECT * FROM schedules WHERE id = ?", scheduleId);
  if (!row) throw Object.assign(new Error(`定时任务不存在: ${scheduleId}`), { status: 404 });
  return row;
}

function schedulePlatform(row: ScheduleRow): string {
  return normalizePlatform(row.platform || DEFAULT_PLATFORM);
}

function focusKeywords(): string[] {
  const raw = getSetting("focus_keywords", "");
  return raw
    .replace(/，/g, ",")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 5);
}

// ---------------------------------------------------------------- 各环节执行

async function runMine(
  schedule: ScheduleRow,
  config: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const mode = String(config.mode || "keyword");
  if (!["keyword", "competitor", "channel", "trending", "hot"].includes(mode)) {
    throw new Error("挖掘方式只支持 keyword / competitor / channel / trending / hot");
  }
  let keywords = config.keywords || [];
  if (typeof keywords === "string") {
    keywords = String(keywords)
      .replace(/，/g, ",")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  const simulated = Boolean(config.simulate);
  const platform = schedulePlatform(schedule);
  // 小红书有自己的搜索接口；其它平台没有公开关键词搜索，走外部热榜，
  // 这样抖音 / 公众号的「找选题→写草稿→发布」也能无人值守跑完。
  const useHot = mode === "hot" || platform !== "xiaohongshu";
  const hotSource = String(config.hot_source || hotSourceForPlatform(platform));
  let data: Record<string, unknown>;
  if (simulated) {
    // 演练模式：不调用平台接口，用可控的模拟选题走完后续环节。
    const keyword = Array.isArray(keywords) && keywords.length ? String(keywords[0]) : "模拟选题";
    const titles: string[] =
      (config.sim_titles as string[]) || [
        `${keyword}｜真实体验和省钱心得`,
        `${keyword}｜踩坑复盘与避雷清单`,
      ];
    const stamp = now();
    data = ingest(
      titles.map((title, index) => ({
        source: "simulated",
        source_ref: `e2e-${stamp}-${index}`,
        keyword,
        category: "模拟",
        title: String(title),
        angle: "端到端演练",
        tone: "",
        product: false,
        liked: 1200 - index * 300,
        collected: 480 - index * 80,
        comments: 96 - index * 10,
        shares: 32,
        published_at: stamp - 86400,
        raw: { simulated: true },
      }))
    );
    data.simulated = true;
  } else if (useHot) {
    data = await mineHot(hotSource, {
      limit: Number(config.limit || 20),
      keywords: keywordList(keywords),
      product: Boolean(config.product),
    });
  } else if (mode === "keyword" && !keywordList(keywords).length) {
    throw new Error("关键词挖掘需要至少一个关键词；也可以开启「模拟演练」先跑通链路");
  } else {
    data = await xhsMine(mineAccount(schedule, config), {
      mode,
      keywords: keywordList(keywords),
      user_urls: keywordList(config.user_urls),
      per_kw: Number(config.per_kw || 20),
      limit: Number(config.limit || 30),
      sort_type_choice: Number(config.sort_type_choice || 0),
      detail_limit:
        config.detail_limit === undefined ? 5 : Number(config.detail_limit),
      product: Boolean(config.product),
    });
  }
  const minScore = Number(config.min_score || 0);
  if (useHot && !simulated && !Number(data.inserted || 0) && ((data.errors as string[]) || []).length) {
    throw new Error(String((data.errors as string[])[0]));
  }
  let dropped = 0;
  const kept: number[] = [];
  const items = (data.items as Record<string, unknown>[]) || [];
  if (minScore > 0) {
    for (const item of items) {
      if (Number(item.score || 0) < minScore) {
        updateTopic(Number(item.id), { status: "dropped" });
        dropped += 1;
      } else {
        kept.push(Number(item.id));
      }
    }
  } else {
    for (const item of items) kept.push(Number(item.id));
  }
  // 「只帮我找选题」可以限定这次最多留几条，避免一次把池子灌太满。
  const findCount = Math.max(0, Math.min(100, Number(config.find_count || 0)));
  const selected = findCount > 0 ? kept.slice(0, findCount) : kept;
  const parts = [`新增 ${Number(data.inserted || 0)} 条`, `去重跳过 ${Number(data.skipped || 0)} 条`];
  if (useHot) parts.unshift(String(data.source_label || "外部热榜"));
  if (simulated) parts.unshift("模拟挖掘");
  if (minScore > 0) parts.push(`低于 ${minScore} 分丢弃 ${dropped} 条`);
  if (findCount > 0 && kept.length > selected.length) {
    parts.push(`只保留前 ${selected.length} 条`);
  }
  return {
    message: parts.join("，"),
    output: {
      inserted: Number(data.inserted || 0),
      skipped: Number(data.skipped || 0),
      dropped,
      topic_ids: selected,
      errors: ((data.errors as unknown[]) || []).slice(0, 10),
      simulated,
      source: useHot ? hotSource : "",
    },
  };
}

/** 选题池里按分数取题；池子有货时链路不再重复挖掘。 */
function poolTopicIds(count: number, minScore = 0): number[] {
  const rows =
    minScore > 0
      ? queryAll<{ id: number }>(
          "SELECT id FROM topics WHERE status = 'pool' AND score >= ? " +
            "ORDER BY score DESC, id DESC LIMIT ?",
          minScore,
          count
        )
      : queryAll<{ id: number }>(
          "SELECT id FROM topics WHERE status = 'pool' ORDER BY score DESC, id DESC LIMIT ?",
          count
        );
  return rows.map((row) => Number(row.id));
}

/** 「只帮我找选题」可以顺手把草稿备好，适合先审再发的账号。 */
async function runMineWithDrafts(
  schedule: ScheduleRow,
  config: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const result = await runMine(schedule, config);
  if (!Boolean(config.auto_draft)) return result;
  const output = (result.output as Record<string, unknown>) || {};
  const ids = ((output.topic_ids as unknown[]) || [])
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > 0);
  const take = Math.max(1, Math.min(5, Number(config.draft_count || config.from_pool || 1)));
  const topicIds = ids.slice(0, take);
  if (!topicIds.length) return result;
  let drafts = createDraftsFromTopics(topicIds, {
    accountId: config.account_id ? Number(config.account_id) : null,
    tone: String(config.tone || ""),
    variants: 1,
    platform: schedulePlatform(schedule),
  });
  const withCards = config.with_cards === undefined ? true : Boolean(config.with_cards);
  if (withCards) drafts = await decorateCards(drafts, String(config.card_style || ""), false);
  return {
    message: `${result.message}；已生成 ${drafts.length} 篇草稿`,
    output: {
      ...output,
      draft_ids: drafts.map((draft) => Number(draft.id)),
      with_cards: withCards,
      auto_draft: true,
    },
  };
}

function mineAccount(
  _schedule: ScheduleRow,
  config: Record<string, unknown>
): AccountRow {
  const configured = Number(config.account_id || 0);
  if (configured > 0) {
    const row = queryOne<AccountRow>(
      "SELECT * FROM accounts WHERE id = ?",
      configured
    );
    if (!row) throw new Error(`账号不存在: ${configured}`);
    return row;
  }
  const row = queryOne<AccountRow>(
    "SELECT * FROM accounts WHERE platform = 'xiaohongshu' AND enabled = 1 " +
      "AND status NOT IN ('expired', 'disabled', 'banned') ORDER BY id LIMIT 1"
  );
  if (!row) {
    throw new Error("没有可用的小红书账号，请先在「账号」页添加并检查登录");
  }
  return row;
}

function keywordList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string") {
    return value
      .replace(/，/g, ",")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

/** 从选题生成草稿；与 Python 的 create_drafts 对齐（生成后把选题标记为 used）。 */
function createDraftsFromTopics(
  topicIds: number[],
  options: {
    accountId?: number | null;
    tone?: string;
    variants?: number;
    platform?: string;
  } = {}
): Record<string, unknown>[] {
  const platform = normalizePlatform(options.platform || DEFAULT_PLATFORM);
  const variants = Math.max(1, Math.min(3, Math.trunc(Number(options.variants || 1))));
  const created: Record<string, unknown>[] = [];
  for (const topicId of topicIds) {
    const topic = queryOne<Record<string, unknown>>("SELECT * FROM topics WHERE id = ?", topicId);
    if (!topic) throw new Error(`选题不存在: ${topicId}`);
    for (let index = 0; index < variants; index += 1) {
      const copy = generateCopy(topic, {
        tone: options.tone || "",
        platform,
      });
      const draft = createManual({
        topic_id: topicId,
        account_id: options.accountId ?? null,
        platform,
        title: copy.title,
        desc: copy.desc,
        topics: copy.topics,
        body_md: copy.body_md,
        body_html: copy.body_html,
        source_note: "schedule",
      });
      created.push(draft);
    }
    updateTopic(topicId, { status: "used" });
  }
  return created;
}

/** 给草稿自动配图；链路里配图失败必须算作草稿环失败。 */
async function decorateCards(
  drafts: Record<string, unknown>[],
  style: string,
  strict = false
): Promise<Record<string, unknown>[]> {
  const updated: Record<string, unknown>[] = [];
  const failures: Array<{ draft_id: number; error: string }> = [];
  for (const draft of drafts) {
    const draftId = Number(draft.id);
    try {
      const result = style
        ? await renderDesignCards(draftId, style)
        : await renderDraftCards(draftId, {});
      updated.push(result as Record<string, unknown>);
    } catch (error) {
      const message = short(error instanceof Error ? error.message : String(error), 160);
      failures.push({ draft_id: draftId, error: message });
      updated.push(draft);
    }
  }
  if (strict && failures.length) {
    throw new StageError(
      "draft",
      `${failures.length} 篇草稿配图失败：${failures[0].error}`,
      { draft_ids: updated.map((item) => item.id), failures }
    );
  }
  return updated;
}

function runDraft(schedule: ScheduleRow, config: Record<string, unknown>): Promise<Record<string, unknown>> {
  return (async () => {
    const platform = schedulePlatform(schedule);
    let topicIds = ((config.topic_ids as unknown[]) || [])
      .map((item) => Number(item))
      .filter((item) => Number.isFinite(item) && item > 0);
    if (!topicIds.length) {
      const count = Math.max(1, Math.min(10, Number(config.from_pool || 5)));
      topicIds = queryAll<{ id: number }>(
        "SELECT id FROM topics WHERE status = 'pool' ORDER BY score DESC, id DESC LIMIT ?",
        count
      ).map((row) => Number(row.id));
    }
    if (!topicIds.length) throw new Error("选题池为空，先用「定时找选题」或手动添加");
    const accountId = config.account_id ? Number(config.account_id) : null;
    let drafts = createDraftsFromTopics(topicIds, {
      accountId,
      tone: String(config.tone || ""),
      variants: Number(config.variants || 1),
      platform,
    });
    if (config.with_cards) {
      drafts = await decorateCards(drafts, String(config.card_style || ""), true);
    }
    return {
      message: `从 ${topicIds.length} 个选题生成 ${drafts.length} 篇草稿`,
      output: {
        topic_ids: topicIds,
        draft_ids: drafts.map((draft) => draft.id),
        with_cards: Boolean(config.with_cards),
      },
    };
  })();
}

async function publishDrafts(
  schedule: ScheduleRow,
  config: Record<string, unknown>,
  draftIds: number[]
): Promise<Record<string, unknown>> {
  if (!draftIds.length) throw new Error("没有可发布的草稿，请先在内容库准备");
  const platform = schedulePlatform(schedule);
  const ready: Record<string, unknown>[] = [];
  const blocked: string[] = [];
  for (const draftId of draftIds) {
    let draft: Record<string, unknown>;
    try {
      draft = getDraft(draftId);
    } catch {
      blocked.push(`#${draftId} 已删除`);
      continue;
    }
    const draftPlatform = String(draft.platform || DEFAULT_PLATFORM);
    if (draftPlatform !== platform) {
      blocked.push(`#${draftId} 属于${platformLabel(draftPlatform)}`);
    } else if (draft.status === "published") {
      blocked.push(`#${draftId} 已发布`);
    } else if ((draft.compliance as unknown[])?.length) {
      blocked.push(`#${draftId} 有合规风险`);
    } else if (
      ["image", "video"].includes(String(draft.media_type || "image")) &&
      !(draft.images as unknown[])?.length
    ) {
      blocked.push(`#${draftId} 缺配图`);
    } else {
      ready.push(draft);
    }
  }
  if (!ready.length) {
    const text = `所选草稿都不满足发布条件：${blocked.slice(0, 3).join("、")}`;
    if (Number(schedule.auto) && blocked.some((item) => item.includes("合规"))) {
      throw new StageError("publish", text, { blocked }, `合规拦截：${short(text, 120)}`);
    }
    throw new Error(text);
  }
  const visibility = Number(config.visibility ?? 1);
  for (const draft of ready) {
    if (Number(draft.visibility || 0) !== visibility) {
      updateDraft(Number(draft.id), { visibility });
    }
  }
  const accountIds = ((config.account_ids as unknown[]) || [])
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > 0);

  if (!Number(schedule.auto)) {
    return {
      message: `已准备 ${ready.length} 篇待确认（未发布，可见范围 ${
        visibility === 0 ? "公开" : "仅自己可见"
      }）`,
      status: "pending",
      output: {
        draft_ids: ready.map((draft) => draft.id),
        pending: true,
        publish_status: "pending",
        blocked,
      },
    };
  }

  const jobs: Record<string, unknown>[] = [];
  const errors: string[] = [...blocked];
  for (const draft of ready) {
    try {
      if (accountIds.length) {
        const batch = enqueueTargets(Number(draft.id), accountIds);
        jobs.push(...batch);
      } else {
        jobs.push(enqueue(Number(draft.id)));
      }
    } catch (error) {
      errors.push(`#${draft.id} ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!jobs.length) throw new Error(`全部草稿入队失败：${errors.slice(0, 3).join("；")}`);

  const published: Record<string, unknown>[] = [];
  let pause = "";
  for (const job of jobs) {
    const result = await runJob(Number(job.id));
    published.push(result);
    const text = String(result.message || "");
    if (result.status === "failed" && RISK_HINTS.some((hint) => text.includes(hint))) {
      pause = `发布命中风控/合规：${short(text, 120)}`;
      break;
    }
    if (result.status === "retry" && ["风控", "频繁", "限流"].some((hint) => text.includes(hint))) {
      pause = `账号触发风控：${short(text, 120)}`;
      break;
    }
  }
  const success = published.filter((item) => item.status === "success").length;
  const failed = published.filter((item) => item.status === "failed").length;
  const waiting = published.length - success - failed;
  let publishStatus: string;
  if (success && !failed && !waiting) publishStatus = "success";
  else if (success) publishStatus = "partial";
  else if (failed && !waiting) publishStatus = "failed";
  else publishStatus = "waiting";

  let message: string;
  if (publishStatus === "success") message = `入队 ${jobs.length} 篇，全部发布成功`;
  else if (publishStatus === "failed") {
    const first = String(published.find((item) => item.status === "failed")?.message || "");
    message = `入队 ${jobs.length} 篇，全部失败${first ? `：${short(first, 120)}` : ""}`;
  } else if (publishStatus === "waiting") {
    message = `入队 ${jobs.length} 篇，暂时都没有发出去，等待重试或分配账号`;
  } else {
    message = `入队 ${jobs.length} 篇，成功 ${success}，失败 ${failed}，待重试 ${waiting}`;
  }
  if (pause) message += "；已暂停任务";
  return {
    message,
    status: publishStatus,
    output: {
      draft_ids: ready.map((draft) => draft.id),
      job_ids: jobs.map((job) => job.id),
      results: published,
      blocked: errors,
      publish_status: publishStatus,
      success,
      failed,
      waiting,
    },
    pause,
  };
}

async function runPublish(schedule: ScheduleRow, config: Record<string, unknown>) {
  let draftIds = ((config.draft_ids as unknown[]) || [])
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > 0);
  if (!draftIds.length) {
    const limit = Math.max(1, Math.min(20, Number(config.limit || 3)));
    draftIds = queryAll<{ id: number }>(
      "SELECT id FROM drafts WHERE status = 'draft' AND platform = ? ORDER BY id DESC LIMIT ?",
      schedulePlatform(schedule),
      limit
    ).map((row) => Number(row.id));
  }
  return publishDrafts(schedule, config, draftIds);
}

async function runChain(schedule: ScheduleRow, config: Record<string, unknown>) {
  const stages: Record<string, unknown>[] = [];
  let topicIds: number[] = [];
  let drafts: Record<string, unknown>[] = [];
  let stage = "mine";
  try {
    const count = Math.max(1, Math.min(5, Number(config.from_pool || 1)));
    const minScore = Number(config.min_score || 0);
    let mineSummary = "";
    // 先吃选题池：池子里有题就直接用，只有池空时才去外部挖掘，
    // 避免每次定时都重复抓一批新题把池子灌爆。
    topicIds = poolTopicIds(count, minScore);
    if (topicIds.length) {
      mineSummary = `直接使用选题池 ${topicIds.length} 条（未重新挖掘）`;
      stages.push({
        key: "mine",
        label: STAGE_LABELS.mine,
        status: "success",
        summary: mineSummary,
        topic_ids: topicIds,
        from_pool: true,
        inserted: 0,
        skipped: 0,
        dropped: 0,
        simulated: false,
      });
    } else {
      const mineResult = await runMine(schedule, config);
      const mineOutput = mineResult.output as Record<string, unknown>;
      topicIds = ((mineOutput.topic_ids as number[]) || []).slice(0, count);
      if (!topicIds.length) throw new Error("选题池为空，这次也没挖到合适的选题");
      mineSummary = String(mineResult.message || "已挖掘选题");
      stages.push({
        key: "mine",
        label: STAGE_LABELS.mine,
        status: "success",
        summary: mineSummary,
        topic_ids: topicIds,
        inserted: mineOutput.inserted || 0,
        skipped: mineOutput.skipped || 0,
        dropped: mineOutput.dropped || 0,
        simulated: mineOutput.simulated || false,
      });
    }

    stage = "draft";
    const withCards = config.with_cards === undefined ? true : Boolean(config.with_cards);
    drafts = createDraftsFromTopics(topicIds, {
      accountId: config.account_id ? Number(config.account_id) : null,
      tone: String(config.tone || ""),
      variants: 1,
      platform: schedulePlatform(schedule),
    });
    if (withCards) drafts = await decorateCards(drafts, String(config.card_style || ""), true);
    const imageCount = drafts.reduce(
      (total, draft) => total + ((draft.images as unknown[]) || []).length,
      0
    );
    const draftIds = drafts.map((draft) => Number(draft.id));
    stages.push({
      key: "draft",
      label: STAGE_LABELS.draft,
      status: "success",
      summary:
        `从 ${topicIds.length} 个选题生成 ${drafts.length} 篇草稿` +
        (imageCount ? `，配图 ${imageCount} 张` : "，未配图"),
      draft_ids: draftIds,
      with_cards: withCards,
      image_count: imageCount,
    });

    stage = "publish";
    if (config.publish === false) {
      stages.push({
        key: "publish",
        label: STAGE_LABELS.publish,
        status: "skipped",
        summary: "任务设置为只产草稿，没有发布",
        draft_ids: draftIds,
      });
      return {
        message: `${mineSummary}；生成 ${drafts.length} 篇草稿（未发布）`,
        output: { stages, topic_ids: topicIds, draft_ids: draftIds, pending: false },
      };
    }

    const publishResult = await publishDrafts(schedule, config, draftIds);
    const publishOutput = (publishResult.output as Record<string, unknown>) || {};
    const publishStatus = String(
      publishOutput.publish_status || publishResult.status || "success"
    );
    stages.push({
      key: "publish",
      label: STAGE_LABELS.publish,
      status: publishStatus,
      summary: publishResult.message || "发布完成",
      draft_ids: publishOutput.draft_ids || draftIds,
      job_ids: publishOutput.job_ids || [],
      results: publishOutput.results || [],
      pending: Boolean(publishOutput.pending),
      blocked: publishOutput.blocked || [],
    });
    return {
      message:
        `${mineSummary}；生成 ${drafts.length} 篇草稿；` +
        `${publishResult.message || "发布完成"}`,
      status: ["pending", "waiting"].includes(publishStatus) ? "waiting" : publishStatus,
      output: {
        stages,
        topic_ids: topicIds,
        draft_ids: draftIds,
        job_ids: publishOutput.job_ids || [],
        results: publishOutput.results || [],
        pending: Boolean(publishOutput.pending),
        publish_status: publishStatus,
        blocked: publishOutput.blocked || [],
      },
      pause: publishResult.pause || "",
    };
  } catch (error) {
    stages.push({
      key: stage,
      label: STAGE_LABELS[stage] || stage,
      status: "failed",
      error: short(error instanceof Error ? error.message : String(error), 300),
    });
    const pause =
      error instanceof StageError
        ? error.pause
        : stage === "publish" &&
            RISK_HINTS.some((hint) => String(error).includes(hint))
          ? `发布环节被拦下：${short(String(error), 120)}`
          : "";
    const errorOutput =
      error instanceof StageError ? { ...(error.output || {}) } : ({} as Record<string, unknown>);
    errorOutput.stages = stages;
    errorOutput.topic_ids = topicIds;
    errorOutput.draft_ids =
      (errorOutput.draft_ids as number[]) || drafts.map((draft) => Number(draft.id));
    throw new StageError(stage, error instanceof Error ? error.message : String(error), errorOutput, pause);
  }
}

async function executeSchedule(schedule: ScheduleRow): Promise<Record<string, unknown>> {
  const config = jsonField<Record<string, unknown>>(schedule.config, {});
  switch (schedule.kind) {
    case "publish":
      return runPublish(schedule, config);
    case "mine":
      return runMineWithDrafts(schedule, config);
    case "draft":
      return runDraft(schedule, config);
    case "chain":
      return runChain(schedule, config);
    default:
      throw new Error(`未知任务类型: ${schedule.kind}`);
  }
}

// ---------------------------------------------------------------- 领取与落库

function finish(
  row: ScheduleRow,
  runId: number,
  status: string,
  message: string,
  output: Record<string, unknown>,
  error: string,
  pause: string,
  trigger: string
): void {
  const stamp = now();
  execute(
    "UPDATE schedule_runs SET status=?, finished_at=?, message=?, error=?, output=? WHERE id=?",
    status,
    stamp,
    short(message, 500),
    short(error, 1000),
    JSON.stringify(output, (_key, value) =>
      value === undefined ? null : value
    ).slice(0, 8000),
    runId
  );
  const failures = ["success", "waiting", "partial"].includes(status)
    ? 0
    : Number(row.failures || 0) + 1;
  let paused = pause;
  if (!paused && failures >= MAX_FAILURES) {
    const stage = String(output.failed_stage || "");
    const tail = STAGE_LABELS[stage] ? `（最后一环：${STAGE_LABELS[stage]}）` : "";
    paused = `连续失败 ${failures} 次${tail}，已自动暂停`;
  }
  let nextRun = Number(row.next_run_at || 0);
  if (trigger === "schedule" || !nextRun || nextRun <= stamp) {
    const base = trigger === "schedule" ? nextRun : stamp;
    nextRun = computeNext(
      {
        trigger_type: row.trigger_type,
        time_of_day: row.time_of_day,
        weekdays: row.weekdays,
        interval_minutes: row.interval_minutes,
      },
      base
    );
  }
  if (paused) {
    execute(
      "UPDATE schedules SET running=0, last_run_at=?, last_status=?, last_message=?, " +
        "failures=?, enabled=0, paused_reason=?, next_run_at=?, updated_at=? WHERE id=?",
      stamp,
      status,
      short(message, 300),
      failures,
      short(paused, 300),
      nextRun,
      stamp,
      row.id
    );
    return;
  }
  execute(
    "UPDATE schedules SET running=0, last_run_at=?, last_status=?, last_message=?, " +
      "failures=?, next_run_at=?, updated_at=? WHERE id=?",
    stamp,
    status,
    short(message, 300),
    failures,
    nextRun,
    stamp,
    row.id
  );
}

function claimed(scheduleId: number): boolean {
  const result = getDb()
    .prepare("UPDATE schedules SET running = 1, updated_at = ? WHERE id = ? AND running = 0")
    .run(now(), scheduleId);
  return result.changes === 1;
}

function release(scheduleId: number): void {
  execute("UPDATE schedules SET running = 0, updated_at = ? WHERE id = ?", now(), scheduleId);
}

export async function runSchedule(
  scheduleId: number,
  trigger = "manual"
): Promise<Record<string, unknown>> {
  const row = getScheduleRow(scheduleId);
  if (!claimed(scheduleId)) {
    return { schedule_id: scheduleId, status: "skipped", message: "任务正在执行中" };
  }
  const stamp = now();
  const due = Number(row.next_run_at || 0);
  const late = trigger === "schedule" && due > 0 && stamp - due > 600;
  const runId = execute(
    "INSERT INTO schedule_runs(schedule_id, schedule_name, kind, trigger, status, started_at, " +
      "finished_at, message, error, output, created_at) " +
      "VALUES(?,?,?,?, 'running', ?, 0, '', '', '{}', ?)",
    scheduleId,
    row.name,
    row.kind,
    trigger,
    stamp,
    stamp
  );
  let status = "success";
  let message = "";
  let output: Record<string, unknown> = {};
  let error = "";
  let pause = "";
  try {
    const payload = await executeSchedule(row);
    message = String(payload.message || "执行完成");
    output = (payload.output as Record<string, unknown>) || {};
    pause = String(payload.pause || "");
    status = String(payload.status || "success");
    if (status === "pending") status = "waiting";
    if (late) {
      const when = new Date(due * 1000);
      const pad = (num: number) => String(num).padStart(2, "0");
      message = `补跑（原定 ${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${pad(
        when.getHours()
      )}:${pad(when.getMinutes())}）：${message}`;
    }
  } catch (exc) {
    status = "failed";
    error = `${exc instanceof Error ? exc.name : "Error"}: ${
      exc instanceof Error ? exc.message : String(exc)
    }`;
    message = short(error, 200);
    if (exc instanceof StageError) {
      output = { ...(exc.output || {}), failed_stage: exc.stage };
      pause = exc.pause;
    }
  } finally {
    finish(row, runId, status, message, output, error, pause, trigger);
    release(scheduleId);
  }
  return { schedule_id: scheduleId, run_id: runId, status, message, error, output };
}

let scheduling = false;

export async function tickSchedules(limit = 2): Promise<Record<string, unknown>> {
  if (scheduling) {
    return { ran: 0, skipped: "上一轮定时调度尚未结束" };
  }
  scheduling = true;
  try {
    const stamp = now();
    const rows = queryAll<{ id: number }>(
      "SELECT id FROM schedules WHERE enabled = 1 AND running = 0 AND next_run_at > 0 " +
        "AND next_run_at <= ? ORDER BY next_run_at LIMIT ?",
      stamp,
      Math.max(1, limit)
    );
    const results: Record<string, unknown>[] = [];
    for (const row of rows) results.push(await runSchedule(Number(row.id), "schedule"));
    return { ran: results.length, results };
  } finally {
    scheduling = false;
  }
}

/** 启动时清理残留状态：中断的执行标记失败，任务重新可领取。 */
export function recoverSchedules(): { interrupted: number; overdue: number } {
  const stamp = now();
  const stale = queryAll<{ id: number }>("SELECT id FROM schedule_runs WHERE status = 'running'");
  for (const row of stale) {
    execute(
      "UPDATE schedule_runs SET status='interrupted', finished_at=?, " +
        "message='服务重启，执行未完成，已标记中断', error='服务重启' WHERE id=?",
      stamp,
      row.id
    );
  }
  execute("UPDATE schedules SET running = 0 WHERE running = 1");
  const overdue = queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM schedules WHERE enabled = 1 AND next_run_at <= ?",
    stamp
  );
  return { interrupted: stale.length, overdue: Number(overdue?.n || 0) };
}

// ---------------------------------------------------------------- 重跑与确认

export async function rerunStage(runId: number, stage = ""): Promise<Record<string, unknown>> {
  const runRow = queryOne<Record<string, unknown>>("SELECT * FROM schedule_runs WHERE id = ?", runId);
  if (!runRow) throw Object.assign(new Error(`运行记录不存在: ${runId}`), { status: 404 });
  const baseOutput = jsonField<Record<string, unknown>>(runRow.output, {});
  const target = String(stage || baseOutput.failed_stage || "").trim();
  if (!STAGE_ORDER.includes(target as never)) {
    throw new Error("只能重跑「找选题 / 写草稿 / 发布」其中一环");
  }
  const schedule = getScheduleRow(Number(runRow.schedule_id));
  const config = jsonField<Record<string, unknown>>(schedule.config, {});
  if (!claimed(schedule.id)) {
    return { schedule_id: schedule.id, status: "skipped", message: "任务正在执行中" };
  }
  const stamp = now();
  const newRunId = execute(
    "INSERT INTO schedule_runs(schedule_id, schedule_name, kind, trigger, status, started_at, " +
      "finished_at, message, error, output, created_at) " +
      "VALUES(?,?,?,?, 'running', ?, 0, '', '', '{}', ?)",
    schedule.id,
    schedule.name,
    schedule.kind,
    `retry:${target}`,
    stamp,
    stamp
  );
  let stages = ((baseOutput.stages as Record<string, unknown>[]) || []).map((item) => ({ ...item }));
  const output: Record<string, unknown> = { ...baseOutput };
  let status = "success";
  let message = "";
  let error = "";
  let pause = "";
  try {
    let entry: Record<string, unknown>;
    if (target === "mine") {
      const result = await runMine(schedule, config);
      const resultOutput = result.output as Record<string, unknown>;
      entry = {
        key: "mine",
        label: STAGE_LABELS.mine,
        status: "success",
        summary: result.message,
        topic_ids: resultOutput.topic_ids || [],
        inserted: resultOutput.inserted || 0,
        skipped: resultOutput.skipped || 0,
        dropped: resultOutput.dropped || 0,
      };
      output.topic_ids = entry.topic_ids;
    } else if (target === "draft") {
      const topicIds = ((baseOutput.topic_ids as unknown[]) || [])
        .map((item) => Number(item))
        .filter((item) => Number.isFinite(item) && item > 0);
      if (!topicIds.length) throw new Error("上一次执行没有留下选题，无法只重跑草稿环节");
      const withCards = config.with_cards === undefined ? true : Boolean(config.with_cards);
      let drafts = createDraftsFromTopics(topicIds, {
        accountId: config.account_id ? Number(config.account_id) : null,
        tone: String(config.tone || ""),
        variants: 1,
        platform: schedulePlatform(schedule),
      });
      if (withCards) drafts = await decorateCards(drafts, String(config.card_style || ""));
      const imageCount = drafts.reduce(
        (total, draft) => total + ((draft.images as unknown[]) || []).length,
        0
      );
      entry = {
        key: "draft",
        label: STAGE_LABELS.draft,
        status: "success",
        summary:
          `重跑生成 ${drafts.length} 篇草稿` + (imageCount ? `，配图 ${imageCount} 张` : ""),
        draft_ids: drafts.map((draft) => draft.id),
        with_cards: withCards,
        image_count: imageCount,
      };
      output.draft_ids = entry.draft_ids;
    } else {
      const draftIds = ((baseOutput.draft_ids as unknown[]) || [])
        .map((item) => Number(item))
        .filter((item) => Number.isFinite(item) && item > 0);
      const result = await publishDrafts(schedule, config, draftIds);
      const resultOutput = (result.output as Record<string, unknown>) || {};
      const publishStatus = String(resultOutput.publish_status || result.status || "success");
      entry = {
        key: "publish",
        label: STAGE_LABELS.publish,
        status: publishStatus,
        summary: result.message || "发布完成",
        draft_ids: resultOutput.draft_ids || draftIds,
        job_ids: resultOutput.job_ids || [],
        results: resultOutput.results || [],
        pending: Boolean(resultOutput.pending),
        blocked: resultOutput.blocked || [],
      };
      output.job_ids = entry.job_ids;
      output.results = entry.results;
      output.pending = entry.pending;
      output.publish_status = publishStatus;
      status = ["pending", "waiting"].includes(publishStatus) ? "waiting" : publishStatus;
      pause = String(result.pause || "");
    }
    // 重跑上游环节后，下游产物与新结果对不上：丢掉旧的下游节点与待确认状态。
    if (target === "mine") {
      stages = stages.filter((item) => item.key === "mine");
      for (const key of ["draft_ids", "job_ids", "results", "pending", "blocked", "confirmed_at"]) {
        delete output[key];
      }
    } else if (target === "draft") {
      stages = stages.filter((item) => ["mine", "draft"].includes(String(item.key)));
      for (const key of ["job_ids", "results", "pending", "blocked", "confirmed_at"]) {
        delete output[key];
      }
    }
    const merged: Record<string, Record<string, unknown>> = {};
    for (const item of stages) merged[String(item.key)] = item;
    merged[target] = entry;
    output.stages = STAGE_ORDER.filter((key) => merged[key]).map((key) => merged[key]);
    output.failed_stage = ["success", "waiting", "partial"].includes(status) ? "" : target;
    message = `只重跑「${STAGE_LABELS[target]}」：${entry.summary || "完成"}`;
  } catch (exc) {
    status = "failed";
    error = `${exc instanceof Error ? exc.name : "Error"}: ${
      exc instanceof Error ? exc.message : String(exc)
    }`;
    message = `重跑「${STAGE_LABELS[target]}」失败：${short(
      exc instanceof Error ? exc.message : String(exc),
      160
    )}`;
    const merged: Record<string, Record<string, unknown>> = {};
    for (const item of stages) merged[String(item.key)] = item;
    merged[target] = {
      key: target,
      label: STAGE_LABELS[target],
      status: "failed",
      error: short(exc instanceof Error ? exc.message : String(exc), 300),
    };
    output.stages = STAGE_ORDER.filter((key) => merged[key]).map((key) => merged[key]);
    output.failed_stage = target;
    if (target === "publish" && RISK_HINTS.some((hint) => String(exc).includes(hint))) {
      pause = `发布环节被拦下：${short(String(exc), 120)}`;
    }
  }
  try {
    finish(schedule, newRunId, status, message, output, error, pause, "manual");
  } finally {
    release(schedule.id);
  }
  return {
    schedule_id: schedule.id,
    run_id: newRunId,
    stage: target,
    status,
    message,
    error,
    output,
  };
}

/** 全自动关闭时，人工确认一条运行记录里的待发布草稿。 */
export async function confirmRun(runId: number): Promise<Record<string, unknown>> {
  const row = queryOne<Record<string, unknown>>("SELECT * FROM schedule_runs WHERE id = ?", runId);
  if (!row) throw Object.assign(new Error(`运行记录不存在: ${runId}`), { status: 404 });
  const output = jsonField<Record<string, unknown>>(row.output, {});
  const draftIds = ((output.draft_ids as unknown[]) || [])
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > 0);
  if (!draftIds.length) throw new Error("这条运行记录没有待确认的草稿");
  if (output.confirmed_at) throw new Error("这条记录已经确认过，请勿重复发布");
  // 原子认领：把 confirmed_at 先写回，避免两个请求同时通过上面的检查重复发布。
  const stamp = now();
  const claimed = getDb()
    .prepare(
      "UPDATE schedule_runs SET output=? WHERE id=? AND instr(IFNULL(output,''), ?) = 0"
    )
    .run(JSON.stringify({ ...output, confirmed_at: stamp }), runId, '"confirmed_at"');
  if (Number(claimed.changes) !== 1) {
    throw new Error("这条记录已经确认过，请勿重复发布");
  }
  const schedule = queryOne<Record<string, unknown>>("SELECT * FROM schedules WHERE id = ?", row.schedule_id);
  const config = schedule ? jsonField<Record<string, unknown>>(schedule.config, {}) : {};
  const accountIds = ((config.account_ids as unknown[]) || [])
    .map((item) => Number(item))
    .filter((item) => Number.isFinite(item) && item > 0);
  const jobs: Record<string, unknown>[] = [];
  const errors: string[] = [];
  for (const draftId of draftIds) {
    try {
      if (accountIds.length) jobs.push(...enqueueTargets(draftId, accountIds));
      else jobs.push(enqueue(draftId));
    } catch (error) {
      errors.push(`#${draftId} ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const results: Record<string, unknown>[] = [];
  for (const job of jobs) results.push(await runJob(Number(job.id)));
  const success = results.filter((item) => item.status === "success").length;
  const failed = results.filter((item) => item.status === "failed").length;
  const waiting = results.length - success - failed;
  let runStatus: string;
  if (!jobs.length) runStatus = "failed";
  else if (success === results.length) runStatus = "success";
  else if (success) runStatus = "partial";
  else if (failed === results.length) runStatus = "failed";
  else runStatus = "waiting";
  const message = `已确认发布：成功 ${success}，失败 ${failed}，待重试 ${waiting}`;
  output.confirmed_at = stamp;
  output.job_ids = jobs.map((job) => job.id);
  output.results = results;
  output.errors = ((output.errors as unknown[]) || []).concat(errors);
  output.publish_status = runStatus;
  execute(
    "UPDATE schedule_runs SET output=?, message=?, status=? WHERE id=?",
    JSON.stringify(output).slice(0, 8000),
    short(message, 300),
    runStatus,
    runId
  );
  return {
    run_id: runId,
    status: runStatus,
    enqueued: jobs.length,
    success,
    failed,
    waiting,
    errors,
    results,
  };
}

export function schedulerStatus(): Record<string, unknown> {
  const row = queryOne<Record<string, number>>(
    "SELECT SUM(CASE WHEN enabled=1 THEN 1 ELSE 0 END) AS enabled, " +
      "SUM(CASE WHEN running=1 THEN 1 ELSE 0 END) AS running, " +
      "SUM(CASE WHEN enabled=1 AND paused_reason != '' THEN 1 ELSE 0 END) AS paused FROM schedules"
  );
  return {
    enabled: Number(row?.enabled || 0),
    running: Number(row?.running || 0),
    paused: Number(row?.paused || 0),
    kinds: KINDS,
    focus_keywords: focusKeywords(),
  };
}
