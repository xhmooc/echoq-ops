/**
 * 本地 API：真实前端（ops/web/static）在 Electron 里调用的全部端点。
 *
 * 约定与 Python 版一致：成功 {ok:true,data,...}，失败 {ok:false,error}。
 * 迁移期平台发布/图片渲染等重活仍以 Python 版为准，这里先把只读与
 * 数据库 CRUD 打通，避免前端因为 404 整体不可用。
 */
import fs from "node:fs";
import path from "node:path";
import { now, DATA_DIR, KEY_PATH, DB_PATH, BACKUP_DIR } from "../core/config";
import { execute, queryAll, queryOne } from "../core/db";
import {
  addCookie,
  availability,
  clearCooldown,
  decryptSession,
  deleteAccount,
  accountGroups,
  getAccount,
  limits,
  listAccounts,
  listAccountsFiltered,
  markChecked,
  saveProfile,
  saveSession,
  updateAccount,
  upsertSession,
  type AccountRow,
} from "../core/accounts";
import { listPlatforms, platformLabel, normalizePlatform } from "../core/platform";
import { HttpError, Router } from "./http";
import { QrRegistry } from "../platforms/wechat/qr";
import { checkSession, publishDraft } from "../platforms/wechat/publish";
import { DouyinQrRegistry } from "../platforms/douyin/qr";
import { checkSession as douyinCheckSession } from "../platforms/douyin/adapter";
import { fetchPublished, markSyncError, savePublished } from "../platforms/wechat/published";
import { overview } from "../services/overview";
import {
  addManual as addTopic,
  countTopics,
  deleteTopics,
  getTopic,
  importLibrary,
  importText,
  listDedupes,
  listTopics,
  updateTopic,
} from "../services/topics";
import {
  countDrafts,
  createManual,
  deleteDraft,
  deleteDrafts,
  getDraft,
  listDrafts,
  switchPlatform,
  updateDraft,
} from "../services/drafts";
import {
  cancelJob,
  confirmJob,
  countJobs,
  enqueue,
  enqueueMany,
  enqueueTargets,
  listJobs,
  listRecords,
  countRecordsSummary,
  queueReasons,
  retryJob,
} from "../services/queue";
import {
  countRuns,
  countSchedules,
  createSchedule,
  deleteSchedule,
  listRuns,
  listSchedules,
  quickCreateSchedule,
  updateSchedule,
} from "../services/schedules";
import { accountsStatus, listComments, listNotes, metrics, saveComments, sourcesMeta } from "../services/published";
import {
  addChannel,
  addProxy,
  backupPath,
  deleteBackup,
  deleteChannel,
  deleteProxy,
  listBackups,
  listChannels,
  listNotifications,
  listProxies,
  markNotificationsRead,
  settingsPublic,
  testChannel,
  testProxy,
  updateChannel,
  updateProxy,
  updateSettings,
} from "../services/misc";
import { getTask, submit } from "../services/tasks";
import { applyTheme, listThemes, render as renderRich } from "../services/richtext";
import { checkCopy, generateCopy, generateFromBrief, rewriteCopy } from "../services/copy";
import { handleUpload } from "../services/uploads";
import { createBackup, restoreBackup } from "../services/backup";
import {
  renderArtworkInline,
  renderCover,
  renderDesignCards,
  renderDraftCards,
  renderMotion,
} from "../render/cards";
import { CARD_LAYOUTS, CARD_PALETTES, CARD_STYLES, ART_STYLES, isArtStyle } from "../render/templates";
import { confirmRun, rerunStage, runSchedule, tickSchedules } from "../services/schedulerEngine";
import { startLoop, stopLoop, tick as workerTick, workerStatus } from "../services/worker";
import * as cloud from "../services/cloud";
import {
  checkSession as xhsCheckSession,
  fetchComments as xhsFetchComments,
  fetchPublished as xhsFetchPublished,
  mine as xhsMine,
} from "../platforms/xiaohongshu/adapter";

const registry = new QrRegistry();
const douyinRegistry = new DouyinQrRegistry();

function ok(data: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ok: true, data, ...extra };
}

function intParam(value: string, label = "ID"): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new HttpError(400, `${label} 不正确`);
  return Math.trunc(parsed);
}

function accountOr404(id: number): AccountRow {
  if (!Number.isFinite(id) || id <= 0) throw new HttpError(400, "账号 ID 不正确");
  const row = queryOne<AccountRow>("SELECT * FROM accounts WHERE id = ?", id);
  if (!row) throw new HttpError(404, `账号不存在: ${id}`);
  return row;
}

function draftOr404(id: number): void {
  const row = queryOne<{ id: number }>("SELECT id FROM drafts WHERE id = ?", id);
  if (!row) throw new HttpError(404, `草稿不存在: ${id}`);
}

function csvResponse(res: import("node:http").ServerResponse, filename: string, rows: string[][]): void {
  const body = rows
    .map((line) =>
      line
        .map((cell) => {
          const text = String(cell ?? "");
          return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
        })
        .join(",")
    )
    .join("\r\n");
  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${encodeURIComponent(filename)}"`,
    "Cache-Control": "no-store",
  });
  res.end("\ufeff" + body);
}

function dateText(stamp: unknown): string {
  const value = Number(stamp || 0);
  if (!value) return "";
  const date = new Date(value * 1000);
  const pad = (num: number) => String(num).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function diagnoseAccount(row: AccountRow): Record<string, unknown> {
  const item = listAccounts(row.platform).find((entry) => Number(entry.id) === row.id);
  const [limit, interval, jitter] = limits(row);
  const [can, reason, nextAt] = availability(row);
  const synced = Number(
    queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM published_notes WHERE account_id=?", row.id)?.n || 0
  );
  const risky = Number(
    queryOne<{ n: number }>(
      "SELECT COUNT(*) AS n FROM published_notes WHERE account_id=? AND health_state IN ('zero_views','risky','removed')",
      row.id
    )?.n || 0
  );
  const jobs: Record<string, number> = {};
  for (const status of ["pending", "retry", "running", "pending_confirm", "success", "failed"]) {
    jobs[status] = Number(
      queryOne<{ n: number }>(
        "SELECT COUNT(*) AS n FROM jobs WHERE account_id=? AND status=?",
        row.id,
        status
      )?.n || 0
    );
  }
  const records = queryAll<Record<string, unknown>>(
    "SELECT * FROM records WHERE account_id=? ORDER BY id DESC LIMIT 5",
    row.id
  ).map((record) => {
    let evidence: unknown = {};
    try {
      const payload = JSON.parse(String(record.result || "{}"));
      evidence = payload && typeof payload === "object" ? (payload as Record<string, unknown>).evidence || {} : {};
    } catch {
      evidence = {};
    }
    return {
      id: record.id,
      success: Boolean(record.success),
      message: record.message,
      created_at: record.created_at,
      remote_note_id: record.remote_note_id,
      evidence,
    };
  });
  const riskEvents = queryAll<Record<string, unknown>>(
    "SELECT * FROM risk_events WHERE account_id=? ORDER BY id DESC LIMIT 8",
    row.id
  ).map((risk) => ({
    id: risk.id,
    type: risk.type,
    reason: risk.reason,
    source: risk.source,
    started_at: risk.started_at,
    ended_at: risk.ended_at,
  }));
  const today = Number(item?.published_today || 0);
  const platform = String(row.platform || "xiaohongshu");
  const checklist = [
    { key: "login", label: "登录态", ok: row.status === "healthy", hint: item?.status_text },
    { key: "enabled", label: "账号启用", ok: Boolean(row.enabled), hint: row.enabled ? "已启用" : "已停用" },
    {
      key: "risk",
      label: "风控状态",
      ok: Number(row.cooldown_until || 0) <= now(),
      hint: Number(row.cooldown_until || 0) > now() ? "冷却中" : "未在冷却",
    },
    { key: "platform", label: "发布能力", ok: true, hint: "已接入" },
    { key: "quota", label: "今日额度", ok: today < limit, hint: `${today} / ${limit} 篇` },
    { key: "sync", label: "内容同步", ok: !row.published_sync_error, hint: row.published_sync_error || "正常" },
  ];
  return {
    account: item,
    publish: {
      available: can,
      reason: reason || (can ? "可以发布" : "暂不可发布"),
      next_available_at: nextAt,
      daily_limit: limit,
      used_today: today,
      min_interval_sec: interval,
      jitter_sec: jitter,
    },
    environment: {
      profile_key: item?.profile_key || "",
      proxy: row.proxy || "",
      proxy_group: row.proxy_group || "",
      exit_ip: row.exit_ip || "",
      exit_country: row.exit_country || "",
      exit_timezone: row.exit_timezone || "",
      exit_checked_at: Number(row.exit_checked_at || 0),
      lanes: [
        { key: "read", label: "浏览 / 同步", ok: row.status === "healthy", hint: "能查看笔记" },
        {
          key: "publish",
          label: "创作者发布",
          ok: row.status === "healthy",
          hint: "能查看笔记 ≠ 能发布，发布前请在平台上确认创作者身份",
        },
      ],
    },
    sync: {
      synced_at: row.published_synced_at || 0,
      error: row.published_sync_error || "",
      published_total: synced,
      abnormal_total: risky,
    },
    jobs,
    recent_records: records,
    risk_events: riskEvents,
    checklist,
    platform,
  };
}

export function buildRouter(): Router {
  const router = new Router();

  // ---------------------------------------------------------------- 站点
  router.get("/api/health", () => {
    const inside = KEY_PATH.startsWith(DATA_DIR);
    return ok({
      status: "ok",
      engine: "node",
      data_dir: DATA_DIR,
      db: { path: DB_PATH, exists: fs.existsSync(DB_PATH) },
      key: {
        path: KEY_PATH,
        exists: fs.existsSync(KEY_PATH),
        outside_data_dir: !inside,
        restricted: true,
        warning: fs.existsSync(KEY_PATH) ? "" : "密钥尚未生成，扫码保存账号时会提示",
      },
    });
  });
  router.get("/api/overview", () => ok(overview()));
  router.get("/api/platforms", () => ok(listPlatforms()));

  // ---------------------------------------------------------------- 设置
  router.get("/api/settings", () => ok(settingsPublic()));
  router.patch("/api/settings", (ctx) => ok(updateSettings(ctx.body)));

  // ---------------------------------------------------------------- 账号
  router.get("/api/accounts", (ctx) => {
    const platform = ctx.query.get("platform") || "";
    const group = ctx.query.get("group") || "";
    const items = listAccountsFiltered(platform, group);
    return ok(items, { total: items.length });
  });
  router.get("/api/accounts/groups", () => ok(accountGroups()));
  router.post("/api/accounts", (ctx) => {
    const account = addCookie(
      String(ctx.body.name || ""),
      String(ctx.body.cookie || ""),
      String(ctx.body.proxy || ""),
      normalizePlatform(ctx.body.platform || "xiaohongshu")
    );
    return ok(account);
  });
  router.post("/api/accounts/import-env", () => {
    const cookie = String(process.env.COOKIES || "").trim().replace(/^['"]|['"]$/g, "");
    if (!cookie) throw new HttpError(400, ".env 中没有 COOKIES，请先登录或手动添加账号");
    return ok(addCookie("", cookie, ""));
  });
  router.post("/api/accounts/batch", (ctx) => {
    let ids = ctx.body.ids ?? ctx.body.account_ids ?? [];
    if (typeof ids === "string") ids = ids.split(",").filter((item) => item.trim());
    const accountIds = (Array.isArray(ids) ? ids : []).map((item) => intParam(String(item), "账号 ID"));
    if (!accountIds.length) throw new HttpError(400, "请至少选择一个账号");
    accountIds.forEach((id) => accountOr404(id));
    const action = String(ctx.body.action || "");
    const stamp = now();
    if (action === "enable" || action === "disable") {
      for (const id of accountIds) {
        execute("UPDATE accounts SET enabled=?, updated_at=? WHERE id=?", action === "enable" ? 1 : 0, stamp, id);
      }
      return ok({ action, count: accountIds.length, message: "账号状态已更新" });
    }
    if (action === "group") {
      const group = String(ctx.body.group_name || "").slice(0, 30);
      for (const id of accountIds) execute("UPDATE accounts SET group_name=?, updated_at=? WHERE id=?", group, stamp, id);
      return ok({ action, count: accountIds.length, message: "分组已更新" });
    }
    if (action === "tag") {
      const tags = JSON.stringify(
        (Array.isArray(ctx.body.tags) ? ctx.body.tags : []).slice(0, 8).map((item) => String(item).slice(0, 20))
      );
      for (const id of accountIds) execute("UPDATE accounts SET tags=?, updated_at=? WHERE id=?", tags, stamp, id);
      return ok({ action, count: accountIds.length, message: "标签已更新" });
    }
    if (action === "clear_cooldown") {
      accountIds.forEach((id) => clearCooldown(id, true));
      return ok({ action, count: accountIds.length, message: "已解除冷却" });
    }
    if (action === "check") {
      const results: Record<string, unknown>[] = [];
      for (const id of accountIds) results.push(diagnoseAccount(accountOr404(id)) as Record<string, unknown>);
      return ok({ action, count: accountIds.length, results, message: `已检查 ${accountIds.length} 个账号` });
    }
    throw new HttpError(400, "不支持的批量操作");
  });
  router.post("/api/accounts/qr", async (ctx) => {
    const platform = normalizePlatform(ctx.body.platform || "wechat_mp");
    if (platform !== "wechat_mp" && platform !== "douyin") {
      throw new HttpError(400, "小红书暂不支持扫码登录，请粘贴 Cookie 接入");
    }
    if (!fs.existsSync(KEY_PATH)) throw new HttpError(400, `未找到 Cookie 加密密钥：${KEY_PATH}`);
    const proxy = String(ctx.body.proxy || "");
    return ok(
      platform === "douyin" ? await douyinRegistry.start(proxy) : await registry.start(proxy)
    );
  });
  router.get("/api/accounts/qr/:sid", (ctx) => {
    const sid = ctx.params.sid;
    return ok(sid.startsWith("dy") ? douyinRegistry.poll(sid) : registry.poll(sid));
  });
  router.post("/api/accounts/qr/:sid/save", (ctx) => {
    const sid = ctx.params.sid;
    const isDouyin = sid.startsWith("dy");
    const session = isDouyin ? douyinRegistry.get(sid) : registry.get(sid);
    const payload = session.payload() as unknown as {
      status?: string;
      message?: string;
      nickname?: string;
      red_id?: string;
      avatar?: string;
    };
    if (payload.status !== "confirmed") {
      throw new HttpError(400, payload.message || "扫码尚未完成");
    }
    const state = session.accountPayload() as Record<string, unknown> & {
      cookie_header?: string;
      avatar?: string;
    };
    if (!state.cookie_header) {
      throw new HttpError(400, "扫码完成但没有拿到有效登录态，请重试");
    }
    const account = upsertSession(
      isDouyin ? "douyin" : "wechat_mp",
      String(ctx.body.name || payload.nickname || (isDouyin ? "抖音账号" : "公众号")),
      state,
      {
        nickname: payload.nickname,
        redId: payload.red_id,
        userId: payload.red_id,
        avatar: payload.avatar || state.avatar,
      }
    );
    if (isDouyin) douyinRegistry.drop(sid);
    else registry.drop(sid);
    return ok(account);
  });
  router.post("/api/accounts/qr/:sid/window", (ctx) => {
    const sid = ctx.params.sid;
    return ok(
      sid.startsWith("dy")
        ? douyinRegistry.get(sid).openWindow()
        : registry.get(sid).openWindow()
    );
  });
  router.patch("/api/accounts/:id", (ctx) => ok(updateAccount(intParam(ctx.params.id, "账号 ID"), ctx.body)));
  router.delete("/api/accounts/:id", (ctx) => {
    deleteAccount(intParam(ctx.params.id, "账号 ID"));
    return ok({ deleted: true });
  });
  router.get("/api/accounts/:id/diagnose", (ctx) =>
    ok(diagnoseAccount(accountOr404(intParam(ctx.params.id, "账号 ID"))))
  );
  router.post("/api/accounts/:id/check", async (ctx) => {
    const id = intParam(ctx.params.id, "账号 ID");
    const row = accountOr404(id);
    const result =
      row.platform === "xiaohongshu"
        ? await xhsCheckSession(row)
        : row.platform === "douyin"
          ? await douyinCheckSession(decryptSession(row), row.proxy || "")
          : await checkSession(decryptSession(row), row.proxy || "");
    markChecked(id, Boolean(result.ok), result.message || "");
    if (result.ok) {
      saveProfile(id, {
        nickname: result.nickname,
        red_id: result.red_id,
        user_id: result.user_id,
        avatar: result.avatar,
      });
    }
    return ok(result);
  });
  router.post("/api/accounts/:id/proxy-test", async (ctx) => {
    const id = intParam(ctx.params.id, "账号 ID");
    const row = accountOr404(id);
    if (!String(row.proxy || "").trim()) throw new HttpError(400, "该账号使用直连，没有可测试的代理");
    const result = await testProxy(null, row.proxy);
    const changed = Boolean(row.exit_ip && row.exit_ip !== result.exit_ip);
    execute(
      "UPDATE accounts SET exit_ip=?, exit_country=?, exit_timezone=?, exit_checked_at=?, updated_at=? WHERE id=?",
      result.exit_ip,
      result.country,
      result.timezone,
      now(),
      now(),
      id
    );
    return ok({ ...result, changed, message: changed ? "出口 IP 发生变化，留意账号环境" : "出口正常" });
  });
  router.post("/api/accounts/:id/cooldown/clear", (ctx) => {
    const id = intParam(ctx.params.id, "账号 ID");
    accountOr404(id);
    clearCooldown(id, true);
    return ok(diagnoseAccount(accountOr404(id)));
  });
  router.post("/api/accounts/:id/publish", async (ctx) => {
    const id = intParam(ctx.params.id, "账号 ID");
    const row = accountOr404(id);
    if (row.platform !== "wechat_mp") throw new HttpError(400, "当前节点只支持公众号发布");
    const session = decryptSession(row);
    const payload = {
      title: String(ctx.body.title || ""),
      desc: String(ctx.body.desc || ""),
      body_html: String(ctx.body.body_html || ""),
      wx_theme: String(ctx.body.wx_theme || ""),
      images: Array.isArray(ctx.body.images) ? (ctx.body.images as unknown[]).map(String) : [],
      content_type: String(ctx.body.content_type || "long_article"),
    };
    const outcome = await publishDraft(session, payload, row.proxy || "");
    const draftId = String(outcome.result.draft_id || "");
    execute(
      "INSERT INTO records(job_id, draft_id, account_id, platform, success, message, remote_note_id, result, created_at) " +
        "VALUES(NULL, NULL, ?, 'wechat_mp', ?, ?, ?, ?, ?)",
      id,
      outcome.ok ? 1 : 0,
      outcome.message,
      draftId,
      JSON.stringify(outcome.result),
      now()
    );
    if (outcome.ok) execute("UPDATE accounts SET last_publish_at=?, updated_at=? WHERE id=?", now(), now(), id);
    return ok({ ok: outcome.ok, message: outcome.message, result: outcome.result, kind: outcome.kind || "" });
  });

  // ---------------------------------------------------------------- 代理
  router.get("/api/proxies", () => ok(listProxies()));
  router.post("/api/proxies", (ctx) => ok(addProxy(ctx.body)));
  router.post("/api/proxies/test", async (ctx) => ok(await testProxy(null, String(ctx.body.url || ""))));
  router.patch("/api/proxies/:id", (ctx) => ok(updateProxy(intParam(ctx.params.id, "代理 ID"), ctx.body)));
  router.delete("/api/proxies/:id", (ctx) => {
    deleteProxy(intParam(ctx.params.id, "代理 ID"));
    return ok({ deleted: true });
  });
  router.post("/api/proxies/:id/test", async (ctx) =>
    ok(await testProxy(intParam(ctx.params.id, "代理 ID")))
  );

  // ---------------------------------------------------------------- 选题
  router.get("/api/topics", (ctx) => {
    const status = ctx.query.get("status") || "";
    const query = ctx.query.get("q") || "";
    const limit = Math.max(1, Math.min(500, Number(ctx.query.get("limit") || 200)));
    const offset = Math.max(0, Number(ctx.query.get("offset") || 0));
    const source = ctx.query.get("source") || "";
    const category = ctx.query.get("category") || "";
    const minScore = Number(ctx.query.get("min_score") || 0);
    const sort = ctx.query.get("sort") || "score";
    const items = listTopics(status, query, limit, source, category, minScore, sort, offset);
    return ok(items, { total: countTopics(status, query, source, category, minScore), limit, offset });
  });
  router.get("/api/topics/dedupes", (ctx) => ok(listDedupes(Number(ctx.query.get("limit") || 50))));
  router.post("/api/topics/mine", async (ctx) => {
    const rawId = ctx.body.account_id;
    let account: AccountRow;
    if (rawId === null || rawId === undefined || rawId === "") {
      const candidates = queryAll<AccountRow>(
        "SELECT * FROM accounts WHERE platform = 'xiaohongshu' AND enabled = 1 ORDER BY id"
      ).filter(
        (row) => !["expired", "disabled", "banned"].includes(String(row.status || ""))
      );
      if (!candidates.length) {
        throw new HttpError(
          400,
          "没有可用的小红书账号，请先在「账号」页添加并检查登录"
        );
      }
      account = candidates[0];
    } else {
      account = accountOr404(Number(rawId));
      if (normalizePlatform(account.platform) !== "xiaohongshu") {
        throw new HttpError(400, "选题挖掘只支持小红书账号");
      }
    }
    const toList = (value: unknown): string[] => {
      if (Array.isArray(value)) {
        return value.map((item) => String(item).trim()).filter(Boolean);
      }
      return String(value || "")
        .replace(/，/g, ",")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    };
    const result = await xhsMine(account, {
      mode: String(ctx.body.mode || "keyword"),
      keywords: toList(ctx.body.keywords),
      user_urls: toList(ctx.body.user_urls),
      per_kw: Math.max(1, Math.min(50, Number(ctx.body.per_kw || 20))),
      limit: Math.max(1, Math.min(100, Number(ctx.body.limit || 30))),
      sort_type_choice: Number(ctx.body.sort_type_choice || 0),
      detail_limit: Math.max(0, Math.min(20, Number(ctx.body.detail_limit ?? 5))),
      product: Boolean(ctx.body.product),
    });
    return ok(result);
  });
  router.post("/api/topics", (ctx) =>
    ok(
      addTopic({
        title: String(ctx.body.title || ""),
        angle: String(ctx.body.angle || ""),
        keyword: String(ctx.body.keyword || ""),
        category: String(ctx.body.category || ""),
        tone: String(ctx.body.tone || ""),
        product: Boolean(ctx.body.product),
      })
    )
  );
  router.post("/api/topics/import", (ctx) => ok(importText(String(ctx.body.text || ""))));
  router.post("/api/topics/import-library", (ctx) => {
    const target =
      String(ctx.body.path || "") ||
      path.join(__dirname, "..", "..", "..", "xhs-promo", "topics", "library.json");
    return ok(importLibrary(target));
  });
  router.patch("/api/topics/:id", (ctx) => ok(updateTopic(intParam(ctx.params.id, "选题 ID"), ctx.body)));
  router.delete("/api/topics/:id", (ctx) => {
    deleteTopics([intParam(ctx.params.id, "选题 ID")]);
    return ok({ deleted: true });
  });
  router.post("/api/topics/batch-delete", (ctx) => {
    let ids = ctx.body.ids ?? ctx.body.topic_ids ?? [];
    if (typeof ids === "string") ids = ids.split(",").filter((item) => item.trim());
    const topicIds = (Array.isArray(ids) ? ids : []).map((item) => intParam(String(item), "选题 ID"));
    return ok({ deleted: deleteTopics(topicIds) });
  });

  // ---------------------------------------------------------------- 文案
  router.post("/api/copy/generate", (ctx) =>
    ok(
      generateFromBrief(String(ctx.body.brief || ""), {
        topic: String(ctx.body.topic || ""),
        tone: String(ctx.body.tone || ""),
        tags: ctx.body.tags === undefined ? true : Boolean(ctx.body.tags),
        product: Boolean(ctx.body.product),
        platform: String(ctx.body.platform || ""),
      })
    )
  );
  router.post("/api/copy/rewrite", (ctx) => {
    const result = rewriteCopy(String(ctx.body.title || ""), String(ctx.body.desc || ctx.body.body || ""), {
      angle: String(ctx.body.angle || ""),
      tone: String(ctx.body.tone || ""),
      platform: String(ctx.body.platform || ""),
    });
    const draft = createManual({
      title: result.title,
      desc: result.desc,
      topics: result.topics,
      platform: result.platform,
      body_md: result.body_md,
      body_html: result.body_html,
      source_note: "洗稿",
    });
    return ok(draft);
  });
  router.post("/api/copy/check", (ctx) =>
    ok(checkCopy(String(ctx.body.title || ""), String(ctx.body.desc || ""), String(ctx.body.platform || "")))
  );

  // ---------------------------------------------------------------- 草稿
  router.get("/api/drafts", (ctx) => {
    const status = ctx.query.get("status") || "";
    const platform = ctx.query.get("platform") || "";
    const limit = Math.max(1, Math.min(500, Number(ctx.query.get("limit") || 200)));
    const offset = Math.max(0, Number(ctx.query.get("offset") || 0));
    const items = listDrafts(status, limit, offset, platform);
    return ok(items, { total: countDrafts(status, platform), limit, offset });
  });
  router.post("/api/drafts/manual", (ctx) => {
    const payload = ctx.body;
    const draft = createManual({
      title: String(payload.title || ""),
      desc: String(payload.desc || ""),
      topics: payload.topics,
      images: Array.isArray(payload.images) ? payload.images.map(String) : [],
      visibility: Number(payload.visibility || 0),
      media_type: String(payload.media_type || "image"),
      account_id: payload.account_id ? Number(payload.account_id) : null,
      topic_id: payload.topic_id ? Number(payload.topic_id) : null,
      platform: String(payload.platform || ""),
      content_type: String(payload.content_type || ""),
      body_md: String(payload.body_md || ""),
      body_html: String(payload.body_html || ""),
      wx_theme: String(payload.wx_theme || ""),
    });
    if (payload.topic_id) {
      execute("UPDATE topics SET status='used', updated_at=? WHERE id=?", now(), Number(payload.topic_id));
    }
    let accountIds = payload.account_ids || [];
    if (typeof accountIds === "string") accountIds = accountIds.split(",").filter((item) => item.trim());
    if (payload.enqueue) {
      const ids = (Array.isArray(accountIds) ? accountIds : []).map((item) => Number(item));
      if (ids.length) enqueueTargets(Number(draft.id), ids, payload.scheduled_at || 0);
      else enqueue(Number(draft.id), null, payload.scheduled_at || 0);
    }
    return ok(getDraft(Number(draft.id)));
  });
  router.post("/api/drafts/batch-delete", (ctx) => {
    let ids = ctx.body.draft_ids ?? ctx.body.ids ?? [];
    if (typeof ids === "string") ids = ids.split(",").filter((item) => item.trim());
    return ok(deleteDrafts((Array.isArray(ids) ? ids : []).map((item) => Number(item))));
  });
  router.post("/api/drafts", (ctx) => {
    let topicIds = ctx.body.topic_ids ?? [];
    if (typeof topicIds === "string") topicIds = topicIds.split(",").filter((item) => item.trim());
    const ids = (Array.isArray(topicIds) ? topicIds : []).map((item) => Number(item));
    if (!ids.length) throw new HttpError(400, "请选择至少一个选题");
    const variantCount = Math.max(1, Math.min(3, Number(ctx.body.variants || 1)));
    const tone = String(ctx.body.tone || "");
    const platform = String(ctx.body.platform || "");
    const accountId = ctx.body.account_id ? Number(ctx.body.account_id) : null;
    const product = ctx.body.product === undefined || ctx.body.product === null ? null : Boolean(ctx.body.product);
    const task = submit(
      "drafts",
      `drafts:${ids.join(",")}:${platform}`,
      () => {
        const drafts: Record<string, unknown>[] = [];
        for (const topicId of ids) {
          const topic = getTopic(topicId);
          for (let index = 0; index < variantCount; index += 1) {
            const copy = generateCopy(topic, {
              tone,
              product,
              platform: platform || String(topic.platform || ""),
            });
            const draft = createManual({
              title: copy.title,
              desc: copy.desc,
              topics: copy.topics,
              images: [],
              account_id: accountId,
              topic_id: topicId,
              platform: copy.platform,
              body_md: copy.body_md,
              body_html: copy.body_html,
              source_note: "AI 生成（本地模板）",
            });
            execute("UPDATE topics SET status='used', updated_at=? WHERE id=?", now(), topicId);
            drafts.push(draft);
          }
        }
        return drafts;
      },
      900
    );
    return { ...ok(task), status_code: 202 };
  });
  router.get("/api/tasks/:id", (ctx) => ok(getTask(ctx.params.id)));
  router.post("/api/drafts/:id/convert", (ctx) => {
    const id = intParam(ctx.params.id, "草稿 ID");
    const draft = getDraft(id);
    const target = normalizePlatform(ctx.body.target_platform || draft.platform);
    const copy = rewriteCopy(String(draft.title || ""), String(draft.desc || ""), {
      tone: String(ctx.body.tone || ""),
      platform: target,
    });
    return ok(
      updateDraft(id, {
        title: copy.title,
        desc: copy.desc,
        body_md: copy.body_md,
        body_html: copy.body_html,
        platform: target,
        content_type: target === "wechat_mp" ? "long_article" : "image_text",
      })
    );
  });
  router.post("/api/drafts/:id/switch-platform", (ctx) =>
    ok(switchPlatform(intParam(ctx.params.id, "草稿 ID"), String(ctx.body.platform || ""), String(ctx.body.content_type || "")))
  );
  router.post("/api/drafts/:id/rewrite", (ctx) => {
    const id = intParam(ctx.params.id, "草稿 ID");
    const draft = getDraft(id);
    const copy = rewriteCopy(String(draft.title || ""), String(draft.desc || ""), {
      angle: String(ctx.body.angle || ""),
      tone: String(ctx.body.tone || ""),
      platform: String(ctx.body.platform || draft.platform || ""),
    });
    return ok(
      updateDraft(id, {
        title: copy.title,
        desc: copy.desc,
        topics: copy.topics,
        body_md: copy.body_md,
        body_html: copy.body_html,
      })
    );
  });
  router.get("/api/drafts/:id", (ctx) => ok(getDraft(intParam(ctx.params.id, "草稿 ID"))));
  router.patch("/api/drafts/:id", (ctx) =>
    ok(updateDraft(intParam(ctx.params.id, "草稿 ID"), ctx.body))
  );
  router.delete("/api/drafts/:id", (ctx) => {
    deleteDraft(intParam(ctx.params.id, "草稿 ID"));
    return ok({ deleted: true });
  });
  const renderOptions = (body: Record<string, unknown>): Record<string, string> => {
    const options: Record<string, string> = {};
    for (const key of ["style", "layout", "palette", "platform", "brand", "column", "issue", "themeColor"]) {
      if (body[key]) options[key] = String(body[key]);
    }
    return options;
  };
  router.post("/api/drafts/:id/cards", async (ctx) => {
    const id = intParam(ctx.params.id, "草稿 ID");
    draftOr404(id);
    return ok(await renderDraftCards(id, renderOptions(ctx.body) as never));
  });
  router.post("/api/drafts/:id/paid-cards", () => {
    throw new HttpError(400, "付费配图需要云端配图 Key，本机尚未开通；可先用免费模板出图");
  });
  router.post("/api/drafts/:id/design-cards", async (ctx) => {
    const id = intParam(ctx.params.id, "草稿 ID");
    draftOr404(id);
    const style = String(ctx.body.style || "");
    return ok(await renderDesignCards(id, style, renderOptions(ctx.body) as never));
  });
  router.post("/api/drafts/:id/motion", async (ctx) => {
    const id = intParam(ctx.params.id, "草稿 ID");
    draftOr404(id);
    return ok(await renderMotion(id));
  });
  router.post("/api/drafts/:id/artwork-inline", async (ctx) => {
    const id = intParam(ctx.params.id, "草稿 ID");
    draftOr404(id);
    return ok(await renderArtworkInline(id, renderOptions(ctx.body) as never));
  });

  // ---------------------------------------------------------------- 富文本 / 设计
  router.post("/api/richtext/render", (ctx) =>
    ok(
      renderRich(
        String(ctx.body.text || ""),
        String(ctx.body.format || "markdown"),
        Array.isArray(ctx.body.images) ? ctx.body.images.map(String) : []
      )
    )
  );
  router.get("/api/richtext/themes", () => ok(listThemes()));
  router.post("/api/richtext/style", (ctx) =>
    ok({ html: applyTheme(String(ctx.body.html || ""), String(ctx.body.theme || "huasheng")) })
  );
  router.get("/api/design/styles", () =>
    ok([
      ...CARD_STYLES.map((item) => ({
        key: item.key,
        name: item.name,
        group: item.group,
        desc: item.desc,
        colors: item.colors,
      })),
      ...ART_STYLES.map((item) => ({ key: item.key, name: item.name, group: item.group, desc: "程序化插画" })),
    ])
  );
  router.post("/api/design/plan", (ctx) => {
    const platform = normalizePlatform(ctx.body.platform || "");
    const desc = String(ctx.body.desc || "");
    const art = isArtStyle(ctx.body.style) || String(ctx.body.style || "").startsWith("art");
    return ok({
      platform,
      content_type: String(ctx.body.content_type || ""),
      content_type_label: platformLabel(platform),
      pages: art ? 1 : Math.max(1, Math.min(18, Math.ceil(desc.length / 180))),
      max_images: platform === "wechat_mp" ? 1 : 18,
      art,
      canvas: { width: 1080, height: platform === "wechat_mp" ? 460 : 1440 },
    });
  });
  router.post("/api/design/cover", async (ctx) => {
    const id = Number(ctx.body.draft_id || ctx.body.id || 0);
    if (!id) throw new HttpError(400, "请先保存草稿再生成封面");
    draftOr404(id);
    const options: Record<string, unknown> = {
      ...renderOptions(ctx.body),
      title: ctx.body.title ? String(ctx.body.title) : undefined,
      subtitle: ctx.body.subtitle ? String(ctx.body.subtitle) : undefined,
    };
    return ok(await renderCover(id, options as never));
  });
  router.get("/api/cards/styles", () =>
    ok(CARD_STYLES.map((item) => ({ key: item.key, name: item.name, group: item.group })))
  );
  router.get("/api/cards/options", () =>
    ok({
      styles: CARD_STYLES.map((item) => ({ key: item.key, name: item.name, group: item.group })),
      layouts: CARD_LAYOUTS.map((item) => ({ key: item.key, name: item.name, hint: item.hint })),
      palettes: CARD_PALETTES,
      presets: [],
      backend: {
        configured: true,
        reason: "",
        engine: "Electron 本地渲染",
        artwork_styles: ART_STYLES,
      },
      paid: { configured: false, reason: "付费配图需要云端配图 Key，本机尚未开通" },
    })
  );

  // ---------------------------------------------------------------- 上传
  router.post("/api/uploads", async (ctx) => ok(await handleUpload(ctx.req)));

  // ---------------------------------------------------------------- 队列
  router.get("/api/jobs", (ctx) => {
    const status = ctx.query.get("status") || "";
    const reason = ctx.query.get("reason") || "";
    const limit = Math.max(1, Math.min(500, Number(ctx.query.get("limit") || 100)));
    const offset = Math.max(0, Number(ctx.query.get("offset") || 0));
    const items = listJobs(limit, offset, status, reason);
    return ok(items, { total: countJobs(status, reason), limit, offset });
  });
  router.get("/api/jobs/export", (ctx) => {
    const rows = [["ID", "草稿", "平台", "账号", "状态", "尝试", "下次执行", "错误"]];
    for (const job of listJobs(500, 0, ctx.query.get("status") || "")) {
      rows.push([
        String(job.id),
        String(job.draft_title || ""),
        String(job.platform_name || ""),
        String(job.account_name || ""),
        String(job.status || ""),
        String(job.attempts || 0),
        dateText(job.next_run_at),
        String(job.last_error || ""),
      ]);
    }
    csvResponse(ctx.res, "发布队列.csv", rows);
    return undefined;
  });
  router.get("/api/queue/reasons", () => ok(queueReasons()));
  router.post("/api/jobs", (ctx) => {
    let rawDrafts = ctx.body.draft_ids;
    if (rawDrafts === undefined && ctx.body.draft_id) rawDrafts = [ctx.body.draft_id];
    if (typeof rawDrafts === "string") rawDrafts = rawDrafts.split(",").filter((item) => item.trim());
    const draftIds = (Array.isArray(rawDrafts) ? rawDrafts : []).map((item) => Number(item)).filter(Boolean);
    if (!draftIds.length) throw new HttpError(400, "请指定草稿");
    draftIds.forEach((id) => draftOr404(id));
    let rawAccounts = ctx.body.account_ids ?? [];
    if (typeof rawAccounts === "string") rawAccounts = rawAccounts.split(",").filter((item) => item.trim());
    const accountIds = (Array.isArray(rawAccounts) ? rawAccounts : []).map((item) => Number(item)).filter(Boolean);
    const accountId = ctx.body.account_id ? Number(ctx.body.account_id) : null;
    const jobs = enqueueMany(draftIds, accountId, accountIds, ctx.body.scheduled_at || 0);
    return ok(jobs, { total: jobs.length });
  });
  router.post("/api/jobs/:id/cancel", (ctx) => ok(cancelJob(intParam(ctx.params.id, "任务 ID"))));
  router.post("/api/jobs/:id/retry", (ctx) => ok(retryJob(intParam(ctx.params.id, "任务 ID"))));
  router.post("/api/jobs/:id/confirm", (ctx) =>
    ok(confirmJob(intParam(ctx.params.id, "任务 ID"), Boolean(ctx.body.published ?? ctx.body.ok)))
  );
  router.get("/api/records", (ctx) => {
    const limit = Math.max(1, Math.min(500, Number(ctx.query.get("limit") || 100)));
    const offset = Math.max(0, Number(ctx.query.get("offset") || 0));
    const items = listRecords(limit, offset);
    const summary = countRecordsSummary();
    return ok(items, {
      total: summary.total,
      success_total: summary.success_total,
      failed_total: summary.failed_total,
      limit,
      offset,
    });
  });
  router.get("/api/records/export", (ctx) => {
    const rows = [["ID", "时间", "草稿", "平台", "账号", "结果", "说明", "远端 ID"]];
    for (const record of listRecords(500, 0)) {
      rows.push([
        String(record.id),
        dateText(record.created_at),
        String(record.draft_title || ""),
        String(record.platform_name || ""),
        String(record.account_name || ""),
        record.success ? "成功" : "失败",
        String(record.message || ""),
        String(record.remote_note_id || ""),
      ]);
    }
    csvResponse(ctx.res, "发布记录.csv", rows);
    return undefined;
  });

  // ---------------------------------------------------------------- 定时任务
  router.get("/api/schedules", (ctx) => {
    const limit = Math.max(1, Math.min(500, Number(ctx.query.get("limit") || 200)));
    const offset = Math.max(0, Number(ctx.query.get("offset") || 0));
    const items = listSchedules(limit, offset);
    return ok(items, { total: countSchedules(), limit, offset });
  });
  router.post("/api/schedules/quick", (ctx) => ok(quickCreateSchedule(ctx.body)));
  router.post("/api/schedules", (ctx) => ok(createSchedule(ctx.body)));
  router.patch("/api/schedules/:id", (ctx) =>
    ok(updateSchedule(intParam(ctx.params.id, "定时任务 ID"), ctx.body))
  );
  router.delete("/api/schedules/:id", (ctx) => {
    deleteSchedule(intParam(ctx.params.id, "定时任务 ID"));
    return ok({ deleted: true });
  });
  router.post("/api/schedules/:id/run", async (ctx) =>
    ok(await runSchedule(intParam(ctx.params.id, "定时任务 ID"), "manual"))
  );
  router.get("/api/schedule-runs", (ctx) => {
    const scheduleId = ctx.query.get("schedule_id") ? Number(ctx.query.get("schedule_id")) : null;
    const limit = Math.max(1, Math.min(500, Number(ctx.query.get("limit") || 50)));
    const offset = Math.max(0, Number(ctx.query.get("offset") || 0));
    return ok(listRuns(scheduleId, limit, offset), {
      total: countRuns(scheduleId),
      limit,
      offset,
    });
  });
  router.post("/api/schedule-runs/:id/rerun", async (ctx) =>
    ok(await rerunStage(intParam(ctx.params.id, "运行记录 ID"), String(ctx.body.stage || "")))
  );
  router.post("/api/schedule-runs/:id/confirm", async (ctx) =>
    ok(await confirmRun(intParam(ctx.params.id, "运行记录 ID")))
  );

  // ---------------------------------------------------------------- 已发布
  router.get("/api/published", (ctx) => {
    const platform = ctx.query.get("platform") || "";
    const accountId = Number(ctx.query.get("account_id") || 0);
    if (!platform && !accountId) {
      // 兼容旧版调用：只给 account_id 时返回缓存的简要列表。
      const legacyPlatform = ctx.query.get("legacy_platform") || "";
      void legacyPlatform;
    }
    const sinceDays = Number(ctx.query.get("since_days") || 0);
    const query = {
      account_id: accountId || undefined,
      platform,
      since: sinceDays > 0 ? now() - sinceDays * 86400 : Number(ctx.query.get("since") || 0),
      until: Number(ctx.query.get("until") || 0),
      keyword: ctx.query.get("keyword") || "",
      health: ctx.query.get("health") || "",
      limit: Number(ctx.query.get("limit") || 20),
      offset: Number(ctx.query.get("offset") || 0),
      include_local: ctx.query.get("include_local") !== "0",
    };
    const result = listNotes(query);
    return ok(result.items, {
      total: result.total,
      limit: result.limit,
      offset: result.offset,
      filters: result.filters,
      meta: result.meta,
    });
  });
  router.get("/api/published/accounts", (ctx) => ok(accountsStatus(ctx.query.get("platform") || "")));
  router.get("/api/published/sources", () => ok(sourcesMeta()));
  router.post("/api/published/sync", async (ctx) => {
    let rawIds = ctx.body.account_ids;
    if (rawIds === undefined && ctx.body.account_id) rawIds = [ctx.body.account_id];
    if (typeof rawIds === "string") rawIds = rawIds.split(",").filter((item) => item.trim());
    let ids = (Array.isArray(rawIds) ? rawIds : []).map((item) => Number(item)).filter(Boolean);
    if (!ids.length) {
      ids = queryAll<{ id: number }>(
        "SELECT id FROM accounts WHERE enabled=1 AND platform IN ('wechat_mp','xiaohongshu') ORDER BY id"
      ).map((row) => Number(row.id));
    }
    if (!ids.length) throw new HttpError(400, "没有可回读的账号");
    ids.forEach((id) => accountOr404(id));
    const pages = Math.max(1, Math.min(20, Number(ctx.body.pages || 2)));
    const results: Record<string, unknown>[] = [];
    let total = 0;
    let okCount = 0;
    for (const id of ids) {
      const row = accountOr404(id);
      let cursor: unknown = 0;
      let synced = 0;
      let error = "";
      for (let page = 0; page < pages; page += 1) {
        if (row.platform === "xiaohongshu") {
          const result = await xhsFetchPublished(row, cursor, 30);
          if (!result.ok) {
            error = result.message;
            markSyncError(id, error);
            break;
          }
          synced += savePublished(id, "xiaohongshu", result.items as never);
          if (result.next_cursor === null) break;
          cursor = result.next_cursor;
          continue;
        }
        const result = await fetchPublished(decryptSession(row), {
          cursor: Number(cursor || 0),
          limit: 30,
          proxy: row.proxy || "",
        });
        if (!result.ok) {
          error = result.message;
          markSyncError(id, error);
          break;
        }
        synced += savePublished(id, "wechat_mp", result.items);
        if (result.state) saveSession(id, result.state);
        if (!result.next_cursor) break;
        cursor = result.next_cursor;
      }
      total += synced;
      if (!error) okCount += 1;
      results.push({
        account_id: id,
        platform: row.platform,
        ok: !error,
        synced,
        message: error || `已同步 ${synced} 篇`,
      });
    }
    return ok({
      account_ids: ids,
      synced: total,
      ok_count: okCount,
      results,
      message: `已同步 ${ids.length} 个账号，新增 ${total} 篇`,
    });
  });
  router.post("/api/published/sync-all", (ctx) => ok({ synced: 0, message: "请使用「同步数据」按钮，Node 版会同步全部公众号账号" }));
  router.post("/api/published/health-check", (ctx) => {
    const accountId = Number(ctx.body.account_id || 0);
    const rows = queryAll<{ n: number }>(
      accountId
        ? "SELECT COUNT(*) AS n FROM published_notes WHERE account_id=?"
        : "SELECT COUNT(*) AS n FROM published_notes",
      ...(accountId ? [accountId] : [])
    );
    return ok({
      checked: Number(rows[0]?.n || 0),
      message: "已完成列表巡检；平台侧删除/隐藏检测尚未迁移到 Node 版",
    });
  });
  router.get("/api/published/:id/metrics", (ctx) =>
    ok(metrics(intParam(ctx.params.id, "作品 ID"), Number(ctx.query.get("days") || 30)))
  );
  router.get("/api/published/:id/comments", (ctx) =>
    ok(
      listComments(
        intParam(ctx.params.id, "作品 ID"),
        Number(ctx.query.get("limit") || 20),
        Number(ctx.query.get("offset") || 0)
      )
    )
  );
  router.post("/api/published/:id/comments/sync", async (ctx) => {
    const noteId = intParam(ctx.params.id, "作品 ID");
    const note = queryOne<Record<string, unknown>>(
      "SELECT * FROM published_notes WHERE id=?",
      noteId
    );
    if (!note) throw new HttpError(404, `作品不存在: ${noteId}`);
    if (note.platform !== "xiaohongshu") {
      return ok({
        ok: false,
        synced: 0,
        message: "公众号只能读取精选留言，Node 版暂未接入，请先用原版同步",
      });
    }
    const account = accountOr404(Number(note.account_id || 0));
    const pages = Math.max(1, Math.min(10, Number(ctx.body.pages || 3)));
    const result = await xhsFetchComments(account, note, pages);
    const synced = result.ok ? saveComments(noteId, result.items as never) : 0;
    return ok({
      ok: result.ok,
      synced,
      total: (result.items || []).length,
      message: result.message || (result.ok ? `已同步 ${synced} 条评论` : "评论同步失败"),
    });
  });

  // ---------------------------------------------------------------- 通知 / 备份 / 云
  router.get("/api/notifications", (ctx) => {
    const result = listNotifications(
      Number(ctx.query.get("limit") || 20),
      Number(ctx.query.get("offset") || 0),
      ctx.query.get("unread") === "1"
    );
    return ok(result.items, { total: result.total, unread: result.unread });
  });
  router.post("/api/notifications/read", (ctx) => {
    const ids = ctx.body.ids;
    if (ids === undefined || ids === null) return ok(markNotificationsRead(null));
    const list = (Array.isArray(ids) ? ids : [ids]).map((item) => Number(item));
    return ok(markNotificationsRead(list));
  });
  router.get("/api/notifications/channels", () => ok(listChannels()));
  router.post("/api/notifications/channels", (ctx) => ok(addChannel(ctx.body)));
  router.patch("/api/notifications/channels/:id", (ctx) =>
    ok(updateChannel(intParam(ctx.params.id, "通知渠道 ID"), ctx.body))
  );
  router.delete("/api/notifications/channels/:id", (ctx) => {
    deleteChannel(intParam(ctx.params.id, "通知渠道 ID"));
    return ok({ deleted: true });
  });
  router.post("/api/notifications/channels/:id/test", async (ctx) =>
    ok(await testChannel(intParam(ctx.params.id, "通知渠道 ID")))
  );
  router.get("/api/backups", () => ok(listBackups()));
  router.post("/api/backups", async (ctx) =>
    ok(
      await createBackup({
        include_images: Boolean(ctx.body.include_images),
        include_key: Boolean(ctx.body.include_key),
        prefix: String(ctx.body.prefix || "backup"),
      })
    )
  );
  router.get("/api/backups/download", (ctx) => {
    const name = String(ctx.query.get("name") || "");
    const target = backupPath(name);
    ctx.res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(name)}"`,
      "Cache-Control": "no-store",
    });
    fs.createReadStream(target).pipe(ctx.res);
    return undefined;
  });
  router.post("/api/backups/restore", async (ctx) =>
    ok(await restoreBackup(String(ctx.body.name || "")))
  );
  router.delete("/api/backups/:name", (ctx) => ok(deleteBackup(ctx.params.name)));
  router.get("/api/cloud/status", () => ok(cloud.status()));
  router.get("/api/cloud/doctor", async (ctx) =>
    ok(await cloud.doctor(String(ctx.query.get("model") || "")))
  );
  router.get("/api/update", async () =>
    ok(await cloud.updateInfo(String(process.env.OPS_APP_VERSION || "0.1.0")))
  );
  router.post("/api/cloud/sms/send", async (ctx) =>
    ok(await cloud.sendSms(String(ctx.body.phone || "")))
  );
  router.post("/api/cloud/login", async (ctx) => ok(await cloud.login(ctx.body)));
  router.post("/api/cloud/logout", async () => ok(await cloud.logout()));
  router.post("/api/cloud/refresh", async () => ok(await cloud.refresh()));
  router.post("/api/cloud/keys/reset", async (ctx) =>
    ok(await cloud.resetKey(String(ctx.body.kind || "llm")))
  );

  // ---------------------------------------------------------------- 队列运行时
  router.get("/api/worker", () => ok(workerStatus()));
  router.post("/api/worker/tick", async (ctx) => {
    const action = String(ctx.body.action || "tick");
    if (action === "start") {
      startLoop();
      return ok(workerStatus());
    }
    if (action === "stop") {
      stopLoop();
      return ok(workerStatus());
    }
    if (action === "schedule") return ok(await tickSchedules(2));
    return ok(await workerTick());
  });

  return router;
}
