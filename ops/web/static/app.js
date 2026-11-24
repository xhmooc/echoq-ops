/* 应声运营 · 小红书内容工作台（原生 JS，无构建链） */

/* 原帖摘录里常常全是「#话题[话题]#」，直接铺出来又长又像机器吐的；
   这种情况只保留话题名，不然就截断成一行摘录。 */
function topicAngleText(topic) {
  const raw = String(topic.angle || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  if (raw.startsWith("#") || (raw.match(/#/g) || []).length >= 3) {
    const tags = Array.from(raw.matchAll(/#([^#\s[\]@]+)/g))
      .map((match) => match[1].trim())
      .filter(Boolean);
    const unique = Array.from(new Set(tags)).slice(0, 4);
    return unique.length ? `原帖话题：${unique.join(" · ")}` : "";
  }
  return raw.length > 80 ? `${raw.slice(0, 80)}…` : raw;
}

/* 公众号默认排版主题；正文只存内容，主题在预览和发布时套用。 */
const DEFAULT_WX_THEME = "wechat-default";

const state = {
  view: "studio",
  platforms: [],
  accounts: [],
  topics: [],
  drafts: [],
  jobs: [],
  records: [],
  schedules: [],
  scheduleOpen: new Set(),
  scheduleRunCache: {},
  settings: null,
  cloud: null,
  cardStyles: [],
  cardStyle: "",
  designStyles: [],
  cardOptions: { styles: [], layouts: [], palettes: [], backend: {} },
  styleError: "",
  paidError: "",
  selectedTopics: new Set(),
  selectedDrafts: new Set(),
  draftAllMatched: false,
  setupView: "accounts",
  topicPage: 1,
  topicTotal: 0,
  topicStatus: "pool",
  draftPage: 1,
  draftTotal: 0,
  jobPage: 1,
  jobTotal: 0,
  schedulePage: 1,
  scheduleTotal: 0,
  accountTotal: 0,
  recordPage: 1,
  recordTotal: 0,
  libraryMode: "drafts",
  published: [],
  publishedPage: 1,
  publishedTotal: 0,
  publishedHealth: "",
  publishedAccountId: "",
  publishedLoading: false,
  noteComments: {},
  jobReason: "",
  accountGroups: [],
  accountGroupFilter: "",
  accountBatch: false,
  accountPicked: new Set(),
  accountDrawerId: null,
  notifications: [],
  notificationsUnread: 0,
  attentionTarget: "",
  topicDedupes: [],
  showDedupes: false,
  dedupeExpanded: false,
  mediaTab: "free",
  draftFilter: "",
  draftPlatformFilter: "",
  loading: { library: false, records: false, topics: false, accounts: false },
  studio: {
    draftId: null,
    draftStatus: "draft",
    topicId: null,
    platform: "xiaohongshu",
    contentType: "image_text",
    images: [],
    contentJson: {},
    visibility: 0,
    issues: [],
    engine: "",
    bodyMd: "",
    bodyHtml: "",
    wxTheme: "wechat-default",
    mdMode: false,
    accountId: "",
    accountIds: new Set(),
    dirty: false,
    generating: false,
    imageIndex: 0,
    videoMeta: null,
    mediaMismatch: null,
  },
  qr: { timer: null, ticker: null, session: null, payload: null },
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const SOURCE_LABEL = {
  keyword: "关键词",
  competitor: "竞品",
  channel: "频道",
  trending: "热榜",
  library: "题库",
  manual: "手动",
};
const JOB_STATUS = {
  pending: ["等待", "warn"],
  retry: ["重试中", "warn"],
  running: ["执行中", "accent"],
  pending_confirm: ["待确认", "warn"],
  success: ["成功", "ok"],
  failed: ["失败", "bad"],
  cancelled: ["已取消", ""],
};
const HEALTH_TEXT = {
  unknown: ["未判断", ""],
  normal: ["正常", "ok"],
  zero_views: ["零浏览", "bad"],
  risky: ["数据异常", "warn"],
  removed: ["疑似下架", "bad"],
};
const DRAFT_STATUS = {
  draft: ["待发布", "warn"],
  queued: ["已入队", "accent"],
  published: ["已发布", "ok"],
  failed: ["失败", "bad"],
};
const TONE_OPTIONS = {
  story: "经验分享",
  informative: "干货科普",
  emotional: "情感共鸣",
  warn: "避坑指南",
  professional: "专业测评",
  casual: "日常随意",
  recommend: "好物种草",
  cute: "可爱软萌",
  enthusiastic: "激情感召",
};
const SETTING_FIELDS = [
  ["publish_daily_limit", "每个账号每天最多发（篇）", "number", "到量后当天不再发"],
  ["publish_min_interval_sec", "两次发布至少隔（分钟）", "number", "别把两条排得太近", 60],
  ["publish_jitter_sec", "间隔上再加随机（分钟）", "number", "看起来更像真人，默认 5 分钟", 60],
  ["job_max_attempts", "失败后最多试（次）", "number", "包含第一次"],
  ["worker_poll_sec", "后台多久看一次队列（秒）", "number", "越小越及时，也越占资源"],
  ["health_check_hours", "多久检查一次登录（小时）", "number", "过期能提前发现"],
  ["focus_keywords", "关注的赛道词", "text", "用逗号分开，例如：面试, 秋招"],
  ["product_name", "产品名称", "text", "文案里最多陈述一句事实"],
  ["product_pitch", "一句话介绍产品", "textarea", "别写诱导或交换条件"],
  ["card_style", "默认配图模板", "style", "选好后回创作页点「生成配图」"],
  ["card_layout", "默认版式", "layout", "稀疏、均衡、密集、清单等"],
  ["card_palette", "默认配色", "palette", "留空就跟着模板走"],
  ["draft_style", "默认文案语气", "tone", "生成草稿时默认用它"],
];

/* ------------------------------------------------------------------ 主题 */

const THEMES = [
  { key: "red", label: "品牌红", color: "#ff2442" },
  { key: "green", label: "松石绿", color: "#0c9a66" },
  { key: "blue", label: "科技蓝", color: "#2458e6" },
  { key: "purple", label: "暮光紫", color: "#7c3aed" },
  { key: "neutral", label: "中性灰", color: "#2f3437" },
];

/* 只切强调色令牌；版式与平台品牌色（--brand）都不动。 */
function applyTheme(name, { persist = false } = {}) {
  const key = THEMES.some((item) => item.key === name) ? name : "red";
  document.documentElement.dataset.theme = key;
  if (persist) {
    try {
      localStorage.setItem("echoq-theme", key);
    } catch (error) {
      /* 隐私模式下写不了就算了 */
    }
  }
  renderThemeControl();
  return key;
}

/* 顶部常驻的主色控件：按钮只显示当前色点，菜单里才是整套色板。 */
function renderThemeControl() {
  const current = document.documentElement.dataset.theme || "red";
  const theme = THEMES.find((item) => item.key === current) || THEMES[0];
  const dot = $("#theme-dot");
  if (dot) dot.style.setProperty("--dot", theme.color);
  const list = $("#theme-menu-list");
  if (!list) return;
  list.innerHTML = THEMES.map(
    (item) => `<button type="button" class="theme-option${item.key === current ? " active" : ""}"
      data-theme-pick="${item.key}" aria-pressed="${item.key === current}">
      <span class="theme-dot" style="--dot:${item.color}"></span>
      <span class="theme-option-label">${item.label}</span>
      ${item.key === current ? '<span class="theme-check">✓</span>' : ""}
    </button>`
  ).join("");
}

function setThemeMenu(open) {
  const menu = $("#theme-menu");
  const button = $("#btn-theme");
  if (!menu || !button) return;
  menu.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
  if (open) renderThemeControl();
}

/* 选完即时生效并落库；存不上也不回滚，只提示，避免界面闪一下又变回去。 */
async function pickTheme(key) {
  applyTheme(key, { persist: true });
  setThemeMenu(false);
  try {
    state.settings = await api("/api/settings", { method: "PATCH", body: { theme_color: key } });
  } catch (error) {
    toast(`主题已切换，但保存失败：${error.message}`, true);
  }
}

try {
  applyTheme(localStorage.getItem("echoq-theme") || "red");
} catch (error) {
  applyTheme("red");
}

/* ------------------------------------------------------------------ 平台 */

const PLATFORM_FALLBACK = {
  key: "xiaohongshu",
  name: "小红书",
  short: "小红书",
  ready: true,
  status_text: "已接入",
  content_types: [
    { key: "image_text", label: "图文笔记", media_type: "image", title_max: 20, desc_max: 1000, min_images: 1, max_images: 18, requires_media: true },
  ],
};

function platformInfo(key) {
  const target = key || "xiaohongshu";
  return state.platforms.find((item) => item.key === target) || (target === "xiaohongshu" ? PLATFORM_FALLBACK : null);
}

function platformName(key) {
  const info = platformInfo(key);
  return info ? info.name : String(key || "");
}

function platformBadge(key) {
  const info = platformInfo(key);
  if (!info) return "";
  const kind = info.ready ? "ready" : "planned";
  return `<span class="platform-badge ${kind}" style="--brand:${esc(info.color || "#8a8f98")}" title="${esc(
    info.status_text || ""
  )}">${esc(info.short || info.name)}</span>`;
}

const PLAT_TAGS = {
  xiaohongshu: { cls: "xhs", text: "红" },
  douyin: { cls: "dy", text: "抖" },
  wechat_mp: { cls: "wx", text: "公" },
};

function platTag(key) {
  const tag = PLAT_TAGS[key];
  if (!tag) {
    return `<span class="plat" title="${esc(platformName(key))}">${esc(
      String(platformName(key) || "?").slice(0, 1)
    )}</span>`;
  }
  return `<span class="plat ${tag.cls}" title="${esc(platformName(key))}">${tag.text}</span>`;
}

function platWrap(platforms) {
  const keys = Array.from(new Set((platforms || []).filter(Boolean)));
  if (!keys.length) return "";
  return `<span class="plat-wrap">${keys.map((key) => platTag(key)).join("")}</span>`;
}

function dayStamp(ts) {
  const date = new Date((Number(ts) || 0) * 1000);
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diff = Math.round((start - target) / 86400000);
  if (diff === 0) return "今天";
  if (diff === 1) return "昨天";
  return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`;
}

function clockStamp(ts) {
  const date = new Date((Number(ts) || 0) * 1000);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function platformOptions(selected, { includeAll = false } = {}) {
  const current = selected || "xiaohongshu";
  const rows = [];
  if (includeAll) rows.push(`<option value="">全部平台</option>`);
  state.platforms.forEach((item) => {
    rows.push(
      `<option value="${esc(item.key)}" ${item.key === current ? "selected" : ""}>${esc(item.name)}${
        item.ready ? "" : "（接入位）"
      }</option>`
    );
  });
  if (!state.platforms.length) {
    rows.push(`<option value="xiaohongshu">小红书</option>`);
  }
  return rows.join("");
}

function studioPlatformInfo() {
  return platformInfo(state.studio.platform) || PLATFORM_FALLBACK;
}

function contentTypesFor(key) {
  const info = platformInfo(key);
  return (info && info.content_types) || [];
}

/* 平台默认内容类型：抖音是视频，公众号是长文，小红书是图文。 */
function defaultContentType(key) {
  const info = platformInfo(key);
  if (!info) return "image_text";
  return info.default_content_type || (info.content_types && info.content_types[0] && info.content_types[0].key) || "";
}

function specOf(platformKey, contentKey) {
  const types = contentTypesFor(platformKey);
  return (
    types.find((item) => item.key === contentKey) ||
    types.find((item) => item.key === defaultContentType(platformKey)) ||
    types[0] ||
    PLATFORM_FALLBACK.content_types[0]
  );
}

function studioSpec() {
  const info = studioPlatformInfo();
  return specOf(info.key, state.studio.contentType);
}

function isWechatPlatform(key = state.studio.platform) {
  return key === "wechat_mp";
}

/* 公众号的群发/草稿在界面里叫「立即发布 / 先存草稿」，不再用群发这个词。 */
function platformActionMode(key = state.studio.platform) {
  return isWechatPlatform(key) ? "wechat" : "queue";
}

/* 三个平台的配图能力：图文 3:4 多张，公众号长文只出 1 张封面，贴图 1-9 张原图。 */
function mediaCapability(info = studioPlatformInfo(), spec = studioSpec()) {
  if (spec.media_type === "video") {
    return { kind: "video", supported: false, aspect: "9:16", size: "视频", min: 1, max: 1, count: 0 };
  }
  if (isWechatPlatform(info.key)) {
    if (spec.key === "image_message") {
      return {
        kind: "image",
        supported: true,
        aspect: "原图比例",
        size: "1-9 张原图",
        min: Number(spec.min_images || 1),
        max: Number(spec.max_images || 9),
        count: 4,
      };
    }
    return {
      kind: "cover",
      supported: true,
      aspect: "2.35:1",
      size: "封面 900×383",
      min: 1,
      max: 1,
      count: 1,
    };
  }
  return {
    kind: "image",
    supported: true,
    aspect: "3:4",
    size: "1080×1440",
    min: Number(spec.min_images || 1),
    max: Number(spec.max_images || 9),
    count: 4,
  };
}

function mediaCapabilityText(info = studioPlatformInfo(), spec = studioSpec()) {
  const cap = mediaCapability(info, spec);
  if (cap.kind === "video") return "视频内容不生成图文配图";
  if (cap.kind === "cover") return `${cap.aspect} 封面 · ${cap.max} 张（生成图按居中区域裁切）`;
  if (spec.key === "image_message") return `原图比例 · ${cap.min}-${cap.max} 张 · 预览按顶部竖排`;
  return `${cap.aspect} · ${cap.size} · ${cap.min}-${cap.max} 张`;
}

function accountsForPlatform(platform) {
  const target = platform || "xiaohongshu";
  return state.accounts.filter(
    (account) => account.enabled && (account.platform || "xiaohongshu") === target
  );
}


function esc(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pad(number) {
  return String(number).padStart(2, "0");
}

function fmtTime(ts) {
  if (!ts) return "—";
  const date = new Date(ts * 1000);
  return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function relTime(ts) {
  if (!ts) return "—";
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  return `${Math.floor(diff / 86400)} 天前`;
}

function badge(text, kind = "") {
  return `<span class="badge ${kind}">${esc(text)}</span>`;
}

let toastTimer = null;
function toast(message, isError = false) {
  const node = $("#toast");
  node.textContent = message;
  node.className = "toast show" + (isError ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.className = "toast";
  }, isError ? 4200 : 2600);
}

let lastBackgroundErrorAt = 0;
/* 自动刷新失败不能完全静默：控制台留痕，页面上每分钟最多提示一次。 */
function reportBackgroundError(error) {
  console.warn("[后台刷新失败]", error);
  const now = Date.now();
  if (now - lastBackgroundErrorAt < 60000) return;
  lastBackgroundErrorAt = now;
  toast(`刷新失败：${error && error.message ? error.message : error}`, true);
}

/* 后端错误可能带 RuntimeError/ValueError 前缀，展示前统一去掉。 */
function friendlyError(text) {
  return (
    String(text || "")
      .replace(/^[A-Za-z_][\w.]*(Error|Exception):\s*/, "")
      .replace(/^补跑（[^）]*）：/, "")
      .trim() || "—"
  );
}

/* 失败态：先给可读原因；错误编号与后端 technical detail 折叠在「详情」里。 */
function errorHTML(error, { retryAction = "" } = {}) {
  const raw = friendlyError(error && error.message ? error.message : error);
  const id = (error && error.errorId) || "";
  let title = raw;
  if (id) {
    title = raw
      .replace(/[；;]?\s*如果持续出现[，,]?\s*把错误编号\s*[\w-]+\s*发给维护者[。.]?/g, "")
      .replace(/[（(]?错误编号[:：]?\s*[\w-]+[）)]?/g, "")
      .trim();
  }
  if (!title || title === "—") title = "请求失败，请稍后重试";
  const retry = retryAction
    ? `<button type="button" class="link-btn" data-action="${retryAction}">重试</button>`
    : "";
  const parts = [`<div class="err-main"><span>${esc(title)}</span>${retry}</div>`];
  const detail = error && error.detail ? String(error.detail) : "";
  if (id || detail) {
    const bits = [
      id ? `<span>错误编号 <code>${esc(id)}</code></span>` : "",
      detail ? `<span>${esc(detail)}</span>` : "",
    ].filter(Boolean).join("");
    parts.push(`<details class="err-more"><summary>详情</summary><div>${bits}</div></details>`);
  }
  return parts.join("");
}

function showErrorBox(selector, error) {
  const node = $(selector);
  if (!node) return;
  node.hidden = false;
  /* 服务端失败的提示要留住：编辑器的实时刷新不能把它覆盖掉。 */
  node.dataset.sticky = "1";
  node.innerHTML = errorHTML(error);
}

function clearErrorBox(selector) {
  const node = $(selector);
  if (!node) return;
  delete node.dataset.sticky;
  node.hidden = true;
  node.textContent = "";
}

function showInline(selector, message) {
  const node = $(selector);
  if (!node) return;
  node.textContent = message;
  node.hidden = false;
}

function hideInline(selector) {
  const node = $(selector);
  if (!node) return;
  node.hidden = true;
  node.textContent = "";
}

async function api(path, options = {}) {
  const config = { headers: {}, ...options };
  if (config.body instanceof FormData) {
    // 交给浏览器自己写 multipart 边界。
  } else if (config.body && typeof config.body !== "string") {
    config.body = JSON.stringify(config.body);
    config.headers["Content-Type"] = "application/json";
  }
  let response;
  try {
    response = await fetch(path, config);
  } catch (error) {
    // fetch 本身失败（断网、服务没起来、请求被中断）时给出中文原因，而不是 "Failed to fetch"。
    throw new Error("网络连接失败，请确认服务在运行后重试");
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(`服务返回异常（HTTP ${response.status}）`);
  }
  if (!response.ok || payload.ok === false) {
    const failure = new Error(payload.error || `请求失败（HTTP ${response.status}）`);
    /* 后端约定：error 是可读原因，error_id 是回查编号，detail 是可选的技术细节。 */
    failure.status = response.status;
    failure.errorId = payload.error_id || "";
    failure.detail = payload.detail || "";
    throw failure;
  }
  lastMeta = {
    total: typeof payload.total === "number" ? payload.total : null,
    limit: payload.limit || 0,
    offset: payload.offset || 0,
    successTotal: typeof payload.success_total === "number" ? payload.success_total : null,
    failedTotal: typeof payload.failed_total === "number" ? payload.failed_total : null,
    unread: typeof payload.unread === "number" ? payload.unread : null,
  };
  return payload.data;
}

let lastMeta = {
  total: null,
  limit: 0,
  offset: 0,
  successTotal: null,
  failedTotal: null,
  unread: null,
};

function setButtonLoading(button, loading, text) {
  if (!button) return;
  if (loading) {
    if (!button.dataset.label) button.dataset.label = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<span class="spinner"></span>${esc(text || "处理中…")}`;
  } else {
    button.disabled = false;
    if (button.dataset.label) {
      button.innerHTML = button.dataset.label;
      delete button.dataset.label;
    }
  }
}

function emptyState(title, desc, actionHtml = "") {
  return `<div class="empty-state">
    <div class="empty-title">${esc(title)}</div>
    ${desc ? `<p>${esc(desc)}</p>` : ""}
    ${actionHtml ? `<div class="actions">${actionHtml}</div>` : ""}
  </div>`;
}

/* 真分页：页码 + 上一页/下一页 + 总数 + 跳页，列表不再用「加载更多」。 */
const PAGE_SIZE = { topics: 20, drafts: 6, jobs: 8, records: 20, schedules: 6, published: 9 };

function pagerHtml(kind, page, pageSize, total, { compact = false } = {}) {
  const pages = Math.max(1, Math.ceil((Number(total) || 0) / pageSize));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  /* 只有一页时不摆翻页控件，只留总数，避免出现一排点不动的按钮。 */
  if (pages <= 1) {
    return `<nav class="pager-bar${compact ? " compact" : ""}" data-pager="${kind}" aria-label="分页">
      <span class="pager-total">共 ${Number(total) || 0} 条</span>
    </nav>`;
  }
  const numbers = [];
  if (pages <= 7) {
    for (let index = 1; index <= pages; index += 1) numbers.push(index);
  } else {
    numbers.push(1);
    if (current > 3) numbers.push("gap");
    for (let index = Math.max(2, current - 1); index <= Math.min(pages - 1, current + 1); index += 1) {
      numbers.push(index);
    }
    if (current < pages - 2) numbers.push("gap");
    numbers.push(pages);
  }
  return `<nav class="pager-bar${compact ? " compact" : ""}" data-pager="${kind}" aria-label="分页">
    <span class="pager-total">共 ${Number(total) || 0} 条</span>
    <div class="pager-pages">
      <button type="button" class="pager-btn" data-page="${current - 1}" ${
    current <= 1 ? "disabled" : ""
  } aria-label="上一页">‹</button>
      ${numbers
        .map((item) =>
          item === "gap"
            ? `<span class="pager-gap">…</span>`
            : `<button type="button" class="pager-btn${item === current ? " on" : ""}" data-page="${item}" ${
                item === current ? 'aria-current="page"' : ""
              }>${item}</button>`
        )
        .join("")}
      <button type="button" class="pager-btn" data-page="${current + 1}" ${
    current >= pages ? "disabled" : ""
  } aria-label="下一页">›</button>
    </div>
    <label class="pager-jump">第
      <input type="number" min="1" max="${pages}" value="${current}" data-jump="${kind}" aria-label="跳转到第几页" />
      / ${pages} 页
      <button type="button" class="pager-btn go" data-page="${current}" data-jump-go="${kind}">跳转</button>
    </label>
  </nav>`;
}

function bindPager(selector, onChange) {
  const box = $(selector);
  if (!box) return;
  const go = (page) => {
    const target = Math.max(1, Math.round(Number(page) || 1));
    onChange(target);
  };
  box.addEventListener("click", (event) => {
    const jumpButton = event.target.closest("[data-jump-go]");
    if (jumpButton) {
      const input = box.querySelector("[data-jump]");
      if (input) go(input.value);
      return;
    }
    const button = event.target.closest("button[data-page]");
    if (!button || button.disabled) return;
    go(button.dataset.page);
  });
  box.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const input = event.target.closest("[data-jump]");
    if (!input) return;
    event.preventDefault();
    go(input.value);
  });
}

/* 后台生成任务：POST /api/drafts 立即返回 task.id，这里轮询到结束再刷新页面。 */
async function waitTask(taskId, { timeout = 10 * 60 * 1000, interval = 1500 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const task = await api(`/api/tasks/${encodeURIComponent(taskId)}`);
    if (task.status !== "running") return task;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error("生成时间较长，任务仍在后台运行；稍后到内容库查看结果");
}

async function generateDrafts(body, button, loadingText = "生成中") {
  setButtonLoading(button, true, loadingText);
  try {
    const task = await api("/api/drafts", { method: "POST", body });
    if (task.existed) toast("同样的任务已经在生成，等它完成即可");
    const done = await waitTask(task.id);
    if (done.status === "failed") throw new Error(done.error || done.message || "生成失败");
    const drafts = done.result || [];
    await refreshTopics();
    await refreshLibrary();
    await refreshOverview();
    switchView("library");
    toast(`已生成 ${drafts.length} 篇草稿`);
    return drafts;
  } catch (error) {
    if (!maybePromptLogin(error)) toast(error.message, true);
    return [];
  } finally {
    setButtonLoading(button, false);
  }
}

/* ------------------------------------------------------------------ 弹窗 */

function openModal(title, body, foot = "") {
  $("#modal-title").textContent = title;
  $("#modal-body").innerHTML = body;
  $("#modal-foot").innerHTML = foot;
  $("#modal-mask").classList.remove("hidden");
}

function closeModal() {
  $("#modal-mask").classList.add("hidden");
  $("#modal-body").innerHTML = "";
  $("#modal-foot").innerHTML = "";
  stopQrPolling();
}

function stopQrPolling() {
  if (state.qr.timer) {
    clearInterval(state.qr.timer);
    state.qr.timer = null;
  }
  if (state.qr.ticker) {
    clearInterval(state.qr.ticker);
    state.qr.ticker = null;
  }
  state.qr.session = null;
  state.qr.payload = null;
}

function confirmDialog(message, okText = "确定") {
  return new Promise((resolve) => {
    openModal(
      "请确认",
      `<p class="confirm-text">${esc(message)}</p>`,
      `<button class="btn ghost" id="confirm-no">取消</button>
       <button class="btn primary" id="confirm-yes">${esc(okText)}</button>`
    );
    $("#confirm-no").addEventListener("click", () => {
      closeModal();
      resolve(false);
    });
    $("#confirm-yes").addEventListener("click", () => {
      closeModal();
      resolve(true);
    });
  });
}

/* ------------------------------------------------------------------ 路由 */

function switchView(view) {
  state.view = view;
  const activeTab = view === "records" ? "library" : view;
  $$(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === activeTab));
  $$(".view").forEach((panel) => panel.classList.toggle("active", panel.id === `view-${view}`));
  if (view === "library") {
    if (state.libraryMode === "published") {
      refreshPublished().catch((error) => toast(error.message, true));
    } else {
      refreshLibrary().catch((error) => toast(error.message, true));
    }
  }
  if (view === "records") refreshRecords().catch((error) => toast(error.message, true));
  if (view === "queue") refreshLibrary().catch((error) => toast(error.message, true));
  if (view === "topics") refreshTopics().catch((error) => toast(error.message, true));
  if (view === "schedule") refreshSchedules().catch((error) => toast(error.message, true));
  if (view === "accounts") refreshAccounts().catch((error) => toast(error.message, true));
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ------------------------------------------------------------------ 概览 */

async function refreshOverview() {
  try {
    const data = await api("/api/overview");
    const pending =
      (data.jobs.pending || 0) + (data.jobs.retry || 0) + (data.jobs.running || 0);
    $("#today-chip").textContent = `今日 ${data.today_published} 篇 · 待发 ${pending}`;
    const count = $("#nav-library-count");
    const totalDrafts = ["draft", "queued", "published", "failed"].reduce(
      (sum, key) => sum + Number((data.drafts || {})[key] || 0),
      0
    );
    count.textContent = totalDrafts ? String(totalDrafts) : "";
    count.classList.toggle("show", totalDrafts > 0);
    state.overview = data;
    renderSetupBanner(data);
    renderAttention(data);
    state.notificationsUnread =
      (data.needs_action && data.needs_action.unread_notifications) || 0;
    renderNotifyBadge();
    if (state.view === "library" && state.libraryMode === "drafts") {
      renderLibraryStats();
      renderQueueReasons();
    }
  } catch (error) {
    toast(error.message, true);
  }
}

/* 新手引导：没有账号、没有选题、没有草稿时，明确告诉用户先点哪。 */
function renderSetupBanner(data) {
  const banner = $("#setup-banner");
  if (!banner || !data) return;
  const accounts = data.accounts || {};
  const topics = data.topics || {};
  const drafts = data.drafts || {};
  let step = 1;
  let view = "accounts";
  let title = "";
  let desc = "";
  let action = "";
  if (!accounts.total) {
    title = "第一步：先接入一个账号";
    desc = "没有账号就没法发布。到「账号」页扫码，或粘贴浏览器里的登录信息（Cookie）。";
    action = "去接入";
  } else if (!accounts.healthy) {
    title = "账号登录已失效";
    desc = "重新扫码或更新登录信息之后，才能继续发布。";
    action = "去处理";
  } else if (!topics.pool && !topics.used) {
    step = 2;
    view = "topics";
    title = "第二步：先找几个选题";
    desc = "到「选题」页按关键词挖一批，或者手动加一条。";
    action = "去选题";
  } else if (!drafts.draft && !drafts.queued && !drafts.published) {
    step = 3;
    view = "studio";
    title = "第三步：写出第一篇笔记";
    desc = "可以直接让模型起草，也可以把选题一键变成草稿。";
    action = "开始写";
  }
  state.setupView = view;
  banner.hidden = !title;
  if (!title) return;
  banner.querySelector(".step-no").textContent = String(step);
  $("#setup-title").textContent = title;
  $("#setup-desc").textContent = desc;
  $("#btn-setup-go").textContent = action;
}

/* 首页提醒条：把待确认、作品异常、账号失效变成可点击的下一步。 */
function renderAttention(data) {
  const needs = data.needs_action || {};
  const pending = Number(needs.pending_confirm || 0);
  const abnormal = Number(needs.abnormal_notes || 0);
  const expired = Number(needs.expired_accounts || 0);
  const banner = $("#attention-banner");
  if (!banner) return;
  const parts = [];
  if (pending) parts.push(`${pending} 条发布结果待确认`);
  if (abnormal) parts.push(`${abnormal} 篇作品需关注`);
  if (expired) parts.push(`${expired} 个账号登录失效`);
  banner.hidden = parts.length === 0;
  if (!parts.length) {
    state.attentionTarget = "";
    return;
  }
  $("#attention-text").textContent = `${parts.join("、")}，建议尽快处理。`;
  state.attentionTarget = pending ? "pending" : expired ? "accounts" : "published";
}

/* ------------------------------------------------------------------ 通知 */

function renderNotifyBadge() {
  const badgeNode = $("#notify-badge");
  if (!badgeNode) return;
  const unread = Number(state.notificationsUnread || 0);
  badgeNode.hidden = unread <= 0;
  badgeNode.textContent = unread > 99 ? "99+" : String(unread);
}

async function refreshNotifications({ silent = true } = {}) {
  try {
    const items = await api("/api/notifications?limit=20");
    state.notifications = items;
    state.notificationsUnread = lastMeta.unread == null ? 0 : lastMeta.unread;
    renderNotifyBadge();
    if (!$("#notify-pop").hidden) renderNotifyList();
  } catch (error) {
    if (!silent) toast(error.message, true);
  }
}

function renderNotifyList() {
  const list = $("#notify-list");
  if (!list) return;
  if (!state.notifications.length) {
    list.innerHTML = `<p class="notify-empty">暂无通知。发布失败、账号失效、作品异常时会出现在这里。</p>`;
    return;
  }
  list.innerHTML = state.notifications
    .map((item) => {
      const level = item.level === "error" ? "bad" : item.level === "info" ? "ok" : "warn";
      return `<button type="button" class="notify-item${item.read ? "" : " unread"}" data-action="open-notification" data-id="${item.id}">
        <span class="notify-dot ${level}"></span>
        <span class="notify-main">
          <b>${esc(item.title)}</b>
          <small>${esc(item.message || item.event_text)}</small>
          <em>${esc(fmtTime(item.created_at))}</em>
        </span>
      </button>`;
    })
    .join("");
}

function toggleNotifyPop(open) {
  const pop = $("#notify-pop");
  const button = $("#btn-notify");
  if (!pop || !button) return;
  const next = open == null ? pop.hidden : Boolean(open);
  pop.hidden = !next;
  button.setAttribute("aria-expanded", String(next));
  if (next) {
    renderNotifyList();
    refreshNotifications({ silent: true });
  }
}

async function markNotificationsRead() {
  try {
    await api("/api/notifications/read", { method: "POST", body: {} });
    state.notifications = state.notifications.map((item) => ({ ...item, read: true }));
    state.notificationsUnread = 0;
    renderNotifyBadge();
    renderNotifyList();
    toast("已全部标记为已读");
  } catch (error) {
    toast(error.message, true);
  }
}

async function openNotification(item) {
  toggleNotifyPop(false);
  if (!item) return;
  if (!item.read) {
    api("/api/notifications/read", { method: "POST", body: { ids: [item.id] } })
      .then(() => refreshNotifications({ silent: true }))
      .catch(reportBackgroundError);
  }
  if (item.link_view === "accounts") {
    switchView("accounts");
    if (item.link_id) openAccountDrawer(item.link_id);
    return;
  }
  if (item.link_view === "published") {
    switchView("library");
    setLibraryMode("published");
    if (item.link_id) openNoteDetail(item.link_id);
    return;
  }
  if (item.link_view === "records") {
    switchView("records");
    return;
  }
  switchView("library");
  setLibraryMode("drafts");
}

/* 推送渠道：站内消息之外的可选通道。 */
async function openNotifyChannels() {
  toggleNotifyPop(false);
  openModal(
    "推送渠道",
    `<p class="hint">站内通知始终保留；这里配置的是额外的站外推送（失败只记录，不影响业务）。</p>
     <div class="form-row"><label>渠道</label>
       <select id="notify-channel-kind">
         <option value="webhook">通用 Webhook（POST JSON）</option>
         <option value="dingtalk">钉钉机器人</option>
         <option value="bark">Bark</option>
       </select></div>
     <div class="form-row"><label>名称</label><input id="notify-channel-name" placeholder="例如：主账号群" /></div>
     <div class="form-row"><label>推送地址</label><input id="notify-channel-target" placeholder="https://..." /></div>
     <div class="form-row"><label>订阅事件</label>
       <select id="notify-channel-events">
         <option value="all">全部事件</option>
         <option value="publish_failed">发布失败</option>
         <option value="publish_pending">结果待确认</option>
         <option value="account_expired">账号失效</option>
         <option value="note_abnormal">作品异常</option>
         <option value="sync_failed">同步失败</option>
         <option value="risk_cooldown">风控冷却</option>
       </select></div>
     <div class="notify-channel-list" id="notify-channel-list"><div class="skeleton skeleton-line"></div></div>`,
    `<button class="btn ghost" data-action="close-modal">关闭</button>
     <button class="btn primary" data-action="add-notify-channel">添加渠道</button>`
  );
  try {
    const channels = await api("/api/notifications/channels");
    const box = $("#notify-channel-list");
    if (!box) return;
    box.innerHTML = channels.length
      ? channels
          .map(
            (item) => `<div class="notify-channel-row">
              <div>
                <b>${esc(item.name || item.channel)}</b>
                <small>${esc(item.channel)} · ${esc(item.target)}</small>
                <em>${item.last_sent_at ? `最近推送 ${esc(relTime(item.last_sent_at))} · ${esc(item.last_status)}` : "尚未推送"}</em>
              </div>
              <div class="notify-channel-actions">
                <button class="btn small ghost" data-action="test-notify-channel" data-id="${item.id}">测试</button>
                <button class="btn small ghost" data-action="delete-notify-channel" data-id="${item.id}">删除</button>
              </div>
            </div>`
          )
          .join("")
      : `<p class="hint">还没有渠道。上面填好地址后点「添加渠道」。</p>`;
  } catch (error) {
    toast(error.message, true);
  }
}

/* ------------------------------------------------------------------ 创作台 */

function splitTopics(value) {
  const items = [];
  String(value || "")
    .split(/[,，;；\n#]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .forEach((item) => {
      if (items.length < 5 && !items.includes(item)) items.push(item);
    });
  return items;
}

function bodyWithoutTags(text) {
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*(#[^\s#]+\s*)+$/.test(line))
    .join("\n")
    .trim();
}

function currentAccount() {
  const id = Number(state.studio.accountId || 0);
  return state.accounts.find((account) => account.id === id) || null;
}

function studioValues() {
  return {
    title: $("#f-title").value.trim(),
    desc: $("#f-desc").value.trim(),
    topics: splitTopics($("#f-topics").value),
    images: state.studio.images.slice(),
    visibility: state.studio.visibility,
    bodyMd: state.studio.bodyMd || "",
    bodyHtml: state.studio.bodyHtml || "",
  };
}

const IMAGE_EXT = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];
const VIDEO_EXT = ["mp4", "mov", "webm", "avi", "mkv", "flv", "wmv", "m4v"];

function fileExt(path) {
  const value = String(path || "").split(/[?#]/)[0];
  const index = value.lastIndexOf(".");
  return index >= 0 ? value.slice(index + 1).toLowerCase() : "";
}

/* 与适配器同一份规格：写错当场提示，不等提交才报错。 */
function studioSpecProblems(values, platformKey = state.studio.platform, contentType = state.studio.contentType) {
  const info = platformInfo(platformKey) || PLATFORM_FALLBACK;
  const spec = specOf(info.key, contentType);
  const problems = [];
  const title = String(values.title || "");
  const desc = String(values.desc || "");
  const images = values.images || [];
  if (!title) problems.push({ field: "title", text: "标题不能为空" });
  else if (title.length > spec.title_max) {
    problems.push({ field: "title", text: `${info.name}标题最多 ${spec.title_max} 字，当前 ${title.length} 字` });
  }
  if (!desc) problems.push({ field: "desc", text: "正文不能为空" });
  else if (desc.length > spec.desc_max) {
    problems.push({ field: "desc", text: `${info.name}正文最多 ${spec.desc_max} 字，当前 ${desc.length} 字` });
  }
  if (info.key === "douyin") {
    const caption = [title, desc].filter(Boolean).join("\n");
    if (caption.length > 1000) {
      problems.push({ field: "desc", text: `抖音文案（标题+正文）最多 1000 字，当前 ${caption.length} 字` });
    }
  }
  const needMin = spec.requires_media ? Math.max(1, spec.min_images || 1) : 0;
  if (spec.media_type === "video") {
    if (!images.length) problems.push({ field: "media", text: `${spec.label}需要 1 个视频文件` });
    else {
      const ext = fileExt(images[0]);
      if (ext && !VIDEO_EXT.includes(ext)) {
        problems.push({ field: "media", text: `不支持的视频格式 .${ext}，请用 mp4 / mov / webm 等` });
      }
      const meta = state.studio.videoMeta || {};
      if (meta.duration && meta.duration > 15 * 60 + 1) {
        problems.push({ field: "media", text: `抖音视频不能超过 15 分钟，当前约 ${Math.round(meta.duration / 60)} 分钟` });
      }
      if (meta.size && meta.size > 4 * 1024 * 1024 * 1024) {
        problems.push({ field: "media", text: "抖音视频不能超过 4GB" });
      }
    }
  } else if (spec.max_images) {
    if (images.length < needMin) {
      problems.push({
        field: "media",
        text: `${info.name}${spec.label}需要至少 ${needMin} 张图片，当前 ${images.length} 张`,
      });
    } else if (images.length > spec.max_images && info.key !== "wechat_mp") {
      /* 公众号多出来的图会保留并提示插入正文，不算错误。 */
      problems.push({
        field: "media",
        text: `${info.name}${spec.label}最多 ${spec.max_images} 张图片，当前 ${images.length} 张`,
      });
    }
    images.forEach((path) => {
      const ext = fileExt(path);
      if (ext && !IMAGE_EXT.includes(ext)) {
        problems.push({ field: "media", text: `不支持的图片格式 .${ext}` });
      }
    });
  }
  if (spec.media_type !== "video" && images.some((path) => VIDEO_EXT.includes(fileExt(path)))) {
    problems.push({ field: "media", text: `${info.name}${spec.label}不接受视频文件，请换成图片` });
  }
  if (!accountsForPlatform(info.key).length) {
    problems.push({ field: "account", text: `还没有${info.name}账号，先到「账号」页添加` });
  }
  return problems;
}

/* 切平台/内容类型时按目标规格收缩素材：视频只保留 1 个视频，公众号只保留 1 张封面。 */
function sanitizeMediaForSpec(images, spec, platformKey) {
  const list = (images || []).slice();
  if (spec.media_type === "video") {
    const video = list.find((path) => VIDEO_EXT.includes(fileExt(path)));
    return video ? [video] : [];
  }
  const pictures = list.filter((path) => !VIDEO_EXT.includes(fileExt(path)));
  if (platformKey === "wechat_mp" && spec.key !== "image_message") return pictures.slice(0, 1);
  return pictures.slice(0, spec.max_images || pictures.length);
}

function platformVisibility(target, current) {
  if (target === "wechat_mp") return 1;
  const options = (platformInfo(target) || {}).visibility_options || [];
  if (!options.length) return 0;
  return options.some((item) => Number(item.value) === Number(current))
    ? Number(current)
    : Number(options[0].value);
}

/* 一份素材可能是本地生成的卡片、设计风卡片，也可能是用户上传的图片，
   这里统一映射成页面可访问的 URL。 */
function mediaUrl(path, draftId = state.studio.draftId) {
  const value = String(path || "");
  if (!value) return "";
  if (/^https?:\/\//.test(value) || value.startsWith("/")) return value;
  const parts = value.replace(/\\/g, "/").split("/");
  const name = parts.pop();
  if (parts.includes("uploads")) return `/uploads/${encodeURIComponent(name)}`;
  if (parts.includes("designs")) {
    const style = parts.pop();
    const draft = parts.pop();
    return `/designs/${encodeURIComponent(draft)}/${encodeURIComponent(style)}/${encodeURIComponent(name)}`;
  }
  return draftId ? `/assets/draft-${draftId}/${encodeURIComponent(name)}` : "";
}

function highlightTags(text) {
  return esc(text).replace(/#([^\s#<]+)/g, '<span class="tag">#$1</span>');
}

function todayLabel() {
  const date = new Date();
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function resetPreviewScroll() {
  const scroll = $("#pv-scroll");
  if (scroll) scroll.scrollTop = 0;
}

function todayFullLabel() {
  const date = new Date();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function previewParagraphs(text) {
  return String(text || "")
    .split(/\n{2,}/)
    .map((block) => `<p>${esc(block).replace(/\n/g, "<br />")}</p>`)
    .join("");
}

/* 预览里的可编辑节点正在输入时不能重绘，否则光标会被打断。 */
function isEditingNode(node) {
  if (!node) return false;
  const active = document.activeElement;
  return !!active && (active === node || node.contains(active));
}

/* contenteditable 的 HTML → 纯文本，写回正文输入框并参与字数校验。 */
function htmlToPlain(html) {
  const holder = document.createElement("div");
  holder.innerHTML = String(html || "");
  holder.querySelectorAll("br").forEach((node) => node.replaceWith("\n"));
  holder.querySelectorAll("p,div,h1,h2,h3,h4,li,blockquote,section,figure").forEach((node) => node.append("\n"));
  return (holder.textContent || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderPreview() {
  const values = studioValues();
  const info = studioPlatformInfo();
  const spec = studioSpec();
  const author = currentAccount();
  const authorName = author ? author.nickname || author.name : "应声面试";
  $$(".preview-device").forEach((node) => {
    node.hidden = node.dataset.preview !== info.key;
  });
  const platformTag = $("#pv-platform");
  if (platformTag) platformTag.textContent = info.short || info.name;
  renderXhsPreview(values, spec, authorName);
  renderWechatPreview(values, authorName);
  renderDouyinPreview(values, spec, authorName);
}

function renderXhsPreview(values, spec, authorName) {
  const wrap = $(".gallery-wrap");
  $("#pv-author").textContent = authorName;
  $("#pv-avatar").textContent = (authorName || "应").slice(0, 1);
  if (spec.media_type === "video") {
    if (galleryController) galleryController.destroy();
    galleryController = null;
    const src = values.images.length ? mediaUrl(values.images[0]) : "";
    wrap.dataset.sig = "";
    wrap.innerHTML = src
      ? `<div class="gallery xhs-video"><video src="${esc(src)}" muted loop playsinline preload="metadata"></video>
          <span class="xhs-video-badge">视频笔记</span></div>`
      : `<div class="gallery is-empty"><div class="gallery-empty">
          <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="3" y="4" width="18" height="16" rx="3"></rect><path d="M10 8.5l6 3.5-6 3.5z"></path></svg>
          <span>视频会显示在这里</span><span>右侧上传 1 个视频</span></div></div>`;
  } else if (values.images.length) {
    const srcs = values.images.map((path) => mediaUrl(path));
    const sig = `${state.studio.draftId || ""}|${values.images.join("|")}`;
    const startIndex = Math.min(state.studio.imageIndex || 0, values.images.length - 1);
    if (wrap.dataset.sig !== sig) {
      if (galleryController) galleryController.destroy();
      wrap.dataset.sig = sig;
      wrap.innerHTML = `
        <div class="gallery">
          <div class="gallery-viewport" tabindex="0" role="group" aria-label="笔记配图">
            <div class="gallery-track">${srcs
              .map(
                (src, index) =>
                  `<div class="gallery-item">${
                    src
                      ? `<img src="${esc(src)}" alt="配图 ${index + 1}" draggable="false" />`
                      : ""
                  }</div>`
              )
              .join("")}</div>
          </div>
          <span class="gallery-counter">${startIndex + 1}/${values.images.length}</span>
        </div>
        <div class="gallery-dots">${srcs
          .map((_, index) => `<span class="gallery-dot${index === startIndex ? " on" : ""}"></span>`)
          .join("")}</div>`;
      galleryController = createGallery(wrap, startIndex);
    } else if (galleryController) {
      galleryController.setIndex(startIndex, false);
    }
  } else {
    if (galleryController) galleryController.destroy();
    galleryController = null;
    wrap.dataset.sig = "";
    wrap.innerHTML = `<div class="gallery is-empty"><div class="gallery-empty">
      <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.4">
        <rect x="3" y="4" width="18" height="16" rx="3"></rect>
        <circle cx="9" cy="10" r="1.6"></circle>
        <path d="M4 17l5-4 4 3 3-2 4 3"></path>
      </svg>
      <span>配图会显示在这里</span>
      <span>右侧点「生成配图」</span>
    </div></div>`;
  }
  const titleNode = $("#pv-title");
  if (!isEditingNode(titleNode)) titleNode.textContent = values.title;
  const bodyNode = $("#pv-body");
  if (!isEditingNode(bodyNode)) {
    bodyNode.innerHTML = values.desc ? highlightTags(values.desc).replace(/\n/g, "<br />") : "";
  }
  const topics = values.topics || [];
  $("#pv-tags").innerHTML = topics.map((topic) => `<span class="tag">#${esc(topic)}</span>`).join("");
  const collection = $("#pv-collection");
  if (collection) {
    collection.textContent = topics[0] || "";
    const row = collection.closest(".note-collection");
    if (row) row.hidden = !topics[0];
  }
  $("#pv-date").textContent = todayLabel();
}

/* 公众号预览：正文只存内容，主题在渲染时套用；缓存同一份「主题+内容」的结果，
   避免每次输入都请求服务端，也避免重绘打断正在编辑的光标。 */
let wxThemeCache = { sig: "", html: "", pending: "" };
let wxThemeTimer = 0;
let wxThemeToken = 0;

function wechatRawBody(values) {
  const html = String(state.studio.bodyHtml || "").trim();
  if (html) return html;
  if (!values.desc) return "";
  /* Markdown 模式下以服务端渲染结果为准，先不把 Markdown 当纯文本灌进预览。 */
  if (state.studio.mdMode) return "";
  return previewParagraphs(values.desc);
}

function scheduleWechatTheming(sig, raw, theme) {
  window.clearTimeout(wxThemeTimer);
  const token = ++wxThemeToken;
  wxThemeTimer = window.setTimeout(async () => {
    try {
      const result = await api("/api/richtext/style", {
        method: "POST",
        body: { html: raw, theme },
      });
      if (token !== wxThemeToken) return;
      const themed = String((result && result.html) || raw);
      wxThemeCache = { sig, html: themed, pending: "" };
      const body = $("#pv-wx-body");
      if (!body || body.dataset.themeSig !== sig || isEditingNode(body)) return;
      body.innerHTML = themed;
    } catch (error) {
      wxThemeCache.pending = "";
      reportBackgroundError(error);
    }
  }, 200);
}

function paintWechatBody(raw) {
  const body = $("#pv-wx-body");
  if (!body) return;
  if (!raw) {
    body.dataset.themeSig = "";
    body.innerHTML = `<p class="placeholder">正文会显示在这里。左侧写 Markdown 或文字，这里会实时套用排版。</p>`;
    return;
  }
  const theme = String(state.studio.wxTheme || "").trim();
  const sig = `${theme}|${raw}`;
  const previous = body.dataset.themeSig || "";
  body.dataset.themeSig = sig;
  if (!theme) {
    wxThemeCache = { sig, html: raw, pending: "" };
    body.innerHTML = raw;
    return;
  }
  if (wxThemeCache.sig === sig) {
    body.innerHTML = wxThemeCache.html;
    return;
  }
  if (wxThemeCache.pending === sig) return;
  wxThemeCache.pending = sig;
  /* 已经渲染过内容时先保留旧画面，等排版结果回来再替换，避免一打字就闪出原文。 */
  if (!previous) body.innerHTML = raw;
  scheduleWechatTheming(sig, raw, theme);
}

function renderWechatPreview(values, authorName) {
  const title = $("#pv-wx-title");
  if (!isEditingNode(title)) {
    title.textContent = values.title || "标题会显示在这里";
    title.classList.toggle("placeholder", !values.title);
  }
  const avatar = $("#pv-wx-avatar");
  if (avatar) avatar.textContent = (authorName || "应").slice(0, 1);
  $("#pv-wx-author").textContent = authorName;
  const body = $("#pv-wx-body");
  if (!isEditingNode(body)) paintWechatBody(wechatRawBody(values));
  /* 长文本来就没有顶图，封面只在素材区展示；贴图才把图片竖排进正文。 */
  const figures = $("#pv-wx-figures");
  const spec = studioSpec();
  const signature = `${spec.key}|${values.images.join("|")}`;
  if (figures && figures.dataset.sig !== signature) {
    figures.dataset.sig = signature;
    figures.innerHTML =
      spec.key === "image_message"
        ? values.images
            .map((path, index) => `<img src="${esc(mediaUrl(path))}" alt="贴图 ${index + 1}" />`)
            .join("")
        : "";
  }
}

function renderDouyinPreview(values, spec, authorName) {
  $("#pv-dy-author").textContent = authorName;
  $("#pv-dy-avatar").textContent = (authorName || "应").slice(0, 1);
  const declaredVideo = spec.media_type === "video";
  const hasVideoFile = values.images.some((path) => VIDEO_EXT.includes(fileExt(path)));
  /* 内容是视频类型但只传了图片时按图文渲染，避免整屏黑底加一张窄图。 */
  const isVideo = declaredVideo && (hasVideoFile || !values.images.length);
  const kind = $("#pv-dy-kind");
  if (kind) kind.textContent = isVideo ? "视频" : "图文";
  const media = $("#pv-dy-media");
  const mediaSig = `${isVideo ? "video" : "image"}|${values.images.join("|")}`;
  if (media && media.dataset.sig !== mediaSig) {
    media.dataset.sig = mediaSig;
    if (isVideo) {
      const src = values.images.length ? mediaUrl(values.images[0]) : "";
      media.innerHTML = src
        ? `<video src="${esc(src)}" muted loop playsinline preload="metadata"></video>
           <span class="dy-play" aria-hidden="true">▶</span>`
        : `<div class="dy-media-empty"><span>视频会显示在这里</span><small>上传 1 个视频后预览</small></div>`;
      const video = $("video", media);
      if (video) {
        media.addEventListener("click", () => {
          if (video.paused) video.play().catch(() => {});
          else video.pause();
        }, { once: true });
      }
    } else if (values.images.length) {
      /* 图文按原始比例铺在画面里，左右拖动切换；不裁切、不拉伸。 */
      const total = values.images.length;
      media.innerHTML = `
        <div class="dy-gallery">
          ${values.images
            .map(
              (path, index) =>
                `<div class="dy-slide"><img src="${esc(mediaUrl(path))}" alt="图片 ${index + 1}" draggable="false" loading="lazy" /></div>`
            )
            .join("")}
        </div>
        ${
          total > 1
            ? `<div class="dy-progress">${values.images
                .map((_, index) => `<span class="dy-seg${index === 0 ? " active" : ""}"></span>`)
                .join("")}</div>`
            : ""
        }`;
      const track = $(".dy-gallery", media);
      if (track && total > 1) {
        const syncIndex = () => {
          const index = Math.min(
            total - 1,
            Math.max(0, Math.round(track.scrollLeft / Math.max(1, track.clientWidth)))
          );
          $$(".dy-seg", media).forEach((seg, i) => seg.classList.toggle("active", i === index));
        };
        track.addEventListener("scroll", syncIndex, { passive: true });
        /* 桌面端原生滚动容器用鼠标拖不动，这里补一段按住拖动。 */
        let startX = 0;
        let startLeft = 0;
        let dragging = false;
        track.addEventListener("pointerdown", (event) => {
          if (event.pointerType !== "mouse" || event.button !== 0) return;
          dragging = true;
          startX = event.clientX;
          startLeft = track.scrollLeft;
          track.classList.add("dragging");
          track.setPointerCapture(event.pointerId);
        });
        track.addEventListener("pointermove", (event) => {
          if (!dragging) return;
          track.scrollLeft = startLeft - (event.clientX - startX);
        });
        const endDrag = () => {
          if (!dragging) return;
          dragging = false;
          track.classList.remove("dragging");
          track.scrollTo({
            left: Math.round(track.scrollLeft / Math.max(1, track.clientWidth)) * track.clientWidth,
            behavior: "smooth",
          });
        };
        track.addEventListener("pointerup", endDrag);
        track.addEventListener("pointercancel", endDrag);
      }
    } else {
      media.innerHTML = `<div class="dy-media-empty"><span>${isVideo ? "视频" : "图片"}会显示在这里</span><small>${
        isVideo ? "上传 1 个视频" : "至少上传 2 张图片"
      }</small></div>`;
    }
  }
  const caption = $("#pv-dy-caption");
  if (!isEditingNode(caption)) {
    const captionTitle = values.title || "";
    let captionBody = values.desc || "";
    /* 标题往往就是正文第一句，重复出现时只保留一次。 */
    if (captionTitle && captionBody.startsWith(captionTitle)) {
      captionBody = captionBody
        .slice(captionTitle.length)
        .replace(/^[\s，。、,:：;；\-—]+/, "");
    }
    caption.innerHTML =
      captionTitle || captionBody
        ? `<b contenteditable="true" spellcheck="false" data-field="title">${esc(captionTitle)}</b>` +
          `<span contenteditable="true" spellcheck="false" data-field="desc">${esc(captionBody).replace(/\n/g, "<br />")}</span>`
        : '<span class="placeholder">文案会显示在这里，标题和正文都会出现在视频下方。</span>';
    caption.classList.remove("expanded");
    const long = (captionTitle.length + captionBody.length) > 90;
    /* 展开按钮放在文案框外面，避免被三行截断一起裁掉。 */
    const expand = $("#pv-dy-expand");
    if (expand) {
      expand.hidden = !long;
      expand.textContent = "展开";
    }
  }
  $("#pv-dy-tags").innerHTML = (values.topics || [])
    .map((topic) => `<span>#${esc(topic)}</span>`)
    .join("");
}

let galleryController = null;
let lightbox = null;

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function createGallery(wrap, startIndex) {
  const viewport = $(".gallery-viewport", wrap);
  const track = $(".gallery-track", wrap);
  const counter = $(".gallery-counter", wrap);
  const total = track.children.length;
  let index = clampNumber(startIndex, 0, total - 1);
  let width = viewport.clientWidth || 1;
  let dragging = false;
  let axis = null;
  let activeId = null;
  let startX = 0;
  let startY = 0;
  let deltaX = 0;
  let lastX = 0;
  let lastTime = 0;
  let velocity = 0;
  let moved = false;
  let suppressClick = false;

  const paint = (offset, animate) => {
    track.style.transition = animate ? "" : "none";
    track.style.transform = `translate3d(${offset}px, 0, 0)`;
  };

  const sync = () => {
    if (counter) counter.textContent = `${index + 1}/${total}`;
    $$(".gallery-dot", wrap).forEach((dot, i) => dot.classList.toggle("on", i === index));
    state.studio.imageIndex = index;
  };

  const setIndex = (next, animate = true) => {
    index = clampNumber(next, 0, total - 1);
    paint(-index * width, animate);
    sync();
  };

  const settle = () => {
    const threshold = Math.min(width * 0.18, 90);
    let next = index;
    if (deltaX < -threshold || velocity < -0.45) next = index + 1;
    else if (deltaX > threshold || velocity > 0.45) next = index - 1;
    setIndex(next, true);
  };

  const urls = () => $$("img", track).map((image) => image.currentSrc || image.src);

  const onPointerDown = (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    dragging = true;
    axis = null;
    activeId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    lastX = event.clientX;
    lastTime = performance.now();
    deltaX = 0;
    velocity = 0;
    moved = false;
    suppressClick = false;
    track.style.transition = "none";
  };

  const onPointerMove = (event) => {
    if (!dragging || event.pointerId !== activeId) return;
    const rawX = event.clientX - startX;
    const rawY = event.clientY - startY;
    if (!axis) {
      if (Math.abs(rawX) < 6 && Math.abs(rawY) < 6) return;
      axis = Math.abs(rawX) > Math.abs(rawY) ? "x" : "y";
      if (axis === "y") {
        dragging = false;
        return;
      }
      viewport.classList.add("dragging");
      try {
        viewport.setPointerCapture(event.pointerId);
      } catch (error) {
        /* ignore */
      }
    }
    event.preventDefault();
    deltaX = rawX;
    moved = moved || Math.abs(rawX) > 8 || Math.abs(rawY) > 8;
    const now = performance.now();
    velocity = (event.clientX - lastX) / Math.max(1, now - lastTime);
    lastX = event.clientX;
    lastTime = now;
    let offset = -index * width + deltaX;
    const min = -(total - 1) * width;
    if (offset > 0) offset *= 0.35;
    else if (offset < min) offset = min + (offset - min) * 0.35;
    track.style.transform = `translate3d(${offset}px, 0, 0)`;
  };

  const finishDrag = (event) => {
    if (!dragging || (event && event.pointerId !== activeId)) return;
    const horizontal = axis === "x";
    dragging = false;
    axis = null;
    activeId = null;
    viewport.classList.remove("dragging");
    if (horizontal) {
      suppressClick = moved;
      settle();
    }
  };

  const onClick = () => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    openLightbox(urls(), index, (next) => setIndex(next, false));
  };

  const onKey = (event) => {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      setIndex(index + 1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      setIndex(index - 1);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openLightbox(urls(), index, (next) => setIndex(next, false));
    }
  };

  const observer = new ResizeObserver(() => {
    width = viewport.clientWidth || 1;
    paint(-index * width, false);
  });
  observer.observe(viewport);
  viewport.addEventListener("pointerdown", onPointerDown);
  viewport.addEventListener("pointermove", onPointerMove, { passive: false });
  viewport.addEventListener("pointerup", finishDrag);
  viewport.addEventListener("pointercancel", finishDrag);
  viewport.addEventListener("click", onClick);
  viewport.addEventListener("keydown", onKey);
  setIndex(index, false);

  return {
    setIndex,
    get index() {
      return index;
    },
    destroy() {
      observer.disconnect();
      viewport.removeEventListener("pointerdown", onPointerDown);
      viewport.removeEventListener("pointermove", onPointerMove);
      viewport.removeEventListener("pointerup", finishDrag);
      viewport.removeEventListener("pointercancel", finishDrag);
      viewport.removeEventListener("click", onClick);
      viewport.removeEventListener("keydown", onKey);
    },
  };
}

function openLightbox(urls, startIndex, onIndex) {
  if (!urls.length) return;
  if (lightbox) closeLightbox();
  const root = document.createElement("div");
  root.className = "lightbox" + (urls.length === 1 ? " single" : "");
  root.innerHTML = `
    <div class="lb-backdrop"></div>
    <div class="lb-top">
      <span class="lb-count">${startIndex + 1}/${urls.length}</span>
      <button class="lb-close" type="button" aria-label="关闭">
        <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M6 6l12 12M18 6L6 18"></path>
        </svg>
      </button>
    </div>
    <div class="lb-stage">
      <div class="lb-track">${urls
        .map((url) => `<div class="lb-slide"><img src="${esc(url)}" alt="配图" draggable="false" /></div>`)
        .join("")}</div>
    </div>
    ${
      urls.length > 1
        ? `<div class="lb-strip">${urls
            .map(
              (url, i) =>
                `<button class="lb-thumb${i === startIndex ? " on" : ""}" type="button" data-index="${i}" aria-label="第 ${i + 1} 张">
                  <img src="${esc(url)}" alt="" draggable="false" />
                </button>`
            )
            .join("")}</div>`
        : ""
    }`;
  document.body.appendChild(root);
  document.body.classList.add("lb-open");
  requestAnimationFrame(() => root.classList.add("open"));

  const stage = $(".lb-stage", root);
  const track = $(".lb-track", root);
  const images = $$("img", track);
  const counter = $(".lb-count", root);
  const thumbs = $$(".lb-thumb", root);
  let index = clampNumber(startIndex, 0, urls.length - 1);
  let stageWidth = stage.clientWidth || 1;
  let scale = 1;
  let tx = 0;
  let ty = 0;
  let pointers = new Map();
  let drag = null;
  let pinch = null;
  let lastTap = 0;
  let closing = false;

  const currentImg = () => images[index];

  const updateChrome = () => {
    if (counter) counter.textContent = `${index + 1}/${urls.length}`;
    thumbs.forEach((thumb, i) => {
      thumb.classList.toggle("on", i === index);
      if (i === index) thumb.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
    });
  };

  const clampPan = () => {
    const img = currentImg();
    if (!img) return;
    const rect = stage.getBoundingClientRect();
    const maxX = Math.max(0, (img.offsetWidth * scale - rect.width) / 2) + 24;
    const maxY = Math.max(0, (img.offsetHeight * scale - rect.height) / 2) + 24;
    tx = clampNumber(tx, -maxX, maxX);
    ty = clampNumber(ty, -maxY, maxY);
  };

  const applyZoom = (animate = true) => {
    const img = currentImg();
    if (!img) return;
    img.style.transition = animate ? "" : "none";
    img.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
  };

  const resetZoom = () => {
    scale = 1;
    tx = 0;
    ty = 0;
    images.forEach((image) => {
      if (image !== currentImg()) {
        image.style.transition = "none";
        image.style.transform = "";
      }
    });
    applyZoom(false);
  };

  const setPage = (next, animate = true) => {
    index = clampNumber(next, 0, urls.length - 1);
    resetZoom();
    track.style.transition = animate ? "" : "none";
    track.style.transform = `translate3d(${-index * stageWidth}px, 0, 0)`;
    updateChrome();
  };

  const zoomAt = (clientX, clientY) => {
    if (scale > 1) {
      scale = 1;
      tx = 0;
      ty = 0;
      applyZoom();
      return;
    }
    const rect = stage.getBoundingClientRect();
    const cx = clientX - (rect.left + rect.width / 2);
    const cy = clientY - (rect.top + rect.height / 2);
    scale = 2.5;
    tx = -cx * (scale - 1);
    ty = -cy * (scale - 1);
    clampPan();
    applyZoom();
  };

  const onDown = (event) => {
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    try {
      stage.setPointerCapture(event.pointerId);
    } catch (error) {
      /* ignore */
    }
    if (pointers.size === 1) {
      drag = { startX: event.clientX, startY: event.clientY, moved: false };
      drag.lastX = event.clientX;
      drag.lastY = event.clientY;
      if (scale <= 1) track.style.transition = "none";
    } else if (pointers.size === 2) {
      drag = null;
      const [a, b] = [...pointers.values()];
      pinch = {
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        scale,
        tx,
        ty,
        mx: (a.x + b.x) / 2,
        my: (a.y + b.y) / 2,
      };
    }
  };

  const onMove = (event) => {
    if (!pointers.has(event.pointerId)) return;
    const previous = pointers.get(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size >= 2 && pinch) {
      event.preventDefault();
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      scale = clampNumber((pinch.scale * distance) / Math.max(1, pinch.dist), 1, 4);
      tx = pinch.tx + (mx - pinch.mx);
      ty = pinch.ty + (my - pinch.my);
      if (scale <= 1.01) {
        tx = 0;
        ty = 0;
      }
      clampPan();
      applyZoom(false);
      return;
    }
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) drag.moved = true;
    if (scale > 1) {
      event.preventDefault();
      tx += event.clientX - previous.x;
      ty += event.clientY - previous.y;
      clampPan();
      applyZoom(false);
      return;
    }
    if (Math.abs(dx) >= Math.abs(dy)) {
      event.preventDefault();
      let offset = -index * stageWidth + dx;
      const min = -(urls.length - 1) * stageWidth;
      if (offset > 0) offset *= 0.35;
      else if (offset < min) offset = min + (offset - min) * 0.35;
      track.style.transform = `translate3d(${offset}px, 0, 0)`;
    }
  };

  const onUp = (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size > 0) return;
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (scale <= 1) {
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
        setPage(index + (dx < 0 ? 1 : -1));
      } else if (dy > 120 && Math.abs(dy) > Math.abs(dx)) {
        closeLightbox();
        return;
      } else {
        setPage(index);
      }
      if (event.pointerType !== "mouse" && !drag.moved) {
        const now = Date.now();
        if (now - lastTap < 300) {
          zoomAt(event.clientX, event.clientY);
          lastTap = 0;
        } else {
          lastTap = now;
        }
      }
    } else if (drag.moved) {
      clampPan();
    }
    drag = null;
  };

  const onWheel = (event) => {
    if (!event.ctrlKey && Math.abs(event.deltaY) < 4) return;
    event.preventDefault();
    const next = clampNumber(scale + (event.deltaY < 0 ? 0.3 : -0.3), 1, 4);
    if (next === 1) {
      tx = 0;
      ty = 0;
    }
    scale = next;
    applyZoom();
  };

  const onResize = () => {
    stageWidth = stage.clientWidth || 1;
    track.style.transition = "none";
    track.style.transform = `translate3d(${-index * stageWidth}px, 0, 0)`;
    clampPan();
    applyZoom(false);
  };

  const onDoubleClick = (event) => {
    event.preventDefault();
    zoomAt(event.clientX, event.clientY);
  };

  const onKey = (event) => {
    if (event.key === "Escape") closeLightbox();
    else if (event.key === "ArrowRight") setPage(index + 1);
    else if (event.key === "ArrowLeft") setPage(index - 1);
  };

  $(".lb-close", root).addEventListener("click", () => closeLightbox());
  const strip = $(".lb-strip", root);
  if (strip) {
    strip.addEventListener("click", (event) => {
      const thumb = event.target.closest(".lb-thumb");
      if (!thumb) return;
      setPage(Number(thumb.dataset.index));
    });
  }
  root.addEventListener("click", (event) => {
    if (event.target.closest(".lb-top, .lb-strip, img")) return;
    closeLightbox();
  });
  stage.addEventListener("pointerdown", onDown);
  stage.addEventListener("pointermove", onMove, { passive: false });
  stage.addEventListener("pointerup", onUp);
  stage.addEventListener("pointercancel", onUp);
  stage.addEventListener("dblclick", onDoubleClick);
  stage.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("resize", onResize);
  document.addEventListener("keydown", onKey);
  setPage(index, false);

  lightbox = {
    root,
    onIndex,
    index: () => index,
    close: () => {
      if (closing) return;
      closing = true;
      const current = index;
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      stage.removeEventListener("pointerdown", onDown);
      stage.removeEventListener("pointermove", onMove);
      stage.removeEventListener("pointerup", onUp);
      stage.removeEventListener("pointercancel", onUp);
      stage.removeEventListener("dblclick", onDoubleClick);
      stage.removeEventListener("wheel", onWheel);
      root.classList.add("closing");
      document.body.classList.remove("lb-open");
      if (onIndex) onIndex(current);
      setTimeout(() => root.remove(), 220);
    },
  };
}

function closeLightbox(notify = true) {
  if (!lightbox) return;
  const active = lightbox;
  lightbox = null;
  if (!notify) {
    active.root.remove();
    document.body.classList.remove("lb-open");
    return;
  }
  active.close();
}

function renderCompliance() {
  const card = $("#compliance-card");
  const values = studioValues();
  const issues = state.studio.issues || [];
  const problems = studioSpecProblems(values);
  const info = studioPlatformInfo();
  const spec = studioSpec();
  if (!values.title && !values.desc) {
    card.className = "check-card idle";
    card.innerHTML = `<div class="check-line">
      <span class="check-title">发布前检查</span>
      <span class="check-sub">写完标题和正文后显示结果</span></div>`;
    return;
  }
  if (issues.length) {
    card.className = "check-card bad";
    card.innerHTML = `<details class="check-details" open>
      <summary class="check-line">
        <span class="check-title">${issues.length} 处需要修改</span>
        <span class="check-sub">${issues
          .slice(0, 2)
          .map((issue) => esc(issue.label))
          .join("、")}${issues.length > 2 ? " 等" : ""}</span>
      </summary>
      <div class="check-body">
        <ul>${issues
          .slice(0, 5)
          .map((issue) => `<li>${esc(issue.label)}：<b>${esc(issue.match)}</b></li>`)
          .join("")}</ul>
        <p class="hint">改掉这些词才能发布。</p>
      </div>
    </details>`;
    return;
  }
  if (problems.length) {
    card.className = "check-card bad";
    card.innerHTML = `<details class="check-details" open>
      <summary class="check-line">
        <span class="check-title">${problems.length} 项还不能发布</span>
        <span class="check-sub">提交前会再校验</span>
      </summary>
      <div class="check-body"><ul>${problems
        .slice(0, 6)
        .map((item) => `<li>${esc(item.text)}</li>`)
        .join("")}</ul></div>
    </details>`;
    return;
  }
  const mediaLabel =
    spec.media_type === "video" ? `${values.images.length} 个视频` : `${values.images.length} 张图片`;
  card.className = "check-card ok";
  card.innerHTML = `<div class="check-line">
    <span class="check-title">可以发布</span>
    <span class="check-sub">${esc(info.name)} · ${esc(spec.label)} · 标题 ${values.title.length}/${spec.title_max} · 正文 ${values.desc.length}/${spec.desc_max} · ${mediaLabel}</span>
  </div>`;
}

function renderMedia() {
  const grid = $("#media-grid");
  const images = state.studio.images;
  const info = studioPlatformInfo();
  const spec = studioSpec();
  const isVideo = spec.media_type === "video";
  const card = grid.closest(".media-card");
  if (card) card.classList.toggle("has-media", images.length > 0);
  const wechatSquare =
    isWechatPlatform() && spec.key !== "image_message"
      ? String((state.studio.contentJson || {}).wechat_square || "")
      : "";
  const count = $("#media-count");
  if (count) {
    if (isVideo) count.textContent = images.length ? "已选 1 个视频" : "还没选视频";
    else if (isWechatPlatform() && spec.key !== "image_message") {
      count.textContent = `${images.length} / 1 张封面${wechatSquare ? " + 1 张方图" : ""}`;
    } else count.textContent = images.length ? `${images.length} 张` : "还没加图";
  }
  const freeButton = $("#btn-cards-free");
  if (freeButton && !freeButton.dataset.busy) {
    const hasImages = images.length > 0;
    const artSelected = /^art-/.test(state.cardStyle);
    const noun = artSelected ? "插画封面" : isWechatPlatform() ? "封面" : "配图";
    freeButton.classList.toggle("primary", !hasImages);
    freeButton.classList.toggle("ghost", hasImages);
    if (freeButton.textContent.trim()) {
      freeButton.textContent = hasImages ? `重新生成${noun}` : `生成${noun}`;
    }
  }
  if (!images.length && !wechatSquare) {
    grid.innerHTML = "";
    return;
  }
  /* 公众号长文的封面与小图已在上方成对展示，这里不再重复出缩略图。 */
  const coverOnly = isWechatPlatform() && spec.key !== "image_message";
  const inCoverRow = new Set(coverOnly ? [images[0], wechatSquare].filter(Boolean) : []);
  let thumbs = images
    .map((path, index) => ({ path, index }))
    .filter(({ path }) => !inCoverRow.has(path))
    .map(({ path, index }) => {
      const url = mediaUrl(path);
      if (isVideo || VIDEO_EXT.includes(fileExt(path))) {
        return `<div class="media-thumb video-thumb" title="${esc(info.name)}视频">
          ${url ? `<video src="${esc(url)}" muted playsinline preload="metadata"></video>` : ""}
          <span class="video-tag">视频</span>
          <span class="remove" data-action="remove-image" data-index="${index}" title="移除">×</span>
        </div>`;
      }
      return `<button class="media-thumb" type="button" data-index="${index}" title="点击放大">
        ${url ? `<img src="${esc(url)}" alt="配图 ${index + 1}" loading="lazy" />` : ""}
        <span class="remove" data-action="remove-image" data-index="${index}" title="移除">×</span>
      </button>`;
    })
    .join("");
  /* 公众号 1:1 方图已在上方小图位展示，独立格子里不再重复。 */
  if (wechatSquare && !images.includes(wechatSquare) && !coverOnly) {
    thumbs += `<button class="media-thumb" type="button" data-extra="wechat-square"
      title="公众号 1:1 方图（正文插图）">
      <img src="${esc(mediaUrl(wechatSquare))}" alt="公众号 1:1 方图" loading="lazy" />
      <span class="video-tag">1:1 方图</span>
    </button>`;
  }
  grid.innerHTML = thumbs;
  const video = $("video", grid);
  if (video) {
    video.addEventListener("loadedmetadata", () => {
      state.studio.videoMeta = {
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        size: (state.studio.videoMeta && state.studio.videoMeta.size) || 0,
      };
      renderCompliance();
      updateStudioMeta();
    });
  }
  $$("#media-grid img").forEach((img) => {
    img.addEventListener("error", () => {
      const thumb = img.closest(".media-thumb");
      if (thumb) {
        thumb.classList.add("missing");
        img.remove();
      }
    });
  });
  /* 公众号长文：一张原图同时给出 2.35:1 封面与 1:1 小图封面的裁切效果。 */
  const coverBox = $("#wx-cover-preview");
  if (coverBox) {
    const spec = studioSpec();
    const cover = state.studio.images[0];
    const show = isWechatPlatform() && spec.key === "long_article" && Boolean(cover);
    coverBox.hidden = !show;
    if (show) {
      /* 有独立 1:1 方图时小图位用方图本身，否则用封面裁切预览。 */
      $("#wx-cover-main-img").src = mediaUrl(cover);
      $("#wx-cover-square-img").src = mediaUrl(wechatSquare || cover);
    }
  }
}

/* 素材区按平台/内容类型切换：视频只收视频；图文与公众号都能出图，
   公众号只出 1 张封面。入口不整体隐藏，不能用的能力说明原因并给替代动作。 */
function renderMediaMode() {
  const info = studioPlatformInfo();
  const spec = studioSpec();
  const cap = mediaCapability(info, spec);
  const isVideo = cap.kind === "video";
  const isCover = cap.kind === "cover";
  const tabs = $("#media-tabs");
  if (tabs) tabs.hidden = isVideo;
  if (isVideo) {
    ["#panel-free", "#panel-paid"].forEach((selector) => {
      const node = $(selector);
      if (node) node.hidden = true;
    });
  } else {
    if (isCover) state.mediaTab = "free";
    const paidTab = $('.media-tab[data-tab="paid"]');
    if (paidTab) {
      paidTab.disabled = isCover;
      paidTab.title = isCover ? "公众号只取第 1 张封面；付费出图 3 张起，不适用于单张封面" : "";
    }
    switchMediaTab(state.mediaTab);
  }
  const input = $("#upload-input");
  if (input) {
    if (isVideo) {
      input.accept = "video/*,.mp4,.mov,.webm,.avi,.mkv,.flv,.wmv,.m4v";
      input.multiple = false;
    } else {
      input.accept = "image/*";
      input.multiple = !isCover;
    }
  }
  const mediaTitle = $("#media-title");
  if (mediaTitle) {
    mediaTitle.textContent = isVideo ? "视频素材" : isCover ? "公众号封面" : "配图";
  }
  const title = $("#upload-title");
  const sub = $("#upload-sub");
  if (title) title.textContent = isVideo ? "上传视频" : isCover ? "上传封面" : "上传素材";
  if (sub) {
    sub.textContent = isVideo
      ? "MP4 / MOV 等，≤4GB、≤15 分钟"
      : isCover
      ? "1 张 JPG / PNG，≤10MB"
      : info.key === "douyin"
      ? `${spec.min_images}-${spec.max_images} 张，单张 ≤20MB`
      : "点击或拖入图片";
  }
  renderMediaNote(info, spec, cap);
}

/* 说明当前平台的出图规格；跨平台后尺寸/张数对不上时提示重新生成。 */
function renderMediaNote(info, spec, cap) {
  const note = $("#media-mode-note");
  if (!note) return;
  note.hidden = false;
  if (cap.kind === "video") {
    note.classList.add("attention");
    note.innerHTML = `视频内容不生成图文配图。要出图请先把内容类型切到「图文」：
      <button type="button" class="link-btn" data-action="switch-image-text">切换到图文</button>`;
    return;
  }
  if (state.studio.mediaMismatch) {
    note.classList.add("attention");
    const mismatch = state.studio.mediaMismatch;
    const extra =
      info.key === "wechat_mp" && spec.key !== "image_message" && state.studio.images.length > 1
        ? `；另外 ${state.studio.images.length - 1} 张可
      <button type="button" class="link-btn" data-action="insert-extra-images">插入正文</button>`
        : "";
    note.innerHTML = `这 ${state.studio.images.length} 张是按${esc(mismatch.from)} ${esc(
      mismatch.aspect
    )} 生成的，${esc(info.name)}需要 ${esc(cap.aspect)}，建议重新生成：
      <button type="button" class="link-btn" data-action="regenerate-cards">重新生成</button>${extra}`;
    return;
  }
  if (info.key === "wechat_mp" && spec.key !== "image_message" && state.studio.images.length > 1) {
    /* 公众号封面只有 1 张，但不丢图：封面和其余图片都能补进正文。 */
    note.classList.remove("attention");
    note.innerHTML = `公众号只用第 1 张作封面，封面和其余 ${state.studio.images.length - 1} 张都可
      <button type="button" class="link-btn" data-action="insert-extra-images">插入正文</button>`;
    return;
  }
  if (info.key === "wechat_mp" && spec.key !== "image_message" && state.studio.images.length) {
    const square = (state.studio.contentJson || {}).wechat_square;
    note.classList.remove("attention");
    note.innerHTML = `${square ? "封面和 1:1 方图" : "封面"}也可以
      <button type="button" class="link-btn" data-action="insert-extra-images">插入正文</button>`;
    return;
  }
  note.classList.remove("attention");
  note.textContent = mediaCapabilityText(info, spec);
}


function updateStudioMeta() {
  const values = studioValues();
  const spec = studioSpec();
  const info = studioPlatformInfo();
  const problems = studioSpecProblems(values);
  const published = state.studio.draftStatus === "published";
  const queued = state.studio.draftStatus === "queued";
  const blocked = !info.ready;
  const canSubmit = !blocked && !published && !queued && !state.studio.generating && !problems.length;
  const firstProblem = problems.length ? problems[0].text : "";
  const publishButton = $("#btn-publish");
  const publishNow = $("#btn-publish-now");
  const draftOnly = $("#btn-save-platform-draft");
  const wechat = platformActionMode() === "wechat";
  if (publishButton) {
    publishButton.hidden = wechat;
    publishButton.disabled = !canSubmit;
    publishButton.textContent = blocked ? "该平台暂未接入发布" : "加入发布队列";
    publishButton.title = blocked
      ? `${info.name}尚未接入发布，只能先存入内容库`
      : published
      ? "该草稿已发布"
      : queued
      ? "该草稿已在发布队列中"
      : firstProblem;
  }
  if (publishNow) {
    publishNow.hidden = !wechat;
    publishNow.disabled = !canSubmit;
    publishNow.title = published ? "该草稿已发布" : queued ? "该草稿已在发布队列中" : firstProblem;
  }
  if (draftOnly) {
    draftOnly.hidden = !wechat;
    draftOnly.disabled = !canSubmit;
    draftOnly.title = published ? "该草稿已发布" : queued ? "该草稿已在发布队列中" : firstProblem;
  }
  const titleProblem = problems.find((item) => item.field === "title");
  if (titleProblem && values.title) showInline("#title-error", titleProblem.text);
  else hideInline("#title-error");
  const descProblem = problems.find((item) => item.field === "desc");
  if (descProblem && values.desc) showInline("#desc-error", descProblem.text);
  else hideInline("#desc-error");
  const mediaProblem = problems.find((item) => item.field === "media");
  const mediaBox = $("#media-error");
  const mediaSticky = mediaBox && mediaBox.dataset.sticky === "1";
  if (!mediaSticky) {
    if (mediaProblem && values.images.length) showInline("#media-error", mediaProblem.text);
    else clearErrorBox("#media-error");
  }
  const meta = $("#studio-meta");
  const kind = `${info.short || info.name} ${spec.label}`;
  if (state.studio.draftId) {
    meta.textContent = published
      ? `草稿 #${state.studio.draftId} · ${kind} · 已发布，修改不会同步到平台`
      : queued
      ? `草稿 #${state.studio.draftId} · ${kind} · 已加入队列`
      : `草稿 #${state.studio.draftId} · ${kind} · ${
          state.studio.dirty ? "有未保存修改" : "已保存"
        }${problems.length ? " · 还不能发布" : ""}`;
  } else {
    meta.textContent = `新草稿 · ${kind} · ${problems.length ? "还不能发布" : "尚未保存"}`;
  }
  const titleInput = $("#f-title");
  titleInput.removeAttribute("maxlength");
  const countTitle = $("#count-title");
  countTitle.textContent = `${values.title.length} / ${spec.title_max}`;
  countTitle.classList.toggle("warn", values.title.length > spec.title_max);
  const countDesc = $("#count-desc");
  countDesc.textContent = `${values.desc.length} / ${spec.desc_max}`;
  countDesc.classList.toggle("warn", values.desc.length > spec.desc_max);
  const topicStyle = info.topic_style || spec.topics || "hashtag";
  $("#topic-chips").innerHTML = values.topics
    .map((topic) =>
      topicStyle === "topic"
        ? `<span class="badge">话题：${esc(topic)}</span>`
        : `<span class="badge accent">#${esc(topic)}</span>`
    )
    .join("");
  scheduleCardPlan();
}

function renderPlatformUi() {
  const info = studioPlatformInfo();
  const spec = studioSpec();
  const seg = $("#f-platform");
  if (seg) {
    seg.innerHTML = state.platforms
      .map(
        (item) => `<button type="button" class="${item.key === info.key ? "active" : ""}" data-platform="${esc(
          item.key
        )}" style="--brand:${esc(item.color || "#8a8f98")}" title="${esc(item.status_text || "")}">${esc(
          item.short || item.name
        )}</button>`
      )
      .join("");
  }
  const types = contentTypesFor(info.key);
  if (types.length && !types.some((item) => item.key === state.studio.contentType)) {
    state.studio.contentType = defaultContentType(info.key);
  }
  const activeSpec = studioSpec();
  const contentSeg = $("#f-content-type");
  if (contentSeg) {
    contentSeg.innerHTML = types
      .map(
        (item) => `<button type="button" class="${item.key === activeSpec.key ? "active" : ""}" data-content-type="${esc(
          item.key
        )}" title="${esc(item.notes || "")}">${esc(item.label.replace(/^(小红书|抖音|公众号)/, ""))}</button>`
      )
      .join("");
  }
  const hint = $("#platform-hint");
  if (hint) {
    const limits = [`标题 ${activeSpec.title_max} 字`, `正文 ${activeSpec.desc_max} 字`];
    if (activeSpec.media_type === "video") {
      limits.push(info.key === "douyin" ? "1 个视频 ≤4GB / ≤15 分钟" : "1 个视频");
      limits.push("文案（标题+正文）≤1000 字");
    } else if (info.key === "wechat_mp") {
      limits.push(
        activeSpec.key === "image_message"
          ? `${activeSpec.min_images}-${activeSpec.max_images} 张原图 JPG / PNG`
          : "1 张封面 JPG / PNG ≤10MB"
      );
    } else {
      limits.push(`${activeSpec.min_images}-${activeSpec.max_images} 张图片`);
    }
    hint.innerHTML = `${platformBadge(info.key)} ${limits.join(" · ")}${
      info.ready ? "" : " · 发布接入位已预留"
    }`;
  }
  const note = $("#platform-note");
  if (note) note.textContent = info.ready ? "已接入" : "接入位已预留";
  const actionHint = $("#platform-action-hint");
  if (actionHint) {
    actionHint.hidden = info.key === "xiaohongshu";
    actionHint.textContent =
      info.key === "wechat_mp"
        ? "「先存草稿」只进草稿箱，不推送；「立即发布」会推送给全部关注者，每天 1 次。"
        : info.key === "douyin"
        ? "视频与图文素材要求不同；可见范围含好友可见。"
        : "";
  }
  // 公众号不用「谁可见」表达草稿/发布，改为两个明确动作；其它平台按适配器声明渲染。
  const visibilityCell = $("#visibility-cell");
  if (visibilityCell) visibilityCell.hidden = isWechatPlatform(info.key);
  const pubGrid = $("#f-platform") && $("#f-platform").closest(".pub-grid");
  if (pubGrid) {
    const visibilityCount = ((info.visibility_options || []).length || 2);
    pubGrid.classList.toggle("single-type", ((info.content_types || []).length || 1) <= 1);
    pubGrid.classList.toggle("wide-visibility", !isWechatPlatform(info.key) && visibilityCount > 2);
  }
  const visibilityBox = $("#f-visibility");
  if (visibilityBox && !isWechatPlatform(info.key)) {
    const options = info.visibility_options && info.visibility_options.length
      ? info.visibility_options
      : [
          { value: 0, label: "公开" },
          { value: 1, label: "仅自己可见" },
        ];
    const values = options.map((item) => Number(item.value));
    if (!values.includes(Number(state.studio.visibility))) {
      state.studio.visibility = values[0];
    }
    const current = Number(state.studio.visibility || 0);
    visibilityBox.innerHTML = options
      .map(
        (item) =>
          `<button type="button" class="${Number(item.value) === current ? "active" : ""}" data-value="${item.value}" title="${esc(
            item.note || ""
          )}">${esc(item.label)}</button>`
      )
      .join("");
  }
  const copyButton = $("#btn-copy-platform");
  if (copyButton) {
    copyButton.hidden = info.ready || !state.studio.draftId;
  }
  // 公众号正文是富文本，工具条只在公众号下出现，选中文字时浮在光标附近。
  if (info.key !== "wechat_mp") {
    hideWechatEditor();
    toggleMdPop(false);
  }
  renderAccountChips();
}


function refreshStudioUI() {
  renderPlatformUi();
  renderBodyMode();
  renderPreview();
  renderCompliance();
  renderMediaMode();
  renderMedia();
  updateStudioMeta();
}

function setEngineBadge() {
  const badgeNode = $("#engine-badge");
  if (!badgeNode) return;
  const llm = state.settings && state.settings.llm;
  const cloud = state.cloud;
  if (state.studio.engine === "llm") {
    badgeNode.className = "engine-badge ok";
    badgeNode.textContent = "模型生成";
  } else if (state.studio.engine === "offline") {
    badgeNode.className = "engine-badge warn";
    badgeNode.textContent = "离线模板";
  } else if (!cloud) {
    badgeNode.className = "engine-badge warn";
    badgeNode.textContent = "检测中";
  } else if (!cloud.logged_in) {
    badgeNode.className = "engine-badge warn";
    badgeNode.textContent = "未登录";
  } else if (llm && llm.configured) {
    badgeNode.className = "engine-badge ok";
    badgeNode.textContent = "模型就绪";
  } else {
    badgeNode.className = "engine-badge warn";
    badgeNode.textContent = "账号不可用";
  }
}

let checkTimer = null;
function scheduleComplianceCheck() {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(async () => {
    const values = studioValues();
    if (!values.title && !values.desc) {
      state.studio.issues = [];
      renderCompliance();
      updateStudioMeta();
      return;
    }
    try {
      const result = await api("/api/copy/check", {
        method: "POST",
        body: { title: values.title, desc: values.desc, topics: values.topics },
      });
      state.studio.issues = result.issues || [];
    } catch (error) {
      /* 检查失败不打断编辑 */
    }
    renderCompliance();
    updateStudioMeta();
  }, 380);
}

/* 生成时的预览骨架；元素缺失也不能中断生成流程。 */
function showPreviewSkeleton() {
  const title = $("#pv-title");
  const body = $("#pv-body");
  if (title) title.textContent = "";
  if (body) {
    body.innerHTML =
      '<span class="skeleton skeleton-line"></span><span class="skeleton skeleton-line"></span><span class="skeleton skeleton-line w60"></span>';
  }
}

/* 失败时把原因和重试入口放在按钮下方，不能只剩一个转圈。 */
function showGenError(error) {
  const node = $("#gen-error");
  if (!node) {
    toast(error && error.message ? error.message : error, true);
    return;
  }
  node.hidden = false;
  node.innerHTML = errorHTML(error, { retryAction: "retry-generate" });
}

async function generateCopy() {
  const brief = $("#f-brief").value.trim();
  hideInline("#gen-error");
  if (!brief) {
    showInline("#gen-error", "先写一句这条笔记想讲什么，再点生成。");
    $("#f-brief").focus();
    return;
  }
  const button = $("#btn-generate");
  state.studio.generating = true;
  setButtonLoading(button, true, "生成中");
  try {
    showPreviewSkeleton();
    const data = await api("/api/copy/generate", {
      method: "POST",
      body: {
        brief,
        topic: $("#f-topic").value.trim(),
        tone: $("#f-tone").value,
        tags: $("#f-tags").checked,
        product: $("#f-product").checked,
        // 平台标识与 /api/accounts 一致，后端按平台差异化生成时使用。
        platform: state.studio.platform,
      },
    });
    $("#f-title").value = data.title || "";
    /* Markdown 模式下正文框就是源码，直接写 body_md；否则写纯文本。 */
    $("#f-desc").value = state.studio.mdMode
      ? data.body_md || bodyWithoutTags(data.desc || "")
      : bodyWithoutTags(data.desc || "");
    $("#f-topics").value = (data.topics || []).join(", ");
    state.studio.issues = data.compliance || [];
    state.studio.engine = data.engine || "";
    state.studio.bodyMd = data.body_md || "";
    state.studio.bodyHtml = data.body_html || "";
    state.studio.dirty = true;
    setEngineBadge();
    refreshStudioUI();
    if (data.llm_error) {
      toast(data.llm_error, true);
    } else if (data.engine === "llm") {
      toast("文案已生成");
    } else {
      toast("模型没有返回有效结果，已用离线模板生成", true);
    }
    if (state.studio.issues.length) toast("命中合规红线，已在右侧标出", true);
  } catch (error) {
    showGenError(error);
    renderPreview();
    maybePromptLogin(error);
  } finally {
    state.studio.generating = false;
    setButtonLoading(button, false);
    updateStudioMeta();
  }
}

function enabledAccounts() {
  return accountsForPlatform(state.studio.platform);
}

/* 新草稿默认选中第一个可用账号；用户仍然可以多选或全部取消（自动轮换）。 */
function defaultAccountIds() {
  const accounts = enabledAccounts();
  if (!accounts.length) return new Set();
  const first = accounts.find((account) => account.status !== "expired") || accounts[0];
  return new Set([first.id]);
}

function renderAccountChips() {
  const box = $("#account-chips");
  if (!box) return;
  const accounts = enabledAccounts();
  if (!accounts.length) {
    state.studio.accountIds = new Set();
    state.studio.accountId = "";
    const info = studioPlatformInfo();
    box.innerHTML = info.ready
      ? `<span class="hint">该平台还没有账号</span><button type="button" class="btn small ghost" data-action="add-account">添加账号</button>`
      : `<span class="hint">${esc(info.name)}的登录接入位已预留，先把内容存进内容库，接入后即可发布。</span>`;
    return;
  }
  const valid = new Set(accounts.map((account) => account.id));
  state.studio.accountIds = new Set(
    Array.from(state.studio.accountIds).filter((id) => valid.has(id))
  );
  if (!state.studio.accountIds.size) {
    state.studio.accountIds = defaultAccountIds();
  }
  state.studio.accountId = String(Array.from(state.studio.accountIds)[0] || "");
  box.innerHTML = accounts
    .map((account) => {
      const on = state.studio.accountIds.has(account.id);
      const expired = account.status === "expired";
      return `<button type="button" class="account-chip${on ? " on" : ""}${
        expired ? " expired" : ""
      }" data-account="${account.id}" aria-pressed="${on}">
        ${accountAvatarImage(account, "avatar xs", 24, 8) ||
        `<span class="avatar xs">${esc((account.nickname || account.name || "账").slice(0, 1))}</span>`}
        <span class="account-chip-main">
          <b>${esc(account.nickname || account.name)}</b>
          <em>今日 ${account.published_today}/${accountLimit(account)}${expired ? " · 失效" : ""}</em>
        </span>
        <span class="account-chip-check" aria-hidden="true">✓</span>
      </button>`;
    })
    .join("");
}

function fillStudio(draft) {
  state.studio.draftId = draft.id;
  state.studio.draftStatus = draft.status || "draft";
  state.studio.topicId = draft.topic_id || null;
  state.studio.platform = draft.platform || "xiaohongshu";
  state.studio.contentType = draft.content_type || defaultContentType(state.studio.platform);
  if (!contentTypesFor(state.studio.platform).some((item) => item.key === state.studio.contentType)) {
    state.studio.contentType = defaultContentType(state.studio.platform);
  }
  state.studio.images = (draft.images || []).slice();
  state.studio.contentJson =
    draft.content_json && typeof draft.content_json === "object" ? draft.content_json : {};
  /* 视频时长要等预览加载后再读，先清掉旧草稿的时长。 */
  state.studio.videoMeta = null;
  state.studio.mediaMismatch = null;
  state.studio.visibility = Number(draft.visibility || 0);
  state.studio.issues = draft.compliance || [];
  state.studio.engine = "";
  state.studio.bodyMd = draft.body_md || "";
  state.studio.bodyHtml = draft.body_html || "";
  state.studio.wxTheme = draft.wx_theme || DEFAULT_WX_THEME;
  /* 有 Markdown 原文的公众号草稿默认回到 Markdown 编辑，右侧手机预览实时排版。 */
  state.studio.mdMode =
    state.studio.platform === "wechat_mp" && Boolean(String(state.studio.bodyMd || "").trim());
  state.studio.accountId = draft.account_id ? String(draft.account_id) : "";
  state.studio.accountIds = new Set(
    draft.account_id ? [Number(draft.account_id)] : defaultAccountIds()
  );
  if (!state.studio.accountId && state.studio.accountIds.size) {
    state.studio.accountId = String(Array.from(state.studio.accountIds)[0]);
  }
  state.studio.dirty = false;
  $("#f-title").value = draft.title || "";
  $("#f-desc").value = state.studio.mdMode
    ? state.studio.bodyMd
    : bodyWithoutTags(draft.desc || "");
  $("#f-topics").value = (draft.topics || []).join(", ");
  $("#f-schedule").value = "";
  $$("#f-visibility button").forEach((button) =>
    button.classList.toggle("active", Number(button.dataset.value) === state.studio.visibility)
  );
  renderAccountChips();
  hideInline("#title-error");
  hideInline("#desc-error");
  clearErrorBox("#media-error");
  setEngineBadge();
  resetPreviewScroll();
  refreshStudioUI();
}

function resetStudio() {
  state.studio = {
    draftId: null,
    draftStatus: "draft",
    topicId: null,
    platform: "xiaohongshu",
    contentType: "image_text",
    images: [],
    contentJson: {},
    visibility: 0,
    issues: [],
    engine: "",
    bodyMd: "",
    bodyHtml: "",
    wxTheme: DEFAULT_WX_THEME,
    mdMode: false,
    accountId: "",
    accountIds: new Set(),
    dirty: false,
    generating: false,
    imageIndex: 0,
    videoMeta: null,
    mediaMismatch: null,
    cardPlan: null,
    cardPlanKey: "",
  };
  $("#f-brief").value = "";
  $("#count-brief").textContent = "0 / 500";
  $("#f-title").value = "";
  $("#f-desc").value = "";
  $("#f-topics").value = "";
  $("#f-topic").value = "";
  $("#f-schedule").value = "";
  $$("#f-visibility button").forEach((button) =>
    button.classList.toggle("active", button.dataset.value === "0")
  );
  hideInline("#gen-error");
  hideInline("#title-error");
  hideInline("#desc-error");
  clearErrorBox("#media-error");
  renderAccountChips();
  setEngineBadge();
  resetPreviewScroll();
  refreshStudioUI();
}

async function clearStudioDraft() {
  const values = studioValues();
  const brief = $("#f-brief").value.trim();
  const hasContent =
    values.title || values.desc || values.topics.length || state.studio.images.length || brief;
  if (!hasContent) {
    toast("当前草稿已经是空的");
    return;
  }
  const confirmed = await confirmDialog(
    "会清空标题、正文、话题、素材和配图，账号选择、语气等偏好会保留。确定清空吗？",
    "清空"
  );
  if (!confirmed) return;
  // 账号选择属于偏好项，清空内容后原样带回。
  const accountIds = new Set(state.studio.accountIds);
  const accountId = state.studio.accountId;
  resetStudio();
  state.studio.accountIds = accountIds;
  state.studio.accountId = accountId;
  renderAccountChips();
  refreshStudioUI();
  toast("已清空当前草稿");
}

async function openDraftInStudio(draftId) {
  try {
    const draft = await api(`/api/drafts/${draftId}`);
    fillStudio(draft);
    switchView("studio");
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (error) {
    toast(error.message, true);
  }
}

function validateStudio(requireImages) {
  const values = studioValues();
  const info = studioPlatformInfo();
  const problems = studioSpecProblems(values).filter(
    (item) => requireImages || (item.field !== "media" && item.field !== "account")
  );
  hideInline("#title-error");
  hideInline("#desc-error");
  clearErrorBox("#media-error");
  let ok = true;
  problems.forEach((item) => {
    const selector =
      item.field === "title" ? "#title-error" : item.field === "desc" ? "#desc-error" : "#media-error";
    if (!$(selector).textContent) showInline(selector, item.text);
    ok = false;
  });
  if (problems.length) {
    const field = problems[0].field;
    const input = field === "title" ? $("#f-title") : field === "desc" ? $("#f-desc") : null;
    if (input) {
      input.classList.add("invalid");
      input.focus();
    }
  }
  if (state.studio.issues.length) {
    toast("文案还有合规风险，先改掉再发布", true);
    ok = false;
  }
  if (!info.ready && requireImages) {
    toast(`${info.name}还没有接入发布，先存入内容库`, true);
    ok = false;
  }
  return ok;
}

async function persistStudio({ silent = false } = {}) {
  const values = studioValues();
  const body = {
    title: values.title,
    desc: values.desc,
    topics: values.topics,
    images: values.images,
    visibility: values.visibility,
    account_id: state.studio.accountId || null,
    topic_id: state.studio.topicId,
    body_md: values.bodyMd,
    body_html: values.bodyHtml,
    wx_theme: state.studio.wxTheme || "",
  };
  let draft;
  if (state.studio.draftId) {
    draft = await api(`/api/drafts/${state.studio.draftId}`, { method: "PATCH", body });
  } else {
    draft = await api("/api/drafts/manual", {
      method: "POST",
      body: {
        ...body,
        platform: state.studio.platform,
        content_type: state.studio.contentType,
      },
    });
  }
  state.studio.draftId = draft.id;
  state.studio.draftStatus = draft.status || state.studio.draftStatus;
  state.studio.platform = draft.platform || state.studio.platform;
  state.studio.contentType = draft.content_type || state.studio.contentType;
  state.studio.images = (draft.images || []).slice();
  state.studio.contentJson =
    draft.content_json && typeof draft.content_json === "object" ? draft.content_json : state.studio.contentJson;
  state.studio.issues = draft.compliance || [];
  state.studio.dirty = false;
  if (!silent) {
    refreshStudioUI();
    toast(`已保存草稿 #${draft.id}`);
    await refreshOverview();
  }
  return draft;
}

function targetContentType(target, explicit, preferDefault = false) {
  const info = platformInfo(target);
  if (!info) return "";
  if (explicit) return explicit;
  /* 直接切平台时落到该平台默认内容类型（抖音=视频，公众号=长文）；
     从已保存草稿复制时优先保留当前素材对应的类型。 */
  if (preferDefault || !state.studio.images.length) return defaultContentType(target);
  const current = state.studio.contentType;
  if ((info.content_types || []).some((item) => item.key === current)) return current;
  const media = studioSpec().media_type;
  const matched = (info.content_types || []).find((item) => item.media_type === media);
  return matched ? matched.key : defaultContentType(target);
}

async function copyDraftToPlatform(target, explicitContentType = "") {
  const info = platformInfo(target);
  if (!info) return;
  if (!state.studio.draftId) {
    toast("先保存当前内容，再复制到其它平台", true);
    return;
  }
  const contentType = targetContentType(target, explicitContentType);
  const spec = specOf(target, contentType);
  const samePlatform = target === state.studio.platform;
  if (samePlatform && contentType === state.studio.contentType) return;
  const values = studioValues();
  const ok = await confirmDialog(
    `将《${values.title}》复制为${info.name}的${spec.label}草稿？\n当前草稿保持不变；复制后可以按该平台的标题/正文/素材规格单独调整。`,
    samePlatform ? "另存为新内容类型" : `复制到${info.short || info.name}`
  );
  if (!ok) return;
  try {
    await persistStudio({ silent: true });
    const draft = await api("/api/drafts/manual", {
      method: "POST",
      body: {
        title: values.title,
        desc: values.desc,
        topics: values.topics,
        images: sanitizeMediaForSpec(values.images, spec, target),
        visibility: platformVisibility(target, values.visibility),
        account_id: null,
        topic_id: state.studio.topicId,
        platform: target,
        content_type: contentType,
      },
    });
    await refreshLibrary().catch(reportBackgroundError);
    await openDraftInStudio(draft.id);
    toast(`已复制为${info.name}草稿 #${draft.id}`);
  } catch (error) {
    toast(error.message, true);
  }
}

/* 切平台：同一篇草稿直接换平台，不新建副本；图片一张不丢。 */
async function switchStudioPlatform(target) {
  const info = platformInfo(target);
  if (!info) return;
  if (state.studio.draftStatus === "published") {
    toast("这篇已经发布过，不能再切平台；可以新建一篇", true);
    return;
  }
  if (state.studio.draftId) {
    const ok = await confirmDialog(
      `把这篇草稿切到${info.short || info.name}？\n不会新建草稿：标题和正文保留，${state.studio.images.length} 张图全部保留；公众号只用第 1 张做封面。`,
      `切换到${info.short || info.name}`
    );
    if (!ok) return;
    try {
      await persistStudio({ silent: true });
      await api(`/api/drafts/${state.studio.draftId}/switch-platform`, {
        method: "POST",
        body: { platform: target },
      });
      await refreshLibrary().catch(reportBackgroundError);
      await openDraftInStudio(state.studio.draftId);
      toast(`已切到${info.short || info.name}，仍是同一篇草稿`);
    } catch (error) {
      toast(error.message, true);
    }
    return;
  }
  const prevKey = state.studio.platform;
  const prevCap = mediaCapability(platformInfo(prevKey), specOf(prevKey, state.studio.contentType));
  const nextType = targetContentType(target, "", true);
  const nextSpec = specOf(target, nextType);
  state.studio.platform = target;
  state.studio.contentType = nextType;
  state.studio.visibility = platformVisibility(target, state.studio.visibility);
  state.studio.videoMeta = null;
  state.studio.accountIds = new Set();
  state.studio.accountId = "";
  state.studio.dirty = true;
  /* 公众号长文默认 Markdown；贴图是图片为主，不启用 Markdown。
     切回其它平台时把 Markdown 转成纯文本，避免预览里露出源码符号。 */
  if (target === "wechat_mp") {
    if (nextSpec.key === "image_message") {
      state.studio.mdMode = false;
    } else if (!state.studio.mdMode) {
      state.studio.bodyMd = String(state.studio.bodyMd || "").trim() || $("#f-desc").value.trim();
      state.studio.mdMode = true;
      if (state.studio.bodyMd) scheduleMarkdownRender(0);
    }
  } else if (state.studio.mdMode) {
    const source = $("#f-desc").value;
    state.studio.mdMode = false;
    if (source.trim()) {
      let plain = state.studio.bodyHtml ? htmlToPlain(state.studio.bodyHtml) : "";
      if (!plain) {
        try {
          const result = await api("/api/richtext/render", {
            method: "POST",
            body: { text: source, format: "markdown", images: [] },
          });
          plain = htmlToPlain(String(result.html || ""));
        } catch (error) {
          plain = source;
          reportBackgroundError(error);
        }
      }
      if (plain.trim()) $("#f-desc").value = bodyWithoutTags(plain);
    }
  }
  const nextCap = mediaCapability(info, nextSpec);
  /* 只提示尺寸不合，不删图：切回原平台时还能直接用。 */
  state.studio.mediaMismatch =
    state.studio.images.length && nextCap.kind !== "video" && nextCap.aspect !== prevCap.aspect
      ? { from: platformName(prevKey), aspect: prevCap.aspect }
      : null;
  refreshStudioUI();
  if (state.studio.images.length > nextSpec.max_images) {
    toast(
      target === "wechat_mp"
        ? `已切到${info.short || info.name}：${state.studio.images.length} 张图都保留，第 1 张作封面`
        : `已切到${info.short || info.name}，图片全部保留`
    );
  }
}

async function switchStudioContentType(targetType) {
  const info = studioPlatformInfo();
  if (!info || targetType === state.studio.contentType) return;
  if (state.studio.draftId) {
    if (state.studio.draftStatus === "published") {
      toast("这篇已经发布过，不能再改内容类型；可以新建一篇", true);
      return;
    }
    const label = (specOf(info.key, targetType) || {}).label || targetType;
    const ok = await confirmDialog(
      `把这篇草稿的内容类型切到「${label}」？\n不会新建草稿，标题和正文保留。`,
      "切换内容类型"
    );
    if (!ok) return;
    try {
      await persistStudio({ silent: true });
      await api(`/api/drafts/${state.studio.draftId}/switch-platform`, {
        method: "POST",
        body: { platform: info.key, content_type: targetType },
      });
      await refreshLibrary().catch(reportBackgroundError);
      await openDraftInStudio(state.studio.draftId);
      toast(`已切到「${label}」，仍是同一篇草稿`);
    } catch (error) {
      toast(error.message, true);
    }
    return;
  }
  const prevCap = mediaCapability(info, studioSpec());
  const nextSpec = specOf(info.key, targetType);
  const before = state.studio.images.length;
  state.studio.contentType = targetType;
  /* 贴图以图片为主，切过去时退出 Markdown，正文保留为纯文本。 */
  if (info.key === "wechat_mp" && nextSpec.key === "image_message" && state.studio.mdMode) {
    if (state.studio.bodyHtml) {
      $("#f-desc").value = bodyWithoutTags(htmlToPlain(state.studio.bodyHtml));
    }
    state.studio.mdMode = false;
    state.studio.bodyMd = "";
  }
  state.studio.images = sanitizeMediaForSpec(state.studio.images, nextSpec, info.key);
  state.studio.videoMeta = null;
  state.studio.dirty = true;
  const nextCap = mediaCapability(info, nextSpec);
  const trimmed = before !== state.studio.images.length;
  state.studio.mediaMismatch =
    state.studio.images.length && (trimmed || nextCap.aspect !== prevCap.aspect)
      ? { from: info.name, aspect: prevCap.aspect }
      : null;
  refreshStudioUI();
  if (trimmed) {
    toast(`已切到${nextSpec.label}，素材按新规格调整`);
  }
}

async function saveStudio() {
  hideInline("#title-error");
  hideInline("#desc-error");
  if (!validateStudio(false)) return;
  const button = $("#btn-save");
  setButtonLoading(button, true, "保存中");
  try {
    await persistStudio();
  } catch (error) {
    toast(error.message, true);
  } finally {
    setButtonLoading(button, false);
  }
}

/* ------------------------------------------------------------ 预览里直接编辑 */

function syncWechatPreview() {
  const body = $("#pv-wx-body");
  const title = $("#pv-wx-title");
  if (body) {
    state.studio.bodyHtml = body.innerHTML;
    /* Markdown 模式下正文框是唯一数据源，预览只读，回写时不能把它清掉。 */
    if (!state.studio.mdMode) {
      state.studio.bodyMd = "";
      $("#f-desc").value = bodyWithoutTags(htmlToPlain(body.innerHTML));
    }
  }
  if (title) {
    const text = title.textContent.replace(/\s+/g, " ").trim();
    if ($("#f-title").value !== text) $("#f-title").value = text;
  }
  state.studio.dirty = true;
  updateStudioMeta();
  scheduleComplianceCheck();
}

function syncTextPreview(field) {
  const node = field === "title" ? $("#pv-title") : $("#pv-body");
  if (!node) return;
  if (field === "title") {
    $("#f-title").value = node.textContent.replace(/\s+/g, " ").trim();
  } else {
    $("#f-desc").value = bodyWithoutTags(node.innerText.replace(/\u00a0/g, " "));
  }
  if (state.studio.platform !== "wechat_mp") {
    state.studio.bodyMd = "";
    state.studio.bodyHtml = "";
  }
  state.studio.dirty = true;
  updateStudioMeta();
  scheduleComplianceCheck();
}

function bindPreviewEditing() {
  const wxTitle = $("#pv-wx-title");
  [wxTitle, $("#pv-title")].forEach((node) => {
    if (!node) return;
    node.addEventListener("keydown", (event) => {
      if (event.key === "Enter") event.preventDefault();
    });
  });
  const wxBody = $("#pv-wx-body");
  if (wxTitle) {
    wxTitle.addEventListener("input", () => {
      if (state.studio.platform === "wechat_mp") syncWechatPreview();
    });
  }
  if (wxBody) {
    wxBody.addEventListener("focus", () => {
      if (wxBody.querySelector("p.placeholder")) wxBody.innerHTML = "";
    });
    wxBody.addEventListener("input", () => {
      if (state.studio.platform === "wechat_mp") syncWechatPreview();
    });
    wxBody.addEventListener("paste", (event) => {
      if (state.studio.platform !== "wechat_mp") return;
      const html = event.clipboardData && event.clipboardData.getData("text/html");
      if (!html) return;
      event.preventDefault();
      document.execCommand("insertHTML", false, html);
      syncWechatPreview();
    });
    document.addEventListener("selectionchange", updateWechatEditorPlacement);
  }
  const editBar = $("#wx-edit-bar");
  if (editBar) {
    // 按下工具条时不抢焦点，否则选区会消失。
    editBar.addEventListener("mousedown", (event) => event.preventDefault());
  }
  document.addEventListener("mousedown", (event) => {
    const bar = $("#wx-edit-bar");
    const pop = $("#md-pop");
    const body = $("#pv-wx-body");
    const themePop = $("#wx-theme-pop");
    const themeBtn = $("#btn-wx-theme");
    /* 排版主题也可以从正文头部打开，这时工具条是隐藏的，单独处理点击外部关闭。 */
    if (
      themePop &&
      !themePop.hidden &&
      !themePop.contains(event.target) &&
      !(themeBtn && themeBtn.contains(event.target))
    ) {
      toggleThemePop(false);
    }
    if (!bar || bar.hidden) return;
    if (bar.contains(event.target)) return;
    if (pop && pop.contains(event.target)) return;
    if (themePop && themePop.contains(event.target)) return;
    if (body && body.contains(event.target)) return;
    hideWechatEditor();
  });
  document.addEventListener(
    "scroll",
    (event) => {
      /* 主题面板自己滚动时不能把面板关掉，否则滚轮一用就消失。 */
      const target = event.target;
      if (target && target.nodeType === 1 && target.closest("#wx-theme-pop")) return;
      hideWechatEditor();
    },
    true
  );
  [["#pv-title", "title"], ["#pv-body", "desc"]].forEach(([selector, field]) => {
    const node = $(selector);
    if (!node) return;
    node.addEventListener("input", () => {
      if (state.studio.platform === "wechat_mp") return;
      syncTextPreview(field);
    });
  });
  const caption = $("#pv-dy-caption");
  if (caption) {
    caption.addEventListener("focusin", () => {
      caption.classList.add("expanded");
      const expand = $("#pv-dy-expand");
      if (expand && !expand.hidden) expand.textContent = "收起";
    });
    caption.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && event.target.dataset.field === "title") {
        event.preventDefault();
      }
    });
    caption.addEventListener("input", (event) => {
      const field = event.target.closest("[data-field]");
      if (!field) return;
      const text = field.innerText.replace(/\u00a0/g, " ");
      if (field.dataset.field === "title") {
        $("#f-title").value = text.replace(/\s+/g, " ").trim();
      } else {
        $("#f-desc").value = bodyWithoutTags(text);
      }
      state.studio.dirty = true;
      updateStudioMeta();
      scheduleComplianceCheck();
    });
  }
  const dyExpand = $("#pv-dy-expand");
  if (dyExpand) {
    dyExpand.addEventListener("click", () => {
      const node = $("#pv-dy-caption");
      if (!node) return;
      const open = node.classList.toggle("expanded");
      dyExpand.textContent = open ? "收起" : "展开";
    });
  }
}

/* 公众号正文工具条：命令都作用在预览里的 contenteditable 上。 */
let wxSavedRange = null;

const WX_THEMES = [
  { key: "huasheng", name: "默认公众号", accent: "#3498db" },
  { key: "latepost", name: "晚点风格", accent: "#d32f2f" },
  { key: "ft", name: "金融时报", accent: "#990f3d" },
  { key: "claude", name: "Claude", accent: "#c15f3c" },
  { key: "tech", name: "技术风格", accent: "#0066cc" },
];

let WX_THEME_OPTIONS = null;

function wechatThemeOptions() {
  return WX_THEME_OPTIONS && WX_THEME_OPTIONS.length ? WX_THEME_OPTIONS : WX_THEMES;
}

function renderThemeList() {
  const list = $("#theme-list");
  if (!list) return;
  const current = String(state.studio.wxTheme || "");
  let html = "";
  let group = "";
  wechatThemeOptions().forEach((theme) => {
    if (theme.group && theme.group !== group) {
      group = theme.group;
      html += `<p class="theme-group">${esc(group)}</p>`;
    }
    html += `<button type="button" class="${theme.key === current ? "on" : ""}" title="${esc(
      theme.name
    )}" data-theme="${esc(theme.key)}"><span class="theme-dot" style="background:${esc(
      theme.accent
    )}"></span><span class="theme-name">${esc(theme.name)}</span></button>`;
  });
  list.innerHTML = html;
}

async function loadWechatThemes() {
  if (WX_THEME_OPTIONS) return;
  try {
    const items = await api("/api/richtext/themes");
    if (Array.isArray(items) && items.length) {
      WX_THEME_OPTIONS = items;
      renderThemeList();
    }
  } catch (error) {
    reportBackgroundError(error);
  }
}

function showWechatEditor() {
  const bar = $("#wx-edit-bar");
  const body = $("#pv-wx-body");
  if (!bar || !body || state.studio.platform !== "wechat_mp") return;
  if (body.getAttribute("contenteditable") === "false") return;
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return;
  /* 只有真的选中了一段内容才出工具条；点一下光标就弹框会挡住正文。 */
  if (selection.isCollapsed) {
    hideWechatEditor();
    return;
  }
  const range = selection.getRangeAt(0);
  if (!body.contains(range.commonAncestorContainer)) return;
  const rects = range.getClientRects();
  const rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) return;
  const screen = body.closest(".phone-screen");
  const bounds = screen ? screen.getBoundingClientRect() : { left: 0, right: window.innerWidth, width: window.innerWidth };
  bar.hidden = false;
  /* 工具条以手机屏为界：窄屏时缩到屏内并允许横向滑动，绝不越过屏幕左边缘。 */
  const maxWidth = Math.max(160, Math.min(bounds.width - 12, window.innerWidth - 16));
  bar.style.maxWidth = `${Math.round(maxWidth)}px`;
  const barRect = bar.getBoundingClientRect();
  const minLeft = bounds.left + 6;
  const maxLeft = Math.max(minLeft, bounds.right - barRect.width - 6);
  const left = Math.min(Math.max(minLeft, rect.left + rect.width / 2 - barRect.width / 2), maxLeft);
  let top = rect.top - barRect.height - 10;
  if (top < 8) top = rect.bottom + 10;
  bar.style.left = `${Math.round(left)}px`;
  bar.style.top = `${Math.round(Math.min(top, window.innerHeight - barRect.height - 8))}px`;
}

function hideWechatEditor() {
  const bar = $("#wx-edit-bar");
  if (bar && !bar.hidden) bar.hidden = true;
  toggleMdPop(false);
  toggleThemePop(false);
}

function updateWechatEditorPlacement() {
  const body = $("#pv-wx-body");
  const selection = window.getSelection();
  if (!body || !selection || !selection.rangeCount) {
    hideWechatEditor();
    return;
  }
  const range = selection.getRangeAt(0);
  if (!body.contains(range.commonAncestorContainer)) {
    const active = document.activeElement;
    const bar = $("#wx-edit-bar");
    const pop = $("#md-pop");
    const themePop = $("#wx-theme-pop");
    if (
      (bar && bar.contains(active)) ||
      (pop && pop.contains(active)) ||
      (themePop && themePop.contains(active))
    ) {
      return;
    }
    hideWechatEditor();
    return;
  }
  wxSavedRange = range.cloneRange();
  if (selection.isCollapsed) {
    hideWechatEditor();
    return;
  }
  showWechatEditor();
}

function restoreWechatSelection() {
  const body = $("#pv-wx-body");
  if (!body) return;
  body.focus();
  const selection = window.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  if (wxSavedRange && body.contains(wxSavedRange.commonAncestorContainer)) {
    selection.addRange(wxSavedRange);
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(body);
  range.collapse(false);
  selection.addRange(range);
}

function insertWechatHtml(html) {
  const body = $("#pv-wx-body");
  if (!body || !html) return;
  restoreWechatSelection();
  document.execCommand("insertHTML", false, html);
  syncWechatPreview();
}

function videoPlaceholderHtml() {
  return (
    '<section style="margin:16px 0;padding:14px 16px;background:#f5f6f7;border-radius:8px;">' +
    '<p style="margin:0 0 6px;font-weight:600;color:#111;">▶ 视频占位</p>' +
    '<p style="margin:0;font-size:14px;line-height:1.7;color:#57606a;">在这里说明视频内容；' +
    "发布到公众号后请替换成视频卡片或链接。</p></section><p><br/></p>"
  );
}

function handleWechatCommand(cmd) {
  const body = $("#pv-wx-body");
  if (!body) return;
  if (cmd === "image") {
    $("#wx-inline-upload").click();
    return;
  }
  if (cmd === "md") {
    toggleMdPop();
    return;
  }
  if (cmd === "art") {
    generateInlineArt();
    return;
  }
  if (cmd === "theme") {
    toggleThemePop();
    return;
  }
  if (cmd === "video") {
    insertWechatHtml(videoPlaceholderHtml());
    return;
  }
  restoreWechatSelection();
  if (cmd === "bold") document.execCommand("bold");
  else if (cmd === "h2") document.execCommand("formatBlock", false, "h2");
  else if (cmd === "quote") document.execCommand("formatBlock", false, "blockquote");
  else if (cmd === "ul") document.execCommand("insertUnorderedList");
  else if (cmd === "hr") document.execCommand("insertHorizontalRule");
  syncWechatPreview();
}

function toggleMdPop(force) {
  const pop = $("#md-pop");
  if (!pop) return;
  const show = force === undefined ? pop.hidden : Boolean(force);
  pop.hidden = !show;
  if (!show) return;
  toggleThemePop(false);
  const bar = $("#wx-edit-bar");
  const barRect = bar && !bar.hidden ? bar.getBoundingClientRect() : null;
  const width = Math.min(320, window.innerWidth - 24);
  pop.style.left = `${Math.round(Math.max(12, Math.min((barRect ? barRect.left : window.innerWidth - width - 12), window.innerWidth - width - 12)))}px`;
  pop.style.top = `${Math.round(barRect ? barRect.bottom + 8 : 80)}px`;
  $("#md-pop-text").focus();
}

function toggleThemePop(force, anchor) {
  const pop = $("#wx-theme-pop");
  if (!pop) return;
  const show = force === undefined ? pop.hidden : Boolean(force);
  pop.hidden = !show;
  if (!show) return;
  toggleMdPop(false);
  const bar = $("#wx-edit-bar");
  const barRect =
    anchor && anchor.getBoundingClientRect
      ? anchor.getBoundingClientRect()
      : bar && !bar.hidden
      ? bar.getBoundingClientRect()
      : null;
  const width = Math.min(320, window.innerWidth - 24);
  const left = Math.max(12, Math.min(barRect ? barRect.left : window.innerWidth - width - 12, window.innerWidth - width - 12));
  const top = barRect ? Math.min(barRect.bottom + 8, window.innerHeight - 120) : 80;
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(Math.max(12, top))}px`;
  const list = $("#theme-list");
  if (list) {
    renderThemeList();
    loadWechatThemes();
  }
}

function applyWechatTheme(themeKey) {
  /* 主题只是正文的显示设置：存在草稿上，预览和发布时套用，不改写正文内容。
     正文为空时也允许先选主题，等写完内容直接生效。 */
  state.studio.wxTheme = themeKey || "";
  wxThemeCache = { sig: "", html: "", pending: "" };
  state.studio.dirty = true;
  toggleThemePop(false);
  renderPreview();
  updateStudioMeta();
  const name = (wechatThemeOptions().find((item) => item.key === themeKey) || {}).name || themeKey;
  toast(`预览和发布将使用「${name}」排版`);
}

function insertExtraImagesToBody() {
  if (state.studio.platform !== "wechat_mp") {
    toast("先切到公众号，再把其余图片补进正文", true);
    return;
  }
  /* 封面（2.35:1 长图）本身就是正文可用的插图，一起参与插入。 */
  const images = state.studio.images.filter(Boolean);
  const square = String((state.studio.contentJson || {}).wechat_square || "");
  if (square && !images.includes(square)) images.push(square);
  if (!images.length) {
    toast("没有可插入的图片", true);
    return;
  }
  const values = studioValues();
  const current =
    String(state.studio.bodyHtml || "").trim() ||
    values.desc
      .split(/\n+/)
      .map((line) => `<p>${esc(line.trim())}</p>`)
      .join("");
  const extras = images.filter((path) => {
    const url = mediaUrl(path);
    return url && !current.includes(url) && !current.includes(path);
  });
  if (!extras.length) {
    toast("这些图片已经在正文里了");
    return;
  }
  const addition = extras
    .map(
      (path) =>
        `<p style="margin:20px 0;text-align:center;"><img src="${esc(
          mediaUrl(path)
        )}" alt="配图"/></p>`
    )
    .join("");
  state.studio.bodyHtml = `${current}${addition}`;
  state.studio.bodyMd = "";
  state.studio.dirty = true;
  renderPreview();
  updateStudioMeta();
  renderMedia();
  toast(`已把 ${extras.length} 张图补进正文`);
}

async function generateInlineArt() {
  const cap = mediaCapability();
  if (cap.kind === "video") {
    toast("视频内容不生成插画，先切换到图文", true);
    return;
  }
  const values = studioValues();
  if (!values.title && !values.desc) {
    toast("先写点内容，再生成插画", true);
    return;
  }
  const style = /^art-/.test(state.cardStyle) ? state.cardStyle : "art-chalk";
  const button = $('.wx-edit-tools [data-wx-cmd="art"]');
  if (button) button.disabled = true;
  try {
    if (!state.studio.draftId) await persistStudio({ silent: true });
    const result = await api(`/api/drafts/${state.studio.draftId}/artwork-inline`, {
      method: "POST",
      body: { style, platform: studioPlatformInfo().key },
    });
    const paths = (result.paths || []).map((path) => mediaUrl(path));
    if (!paths.length) throw new Error("插画没有生成成功，请重试");
    insertWechatHtml(
      paths
        .map(
          (src) =>
            `<p style="margin:22px 0;text-align:center;"><img src="${esc(
              src
            )}" alt="正文插画" style="max-width:100%;"/></p>`
        )
        .join("")
    );
    toast("插画已插入正文");
  } catch (error) {
    toast(error.message, true);
  } finally {
    if (button) button.disabled = false;
  }
}

async function uploadWechatInlineImages(files) {
  const list = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
  if (!list.length) {
    toast("请选择图片文件", true);
    return;
  }
  const form = new FormData();
  list.slice(0, 6).forEach((file) => form.append("files", file));
  try {
    const data = await api("/api/uploads", { method: "POST", body: form });
    const paths = (data.paths || []).map((path) => mediaUrl(path));
    if (!paths.length) return;
    insertWechatHtml(paths.map((src) => `<p><img src="${esc(src)}" alt="正文配图"/></p>`).join(""));
    toast(`已插入 ${paths.length} 张正文图片`);
  } catch (error) {
    toast(error.message, true);
  } finally {
    $("#wx-inline-upload").value = "";
  }
}

async function insertMarkdownFromPop() {
  const text = $("#md-pop-text").value.trim();
  if (!text) {
    toast("先粘贴 Markdown 或 HTML", true);
    return;
  }
  const button = $("#md-pop-insert");
  setButtonLoading(button, true, "转换中");
  try {
    const result = await api("/api/richtext/render", {
      method: "POST",
      body: {
        text,
        format: $("#md-pop-format").value,
        images: studioValues().images.map((path) => mediaUrl(path)),
      },
    });
    insertWechatHtml(result.html || "");
    $("#md-pop-text").value = "";
    toggleMdPop(false);
    toast("已插入正文");
  } catch (error) {
    toast(error.message, true);
  } finally {
    setButtonLoading(button, false);
  }
}

/* ------------------------------------------------------------ Markdown 编辑 */
/* 正文有两种写法：纯文本（小红书 / 抖音）与 Markdown（公众号）。Markdown 模式下
   左侧是源码，右侧手机预览实时渲染并套用排版主题；发布时同样按主题输出。 */

let mdRenderTimer = 0;
let mdRenderToken = 0;

function renderBodyMode() {
  const field = $("#f-desc");
  if (!field) return;
  const md = Boolean(state.studio.mdMode);
  const toggle = $("#body-format");
  if (toggle) {
    $$("[data-body-format]", toggle).forEach((button) =>
      button.classList.toggle("active", (button.dataset.bodyFormat === "markdown") === md)
    );
  }
  field.placeholder = md
    ? "用 Markdown 写正文：# 小标题、**加粗**、> 引用、- 列表、![图](/uploads/x.png)"
    : "写清楚场景、动作和结果。结尾别喊口号。";
  const hint = $("#body-mode-hint");
  if (hint) hint.hidden = !md;
  const label = $('label[for="f-desc"]');
  if (label) label.textContent = md ? "正文 · Markdown" : "正文";
  /* Markdown 模式下预览是只读的，避免两处同时编辑打架。 */
  const body = $("#pv-wx-body");
  if (body) body.setAttribute("contenteditable", md ? "false" : "true");
}

function scheduleMarkdownRender(delay = 350) {
  window.clearTimeout(mdRenderTimer);
  const token = ++mdRenderToken;
  mdRenderTimer = window.setTimeout(async () => {
    const text = $("#f-desc").value;
    try {
      const result = await api("/api/richtext/render", {
        method: "POST",
        body: {
          text,
          format: "markdown",
          images: studioValues().images.map((path) => mediaUrl(path)),
        },
      });
      if (token !== mdRenderToken) return;
      state.studio.bodyMd = text;
      state.studio.bodyHtml = String(result.html || "");
      wxThemeCache = { sig: "", html: "", pending: "" };
      renderPreview();
    } catch (error) {
      reportBackgroundError(error);
    }
  }, delay);
}

/* 纯文本转 Markdown：保留空行分段，单换行的每一行也各自成段；
   连续列表行保持紧凑，避免转过去整段挤成一坨。 */
function plainTextToMarkdown(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
      if (!lines.length) return "";
      const isList = lines.every((line) => /^([-*+]|\d+[.)])\s+/.test(line));
      return isList ? lines.join("\n") : lines.join("\n\n");
    })
    .filter(Boolean)
    .join("\n\n");
}

async function switchBodyFormat(mode) {
  const target = mode === "markdown";
  if (target === Boolean(state.studio.mdMode)) return;
  const field = $("#f-desc");
  const values = studioValues();
  if (target) {
    let markdown = String(state.studio.bodyMd || "").trim();
    if (!markdown) {
      const html = String(state.studio.bodyHtml || "").trim();
      if (html) {
        try {
          const result = await api("/api/richtext/render", {
            method: "POST",
            body: { text: html, format: "to_markdown" },
          });
          markdown = String(result.markdown || "");
        } catch (error) {
          markdown = "";
        }
      }
      if (!markdown) markdown = plainTextToMarkdown(values.desc);
    }
    state.studio.mdMode = true;
    state.studio.bodyMd = markdown;
    field.value = markdown;
    renderBodyMode();
    if (markdown) scheduleMarkdownRender(0);
  } else {
    const html = String(state.studio.bodyHtml || "").trim();
    const plain = html ? htmlToPlain(html) : values.desc;
    state.studio.mdMode = false;
    state.studio.bodyMd = "";
    field.value = bodyWithoutTags(plain);
    state.studio.dirty = true;
    renderBodyMode();
  }
  refreshStudioUI();
}

/* ------------------------------------------------------------ 平台切换 */
/* 一个内容只保留一篇草稿：切平台在原草稿上完成，不新建副本。 */

async function switchDraftCardPlatform(draft) {
  const target = draft.platform === "wechat_mp" ? "xiaohongshu" : "wechat_mp";
  const label = platformName(target);
  const ok = await confirmDialog(
    `把《${draft.title || `#${draft.id}`}》切到${label}？\n不会新建草稿：标题和正文保留，图片全部保留；公众号只用第 1 张做封面。`,
    `切换到${label}`
  );
  if (!ok) return;
  try {
    await api(`/api/drafts/${draft.id}/switch-platform`, {
      method: "POST",
      body: { platform: target },
    });
    await refreshLibrary().catch(reportBackgroundError);
    await openDraftInStudio(draft.id);
    toast(`已切到${label}，仍是草稿 #${draft.id}`);
  } catch (error) {
    toast(error.message, true);
  }
}

function selectedTargets() {
  return Array.from(state.studio.accountIds)
    .map(Number)
    .filter((id) => state.accounts.some((account) => account.id === id && account.enabled));
}

async function publishStudio(mode = "queue") {
  if (state.studio.draftStatus === "published") {
    toast("这篇已经发布过，不能重复操作", true);
    return;
  }
  if (!validateStudio(true)) return;
  const wechat = platformActionMode() === "wechat";
  const action = wechat ? (mode === "draft" ? "draft" : "publish") : "queue";
  const visibility = wechat ? (action === "draft" ? 1 : 0) : Number(state.studio.visibility || 0);
  const values = studioValues();
  const spec = studioSpec();
  const targets = selectedTargets();
  const targetLabel = targets.length
    ? targets
        .map((id) => state.accounts.find((item) => item.id === id))
        .filter(Boolean)
        .map((item) => item.nickname || item.name)
        .join("、")
    : "自动轮换";
  const time = $("#f-schedule").value;
  const mediaLabel = spec.media_type === "video" ? "视频 1 个" : `图片 ${values.images.length} 张`;
  const visibilityLabel = (() => {
    const options = studioPlatformInfo().visibility_options || [];
    const found = options.find((item) => Number(item.value) === visibility);
    return found ? found.label : visibility === 0 ? "公开" : "仅自己可见";
  })();
  const confirmText = wechat
    ? action === "draft"
      ? `把《${values.title}》保存到公众号草稿箱？\n账号：${targetLabel}\n封面：${values.images.length} 张\n草稿不会推送给关注者，之后可以再到公众号后台发布。${
          time ? `\n预约时间：${time.replace("T", " ")}` : ""
        }`
      : `把《${values.title}》立即发布到公众号？\n账号：${targetLabel}\n封面：${values.images.length} 张\n发布后会推送给全部关注者，每天只有 1 次机会。${
          time ? `\n预约时间：${time.replace("T", " ")}` : ""
        }`
    : `发布《${values.title}》\n平台：${studioPlatformInfo().name} · ${spec.label}\n账号：${targetLabel}\n可见范围：${visibilityLabel}\n素材：${mediaLabel}${
        time ? `\n预约时间：${time.replace("T", " ")}` : ""
      }`;
  const ok = await confirmDialog(
    confirmText,
    wechat ? (action === "draft" ? "保存草稿" : "立即发布") : "确认加入队列"
  );
  if (!ok) return;
  const button =
    wechat && action === "draft"
      ? $("#btn-save-platform-draft")
      : wechat
      ? $("#btn-publish-now")
      : $("#btn-publish");
  setButtonLoading(button, true, "提交中");
  try {
    state.studio.visibility = visibility;
    const draft = await persistStudio({ silent: true });
    if (draft.status === "published") {
      throw new Error("这篇已经发布过，不能重复操作");
    }
    await api("/api/jobs", {
      method: "POST",
      body: {
        draft_ids: [draft.id],
        account_id: targets.length === 1 ? targets[0] : null,
        account_ids: targets.length > 1 ? targets : [],
        scheduled_at: time ? time.replace("T", " ") : 0,
      },
    });
    toast(
      wechat
        ? action === "draft"
          ? "已保存到公众号草稿箱（未推送）"
          : "公众号已进入发布队列"
        : targets.length > 1
        ? `已分发到 ${targets.length} 个账号`
        : "已加入发布队列"
    );
    state.studio.draftStatus = "queued";
    refreshStudioUI();
    await refreshOverview();
    if (state.view === "library") await refreshLibrary();
    switchView("library");
  } catch (error) {
    toast(error.message, true);
  } finally {
    setButtonLoading(button, false);
  }
}

let cardPlanTimer = null;
let cardPlanSeq = 0;

/* 配图张数必须跟设计页数一致：先问后端这套内容排成几页，再决定传不传 limit。 */
function cardPlanKeyOf(values, info, spec) {
  return [info.key, spec.key, state.cardStyle, values.title, values.desc].join("\u0000");
}

function scheduleCardPlan() {
  clearTimeout(cardPlanTimer);
  cardPlanTimer = setTimeout(() => {
    loadCardPlan().catch(() => {});
  }, 450);
}

async function loadCardPlan(force = false) {
  const hint = $("#card-plan-hint");
  if (!hint) return null;
  const info = studioPlatformInfo();
  const spec = studioSpec();
  if (spec.media_type === "video") {
    state.cardPlan = null;
    state.cardPlanKey = "";
    hint.textContent = "视频内容不生成配图";
    hint.classList.remove("warn");
    return null;
  }
  const values = studioValues();
  if (!values.title && !values.desc) {
    state.cardPlan = null;
    state.cardPlanKey = "";
    hint.textContent = "写完标题和正文后，这里会显示要生成几张";
    hint.classList.remove("warn");
    return null;
  }
  const key = cardPlanKeyOf(values, info, spec);
  if (!force && key === state.cardPlanKey && state.cardPlan) return state.cardPlan;
  const seq = ++cardPlanSeq;
  try {
    const plan = await api("/api/design/plan", {
      method: "POST",
      body: {
        platform: info.key,
        content_type: spec.key,
        title: values.title,
        desc: values.desc,
        style: state.cardStyle,
      },
    });
    if (seq !== cardPlanSeq) return state.cardPlan;
    state.cardPlan = plan;
    state.cardPlanKey = key;
    renderCardPlanHint();
    return plan;
  } catch (error) {
    if (seq === cardPlanSeq) {
      state.cardPlan = null;
      state.cardPlanKey = "";
      hint.textContent = "";
      hint.classList.remove("warn");
    }
    return null;
  }
}

function renderCardPlanHint() {
  const hint = $("#card-plan-hint");
  if (!hint) return;
  const plan = state.cardPlan;
  if (!plan || !plan.pages) {
    hint.textContent = "";
    hint.classList.remove("warn");
    return;
  }
  const pages = Number(plan.pages) || 0;
  const max = Number(plan.max_images) || pages;
  if (plan.art) {
    hint.textContent = "手绘插画固定出 1 张，本机渲染，同一版内容可复现";
    hint.classList.remove("warn");
    return;
  }
  if (pages > max) {
    hint.textContent = `共 ${pages} 页，超过平台上限 ${max} 张，只生成前 ${max} 张`;
    hint.classList.add("warn");
  } else {
    hint.textContent = `共 ${pages} 页，将生成 ${pages} 张配图`;
    hint.classList.remove("warn");
  }
}

async function generateCards() {
  clearErrorBox("#media-error");
  const values = studioValues();
  const cap = mediaCapability();
  if (cap.kind === "video") {
    toast("视频内容不生成图文配图，先切到「图文」再试", true);
    return;
  }
  if (!values.title || !values.desc) {
    toast("先有标题和正文，再生成配图", true);
    return;
  }
  const button = $("#btn-cards-free");
  setButtonLoading(button, true, "生成中");
  try {
    if (!state.studio.draftId) {
      await persistStudio({ silent: true });
    }
    const styleValue = state.cardStyle || (state.designStyles[0] && state.designStyles[0].key) || "";
    if (!styleValue) throw new Error("还没有可用的免费模板");
    const plan = await loadCardPlan(true);
    const pages = plan ? Number(plan.pages) || 0 : 0;
    const max = plan ? Number(plan.max_images) || pages : cap.max || 0;
    const expected = plan && plan.art ? 1 : pages ? Math.min(pages, max) : cap.count;
    const body = { style: styleValue };
    /* 页数没超上限就不传 limit，让后端按实际页数全出；超了才显式截断。 */
    if (pages && max && pages > max) body.limit = max;
    const draft = await api(`/api/drafts/${state.studio.draftId}/design-cards`, {
      method: "POST",
      body,
    });
    state.studio.images = (draft.images || []).slice();
    state.studio.contentJson =
      draft.content_json && typeof draft.content_json === "object" ? draft.content_json : state.studio.contentJson;
    state.studio.mediaMismatch = null;
    state.studio.dirty = false;
    refreshStudioUI();
    const got = state.studio.images.length;
    if (pages && got !== expected) {
      const message = `${platformName() || "当前平台"}：预览 ${pages} 页，上限 ${max}，期望 ${expected} 张，实际 ${got} 张`;
      console.warn(`[配图数量不一致] ${message}`);
      const hint = $("#card-plan-hint");
      if (hint) {
        hint.textContent = `页数与张数不一致：预览 ${pages} 页，实际生成 ${got} 张`;
        hint.classList.add("warn");
      }
    } else {
      renderCardPlanHint();
    }
    toast(
      cap.kind === "cover"
        ? "已生成 1 张封面"
        : pages && pages > max
        ? `共 ${pages} 页，超过上限，只生成前 ${max} 张`
        : `已生成 ${got} 张配图`
    );
    await refreshOverview();
  } catch (error) {
    showErrorBox("#media-error", error);
  } finally {
    setButtonLoading(button, false);
  }
}

async function generateMotion() {
  clearErrorBox("#media-error");
  const values = studioValues();
  if (!values.title || !values.desc) {
    toast("先有标题和正文，再生成动图", true);
    return;
  }
  if (!state.studio.draftId) {
    await persistStudio({ silent: true });
  }
  const button = $("#btn-motion");
  setButtonLoading(button, true, "生成中");
  try {
    const result = await api(`/api/drafts/${state.studio.draftId}/motion`, {
      method: "POST",
      body: {},
    });
    const motion = (result && result.motion) || result;
    if (!motion || !motion.gif) throw new Error("没有生成动图");
    const gifLink = $("#motion-gif");
    const mp4Link = $("#motion-mp4");
    if (gifLink) gifLink.href = mediaUrl(motion.gif);
    if (mp4Link && motion.mp4) mp4Link.href = mediaUrl(motion.mp4);
    const box = $("#motion-result");
    if (box) box.hidden = false;
    toast("6 秒动图已生成，点下方链接查看");
  } catch (error) {
    showErrorBox("#media-error", error);
  } finally {
    setButtonLoading(button, false);
  }
}

async function generatePaidCards() {
  hideInline("#paid-error");
  const paid = paidOptions();
  if (!paid.configured) {
    if (!maybePromptLogin({ message: paid.reason || "" })) {
      toast(paid.reason || "付费出图暂不可用", true);
    }
    return;
  }
  const values = studioValues();
  if (!values.title || !values.desc) {
    toast("先有标题和正文，再生成配图", true);
    return;
  }
  const count = paid.count || 3;
  const unit = Number(paid.unit_price || 0.18);
  const total = (unit * count).toFixed(2);
  const styleKey = $("#f-paid-style").value || (paid.styles && paid.styles[0] && paid.styles[0].key) || "";
  const layoutKey = $("#f-paid-layout").value || "balanced";
  const paletteKey = $("#f-paid-palette").value || "";
  const styleItem = (paid.styles || []).find((item) => item.key === styleKey);
  const layoutItem = (paid.layouts || []).find((item) => item.key === layoutKey);
  const paletteItem = (paid.palettes || []).find((item) => item.key === paletteKey);
  const ok = await confirmDialog(
    `付费出图会按张计费。\n模型：${paid.model || "qwen-image-3.0"}\n风格：${
      styleItem ? styleItem.label : styleKey
    }\n版式：${layoutItem ? layoutItem.label : layoutKey}\n配色：${
      paletteItem ? paletteItem.label : "跟随风格"
    }\n数量：${count} 张\n单张：¥${unit}\n预计费用：¥${total}\n\n确认后才会调用付费接口。`,
    `确认支付 ¥${total}`
  );
  if (!ok) return;

  const button = $("#btn-cards-paid");
  setButtonLoading(button, true, "生成中");
  try {
    if (!state.studio.draftId) {
      await persistStudio({ silent: true });
    }
    const draft = await api(`/api/drafts/${state.studio.draftId}/paid-cards`, {
      method: "POST",
      body: { style: styleKey, layout: layoutKey, palette: paletteKey },
    });
    state.studio.images = (draft.images || []).slice();
    state.studio.dirty = false;
    refreshStudioUI();
    toast(`已生成 ${state.studio.images.length} 张付费配图（约 ¥${total}）`);
    await refreshOverview();
  } catch (error) {
    showInline("#paid-error", error.message);
    maybePromptLogin(error);
  } finally {
    setButtonLoading(button, false);
  }
}

function switchMediaTab(tab) {
  state.mediaTab = tab === "paid" ? "paid" : "free";
  $$(".media-tab").forEach((button) => {
    const on = button.dataset.tab === state.mediaTab;
    button.classList.toggle("active", on);
    button.setAttribute("aria-selected", on ? "true" : "false");
  });
  const free = $("#panel-free");
  const paid = $("#panel-paid");
  if (free) free.hidden = state.mediaTab !== "free";
  if (paid) paid.hidden = state.mediaTab !== "paid";
}

function paidOptions() {
  return state.cardOptions.paid || {};
}

function renderPaidPanel() {
  const paid = paidOptions();
  const count = paid.count || 3;
  const unit = Number(paid.unit_price || 0.18);
  const modelLine = $("#paid-model-line");
  if (modelLine) {
    modelLine.textContent = `${paid.model || "qwen-image-3.0"} · ${paid.size || "1k"} · 约 ¥${unit}/张`;
  }
  const cost = $("#paid-cost");
  if (cost) {
    cost.innerHTML = `
      <div><span>本次生成</span><b>${count} 张</b></div>
      <div><span>单张价格</span><b>¥${unit}</b></div>
      <div class="cost-total"><span>预计费用</span><b>¥${(unit * count).toFixed(2)}</b></div>`;
  }
  const button = $("#btn-cards-paid");
  const note = $("#paid-note");
  const problem =
    state.paidError || (paid.configured ? "" : paid.reason || "付费出图暂不可用。");
  if (button) {
    button.disabled = Boolean(problem);
    button.textContent = problem
      ? "暂时不可用"
      : `付费生成 ${count} 张`;
  }
  if (note) {
    note.classList.toggle("warn", Boolean(problem));
    note.textContent = problem || "按次计费，确认后才会调用付费接口；不点不产生费用。";
  }
}

function probeVideo(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    const finish = (value) => {
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(() => finish({ duration: 0 }), 5000);
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      clearTimeout(timer);
      finish({ duration: Number.isFinite(video.duration) ? video.duration : 0 });
    };
    video.onerror = () => {
      clearTimeout(timer);
      finish({ duration: 0 });
    };
    video.src = url;
  });
}

async function uploadImages(fileList) {
  const info = studioPlatformInfo();
  const spec = studioSpec();
  const isVideo = spec.media_type === "video";
  let files = Array.from(fileList || []);
  if (isVideo) {
    files = files.filter((file) => file.type.startsWith("video/") || VIDEO_EXT.includes(fileExt(file.name)));
    if (!files.length) {
      toast(`${info.name}${spec.label}需要视频文件`, true);
      return;
    }
    const file = files[0];
    const ext = fileExt(file.name);
    if (!VIDEO_EXT.includes(ext)) {
      showInline("#media-error", `不支持的视频格式 .${ext || "未知"}，请用 mp4 / mov / webm`);
      return;
    }
    if (file.size > 4 * 1024 * 1024 * 1024) {
      showInline("#media-error", "视频不能超过 4GB");
      return;
    }
    const meta = await probeVideo(file);
    if (info.key === "douyin" && meta.duration > 15 * 60 + 1) {
      showInline("#media-error", `抖音视频不能超过 15 分钟，当前约 ${Math.round(meta.duration / 60)} 分钟`);
      return;
    }
    state.studio.videoMeta = { duration: meta.duration, size: file.size };
    files = [file];
  } else {
    files = files.filter((file) => file.type.startsWith("image/"));
    if (!files.length) {
      toast("只能上传图片文件", true);
      return;
    }
    const wechatCover = isWechatPlatform() && spec.key !== "image_message";
    if (wechatCover) files = files.slice(0, 1);
    const limit = spec.max_images || files.length;
    const room = Math.max(0, limit - (wechatCover ? 0 : state.studio.images.length));
    if (!room) {
      toast(`${info.name}${spec.label}最多 ${limit} 张图片`, true);
      return;
    }
    if (files.length > room) {
      files = files.slice(0, room);
      toast(`已按${info.name}规格保留前 ${room} 张`, true);
    }
  }
  const zone = $("#upload-zone");
  zone.classList.add("busy");
  clearErrorBox("#media-error");
  const form = new FormData();
  files.forEach((file) => form.append("files", file));
  try {
    const data = await api("/api/uploads", { method: "POST", body: form });
    const paths = data.paths || [];
    if (isVideo) {
      state.studio.images = paths.slice(0, 1);
      toast("视频已就绪");
    } else if (isWechatPlatform() && spec.key !== "image_message") {
      state.studio.images = paths.slice(0, 1);
      toast("封面已更新");
    } else {
      state.studio.images = state.studio.images.concat(paths);
      toast(`已添加 ${paths.length} 张素材`);
    }
    state.studio.dirty = true;
    refreshStudioUI();
  } catch (error) {
    showInline("#media-error", error.message);
  } finally {
    zone.classList.remove("busy");
    $("#upload-input").value = "";
  }
}

/* ------------------------------------------------------------------ 内容库 */

function renderLibraryStats() {
  const wrap = $("#library-stats");
  const drafts = (state.overview && state.overview.drafts) || {};
  const total =
    Number(drafts.draft || 0) +
    Number(drafts.queued || 0) +
    Number(drafts.published || 0) +
    Number(drafts.failed || 0);
  $$("#draft-filter button[data-status]").forEach((button) => {
    if (!button.dataset.label) button.dataset.label = button.textContent.trim();
    const key = button.dataset.status;
    const value = key ? Number(drafts[key] || 0) : total;
    button.innerHTML = `${button.dataset.label}<span class="count">${value}</span>`;
  });
  if (!wrap) return;
  const stats = [
    ["待发布", drafts.draft, "篇", drafts.ready ? `其中 ${drafts.ready} 篇可立即发布` : "写完后可入队"],
    ["已入队", drafts.queued, "篇", "等待自动执行"],
    ["已发布", drafts.published, "篇", "成功发到平台"],
    ["失败", drafts.failed, "篇", drafts.failed ? "需要重试或修改" : "暂无失败"],
  ];
  wrap.innerHTML = stats
    .map(
      ([label, value, unit, hint]) =>
        `<div class="stat-tile"><span>${label}</span><b>${value == null ? "—" : value}<small>${unit}</small></b><em>${esc(
          hint
        )}</em></div>`
    )
    .join("");
}

function renderLibrary() {
  const grid = $("#draft-grid");
  if (state.loading.library) {
    grid.innerHTML = Array.from({ length: 6 })
      .map(
        () => `<div class="draft-tile loading"><div class="draft-cover skeleton"></div>
          <div class="draft-main"><div class="skeleton skeleton-line"></div>
          <div class="skeleton skeleton-line w60"></div><div class="skeleton skeleton-line"></div></div></div>`
      )
      .join("");
    return;
  }
  const drafts = state.drafts;
  if (!drafts.length) {
    grid.innerHTML = emptyState(
      state.draftFilter || state.draftPlatformFilter ? "这个筛选下还没有内容" : "内容库还是空的",
      "从创作台写一条，或者去选题池挑一个。",
      `<button class="btn primary" data-action="new-note">写新内容</button>
       <button class="btn ghost" data-action="go-topics">去选题</button>`
    );
    const pager = $("#library-pager");
    if (pager) pager.innerHTML = "";
    updateDraftSelected();
    return;
  }
  grid.innerHTML = drafts
    .map((draft) => {
      const [statusText, statusKind] = DRAFT_STATUS[draft.status] || [draft.status, ""];
      const spec = specOf(draft.platform, draft.content_type);
      const isVideoDraft = spec.media_type === "video";
      const cover =
        draft.images && draft.images.length ? mediaUrl(draft.images[0], draft.id) : "";
      const jobs = draft.jobs || [];
      const picked = state.selectedDrafts.has(draft.id) ? "checked" : "";
      const canQueue = draft.status !== "published" && draft.status !== "queued";
      const platKey = draft.platform === "douyin" ? "dy" : draft.platform === "wechat_mp" ? "wx" : "xhs";
      const stateKey =
        draft.status === "queued"
          ? "queued"
          : draft.status === "published"
          ? "published"
          : draft.status === "failed"
          ? "failed"
          : "";
      const title = draft.title || "未命名草稿";
      const words = (draft.desc || "").replace(/<[^>]+>/g, "").length;
      const firstTopic = (draft.topics || [])[0] || spec.label;
      const accountName = (jobs[0] && jobs[0].account_name) || draft.account_name || "未指定账号";
      const when = typeof relTime === "function" && draft.updated_at ? relTime(draft.updated_at) : "";
      const excerpt = bodyWithoutTags(draft.desc) || "还没有正文";
      return `<article class="content-card${picked ? " selected" : ""}" data-action="open-draft" data-id="${draft.id}">
        <div class="cc-cover ${platKey}">
          ${
            cover
              ? `<img class="cc-img" src="${esc(cover)}" alt="" loading="lazy" />`
              : ""
          }
          <label class="cc-check" title="勾选后可批量删除">
            <input type="checkbox" class="draft-check" data-id="${draft.id}" ${picked} />
          </label>
          <div class="cc-badges">
            <span class="cc-plat">${platformBadge(draft.platform)}${esc(
        typeof platformName === "function" ? platformName(draft.platform) : spec.label
      )}</span>
            <span class="cc-state ${stateKey}">${esc(statusText)}</span>
          </div>
          <span class="cc-title">${esc(title)}</span>
          <span class="cc-sub">${esc(excerpt.slice(0, 26))}</span>
        </div>
        <div class="cc-body">
          <div class="t" title="${esc(title)}">${esc(title)}</div>
          <div class="m">
            <span>#${esc(firstTopic)}</span><i></i>
            <span>${words ? `${words} 字` : "未完成"}</span><i></i>
            <span>${isVideoDraft ? "视频" : `${(draft.images || []).length} 图`}</span>
          </div>
          <div class="cc-foot">
            <div class="cc-acc"><span class="avatar">${esc(String(accountName).slice(0, 1))}</span><span>${esc(
        accountName
      )}${when ? ` · ${esc(when)}` : ""}</span></div>
            <div class="cc-actions">
              ${
                canQueue
                  ? `<button class="icon-btn" type="button" data-action="queue-draft" data-id="${draft.id}" title="加入队列">
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 4L10 14"/><path d="M21 4l-7 17-4-7-7-4z"/></svg>
                    </button>`
                  : `<button class="icon-btn" type="button" data-action="open-draft" data-id="${draft.id}" title="继续编辑">
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15.5 4.5l4 4L8 20H4v-4z"/><path d="M13 7l4 4"/></svg>
                    </button>`
              }
              <details class="card-more">
                <summary title="更多操作" aria-label="更多操作">⋯</summary>
                <div class="card-more-menu">
                  <button type="button" data-action="open-draft" data-id="${draft.id}">继续编辑</button>
                  <button type="button" data-action="rewrite-draft" data-id="${draft.id}">洗稿</button>
                  <button type="button" data-action="convert-draft" data-id="${draft.id}">${
        draft.platform === "wechat_mp" ? "切换到小红书" : "切换到公众号"
      }</button>
                  <button type="button" class="danger" data-action="delete-draft" data-id="${draft.id}">删除</button>
                </div>
              </details>
            </div>
          </div>
        </div>
      </article>`;
    })
    .join("");
  $$("#draft-grid .cc-img").forEach((img) => {
    img.addEventListener("error", () => img.remove());
  });
  const pager = $("#library-pager");
  if (pager) {
    pager.innerHTML = pagerHtml("drafts", state.draftPage, PAGE_SIZE.drafts, state.draftTotal);
  }
  updateDraftSelected();
}

function updateDraftSelected() {
  const count = state.selectedDrafts.size;
  const pageIds = state.drafts.map((draft) => draft.id);
  const pageSelected = pageIds.filter((id) => state.selectedDrafts.has(id)).length;

  const all = $("#draft-check-all");
  if (all) {
    all.checked = pageIds.length > 0 && pageSelected === pageIds.length;
    all.indeterminate = pageSelected > 0 && pageSelected < pageIds.length;
    all.disabled = pageIds.length === 0;
  }

  const countNode = $("#draft-selected-count");
  if (countNode) countNode.textContent = `已选 ${count} 项`;
  const bulkBar = $("#draft-bulk");
  if (bulkBar) bulkBar.hidden = count === 0;

  const upgrade = $("#btn-select-all-filtered");
  if (upgrade) {
    if (state.draftAllMatched) {
      upgrade.hidden = false;
      upgrade.textContent = "取消全选";
    } else if (all && all.checked && state.draftTotal > pageIds.length) {
      upgrade.hidden = false;
      upgrade.textContent = `选中全部 ${state.draftTotal} 篇`;
    } else {
      upgrade.hidden = true;
    }
  }

  const scope = $("#draft-select-scope");
  if (scope) {
    scope.hidden = !state.draftAllMatched;
    if (state.draftAllMatched) {
      scope.textContent = `已跨页选中当前筛选下的全部 ${count} 篇，删除和入队会作用于这些草稿。`;
    }
  }

  const del = $("#btn-delete-drafts");
  if (del) {
    del.disabled = count === 0;
    del.textContent = count ? `删除所选（${count}）` : "删除所选";
  }
  const queue = $("#btn-queue-selected");
  if (queue) {
    queue.disabled = count === 0;
    queue.textContent = count ? `批量入队（${count}）` : "批量入队";
  }

  $$("#draft-grid .draft-tile, #draft-grid .content-card").forEach((tile) => {
    tile.classList.toggle("picked", state.selectedDrafts.has(Number(tile.dataset.id)));
  });
  $$("#draft-grid .draft-check").forEach((node) => {
    node.checked = state.selectedDrafts.has(Number(node.dataset.id));
  });
}

/* 筛选条件变化时清空选择，避免批量操作到已经不可见的草稿。 */
function clearDraftSelection() {
  state.selectedDrafts.clear();
  state.draftAllMatched = false;
  updateDraftSelected();
}

/* ------------------------------------------------------------------ 洗稿 */

const REWRITE_TONE_OPTIONS = [
  ["", "跟随原文语气"],
  ["story", "经验分享"],
  ["informative", "干货科普"],
  ["emotional", "情感共鸣"],
  ["warn", "避坑指南"],
  ["professional", "专业测评"],
  ["casual", "日常随意"],
];

function rewriteFormHtml() {
  return `<p class="hint">保留原文的事实和信息点，只换开头、结构、表达和语气。新草稿会标注洗稿来源。</p>
    <div class="form-row"><label>怎么改（角度）</label>
      <input id="rw-angle" type="text" placeholder="例如：换成清单体，从新手视角重讲" /></div>
    <div class="form-row cols">
      <div><label>语气</label><select id="rw-tone">
        ${REWRITE_TONE_OPTIONS.map(
          ([value, label]) => `<option value="${value}">${esc(label)}</option>`
        ).join("")}
      </select></div>
      <label class="check"><input type="checkbox" id="rw-cards" checked /> 同时配图</label>
    </div>`;
}

async function submitRewrite(url, extra) {
  const button = $("#btn-rewrite-save");
  setButtonLoading(button, true, "洗稿中");
  try {
    const draft = await api(url, {
      method: "POST",
      body: {
        ...extra,
        angle: $("#rw-angle").value.trim(),
        tone: $("#rw-tone").value,
        with_cards: $("#rw-cards").checked,
      },
    });
    toast(`已生成新草稿 #${draft.id}（${draft.engine === "llm" ? "模型改写" : "离线改写"}）`);
    closeModal();
    await refreshLibrary();
    await refreshOverview();
    switchView("library");
  } catch (error) {
    if (!maybePromptLogin(error)) toast(error.message, true);
  } finally {
    setButtonLoading(button, false);
  }
}

function openRewriteDraft(draft) {
  openModal(
    `洗稿 · ${esc(draft.title || `#${draft.id}`)}`,
    rewriteFormHtml(),
    `<button class="btn ghost" data-action="close-modal">取消</button>
     <button class="btn primary" id="btn-rewrite-save">生成新草稿</button>`
  );
  $("#btn-rewrite-save").addEventListener("click", () =>
    submitRewrite(`/api/drafts/${draft.id}/rewrite`, {})
  );
}

function openRewriteText() {
  openModal(
    "粘贴文案洗稿",
    `<div class="form-row"><label>原标题（可留空，默认取第一行）</label>
       <input id="rw-title" type="text" placeholder="留空就从正文第一行取标题" /></div>
     <div class="form-row"><label>要洗的文案</label>
       <textarea id="rw-text" rows="9" placeholder="把已有笔记或一段文案粘进来"></textarea></div>
     ${rewriteFormHtml()}`,
    `<button class="btn ghost" data-action="close-modal">取消</button>
     <button class="btn primary" id="btn-rewrite-save">生成新草稿</button>`
  );
  $("#btn-rewrite-save").addEventListener("click", () => {
    const text = $("#rw-text").value.trim();
    if (!text) {
      toast("先粘贴要洗的文案", true);
      return;
    }
    submitRewrite("/api/copy/rewrite", { text, title: $("#rw-title").value.trim() });
  });
}

/* ------------------------------------------------------------------ 内容库 */

async function refreshLibrary({ silent = false } = {}) {
  if (state.libraryMode === "published") return;
  if (!silent) {
    state.loading.library = true;
    renderLibrary();
  }
  try {
    const draftQuery = new URLSearchParams({
      limit: String(PAGE_SIZE.drafts),
      offset: String((state.draftPage - 1) * PAGE_SIZE.drafts),
    });
    if (state.draftFilter) draftQuery.set("status", state.draftFilter);
    if (state.draftPlatformFilter) draftQuery.set("platform", state.draftPlatformFilter);
    state.drafts = await api(`/api/drafts?${draftQuery.toString()}`);
    state.draftTotal = lastMeta.total == null ? state.drafts.length : lastMeta.total;
    const draftPages = Math.max(1, Math.ceil(state.draftTotal / PAGE_SIZE.drafts));
    if (!state.drafts.length && state.draftPage > draftPages) {
      state.draftPage = draftPages;
      return refreshLibrary({ silent });
    }
    const jobQuery = new URLSearchParams({
      limit: String(PAGE_SIZE.jobs),
      offset: String((state.jobPage - 1) * PAGE_SIZE.jobs),
    });
    if (state.jobReason) jobQuery.set("reason", state.jobReason);
    state.jobs = await api(`/api/jobs?${jobQuery.toString()}`);
    state.jobTotal = lastMeta.total == null ? state.jobs.length : lastMeta.total;
    const jobPages = Math.max(1, Math.ceil(state.jobTotal / PAGE_SIZE.jobs));
    if (!state.jobs.length && state.jobPage > jobPages) {
      state.jobPage = jobPages;
      return refreshLibrary({ silent });
    }
    state.loading.library = false;
    renderLibrary();
    renderLibraryStats();
    renderJobs();
  } catch (error) {
    state.loading.library = false;
    renderLibrary();
    throw error;
  }
}

function renderJobs() {
  const list = $("#job-list");
  const totalLabel = $("#job-total");
  const queue = (state.overview && state.overview.jobs) || {};
  const waiting = (queue.pending || 0) + (queue.retry || 0);
  if (totalLabel) totalLabel.textContent = waiting ? `${waiting} 个待执行` : "空闲";
  if (!state.jobs.length) {
    list.innerHTML = emptyState(
      "队列是空的",
      "在草稿卡片上点「发布」，任务会按账号限额自动执行。"
    );
    const emptyPager = $("#job-pager");
    if (emptyPager) emptyPager.innerHTML = "";
    renderQueueReasons();
    return;
  }
  const statusMeta = {
    pending: ["排队中", "brand"],
    running: ["发布中", "brand"],
    retry: ["重试中", "warn"],
    pending_confirm: ["待确认", "warn"],
    failed: ["失败 · 暂停", "bad"],
    cancelled: ["已取消", ""],
    success: ["已发布", "ok"],
  };
  const groups = [
    { key: "pending", title: "即将发布", statuses: ["pending", "running", "pending_confirm"] },
    { key: "failed", title: "需要处理", statuses: ["failed", "cancelled"] },
    { key: "retry", title: "重试中", statuses: ["retry"] },
    { key: "done", title: "最近完成", statuses: ["success"] },
  ];
  const rowOf = (job) => {
    const [statusText, statusKind] = statusMeta[job.status] || JOB_STATUS[job.status] || [job.status, ""];
    const stamp = job.next_run_at || job.created_at;
    const actions = [];
    if (job.status === "failed" || job.status === "cancelled") {
      actions.push(
        `<button class="btn sm" data-action="retry-job" data-id="${job.id}">立即重试</button>`
      );
    }
    if (job.status === "pending" || job.status === "retry") {
      actions.push(
        `<button class="icon-btn" title="移出队列" aria-label="移出队列" data-action="cancel-job" data-id="${job.id}"><svg class="ico" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"></path></svg></button>`
      );
    }
    if (job.status === "pending_confirm") {
      actions.push(
        `<button class="btn sm primary" data-action="confirm-job" data-id="${job.id}" data-published="1">已发布</button>`,
        `<button class="btn sm" data-action="confirm-job" data-id="${job.id}" data-published="0">未发布</button>`
      );
    }
    const notes = [];
    if (job.blocked_reason && (job.status === "pending" || job.status === "retry")) {
      notes.push(job.blocked_reason);
    }
    if (job.status === "running" && job.submitted_at) {
      notes.push(`已提交到平台，等待回执（${fmtTime(job.submitted_at)}）`);
    }
    if (job.status === "pending_confirm") {
      notes.push(`平台回执缺失，请在 ${fmtTime(job.confirm_deadline)} 前确认。`);
    }
    if (job.last_error && job.status !== "success" && job.status !== "pending_confirm") {
      notes.push(friendlyError(job.last_error));
    }
    const note = notes.length
      ? `<div class="q-note${job.status === "failed" ? " bad" : ""}">${esc(notes[0])}</div>`
      : "";
    return `<article class="q-row${job.status === "failed" ? " failed" : ""}" data-job-status="${esc(
      job.status
    )}">
      <div class="q-time">${clockStamp(stamp)}<span>${dayStamp(stamp)}</span></div>
      <span class="q-thumb ${(PLAT_TAGS[job.platform] || {}).cls || ""}"></span>
      <div class="q-info">
        <b title="${esc(job.draft_title)}">${esc(job.draft_title || "未命名内容")}</b>
        <div class="q-meta">
          ${platWrap([job.platform])}
          <span class="q-accts">${esc(job.account_name || "自动选账号")} · 第 ${
      job.attempts || 0
    }/${job.max_attempts || 0} 次</span>
        </div>
        ${note}
      </div>
      <span class="pill ${statusKind}">${esc(statusText)}</span>
      <div class="q-actions">${actions.join("")}</div>
    </article>`;
  };
  const blocks = groups
    .map((group) => {
      const rows = state.jobs.filter((job) => group.statuses.includes(job.status));
      if (!rows.length) return "";
      return `<div class="queue-group" data-group="${group.key}">
        <div class="group-label" style="margin:12px 16px 2px">${group.title} <span class="n">${rows.length}</span></div>
        ${rows.map(rowOf).join("")}
      </div>`;
    })
    .join("");
  list.innerHTML = blocks || emptyState("队列是空的", "在草稿卡片上点「发布」，任务会按账号限额自动执行。");
  const alert = $("#queue-alert");
  if (alert) {
    const expired = (state.accounts || []).filter((account) => account.status === "expired").length;
    const failed = Number(((state.overview || {}).jobs || {}).failed || 0);
    alert.innerHTML =
      failed || expired
        ? `<div class="alert-banner">
            <svg class="ico" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4l9 16H3z"></path><path d="M12 10v4"></path><circle cx="12" cy="17" r=".9" fill="currentColor" stroke="none"></circle></svg>
            <span><b>${failed || expired} 个任务需要处理</b>：账号登录失效或发布失败，处理后会自动继续。</span>
            <span class="spacer"></span>
            <button class="btn sm" type="button" data-view="accounts">去处理</button>
          </div>`
        : "";
  }
  const pager = $("#job-pager");
  if (pager) pager.innerHTML = pagerHtml("jobs", state.jobPage, PAGE_SIZE.jobs, state.jobTotal, { compact: true });
  renderQueueReasons();
}

/* 队列受阻原因：直接回答「为什么还没发」，点一下只看这一类。 */
function renderQueueReasons() {
  const box = $("#queue-reasons");
  if (!box) return;
  const data = (state.overview && state.overview.queue) || {};
  const groups = data.groups || [];
  if (!groups.length) {
    box.innerHTML = "";
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.innerHTML = groups
    .map(
      (group) => `<button type="button" class="reason-chip${
        state.jobReason === group.reason ? " on" : ""
      }" data-action="filter-job-reason" data-reason="${esc(group.reason)}">
        ${esc(group.reason)} <b>${group.count}</b>
      </button>`
    )
    .join("");
}

/* ------------------------------------------------------------------ 已发布作品 */

function setLibraryMode(mode) {
  state.libraryMode = mode === "published" ? "published" : "drafts";
  $$("#library-mode button").forEach((button) =>
    button.classList.toggle("active", button.dataset.libMode === state.libraryMode)
  );
  const draftPanel = $("#draft-panel");
  const publishedPanel = $("#published-panel");
  if (draftPanel) draftPanel.hidden = state.libraryMode === "published";
  if (publishedPanel) publishedPanel.hidden = state.libraryMode !== "published";
  if (state.libraryMode === "published") {
    refreshPublished().catch((error) => toast(error.message, true));
  } else {
    refreshLibrary().catch((error) => toast(error.message, true));
  }
}

async function refreshPublished({ silent = false } = {}) {
  if (state.libraryMode !== "published") return;
  const grid = $("#published-grid");
  if (!grid) return;
  state.publishedLoading = true;
  if (!silent) grid.innerHTML = `<div class="skeleton skeleton-card"></div><div class="skeleton skeleton-card"></div>`;
  try {
    const query = new URLSearchParams({
      limit: String(PAGE_SIZE.published),
      offset: String((state.publishedPage - 1) * PAGE_SIZE.published),
    });
    if (state.publishedAccountId) query.set("account_id", state.publishedAccountId);
    if (state.publishedHealth) query.set("health", state.publishedHealth);
    state.published = await api(`/api/published?${query.toString()}`);
    state.publishedTotal =
      lastMeta.total == null ? state.published.length : lastMeta.total;
    const pages = Math.max(1, Math.ceil(state.publishedTotal / PAGE_SIZE.published));
    if (!state.published.length && state.publishedPage > pages) {
      state.publishedPage = pages;
      return refreshPublished({ silent: true });
    }
    state.publishedLoading = false;
    renderPublished();
  } catch (error) {
    state.publishedLoading = false;
    throw error;
  }
}

function healthBadge(item) {
  const [text, kind] = HEALTH_TEXT[item.health_state] || [item.health_state || "未判断", ""];
  return badge(text, kind);
}

function metricText(value) {
  return value == null ? "—" : Number(value).toLocaleString("zh-CN");
}

function renderPublished() {
  const grid = $("#published-grid");
  if (!grid) return;
  if (!state.published.length) {
    grid.innerHTML = emptyState(
      state.publishedHealth || state.publishedAccountId
        ? "没有符合条件的作品"
        : "还没有已发布作品",
      "发布成功后，到「已发布作品」同步平台数据，就能看到阅读、互动和异常提醒。",
      `<button class="btn small primary" data-action="sync-published">同步平台</button>`
    );
    $("#published-pager").innerHTML = "";
    return;
  }
  grid.innerHTML = state.published
    .map((item) => {
      const cover = item.cover
        ? `<img class="published-cover" src="${esc(item.cover)}" alt="" loading="lazy" />`
        : `<span class="published-cover placeholder">${esc((item.title || "作").slice(0, 1))}</span>`;
      const canOpen = Boolean(item.id);
      return `<article class="published-card${canOpen ? "" : " needs-sync"}" ${
        canOpen ? `data-action="open-note" data-id="${item.id}"` : ""
      }>
        ${cover}
        <div class="published-body">
          <div class="published-top">
            ${platformBadge(item.platform)}
            ${healthBadge(item)}
            ${item.needs_sync ? badge("待同步", "warn") : ""}
          </div>
          <div class="published-title" title="${esc(item.title)}">${esc(item.title || "(无标题)")}</div>
          <div class="published-sub">${esc(item.account_name || "")} · ${esc(
            fmtTime(item.published_at)
          )}</div>
          <div class="published-metrics">
            <span><b>${metricText(item.views)}</b><small>浏览</small></span>
            <span><b>${metricText(item.likes)}</b><small>点赞</small></span>
            <span><b>${metricText(item.comments)}</b><small>评论</small></span>
            <span><b>${metricText(item.collects)}</b><small>收藏</small></span>
          </div>
          ${
            item.health_note
              ? `<p class="published-note">${esc(item.health_note)}</p>`
              : ""
          }
        </div>
      </article>`;
    })
    .join("");
  const pager = $("#published-pager");
  if (pager) {
    pager.innerHTML = pagerHtml(
      "published",
      state.publishedPage,
      PAGE_SIZE.published,
      state.publishedTotal
    );
  }
}

function openNoteDetail(noteId) {
  const note = state.published.find((item) => item.id === Number(noteId));
  if (!note) {
    toast("作品数据已更新，请刷新后再打开", true);
    return;
  }
  openModal(
    note.title || "作品详情",
    `<div class="note-detail">
      <div class="note-detail-head">
        ${platformBadge(note.platform)}
        ${healthBadge(note)}
        <span class="hint">${esc(note.account_name || "")} · 发布 ${esc(
          fmtTime(note.published_at)
        )}</span>
        ${note.url ? `<a class="link-btn" href="${esc(note.url)}" target="_blank" rel="noreferrer">打开原作品</a>` : ""}
      </div>
      <div class="note-metrics-row">
        <span><b>${metricText(note.views)}</b><small>浏览</small></span>
        <span><b>${metricText(note.likes)}</b><small>点赞</small></span>
        <span><b>${metricText(note.comments)}</b><small>评论</small></span>
        <span><b>${metricText(note.collects)}</b><small>收藏</small></span>
      </div>
      <div class="note-detail-grid">
        <section>
          <div class="note-section-head">
            <h4>数据趋势</h4>
            <div class="seg" id="note-range">
              <button type="button" class="active" data-action="note-range" data-id="${note.id}" data-days="7">7 天</button>
              <button type="button" data-action="note-range" data-id="${note.id}" data-days="30">30 天</button>
            </div>
          </div>
          <div class="metric-chart" id="note-metrics"><div class="skeleton skeleton-line"></div></div>
        </section>
        <section>
          <div class="note-section-head">
            <h4>评论 <span class="hint" id="note-comments-total"></span></h4>
            <button class="btn small ghost" data-action="sync-comments" data-id="${note.id}">${
              note.comments_supported === null ? "探测并同步" : "同步评论"
            }</button>
          </div>
          <p class="hint" id="note-comments-notice"></p>
          <div class="comment-list" id="note-comments"><div class="skeleton skeleton-line"></div></div>
          <div id="note-comments-more"></div>
        </section>
      </div>
    </div>`,
    `<button class="btn ghost" data-action="close-modal">关闭</button>`
  );
  loadNoteMetrics(note.id, 7);
  loadNoteComments(note.id, 0, false);
}

async function loadNoteMetrics(noteId, days = 7, button = null) {
  const box = $("#note-metrics");
  if (!box) return;
  if (button) setButtonLoading(button, true);
  try {
    const data = await api(`/api/published/${noteId}/metrics?days=${days}`);
    box.innerHTML = renderMetricBars(data.series || []);
    const hint = document.querySelector("#note-metrics + .hint");
    if (hint) hint.textContent = data.hint || "";
    const range = $("#note-range");
    if (range) {
      $$("#note-range button").forEach((item) =>
        item.classList.toggle("active", Number(item.dataset.days) === Number(days))
      );
    }
  } catch (error) {
    box.innerHTML = `<p class="hint">${esc(error.message)}</p>`;
  } finally {
    if (button) setButtonLoading(button, false);
  }
}

function renderMetricBars(series) {
  const rows = series.filter((item) => item.views != null);
  if (!rows.length) {
    return `<p class="hint">平台还没有返回可用的浏览数据。同步一次后再看。</p>`;
  }
  const max = Math.max(1, ...rows.map((item) => Number(item.views) || 0));
  return `<div class="metric-bars">${series
    .map((item) => {
      if (item.views == null) {
        return `<span class="metric-bar gap" title="${esc(item.day)} · 无数据"></span>`;
      }
      const height = Math.max(2, Math.round((Number(item.views) / max) * 96));
      return `<span class="metric-bar" style="--h:${height}px" title="${esc(item.day)} · 浏览 ${metricText(
        item.views
      )} / 赞 ${metricText(item.likes)}"></span>`;
    })
    .join("")}</div>
    <p class="hint">柱高为浏览量；缺口表示平台当天没返回数据，不按 0 处理。</p>`;
}

async function loadNoteComments(noteId, offset = 0, append = false) {
  const list = $("#note-comments");
  if (!list) return;
  if (!append) list.innerHTML = `<div class="skeleton skeleton-line"></div>`;
  try {
    const data = await api(
      `/api/published/${noteId}/comments?limit=10&offset=${offset}`
    );
    state.noteComments[noteId] = data;
    const totalLabel = $("#note-comments-total");
    if (totalLabel) totalLabel.textContent = data.total ? `（${data.total}）` : "";
    const notice = $("#note-comments-notice");
    if (notice) notice.textContent = data.notice || data.empty_text || "";
    if (!data.items.length) {
      list.innerHTML = `<p class="hint">${esc(data.empty_text || "暂无评论")}</p>`;
    } else {
      const html = data.items
        .map(
          (item) => `<div class="comment-item${item.is_reply ? " reply" : ""}">
            <div class="comment-head"><b>${esc(item.author || "匿名")}</b>
              <span class="hint">${esc(fmtTime(item.commented_at))}${
                item.likes == null ? "" : ` · 赞 ${metricText(item.likes)}`
              }</span></div>
            <p>${esc(item.content)}</p>
          </div>`
        )
        .join("");
      list.innerHTML = append ? list.innerHTML + html : html;
    }
    const more = $("#note-comments-more");
    if (more) {
      more.innerHTML =
        data.items.length && data.offset + data.items.length < data.total
          ? `<button class="btn small ghost" data-action="more-comments" data-id="${noteId}" data-offset="${
              data.offset + data.items.length
            }">加载更多</button>`
          : "";
    }
  } catch (error) {
    list.innerHTML = `<p class="hint">${esc(error.message)}</p>`;
  }
}

async function syncNoteComments(noteId, button) {
  setButtonLoading(button, true, "同步中");
  try {
    const data = await api(`/api/published/${noteId}/comments/sync`, {
      method: "POST",
      body: { pages: 3 },
    });
    toast(data.message || "评论已同步");
    await loadNoteComments(noteId, 0, false);
    await refreshPublished({ silent: true });
  } catch (error) {
    toast(error.message, true);
  } finally {
    setButtonLoading(button, false);
  }
}

async function syncPublishedData(button) {
  setButtonLoading(button, true, "同步中");
  try {
    const body = state.publishedAccountId
      ? { account_ids: [Number(state.publishedAccountId)], pages: 2 }
      : { pages: 2 };
    const task = await api("/api/published/sync", { method: "POST", body });
    toast(task.message || "同步任务已提交，稍后刷新查看");
  } catch (error) {
    toast(error.message, true);
  } finally {
    setButtonLoading(button, false);
  }
}

async function runHealthCheck(button) {
  setButtonLoading(button, true, "检查中");
  try {
    const body = state.publishedAccountId
      ? { account_id: Number(state.publishedAccountId) }
      : {};
    const data = await api("/api/published/health-check", { method: "POST", body });
    toast(data.message || "健康检查完成");
    await refreshPublished({ silent: true });
  } catch (error) {
    toast(error.message, true);
  } finally {
    setButtonLoading(button, false);
  }
}

function openQueueDialog(draftId) {
  const draft = state.drafts.find((item) => item.id === draftId) || {
    id: draftId,
    title: `#${draftId}`,
    platform: "xiaohongshu",
  };
  const info = platformInfo(draft.platform);
  if (info && !info.ready) {
    toast(`${info.name}尚未接入发布，先把草稿留在内容库`, true);
    return;
  }
  const options = ['<option value="">自动轮换（推荐）</option>'].concat(
    accountsForPlatform(draft.platform)
      .map(
        (account) =>
          `<option value="${account.id}">${esc(account.nickname || account.name)} · 今日 ${account.published_today}</option>`
      )
  );
  const wechat = isWechatPlatform(draft.platform);
  const actionHtml = wechat
    ? `<div class="form-row"><label>发布方式</label>
        <div class="seg" id="queue-action">
          <button type="button" class="active" data-action="draft">先存草稿</button>
          <button type="button" data-action="publish">立即发布</button>
        </div>
        <div class="desc" id="queue-action-desc">只保存到公众号草稿箱，不会推送给关注者。</div></div>`
    : "";
  openModal(
    `发布到${info ? info.short || info.name : "平台"}`,
    `<div class="form-row"><label>草稿</label><div>${esc(draft.title)}</div></div>
     <div class="form-row"><label>目标账号</label><select id="queue-account">${options.join("")}</select>
       <div class="desc">自动轮换会优先选今日发得少、间隔已到的账号。</div></div>
     ${actionHtml}
     <div class="form-row"><label>定时发布（留空立即进入队列）</label>
       <input id="queue-time" type="datetime-local" /></div>`,
    `<button class="btn ghost" data-action="close-modal">取消</button>
     <button class="btn primary" id="btn-queue-confirm">${wechat ? "保存草稿" : "加入队列"}</button>`
  );
  if (wechat) {
    $("#queue-action").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      $$("#queue-action button").forEach((node) => node.classList.toggle("active", node === button));
      const publish = button.dataset.action === "publish";
      $("#queue-action-desc").textContent = publish
        ? "发布后会推送给全部关注者，每天只有 1 次机会。"
        : "只保存到公众号草稿箱，不会推送给关注者。";
      $("#btn-queue-confirm").textContent = publish ? "立即发布" : "保存草稿";
    });
  }
  $("#btn-queue-confirm").addEventListener("click", async () => {
    const actionButton = $("#queue-action .active");
    const action = wechat && actionButton ? actionButton.dataset.action : "queue";
    const values = {
      title: draft.title || "",
      desc: draft.desc || "",
      topics: draft.topics || [],
      images: draft.images || [],
      visibility: Number(draft.visibility || 0),
    };
    const problems = studioSpecProblems(values, draft.platform, draft.content_type);
    if (problems.length) {
      toast(problems[0].text, true);
      return;
    }
    const button = $("#btn-queue-confirm");
    setButtonLoading(button, true, "提交中");
    try {
      if (wechat) {
        await api(`/api/drafts/${draftId}`, {
          method: "PATCH",
          body: { visibility: action === "draft" ? 1 : 0 },
        });
      }
      const time = $("#queue-time").value;
      await api("/api/jobs", {
        method: "POST",
        body: {
          draft_ids: [draftId],
          account_id: $("#queue-account").value || null,
          scheduled_at: time ? time.replace("T", " ") : 0,
        },
      });
      toast(
        wechat
          ? action === "draft"
            ? "已加入队列：保存到公众号草稿箱"
            : "已加入队列：立即发布"
          : "已加入发布队列"
      );
      closeModal();
      await refreshLibrary();
      await refreshOverview();
    } catch (error) {
      toast(error.message, true);
    } finally {
      setButtonLoading(button, false);
    }
  });
}

/* ------------------------------------------------------------------ 记录 */

async function refreshRecords() {
  state.loading.records = true;
  $("#record-table tbody").innerHTML = `<tr><td colspan="7"><div class="skeleton skeleton-line"></div></td></tr>`;
  try {
    const query = new URLSearchParams({
      limit: String(PAGE_SIZE.records),
      offset: String((state.recordPage - 1) * PAGE_SIZE.records),
    });
    state.records = await api(`/api/records?${query.toString()}`);
    state.recordTotal = lastMeta.total == null ? state.records.length : lastMeta.total;
    const successTotal =
      lastMeta.successTotal == null
        ? state.records.filter((record) => record.success).length
        : lastMeta.successTotal;
    const failedTotal =
      lastMeta.failedTotal == null ? state.records.length - successTotal : lastMeta.failedTotal;
    const pages = Math.max(1, Math.ceil(state.recordTotal / PAGE_SIZE.records));
    if (!state.records.length && state.recordPage > pages) {
      state.recordPage = pages;
      return refreshRecords();
    }
    state.loading.records = false;
    const rate = state.recordTotal ? Math.round((successTotal / state.recordTotal) * 1000) / 10 : 0;
    $("#record-summary").innerHTML = `
      <span>发布记录 <b>${state.recordTotal}</b></span>
      <span>成功率 <b>${rate}%</b></span>
      <span>成功 <b>${successTotal}</b></span>
      <span style="color:var(--bad)">失败 <b style="color:var(--bad)">${failedTotal}</b></span>
      <span class="spacer"></span>
      <button class="link-btn" type="button" id="record-failed-only">查看失败明细</button>`;
    const body = $("#record-table tbody");
    const rows = [];
    let lastDay = "";
    state.records.forEach((record) => {
      const day = dayStamp(record.created_at);
      if (day !== lastDay) {
        lastDay = day;
        rows.push(`<tr class="group-row"><td colspan="6">${day}</td></tr>`);
      }
      const remote = record.remote_note_id || "";
      const remoteShort = remote.length > 12 ? `${remote.slice(0, 6)}…${remote.slice(-3)}` : remote;
      rows.push(`<tr data-platform="${esc(platformName(record.platform))}" data-result="${
        record.success ? "ok" : "failed"
      }">
        <td class="tabular muted">${clockStamp(record.created_at)}</td>
        <td><div class="rec-cont"><span class="thumb ${(PLAT_TAGS[record.platform] || {}).cls || ""}"></span><div class="txt">
          <div class="t" title="${esc(record.draft_title)}">${esc(record.draft_title || "未命名内容")}</div>
          <div class="s">${platWrap([record.platform])}<span>${esc(platformName(record.platform))}</span></div>
        </div></div></td>
        <td>${esc(record.account_name || "—")}</td>
        <td>${record.success ? '<span class="pill ok">成功</span>' : '<span class="pill bad">失败</span>'}</td>
        <td class="muted tabular" title="${esc(remote)}">${esc(remoteShort || "—")}</td>
        <td class="muted">${esc(record.message || "—")}</td>
      </tr>`);
    });
    body.innerHTML = state.records.length
      ? rows.join("")
      : `<tr><td colspan="6">${emptyState("还没有发布记录", "第一次发布成功后，这里会留下远端笔记 ID。")}</td></tr>`;
    const pager = $("#record-pager");
    if (pager) {
      pager.innerHTML = state.records.length
        ? pagerHtml("records", state.recordPage, PAGE_SIZE.records, state.recordTotal)
        : "";
    }
  } catch (error) {
    state.loading.records = false;
    throw error;
  }
}

/* ------------------------------------------------------------------ 选题 */

async function refreshTopics() {
  const pageSize = PAGE_SIZE.topics;
  const query = new URLSearchParams({
    status: state.topicStatus,
    q: $("#topic-search").value.trim(),
    source: $("#topic-source").value,
    sort: $("#topic-sort").value,
    min_score: $("#topic-min-score").value || "0",
    limit: String(pageSize),
    offset: String((state.topicPage - 1) * pageSize),
  });
  state.topics = await api(`/api/topics?${query.toString()}`);
  state.topicTotal = lastMeta.total == null ? state.topics.length : lastMeta.total;
  // 页码越界时（例如删完最后一页）自动回到最后一页再取一次。
  const pages = Math.max(1, Math.ceil(state.topicTotal / pageSize));
  if (!state.topics.length && state.topicPage > pages) {
    state.topicPage = pages;
    return refreshTopics();
  }
  const valid = new Set(state.topics.map((topic) => topic.id));
  state.selectedTopics = new Set(Array.from(state.selectedTopics).filter((id) => valid.has(id)));
  renderTopics();
  const pager = $("#topic-pager");
  if (pager) pager.innerHTML = pagerHtml("topics", state.topicPage, pageSize, state.topicTotal);
  if (state.showDedupes) await refreshDedupes();
}

function resetTopicPaging() {
  state.topicPage = 1;
}

async function refreshDedupes() {
  state.topicDedupes = await api("/api/topics/dedupes?limit=30").catch((error) => {
      reportBackgroundError(error);
      return [];
    });
  renderDedupes();
}

function renderDedupes() {
  const panel = $("#dedupe-panel");
  if (!panel) return;
  panel.hidden = !state.showDedupes;
  if (!state.showDedupes) return;
  if (!state.topicDedupes.length) {
    panel.innerHTML = `<div class="dedupe-head"><div><b>去重记录</b>
      <p class="hint">还没有合并记录。同类标题再次入池时，这里会写明哪条被合并、保留的是哪条。</p></div></div>`;
    return;
  }
  panel.innerHTML = `<div class="dedupe-head"><div><b>去重记录</b>
      <p class="hint">重复的题没有入池，保留的是更早入池的那一条。</p></div>
      <span class="dedupe-count">${state.topicDedupes.length} 条合并</span></div>
    <div class="dedupe-list">${state.topicDedupes
      .slice(0, state.dedupeExpanded ? state.topicDedupes.length : 5)
      .map(
        (item) => `<div class="dedupe-row">
          <span class="dedupe-merged" title="${esc(item.title)}">${esc(item.title)}</span>
          <span class="dedupe-arrow">并入</span>
          <button class="link-btn dedupe-kept" data-action="show-topic" data-id="${item.kept_topic_id}">#${item.kept_topic_id} ${esc(
          item.kept_title
        )}</button>
          <span class="dedupe-spacer"></span>
          <span class="dedupe-sim">相似 ${Math.round((item.similarity || 0) * 100)}%</span>
          <span class="dedupe-src">${esc(
            SOURCE_LABEL[item.source] || item.source_label || item.source || ""
          )}</span>
        </div>`
      )
      .join("")}</div>
    ${
      state.topicDedupes.length > 5
        ? `<div class="dedupe-foot"><button class="btn small ghost" data-action="toggle-dedupe-all">${
            state.dedupeExpanded ? "收起" : `查看全部 ${state.topicDedupes.length} 条`
          }</button></div>`
        : ""
    }`;
}

function scoreTip(topic) {
  const detail = topic.score_detail || {};
  return `互动 ${Math.round((detail.engagement || 0) * 100)}% · 新鲜 ${Math.round(
    (detail.fresh || 0) * 100
  )}% · 匹配 ${Math.round((detail.fit || 0) * 100)}% · 新颖 ${Math.round((detail.novelty || 0) * 100)}%`;
}

function openScoreExplain(topic) {
  const rows = topic.score_explain || [];
  const score = Number(topic.score) || 0;
  const dims = rows.filter((row) => row.key !== "total");
  const body = `<div class="score-sheet">
    <div class="score-hero">
      <div class="score-ring big" style="--pct:${Math.min(100, Math.max(0, score))}">
        <b>${score.toFixed(1)}</b><span>总分</span>
      </div>
      <div class="score-hero-text">
        <b>${esc(topic.title)}</b>
        <span>由互动热度、新鲜度、赛道匹配、新颖度四项加权得出，满分 100。</span>
      </div>
    </div>
    <div class="score-dims">${dims
      .map(
        (row) => `<div class="score-dim">
          <div class="score-dim-head">
            <span>${esc(row.label)}</span>
            <span class="hint">权重 ${row.weight}%</span>
            <b>${row.points} 分</b>
          </div>
          <div class="score-bar"><span style="width:${Math.round((row.value || 0) * 100)}%"></span></div>
          <p class="hint">${esc(row.note || "")}</p>
        </div>`
      )
      .join("")}</div>
    <div class="score-total-row"><span>合计</span><b>${score.toFixed(1)} 分</b></div>
    <p class="hint">总分 = 互动×45% + 新鲜×15% + 赛道匹配×20% + 新颖×20%。分数只是参考，最终还是要看这个角度你能不能写出东西。</p>
  </div>`;
  openModal("这条为什么是这个分", body, `<button class="btn ghost" data-action="close-modal">关闭</button>`);
}

function heatLabel(value) {
  const heat = Number(value) || 0;
  if (heat >= 10000) return `${(heat / 10000).toFixed(1)} 万`;
  return heat.toLocaleString("zh-CN");
}

function renderTopicStats() {
  const box = $("#topic-stats");
  if (!box) return;
  const overviewTopics = (state.overview && state.overview.topics) || {};
  const scores = state.topics.map((topic) => Number(topic.score) || 0);
  const avg = scores.length ? scores.reduce((sum, value) => sum + value, 0) / scores.length : 0;
  const topHeat = state.topics.reduce((max, topic) => Math.max(max, Number(topic.heat) || 0), 0);
  const tiles = [
    { label: "待用选题", value: overviewTopics.pool == null ? "—" : overviewTopics.pool, hint: "还在池子里" },
    { label: "已用选题", value: overviewTopics.used == null ? "—" : overviewTopics.used, hint: "已经写成草稿" },
    { label: "本页平均分", value: avg ? avg.toFixed(1) : "—", hint: "满分 100" },
    { label: "本页最高热度", value: topHeat ? heatLabel(topHeat) : "—", hint: "点赞 + 收藏×2 + 评论×3 + 转发×2" },
  ];
  box.innerHTML = tiles
    .map(
      (tile) => `<div class="stat-tile">
        <span>${tile.label}</span><b>${tile.value}</b><em>${tile.hint}</em>
      </div>`
    )
    .join("");
}

function renderTopicCard(topic) {
  const statusMap = { pool: ["待用", "accent"], used: ["已用", ""], dropped: ["已丢弃", "muted"] };
  const [statusText, statusKind] = statusMap[topic.status] || [topic.status, ""];
  const checked = state.selectedTopics.has(topic.id) ? "checked" : "";
  const score = Number(topic.score) || 0;
  const nextStatus = topic.status === "dropped" ? "pool" : "dropped";
  return `<article class="topic-card${checked ? " selected" : ""}" data-id="${topic.id}">
    <label class="topic-check-wrap" title="选择这条选题">
      <input type="checkbox" class="topic-check" data-id="${topic.id}" ${checked} />
    </label>
    <div class="topic-main">
      <div class="topic-top">
        ${badge(topic.source_label || SOURCE_LABEL[topic.source] || topic.source || "来源")}
        ${topic.product ? badge("产品", "accent") : ""}
        ${topic.keyword ? `<span class="topic-kw">#${esc(topic.keyword)}</span>` : ""}
        <span class="spacer"></span>
        <span class="topic-status ${esc(topic.status || "")}">${esc(statusText)}</span>
      </div>
      <button type="button" class="topic-title" data-action="score-explain" data-id="${topic.id}" title="点击查看评分构成">
        ${esc(topic.title)}
      </button>
      ${topicAngleText(topic) ? `<p class="topic-angle">${esc(topicAngleText(topic))}</p>` : ""}
      <div class="topic-meta">
        <span class="topic-heat" title="点赞 + 收藏×2 + 评论×3 + 转发×2">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 20s-7-4.4-7-9.3A4.2 4.2 0 0 1 9.2 6c1.2 0 2.2.6 2.8 1.5A3.4 3.4 0 0 1 14.8 6 4.2 4.2 0 0 1 19 10.7C19 15.6 12 20 12 20z"></path>
          </svg>
          热度 ${heatLabel(topic.heat)}
        </span>
        <span class="topic-sep"></span>
        <span>${esc(topic.category || "未设栏目")}</span>
        <span class="topic-sep"></span>
        <span>${esc(TONE_OPTIONS[topic.tone] || topic.tone || "未设语气")}</span>
      </div>
      <div class="topic-actions">
        <button class="btn small primary" data-action="topic-to-studio" data-id="${topic.id}">带入创作</button>
        <button class="btn small ghost" data-action="draft-from-topic" data-id="${topic.id}">一键成稿</button>
        <span class="spacer"></span>
        <details class="card-more">
          <summary title="更多操作" aria-label="更多操作">⋯</summary>
          <div class="card-more-menu">
            <button type="button" data-action="edit-topic" data-id="${topic.id}">编辑</button>
            <button type="button" data-action="drop-topic" data-id="${topic.id}" data-status="${nextStatus}">${
    topic.status === "dropped" ? "恢复到选题池" : "丢弃"
  }</button>
            <button type="button" class="danger" data-action="delete-topic" data-id="${topic.id}">删除</button>
          </div>
        </details>
      </div>
    </div>
    <div class="topic-side">
      <button type="button" class="score-ring" data-action="score-explain" data-id="${topic.id}"
        style="--pct:${Math.min(100, Math.max(0, score))}" title="${esc(scoreTip(topic))}">
        <b>${score.toFixed(1)}</b><span>评分</span>
      </button>
    </div>
  </article>`;
}

function renderTopics() {
  const list = $("#topic-list");
  if (!list) return;
  renderTopicStats();
  if (!state.topics.length) {
    list.innerHTML = emptyState(
      "选题池是空的",
      "用上方的关键词、竞品或热榜挖一批，也可以手动加一条。",
      `<button class="btn small primary" data-action="focus-mine">开始挖掘</button>`
    );
    updateTopicSelected();
    return;
  }
  list.innerHTML = state.topics.map(renderTopicCard).join("");
  updateTopicSelected();
}

function updateTopicSelected() {
  const count = state.selectedTopics.size;
  const label = $("#topic-selected");
  if (label) label.textContent = count ? `已选 ${count} 条` : "未选择";
  const bulk = $("#topic-bulk");
  if (bulk) bulk.hidden = count === 0;
  const createButton = $("#btn-create-drafts");
  if (createButton) createButton.disabled = count === 0;
  const deleteButton = $("#btn-delete-topics");
  if (deleteButton) {
    deleteButton.disabled = count === 0;
    deleteButton.textContent = count ? `删除所选（${count}）` : "删除所选";
  }
  const all = $("#topic-check-all");
  if (all) all.checked = count > 0 && count === state.topics.length;
}

async function runMining() {
  const activeMode = $("#mine-modes .active");
  const mode = (activeMode && activeMode.dataset.mode) || "keyword";
  const raw = $("#mine-input").value.trim();
  if (mode !== "trending" && !raw) {
    toast(
      mode === "keyword"
        ? "请先输入关键词"
        : mode === "channel"
        ? "请先输入频道名，如 职场 / 学习"
        : "请先输入竞品主页链接",
      true
    );
    return;
  }
  const button = $("#btn-mine");
  setButtonLoading(button, true, "挖掘中");
  try {
    const payload = {
      mode,
      keywords: ["keyword", "channel"].includes(mode) ? raw.split(/[,，\n]/) : [],
      user_urls: mode === "competitor" ? raw.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean) : [],
      per_kw: Number($("#mine-per-kw").value || 20),
      limit: Number($("#mine-per-kw").value || 30),
      detail_limit: Number($("#mine-detail").value || 5),
      product: $("#mine-product").checked,
      account_id: $("#mine-account").value || null,
      sort_type_choice: 0,
    };
    const result = await api("/api/topics/mine", { method: "POST", body: payload });
    const errors = (result.errors || []).slice(0, 2).join("；");
    const merged = (result.dedupes || []).length;
    toast(
      `入池 ${result.inserted} 条，跳过 ${result.skipped} 条${
        merged ? `（其中 ${merged} 条合并进已有选题）` : ""
      }${errors ? `（${errors}）` : ""}`
    );
    if (merged) {
      state.showDedupes = true;
    }
    await refreshTopics();
    await refreshOverview();
  } catch (error) {
    toast(error.message, true);
  } finally {
    setButtonLoading(button, false);
  }
}

function openAddTopic() {
  openModal(
    "手动添加选题",
    `<div class="form-row"><label>选题标题</label>
      <input id="topic-title" type="text" placeholder="面试被问「你的缺点是什么」怎么答" /></div>
    <div class="form-row"><label>切入角度（可留空）</label>
      <textarea id="topic-angle" rows="3" placeholder="不要讲套话，给一个能直接说出口的句式"></textarea></div>
    <div class="form-row"><label>关键词</label>
      <input id="topic-keyword" type="text" placeholder="面试, 缺点" /></div>
    <div class="form-row cols">
      <div><label>栏目</label><input id="topic-category" type="text" placeholder="如 面试 / 职场 / 学习" /></div>
      <div><label>语气</label><select id="topic-tone">
        <option value="">默认（经验分享）</option>
        ${Object.keys(TONE_OPTIONS)
          .map((key) => `<option value="${key}">${esc(TONE_OPTIONS[key])}</option>`)
          .join("")}
      </select></div>
    </div>
    <label class="check"><input type="checkbox" id="topic-product" /> 带产品</label>`,
    `<button class="btn ghost" data-action="close-modal">取消</button>
     <button class="btn primary" id="btn-topic-save">加入选题池</button>`
  );
  $("#btn-topic-save").addEventListener("click", async () => {
    const title = $("#topic-title").value.trim();
    if (!title) {
      toast("标题不能为空", true);
      $("#topic-title").classList.add("invalid");
      $("#topic-title").focus();
      return;
    }
    try {
      await api("/api/topics", {
        method: "POST",
        body: {
          title,
          angle: $("#topic-angle").value.trim(),
          keyword: $("#topic-keyword").value.trim(),
          category: $("#topic-category").value.trim(),
          tone: $("#topic-tone").value,
          product: $("#topic-product").checked,
        },
      });
      toast("已加入选题池");
      closeModal();
      await refreshTopics();
      await refreshOverview();
    } catch (error) {
      if (/重复/.test(error.message)) {
        state.showDedupes = true;
        await refreshDedupes().catch(reportBackgroundError);
      }
      toast(error.message, true);
    }
  });
}

function openImportTopics() {
  openModal(
    "批量导入选题",
    `<p class="hint">每行一条：标题, 角度, 关键词, 栏目, 语气, 是否带产品。也支持粘贴 JSON 数组。</p>
     <div class="form-row"><label>导入内容</label>
       <textarea id="topic-import-text" rows="10" placeholder="面试被问缺点怎么答, 给可直接说的句式, 面试, 面试, story, 0
秋招时间线怎么排, 按月份拆解, 秋招, 求职, informative, 0"></textarea></div>`,
    `<button class="btn ghost" data-action="close-modal">取消</button>
     <button class="btn primary" id="btn-import-topics-save">开始导入</button>`
  );
  $("#btn-import-topics-save").addEventListener("click", async () => {
    const text = $("#topic-import-text").value.trim();
    if (!text) {
      toast("先粘贴要导入的内容", true);
      return;
    }
    try {
      const result = await api("/api/topics/import", { method: "POST", body: { text } });
      toast(`导入 ${result.inserted} 条，跳过 ${result.skipped} 条`);
      state.showDedupes = Boolean((result.dedupes || []).length) || state.showDedupes;
      closeModal();
      await refreshTopics();
      await refreshOverview();
    } catch (error) {
      toast(error.message, true);
    }
  });
}

function openTopicEditor(topic) {
  openModal(
    "编辑选题",
    `<div class="form-row"><label>标题</label><input id="edit-title" type="text" value="${esc(topic.title)}" /></div>
     <div class="form-row"><label>角度</label><textarea id="edit-angle" rows="3">${esc(topic.angle)}</textarea></div>
     <div class="form-row"><label>关键词</label><input id="edit-keyword" type="text" value="${esc(topic.keyword)}" /></div>
     <div class="form-row cols">
       <div><label>栏目</label><input id="edit-category" type="text" value="${esc(topic.category || "")}" /></div>
       <div><label>语气</label><select id="edit-tone">
         <option value="">未设置</option>
         ${Object.keys(TONE_OPTIONS)
           .map(
             (key) =>
               `<option value="${key}" ${topic.tone === key ? "selected" : ""}>${esc(
                 TONE_OPTIONS[key] || key
               )}</option>`
           )
           .join("")}
       </select></div>
     </div>
     <label class="check"><input type="checkbox" id="edit-product" ${topic.product ? "checked" : ""}/> 带产品</label>`,
    `<button class="btn ghost" data-action="close-modal">取消</button>
     <button class="btn primary" id="btn-topic-update">保存</button>`
  );
  $("#btn-topic-update").addEventListener("click", async () => {
    try {
      await api(`/api/topics/${topic.id}`, {
        method: "PATCH",
        body: {
          title: $("#edit-title").value.trim(),
          angle: $("#edit-angle").value.trim(),
          keyword: $("#edit-keyword").value.trim(),
          category: $("#edit-category").value.trim(),
          tone: $("#edit-tone").value,
          product: $("#edit-product").checked,
        },
      });
      toast("已保存");
      closeModal();
      await refreshTopics();
    } catch (error) {
      toast(error.message, true);
    }
  });
}

function topicToStudio(topic) {
  $("#f-brief").value = `${topic.title}。${topic.angle || "写出你最想讲清楚的那一点。"}`;
  $("#f-topic").value = topic.title;
  $("#f-tone").value = topic.tone || "story";
  $("#f-product").checked = Boolean(topic.product);
  state.studio.topicId = topic.id;
  state.studio.draftId = null;
  state.studio.draftStatus = "draft";
  state.studio.images = [];
  state.studio.issues = [];
  state.studio.engine = "";
  state.studio.dirty = true;
  $("#f-schedule").value = "";
  $("#f-title").value = topic.title.slice(0, 20);
  $("#f-desc").value = "";
  $("#f-topics").value = topic.keyword || "";
  switchView("studio");
  refreshStudioUI();
  toast("已带入创作台，点「生成文案」开始");
}

/* ------------------------------------------------------------------ 定时 */

const SCHEDULE_KIND_LABEL = {
  publish: "定时发布",
  mine: "定时找选题",
  draft: "定时生成草稿",
  chain: "找选题→写草稿→发布",
};
const WEEKDAY_SHORT = ["一", "二", "三", "四", "五", "六", "日"];
const SCHEDULE_RUN_STATUS = {
  running: ["执行中", "accent"],
  success: ["成功", "ok"],
  failed: ["失败", "bad"],
  interrupted: ["已中断", "warn"],
};
// 引导式新建固定三步：做什么 → 什么时候 → 确认，全程不需要填自由文本。
const SCHEDULE_WIZARD_STEPS = 3;
const SCHEDULE_WHATS = [
  { key: "chain", title: "找选题→写草稿→发布", desc: "一条链路跑完：挖选题、写带配图的草稿、到点发布" },
  { key: "publish", title: "发一篇已写好的", desc: "从内容库挑一篇，到点准备发布" },
  { key: "mine", title: "只帮我找选题", desc: "只把选题存进选题池，不写也不发" },
];
const SCHEDULE_WHENS = [
  { key: "morning", title: "每天早上", desc: "09:00", sentence: "每天 09:00" },
  { key: "noon", title: "每天中午", desc: "12:00", sentence: "每天 12:00" },
  { key: "evening", title: "每天晚上", desc: "20:00", sentence: "每天 20:00" },
  { key: "workdays", title: "工作日", desc: "20:00", sentence: "工作日 20:00" },
  { key: "every6h", title: "每隔一段时间", desc: "每 6 小时", sentence: "每 6 小时" },
];
const SCHEDULE_PREFS_KEY = "ops.schedule.prefs";
const SCHEDULE_INTRO_KEY = "ops.schedule.introDismissed";
const SCHEDULE_ERROR_HINTS = [
  { test: /没有可发布的草稿/, title: "到点了，但内容库里没有可发的草稿", fix: "先去创作页写好一篇、补上配图，下次就会自动挑到" },
  { test: /缺配图/, title: "草稿还没配图，暂时不能发", fix: "打开这篇草稿生成配图，或换一篇配好图的" },
  { test: /合规/, title: "文案里有敏感词，被拦下了", fix: "按提示改掉敏感词，再点「马上跑一遍」" },
  { test: /风控|频繁|限流/, title: "平台提示操作太频繁，已经停下来了", fix: "等几小时再试；把发布间隔调长，别用同一账号连发" },
  { test: /登录|失效|过期|401/, title: "账号登录状态过期了", fix: "去「账号」页重新扫码登录" },
  { test: /没有可用账号/, title: "还没有可用的小红书账号", fix: "去「账号」页扫码登录一个账号" },
  { test: /选题池为空|没有挖到选题/, title: "这次没找到合适的选题", fix: "去选题页手动加几个，或放宽关键词后再试" },
  { test: /关键词/, title: "找选题的关键词还没填", fix: "打开「编辑详细设置」补上关键词" },
  { test: /服务重启/, title: "服务重启，这次执行被中断了", fix: "不用处理，下一次会照常执行" },
];

function schedulePrefs() {
  try {
    return JSON.parse(localStorage.getItem(SCHEDULE_PREFS_KEY) || "{}");
  } catch (error) {
    return {};
  }
}

function rememberSchedulePrefs(value) {
  try {
    localStorage.setItem(SCHEDULE_PREFS_KEY, JSON.stringify({ ...schedulePrefs(), ...value }));
  } catch (error) {
    // 隐私模式下写不了，忽略即可。
  }
}

function renderScheduleIntro() {
  const node = $("#schedule-intro");
  if (!node) return;
  let dismissed = false;
  try {
    dismissed = localStorage.getItem(SCHEDULE_INTRO_KEY) === "1";
  } catch (error) {
    dismissed = false;
  }
  node.hidden = dismissed;
}

async function refreshSchedules(resetRuns = true) {
  const query = new URLSearchParams({
    limit: String(PAGE_SIZE.schedules),
    offset: String((state.schedulePage - 1) * PAGE_SIZE.schedules),
  });
  state.schedules = await api(`/api/schedules?${query.toString()}`);
  state.scheduleTotal = lastMeta.total == null ? state.schedules.length : lastMeta.total;
  const pages = Math.max(1, Math.ceil(state.scheduleTotal / PAGE_SIZE.schedules));
  if (!state.schedules.length && state.schedulePage > pages) {
    state.schedulePage = pages;
    return refreshSchedules(resetRuns);
  }
  if (resetRuns) state.scheduleRunCache = {};
  renderSchedules();
  const openIds = Array.from(state.scheduleOpen);
  await Promise.all(
    openIds.map(async (id) => {
      if (state.scheduleRunCache[id]) return;
      try {
        state.scheduleRunCache[id] = await api(`/api/schedule-runs?schedule_id=${id}&limit=5`);
      } catch (error) {
        state.scheduleRunCache[id] = [];
      }
    })
  );
  renderSchedules();
}

async function toggleScheduleDetail(id) {
  if (state.scheduleOpen.has(id)) {
    state.scheduleOpen.delete(id);
  } else {
    state.scheduleOpen.add(id);
  }
  renderSchedules();
  if (state.scheduleOpen.has(id) && !state.scheduleRunCache[id]) {
    try {
      state.scheduleRunCache[id] = await api(`/api/schedule-runs?schedule_id=${id}&limit=5`);
    } catch (error) {
      state.scheduleRunCache[id] = [];
    }
    renderSchedules();
  }
}

function whatLabel(item) {
  if (item.kind === "publish") return "发一篇已写好的";
  if (item.kind === "chain") return "找选题→写草稿→发布";
  if (item.kind === "mine") return "只帮我找选题";
  return "生成草稿";
}

function humanNext(ts) {
  if (!ts) return "—";
  const target = new Date(ts * 1000);
  const now = new Date();
  const startOf = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diffDays = Math.round((startOf(target) - startOf(now)) / 86400000);
  const clock = `${pad(target.getHours())}:${pad(target.getMinutes())}`;
  if (diffDays === 0) return `今天 ${clock}`;
  if (diffDays === 1) return `明天 ${clock}`;
  if (diffDays === 2) return `后天 ${clock}`;
  if (diffDays > 2 && diffDays < 7) return `周${WEEKDAY_SHORT[(target.getDay() + 6) % 7]} ${clock}`;
  return `${target.getMonth() + 1} 月 ${target.getDate()} 日 ${clock}`;
}

function humanizeRun(run) {
  const raw = String(run.error || run.message || "").trim();
  const clean = raw
    .replace(/^补跑（[^）]*）：/, "")
    .replace(/^[A-Za-z]+Error:\s*/, "");
  const output = run.output || {};
  if (["success", "running", "waiting", "partial"].includes(run.status)) {
    const extra = [];
    if ((output.draft_ids || []).length) {
      extra.push(`产出草稿 #${output.draft_ids.slice(0, 3).join("、#")}`);
    }
    if (output.pending && !output.confirmed_at) extra.push("已备好，等你确认发布");
    return {
      title: clean || (run.status === "running" ? "正在执行…" : "执行完成"),
      fix: "",
      extra: extra.join("；"),
    };
  }
  const hint = SCHEDULE_ERROR_HINTS.find((item) => item.test.test(raw));
  return {
    title: hint ? hint.title : clean || "执行失败",
    fix: hint ? hint.fix : "点「马上跑一遍」重试；仍失败就打开详细设置检查账号和内容",
    extra: hint && clean ? `原始提示：${clean}` : "",
  };
}

function findRun(runId) {
  for (const runs of Object.values(state.scheduleRunCache)) {
    const found = (runs || []).find((run) => run.id === Number(runId));
    if (found) return found;
  }
  return null;
}

function renderChainFlow(run) {
  const stages = (run.output && run.output.stages) || [];
  if (!stages.length) return "";
  const nodes = stages
    .map((stage) => {
      const statusMap = {
        failed: ["失败", "bad"],
        skipped: ["跳过", "warn"],
        pending: ["待确认", "warn"],
        waiting: ["待重试", "warn"],
        partial: ["部分成功", "warn"],
      };
      const [statusLabel, kind] = statusMap[stage.status] || ["完成", "ok"];
      const links = [];
      if (stage.key === "mine" && (stage.topic_ids || []).length) {
        links.push(
          `<button class="link-btn" data-action="open-run-topics" data-run="${run.id}">看选题 ${stage.topic_ids.length}</button>`
        );
      }
      if (stage.key === "draft" && (stage.draft_ids || []).length) {
        links.push(
          `<button class="link-btn" data-action="open-run-drafts" data-run="${run.id}">看草稿 ${stage.draft_ids.length}</button>`
        );
        if (stage.image_count) {
          links.push(
            `<button class="link-btn" data-action="open-run-images" data-run="${run.id}">看配图 ${stage.image_count} 张</button>`
          );
        }
      }
      if (stage.key === "publish") {
        if ((stage.job_ids || []).length) {
          links.push(
            `<button class="link-btn" data-action="open-run-publish" data-run="${run.id}">看发布结果</button>`
          );
        }
        if (stage.pending) links.push(`<span class="hint">已备好，待确认</span>`);
      }
      return `<div class="chain-stage ${kind}">
        <div class="chain-body">
          <div class="chain-name">${esc(stage.label || stage.key)}${badge(
        statusLabel,
        kind
      )}</div>
          <div class="chain-sum">${esc(friendlyError(stage.summary || stage.error || ""))}</div>
          ${links.length ? `<div class="chain-links">${links.join("")}</div>` : ""}
          ${
            stage.status === "failed"
              ? `<button class="btn small danger" data-action="rerun-stage" data-run="${run.id}" data-stage="${stage.key}">只重跑这一环</button>`
              : ""
          }
        </div>
      </div>`;
    })
    .join(`<span class="chain-arrow">→</span>`);
  return `<div class="chain-flow">${nodes}</div>`;
}

function renderRunOutputList(rows) {
  if (!rows.length) return `<p class="hint">这一环没有留下可查看的产出。</p>`;
  return `<div class="run-output-list">${rows
    .map(
      (row) => `<div class="run-output-row">
        <div><div class="t">${esc(row.title)}</div>${row.meta ? `<div class="s">${esc(row.meta)}</div>` : ""}</div>
        ${row.action || ""}
      </div>`
    )
    .join("")}</div>`;
}

async function openRunStage(runId, action) {
  const run = findRun(runId);
  if (!run) {
    toast("运行记录已刷新，请收起后重新展开任务", true);
    return;
  }
  const stages = (run.output && run.output.stages) || [];
  const key =
    action === "open-run-topics"
      ? "mine"
      : action === "open-run-images"
      ? "draft"
      : action === "open-run-drafts"
      ? "draft"
      : "publish";
  const stage = stages.find((item) => item.key === key);
  if (!stage) {
    toast("这次运行没有这一环的产出", true);
    return;
  }
  if (key === "mine") {
    const ids = new Set(stage.topic_ids || []);
    const topics = await api("/api/topics?status=&limit=500").catch((error) => {
      reportBackgroundError(error);
      return [];
    });
    const picked = topics.filter((topic) => ids.has(topic.id));
    openModal(
      "这一环产出的选题",
      renderRunOutputList(
        picked.map((topic) => ({
          title: `#${topic.id} ${topic.title}`,
          meta: `${topic.source_label || ""} · ${topic.score} 分${topic.category ? ` · ${topic.category}` : ""}`,
          action: `<button class="btn small ghost" data-action="show-topic" data-id="${topic.id}">去选题池</button>`,
        }))
      ),
      `<button class="btn ghost" data-action="close-modal">关闭</button>`
    );
    return;
  }
  if (key === "draft") {
    const ids = new Set(stage.draft_ids || []);
    if (!state.drafts.length) await refreshLibrary().catch(reportBackgroundError);
    const drafts = state.drafts.filter((draft) => ids.has(draft.id));
    openModal(
      "这一环产出的草稿",
      renderRunOutputList(
        drafts.map((draft) => ({
          title: `#${draft.id} ${draft.title || "未命名"}`,
          meta: `${(draft.images || []).length} 图 · ${draft.status}${
            draft.source_note ? ` · ${draft.source_note}` : ""
          }`,
          action: `<button class="btn small ghost" data-action="open-draft" data-id="${draft.id}">打开</button>`,
        }))
      ),
      `<button class="btn ghost" data-action="close-modal">关闭</button>`
    );
    return;
  }
  if (action === "open-run-images") {
    const ids = new Set(stage.draft_ids || []);
    if (!state.drafts.length) await refreshLibrary().catch(reportBackgroundError);
    const drafts = state.drafts.filter((draft) => ids.has(draft.id));
    const gallery = drafts
      .flatMap((draft) =>
        (draft.images || []).map((path) => ({
          draft,
          url: mediaUrl(path, draft.id),
        }))
      )
      .filter((item) => item.url);
    openModal(
      "这一环产出的配图",
      gallery.length
        ? `<div class="run-image-grid">${gallery
            .map(
              (item) =>
                `<a class="run-image" href="${esc(item.url)}" target="_blank" rel="noopener">
                  <img src="${esc(item.url)}" alt="${esc(item.draft.title || "")}" loading="lazy" />
                  <span>#${item.draft.id} · ${esc(item.draft.title || "")}</span>
                </a>`
            )
            .join("")}</div>`
        : `<p class="hint">这一环的草稿没有配图。</p>`,
      `<button class="btn ghost" data-action="close-modal">关闭</button>`
    );
    return;
  }
  const results = stage.results || [];
  const rows = results.map((item) => ({
    title: item.message || `任务 #${item.job_id || "—"}`,
    meta: [item.status || "", item.remote_note_id ? `笔记 ${item.remote_note_id}` : "", item.account_id ? `账号 #${item.account_id}` : ""]
      .filter(Boolean)
      .join(" · "),
  }));
  (stage.blocked || []).forEach((text) => rows.push({ title: `被挡下：${text}`, meta: "未进入发布队列" }));
  openModal(
    "这一环的发布结果",
    renderRunOutputList(rows),
    `<button class="btn ghost" data-action="close-modal">关闭</button>`
  );
}

function renderRunRow(run) {
  const info = humanizeRun(run);
  const [, statusKind] = SCHEDULE_RUN_STATUS[run.status] || ["", ""];
  const pending = run.output && run.output.pending && !run.output.confirmed_at;
  return `<div class="run-row${run.kind === "chain" ? " chain" : ""} ${statusKind}">
    <div class="run-main">
      <div class="t">${esc(info.title)}</div>
      ${run.kind === "chain" ? renderChainFlow(run) : ""}
      ${info.fix ? `<div class="s">怎么修：${esc(info.fix)}</div>` : ""}
      ${info.extra ? `<div class="s">${esc(info.extra)}</div>` : ""}
    </div>
    <div class="run-side">
      <span class="s">${esc(fmtTime(run.started_at))}</span>
      ${
        pending
          ? `<button class="btn small primary" data-action="confirm-run" data-id="${run.id}">确认发布</button>`
          : ""
      }
    </div>
  </div>`;
}

function humanizePause(text) {
  const raw = String(text || "");
  if (/连续失败/.test(raw)) {
    const times = (raw.match(/\d+/) || ["3"])[0];
    return `连续 ${times} 次没成功，已自动停下`;
  }
  if (/风控|合规/.test(raw)) {
    return raw.replace(/^发布命中风控\/合规：?/, "发布时被平台或合规规则拦下：");
  }
  return raw;
}

function renderScheduleDetail(item) {
  const runs = state.scheduleRunCache[item.id];
  const paused = !item.enabled && item.paused_reason;
  const notice = paused
    ? `<div class="notice bad">已自动暂停：${esc(humanizePause(item.paused_reason))}。<br/>怎么修：先检查账号和文案，确认没问题后点「启用」。</div>`
    : "";
  return `<div class="schedule-detail">
    ${notice}
    <div class="detail-bar">
      <button class="btn small primary" data-action="run-schedule" data-id="${item.id}">马上跑一遍</button>
      <button class="btn small ghost" data-action="edit-schedule" data-id="${item.id}">编辑详细设置</button>
      <button class="btn small ghost" data-action="switch-schedule" data-id="${item.id}">${
        item.enabled ? "先停用" : "启用"
      }</button>
      <button class="btn small danger" data-action="delete-schedule" data-id="${item.id}">删除</button>
      <label class="auto-toggle">全自动
        <button type="button" class="switch${item.auto ? " on" : ""}" data-action="toggle-schedule-auto"
          data-id="${item.id}" role="switch" aria-checked="${item.auto}"><span></span></button>
        <span class="hint">${item.auto ? "到点直接发布" : "到点等你确认"}</span>
      </label>
    </div>
    <div class="run-list">
      <div class="run-head">最近的执行</div>
      ${
        runs === undefined
          ? `<p class="hint">加载中…</p>`
          : runs.length
          ? runs.map(renderRunRow).join("")
          : `<p class="hint">还没执行过。</p>`
      }
    </div>
  </div>`;
}

/* 计划名如果是自动生成的「每天 09:00 · 找选题…」，会和右侧时间重复；
   这种情况下改展示配置要点，避免一行里说两遍同一件事。 */
function scheduleSubLabel(item) {
  const name = item.name || "";
  const autoLike = name.includes("·") && name.includes(item.kind_label || "\u0000");
  if (!autoLike) return name;
  const config = item.config || {};
  const bits = [];
  if (config.mode === "keyword" && Array.isArray(config.keywords) && config.keywords.length) {
    bits.push(`关键词 ${config.keywords.slice(0, 3).join("、")}${config.keywords.length > 3 ? " 等" : ""}`);
  }
  if (config.simulate) bits.push("只演练不真发");
  if (config.from_pool) bits.push("优先用选题池");
  if (config.limit) bits.push(`一次最多 ${config.limit} 条`);
  return bits.join(" · ");
}

const PLAN_ICONS = {
  mine: '<circle cx="11" cy="11" r="6.2"></circle><path d="M15.6 15.6L20 20"></path>',
  publish: '<path d="M21 4L10 14"></path><path d="M21 4l-7 17-4-7-7-4z"></path>',
  chain: '<rect x="4" y="5.5" width="16" height="15" rx="2"></rect><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"></path>',
};

function renderScheduleCard(item) {
  const open = state.scheduleOpen.has(item.id);
  const stateText = item.running
    ? "执行中"
    : item.enabled
    ? "启用"
    : item.paused_reason
    ? "账号异常"
    : "已关闭";
  const stateKind = item.running || item.enabled ? "ok" : item.paused_reason ? "bad" : "";
  const icoKind = item.running || item.enabled ? "brand" : item.paused_reason ? "warn" : "";
  const meta = [item.trigger_label, scheduleSubLabel(item), platformName(item.platform)]
    .filter(Boolean)
    .map((text) => `<span>${esc(text)}</span>`)
    .join("<i></i>");
  const nextLabel = item.running
    ? "正在执行"
    : !item.enabled && item.paused_reason
    ? "恢复后执行"
    : item.next_run_at
    ? "下次执行"
    : "—";
  return `<article class="schedule-plan${open ? " open" : ""}" data-id="${item.id}" data-enabled="${
    item.enabled || item.running ? "1" : "0"
  }">
    <div class="plan-card">
      <span class="plan-ico ${icoKind}"><svg class="ico" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${
        PLAN_ICONS[item.kind] || PLAN_ICONS.chain
      }</svg></span>
      <div class="plan-main" data-action="toggle-schedule-detail" data-id="${item.id}">
        <b>${esc(item.name || whatLabel(item))}</b>
        <div class="plan-meta">${meta}</div>
      </div>
      <div class="plan-next"><div class="n">${esc(humanNext(item.next_run_at))}</div><div class="l">${nextLabel}</div></div>
      <div class="plan-right">
        <span class="pill ${stateKind}">${stateText}</span>
        <button type="button" class="switch${item.enabled ? " on" : ""}" data-action="switch-schedule" data-id="${
    item.id
  }" role="switch" aria-checked="${item.enabled}"><i></i></button>
        <button type="button" class="link-btn" data-action="toggle-schedule-detail" data-id="${item.id}">${
    open ? "收起" : "详情"
  }</button>
      </div>
    </div>
    ${open ? `<div class="schedule-expand">${renderScheduleDetail(item)}</div>` : ""}
  </article>`;
}

function renderSchedules() {
  renderScheduleIntro();
  const list = $("#schedule-list");
  if (!list) return;
  const pager = $("#schedule-pager");
  if (!state.schedules.length) {
    list.innerHTML = emptyState(
      "还没有计划任务",
      "点「新建任务」，选做什么、选什么时候，三步就能建好。",
      `<button class="btn primary" data-action="new-schedule">新建任务</button>`
    );
    if (pager) pager.innerHTML = "";
    return;
  }
  const active = state.schedules.filter((item) => item.enabled || item.running);
  const paused = state.schedules.filter((item) => !item.enabled && !item.running);
  const block = (title, items) =>
    items.length
      ? `<div class="schedule-group"><div class="group-label">${title} <span class="n">${items.length}</span></div>
          <div class="card" style="margin-bottom:18px">${items.map(renderScheduleCard).join("")}</div></div>`
      : "";
  list.innerHTML = block("启用中", active) + block("已暂停", paused);
  if (pager) {
    pager.innerHTML = pagerHtml(
      "schedules",
      state.schedulePage,
      PAGE_SIZE.schedules,
      state.scheduleTotal
    );
  }
}

function wizardWhenSentence(wizard) {
  if (wizard.when !== "custom") {
    const preset = SCHEDULE_WHENS.find((item) => item.key === wizard.when);
    return preset ? preset.sentence : "每天早上 09:00";
  }
  const custom = wizard.custom;
  if (custom.mode === "interval") {
    const hours = Math.max(1, Math.round(Number(custom.interval_hours) || 6));
    return `每 ${hours} 小时`;
  }
  const days = custom.weekdays;
  let dayText = "每天";
  if (days.length === 5 && days.join(",") === "0,1,2,3,4") dayText = "工作日";
  else if (days.length) dayText = days.map((day) => `周${WEEKDAY_SHORT[day]}`).join("、");
  return `${dayText} ${custom.time_of_day || "09:00"}`;
}

function wizardAutoName(wizard) {
  const short = { publish: "发一篇", chain: "找选题→写草稿→发布", mine: "找选题" }[wizard.what];
  return `${wizardWhenSentence(wizard)} · ${short}`;
}

function openScheduleWizard() {
  const prefs = schedulePrefs();
  const wizard = {
    step: 1,
    what: "chain",
    platform: "xiaohongshu",
    when: "morning",
    custom: { mode: "time_point", time_of_day: "09:00", weekdays: [], interval_hours: 6 },
  };
  openModal(
    "新建计划任务",
    `<div class="wizard">
      <div class="wizard-steps">
        <span data-step-dot="1">1 做什么</span>
        <span data-step-dot="2">2 什么时候</span>
        <span data-step-dot="3">3 确认</span>
      </div>
      <div class="wizard-step" data-step="1">
        <p class="wizard-q">想让它做什么？</p>
        <div class="choice-grid">${SCHEDULE_WHATS.map(
          (item) =>
            `<button type="button" class="choice${item.key === wizard.what ? " on" : ""}" data-what="${item.key}">
              <strong>${esc(item.title)}</strong><span>${esc(item.desc)}</span></button>`
        ).join("")}</div>
        <div class="wizard-platform">
          <label class="field-label" for="wz-platform">发布到哪个平台</label>
          <select id="wz-platform">${platformOptions(wizard.platform)}</select>
          <p class="hint">三个平台都已接入。选题任务会按所选平台抓取；生成草稿和发布会使用该平台的账号与规格。</p>
        </div>
      </div>
      <div class="wizard-step" data-step="2" hidden>
        <p class="wizard-q">什么时候做？</p>
        <div class="choice-grid compact">${SCHEDULE_WHENS.map(
          (item) =>
            `<button type="button" class="choice${item.key === wizard.when ? " on" : ""}" data-when="${item.key}">
              <strong>${esc(item.title)}</strong><span>${esc(item.desc)}</span></button>`
        ).join("")}
          <button type="button" class="choice more" data-when="custom">
            <strong>更多方式</strong><span>指定星期几或间隔小时</span></button>
        </div>
        <div class="wizard-custom" id="wz-custom" hidden>
          <div class="seg" id="wz-mode">
            <button type="button" data-mode="time_point" class="active">按时间</button>
            <button type="button" data-mode="interval">按间隔</button>
          </div>
          <div id="wz-time-box">
            <label class="field-label">几点</label>
            <input id="wz-time" type="time" value="${wizard.custom.time_of_day}" />
            ${weekdayPicker([], "wz-weekdays")}
            <p class="hint">不选星期几就是每天。</p>
          </div>
          <div id="wz-interval-box" hidden>
            <label class="field-label">每隔几小时</label>
            <input id="wz-hours" type="number" min="1" max="24" step="1" value="6" />
          </div>
        </div>
      </div>
      <div class="wizard-step" data-step="3" hidden>
        <p class="wizard-q">确认一下</p>
        <div class="wizard-summary">
          <div class="line"><span>做什么</span><strong id="wz-sum-what"></strong></div>
          <div class="line"><span>什么时候</span><strong id="wz-sum-when"></strong></div>
          <div class="line"><span>任务名</span><input id="wz-name" type="text" /></div>
        </div>
        <div class="notice">到点默认只准备内容，等你在任务详情里确认；想直接发，之后可开启「全自动」。</div>
      </div>
    </div>`,
    `<button class="btn ghost" id="wz-back" hidden>上一步</button>
     <button class="btn ghost" data-action="close-modal">取消</button>
     <button class="btn primary" id="wz-next">下一步</button>`
  );

  const steps = $$(".wizard-step", $("#modal-body"));
  const paint = () => {
    steps.forEach((node) => {
      node.hidden = Number(node.dataset.step) !== wizard.step;
    });
    $$("[data-step-dot]", $("#modal-body")).forEach((node) => {
      node.classList.toggle("on", Number(node.dataset.stepDot) <= wizard.step);
    });
    $("#wz-back").hidden = wizard.step === 1;
    $("#wz-next").textContent = wizard.step === SCHEDULE_WIZARD_STEPS ? "完成" : "下一步";
    if (wizard.step === 3) {
      const what = SCHEDULE_WHATS.find((item) => item.key === wizard.what);
      $("#wz-sum-what").textContent = what ? what.title : "";
      $("#wz-sum-when").textContent = wizardWhenSentence(wizard);
      if (!wizard.nameTouched) $("#wz-name").value = wizardAutoName(wizard);
    }
  };
  paint();

  $$("[data-what]", $("#modal-body")).forEach((button) => {
    button.addEventListener("click", () => {
      wizard.what = button.dataset.what;
      $$("[data-what]", $("#modal-body")).forEach((node) =>
        node.classList.toggle("on", node === button)
      );
    });
  });
  $$("[data-when]", $("#modal-body")).forEach((button) => {
    button.addEventListener("click", () => {
      wizard.when = button.dataset.when;
      $$("[data-when]", $("#modal-body")).forEach((node) =>
        node.classList.toggle("on", node === button)
      );
      $("#wz-custom").hidden = wizard.when !== "custom";
    });
  });
  $("#wz-mode").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-mode]");
    if (!button) return;
    $$("#wz-mode button").forEach((node) => node.classList.toggle("active", node === button));
    wizard.custom.mode = button.dataset.mode;
    $("#wz-time-box").hidden = wizard.custom.mode !== "time_point";
    $("#wz-interval-box").hidden = wizard.custom.mode !== "interval";
  });
  $("#wz-time").addEventListener("input", () => {
    wizard.custom.time_of_day = $("#wz-time").value || "09:00";
  });
  $("#wz-hours").addEventListener("input", () => {
    wizard.custom.interval_hours = Number($("#wz-hours").value || 6);
  });
  $("#wz-weekdays").addEventListener("click", (event) => {
    const day = event.target.closest("button[data-day]");
    if (!day) return;
    day.classList.toggle("on");
    wizard.custom.weekdays = $$("#wz-weekdays button.on")
      .map((node) => Number(node.dataset.day))
      .sort((a, b) => a - b);
  });
  $("#wz-name").addEventListener("input", () => {
    wizard.nameTouched = true;
  });
  $("#wz-platform").addEventListener("change", (event) => {
    wizard.platform = event.target.value || "xiaohongshu";
  });
  $("#wz-back").addEventListener("click", () => {
    wizard.step = Math.max(1, wizard.step - 1);
    paint();
  });
  $("#wz-next").addEventListener("click", async () => {
    if (wizard.step < SCHEDULE_WIZARD_STEPS) {
      wizard.step += 1;
      paint();
      return;
    }
    const button = $("#wz-next");
    setButtonLoading(button, true, "创建中");
    try {
      const when =
        wizard.when === "custom"
          ? {
              trigger_type: wizard.custom.mode,
              time_of_day: $("#wz-time").value || "09:00",
              weekdays: $$("#wz-weekdays button.on").map((node) => Number(node.dataset.day)),
              interval_minutes: Math.max(5, Math.round((Number($("#wz-hours").value) || 6) * 60)),
            }
          : wizard.when;
      const created = await api("/api/schedules/quick", {
        method: "POST",
        body: {
          what: wizard.what,
          platform: wizard.platform,
          when,
          name: ($("#wz-name").value || "").trim(),
          tone: prefs.tone || "",
          card_style: prefs.card_style || "",
        },
      });
      closeModal();
      toast(`已创建，${created.trigger_label} 开始执行`);
      state.scheduleOpen.add(created.id);
      state.schedulePage = 1;
      await refreshSchedules();
      await refreshOverview();
    } catch (error) {
      toast(error.message, true);
    } finally {
      setButtonLoading(button, false);
    }
  });
}

function scheduleAccountChecks(selected, platform) {
  const ids = new Set((selected || []).map(Number));
  const accounts = enabledAccounts().filter((account) => !platform || account.platform === platform);
  if (!accounts.length) return `<span class="hint">该平台还没有启用账号，发布会自动跳过。</span>`;
  return `<div class="account-checks">${accounts
    .map(
      (account) =>
        `<label class="check"><input type="checkbox" class="sc-account" value="${account.id}" ${
          ids.has(account.id) ? "checked" : ""
        }/> ${esc(account.nickname || account.name)}</label>`
    )
    .join("")}</div>`;
}

function scheduleAccountSelect(id, selected, platform) {
  return `<select id="${id}"><option value="">自动选择</option>${enabledAccounts()
    .filter((account) => !platform || account.platform === platform)
    .map(
      (account) =>
        `<option value="${account.id}" ${Number(selected) === account.id ? "selected" : ""}>${esc(
          account.nickname || account.name
        )}</option>`
    )
    .join("")}</select>`;
}

function weekdayPicker(days, pickerId = "sc-weekdays") {
  const chosen = new Set((days || []).map(Number));
  return `<div class="weekday-picker" id="${pickerId}">${WEEKDAY_SHORT.map(
    (name, index) =>
      `<button type="button" data-day="${index}" class="${chosen.has(index) ? "on" : ""}">${name}</button>`
  ).join("")}</div>`;
}

function scheduleMineFields(cfg, platform) {
  const mode = cfg.mode || "keyword";
  return `
    <div class="form-row"><label>挖掘方式</label>
      <select id="sc-mode">
        <option value="keyword" ${mode === "keyword" ? "selected" : ""}>关键词</option>
        <option value="competitor" ${mode === "competitor" ? "selected" : ""}>竞品账号</option>
        <option value="trending" ${mode === "trending" ? "selected" : ""}>站内热榜</option>
      </select></div>
    <div class="form-row"><label>关键词（逗号分隔）</label>
      <input id="sc-keywords" type="text" value="${esc((cfg.keywords || []).join(", "))}"
        placeholder="面试, 秋招, 自我介绍" /></div>
    <div class="form-row"><label>竞品主页链接（每行一个）</label>
      <textarea id="sc-urls" rows="3" placeholder="https://www.xiaohongshu.com/user/profile/...">${esc(
        (cfg.user_urls || []).join("\n")
      )}</textarea></div>
    <div class="form-grid">
      <div class="form-row"><label>每词抓取</label>
        <input id="sc-per-kw" type="number" min="5" max="50" value="${cfg.per_kw || 20}" /></div>
      <div class="form-row"><label>总上限</label>
        <input id="sc-limit-mine" type="number" min="5" max="100" value="${cfg.limit || 30}" /></div>
      <div class="form-row"><label>补正文条数</label>
        <input id="sc-detail" type="number" min="0" max="20" value="${cfg.detail_limit || 5}" /></div>
      <div class="form-row"><label>最低入池评分</label>
        <input id="sc-min-score" type="number" min="0" max="100" value="${cfg.min_score || 0}" /></div>
    </div>
    <div class="form-row"><label>使用账号（留空自动选健康账号）</label>
      ${scheduleAccountSelect("sc-account-mine", cfg.account_id, platform)}</div>
    <label class="check"><input type="checkbox" id="sc-product" ${cfg.product ? "checked" : ""}/> 这批选题带产品</label>
    <p class="hint">低于阈值的选题会直接丢弃，可在选题页的「已丢弃」里找回。</p>`;
}

function scheduleChainDraftFields(cfg) {
  const styleOptions = (state.designStyles || [])
    .map(
      (item) =>
        `<option value="${item.key}" ${cfg.card_style === item.key ? "selected" : ""}>${esc(item.name)} · ${esc(
          item.tagline
        )}</option>`
    )
    .join("");
  return `
    <div class="form-grid">
      <div class="form-row"><label>每次生成（篇）</label>
        <input id="sc-from-pool" type="number" min="1" max="5" value="${cfg.from_pool || 1}" /></div>
      <div class="form-row"><label>语气</label>
        <select id="sc-tone">${["", ...Object.keys(TONE_OPTIONS)]
          .map(
            (key) =>
              `<option value="${key}" ${(cfg.tone || "") === key ? "selected" : ""}>${
                key ? TONE_OPTIONS[key] : "跟随选题 / 默认"
              }</option>`
          )
          .join("")}</select></div>
    </div>
    <label class="check"><input type="checkbox" id="sc-with-cards" ${
      cfg.with_cards === false ? "" : "checked"
    }/> 同时生成免费配图</label>
    <div class="form-row" id="sc-card-style-row" ${cfg.with_cards === false ? "hidden" : ""}>
      <label>配图风格</label>
      <select id="sc-card-style">${styleOptions}</select></div>
    <label class="check"><input type="checkbox" id="sc-use-llm" ${
      cfg.use_llm === false ? "" : "checked"
    }/> 允许调用文案模型（关闭则用离线模板）</label>`;
}

function scheduleKindFields(kind, config, platform) {
  const cfg = config || {};
  if (kind === "publish") {
    const ids = (cfg.draft_ids || []).join(", ");
    const visibility = Number(cfg.visibility) === 0 ? 0 : 1;
    const visibilityOptions =
      platform === "wechat_mp"
        ? `<option value="1" ${visibility === 1 ? "selected" : ""}>先存草稿（不推送）</option>
           <option value="0" ${visibility === 0 ? "selected" : ""}>立即发布（推送给关注者）</option>`
        : `<option value="1" ${visibility === 1 ? "selected" : ""}>仅自己可见（测试推荐）</option>
           <option value="0" ${visibility === 0 ? "selected" : ""}>公开</option>`;
    return `
      <div class="form-row"><label>草稿来源</label>
        <select id="sc-draft-mode">
          <option value="ready" ${ids ? "" : "selected"}>自动挑选待发布草稿</option>
          <option value="ids" ${ids ? "selected" : ""}>指定草稿 ID</option>
        </select>
        <div class="desc">自动挑选会取内容库里最新的待发布草稿，命中合规或缺配图的会跳过。</div></div>
      <div class="form-row" id="sc-drafts-row" ${ids ? "" : "hidden"}>
        <label>草稿 ID（逗号分隔）</label>
        <input id="sc-draft-ids" type="text" value="${esc(ids)}" placeholder="6, 7" /></div>
      <div class="form-row" id="sc-limit-row" ${ids ? "hidden" : ""}>
        <label>每次最多发布（篇）</label>
        <input id="sc-limit" type="number" min="1" max="20" value="${cfg.limit || 3}" /></div>
      <div class="form-row"><label>发布账号（不选则按限额自动轮换）</label>
        ${scheduleAccountChecks(cfg.account_ids, platform)}</div>
      <div class="form-row"><label>${platform === "wechat_mp" ? "发布方式" : "可见范围"}</label>
        <select id="sc-visibility">${visibilityOptions}</select>
        <div class="desc">${
          platform === "wechat_mp"
            ? "先存草稿不会打扰关注者；立即发布每天只有 1 次机会。"
            : "真实发布前先用「仅自己可见」验证链路；全自动未开启时只准备待确认清单。"
        }</div></div>`;
  }
  if (kind === "mine") return scheduleMineFields(cfg, platform);
  if (kind === "chain") return scheduleMineFields(cfg, platform) + scheduleChainDraftFields(cfg);
  const ids = (cfg.topic_ids || []).join(", ");
  const styleOptions = (state.designStyles || [])
    .map(
      (item) =>
        `<option value="${item.key}" ${cfg.card_style === item.key ? "selected" : ""}>${esc(item.name)} · ${esc(
          item.tagline
        )}</option>`
    )
    .join("");
  return `
    <div class="form-row"><label>选题来源</label>
      <select id="sc-topic-mode">
        <option value="pool" ${ids ? "" : "selected"}>选题池里评分最高的</option>
        <option value="ids" ${ids ? "selected" : ""}>指定选题 ID</option>
      </select></div>
    <div class="form-row" id="sc-from-pool-row" ${ids ? "hidden" : ""}>
      <label>每次生成（篇）</label>
      <input id="sc-from-pool" type="number" min="1" max="10" value="${cfg.from_pool || 5}" /></div>
    <div class="form-row" id="sc-topic-ids-row" ${ids ? "" : "hidden"}>
      <label>选题 ID（逗号分隔）</label>
      <input id="sc-topic-ids" type="text" value="${esc(ids)}" placeholder="1, 2, 3" /></div>
    <div class="form-grid">
      <div class="form-row"><label>语气</label>
        <select id="sc-tone">${["", ...Object.keys(TONE_OPTIONS)]
          .map(
            (key) =>
              `<option value="${key}" ${(cfg.tone || "") === key ? "selected" : ""}>${
                key ? TONE_OPTIONS[key] : "跟随选题 / 默认"
              }</option>`
          )
          .join("")}</select></div>
      <div class="form-row"><label>每题变体</label>
        <input id="sc-variants" type="number" min="1" max="3" value="${cfg.variants || 1}" /></div>
    </div>
    <div class="form-row"><label>生成账号（留空不绑定）</label>
      ${scheduleAccountSelect("sc-account-draft", cfg.account_id, platform)}</div>
    <label class="check"><input type="checkbox" id="sc-with-cards" ${cfg.with_cards ? "checked" : ""}/> 同时生成免费配图</label>
    <div class="form-row" id="sc-card-style-row" ${cfg.with_cards ? "" : "hidden"}>
      <label>配图风格</label>
      <select id="sc-card-style">${styleOptions}</select></div>
    <label class="check"><input type="checkbox" id="sc-use-llm" ${
      cfg.use_llm === false ? "" : "checked"
    }/> 允许调用文案模型（关闭则用离线模板）</label>`;
}

function bindScheduleConfigEvents() {
  const draftMode = $("#sc-draft-mode");
  if (draftMode) {
    draftMode.addEventListener("change", () => {
      const byIds = draftMode.value === "ids";
      $("#sc-drafts-row").hidden = !byIds;
      $("#sc-limit-row").hidden = byIds;
    });
  }
  const topicMode = $("#sc-topic-mode");
  if (topicMode) {
    topicMode.addEventListener("change", () => {
      const byIds = topicMode.value === "ids";
      $("#sc-topic-ids-row").hidden = !byIds;
      $("#sc-from-pool-row").hidden = byIds;
    });
  }
  const cards = $("#sc-with-cards");
  if (cards) {
    cards.addEventListener("change", () => {
      $("#sc-card-style-row").hidden = !cards.checked;
    });
  }
}

function syncScheduleForm(trigger) {
  $("#sc-time-row").hidden = trigger !== "time_point";
  $("#sc-interval-row").hidden = trigger !== "interval";
}

function collectSchedulePayload() {
  const kind = $("#sc-kind").value;
  const trigger = $("#sc-trigger button.active").dataset.trigger;
  const payload = {
    name: $("#sc-name").value.trim(),
    kind,
    platform: $("#sc-platform").value,
    trigger_type: trigger,
    time_of_day: $("#sc-time").value || "09:00",
    weekdays: $$("#sc-weekdays button.on").map((button) => Number(button.dataset.day)),
    interval_minutes: Number($("#sc-interval").value || 360),
    auto: $("#sc-auto").checked,
    enabled: $("#sc-enabled").checked,
    config: {},
  };
  const config = {};
  if (kind === "publish") {
    config.account_ids = $$(".sc-account:checked").map((node) => Number(node.value));
    config.visibility = Number($("#sc-visibility").value);
    if ($("#sc-draft-mode").value === "ids") {
      config.draft_ids = String($("#sc-draft-ids").value || "")
        .split(/[,，\s]+/)
        .map(Number)
        .filter(Boolean);
    } else {
      config.limit = Number($("#sc-limit").value || 3);
    }
  } else if (kind === "mine") {
    config.mode = $("#sc-mode").value;
    config.keywords = String($("#sc-keywords").value || "")
      .split(/[,，]/)
      .map((item) => item.trim())
      .filter(Boolean);
    config.user_urls = String($("#sc-urls").value || "")
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
    config.per_kw = Number($("#sc-per-kw").value || 20);
    config.limit = Number($("#sc-limit-mine").value || 30);
    config.detail_limit = Number($("#sc-detail").value || 5);
    config.min_score = Number($("#sc-min-score").value || 0);
    config.product = $("#sc-product").checked;
    config.account_id = $("#sc-account-mine").value || null;
  } else if (kind === "chain") {
    config.mode = $("#sc-mode").value;
    config.keywords = String($("#sc-keywords").value || "")
      .split(/[,，]/)
      .map((item) => item.trim())
      .filter(Boolean);
    config.user_urls = String($("#sc-urls").value || "")
      .split(/\r?\n/)
      .map((item) => item.trim())
      .filter(Boolean);
    config.per_kw = Number($("#sc-per-kw").value || 20);
    config.limit = Number($("#sc-limit-mine").value || 30);
    config.detail_limit = Number($("#sc-detail").value || 5);
    config.min_score = Number($("#sc-min-score").value || 0);
    config.product = $("#sc-product").checked;
    config.account_id = $("#sc-account-mine").value || null;
    config.from_pool = Number($("#sc-from-pool").value || 1);
    config.tone = $("#sc-tone").value;
    config.variants = 1;
    config.with_cards = $("#sc-with-cards").checked;
    config.card_style = $("#sc-card-style").value;
    config.use_llm = $("#sc-use-llm").checked;
  } else {
    if ($("#sc-topic-mode").value === "ids") {
      config.topic_ids = String($("#sc-topic-ids").value || "")
        .split(/[,，\s]+/)
        .map(Number)
        .filter(Boolean);
    } else {
      config.from_pool = Number($("#sc-from-pool").value || 5);
    }
    config.tone = $("#sc-tone").value;
    config.variants = Number($("#sc-variants").value || 1);
    config.with_cards = $("#sc-with-cards").checked;
    config.card_style = $("#sc-card-style").value;
    config.use_llm = $("#sc-use-llm").checked;
    config.account_id = $("#sc-account-draft").value || null;
  }
  payload.config = config;
  return payload;
}

function openScheduleEditor(schedule) {
  const item = schedule || {
    id: null,
    name: "",
    kind: "mine",
    enabled: true,
    auto: false,
    trigger_type: "interval",
    time_of_day: "09:00",
    weekdays: [],
    interval_minutes: 360,
    platform: "xiaohongshu",
    config: {},
  };
  const platform = item.platform || "xiaohongshu";
  const trigger = item.trigger_type === "time_point" ? "time_point" : "interval";
  openModal(
    schedule ? `编辑计划任务 #${schedule.id}` : "新建计划任务",
    `<div class="schedule-form">
      <div class="form-row"><label>任务名称</label>
        <input id="sc-name" type="text" value="${esc(item.name)}" placeholder="每天 9 点挖面试选题" /></div>
      <div class="form-row"><label>发布到哪个平台</label>
        <select id="sc-platform">${platformOptions(platform)}</select></div>
      <div class="form-row"><label>任务类型</label>
        <select id="sc-kind">${Object.entries(SCHEDULE_KIND_LABEL)
          .map(
            ([key, label]) =>
              `<option value="${key}" ${item.kind === key ? "selected" : ""}>${label}</option>`
          )
          .join("")}</select>
        <div class="desc">三类任务可以单独跑，也可以串成链路：找选题 → 生成草稿 → 发布。</div></div>
      <div class="form-row"><label>触发方式</label>
        <div class="seg" id="sc-trigger">
          <button type="button" data-trigger="time_point" class="${trigger === "time_point" ? "active" : ""}">固定时间点</button>
          <button type="button" data-trigger="interval" class="${trigger === "interval" ? "active" : ""}">固定间隔</button>
        </div></div>
      <div class="form-row" id="sc-time-row">
        <label>执行时间</label>
        <input id="sc-time" type="time" value="${esc(item.time_of_day || "09:00")}" />
        ${weekdayPicker(item.weekdays || [])}
        <div class="desc">不选星期几表示每天执行。</div></div>
      <div class="form-row" id="sc-interval-row">
        <label>间隔（分钟）</label>
        <input id="sc-interval" type="number" min="5" step="5" value="${item.interval_minutes || 360}" />
        <div class="desc">360 = 每 6 小时；服务重启后按原节奏顺延，不会丢任务。</div></div>
      <div id="sc-config">${scheduleKindFields(item.kind, item.config, platform)}</div>
      <div class="schedule-gate">
        <label class="check"><input type="checkbox" id="sc-auto" ${item.auto ? "checked" : ""}/> 全自动（无人确认直接发布）</label>
        <p class="hint">默认关闭：到点只准备草稿，需在运行记录里点「确认发布」。开启后命中合规/风控或连续失败会自动暂停任务。</p>
      </div>
      <label class="check"><input type="checkbox" id="sc-enabled" ${item.enabled ? "checked" : ""}/> 启用这个任务</label>
    </div>`,
    `<button class="btn ghost" data-action="close-modal">取消</button>
     <button class="btn primary" id="btn-schedule-save">保存</button>`
  );
  syncScheduleForm(trigger);
  bindScheduleConfigEvents();

  $("#sc-weekdays").addEventListener("click", (event) => {
    const day = event.target.closest("button[data-day]");
    if (day) day.classList.toggle("on");
  });
  $$("#sc-trigger button").forEach((button) => {
    button.addEventListener("click", () => {
      $$("#sc-trigger button").forEach((node) => node.classList.toggle("active", node === button));
      syncScheduleForm(button.dataset.trigger);
    });
  });
  $("#sc-kind").addEventListener("change", () => {
    const kind = $("#sc-kind").value;
    $("#sc-config").innerHTML = scheduleKindFields(kind, {}, $("#sc-platform").value);
    bindScheduleConfigEvents();
  });
  $("#sc-platform").addEventListener("change", () => {
    const kind = $("#sc-kind").value;
    $("#sc-config").innerHTML = scheduleKindFields(kind, {}, $("#sc-platform").value);
    bindScheduleConfigEvents();
  });
  $("#btn-schedule-save").addEventListener("click", async () => {
    let payload;
    try {
      payload = collectSchedulePayload();
    } catch (error) {
      toast(error.message, true);
      return;
    }
    if (!payload.name) {
      toast("任务名称不能为空", true);
      $("#sc-name").classList.add("invalid");
      $("#sc-name").focus();
      return;
    }
    if (payload.kind === "mine" && payload.config.mode === "keyword" && !payload.config.keywords.length) {
      toast("关键词挖掘至少填一个关键词", true);
      return;
    }
    if (
      payload.kind === "chain" &&
      payload.config.mode === "keyword" &&
      !payload.config.keywords.length
    ) {
      toast("关键词挖掘至少填一个关键词", true);
      return;
    }
    const button = $("#btn-schedule-save");
    setButtonLoading(button, true, "保存中");
    try {
      if (item.id) {
        await api(`/api/schedules/${item.id}`, { method: "PATCH", body: payload });
      } else {
        await api("/api/schedules", { method: "POST", body: payload });
      }
      if (payload.kind === "draft" || payload.kind === "chain") {
        rememberSchedulePrefs({
          tone: payload.config.tone || "",
          card_style: payload.config.card_style || "",
        });
      }
      toast(item.id ? "任务已更新" : "任务已创建");
      closeModal();
      await refreshSchedules();
      await refreshOverview();
    } catch (error) {
      toast(error.message, true);
    } finally {
      setButtonLoading(button, false);
    }
  });
}

/* ------------------------------------------------------------------ 账号 */

function accountLimit(account) {
  if (account.daily_limit) return account.daily_limit;
  return Number((state.settings && state.settings.values.publish_daily_limit) || 3);
}

function accountInterval(account) {
  const seconds =
    account.min_interval_sec ||
    Number((state.settings && state.settings.values.publish_min_interval_sec) || 2700);
  return `${Math.round(seconds / 60)} 分钟`;
}

function statusBadge(status) {
  if (status === "healthy") return badge("正常", "ok");
  if (status === "expired") return badge("登录失效", "bad");
  if (status === "unknown") return badge("待检查", "warn");
  return badge("未知", "");
}

/* 账号头像：平台巡检拿到头像地址就显示图片，否则回退到平台色块/昵称首字。 */
function accountAvatarImage(account, cls, size, radius) {
  const url = String((account && account.avatar) || "");
  if (!/^https?:\/\//i.test(url)) return "";
  return `<img class="${cls}" src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" style="width:${size}px;height:${size}px;border-radius:${radius}px;object-fit:cover;display:block" />`;
}

function renderAccounts() {
  const grid = $("#account-grid");
  if (!grid) return;
  const count = $("#account-total");
  if (count) {
    const enabled = state.accounts.filter((account) => account.enabled).length;
    const total = state.accountTotal || state.accounts.length;
    count.textContent = total ? `共 ${total} 个 · 启用 ${enabled}` : "";
  }
  renderAccountGroupFilter();
  renderAccountBatchBar();
  if (!state.accounts.length) {
    grid.classList.add("is-empty");
    grid.innerHTML = emptyState(
      state.accountGroupFilter ? "这个分组还没有账号" : "还没有账号",
      "可以扫码登录，也可以粘贴浏览器里的登录信息（Cookie）。账号只用于维持发布能力。",
      `<button class="btn small primary" data-action="add-account">添加账号</button>`
    );
    return;
  }
  grid.classList.remove("is-empty");
  grid.innerHTML = state.accounts
    .map((account) => {
      const name = account.nickname || account.name;
      const cooldown = Number(account.cooldown_until || 0) > Math.floor(Date.now() / 1000);
      const plat = PLAT_TAGS[account.platform] || { cls: "", text: String(name || "账").slice(0, 1) };
      const sub = `${platformName(account.platform)} · ${
        account.group_name || account.red_id || account.tags?.[0] || "未分组"
      }`;
      const statusMeta =
        account.status === "healthy"
          ? ["正常", "ok"]
          : account.status === "expired"
          ? ["需重登", "bad"]
          : account.status === "unknown"
          ? ["待检查", "warn"]
          : ["未知", ""];
      const footText = !account.enabled
        ? "已停用，不参与发布"
        : cooldown
        ? `风控冷却至 ${fmtTime(account.cooldown_until)}`
        : account.last_error || account.group_name || "登录有效，可参与发布";
      return `<article class="card account-card${account.enabled ? "" : " off"}${
        state.accountPicked.has(account.id) ? " picked" : ""
      }">
        <div class="acc-top">
          ${
            state.accountBatch
              ? `<input type="checkbox" class="account-pick" data-account-pick="${account.id}" ${
                  state.accountPicked.has(account.id) ? "checked" : ""
                } aria-label="选择账号" />`
              : ""
          }
          ${
            accountAvatarImage(account, "plat", 34, 9) ||
            `<span class="plat ${plat.cls}" style="width:34px;height:34px;border-radius:9px;font-size:14px">${esc(
              plat.text
            )}</span>`
          }
          <div class="info">
            <b>${esc(name)}</b>
            <span>${esc(sub)}</span>
          </div>
          <span class="pill ${statusMeta[1]}">${statusMeta[0]}</span>
          <details class="card-more">
            <summary title="更多操作" aria-label="更多操作">⋯</summary>
            <div class="card-more-menu">
              <button type="button" data-action="open-account" data-id="${account.id}">账号详情</button>
              <button type="button" data-action="edit-account" data-id="${account.id}">发布设置</button>
              <button type="button" data-action="test-account-proxy" data-id="${account.id}">测试代理</button>
              <button type="button" data-action="toggle-account" data-id="${account.id}" data-enabled="${
                account.enabled ? 1 : 0
              }">${account.enabled ? "停用账号" : "启用账号"}</button>
              <button type="button" class="danger" data-action="delete-account" data-id="${account.id}">删除账号</button>
            </div>
          </details>
        </div>
        <div class="acc-stats">
          <div class="acc-stat"><div class="n">${account.published_today || 0} / ${accountLimit(
        account
      )}</div><div class="l">今日发布</div></div>
          <div class="acc-stat"><div class="n">${esc(accountInterval(account))}</div><div class="l">最小间隔</div></div>
          <div class="acc-stat"><div class="n">${esc(relTime(account.health_checked_at))}</div><div class="l">最近巡检</div></div>
        </div>
        <div class="acc-foot">
          <span${cooldown || account.last_error ? ' style="color:var(--warn)"' : ""}>${esc(footText)}</span>
          <span class="spacer"></span>
          <button class="link-btn" type="button" data-action="check-account" data-id="${account.id}">${
        account.status === "expired" ? "重新登录" : "检查"
      }</button>
          <button class="link-btn" type="button" data-action="open-account" data-id="${account.id}">详情</button>
        </div>
      </article>`;
    })
    .join("");
}

function renderAccountGroupFilter() {
  const select = $("#account-group-filter");
  if (!select) return;
  const groups = state.accountGroups || [];
  select.innerHTML =
    `<option value="">全部分组</option>` +
    groups
      .map(
        (group) =>
          `<option value="${esc(group)}" ${
            state.accountGroupFilter === group ? "selected" : ""
          }>${esc(group)}</option>`
      )
      .join("");
}

function renderAccountBatchBar() {
  const bar = $("#account-batch-bar");
  const toggle = $("#btn-account-batch");
  if (!bar || !toggle) return;
  bar.hidden = !state.accountBatch;
  toggle.setAttribute("aria-pressed", String(state.accountBatch));
  toggle.textContent = state.accountBatch ? "退出批量" : "批量操作";
  const count = $("#account-selected-count");
  if (count) count.textContent = `已选 ${state.accountPicked.size} 个`;
}

async function refreshPlatforms() {
  state.platforms = await api("/api/platforms");
  const select = $("#draft-platform-filter");
  if (select) {
    select.innerHTML = platformOptions(state.draftPlatformFilter, { includeAll: true });
  }
  refreshStudioUI();
}

async function refreshAccounts() {
  const query = state.accountGroupFilter
    ? `?group=${encodeURIComponent(state.accountGroupFilter)}`
    : "";
  state.accounts = await api(`/api/accounts${query}`);
  state.accountTotal = lastMeta.total == null ? state.accounts.length : lastMeta.total;
  try {
    state.accountGroups = await api("/api/accounts/groups");
  } catch (error) {
    state.accountGroups = [];
  }
  renderAccounts();
  renderAccountOptions();
  renderAccountChips();
  renderPreview();
  const publishedSelect = $("#published-account-filter");
  if (publishedSelect) {
    publishedSelect.innerHTML =
      `<option value="">全部账号</option>` +
      state.accounts
        .map(
          (account) =>
            `<option value="${account.id}" ${
              String(state.publishedAccountId) === String(account.id) ? "selected" : ""
            }>${esc(account.nickname || account.name)}</option>`
        )
        .join("");
  }
}

/* ------------------------------------------------------------------ 账号详情抽屉 */

async function openAccountDrawer(accountId) {
  const drawer = $("#account-drawer");
  const mask = $("#drawer-mask");
  const body = $("#drawer-body");
  if (!drawer || !body) return;
  state.accountDrawerId = Number(accountId);
  drawer.hidden = false;
  mask.hidden = false;
  document.body.classList.add("drawer-open");
  $("#drawer-title").textContent = "账号详情";
  body.innerHTML = `<div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line w60"></div><div class="skeleton skeleton-line"></div>`;
  try {
    const data = await api(`/api/accounts/${accountId}/diagnose`);
    if (state.accountDrawerId !== Number(accountId)) return;
    renderAccountDrawer(data);
  } catch (error) {
    body.innerHTML = `<p class="hint">${esc(error.message)}</p>`;
  }
}

function closeAccountDrawer() {
  const drawer = $("#account-drawer");
  const mask = $("#drawer-mask");
  if (drawer) drawer.hidden = true;
  if (mask) mask.hidden = true;
  state.accountDrawerId = null;
  document.body.classList.remove("drawer-open");
}

function renderAccountDrawer(data) {
  const body = $("#drawer-body");
  if (!body) return;
  const account = data.account || {};
  const publish = data.publish || {};
  const env = data.environment || {};
  const sync = data.sync || {};
  const name = account.nickname || account.name || "账号";
  $("#drawer-title").textContent = name;
  const checklist = (data.checklist || [])
    .map(
      (item) => `<li class="${item.ok ? "ok" : "bad"}">
        <span>${item.ok ? "✓" : "!"}</span>
        <div><b>${esc(item.label)}</b><small>${esc(item.hint || "")}</small></div>
      </li>`
    )
    .join("");
  const riskText = {
    rate_limited: "平台限流",
    exit_changed: "出口变化",
    manual_release: "人工解除",
  };
  const riskRows = (data.risk_events || []).length
    ? data.risk_events
        .map(
          (item) => `<div class="timeline-row">
            <b>${esc(riskText[item.type] || item.type)}</b>
            <small>${esc(item.reason || "")}</small>
            <em>${esc(fmtTime(item.started_at))}${
              item.ended_at ? ` · 已结束 ${esc(fmtTime(item.ended_at))}` : " · 进行中"
            }</em>
          </div>`
        )
        .join("")
    : `<p class="hint">没有风控记录。</p>`;
  const recordRows = (data.recent_records || []).length
    ? data.recent_records
        .map((item) => {
          const evidence = item.evidence || {};
          const links = [];
          if (evidence.screenshot) {
            links.push(
              `<a class="evidence-link" href="/evidence/${encodeURIComponent(
                evidence.screenshot
              )}" target="_blank" rel="noopener">查看现场截图</a>`
            );
          }
          if (evidence.dom) {
            links.push(
              `<a class="evidence-link" href="/evidence/${encodeURIComponent(
                evidence.dom
              )}">下载 DOM 快照</a>`
            );
          }
          return `<div class="timeline-row">
            <b>${item.success ? "发布成功" : "发布失败"}</b>
            <small>${esc(item.message || "")}</small>
            <em>${esc(fmtTime(item.created_at))}</em>
            ${links.length ? `<div class="evidence-links">${links.join("")}</div>` : ""}
          </div>`;
        })
        .join("")
    : `<p class="hint">还没有发布记录。</p>`;
  body.innerHTML = `
    <div class="drawer-tags">
      ${platformBadge(account.platform)}
      ${statusBadge(account.status)}
      ${badge(account.health_state_text || "未判断", account.health_state === "healthy" ? "ok" : account.health_state === "risk" ? "warn" : "")}
      ${account.group_name ? `<span class="mini-tag">${esc(account.group_name)}</span>` : ""}
      ${(account.tags || []).map((tag) => `<span class="mini-tag">${esc(tag)}</span>`).join("")}
    </div>

    <section class="drawer-section">
      <h4>现在能不能发</h4>
      <div class="drawer-highlight ${publish.available ? "ok" : "warn"}">
        <b>${publish.available ? "可以发布" : "暂不可发布"}</b>
        <span>${esc(publish.reason || "")}</span>
        <small>${publish.available ? "" : `预计 ${esc(fmtTime(publish.next_available_at))} 恢复`}</small>
      </div>
      <div class="drawer-stats">
        <span><b>${publish.used_today} / ${publish.daily_limit}</b><small>今日额度</small></span>
        <span><b>${Math.round((publish.min_interval_sec || 0) / 60)} 分钟</b><small>最小间隔</small></span>
        <span><b>${data.jobs.pending_confirm || 0}</b><small>待确认</small></span>
        ${
          account.health_state === "probing"
            ? `<span><b>${account.probe_success_count || 0} / ${
                account.probe_target || 2
              }</b><small>恢复探测</small></span>`
            : ""
        }
      </div>
      <ul class="checklist">${checklist}</ul>
    </section>

    <section class="drawer-section">
      <h4>账号环境</h4>
      <div class="kv"><span>独立 Profile</span><b>${esc(env.profile_key || "自动生成")}</b></div>
      <div class="kv"><span>代理</span><b>${esc(env.proxy || "直连")}</b></div>
      <div class="kv"><span>出口</span><b>${esc(env.exit_ip || "未测试")}${
        env.exit_country ? ` · ${esc(env.exit_country)}` : ""
      }</b></div>
      <div class="kv"><span>出口检查</span><b>${esc(env.exit_checked_at ? relTime(env.exit_checked_at) : "未测试")}</b></div>
      ${(env.lanes || [])
        .map(
          (lane) => `<div class="kv"><span>${esc(lane.label)}</span><b class="${
            lane.ok ? "ok-text" : "bad-text"
          }">${lane.ok ? "可用" : "不可用"}</b><small>${esc(lane.hint || "")}</small></div>`
        )
        .join("")}
    </section>

    <section class="drawer-section">
      <h4>发布后数据</h4>
      <div class="drawer-stats">
        <span><b>${sync.published_total || 0}</b><small>已同步作品</small></span>
        <span><b>${sync.abnormal_total || 0}</b><small>需关注</small></span>
        <span><b>${esc(sync.synced_at ? relTime(sync.synced_at) : "未同步")}</b><small>最近同步</small></span>
      </div>
      ${sync.error ? `<p class="account-warning">${esc(sync.error)}</p>` : ""}
    </section>

    <section class="drawer-section">
      <h4>风控时间线</h4>
      ${riskRows}
    </section>

    <section class="drawer-section">
      <h4>最近发布</h4>
      ${recordRows}
    </section>

    <div class="drawer-actions">
      <button class="btn small ghost" data-action="check-account" data-id="${account.id}">检查登录</button>
      <button class="btn small ghost" data-action="test-account-proxy" data-id="${account.id}">测试代理</button>
      <button class="btn small ghost" data-action="clear-account-cooldown" data-id="${account.id}">解除冷却</button>
      <button class="btn small ghost" data-action="edit-account" data-id="${account.id}">发布设置</button>
    </div>`;
}

async function testAccountProxy(accountId, button) {
  setButtonLoading(button, true, "测试中");
  try {
    const data = await api(`/api/accounts/${accountId}/proxy-test`, { method: "POST" });
    toast(data.message || "代理可用", false);
    await refreshAccounts();
    if (state.accountDrawerId === Number(accountId)) openAccountDrawer(accountId);
  } catch (error) {
    toast(error.message, true);
  } finally {
    setButtonLoading(button, false);
  }
}

async function clearAccountCooldown(accountId) {
  if (!(await confirmDialog("解除冷却会立即允许该账号继续发布，确定吗？", "解除"))) return;
  try {
    await api(`/api/accounts/${accountId}/cooldown/clear`, { method: "POST" });
    toast("冷却已解除，建议先检查登录");
    await refreshAccounts();
    await refreshOverview();
    if (state.accountDrawerId === Number(accountId)) openAccountDrawer(accountId);
  } catch (error) {
    toast(error.message, true);
  }
}

function renderAccountOptions() {
  const options = ['<option value="">自动选择 / 轮换</option>']
    .concat(
      state.accounts
        .filter((account) => account.enabled)
        .map(
          (account) =>
            `<option value="${account.id}">${esc(account.nickname || account.name)}${
              account.status === "expired" ? "（失效）" : ""
            }</option>`
        )
    )
    .join("");
  ["#mine-account"].forEach((selector) => {
    const node = $(selector);
    if (!node) return;
    const current = node.value;
    node.innerHTML = options;
    node.value = current;
  });
}

function addPlatform() {
  const active = $("#add-platform .platform-choice.active");
  return (active && active.dataset.platform) || "xiaohongshu";
}

function applyAddPlatform(platform) {
  $$("#add-platform .platform-choice").forEach((button) =>
    button.classList.toggle("active", button.dataset.platform === platform)
  );
  const supportsCookie = platform === "xiaohongshu";
  $("#add-mode").hidden = !supportsCookie;
  if (!supportsCookie) {
    $$("#add-mode button").forEach((button) => button.classList.toggle("active", button.dataset.mode === "qr"));
  }
  const qrMode = !supportsCookie || ($("#add-mode .active") || {}).dataset?.mode === "qr";
  $("#add-cookie").hidden = qrMode;
  $("#add-qr").hidden = !qrMode;
  $("#btn-acc-save").hidden = qrMode;
  $("#btn-qr-start").hidden = !qrMode;
  const hint = $("#add-platform-hint");
  if (hint) {
    hint.textContent =
      platform === "wechat_mp"
        ? "用微信扫码登录公众平台。若有多个公众号需要选择，页面会提示你是否打开验证窗口。"
        : platform === "douyin"
        ? "用抖音 App 扫码登录创作者中心。遇到安全验证时，页面会提示你打开验证窗口。"
        : "小红书支持扫码，也可以粘贴浏览器里的登录信息（Cookie）作为兜底。";
  }
  if (qrMode) {
    stopQrPolling();
    const area = $("#qr-area");
    const status = $("#qr-status");
    if (area) area.innerHTML = "点下方按钮生成二维码。";
    if (status) status.textContent = "";
  }
}

function openAddAccount() {
  openModal(
    "添加账号",
    `<div class="platform-picker" id="add-platform">
      <button type="button" class="platform-choice active" data-platform="xiaohongshu">
        <strong>小红书</strong><span>图文笔记 / 视频笔记</span></button>
      <button type="button" class="platform-choice" data-platform="wechat_mp">
        <strong>公众号</strong><span>图文长文</span></button>
      <button type="button" class="platform-choice" data-platform="douyin">
        <strong>抖音</strong><span>视频 / 图文</span></button>
    </div>
    <p class="hint" id="add-platform-hint"></p>
    <div class="seg" id="add-mode" hidden>
      <button class="active" data-mode="qr">扫码登录</button>
      <button data-mode="cookie">粘贴登录信息</button>
    </div>
    <div id="add-cookie" hidden>
      <div class="form-row"><label>备注名（可留空，自动用昵称）</label>
        <input id="acc-name" type="text" placeholder="主号 / 小号 A" /></div>
      <div class="form-row"><label>代理（可选，http://host:port）</label>
        <input id="acc-proxy" type="text" placeholder="留空表示直连" /></div>
      <div class="form-row"><label>完整登录信息（Cookie）</label>
        <textarea id="acc-cookie" rows="7" placeholder="从已登录的浏览器复制 document.cookie，需包含 web_session"></textarea>
        <div class="desc">Cookie 会加密保存在本机数据目录的 ops.db，不会回传给页面。</div></div>
    </div>
    <div id="add-qr">
      <div class="form-row"><label>代理（可选）</label>
        <input id="acc-qr-proxy" type="text" placeholder="留空表示直连" /></div>
      <div class="qr-box"><div id="qr-area" class="qr-status">点下方按钮生成二维码。</div>
        <div class="qr-status" id="qr-status"></div></div>
      <div class="qr-window" id="qr-window" hidden>
        <p class="qr-window-note" id="qr-window-note"></p>
        <button class="btn primary small" type="button" id="btn-qr-window">打开验证窗口</button>
      </div>
      <p class="qr-meta" id="qr-meta"></p>
    </div>`,
    `<button class="btn ghost" data-action="close-modal">取消</button>
     <button class="btn ghost" id="btn-qr-start">生成二维码</button>
     <button class="btn primary" id="btn-acc-save" hidden>保存并验证</button>`
  );

  $("#add-platform").addEventListener("click", (event) => {
    const button = event.target.closest("[data-platform]");
    if (!button) return;
    applyAddPlatform(button.dataset.platform);
  });

  $$("#add-mode button").forEach((button) => {
    button.addEventListener("click", () => {
      $$("#add-mode button").forEach((item) => item.classList.toggle("active", item === button));
      const mode = button.dataset.mode;
      $("#add-cookie").hidden = mode !== "cookie";
      $("#add-qr").hidden = mode !== "qr";
      $("#btn-acc-save").hidden = mode !== "cookie";
      $("#btn-qr-start").hidden = mode !== "qr";
      if (mode === "cookie") stopQrPolling();
    });
  });

  $("#btn-acc-save").addEventListener("click", async () => {
    const cookie = $("#acc-cookie").value.trim();
    if (!cookie) {
      toast("登录信息不能为空", true);
      $("#acc-cookie").classList.add("invalid");
      return;
    }
    const button = $("#btn-acc-save");
    setButtonLoading(button, true, "验证中");
    try {
      const account = await api("/api/accounts", {
        method: "POST",
        body: { name: $("#acc-name").value.trim(), proxy: $("#acc-proxy").value.trim(), cookie },
      });
      toast(account.updated_existing ? "已更新该账号的登录信息" : "账号已添加");
      closeModal();
      await refreshAccounts();
      await refreshOverview();
    } catch (error) {
      toast(error.message, true);
    } finally {
      setButtonLoading(button, false);
    }
  });

  $("#btn-qr-start").addEventListener("click", () => startQrLogin());
  $("#btn-qr-window").addEventListener("click", () => openQrWindow());
  applyAddPlatform("xiaohongshu");
}

const QR_STATUS_HINT = {
  xiaohongshu: "请用小红书 App 扫码",
  wechat_mp: "请用微信扫码登录公众平台",
  douyin: "请用抖音 App 扫码登录创作者中心",
};

/* 需要人工验证时，由用户自己点按钮开窗口；说明写清楚会发生什么、多久自动关。 */
const QR_WINDOW_NOTE = {
  wechat_mp:
    "后台检测到有多个公众号需要选择。点击后会在本机打开一个浏览器窗口，请在里面选好要接入的公众号；窗口最多停留 120 秒，选完会自动关闭，并继续保存登录态。",
  douyin:
    "后台检测到需要完成安全验证。点击后会在本机打开一个浏览器窗口，请按提示验证一次；窗口最多停留 120 秒，完成后会自动关闭，并继续保存登录态。",
  default:
    "当前步骤需要人工确认。点击后会在本机打开一个浏览器窗口，最多停留 120 秒，完成后会自动关闭并继续。",
};

function stopQrCountdown() {
  if (state.qr.ticker) {
    clearInterval(state.qr.ticker);
    state.qr.ticker = null;
  }
}

function startQrCountdown(deadline) {
  stopQrCountdown();
  const tick = () => {
    if (!state.qr.session) {
      stopQrCountdown();
      return;
    }
    const button = $("#btn-qr-window");
    const meta = $("#qr-meta");
    if (!button) {
      stopQrCountdown();
      return;
    }
    const left = Math.max(0, Math.round(deadline - Date.now() / 1000));
    if (left > 0) {
      button.disabled = true;
      button.textContent = `验证窗口已打开 · ${left}s`;
      if (meta) meta.textContent = "已在浏览器中打开窗口，完成后会自动关闭并继续";
      return;
    }
    stopQrCountdown();
    button.disabled = false;
    button.textContent = "重新打开验证窗口";
    if (meta) meta.textContent = "验证窗口已自动关闭，继续等待扫码结果";
  };
  tick();
  state.qr.ticker = setInterval(tick, 1000);
}

/* 按扫码会话返回的字段同步「打开验证窗口」区域与小字说明。 */
function syncQrWindow(payload) {
  const panel = $("#qr-window");
  if (!panel) return;
  const note = $("#qr-window-note");
  const button = $("#btn-qr-window");
  const meta = $("#qr-meta");
  state.qr.payload = payload || {};
  const requires = !!state.qr.payload.requires_window;
  const opened = !!state.qr.payload.window_open;
  const platform = addPlatform();

  if (!requires && !opened) {
    stopQrCountdown();
    panel.hidden = true;
    if (meta) {
      meta.textContent = state.qr.payload.headless ? "后台静默运行，当前未打开任何浏览器窗口" : "";
    }
    return;
  }

  panel.hidden = false;
  if (requires && !opened) {
    stopQrCountdown();
    if (note) note.textContent = QR_WINDOW_NOTE[platform] || QR_WINDOW_NOTE.default;
    if (button) {
      button.disabled = false;
      button.textContent = "打开验证窗口";
    }
    if (meta) meta.textContent = "现在还没有打开窗口，点上面的按钮才会打开";
  }
  if (opened) {
    if (note) note.textContent = "窗口已经打开，请在浏览器里完成这一步。";
    startQrCountdown(Number(state.qr.payload.deadline || 0));
  }
}

async function startQrLogin() {
  const area = $("#qr-area");
  const status = $("#qr-status");
  const panel = $("#qr-window");
  const meta = $("#qr-meta");
  const platform = addPlatform();
  const info = platformInfo(platform);
  area.innerHTML = "正在生成二维码…";
  if (panel) panel.hidden = true;
  if (meta) meta.textContent = "";
  stopQrPolling();
  try {
    const data = await api("/api/accounts/qr", {
      method: "POST",
      body: { platform, proxy: ($("#acc-qr-proxy") || {}).value || "" },
    });
    state.qr.session = data.session_id;
    if (data.qr) {
      area.innerHTML = `<img src="${data.qr}" alt="扫码登录" />`;
    } else {
      area.textContent = "未能自动截取二维码，请点击「打开验证窗口」完成扫码登录";
    }
    status.textContent = QR_STATUS_HINT[platform] || `请用${info ? info.short || info.name : ""} App 扫码`;
    state.qr.timer = setInterval(async () => {
      if (!state.qr.session) return;
      try {
        const result = await api(`/api/accounts/qr/${state.qr.session}`);
        status.textContent = result.message || result.status;
        syncQrWindow(result);
        if (result.status === "confirmed") {
          const sessionId = state.qr.session;
          stopQrPolling();
          status.textContent = `已确认：${result.nickname}，正在保存…`;
          const account = await api(`/api/accounts/qr/${sessionId}/save`, { method: "POST", body: {} });
          toast(`账号已添加：${account.nickname || account.name}`);
          closeModal();
          await refreshAccounts();
          await refreshOverview();
        } else if (
          result.status === "expired" ||
          result.status === "error" ||
          result.status === "failed"
        ) {
          stopQrPolling();
          const windowPanel = $("#qr-window");
          if (windowPanel) windowPanel.hidden = true;
        }
      } catch (error) {
        status.textContent = error.message;
        stopQrPolling();
      }
    }, 2000);
  } catch (error) {
    area.textContent = error.message;
  }
}

async function openQrWindow() {
  const button = $("#btn-qr-window");
  if (!state.qr.session) {
    toast("请先生成二维码，再打开验证窗口", true);
    return;
  }
  button.disabled = true;
  button.textContent = "正在打开…";
  try {
    const result = await api(`/api/accounts/qr/${state.qr.session}/window`, {
      method: "POST",
      body: {},
    });
    const status = $("#qr-status");
    if (status && result.notice) status.textContent = result.notice;
    syncQrWindow(result);
  } catch (error) {
    syncQrWindow(state.qr.payload || {});
    toast(error.message, true);
  }
}

function openAccountEditor(account) {
  openModal(
    `配置账号 #${account.id}`,
    `<div class="form-row"><label>备注名</label>
      <input id="edit-acc-name" type="text" value="${esc(account.name)}" /></div>
     <div class="form-row"><label>日限额（篇，0 表示用全局默认）</label>
      <input id="edit-acc-limit" type="number" min="0" value="${account.daily_limit || 0}" /></div>
     <div class="form-row"><label>最小间隔（分钟，0 表示用全局默认）</label>
      <input id="edit-acc-interval" type="number" min="0" value="${account.min_interval_sec ? Math.round(account.min_interval_sec / 60) : 0}" /></div>
     <div class="form-row"><label>代理（http://host:port，留空直连）</label>
      <input id="edit-acc-proxy" type="text" value="${esc(account.proxy || "")}" /></div>
     <div class="form-row"><label>分组</label>
      <input id="edit-acc-group" type="text" value="${esc(account.group_name || "")}" placeholder="例如：主号 / 矩阵 A" /></div>
     <div class="form-row"><label>标签（逗号分隔）</label>
      <input id="edit-acc-tags" type="text" value="${esc((account.tags || []).join(","))}" placeholder="例如：美妆, 新号" /></div>
     <label class="check"><input type="checkbox" id="edit-acc-enabled" ${account.enabled ? "checked" : ""} /> 启用该账号</label>`,
    `<button class="btn ghost" data-action="close-modal">取消</button>
     <button class="btn primary" id="btn-acc-update">保存</button>`
  );
  $("#btn-acc-update").addEventListener("click", async () => {
    try {
      await api(`/api/accounts/${account.id}`, {
        method: "PATCH",
        body: {
          name: $("#edit-acc-name").value.trim(),
          daily_limit: Number($("#edit-acc-limit").value || 0),
          min_interval_sec: Number($("#edit-acc-interval").value || 0) * 60,
          proxy: $("#edit-acc-proxy").value.trim(),
          group_name: $("#edit-acc-group").value.trim(),
          tags: $("#edit-acc-tags").value.trim(),
          enabled: $("#edit-acc-enabled").checked ? 1 : 0,
        },
      });
      toast("账号配置已保存");
      closeModal();
      await refreshAccounts();
      await refreshOverview();
    } catch (error) {
      toast(error.message, true);
    }
  });
}

/* ------------------------------------------------------------------ 设置 */

function openSettings() {
  openModal(
    "设置",
    `<div id="settings-body">
      <div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line w60"></div>
      <div class="skeleton skeleton-line"></div>
    </div>`,
    `<button class="btn ghost" data-action="close-modal">关闭</button>
     <button class="btn primary" id="btn-save-settings">保存设置</button>`
  );
  $("#btn-save-settings").disabled = true;
  api("/api/settings")
    .then(async (data) => {
      state.settings = data;
      await refreshCardStyles().catch((error) => {
      reportBackgroundError(error);
      return [];
    });
      if (!$("#settings-body")) return;
      renderSettings();
      $("#btn-save-settings").disabled = false;
      setEngineBadge();
    })
    .catch((error) => {
      const body = $("#settings-body");
      if (body) body.innerHTML = `<div class="inline-error">${esc(error.message)}</div>`;
    });

  $("#btn-save-settings").addEventListener("click", async () => {
    const payload = {};
    $$("#settings-form [name]").forEach((node) => {
      const divide = Number(node.dataset.divide || 0);
      payload[node.name] = divide ? String(Math.round((Number(node.value) || 0) * divide)) : node.value;
    });
    const button = $("#btn-save-settings");
    setButtonLoading(button, true, "保存中");
    try {
      state.settings = await api("/api/settings", { method: "PATCH", body: payload });
      applyTheme((state.settings.values || {}).theme_color || "red", { persist: true });
      renderSettings();
      setEngineBadge();
      toast("设置已保存");
      await refreshAccounts();
      await refreshOverview();
    } catch (error) {
      toast(error.message, true);
    } finally {
      setButtonLoading(button, false);
    }
  });
}

function renderSettings() {
  if (!state.settings) return;
  const values = state.settings.values;
  const body = $("#settings-body");
  if (!body) return;
  if (!body.querySelector("#settings-form")) {
    body.innerHTML = `<div class="settings-grid" id="settings-form"></div><div class="settings-note" id="settings-note"></div>`;
  }
  const form = $("#settings-form");
  form.innerHTML = SETTING_FIELDS.map(([key, label, type, desc, divide]) => {
    let control = "";
    if (type === "textarea") {
      control = `<textarea name="${key}" rows="3">${esc(values[key] || "")}</textarea>`;
    } else if (type === "style") {
      control = `<select name="${key}">${state.cardStyles
        .map((item) => `<option value="${item.key}" ${values[key] === item.key ? "selected" : ""}>${esc(item.label)}</option>`)
        .join("")}</select>`;
    } else if (type === "layout" || type === "palette") {
      const items = type === "layout" ? state.cardOptions.layouts : state.cardOptions.palettes;
      control = `<select name="${key}">${
        type === "palette" ? `<option value="">跟随模板</option>` : ""
      }${(items || [])
        .map((item) => `<option value="${item.key}" ${values[key] === item.key ? "selected" : ""}>${esc(item.label)}</option>`)
        .join("")}</select>`;
    } else if (type === "tone") {
      control = `<select name="${key}">${Object.entries(TONE_OPTIONS)
        .map(([item, text]) => `<option value="${item}" ${values[key] === item ? "selected" : ""}>${text}</option>`)
        .join("")}</select>`;
    } else {
      /* 秒数在界面上换算成分钟，保存时再换回去，用户不用心算 2700 秒是多久。 */
      const shown = divide ? Math.round((Number(values[key]) || 0) / divide) : values[key] || "";
      control = `<input name="${key}" type="${type}" value="${esc(shown)}" ${
        divide ? `data-divide="${divide}"` : ""
      } />`;
    }
    return `<div class="field${type === "textarea" ? " wide" : ""}">
      <label>${esc(label)}</label>${control}<span class="hint">${esc(desc)}</span>
    </div>`;
  }).join("");
  const llm = state.settings.llm || {};
  const cloud = state.cloud || {};
  $("#settings-note").innerHTML = `
    文案与配图：统一走云端中转
    ${cloud.logged_in ? badge("已登录", "ok") : badge("未登录", "warn")}
    · 模型 ${esc(llm.model || "—")}
    <br />Key 由云端按账号签发，只保存在本机后台；页面不会显示完整 Key。
    <br />数据目录 <code>${esc(state.settings.data_dir)}</code>
    <div class="settings-links">
      <button class="link-btn" type="button" data-action="open-backups">备份与恢复</button>
      <button class="link-btn" type="button" data-action="open-notify-channels">通知渠道</button>
      <button class="link-btn" type="button" data-action="open-proxies">代理池</button>
    </div>`;
}

/* 简化代理池：只管地址、出口与延迟；绑定在账号的发布设置里完成。 */
async function openProxies() {
  openModal(
    "代理池",
    `<p class="hint">这里只做代理地址与出口测试；绑定方式：在账号「发布设置」里粘贴同一条代理地址。</p>
     <div class="form-row"><label>名称</label><input id="proxy-name" placeholder="例如：美国住宅 1" /></div>
     <div class="form-row"><label>代理地址</label><input id="proxy-url" placeholder="http://user:pass@host:port" /></div>
     <div class="proxy-list" id="proxy-list"><div class="skeleton skeleton-line"></div></div>`,
    `<button class="btn ghost" data-action="close-modal">关闭</button>
     <button class="btn primary" data-action="add-proxy">添加代理</button>`
  );
  await loadProxyList();
}

async function loadProxyList() {
  const box = $("#proxy-list");
  if (!box) return;
  try {
    const items = await api("/api/proxies");
    box.innerHTML = items.length
      ? items
          .map((item) => {
            const bound = state.accounts.filter(
              (account) => account.proxy && account.proxy === item.url
            );
            const status = item.last_status || "未测试";
            const ok = /^出口/.test(status);
            return `<div class="backup-row">
              <div>
                <b>${esc(item.name || item.url)}</b>
                <small>${esc(item.url)}</small>
                <em class="${ok ? "ok-text" : "bad-text"}">${esc(status)}${
                  item.last_latency_ms ? ` · ${item.last_latency_ms}ms` : ""
                }${bound.length ? ` · 已绑 ${bound.length} 个账号` : ""}</em>
              </div>
              <div class="backup-actions">
                <select class="mini-select" id="bind-proxy-${item.id}" aria-label="绑定账号">
                  <option value="">绑定到…</option>
                  ${state.accounts
                    .map(
                      (account) =>
                        `<option value="${account.id}">${esc(
                          account.nickname || account.name
                        )}</option>`
                    )
                    .join("")}
                </select>
                <button class="btn small ghost" data-action="bind-proxy" data-id="${item.id}" data-url="${esc(
                  item.url
                )}">绑定</button>
                <button class="btn small ghost" data-action="test-proxy" data-id="${item.id}">测试</button>
                <button class="btn small ghost" data-action="delete-proxy" data-id="${item.id}">删除</button>
              </div>
            </div>`;
          })
          .join("")
      : `<p class="hint">还没有代理。填写地址后点「添加代理」。</p>`;
  } catch (error) {
    box.innerHTML = `<p class="hint">${esc(error.message)}</p>`;
  }
}

/* 备份与恢复：默认不含图片和密钥，避免一次备份把盘占满。 */
async function openBackups() {
  openModal(
    "备份与恢复",
    `<p class="hint">备份包含数据库；图片与密钥可选。恢复会先自动备份当前数据，再覆盖数据库。</p>
     <label class="check"><input type="checkbox" id="backup-images" /> 包含内容图片（体积可能较大）</label>
     <label class="check"><input type="checkbox" id="backup-key" /> 包含本机密钥（换机恢复登录信息时需要）</label>
     <div class="backup-list" id="backup-list"><div class="skeleton skeleton-line"></div></div>`,
    `<button class="btn ghost" data-action="close-modal">关闭</button>
     <button class="btn primary" data-action="create-backup">立即备份</button>`
  );
  await loadBackupList();
}

async function loadBackupList() {
  const box = $("#backup-list");
  if (!box) return;
  try {
    const items = await api("/api/backups");
    box.innerHTML = items.length
      ? items
          .map(
            (item) => `<div class="backup-row">
              <div>
                <b>${esc(item.name)}</b>
                <small>${esc(item.label)} · ${(item.size / 1024 / 1024).toFixed(2)} MB · ${esc(
                  fmtTime(item.created_at)
                )}</small>
              </div>
              <div class="backup-actions">
                <a class="link-btn" href="/api/backups/download?name=${encodeURIComponent(
                  item.name
                )}">下载</a>
                <button class="btn small ghost" data-action="restore-backup" data-name="${esc(
                  item.name
                )}">恢复</button>
                <button class="btn small ghost" data-action="delete-backup" data-name="${esc(
                  item.name
                )}">删除</button>
              </div>
            </div>`
          )
          .join("")
      : `<p class="hint">还没有备份。点「立即备份」创建第一份。</p>`;
  } catch (error) {
    box.innerHTML = `<p class="hint">${esc(error.message)}</p>`;
  }
}

/* ------------------------------------------------------------------ 账号与额度 */

/* 套餐名只展示中性名称，避免出现「全免期 / 免费试用」等让用户以为以后要收费的字样。 */
function planLabel(sub) {
  const raw = String((sub || {}).plan_name || "").trim();
  if (!raw || /免|试用|trial|free/i.test(raw)) return "专业版";
  return raw;
}

function renderAccountChip() {
  const cloud = state.cloud || {};
  const chip = $("#btn-account");
  const label = $("#account-label");
  const dot = $("#account-dot");
  if (!chip || !label) return;
  const sub = cloud.subscription || {};
  if (cloud.logged_in) {
    label.textContent = planLabel(sub);
    chip.classList.toggle("warn", !cloud.generation_allowed);
    chip.title = `${planLabel(sub)} · ${sub.state_name || ""}`;
  } else {
    label.textContent = "未登录";
    chip.classList.remove("warn");
    chip.title = "登录后可生成文案与配图";
  }
  if (dot) dot.classList.toggle("on", Boolean(cloud.logged_in));
}

async function refreshCloudStatus({ refresh = false, silent = true } = {}) {
  try {
    const data = refresh
      ? await api("/api/cloud/refresh", { method: "POST" })
      : await api("/api/cloud/status");
    state.cloud = refresh ? data.status || data : data;
    renderAccountChip();
    setEngineBadge();
    return state.cloud;
  } catch (error) {
    if (refresh) {
      /* 刷新失败时退回本地缓存，票据失效的情况顺带把界面切回未登录。 */
      try {
        state.cloud = await api("/api/cloud/status");
        renderAccountChip();
        setEngineBadge();
      } catch (ignored) {
        /* 服务本身不可用时保留上一次状态 */
      }
    }
    if (!silent) toast(error.message, true);
    return state.cloud;
  }
}

function maybePromptLogin(error) {
  if (state.cloud && state.cloud.logged_in) return false;
  const text = String((error && error.message) || error || "");
  if (!/登录|账号|Key|订阅|额度|续费/.test(text)) return false;
  openLoginForm();
  return true;
}

function loginBodyHtml(mode) {
  const phone = `
    <div class="field">
      <label for="cloud-phone">手机号</label>
      <input id="cloud-phone" inputmode="numeric" maxlength="11" placeholder="11 位手机号" />
    </div>
    <div class="field">
      <label for="cloud-code">验证码</label>
      <div class="code-row">
        <input id="cloud-code" inputmode="numeric" maxlength="6" placeholder="6 位验证码" />
        <button class="btn ghost" type="button" id="btn-send-code">发送验证码</button>
      </div>
    </div>
    <p class="hint">未注册的手机号会自动创建账号。</p>`;
  const email = `
    <div class="field">
      <label for="cloud-email">邮箱</label>
      <input id="cloud-email" type="email" placeholder="you@example.com" />
    </div>
    <div class="field">
      <label for="cloud-password">密码</label>
      <input id="cloud-password" type="password" placeholder="至少 8 位" />
    </div>
    <p class="hint">邮箱登录用于已注册账号；新用户请用手机号验证码登录。</p>`;
  return `
    <div class="seg login-tabs" id="login-tabs">
      <button type="button" data-mode="phone" class="${mode === "phone" ? "active" : ""}">手机验证码</button>
      <button type="button" data-mode="email" class="${mode === "email" ? "active" : ""}">邮箱密码</button>
    </div>
    ${mode === "email" ? email : phone}
    <div class="inline-error" id="login-error" hidden></div>`;
}

function openLoginForm(mode = "phone") {
  state.loginMode = mode === "email" ? "email" : "phone";
  openModal(
    "登录 EchoQ 账号",
    loginBodyHtml(state.loginMode),
    `<button class="btn ghost" type="button" id="login-cancel">取消</button>
     <button class="btn primary" type="button" id="login-submit">登录</button>`
  );
  $("#login-cancel").addEventListener("click", closeModal);
  $("#login-submit").addEventListener("click", submitCloudLogin);
  $$("#login-tabs [data-mode]").forEach((button) => {
    button.addEventListener("click", () => openLoginForm(button.dataset.mode));
  });
  const send = $("#btn-send-code");
  if (send) send.addEventListener("click", sendLoginCode);
  const first = $("#cloud-phone") || $("#cloud-email");
  if (first) first.focus();
}

function startCodeCountdown(button, seconds) {
  let left = Math.max(1, Number(seconds) || 60);
  button.disabled = true;
  button.textContent = `${left}s 后重发`;
  const timer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(timer);
      button.disabled = false;
      button.textContent = "发送验证码";
      return;
    }
    button.textContent = `${left}s 后重发`;
  }, 1000);
}

async function sendLoginCode() {
  const button = $("#btn-send-code");
  const phone = ($("#cloud-phone") || {}).value ? $("#cloud-phone").value.trim() : "";
  hideInline("#login-error");
  if (!/^1\d{10}$/.test(phone)) {
    showInline("#login-error", "先填 11 位手机号");
    return;
  }
  button.disabled = true;
  button.textContent = "发送中";
  try {
    const data = await api("/api/cloud/sms/send", { method: "POST", body: { phone } });
    if (data.dev_code) {
      $("#cloud-code").value = data.dev_code;
      toast(`开发环境验证码：${data.dev_code}`);
    } else {
      toast("验证码已发送");
    }
    startCodeCountdown(button, data.resend_in || 60);
  } catch (error) {
    button.disabled = false;
    button.textContent = "发送验证码";
    showInline("#login-error", error.message);
  }
}

async function submitCloudLogin() {
  const mode = state.loginMode || "phone";
  const button = $("#login-submit");
  hideInline("#login-error");
  let body;
  if (mode === "email") {
    const email = $("#cloud-email").value.trim();
    const password = $("#cloud-password").value;
    if (!email || !password) {
      showInline("#login-error", "填写邮箱和密码后再登录");
      return;
    }
    body = { email, password };
  } else {
    const phone = $("#cloud-phone").value.trim();
    const code = $("#cloud-code").value.trim();
    if (!/^1\d{10}$/.test(phone)) {
      showInline("#login-error", "请输入 11 位手机号");
      return;
    }
    if (!/^\d{6}$/.test(code)) {
      showInline("#login-error", "请输入 6 位验证码");
      return;
    }
    body = { phone, code };
  }
  setButtonLoading(button, true, "登录中");
  try {
    const data = await api("/api/cloud/login", { method: "POST", body });
    state.cloud = data.status || data;
    closeModal();
    renderAccountChip();
    setEngineBadge();
    toast(data.is_new ? "账号已创建，已登录" : "已登录");
    refreshSettings().catch(reportBackgroundError);
    refreshCardStyles().catch(reportBackgroundError);
  } catch (error) {
    setButtonLoading(button, false);
    showInline("#login-error", error.message);
  }
}

function accountPanelHtml(cloud) {
  const user = cloud.user || {};
  const sub = cloud.subscription || {};
  const keys = cloud.keys || {};
  const name = user.display_name || user.phone || user.email || "已登录";
  const remaining = typeof sub.remaining_units === "number" ? sub.remaining_units : "—";
  const quota = typeof sub.quota_units === "number" ? sub.quota_units : "—";
  const ends = (sub.ends_at || "").slice(0, 10) || "—";
  const days = typeof sub.days_left === "number" ? `（剩 ${sub.days_left} 天）` : "";
  const keyRow = (kind, label) => {
    const item = keys[kind] || {};
    return `<div class="account-key">
      <div class="account-key-main"><span>${label}</span><code>${esc(item.masked || "未签发")}</code></div>
      <button class="btn small ghost" type="button" data-reset-key="${kind}">重置</button>
    </div>`;
  };
  const expired = ["expired", "none", "past_due"].includes(sub.state);
  return `
    <div class="account-summary">
      <div><span>账号</span><b>${esc(name)}</b></div>
      <div><span>套餐</span><b>${esc(planLabel(sub))} · ${esc(sub.state_name || "已开通")}</b></div>
      <div><span>剩余额度</span><b>${remaining} / ${quota} 次</b></div>
      <div><span>本周期到期</span><b>${ends}${days}</b></div>
    </div>
    ${expired ? '<p class="inline-error">订阅已到期，续费后才能继续生成。</p>' : ""}
    <div class="account-keys">
      ${keyRow("llm", "文案 Key")}
      ${keyRow("image", "配图 Key")}
      <p class="hint">Key 由云端按账号签发，只保存在本机后台；页面不会显示完整 Key。</p>
    </div>`;
}

function openAccountPanel() {
  const cloud = state.cloud || {};
  if (!cloud.logged_in) {
    openLoginForm();
    return;
  }
  openModal(
    "账号与额度",
    accountPanelHtml(cloud),
    `<button class="btn ghost" type="button" id="account-doctor">云端体检</button>
     <button class="btn ghost" type="button" id="account-refresh">刷新</button>
     <button class="btn danger" type="button" id="account-logout">退出登录</button>
     <button class="btn primary" data-action="close-modal">关闭</button>`
  );
  $$("[data-reset-key]").forEach((button) => {
    button.addEventListener("click", () => resetCloudKey(button.dataset.resetKey));
  });
  $("#account-refresh").addEventListener("click", refreshAccountPanel);
  $("#account-logout").addEventListener("click", logoutCloud);
  $("#account-doctor").addEventListener("click", runCloudDoctor);
}

/* ------------------------------------------------------- 云端体检 */

function doctorHtml(report) {
  const rows = (report.items || [])
    .map(
      (item) => `<li class="doctor-row ${item.ok ? "ok" : "bad"}">
        <span class="doctor-mark" aria-hidden="true">${item.ok ? "✓" : "!"}</span>
        <b>${esc(item.name)}</b>
        <span class="hint">${esc(item.detail || "")}</span>
      </li>`
    )
    .join("");
  return `<div class="doctor">
    <p class="${report.ok ? "hint" : "inline-error"}">${
      report.ok ? "全部通过，可以正常生成。" : "有项目未通过，按下面的提示处理即可。"
    }</p>
    <ul class="doctor-list">${rows}</ul>
    <p class="hint">检查地址：${esc(report.base_url || "")} · 客户端 v${esc(report.version || "")}</p>
  </div>`;
}

async function runCloudDoctor() {
  try {
    const report = await api("/api/cloud/doctor");
    openModal(
      "云端体检",
      doctorHtml(report),
      `<button class="btn ghost" type="button" id="doctor-back">返回账号</button>
       <button class="btn primary" data-action="close-modal">关闭</button>`
    );
    $("#doctor-back").addEventListener("click", openAccountPanel);
  } catch (error) {
    toast(error.message, true);
  }
}

/* 启动时静默体检一次：已登录却有问题才提示，未登录不打扰。 */
async function checkCloudHealth() {
  try {
    const report = await api("/api/cloud/doctor");
    if (report.ok || !report.logged_in) return;
    const bad = (report.items || []).filter((item) => !item.ok).map((item) => item.name);
    toast(`云端体检未通过：${bad.join("、")}。点右上角账号查看详情`, true);
  } catch (error) {
    /* 体检失败不阻塞使用 */
  }
}

async function refreshAccountPanel() {
  const button = $("#account-refresh");
  setButtonLoading(button, true, "刷新中");
  try {
    const data = await api("/api/cloud/refresh", { method: "POST" });
    state.cloud = data.status || data;
    renderAccountChip();
    setEngineBadge();
    openAccountPanel();
    toast("账号状态已同步");
  } catch (error) {
    toast(error.message, true);
    if (error.status === 401 || error.status === 402) {
      await refreshCloudStatus();
      openAccountPanel();
    }
  } finally {
    setButtonLoading(button, false);
  }
}

async function resetCloudKey(kind) {
  const label = kind === "image" ? "配图 Key" : "文案 Key";
  const ok = await confirmDialog(
    `重置${label}后旧 Key 立即失效，其它设备需要重新获取。确定吗？`,
    "重置"
  );
  if (!ok) return;
  try {
    const data = await api("/api/cloud/keys/reset", { method: "POST", body: { kind } });
    state.cloud = data.status || state.cloud;
    renderAccountChip();
    toast(data.notice || `${label}已重置`);
    openAccountPanel();
    refreshCardStyles().catch(reportBackgroundError);
  } catch (error) {
    toast(error.message, true);
  }
}

async function logoutCloud() {
  if (!(await confirmDialog("退出后本机将无法生成文案和配图，确定吗？", "退出"))) return;
  try {
    const data = await api("/api/cloud/logout", { method: "POST" });
    state.cloud = data.status || data;
    closeModal();
    renderAccountChip();
    setEngineBadge();
    refreshSettings().catch(reportBackgroundError);
    refreshCardStyles().catch(reportBackgroundError);
    toast("已退出登录");
  } catch (error) {
    toast(error.message, true);
  }
}

/* ------------------------------------------------------------------ 事件 */

async function doAction(action, element) {
  const id = Number(element.dataset.id);
  if (action === "close-modal") return closeModal();
  if (action === "switch-image-text") {
    switchStudioContentType("image_text");
    return;
  }
  if (action === "retry-generate") {
    generateCopy();
    return;
  }
  if (action === "regenerate-cards") {
    generateCards();
    return;
  }
  if (action === "insert-extra-images") {
    insertExtraImagesToBody();
    return;
  }
  if (action === "add-account") return openAddAccount();
  if (action === "new-note") {
    if (state.studio.dirty && !(await confirmDialog("当前内容还没保存，确定新建吗？", "新建"))) return;
    resetStudio();
    switchView("studio");
    $("#f-brief").focus();
    return;
  }
  if (action === "go-topics") return switchView("topics");
  if (action === "toggle-dedupe-all") {
    state.dedupeExpanded = !state.dedupeExpanded;
    renderDedupes();
    return;
  }
  if (action === "focus-mine") {
    $("#mine-input").focus();
    return;
  }
  if (action === "open-draft") {
    closeModal();
    return openDraftInStudio(id);
  }
  if (action === "rewrite-draft") {
    const draft = state.drafts.find((item) => item.id === id);
    if (draft) openRewriteDraft(draft);
    return;
  }
  if (action === "convert-draft") {
    const draft = state.drafts.find((item) => item.id === id);
    if (draft) switchDraftCardPlatform(draft);
    return;
  }
  if (action === "queue-draft") {
    const draft = state.drafts.find((item) => item.id === id);
    if (draft && !draft.can_publish) {
      toast(
        draft.compliance && draft.compliance.length
          ? "这篇还有合规风险，先编辑修正"
          : "这篇还缺配图，先打开生成 3 张卡片",
        true
      );
      return;
    }
    return openQueueDialog(id);
  }
  if (action === "remove-image") {
    const index = Number(element.dataset.index);
    state.studio.images.splice(index, 1);
    state.studio.dirty = true;
    refreshStudioUI();
    return;
  }
  if (action === "check-account") {
    setButtonLoading(element, true, "检查中");
    try {
      const result = await api(`/api/accounts/${id}/check`, { method: "POST" });
      toast(result.ok ? `登录态正常：${result.nickname}` : `检查失败：${result.message}`, !result.ok);
      await refreshAccounts();
      await refreshOverview();
    } catch (error) {
      toast(error.message, true);
    } finally {
      setButtonLoading(element, false);
    }
    return;
  }
  if (action === "edit-account") {
    const account = state.accounts.find((item) => item.id === id);
    if (account) openAccountEditor(account);
    return;
  }
  if (action === "toggle-account") {
    await api(`/api/accounts/${id}`, {
      method: "PATCH",
      body: { enabled: element.dataset.enabled === "1" ? 0 : 1 },
    });
    toast("已更新账号状态");
    await refreshAccounts();
    return;
  }
  if (action === "delete-account") {
    if (!(await confirmDialog("删除后该账号的登录信息和队列分配会一并移除，确定吗？", "删除"))) return;
    await api(`/api/accounts/${id}`, { method: "DELETE" });
    toast("账号已删除");
    await refreshAccounts();
    await refreshOverview();
    return;
  }
  if (action === "edit-topic") {
    const topic = state.topics.find((item) => item.id === id);
    if (topic) openTopicEditor(topic);
    return;
  }
  if (action === "topic-to-studio") {
    const topic = state.topics.find((item) => item.id === id);
    if (topic) topicToStudio(topic);
    return;
  }
  if (action === "score-explain") {
    const topic = state.topics.find((item) => item.id === id);
    if (topic) openScoreExplain(topic);
    return;
  }
  if (action === "show-topic") {
    closeModal();
    $("#topic-search").value = "";
    state.topicStatus = "";
    $$("#topic-status-chips button").forEach((item) =>
      item.classList.toggle("on", item.dataset.status === "")
    );
    $("#topic-source").value = "";
    $("#topic-min-score").value = "0";
    await refreshTopics();
    const row = document.querySelector(`.topic-check[data-id="${id}"]`);
    const card = row && row.closest(".topic-card");
    if (card) {
      card.scrollIntoView({ block: "center", behavior: "smooth" });
      card.classList.add("row-focus");
      setTimeout(() => card.classList.remove("row-focus"), 1600);
    }
    return;
  }
  if (action === "draft-from-topic") {
    const topic = state.topics.find((item) => item.id === id);
    if (!topic) return;
    await generateDrafts(
      {
        topic_ids: [id],
        tone: topic.tone || "",
        variants: 1,
        with_cards: true,
      },
      element,
      "生成中"
    );
    return;
  }
  if (action === "drop-topic") {
    await api(`/api/topics/${id}`, { method: "PATCH", body: { status: element.dataset.status } });
    await refreshTopics();
    return;
  }
  if (action === "delete-topic") {
    if (!(await confirmDialog("删除后无法恢复，确定删除这个选题吗？", "删除"))) return;
    await api(`/api/topics/${id}`, { method: "DELETE" });
    state.selectedTopics.delete(id);
    toast("选题已删除");
    await refreshTopics();
    await refreshOverview();
    return;
  }
  if (action === "delete-selected-topics") {
    const ids = Array.from(state.selectedTopics);
    if (!ids.length) {
      toast("先勾选要删除的选题", true);
      return;
    }
    const ok = await confirmDialog(
      `将删除选中的 ${ids.length} 个选题，同时移除对应的去重记录，删除后无法恢复。确定吗？`,
      `删除 ${ids.length} 个`
    );
    if (!ok) return;
    setButtonLoading(element, true, "删除中");
    try {
      const result = await api("/api/topics/batch-delete", {
        method: "POST",
        body: { topic_ids: ids },
      });
      state.selectedTopics.clear();
      toast(`已删除 ${result.deleted} 个选题，当前共 ${result.total} 个（含已用）`);
      await refreshTopics();
      await refreshOverview();
    } catch (error) {
      toast(error.message, true);
    } finally {
      setButtonLoading(element, false);
    }
    return;
  }
  if (action === "delete-selected-drafts") {
    const ids = Array.from(state.selectedDrafts);
    if (!ids.length) {
      toast("先勾选要删除的草稿", true);
      return;
    }
    const ok = await confirmDialog(
      `${state.draftAllMatched ? `已跨页选中当前筛选下的全部 ${ids.length} 篇` : `选中了本页的 ${ids.length} 篇`}草稿，连同配图文件、发布记录与队列任务一起清理，删除后无法恢复。确定吗？`,
      `删除 ${ids.length} 篇`
    );
    if (!ok) return;
    setButtonLoading(element, true, "删除中");
    try {
      const result = await api("/api/drafts/batch-delete", {
        method: "POST",
        body: { draft_ids: ids },
      });
      state.selectedDrafts.clear();
      state.draftAllMatched = false;
      if (ids.includes(state.studio.draftId)) resetStudio();
      toast(`已删除 ${result.deleted} 篇草稿，内容库剩 ${result.total} 篇`);
      await refreshLibrary();
      await refreshOverview();
    } catch (error) {
      toast(error.message, true);
    } finally {
      setButtonLoading(element, false);
    }
    return;
  }
  if (action === "delete-draft") {
    if (!(await confirmDialog("删除草稿会同时删除队列任务，确定吗？", "删除"))) return;
    await api(`/api/drafts/${id}`, { method: "DELETE" });
    if (state.studio.draftId === id) resetStudio();
    toast("草稿已删除");
    await refreshLibrary();
    await refreshOverview();
    return;
  }
  if (action === "retry-job") {
    await api(`/api/jobs/${id}/retry`, { method: "POST" });
    toast("已重新入队");
    await refreshLibrary();
    await refreshOverview();
    return;
  }
  if (action === "cancel-job") {
    await api(`/api/jobs/${id}/cancel`, { method: "POST" });
    toast("已取消");
    await refreshLibrary();
    await refreshOverview();
    return;
  }
  if (action === "confirm-job") {
    const published = element.dataset.published === "1";
    const ok = await confirmDialog(
      published
        ? "确认这条内容已经发布成功？确认后会记为成功，不再重试。"
        : "确认这条内容没有发出去？确认后可手动重试。",
      published ? "已发布" : "未发布"
    );
    if (!ok) return;
    setButtonLoading(element, true);
    try {
      await api(`/api/jobs/${id}/confirm`, {
        method: "POST",
        body: { published },
      });
      toast(published ? "已确认为发布成功" : "已确认为未发布，可重试");
      await refreshLibrary();
      await refreshOverview();
    } finally {
      setButtonLoading(element, false);
    }
    return;
  }
  if (action === "filter-job-reason") {
    const reason = element.dataset.reason || "";
    state.jobReason = state.jobReason === reason ? "" : reason;
    state.jobPage = 1;
    await refreshLibrary();
    return;
  }
  if (action === "open-account") {
    openAccountDrawer(id);
    return;
  }
  if (action === "test-account-proxy") {
    await testAccountProxy(id, element);
    return;
  }
  if (action === "clear-account-cooldown") {
    await clearAccountCooldown(id);
    return;
  }
  if (action === "account-batch") {
    const actionName = element.dataset.batch || "";
    if (!state.accountPicked.size) {
      toast("先勾选要操作的账号", true);
      return;
    }
    const body = { action: actionName, ids: Array.from(state.accountPicked) };
    if (actionName === "group") body.group_name = ($("#account-batch-group") || {}).value || "";
    if (actionName === "tag") body.tags = ($("#account-batch-tags") || {}).value || "";
    setButtonLoading(element, true);
    try {
      const data = await api("/api/accounts/batch", { method: "POST", body });
      toast(data.message || "批量操作完成");
      await refreshAccounts();
      await refreshOverview();
    } finally {
      setButtonLoading(element, false);
    }
    return;
  }
  if (action === "open-note") {
    openNoteDetail(id);
    return;
  }
  if (action === "sync-published") {
    await syncPublishedData(element);
    return;
  }
  if (action === "sync-comments") {
    await syncNoteComments(id, element);
    return;
  }
  if (action === "more-comments") {
    await loadNoteComments(id, Number(element.dataset.offset || 0), true);
    return;
  }
  if (action === "note-range") {
    await loadNoteMetrics(id, Number(element.dataset.days || 7));
    return;
  }
  if (action === "open-notification") {
    const item = state.notifications.find((entry) => entry.id === id);
    await openNotification(item);
    return;
  }
  if (action === "open-backups") {
    await openBackups();
    return;
  }
  if (action === "open-notify-channels") {
    await openNotifyChannels();
    return;
  }
  if (action === "open-proxies") {
    await openProxies();
    return;
  }
  if (action === "add-proxy") {
    setButtonLoading(element, true);
    try {
      await api("/api/proxies", {
        method: "POST",
        body: {
          name: ($("#proxy-name") || {}).value || "",
          url: ($("#proxy-url") || {}).value || "",
        },
      });
      toast("代理已添加");
      await loadProxyList();
    } finally {
      setButtonLoading(element, false);
    }
    return;
  }
  if (action === "test-proxy") {
    setButtonLoading(element, true, "测试中");
    try {
      const data = await api(`/api/proxies/${id}/test`, { method: "POST" });
      toast(data.message || "代理可用");
      await loadProxyList();
    } finally {
      setButtonLoading(element, false);
    }
    return;
  }
  if (action === "bind-proxy") {
    const select = $(`#bind-proxy-${id}`);
    const accountId = select ? select.value : "";
    if (!accountId) {
      toast("先选择要绑定的账号", true);
      return;
    }
    setButtonLoading(element, true);
    try {
      await api(`/api/accounts/${accountId}`, {
        method: "PATCH",
        body: { proxy: element.dataset.url || "", proxy_group: "" },
      });
      toast("已绑定代理，建议先测试出口");
      await refreshAccounts();
      await loadProxyList();
    } finally {
      setButtonLoading(element, false);
    }
    return;
  }
  if (action === "delete-proxy") {
    if (!(await confirmDialog("删除代理会同时解绑使用它的账号，确定吗？", "删除"))) return;
    await api(`/api/proxies/${id}`, { method: "DELETE" });
    toast("代理已删除");
    await loadProxyList();
    await refreshAccounts();
    return;
  }
  if (action === "create-backup") {
    setButtonLoading(element, true, "备份中");
    try {
      const data = await api("/api/backups", {
        method: "POST",
        body: {
          include_images: Boolean(($("#backup-images") || {}).checked),
          include_key: Boolean(($("#backup-key") || {}).checked),
        },
      });
      toast(data.message || `已创建 ${data.name}`);
      await loadBackupList();
    } finally {
      setButtonLoading(element, false);
    }
    return;
  }
  if (action === "restore-backup") {
    if (!(await confirmDialog("恢复后当前数据会被备份内容覆盖，确定吗？", "恢复"))) return;
    setButtonLoading(element, true, "恢复中");
    try {
      const data = await api("/api/backups/restore", {
        method: "POST",
        body: { name: element.dataset.name || "" },
      });
      toast(data.message || "恢复完成");
      await refreshOverview();
      await refreshAccounts();
      await refreshSettings();
      await loadBackupList();
    } finally {
      setButtonLoading(element, false);
    }
    return;
  }
  if (action === "delete-backup") {
    if (!(await confirmDialog("删除后无法找回，确定吗？", "删除"))) return;
    await api(`/api/backups/${encodeURIComponent(element.dataset.name || "")}`, {
      method: "DELETE",
    });
    toast("备份已删除");
    await loadBackupList();
    return;
  }
  if (action === "add-notify-channel") {
    setButtonLoading(element, true);
    try {
      await api("/api/notifications/channels", {
        method: "POST",
        body: {
          channel: ($("#notify-channel-kind") || {}).value || "webhook",
          name: ($("#notify-channel-name") || {}).value || "",
          target: ($("#notify-channel-target") || {}).value || "",
          events: [($("#notify-channel-events") || {}).value || "all"],
        },
      });
      toast("通知渠道已添加");
      await openNotifyChannels();
    } finally {
      setButtonLoading(element, false);
    }
    return;
  }
  if (action === "test-notify-channel") {
    setButtonLoading(element, true, "发送中");
    try {
      const data = await api(`/api/notifications/channels/${id}/test`, {
        method: "POST",
      });
      toast(data.ok ? "测试通知已发送" : data.message, !data.ok);
    } finally {
      setButtonLoading(element, false);
    }
    return;
  }
  if (action === "delete-notify-channel") {
    if (!(await confirmDialog("删除后不再通过该渠道推送，确定吗？", "删除"))) return;
    await api(`/api/notifications/channels/${id}`, { method: "DELETE" });
    toast("渠道已删除");
    await openNotifyChannels();
    return;
  }
  if (action === "new-schedule") return openScheduleWizard();
  if (action === "dismiss-schedule-intro") {
    try {
      localStorage.setItem(SCHEDULE_INTRO_KEY, "1");
    } catch (error) {
      // 忽略隐私模式写入失败。
    }
    const intro = $("#schedule-intro");
    if (intro) intro.hidden = true;
    return;
  }
  if (action === "toggle-schedule-detail") {
    await toggleScheduleDetail(id);
    return;
  }
  if (action === "edit-schedule") {
    const schedule = state.schedules.find((item) => item.id === id);
    if (schedule) openScheduleEditor(schedule);
    return;
  }
  if (action === "switch-schedule") {
    const schedule = state.schedules.find((item) => item.id === id);
    if (!schedule) return;
    await api(`/api/schedules/${id}`, { method: "PATCH", body: { enabled: !schedule.enabled } });
    toast(schedule.enabled ? "任务已停用" : "任务已启用");
    await refreshSchedules();
    await refreshOverview();
    return;
  }
  if (action === "toggle-schedule-auto") {
    const schedule = state.schedules.find((item) => item.id === id);
    if (!schedule) return;
    if (!schedule.auto) {
      const ok = await confirmDialog(
        "开启后到点将无人确认直接发布（可见范围按任务配置，建议先用「仅自己可见」）。确定开启全自动吗？",
        "开启全自动"
      );
      if (!ok) return;
    }
    await api(`/api/schedules/${id}`, { method: "PATCH", body: { auto: !schedule.auto } });
    toast(schedule.auto ? "已切回生成后待确认" : "已开启全自动");
    await refreshSchedules();
    return;
  }
  if (action === "run-schedule") {
    setButtonLoading(element, true, "执行中");
    try {
      const result = await api(`/api/schedules/${id}/run`, { method: "POST" });
      toast(result.message || (result.status === "success" ? "执行完成" : "执行结束"), result.status === "failed");
      await refreshSchedules();
      await refreshOverview();
    } finally {
      setButtonLoading(element, false);
    }
    return;
  }
  if (
    action === "open-run-topics" ||
    action === "open-run-drafts" ||
    action === "open-run-images" ||
    action === "open-run-publish"
  ) {
    await openRunStage(Number(element.dataset.run), action);
    return;
  }
  if (action === "rerun-stage") {
    const runId = Number(element.dataset.run);
    const stage = element.dataset.stage;
    setButtonLoading(element, true, "重跑中");
    try {
      const result = await api(`/api/schedule-runs/${runId}/rerun`, {
        method: "POST",
        body: { stage },
      });
      toast(result.message || "已重跑", result.status === "failed");
      const scheduleId = result.schedule_id || findRun(runId)?.schedule_id;
      if (scheduleId) {
        state.scheduleRunCache[scheduleId] = await api(
          `/api/schedule-runs?schedule_id=${scheduleId}&limit=5`
        );
      }
      await refreshSchedules();
      await refreshOverview();
    } catch (error) {
      toast(error.message, true);
    } finally {
      setButtonLoading(element, false);
    }
    return;
  }
  if (action === "delete-schedule") {
    if (!(await confirmDialog("删除后运行记录会保留，但任务不再执行，确定删除吗？", "删除"))) return;
    await api(`/api/schedules/${id}`, { method: "DELETE" });
    toast("计划任务已删除");
    await refreshSchedules();
    await refreshOverview();
    return;
  }
  if (action === "confirm-run") {
    if (!(await confirmDialog("确认发布这条运行记录里准备的草稿？", "确认发布"))) return;
    setButtonLoading(element, true, "发布中");
    try {
      const result = await api(`/api/schedule-runs/${id}/confirm`, { method: "POST" });
      toast(`已确认：成功 ${result.success} 篇，失败 ${result.failed} 篇`, result.failed > 0);
      await refreshSchedules();
      await refreshLibrary();
      await refreshOverview();
    } finally {
      setButtonLoading(element, false);
    }
  }
}

function bindEvents() {
  document.addEventListener("click", async (event) => {
    if (event.target.closest(".draft-pick")) return;
    // 折叠箭头（summary）自己处理展开，不要冒泡成卡片的「打开」动作。
    if (event.target.closest("summary")) return;
    const actionNode = event.target.closest("[data-action]");
    if (actionNode) {
      event.preventDefault();
      event.stopPropagation();
      try {
        await doAction(actionNode.dataset.action, actionNode);
      } catch (error) {
        toast(error.message, true);
      }
      $$(".card-more[open]").forEach((node) => node.removeAttribute("open"));
      return;
    }
    const tab = event.target.closest(".tab");
    if (tab) switchView(tab.dataset.view);
  });

  const uploadZone = $("#upload-zone");
  const uploadInput = $("#upload-input");
  uploadZone.addEventListener("click", () => uploadInput.click());
  uploadInput.addEventListener("click", (event) => event.stopPropagation());
  uploadInput.addEventListener("change", () => uploadImages(uploadInput.files));
  ["dragenter", "dragover"].forEach((name) => {
    uploadZone.addEventListener(name, (event) => {
      event.preventDefault();
      uploadZone.classList.add("dragover");
    });
  });
  ["dragleave", "dragend"].forEach((name) => {
    uploadZone.addEventListener(name, () => uploadZone.classList.remove("dragover"));
  });
  uploadZone.addEventListener("drop", (event) => {
    event.preventDefault();
    uploadZone.classList.remove("dragover");
    if (event.dataTransfer) uploadImages(event.dataTransfer.files);
  });

  /* 公众号封面卡片：和缩略图一样点击放大（支持键盘 Enter / 空格）。 */
  const coverBox = $("#wx-cover-preview");
  if (coverBox) {
    const zoomCover = (event) => {
      const slot = event.target.closest(".wx-cover-main, .wx-cover-square");
      if (!slot) return;
      const cover = state.studio.images[0];
      if (!cover) return;
      const square = (state.studio.contentJson || {}).wechat_square;
      const path = slot.classList.contains("wx-cover-square") && square ? square : cover;
      openLightbox([mediaUrl(path)], 0, () => {});
    };
    coverBox.addEventListener("click", zoomCover);
    coverBox.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        zoomCover(event);
      }
    });
  }

  $("#media-grid").addEventListener("click", (event) => {
    if (event.target.closest("[data-action]")) return;
    const thumb = event.target.closest(".media-thumb");
    if (!thumb) return;
    if (thumb.dataset.extra === "wechat-square") {
      const square = (state.studio.contentJson || {}).wechat_square;
      if (square) openLightbox([mediaUrl(square)], 0, () => {});
      return;
    }
    const urls = state.studio.images.map((path) => mediaUrl(path));
    openLightbox(urls, Number(thumb.dataset.index), () => {});
  });

  $("#account-chips").addEventListener("click", (event) => {
    const chip = event.target.closest("[data-account]");
    if (!chip) return;
    const id = Number(chip.dataset.account);
    if (state.studio.accountIds.has(id)) {
      if (state.studio.accountIds.size === 1) {
        toast("至少保留一个发布账号", true);
        return;
      }
      state.studio.accountIds.delete(id);
    } else {
      state.studio.accountIds.add(id);
    }
    state.studio.accountId = String(Array.from(state.studio.accountIds)[0] || "");
    state.studio.dirty = true;
    renderAccountChips();
    renderPreview();
  });

  $("#modal-close").addEventListener("click", closeModal);
  $("#modal-mask").addEventListener("click", (event) => {
    if (event.target === $("#modal-mask")) closeModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeModal();
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && state.view === "studio") {
      if (isWechatPlatform()) {
        toast("公众号发布需要点「立即发布」并确认，不用快捷键", true);
        return;
      }
      publishStudio();
    }
  });

  $("#btn-settings").addEventListener("click", openSettings);
  $("#btn-account").addEventListener("click", openAccountPanel);
  /* 主色控件常驻顶栏：点按钮开小面板，选完即时生效并保存。 */
  $("#btn-theme").addEventListener("click", (event) => {
    event.stopPropagation();
    setThemeMenu($("#theme-menu").hidden);
  });
  $("#theme-menu-list").addEventListener("click", (event) => {
    const node = event.target.closest("[data-theme-pick]");
    if (!node) return;
    event.stopPropagation();
    pickTheme(node.dataset.themePick);
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest("#theme-pop")) setThemeMenu(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setThemeMenu(false);
  });
  $("#btn-new-note").addEventListener("click", () => doAction("new-note", $("#btn-new-note")));
  $("#btn-clear-note").addEventListener("click", () => clearStudioDraft());

  // AI 起草的次要参数（语气、主题、开关）默认收起，主流程只留一句描述。
  const aiMoreBtn = $("#btn-ai-more");
  const aiMoreBox = $("#ai-more");
  aiMoreBtn.addEventListener("click", () => {
    const open = aiMoreBox.hidden;
    aiMoreBox.hidden = !open;
    aiMoreBtn.setAttribute("aria-expanded", String(open));
    aiMoreBtn.textContent = open ? "收起选项" : "选项";
  });

  // 模板选择放进浮层，避免 8 套风格把发布栏整体撑高。
  const styleTrigger = $("#style-trigger");
  const stylePop = $("#style-pop");
  /* 浮层挪到 body 下，脱离「准备发布」的滚动容器，位置由 trigger 实时计算。 */
  if (stylePop && stylePop.parentElement !== document.body) {
    document.body.appendChild(stylePop);
  }
  const positionStylePop = () => {
    if (!stylePop || stylePop.hidden || !styleTrigger) return;
    const rect = styleTrigger.getBoundingClientRect();
    if (!rect.width) return;
    const gap = 8;
    const width = Math.min(340, window.innerWidth - 24);
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
    const spaceBelow = window.innerHeight - rect.bottom - gap - 12;
    const spaceAbove = rect.top - gap - 12;
    const openUp = spaceBelow < 260 && spaceAbove > spaceBelow;
    stylePop.style.width = `${width}px`;
    stylePop.style.left = `${Math.round(left)}px`;
    if (openUp) {
      stylePop.style.top = "auto";
      stylePop.style.bottom = `${Math.round(window.innerHeight - rect.top + gap)}px`;
      stylePop.style.maxHeight = `${Math.round(Math.max(160, Math.min(520, spaceAbove)))}px`;
    } else {
      stylePop.style.bottom = "auto";
      stylePop.style.top = `${Math.round(rect.bottom + gap)}px`;
      stylePop.style.maxHeight = `${Math.round(Math.max(160, Math.min(520, spaceBelow)))}px`;
    }
  };
  const closeStylePop = () => {
    if (stylePop.hidden) return;
    stylePop.hidden = true;
    styleTrigger.setAttribute("aria-expanded", "false");
  };
  const openStylePop = () => {
    stylePop.hidden = false;
    styleTrigger.setAttribute("aria-expanded", "true");
    positionStylePop();
  };
  styleTrigger.addEventListener("click", (event) => {
    event.stopPropagation();
    if (stylePop.hidden) openStylePop();
    else closeStylePop();
  });
  window.addEventListener("resize", positionStylePop);
  document.addEventListener("scroll", positionStylePop, true);
  document.addEventListener("click", (event) => {
    if (stylePop.hidden) return;
    if (event.target.closest("#style-pop") || event.target.closest("#style-trigger")) return;
    closeStylePop();
  });
  $("#btn-retry-styles").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    setButtonLoading(button, true, "重试中");
    try {
      await refreshCardStyles();
    } catch (error) {
      showInline("#media-error", error.message);
    } finally {
      setButtonLoading(button, false);
    }
  });
  function setPreviewOpen(on) {
    const studio = $("#view-studio .studio");
    if (!studio) return;
    studio.classList.toggle("show-preview", on);
    const toggle = $("#btn-toggle-preview");
    if (toggle) {
      toggle.setAttribute("aria-pressed", String(on));
      toggle.textContent = on ? "收起预览" : "预览";
    }
  }
  $("#btn-toggle-preview").addEventListener("click", () => {
    const studio = $("#view-studio .studio");
    const on = !studio.classList.contains("show-preview");
    setPreviewOpen(on);
    if (on) {
      const preview = $(".preview-pane");
      if (preview) preview.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
  $("#btn-close-preview").addEventListener("click", () => {
    setPreviewOpen(false);
    const editor = $(".editor-pane");
    if (editor) editor.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  $("#btn-add-account").addEventListener("click", openAddAccount);
  $("#btn-import-env").addEventListener("click", async () => {
    const button = $("#btn-import-env");
    setButtonLoading(button, true, "导入中");
    try {
      const account = await api("/api/accounts/import-env", { method: "POST" });
      toast(`已导入：${account.nickname || account.name}`);
      await refreshAccounts();
      await refreshOverview();
    } catch (error) {
      toast(error.message, true);
    } finally {
      setButtonLoading(button, false);
    }
  });
  $("#btn-check-all").addEventListener("click", async () => {
    if (!state.accounts.length) return toast("还没有账号", true);
    const button = $("#btn-check-all");
    setButtonLoading(button, true, "检查中");
    for (const account of state.accounts.filter((item) => item.enabled)) {
      try {
        await api(`/api/accounts/${account.id}/check`, { method: "POST" });
      } catch (error) {
        /* 单个失败不阻断 */
      }
    }
    toast("检查完成");
    setButtonLoading(button, false);
    await refreshAccounts();
    await refreshOverview();
  });

  $("#btn-generate").addEventListener("click", generateCopy);
  $("#btn-save").addEventListener("click", saveStudio);
  bindPreviewEditing();
  const editBar = $("#wx-edit-bar");
  if (editBar) {
    editBar.addEventListener("click", (event) => {
      const button = event.target.closest("[data-wx-cmd]");
      if (button) handleWechatCommand(button.dataset.wxCmd);
    });
  }
  const mdCancel = $("#md-pop-cancel");
  if (mdCancel) mdCancel.addEventListener("click", () => toggleMdPop(false));
  const mdInsert = $("#md-pop-insert");
  if (mdInsert) mdInsert.addEventListener("click", insertMarkdownFromPop);
  const bodyFormat = $("#body-format");
  if (bodyFormat) {
    bodyFormat.addEventListener("click", (event) => {
      const button = event.target.closest("[data-body-format]");
      if (button) switchBodyFormat(button.dataset.bodyFormat);
    });
  }
  const wxThemeBtn = $("#btn-wx-theme");
  if (wxThemeBtn) {
    wxThemeBtn.addEventListener("click", (event) => {
      if (state.studio.platform !== "wechat_mp") {
        toast("排版主题只作用于公众号正文", true);
        return;
      }
      toggleThemePop(undefined, event.currentTarget);
    });
  }
  const themeList = $("#theme-list");
  if (themeList) {
    themeList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-theme]");
      if (button) applyWechatTheme(button.dataset.theme);
    });
  }
  const inlineUpload = $("#wx-inline-upload");
  if (inlineUpload) {
    inlineUpload.addEventListener("change", (event) =>
      uploadWechatInlineImages(event.target.files)
    );
  }
  $("#btn-publish").addEventListener("click", () => publishStudio("queue"));
  $("#btn-publish-now").addEventListener("click", () => publishStudio("publish"));
  $("#btn-save-platform-draft").addEventListener("click", () => publishStudio("draft"));
  $("#btn-cards-free").addEventListener("click", generateCards);
  $("#btn-motion").addEventListener("click", generateMotion);
  $("#btn-cards-paid").addEventListener("click", generatePaidCards);
  $("#media-tabs").addEventListener("click", (event) => {
    const tab = event.target.closest(".media-tab");
    if (tab) switchMediaTab(tab.dataset.tab);
  });
  ["#f-title", "#f-desc", "#f-topics"].forEach((selector) => {
    $(selector).addEventListener("input", () => {
      state.studio.dirty = true;
      /* 在左侧正文框里改字时，以纯文本为准，避免预览还停在旧的富文本上；
         Markdown 模式例外：正文框就是源码，交给防抖渲染。 */
      if (selector === "#f-desc") {
        if (state.studio.mdMode) scheduleMarkdownRender();
        else if (state.studio.bodyHtml) state.studio.bodyHtml = "";
      }
      /* 用户改了内容，上一轮生成失败的提示就过期了。 */
      clearErrorBox("#media-error");
      refreshStudioUI();
      scheduleComplianceCheck();
      if (selector === "#f-title") $("#f-title").classList.remove("invalid");
      if (selector === "#f-desc") $("#f-desc").classList.remove("invalid");
    });
  });
  $("#f-topic").addEventListener("input", () => {
    state.studio.dirty = true;
  });
  $("#f-brief").addEventListener("input", () => {
    $("#count-brief").textContent = `${$("#f-brief").value.length} / 500`;
  });
  // 可见范围与平台按钮由 renderPlatformUi 动态重绘，统一用事件委托。
  $("#f-visibility").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-value]");
    if (!button) return;
    $$("#f-visibility button").forEach((item) => item.classList.toggle("active", item === button));
    state.studio.visibility = Number(button.dataset.value);
    state.studio.dirty = true;
    renderCompliance();
  });

  $("#f-platform").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-platform]");
    if (!button) return;
    const target = button.dataset.platform;
    if (target === state.studio.platform) return;
    switchStudioPlatform(target);
  });

  $("#f-content-type").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-content-type]");
    if (!button) return;
    switchStudioContentType(button.dataset.contentType);
  });

  // 该入口只在草稿跨平台时才会渲染，没有时不能阻断其它绑定。
  const copyPlatformBtn = $("#btn-copy-platform");
  if (copyPlatformBtn) copyPlatformBtn.addEventListener("click", copyDraftToPlatform);

  $("#btn-rewrite-text").addEventListener("click", openRewriteText);
  $("#btn-refresh-library").addEventListener("click", () => refreshLibrary().catch((error) => toast(error.message, true)));
  $("#btn-records").addEventListener("click", () => switchView("records"));
  $("#btn-setup-go").addEventListener("click", () => switchView(state.setupView || "accounts"));
  $("#btn-queue-ready").addEventListener("click", async () => {
    const button = $("#btn-queue-ready");
    setButtonLoading(button, true, "检查中");
    let all = [];
    try {
      all = await api("/api/drafts?status=draft&limit=500");
    } catch (error) {
      toast(error.message, true);
      setButtonLoading(button, false);
      return;
    }
    const ready = all.filter((draft) => draft.can_publish);
    if (!ready.length) {
      toast("没有可发布的草稿：需要正文、配图且无合规风险", true);
      setButtonLoading(button, false);
      return;
    }
    if (!(await confirmDialog(`将 ${ready.length} 篇草稿加入发布队列，按账号限额自动轮换。确定吗？`, "批量入队"))) {
      setButtonLoading(button, false);
      return;
    }
    setButtonLoading(button, true, "提交中");
    try {
      await api("/api/jobs", {
        method: "POST",
        body: { draft_ids: ready.map((draft) => draft.id), account_id: null },
      });
      toast(`已加入 ${ready.length} 篇`);
      await refreshLibrary();
      await refreshOverview();
    } catch (error) {
      toast(error.message, true);
    } finally {
      setButtonLoading(button, false);
    }
  });
  const queueToggle = $("#btn-toggle-queue");
  if (queueToggle) {
    queueToggle.addEventListener("click", (event) => {
      const section = $("#queue-section");
      if (!section) return;
      const open = !section.classList.contains("open");
      section.classList.toggle("open", open);
      event.currentTarget.setAttribute("aria-expanded", String(open));
      event.currentTarget.textContent = open ? "收起" : "展开";
    });
  }
  bindPager("#library-pager", (page) => {
    state.draftPage = page;
    refreshLibrary().catch((error) => toast(error.message, true));
  });
  bindPager("#job-pager", (page) => {
    state.jobPage = page;
    refreshLibrary().catch((error) => toast(error.message, true));
  });
  bindPager("#published-pager", (page) => {
    state.publishedPage = page;
    refreshPublished().catch((error) => toast(error.message, true));
  });
  $("#library-mode").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-lib-mode]");
    if (!button) return;
    setLibraryMode(button.dataset.libMode);
  });
  $("#published-filter").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-health]");
    if (!button) return;
    $$("#published-filter button[data-health]").forEach((item) =>
      item.classList.toggle("active", item === button)
    );
    state.publishedHealth = button.dataset.health || "";
    state.publishedPage = 1;
    refreshPublished().catch((error) => toast(error.message, true));
  });
  $("#published-account-filter").addEventListener("change", (event) => {
    state.publishedAccountId = event.target.value;
    state.publishedPage = 1;
    refreshPublished().catch((error) => toast(error.message, true));
  });
  $("#btn-sync-published").addEventListener("click", (event) =>
    syncPublishedData(event.currentTarget).catch((error) => toast(error.message, true))
  );
  $("#btn-health-check").addEventListener("click", (event) =>
    runHealthCheck(event.currentTarget).catch((error) => toast(error.message, true))
  );
  $("#account-group-filter").addEventListener("change", (event) => {
    state.accountGroupFilter = event.target.value;
    state.accountPicked.clear();
    refreshAccounts().catch((error) => toast(error.message, true));
  });
  $("#btn-account-batch").addEventListener("click", () => {
    state.accountBatch = !state.accountBatch;
    if (!state.accountBatch) state.accountPicked.clear();
    renderAccounts();
  });
  $("#account-grid").addEventListener("change", (event) => {
    const box = event.target.closest("[data-account-pick]");
    if (!box) return;
    const accountId = Number(box.dataset.accountPick);
    if (box.checked) state.accountPicked.add(accountId);
    else state.accountPicked.delete(accountId);
    renderAccountBatchBar();
    const card = box.closest(".account-card");
    if (card) card.classList.toggle("picked", box.checked);
  });
  $("#drawer-close").addEventListener("click", closeAccountDrawer);
  $("#drawer-mask").addEventListener("click", closeAccountDrawer);
  $("#btn-attention-go").addEventListener("click", () => {
    const target = state.attentionTarget;
    if (target === "accounts") {
      switchView("accounts");
      return;
    }
    if (target === "published") {
      switchView("library");
      state.publishedHealth = "attention";
      state.publishedPage = 1;
      $$("#published-filter button[data-health]").forEach((item) =>
        item.classList.toggle("active", item.dataset.health === "attention")
      );
      setLibraryMode("published");
      return;
    }
    switchView("library");
    setLibraryMode("drafts");
    const toggle = $("#btn-toggle-queue");
    if (toggle && toggle.getAttribute("aria-expanded") !== "true") toggle.click();
  });
  $("#btn-notify").addEventListener("click", (event) => {
    event.stopPropagation();
    toggleNotifyPop();
  });
  $("#btn-notify-read").addEventListener("click", (event) => {
    event.stopPropagation();
    markNotificationsRead();
  });
  $("#btn-notify-channels").addEventListener("click", (event) => {
    event.stopPropagation();
    openNotifyChannels();
  });
  document.addEventListener("click", (event) => {
    if (event.target.closest(".notify-wrap")) return;
    if (!$("#notify-pop").hidden) toggleNotifyPop(false);
  });
  bindPager("#record-pager", (page) => {
    state.recordPage = page;
    refreshRecords().catch((error) => toast(error.message, true));
  });
  bindPager("#schedule-pager", (page) => {
    state.schedulePage = page;
    refreshSchedules(false).catch((error) => toast(error.message, true));
  });
  $("#btn-refresh-records").addEventListener("click", () => refreshRecords().catch((error) => toast(error.message, true)));
  $("#btn-refresh-schedules").addEventListener("click", () =>
    refreshSchedules().catch((error) => toast(error.message, true))
  );
  $("#btn-new-schedule").addEventListener("click", () => openScheduleWizard());
  $("#draft-filter").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-status]");
    if (!button) return;
    $$("#draft-filter button").forEach((item) => item.classList.toggle("active", item === button));
    state.draftFilter = button.dataset.status;
    state.draftPage = 1;
    clearDraftSelection();
    refreshLibrary().catch((error) => toast(error.message, true));
  });
  $("#draft-platform-filter").addEventListener("change", (event) => {
    state.draftPlatformFilter = event.target.value;
    state.draftPage = 1;
    clearDraftSelection();
    refreshLibrary().catch((error) => toast(error.message, true));
  });
  $("#draft-check-all").addEventListener("change", (event) => {
    const checked = event.target.checked;
    state.drafts.forEach((draft) => {
      if (checked) state.selectedDrafts.add(draft.id);
      else state.selectedDrafts.delete(draft.id);
    });
    if (!checked) state.draftAllMatched = false;
    updateDraftSelected();
  });
  $("#btn-select-all-filtered").addEventListener("click", async () => {
    const button = $("#btn-select-all-filtered");
    if (state.draftAllMatched) {
      clearDraftSelection();
      return;
    }
    button.disabled = true;
    try {
      const query = new URLSearchParams({ limit: "500" });
      if (state.draftFilter) query.set("status", state.draftFilter);
      if (state.draftPlatformFilter) query.set("platform", state.draftPlatformFilter);
      const all = await api(`/api/drafts?${query.toString()}`);
      state.selectedDrafts = new Set(all.map((draft) => draft.id));
      state.draftAllMatched = true;
      updateDraftSelected();
    } catch (error) {
      toast(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
  $("#btn-queue-selected").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const ids = Array.from(state.selectedDrafts);
    if (!ids.length) return;
    const scope = state.draftAllMatched ? "（跨页，当前筛选结果）" : "（本页）";
    if (
      !(await confirmDialog(
        `将选中的 ${ids.length} 篇${scope}加入发布队列，按账号限额自动轮换。确定吗？`,
        `入队 ${ids.length} 篇`
      ))
    ) {
      return;
    }
    setButtonLoading(button, true, "提交中");
    try {
      await api("/api/jobs", {
        method: "POST",
        body: { draft_ids: ids, account_id: null },
      });
      toast(`已加入 ${ids.length} 篇`);
      clearDraftSelection();
      await refreshLibrary();
      await refreshOverview();
    } catch (error) {
      toast(error.message, true);
    } finally {
      setButtonLoading(button, false);
    }
  });
  $("#draft-grid").addEventListener("change", (event) => {
    const node = event.target.closest(".draft-check");
    if (!node) return;
    const id = Number(node.dataset.id);
    if (node.checked) state.selectedDrafts.add(id);
    else {
      state.selectedDrafts.delete(id);
      state.draftAllMatched = false;
    }
    updateDraftSelected();
  });
  $("#btn-delete-drafts").addEventListener("click", (event) => {
    event.preventDefault();
    doAction("delete-selected-drafts", event.currentTarget).catch((error) =>
      toast(error.message, true)
    );
  });
  $("#btn-delete-topics").addEventListener("click", (event) => {
    event.preventDefault();
    doAction("delete-selected-topics", event.currentTarget).catch((error) =>
      toast(error.message, true)
    );
  });
  $("#btn-tick").addEventListener("click", async () => {
    const button = $("#btn-tick");
    setButtonLoading(button, true, "执行中");
    try {
      const result = await api("/api/worker/tick", { method: "POST" });
      const ran = (result.published && result.published.ran) || 0;
      toast(ran ? `执行了 ${ran} 个任务` : "没有到期任务");
      await refreshLibrary();
      await refreshOverview();
    } catch (error) {
      toast(error.message, true);
    } finally {
      setButtonLoading(button, false);
    }
  });

  $("#btn-mine").addEventListener("click", runMining);
  bindPager("#topic-pager", (page) => {
    state.topicPage = page;
    refreshTopics().catch((error) => toast(error.message, true));
  });
  const syncMineMode = (mode) => {
    $("#mine-input").placeholder =
      mode === "keyword"
        ? "面试, 秋招, 自我介绍（逗号分隔）"
        : mode === "competitor"
        ? "每行一个竞品主页链接"
        : mode === "channel"
        ? "频道名：职场, 学习, 生活（逗号分隔）"
        : "热榜不需要输入，直接挖掘";
    $("#mine-input").disabled = mode === "trending";
    if (mode === "trending") $("#mine-input").value = "";
  };
  $("#mine-modes").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-mode]");
    if (!button || button.classList.contains("active")) return;
    $$("#mine-modes button").forEach((item) => {
      const on = item === button;
      item.classList.toggle("active", on);
      item.setAttribute("aria-selected", on ? "true" : "false");
    });
    syncMineMode(button.dataset.mode);
  });
  $("#btn-mine-options").addEventListener("click", (event) => {
    const box = $("#mine-options");
    const open = box.hidden;
    box.hidden = !open;
    event.currentTarget.setAttribute("aria-expanded", String(open));
    event.currentTarget.textContent = open ? "收起选项" : "更多选项";
  });
  $("#topic-status-chips").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-status]");
    if (!button || button.classList.contains("on")) return;
    $$("#topic-status-chips button").forEach((item) => item.classList.toggle("on", item === button));
    state.topicStatus = button.dataset.status;
    resetTopicPaging();
    refreshTopics().catch((error) => toast(error.message, true));
  });
  $("#btn-filter-more").addEventListener("click", (event) => {
    const box = $("#filter-extra");
    const open = box.hidden;
    box.hidden = !open;
    event.currentTarget.setAttribute("aria-expanded", String(open));
    event.currentTarget.classList.toggle("active", open);
  });
  ["#topic-source", "#topic-sort", "#topic-min-score"].forEach((selector) => {
    $(selector).addEventListener("change", () => {
      resetTopicPaging();
      refreshTopics().catch((error) => toast(error.message, true));
    });
  });
  $("#btn-toggle-dedupes").addEventListener("click", async (event) => {
    state.showDedupes = !state.showDedupes;
    event.currentTarget.classList.toggle("active", state.showDedupes);
    if (state.showDedupes) await refreshDedupes();
    else renderDedupes();
  });
  $("#btn-import-topics").addEventListener("click", openImportTopics);
  $("#topic-search").addEventListener("input", () => {
    clearTimeout(window.__topicSearchTimer);
    window.__topicSearchTimer = setTimeout(() => {
      resetTopicPaging();
      refreshTopics().catch(reportBackgroundError);
    }, 300);
  });
  $("#topic-check-all").addEventListener("change", (event) => {
    if (event.target.checked) state.topics.forEach((topic) => state.selectedTopics.add(topic.id));
    else state.selectedTopics.clear();
    renderTopics();
  });
  $("#topic-list").addEventListener("change", (event) => {
    const node = event.target.closest(".topic-check");
    if (!node) return;
    const id = Number(node.dataset.id);
    if (node.checked) state.selectedTopics.add(id);
    else state.selectedTopics.delete(id);
    const card = node.closest(".topic-card");
    if (card) card.classList.toggle("selected", node.checked);
    updateTopicSelected();
  });
  // 卡片右上角的「更多」菜单：点空白处收起，避免多张卡片同时展开。
  document.addEventListener("click", (event) => {
    $$(".card-more[open]").forEach((node) => {
      if (!event.target.closest(".card-more")) node.removeAttribute("open");
    });
  });
  $("#btn-add-topic").addEventListener("click", openAddTopic);
  $("#btn-import-library").addEventListener("click", async () => {
    const button = $("#btn-import-library");
    setButtonLoading(button, true, "导入中");
    try {
      const result = await api("/api/topics/import-library", { method: "POST", body: {} });
      toast(`导入 ${result.inserted} 条，跳过 ${result.skipped} 条`);
      await refreshTopics();
      await refreshOverview();
    } catch (error) {
      toast(error.message, true);
    } finally {
      setButtonLoading(button, false);
    }
  });
  $("#btn-create-drafts").addEventListener("click", async () => {
    const ids = Array.from(state.selectedTopics);
    if (!ids.length) {
      toast("先在选题列表里勾选要生成草稿的选题", true);
      return;
    }
    const drafts = await generateDrafts(
      {
        topic_ids: ids,
        tone: $("#draft-tone").value,
        variants: Number($("#draft-variants").value || 1),
        with_cards: $("#draft-cards").checked,
      },
      $("#btn-create-drafts"),
      "生成中"
    );
    if (drafts.length) {
      state.selectedTopics.clear();
      await refreshTopics();
    }
  });
}

/* ------------------------------------------------------------------ 版本更新 */

const UPDATE_SKIP_KEY = "echoq-update-skip";

function renderUpdate(info) {
  const banner = $("#update-banner");
  const title = $("#update-title");
  const notes = $("#update-notes");
  const later = $("#btn-update-later");
  const download = $("#btn-update-download");
  if (!banner || !title || !notes || !later || !download) return;
  const latest = info && info.latest;
  if (!info || !info.update_available || !latest) {
    banner.hidden = true;
    return;
  }
  /* 用户点过「稍后」就不再骚扰，但强制更新必须继续提示。 */
  const skipped = localStorage.getItem(UPDATE_SKIP_KEY) || "";
  if (!info.mandatory && skipped === latest.version) {
    banner.hidden = true;
    return;
  }
  banner.classList.toggle("mandatory", Boolean(info.mandatory));
  title.textContent = info.mandatory
    ? `需要升级到 v${latest.version}`
    : `发现新版本 v${latest.version}`;
  notes.textContent =
    latest.notes || (latest.published_at ? `发布于 ${latest.published_at.slice(0, 10)}` : "");
  notes.hidden = !notes.textContent;
  const url = latest.download && latest.download.url;
  download.href = url || "#";
  download.hidden = !url;
  later.hidden = Boolean(info.mandatory);
  later.onclick = () => {
    localStorage.setItem(UPDATE_SKIP_KEY, latest.version);
    banner.hidden = true;
  };
  banner.hidden = false;
}

async function refreshUpdate() {
  try {
    renderUpdate(await api("/api/update"));
  } catch (error) {
    /* 更新检查失败保持安静：连不上云端时后端也会返回 checked=false。 */
  }
}

/* ------------------------------------------------------------------ 启动 */

async function boot() {
  resetStudio();
  try {
    bindEvents();
    refreshCloudStatus({ refresh: true, silent: true });
    refreshUpdate();
    checkCloudHealth();
    await refreshSettings();
    await refreshPlatforms();
    await Promise.all([
      refreshCardStyles(),
      refreshAccounts(),
      refreshOverview(),
      refreshNotifications({ silent: true }),
    ]);
    setEngineBadge();
    await refreshTopics();
  } catch (error) {
    toast(error.message, true);
  } finally {
    verifyCardStyleUi();
  }
  setInterval(refreshUpdate, 6 * 60 * 60 * 1000);
  setInterval(() => refreshOverview().catch(reportBackgroundError), 30000);
  setInterval(() => refreshNotifications({ silent: true }), 60000);
  setInterval(() => {
    if (state.view !== "library") return;
    if (state.libraryMode === "published") {
      refreshPublished({ silent: true }).catch(reportBackgroundError);
    } else {
      refreshLibrary({ silent: true }).catch(reportBackgroundError);
    }
  }, 15000);
  setInterval(() => {
    if (state.view === "records") refreshRecords().catch(reportBackgroundError);
  }, 20000);
  setInterval(() => {
    if (state.view === "schedule") refreshSchedules().catch(reportBackgroundError);
  }, 15000);
}

async function refreshSettings() {
  state.settings = await api("/api/settings");
  applyTheme((state.settings.values || {}).theme_color || "red", { persist: true });
  setEngineBadge();
}

async function refreshCardStyles() {
  // 两个接口互不连坐：付费配置挂了，不影响免费模板；反之亦然。
  const [optionsResult, designResult] = await Promise.allSettled([
    api("/api/cards/options"),
    api("/api/design/styles"),
  ]);
  const optionsError =
    optionsResult.status === "rejected"
      ? friendlyError(optionsResult.reason && optionsResult.reason.message)
      : "";
  const designError =
    designResult.status === "rejected"
      ? friendlyError(designResult.reason && designResult.reason.message)
      : "";
  const options = optionsResult.status === "fulfilled" && optionsResult.value ? optionsResult.value : {};
  const designStyles =
    designResult.status === "fulfilled" && Array.isArray(designResult.value) ? designResult.value : null;

  state.cardOptions = {
    styles: Array.isArray(options.styles) ? options.styles : [],
    layouts: Array.isArray(options.layouts) ? options.layouts : [],
    palettes: Array.isArray(options.palettes) ? options.palettes : [],
    presets: Array.isArray(options.presets) ? options.presets : [],
    backend: options.backend || {},
    paid: options.paid || {},
  };
  state.cardStyles = state.cardOptions.styles;
  // 接口明确失败时保留上次成功的数据，避免一次抖动把界面清空。
  if (designStyles) state.designStyles = designStyles;
  if (!state.designStyles.some((item) => item.key === state.cardStyle)) {
    state.cardStyle = (state.designStyles[0] && state.designStyles[0].key) || "";
  }
  state.styleError =
    designError ||
    (state.designStyles.length ? "" : "服务器暂时没有返回可用的免费模板。");
  const paidStylesCount = (state.cardOptions.paid.styles || []).length;
  state.paidError = optionsError || (paidStylesCount ? "" : "付费出图的配置没加载出来。");

  renderCardStyleGrid();

  const paid = state.cardOptions.paid || {};
  const fill = (selector, items, emptyLabel = "") => {
    const select = $(selector);
    if (!select) return;
    const value = select.value;
    select.innerHTML =
      (emptyLabel ? `<option value="">${esc(emptyLabel)}</option>` : "") +
      items
        .map((item) => `<option value="${esc(item.key)}">${esc(item.label)} · ${esc(item.key)}</option>`)
        .join("");
    if (value && items.some((item) => item.key === value)) select.value = value;
  };
  fill("#f-paid-style", paid.styles || []);
  fill("#f-paid-layout", paid.layouts || []);
  fill("#f-paid-palette", paid.palettes || [], "跟随风格");

  renderPaidPanel();
  switchMediaTab(state.mediaTab);
  syncCardStyleHint();
  renderStyleStatus();
  verifyCardStyleUi();
}

/* 模板加载失败时的可见状态：一行说明 + 重试，绝不留下空白面板。 */
function renderStyleStatus() {
  const box = $("#style-status");
  const text = $("#style-status-text");
  const trigger = $("#style-trigger");
  const generate = $("#btn-cards-free");
  if (!box) return;
  const broken = Boolean(state.styleError);
  box.hidden = !broken;
  if (text) text.textContent = state.styleError || "";
  if (trigger) trigger.disabled = broken;
  if (generate) generate.disabled = broken;
  if (broken) {
    const current = $("#style-current");
    if (current) current.textContent = "暂时不可用";
    const pop = $("#style-pop");
    if (pop) pop.hidden = true;
    if (trigger) trigger.setAttribute("aria-expanded", "false");
  }
  if (!broken && !$("#style-pop").hidden) {
    trigger.setAttribute("aria-expanded", "true");
  }
}

// 接口数量与前端实际渲染数量必须一致；不一致时给出可重试的提示，不静默。
const CARD_STYLE_BASELINE = { free: 8, paidStyles: 12, paidLayouts: 8, paidPalettes: 3 };

function verifyCardStyleUi() {
  const paid = paidOptions();
  const apiCounts = {
    free: state.designStyles.length,
    paidStyles: (paid.styles || []).length,
    paidLayouts: (paid.layouts || []).length,
    paidPalettes: (paid.palettes || []).length,
  };
  const renderedFree = $$("#card-style-grid .style-chip").length;
  const renderedPaid = {
    paidStyles: $$("#f-paid-style option").length,
    paidLayouts: $$("#f-paid-layout option").length,
    paidPalettes: $$("#f-paid-palette option[value]:not([value=''])").length,
  };
  const problems = [];
  Object.entries(CARD_STYLE_BASELINE).forEach(([key, minimum]) => {
    if (!apiCounts[key]) problems.push(`${key} 接口返回 0`);
    else if (apiCounts[key] < minimum) problems.push(`${key} 仅 ${apiCounts[key]}，少于 ${minimum}`);
  });
  if (renderedFree !== apiCounts.free) {
    problems.push(`免费风格块 ${renderedFree} 个 ≠ 接口 ${apiCounts.free} 套`);
  }
  Object.entries(renderedPaid).forEach(([key, count]) => {
    if (count !== apiCounts[key]) problems.push(`${key} 下拉 ${count} 项 ≠ 接口 ${apiCounts[key]} 项`);
  });
  if (problems.length) {
    console.error("[配图风格自检]", problems.join("；"), { apiCounts, renderedFree, renderedPaid });
    if (!state.styleError && apiCounts.free < CARD_STYLE_BASELINE.free) {
      state.styleError = `配图模板没加载完整（${apiCounts.free}/${CARD_STYLE_BASELINE.free} 套）。`;
    }
    if (!state.paidError && apiCounts.paidStyles < CARD_STYLE_BASELINE.paidStyles) {
      state.paidError = `付费出图选项没加载完整（${apiCounts.paidStyles}/${CARD_STYLE_BASELINE.paidStyles} 项）。`;
    }
    renderStyleStatus();
    if (state.mediaTab === "paid") renderPaidPanel();
    return false;
  }
  clearErrorBox("#media-error");
  return true;
}

function renderCardStyleGrid() {
  const grid = $("#card-style-grid");
  if (!grid) return;
  const groups = [
    { key: "new", label: "新版模板" },
    { key: "classic", label: "经典模板" },
    { key: "art", label: "手绘插画" },
  ];
  const chip = (item) => {
    const colors = Array.isArray(item.colors) ? item.colors : [];
    const dot = colors[2] || colors[1] || "var(--accent)";
    return `
    <button class="style-chip${item.key === state.cardStyle ? " active" : ""}" type="button"
      role="radio" aria-checked="${item.key === state.cardStyle}" data-key="${esc(item.key)}">
      <span class="style-dot" style="background:${esc(dot)}"></span>
      <span class="style-chip-text"><b>${esc(item.name)}</b></span>
    </button>`;
  };
  grid.innerHTML =
    (state.designStyles.some((item) => item.key === "paper")
      ? ""
      : '<p class="style-pop-warn">后端还没加载「实拍纸感」：请重启运营台，再刷新这个页面。</p>') +
    groups
      .map((group) => {
        const items = state.designStyles.filter((item) => (item.group || "classic") === group.key);
        if (!items.length) return "";
        return `<div class="style-group"><span class="style-group-label">${group.label}</span>
          <div class="style-group-grid">${items.map(chip).join("")}</div></div>`;
      })
      .join("");
  grid.querySelectorAll(".style-chip").forEach((node) => {
    node.addEventListener("click", () => {
      state.cardStyle = node.dataset.key;
      grid.querySelectorAll(".style-chip").forEach((item) => {
        const active = item.dataset.key === state.cardStyle;
        item.classList.toggle("active", active);
        item.setAttribute("aria-checked", String(active));
      });
      syncCardStyleHint();
      renderMedia();
      scheduleCardPlan();
      const pop = $("#style-pop");
      if (pop) pop.hidden = true;
      const trigger = $("#style-trigger");
      if (trigger) trigger.setAttribute("aria-expanded", "false");
    });
  });
}

function syncCardStyleHint() {
  const hint = $("#card-style-hint");
  const current = $("#style-current");
  const design = state.designStyles.find((item) => item.key === state.cardStyle);
  if (current) current.textContent = design ? design.name : "选择模板";
  if (!hint) return;
  hint.textContent = design
    ? `${design.name} · ${design.desc}（本机渲染，不调用付费接口）`
    : "本机渲染，不调用付费接口。";
}

document.addEventListener("DOMContentLoaded", boot);



