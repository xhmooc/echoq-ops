/* 应声运营 · UI Refresh 2026
 *
 * 只做界面层增强：
 *   - 侧栏导航（折叠 / 面包屑）
 *   - 运营管理首页、数据概览（复用既有接口与 state）
 *   - 命令面板（Ctrl K）
 *   - 状态栏、侧栏用量
 *   - 设置 / 个人中心浮窗的分组与导航
 *
 * 不修改 app.js 的任何业务逻辑；所有数据都来自现有接口。
 */

(function () {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const VIEW_META = {
    home: ["工作台", "运营管理"],
    dashboard: ["数据", "数据概览"],
    studio: ["工作台", "创作台"],
    library: ["内容", "内容库"],
    topics: ["内容", "选题池"],
    templates: ["内容", "模板"],
    schedule: ["发布", "发布计划"],
    queue: ["发布", "发布队列"],
    records: ["发布", "发布记录"],
    accounts: ["运营", "账号管理"],
  };

  const NAV_META = [
    { group: "工作台", items: [
      { view: "home", name: "运营管理", desc: "待办、数据与快捷入口", icon: "home" },
      { view: "studio", name: "创作台", desc: "写文案、配图与实时预览", icon: "edit" },
    ] },
    { group: "内容", items: [
      { view: "library", name: "内容库", desc: "草稿、队列与已发布作品", icon: "grid" },
      { view: "topics", name: "选题池", desc: "关键词挖掘与竞品选题", icon: "list" },
      { view: "templates", name: "模板", desc: "自定义出图模板编辑器", icon: "palette" },
    ] },
    { group: "发布", items: [
      { view: "schedule", name: "发布计划", desc: "定时任务与自动写稿", icon: "calendar" },
      { view: "queue", name: "发布队列", desc: "排队、重试与失败处理", icon: "queue" },
      { view: "records", name: "发布记录", desc: "成功与失败留痕", icon: "file" },
    ] },
    { group: "数据", items: [
      { view: "dashboard", name: "数据概览", desc: "发布趋势与成功率", icon: "chart" },
    ] },
    { group: "运营", items: [
      { view: "accounts", name: "账号管理", desc: "登录状态与发布限额", icon: "user" },
    ] },
  ];

  const ICONS = {
    home: '<path d="M4 10.5L12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z"/>',
    chart: '<path d="M4 20V9m5 11V4m5 16v-7m5 7V7"/>',
    edit: '<path d="M15.5 4.5l4 4L8 20H4v-4z"/><path d="M13 7l4 4"/>',
    grid: '<rect x="3.5" y="4.5" width="7" height="15" rx="1.5"/><rect x="13.5" y="4.5" width="7" height="15" rx="1.5"/>',
    list: '<path d="M5 6h14M5 12h9M5 18h12"/>',
    calendar: '<rect x="4" y="5.5" width="16" height="15" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
    queue: '<path d="M4 7h16M4 12h16M4 17h10"/><circle cx="18" cy="17" r="2.2"/>',
    file: '<path d="M6 4h9l4 4v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path d="M14 4v5h5M8 13h8M8 17h5"/>',
    user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M4.5 20c.8-3.6 3.8-5.6 7.5-5.6s6.7 2 7.5 5.6"/>',
    bolt: '<path d="M13 3L5 13h6l-1 8 8-10h-6z"/>',
    settings: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z"/>',
    bell: '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    send: '<path d="M21 4L10 14"/><path d="M21 4l-7 17-4-7-7-4z"/>',
    check: '<circle cx="12" cy="12" r="8.5"/><path d="M8.4 12.2l2.6 2.6 4.6-5"/>',
    alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4"/><circle cx="12" cy="17" r=".9" fill="currentColor" stroke="none"/>',
  };

  function icon(name, cls = "ico") {
    return `<svg class="${cls}" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ICONS.bolt}</svg>`;
  }

  function safeEsc(value) {
    return typeof esc === "function" ? esc(value == null ? "" : value) : String(value == null ? "" : value);
  }

  /* 账号头像：平台巡检拿到头像地址就显示图片，否则回退到昵称首字。 */
  function accountAvatarHtml(account, cls, size, radius) {
    let url = String((account && account.avatar) || "").trim();
    if (url.startsWith("//")) url = `https:${url}`;
    if (/^https?:\/\//i.test(url)) {
      return `<img class="${cls}" src="${safeEsc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" style="width:${size}px;height:${size}px;border-radius:${radius}px;object-fit:cover;display:block" />`;
    }
    const text = String((account && (account.nickname || account.name)) || "应").slice(0, 1);
    return `<span class="${cls}">${safeEsc(text)}</span>`;
  }

  function fmtClock(ts) {
    if (!ts) return "--:--";
    const date = new Date(Number(ts) * 1000);
    const two = (value) => String(value).padStart(2, "0");
    return `${two(date.getHours())}:${two(date.getMinutes())}`;
  }

  /* 应用版本由 /api/settings 下发（打包内 package.json 为准），前端不要再写死。 */
  function appVersionText() {
    const ver = String((window.__APP_VERSION || "")).trim();
    return ver ? `v${ver}` : "";
  }

  function versionToast(prefix) {
    const ver = appVersionText();
    return ver ? `${prefix} ${ver}` : prefix;
  }

  /* ------------------------------------------------------------------ 接口 */

  async function uGet(path) {
    const response = await fetch(path, { headers: { Accept: "application/json" } });
    let payload = null;
    try {
      payload = await response.json();
    } catch (error) {
      throw new Error(`服务返回异常（HTTP ${response.status}）`);
    }
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || `请求失败（HTTP ${response.status}）`);
    }
    return payload;
  }

  /* ------------------------------------------------------------------ 侧栏折叠 */

  const COLLAPSE_KEY = "echoq-side-collapsed";
  let railPinned = null;

  function initCollapse() {
    const app = $("#app");
    const button = $("#btn-side-collapse");
    try {
      const stored = localStorage.getItem(COLLAPSE_KEY);
      railPinned = stored === null ? null : stored === "1";
    } catch (error) {
      railPinned = null;
    }
    const apply = () => {
      const auto = window.innerWidth <= 1420;
      const rail = railPinned === null ? auto : railPinned;
      app.classList.toggle("rail", rail);
      if (button) {
        button.title = rail ? "展开侧栏" : "折叠侧栏";
        button.setAttribute("aria-label", button.title);
        button.setAttribute("aria-expanded", String(!rail));
      }
    };
    if (button) {
      button.addEventListener("click", () => {
        const rail = !app.classList.contains("rail");
        railPinned = rail;
        try {
          localStorage.setItem(COLLAPSE_KEY, rail ? "1" : "0");
        } catch (error) {
          /* 隐私模式写不了就算了 */
        }
        apply();
      });
    }
    window.addEventListener("resize", apply);
    apply();
  }

  /* 折叠态：鼠标悬停图标时在侧栏外侧显示名称，避免提示被侧栏裁掉 */
  function initRailTips() {
    const app = $("#app");
    const tip = document.createElement("div");
    tip.className = "rail-tip";
    document.body.appendChild(tip);

    const hide = () => tip.classList.remove("show");
    const show = (item) => {
      if (!app.classList.contains("rail")) return;
      const label = item.querySelector(".nav-text");
      const text = label && label.textContent ? label.textContent.trim() : "";
      if (!text) return;
      tip.textContent = text;
      tip.classList.add("show");
      const rect = item.getBoundingClientRect();
      tip.style.left = `${Math.round(rect.right + 10)}px`;
      tip.style.top = `${Math.round(rect.top + rect.height / 2)}px`;
    };

    document.addEventListener("mouseover", (event) => {
      const item = event.target.closest(".sidebar .nav-item");
      if (item) show(item);
      else hide();
    });
    document.addEventListener("mouseout", (event) => {
      const item = event.target.closest(".sidebar .nav-item");
      if (item && !item.contains(event.relatedTarget)) hide();
    });
    window.addEventListener("scroll", hide, true);
    document.addEventListener("click", hide, true);
  }

  /* ------------------------------------------------------------------ 路由包装 */

  function setActiveNav(view) {
    $$(".tab[data-view]").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.view === view);
    });
  }

  function syncCrumb(view) {
    const meta = VIEW_META[view] || ["工作台", "运营管理"];
    const group = $("#crumb-group");
    const page = $("#crumb-page");
    if (group) group.textContent = meta[0];
    if (page) page.textContent = meta[1];
  }

  function wrapSwitchView() {
    const base = typeof switchView === "function" ? switchView : null;
    if (!base) return;
    switchView = function (view) {
      base.call(this, view);
      setActiveNav(view);
      syncCrumb(view);
      if (view === "queue") {
        const toggle = $("#btn-toggle-queue");
        if (toggle && toggle.getAttribute("aria-expanded") !== "true") toggle.click();
      }
      if (view === "home") renderHome();
      if (view === "dashboard") renderDashboard(true);
      if (view === "schedule") renderWeekBoard();
      if (view === "templates" && typeof initTemplateEditor === "function") {
        initTemplateEditor().catch((error) => console.error("模板编辑器初始化失败:", error));
      }
      syncChrome();
    };
  }

  /* ------------------------------------------------------------------ 状态栏 */

  function dotClass(kind) {
    return kind === "ok" ? "ok" : kind === "warn" ? "warn" : kind === "bad" ? "bad" : "";
  }

  function engineState() {
    const cloud = state.cloud || {};
    if (state.studio && state.studio.engine === "llm") return ["模型生成", "ok"];
    if (state.studio && state.studio.engine === "offline") return ["离线模板", "warn"];
    if (!cloud || !Object.keys(cloud).length) return ["检测中", "warn"];
    if (!cloud.logged_in) return ["未登录", "warn"];
    const llm = state.settings && state.settings.llm;
    if (llm && llm.configured) return ["模型就绪", "ok"];
    if (llm && llm.offline_only) return ["离线模板", "warn"];
    return ["账号不可用", "bad"];
  }

  function syncChrome() {
    const overview = state.overview || {};
    const jobs = overview.jobs || {};
    const accounts = overview.accounts || {};
    const pending = (jobs.pending || 0) + (jobs.retry || 0) + (jobs.running || 0);

    const queueNode = $("#status-queue");
    if (queueNode) queueNode.textContent = String(pending);

    const navTopics = $("#nav-topics-count");
    if (navTopics) {
      const pool = Number((overview.topics || {}).pool || 0);
      navTopics.textContent = pool ? String(pool) : "";
      navTopics.classList.toggle("show", pool > 0);
    }
    const navQueue = $("#nav-queue-count");
    if (navQueue) {
      const stuck = Number((jobs.failed || 0) + (jobs.retry || 0));
      navQueue.textContent = stuck ? String(stuck) : "";
      navQueue.classList.toggle("show", stuck > 0);
      navQueue.classList.toggle("alert", stuck > 0);
    }
    const navAccounts = $("#nav-accounts-count");
    if (navAccounts) {
      const totalAccounts = Number(accounts.total || 0);
      navAccounts.textContent = totalAccounts ? String(totalAccounts) : "";
      navAccounts.classList.toggle("show", totalAccounts > 0);
    }

    const summary = $("#account-stats");
    if (summary) {
      const list = state.accounts || [];
      const healthy = list.filter((account) => account.enabled && account.status === "healthy").length;
      const expired = list.filter((account) => account.status === "expired").length;
      const today = Number(overview.today_published || 0);
      const quota = list.reduce(
        (sum, account) => sum + Number((typeof accountLimit === "function" ? accountLimit(account) : 0) || 0),
        0
      );
      const items = [
        { label: "账号总数", value: list.length || accounts.total || 0, icon: "user", kind: "brand" },
        { label: "登录正常", value: healthy, icon: "check", kind: "ok" },
        { label: "需重新登录", value: expired, icon: "alert", kind: "warn" },
        { label: "今日发布配额", value: `${today} / ${quota || "—"}`, icon: "send", kind: "" },
      ];
      summary.innerHTML = items
        .map(
          (item) => `<div class="card stat-card">
            <span class="stat-ico ${item.kind}">${icon(item.icon)}</span>
            <div><div class="n">${item.value}</div><div class="l">${item.label}</div></div>
          </div>`
        )
        .join("");
    }

    const schedSum = $("#schedule-summary");
    if (schedSum) {
      const sched = overview.schedules || {};
      schedSum.innerHTML = `
        <div class="strip-note">
          <span><b>${sched.total || 0}</b> 个计划</span>
          <span>启用中 <b>${sched.enabled || 0}</b></span>
          <span>已暂停 <b>${sched.paused || 0}</b></span>
          <span class="spacer"></span>
          <span style="display:inline-flex;align-items:center;gap:6px"><i class="st-dot${sched.running ? " on" : ""}"></i>${
        sched.running ? "调度器运行中" : "调度器待命"
      }</span>
        </div>
        <div class="toolbar" style="border-bottom:0">
          <div class="seg" id="schedule-filter">
            <button type="button" class="active" data-sched-filter="">全部</button>
            <button type="button" data-sched-filter="on">启用中</button>
            <button type="button" data-sched-filter="paused">已暂停</button>
          </div>
        </div>`;
    }

    const queueSum = $("#queue-summary");
    if (queueSum) {
      queueSum.innerHTML = `
        <span>排队中 <b>${jobs.pending || 0}</b></span>
        <span>重试中 <b>${jobs.retry || 0}</b></span>
        <span style="color:var(--bad)">失败待处理 <b style="color:var(--bad)">${jobs.failed || 0}</b></span>
        <span class="spacer"></span>
        <span>失败会自动重试，登录失效会暂停任务</span>`;
    }

    const accountNode = $("#status-accounts");
    if (accountNode) {
      accountNode.textContent = `${accounts.healthy || 0} / ${accounts.total || 0}`;
    }

    const lastNode = $("#status-last");
    if (lastNode) {
      const records = overview.records || [];
      lastNode.textContent = records.length && records[0].created_at
        ? (typeof relTime === "function" ? relTime(records[0].created_at) : "")
        : "—";
    }

    const [engineText, engineKind] = engineState();
    const engineNode = $("#status-engine");
    if (engineNode) engineNode.textContent = engineText;
    const engineDot = $("#status-engine-dot");
    if (engineDot) engineDot.className = `status-dot ${engineKind}`;

    const taskNode = $("#status-tasks");
    if (taskNode) {
      const pendingConfirm = (overview.needs_action || {}).pending_confirm || 0;
      taskNode.textContent = pendingConfirm
        ? `${pendingConfirm} 条待确认`
        : pending
        ? `${pending} 个任务执行中`
        : "就绪";
    }

    const today = Number(overview.today_published || 0);
    const todayNode = $("#side-today");
    if (todayNode) todayNode.textContent = `${today} 篇`;
    let limit = 0;
    if (Array.isArray(state.accounts) && typeof accountLimit === "function") {
      limit = state.accounts.reduce((sum, item) => {
        try {
          return sum + (Number(accountLimit(item)) || 0);
        } catch (error) {
          return sum;
        }
      }, 0);
    }
    const bar = $("#side-today-bar");
    if (bar) bar.style.width = `${limit ? Math.min(100, Math.round((today / limit) * 100)) : today ? 12 : 0}%`;

    const cloud = state.cloud || {};
    const user = cloud.user || {};
    const nameNode = $("#side-user-name");
    if (nameNode && cloud.logged_in) {
      nameNode.textContent = user.display_name || user.phone || user.email || "已登录";
    }
    const avatar = $("#side-avatar");
    if (avatar && cloud.logged_in) {
      const label = user.display_name || user.phone || "应";
      avatar.textContent = String(label).trim().slice(0, 1) || "应";
    }
  }

  /* ------------------------------------------------------------------ 运营管理 */

  let homeSignature = "";

  function homeSig() {
    const overview = state.overview || {};
    const accounts = (state.accounts || []).map((item) => [
      item.id,
      item.status,
      item.enabled,
      item.published_today,
    ]);
    const cloud = state.cloud || {};
    return JSON.stringify([
      overview.today_published,
      overview.jobs,
      overview.drafts,
      overview.accounts,
      overview.topics,
      overview.needs_action,
      overview.schedules,
      (overview.records || []).slice(0, 4).map((item) => [item.id, item.success]),
      accounts,
      cloud.logged_in,
      (cloud.subscription || {}).remaining_units,
    ]);
  }

  function metric(label, value, unit = "") {
    return `<div class="home-metric"><span>${safeEsc(label)}</span><b>${safeEsc(value)}${
      unit ? `<small>${safeEsc(unit)}</small>` : ""
    }</b></div>`;
  }

  function homeRow({ dot = "", title, sub = "", end = "", go = "", act = "" }) {
    const attrs = go ? ` data-home-go="${go}"` : act ? ` data-home-act="${act}"` : "";
    return `<button class="home-row" type="button"${attrs}>
      <span class="dot ${dot}"></span>
      <span class="row-main"><b>${safeEsc(title)}</b>${sub ? `<span>${safeEsc(sub)}</span>` : ""}</span>
      ${end ? `<span class="row-end">${safeEsc(end)}</span>` : ""}
    </button>`;
  }

  function renderHome() {
    const grid = $("#home-grid");
    if (!grid) return;
    const overview = state.overview || {};
    const jobs = overview.jobs || {};
    const drafts = overview.drafts || {};
    const accounts = overview.accounts || {};
    const topics = overview.topics || {};
    const needs = overview.needs_action || {};
    const schedules = overview.schedules || {};
    const records = overview.records || [];
    const pending = (jobs.pending || 0) + (jobs.retry || 0) + (jobs.running || 0);
    const attention = (needs.pending_confirm || 0) + (needs.abnormal_notes || 0) + (needs.expired_accounts || 0);

    const quick = [
      { act: "new-note", icon: "plus", label: "写新内容" },
      { act: "go-topics", icon: "list", label: "找选题" },
      { act: "new-schedule", icon: "calendar", label: "新建计划" },
      { act: "add-account", icon: "user", label: "添加账号" },
    ]
      .map(
        (item) =>
          `<button type="button" data-home-act="${item.act}">${icon(item.icon)}<span>${item.label}</span></button>`
      )
      .join("");

    const recent = records.length
      ? records.slice(0, 4)
          .map((record) =>
            homeRow({
              dot: record.success ? "ok" : "bad",
              title: record.draft_title || "未命名内容",
              sub: `${typeof platformName === "function" ? platformName(record.platform) : record.platform} · ${
                record.account_name || "未记录账号"
              }`,
              end: record.success ? "成功" : "失败",
              go: "records",
            })
          )
          .join("")
      : `<div class="home-empty">还没有发布记录，发布第一篇后会出现在这里。</div>`;

    const cloud = state.cloud || {};
    const sub = cloud.subscription || {};
    const remaining = typeof sub.remaining_units === "number" ? sub.remaining_units : null;
    const quota = typeof sub.quota_units === "number" ? sub.quota_units : null;
    const used = remaining != null && quota ? Math.max(0, quota - remaining) : 0;
    const quotaPct = quota ? Math.min(100, Math.round((remaining / quota) * 100)) : 0;

    const attentionRows = [
      needs.pending_confirm
        ? homeRow({ dot: "warn", title: `${needs.pending_confirm} 条发布结果待确认`, sub: "平台回执缺失，需要人工核对", end: "去确认", go: "queue" })
        : "",
      needs.abnormal_notes
        ? homeRow({ dot: "bad", title: `${needs.abnormal_notes} 篇作品需关注`, sub: "零浏览、疑似下架或数据异常", end: "去查看", go: "library" })
        : "",
      needs.expired_accounts
        ? homeRow({ dot: "bad", title: `${needs.expired_accounts} 个账号登录失效`, sub: "失效账号会暂停对应任务", end: "去处理", go: "accounts" })
        : "",
      needs.unread_notifications
        ? homeRow({ dot: "warn", title: `${needs.unread_notifications} 条未读通知`, sub: "发布失败、账号异常会先发通知", end: "去查看", act: "open-notify" })
        : "",
    ]
      .filter(Boolean)
      .join("");

    const layout = homeLayout();

    const todoRows = [
      needs.pending_confirm
        ? { kind: "warn", title: `${needs.pending_confirm} 条发布结果待确认`, sub: "平台回执缺失，需要人工核对", label: "去处理", go: "queue" }
        : "",
      needs.abnormal_notes
        ? { kind: "bad", title: `${needs.abnormal_notes} 篇作品需关注`, sub: "零浏览、疑似下架或数据异常", label: "去查看", go: "library" }
        : "",
      needs.expired_accounts
        ? { kind: "bad", title: `${needs.expired_accounts} 个账号登录失效`, sub: "失效账号会暂停对应任务", label: "重新登录", go: "accounts" }
        : "",
      needs.unread_notifications
        ? { kind: "brand", title: `${needs.unread_notifications} 条未读通知`, sub: "发布失败、账号异常会先发通知", label: "去查看", act: "open-notify" }
        : "",
    ].filter(Boolean);

    const todoHtml = todoRows.length
      ? todoRows
          .map(
            (row) => `<div class="todo-row">
              <span class="stat-ico ${row.kind}">${icon(row.kind === "brand" ? "bell" : "alert", "ico")}</span>
              <div class="txt"><b>${safeEsc(row.title)}</b><span>${safeEsc(row.sub)}</span></div>
              <button class="btn sm" type="button" ${
                row.go ? `data-home-go="${row.go}"` : `data-home-act="${row.act}"`
              }>${row.label}</button>
            </div>`
          )
          .join("")
      : `<div class="home-empty">没有需要处理的事情。</div>`;

    const accountRows = (state.accounts || []).slice(0, 4);
    const accountList = accountRows.length
      ? accountRows
          .map(
            (account) => `<div class="acct-item">
              ${accountAvatarHtml(account, "avatar", 34, 10)}
              <div class="info"><b>${safeEsc(account.nickname || account.name)}</b><span>${safeEsc(
                typeof platformName === "function" ? platformName(account.platform) : account.platform
              )} · 今日 ${account.published_today || 0} 篇</span></div>
              <span class="online${account.enabled && account.status === "healthy" ? "" : " off"}"></span>
            </div>`
          )
          .join("")
      : `<div class="home-empty">还没有账号，先去「账号管理」扫码接入。</div>`;

    const todayJobs = (state.jobs || [])
      .filter((job) => ["pending", "retry", "running"].includes(job.status))
      .slice(0, 3);
    const todayRows = todayJobs.length
      ? todayJobs
          .map((job) => {
            const time = job.next_run_at ? fmtClock(job.next_run_at) : "--:--";
            const kind = job.status === "running" ? "ok" : job.status === "retry" ? "warn" : "info";
            const label = job.status === "running" ? "发布中" : job.status === "retry" ? "重试中" : "已入队";
            return `<div class="tl-row">
              <div class="tl-time">${time}<span>已排定</span></div>
              <div class="tl-main"><b>${safeEsc(job.draft_title || "未命名内容")}</b><span>${safeEsc(
                typeof platformName === "function" ? platformName(job.platform) : job.platform
              )} · ${safeEsc(job.account_name || "自动选账号")}</span></div>
              <span class="pill ${kind}">${label}</span>
            </div>`;
          })
          .join("")
      : `<div class="home-empty">今天没有排定的发布任务。</div>`;

    const usagePct = (value, max) => (max ? Math.min(100, Math.round((value / max) * 100)) : 0);

    const cards = {
      overview: `
      <section class="card home-strip widget" data-mod="overview" data-span="12">
        <div class="hs-item"><span>今日已发布</span><b>${overview.today_published || 0}</b><i class="muted">篇</i></div>
        <div class="hs-item"><span>待发布</span><b>${drafts.queued || 0}</b><i class="muted">${pending ? `${pending} 个任务` : "暂无任务"}</i></div>
        <div class="hs-item"><span>待处理</span><b>${attention}</b><i class="${attention ? "warn" : "muted"}">${attention ? "建议尽快处理" : "已处理完"}</i></div>
        <div class="hs-item"><span>待用选题</span><b>${topics.pool || 0}</b><i class="muted">选题池</i></div>
      </section>`,
      todo: `
      <section class="card widget" data-mod="todo" data-span="8">
        <div class="card-head">
          <h3>待处理</h3><span class="sub">${attention} 项</span>
          <div class="right"><button class="link-btn" type="button" data-home-go="queue">查看全部</button></div>
        </div>
        ${todoHtml}
      </section>`,
      recent: `
      <section class="card widget" data-mod="recent" data-span="8">
        <div class="card-head">
          <h3>最近发布</h3><span class="sub">近期结果</span>
          <div class="right"><button class="link-btn" type="button" data-home-go="records">全部记录</button></div>
        </div>
        <div class="home-list">${recent}</div>
      </section>`,
      accounts: `
      <section class="card widget" data-mod="accounts" data-span="4">
        <div class="card-head">
          <h3>账号状态</h3><span class="sub">${accounts.healthy || 0} / ${accounts.total || 0} 正常</span>
          <div class="right"><button class="link-btn" type="button" data-home-go="accounts">管理</button></div>
        </div>
        ${accountList}
      </section>`,
      schedule: `
      <section class="card widget" data-mod="schedule" data-span="8">
        <div class="card-head">
          <h3>今日排期</h3><span class="sub">${todayJobs.length} 次执行</span>
          <div class="right"><button class="link-btn" type="button" data-home-go="schedule">发布计划</button></div>
        </div>
        ${todayRows}
      </section>`,
      quota: `
      <section class="card widget" data-mod="quota" data-span="4">
        <div class="card-head">
          <h3>订阅用量</h3>
          <div class="right">${
            cloud.logged_in ? '<span class="pill brand">专业版</span>' : ""
          }<button class="link-btn" type="button" data-home-act="account-panel">管理</button></div>
        </div>
        <div class="home-sub">
          <div class="plan-meta">${cloud.logged_in ? safeEsc(sub.state_name || "已登录") : "未登录云端"}</div>
          <div class="usage-row">
            <div class="usage-top"><span>剩余额度</span><b>${
              remaining == null ? "—" : remaining
            }${quota ? ` / ${quota}` : ""}</b></div>
            <div class="usage-bar"><i style="width:${quotaPct}%"></i></div>
          </div>
          <div class="usage-row">
            <div class="usage-top"><span>今日发布</span><b>${overview.today_published || 0} / 24</b></div>
            <div class="usage-bar"><i style="width:${usagePct(overview.today_published || 0, 24)}%"></i></div>
          </div>
          <div class="usage-row">
            <div class="usage-top"><span>待用选题</span><b>${topics.pool || 0} 条</b></div>
            <div class="usage-bar"><i style="width:${usagePct(topics.pool || 0, 100)}%"></i></div>
          </div>
          ${
            cloud.logged_in
              ? ""
              : '<button class="btn primary block" type="button" data-home-act="login">登录账号</button>'
          }
        </div>
      </section>`,
      quick: `
      <section class="card widget" data-mod="quick" data-span="4">
        <div class="card-head"><h3>快捷入口</h3></div>
        <div class="quick-grid">${quick}</div>
      </section>`,
    };

    const visible = layout.order.filter((key) => cards[key] && !layout.hidden.includes(key));
    grid.classList.toggle("editing", homeEditing);
    const editBar = homeEditing
      ? `<div class="home-edit-bar">
          <span>拖动卡片调整顺序，点右上角 × 隐藏模块。</span>
          <button class="btn ghost small" type="button" data-home-restore>恢复默认</button>
        </div>`
      : "";
    grid.innerHTML =
      editBar +
      (visible.length
        ? visible.map((key) => cards[key]).join("")
        : `<section class="home-card full"><div class="home-empty">首页模块已全部隐藏。<button class="link-btn" type="button" data-home-restore>恢复默认</button></div></section>`);

    if (homeEditing) {
      $$(".home-card[data-mod]", grid).forEach((card) => {
        card.draggable = true;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "mod-remove";
        remove.dataset.removeMod = card.dataset.mod;
        remove.title = "隐藏这个模块";
        remove.textContent = "×";
        card.appendChild(remove);
      });
    }

    const now = new Date();
    const hour = now.getHours();
    const greeting = hour < 6 ? "夜深了" : hour < 12 ? "上午好" : hour < 18 ? "下午好" : "晚上好";
    const eyebrow = $("#home-eyebrow");
    if (eyebrow) eyebrow.textContent = `运营管理 · ${now.getMonth() + 1} 月 ${now.getDate()} 日`;
    const greetingNode = $("#home-greeting");
    if (greetingNode) {
      const cloudUser = (state.cloud && state.cloud.user) || {};
      const name = String(cloudUser.display_name || cloudUser.phone || "徐豪").trim();
      greetingNode.innerHTML = `${greeting}，<span class="grad">${safeEsc(name)}</span>`;
    }
    const summaryNode = $("#home-summary");
    if (summaryNode) {
      summaryNode.textContent = `今天有 ${attention} 项待处理、${drafts.queued || 0} 篇待发布，${
        accounts.total || 0
      } 个账号中 ${needs.expired_accounts || 0} 个需要重新登录。`;
    }

    homeSignature = homeSig();
  }

  /* 首页模块布局：顺序与隐藏项写 localStorage，恢复默认即清空。 */
  const HOME_LAYOUT_KEY = "echoq-home-layout-v2";
  const HOME_MODULES = ["overview", "todo", "accounts", "schedule", "quota", "recent", "quick"];
  const HOME_DEFAULT_HIDDEN = ["recent", "quick"];
  let homeEditing = false;

  function homeLayout() {
    const fallback = { order: HOME_MODULES.slice(), hidden: HOME_DEFAULT_HIDDEN.slice() };
    try {
      const raw = JSON.parse(localStorage.getItem(HOME_LAYOUT_KEY) || "null");
      if (!raw || !Array.isArray(raw.order)) return fallback;
      const order = raw.order.filter((key) => HOME_MODULES.includes(key));
      HOME_MODULES.forEach((key) => {
        if (!order.includes(key)) order.push(key);
      });
      const hidden = Array.isArray(raw.hidden)
        ? raw.hidden.filter((key) => HOME_MODULES.includes(key))
        : [];
      return { order, hidden };
    } catch (error) {
      return fallback;
    }
  }

  function saveHomeLayout(layout) {
    try {
      localStorage.setItem(HOME_LAYOUT_KEY, JSON.stringify(layout));
    } catch (error) {
      /* 隐私模式写不了就算了 */
    }
  }

  function resetHomeLayout() {
    try {
      localStorage.removeItem(HOME_LAYOUT_KEY);
    } catch (error) {
      /* 同上 */
    }
    renderHome();
  }

  function statusText(status) {
    const map = { healthy: "正常", expired: "登录失效", unknown: "未判断", risk: "有风险" };
    return map[status] || status || "未知";
  }

  function bindHome() {
    const grid = $("#home-grid");
    if (grid) {
      grid.addEventListener("click", (event) => {
        const remove = event.target.closest("[data-remove-mod]");
        if (remove) {
          const layout = homeLayout();
          if (!layout.hidden.includes(remove.dataset.removeMod)) layout.hidden.push(remove.dataset.removeMod);
          saveHomeLayout(layout);
          renderHome();
          return;
        }
        if (event.target.closest("[data-home-restore]")) {
          resetHomeLayout();
          return;
        }
        const go = event.target.closest("[data-home-go]");
        if (go) {
          switchView(go.dataset.homeGo);
          return;
        }
        const act = event.target.closest("[data-home-act]");
        if (act) runHomeAction(act.dataset.homeAct);
      });

      // 编辑态：原生拖拽调整模块顺序，松手后持久化。
      let dragKey = "";
      grid.addEventListener("dragstart", (event) => {
        const card = event.target.closest(".home-card[data-mod]");
        if (!homeEditing || !card) return;
        dragKey = card.dataset.mod;
        card.classList.add("dragging");
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", dragKey);
      });
      grid.addEventListener("dragover", (event) => {
        if (!homeEditing || !dragKey) return;
        const target = event.target.closest(".home-card[data-mod]");
        if (!target || target.dataset.mod === dragKey) return;
        event.preventDefault();
        const dragged = grid.querySelector(`.home-card[data-mod="${dragKey}"]`);
        if (!dragged) return;
        const rect = target.getBoundingClientRect();
        const after = event.clientY > rect.top + rect.height / 2;
        grid.insertBefore(dragged, after ? target.nextSibling : target);
      });
      grid.addEventListener("dragend", (event) => {
        const card = event.target.closest(".home-card[data-mod]");
        if (card) card.classList.remove("dragging");
        if (!homeEditing || !dragKey) return;
        dragKey = "";
        const order = $$(".home-card[data-mod]", grid).map((node) => node.dataset.mod);
        const layout = homeLayout();
        layout.order = order;
        saveHomeLayout(layout);
        renderHome();
      });
    }
    const custom = $("#btn-home-custom");
    if (custom) {
      custom.addEventListener("click", () => toggleHomeEditing(!homeEditing));
    }
    const refresh = $("#btn-home-refresh");
    if (refresh) {
      refresh.addEventListener("click", () => {
        refreshOverview().then(() => {
          renderHome();
          toast("已刷新");
        }).catch((error) => toast(error.message, true));
      });
    }
    const create = $("#btn-home-new");
    if (create) create.addEventListener("click", () => clickButton("#btn-new-note"));
    const topicsShortcut = $("#btn-home-topics");
    if (topicsShortcut) topicsShortcut.addEventListener("click", () => switchView("topics"));
    const queueShortcut = $("#btn-home-queue");
    if (queueShortcut) queueShortcut.addEventListener("click", () => switchView("queue"));
    const topbarNew = $("#btn-topbar-new");
    if (topbarNew) {
      topbarNew.addEventListener("click", () => {
        switchView("studio");
        window.setTimeout(() => clickButton("#btn-new-note"), 80);
      });
    }
  }

  function toggleHomeEditing(next) {
    homeEditing = Boolean(next);
    const button = $("#btn-home-custom");
    if (button) button.textContent = homeEditing ? "完成" : "自定义";
    renderHome();
  }

  function runHomeAction(action) {
    if (action === "new-note") {
      switchView("studio");
      clickButton("#btn-new-note");
    } else if (action === "go-topics") {
      switchView("topics");
    } else if (action === "new-schedule") {
      switchView("schedule");
      window.setTimeout(() => clickButton("#btn-new-schedule"), 120);
    } else if (action === "add-account") {
      switchView("accounts");
      window.setTimeout(() => clickButton("#btn-add-account"), 120);
    } else if (action === "open-notify") {
      clickButton("#btn-notify");
    } else if (action === "account-panel") {
      clickButton("#btn-account");
    } else if (action === "login") {
      clickButton("#btn-account");
    }
  }

  function clickButton(selector) {
    const node = $(selector);
    if (node) {
      node.click();
      return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ 数据概览 */

  let dashboardCache = { at: 0, payload: null };

  async function loadRecords(force = false) {
    if (!force && dashboardCache.payload && Date.now() - dashboardCache.at < 20000) return dashboardCache.payload;
    const payload = await uGet("/api/records?limit=500");
    dashboardCache = { at: Date.now(), payload };
    return payload;
  }

  function dayKey(ts) {
    const date = new Date(ts * 1000);
    return `${date.getMonth() + 1}-${date.getDate()}`;
  }

  async function renderDashboard(force = false) {
    const grid = $("#dashboard-body");
    if (!grid) return;
    if (!grid.dataset.ready) {
      grid.innerHTML = `<div class="dash-loading"><div class="skeleton"></div><div class="skeleton"></div></div>`;
    }
    let payload;
    try {
      payload = await loadRecords(force);
    } catch (error) {
      grid.innerHTML = `<div class="dash-card full"><div class="dash-empty">读取发布记录失败：${safeEsc(
        error.message
      )}</div></div>`;
      return;
    }
    const records = Array.isArray(payload.data) ? payload.data : [];
    const total = Number(payload.total || records.length);
    const success = Number(payload.success_total != null ? payload.success_total : records.filter((item) => item.success).length);
    const failed = Number(payload.failed_total != null ? payload.failed_total : total - success);
    const rate = total ? ((success / total) * 100).toFixed(1) : "0.0";

    const days = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let index = 6; index >= 0; index -= 1) {
      const day = new Date(today.getTime() - index * 86400000);
      days.push({
        key: `${day.getMonth() + 1}-${day.getDate()}`,
        label: `${day.getDate()}日`,
        xhs: 0,
        dy: 0,
        wx: 0,
        other: 0,
        total: 0,
      });
    }
    const dayMap = new Map(days.map((item) => [item.key, item]));
    const platKey = (value) => {
      const key = String(value || "").toLowerCase();
      if (key === "xiaohongshu" || key === "xhs" || key === "redbook") return "xhs";
      if (key === "douyin" || key === "dy") return "dy";
      if (key === "weixin" || key === "wx" || key === "wechat" || key === "channels") return "wx";
      return "other";
    };
    records.forEach((record) => {
      const bucket = dayMap.get(dayKey(record.created_at));
      if (!bucket) return;
      bucket[platKey(record.platform)] += 1;
      bucket.total += 1;
    });
    const dayMax = Math.max(1, ...days.map((item) => item.total));
    const seg = (key, count) =>
      count > 0
        ? `<i class="b-${key}" style="height:${Math.max(1, Math.round((count / dayMax) * 100))}%"></i>`
        : "";
    const chart = days
      .map((day) => {
        const tip = `${day.label}：共 ${day.total} 条` +
          (day.xhs ? ` · 小红书 ${day.xhs}` : "") +
          (day.dy ? ` · 抖音 ${day.dy}` : "") +
          (day.wx ? ` · 视频号 ${day.wx}` : "") +
          (day.other ? ` · 其他 ${day.other}` : "");
        return `<div class="bar-col" title="${tip}">
          <div class="bar-stack">${seg("other", day.other)}${seg("wx", day.wx)}${seg("xhs", day.xhs)}${seg("dy", day.dy)}</div>
        </div>`;
      })
      .join("");
    const chartAxis = days.map((day) => `<span>${day.label}</span>`).join("");

    const platformCount = new Map();
    records.forEach((record) => {
      const key = record.platform || "unknown";
      platformCount.set(key, (platformCount.get(key) || 0) + 1);
    });
    const platformRows = Array.from(platformCount.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => {
        const percent = records.length ? Math.round((count / records.length) * 100) : 0;
        return `<div class="dash-bar-row"><span>${safeEsc(
          typeof platformName === "function" ? platformName(key) : key
        )}</span><span class="dash-bar-track"><i style="width:${percent}%"></i></span><b>${count}</b></div>`;
      })
      .join("");

    const ov = state.overview || {};
    const ovDrafts = ov.drafts || {};
    const ovAccounts = ov.accounts || {};
    const ovJobs = ov.jobs || {};
    const ovTopics = ov.topics || {};
    const ovNeeds = ov.needs || {};

    const accountList = (state.accounts || []).length
      ? state.accounts
          .slice(0, 4)
          .map(
            (account) => `<div class="acct-item">
              ${accountAvatarHtml(account, "avatar", 34, 10)}
              <div class="info"><b>${safeEsc(account.nickname || account.name)}</b><span>${safeEsc(
                typeof platformName === "function" ? platformName(account.platform) : account.platform
              )} · 今日 ${account.published_today || 0} / ${typeof accountLimit === "function" ? accountLimit(account) : "—"} 篇</span></div>
              <span class="online${account.enabled && account.status === "healthy" ? "" : " off"}"></span>
            </div>`
          )
          .join("")
      : `<div class="home-empty">还没有账号。</div>`;

    const todoItems = [
      ovNeeds.pending_confirm
        ? { kind: "warn", title: `${ovNeeds.pending_confirm} 条发布结果待确认`, sub: "平台回执缺失，需要人工核对", label: "处理", go: "queue" }
        : "",
      ovNeeds.expired_accounts
        ? { kind: "bad", title: `${ovNeeds.expired_accounts} 个账号登录失效`, sub: "失效账号会暂停对应任务", label: "处理", go: "accounts" }
        : "",
      ovNeeds.abnormal_notes
        ? { kind: "bad", title: `${ovNeeds.abnormal_notes} 篇作品需关注`, sub: "零浏览、疑似下架或数据异常", label: "查看", go: "library" }
        : "",
      ovNeeds.unread_notifications
        ? { kind: "brand", title: `${ovNeeds.unread_notifications} 条未读通知`, sub: "发布失败、账号异常会先发通知", label: "查看", go: "" }
        : "",
    ].filter(Boolean);
    const todoList = todoItems.length
      ? todoItems
          .map(
            (item) => `<div class="todo">
              <span class="todo-ico ${item.kind === "brand" ? "info" : item.kind}">${icon(
      item.kind === "brand" ? "bell" : "alert",
      "ico"
    )}</span>
              <div class="txt"><b>${safeEsc(item.title)}</b><span>${safeEsc(item.sub)}</span></div>
              <button class="link-btn" type="button" ${item.go ? `data-dash-go="${item.go}"` : ""}>${item.label}</button>
            </div>`
          )
          .join("")
      : `<div class="home-empty">没有需要处理的事情。</div>`;

    const latest = records.slice(0, 5);
    const latestRows = latest.length
      ? latest
          .map(
            (record) => `<tr>
              <td><div class="cell-main"><span class="thumb"></span><div>
                <div class="t">${safeEsc(record.draft_title || "—")}</div>
                <div class="s">${safeEsc(
                  typeof platformName === "function" ? platformName(record.platform) : record.platform
                )}</div>
              </div></div></td>
              <td>${safeEsc(typeof platformName === "function" ? platformName(record.platform) : record.platform)}</td>
              <td>${safeEsc(record.account_name || "—")}</td>
              <td class="muted tabular">${safeEsc(
                typeof fmtTime === "function" ? fmtTime(record.created_at) : ""
              )}</td>
              <td>${record.success ? '<span class="pill ok">已发布</span>' : '<span class="pill bad">失败</span>'}</td>
            </tr>`
          )
          .join("")
      : `<tr><td colspan="5"><div class="dash-empty">还没有发布记录。</div></td></tr>`;

    grid.dataset.ready = "1";
    grid.innerHTML = `
      <div class="kpi-grid">
        <div class="card kpi">
          <div class="kpi-top"><span class="kpi-label">今日已发布</span><span class="kpi-icon">${icon("send", "ico")}</span></div>
          <div class="kpi-value">${ov.today_published || 0}<small>篇</small></div>
          <div class="kpi-sub">今日本机执行</div>
        </div>
        <div class="card kpi">
          <div class="kpi-top"><span class="kpi-label">待发布队列</span><span class="kpi-icon">${icon("list", "ico")}</span></div>
          <div class="kpi-value">${ovDrafts.queued || 0}<small>篇</small></div>
          <div class="kpi-sub">${ovJobs.pending ? `${ovJobs.pending} 个任务等待执行` : "队列为空"}</div>
        </div>
        <div class="card kpi">
          <div class="kpi-top"><span class="kpi-label">账号可用</span><span class="kpi-icon">${icon("user", "ico")}</span></div>
          <div class="kpi-value">${ovAccounts.healthy || 0}<small>/ ${ovAccounts.total || 0}</small></div>
          <div class="kpi-sub">${
            ovAccounts.expired
              ? `<span class="pill warn" style="height:18px;font-size:10.5px">${ovAccounts.expired} 个需重新登录</span>`
              : "全部登录正常"
          }</div>
        </div>
        <div class="card kpi">
          <div class="kpi-top"><span class="kpi-label">待用选题</span><span class="kpi-icon">${icon("bulb", "ico")}</span></div>
          <div class="kpi-value">${ovTopics.pool || 0}<small>条</small></div>
          <div class="kpi-sub">选题池可用</div>
        </div>
      </div>

      <div class="dash-grid">
        <div class="card">
          <div class="card-head">
            <h3>近 7 天发布趋势</h3>
            <div class="right chart-legend"><span><i class="lg xhs"></i>小红书</span><span><i class="lg dy"></i>抖音</span><span><i class="lg wx"></i>视频号</span></div>
          </div>
          <div class="chart">
            <div class="chart-plot">${chart}</div>
            <div class="chart-axis">${chartAxis}</div>
          </div>
        </div>
        <div class="card">
          <div class="card-head">
            <h3>账号状态</h3>
            <div class="right"><button class="link-btn" type="button" data-dash-go="accounts">查看全部</button></div>
          </div>
          <div class="acct-list">${accountList}</div>
        </div>
      </div>

      <div class="dash-grid">
        <div class="card">
          <div class="card-head">
            <h3>最近发布</h3>
            <div class="right"><button class="link-btn" type="button" data-dash-go="records">发布记录</button></div>
          </div>
          <div class="table-wrap">
            <table class="data">
              <thead><tr><th>内容</th><th>平台</th><th>账号</th><th>时间</th><th>状态</th></tr></thead>
              <tbody>${latestRows}</tbody>
            </table>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h3>待处理</h3><div class="right"><span class="pill ${todoItems.length ? "bad" : "ok"}">${todoItems.length} 项</span></div></div>
          <div class="todo-list">${todoList}</div>
        </div>
      </div>
    `;
  }

  function bindDashboard() {
    const body = $("#dashboard-body");
    if (body) {
      body.addEventListener("click", (event) => {
        const go = event.target.closest("[data-dash-go]");
        if (go) switchView(go.dataset.dashGo);
      });
    }
    const refresh = $("#btn-dashboard-refresh");
    if (refresh) {
      refresh.addEventListener("click", () => {
        dashboardCache = { at: 0, payload: null };
        renderDashboard().then(() => toast("已刷新")).catch((error) => toast(error.message, true));
      });
    }
  }

  /* ------------------------------------------------------------------ 命令面板 */

  const palette = { node: null, items: [], index: 0, filtered: [] };

  function buildPaletteItems() {
    const items = [];
    NAV_META.forEach((group) => {
      group.items.forEach((item) => {
        items.push({
          group: "前往",
          icon: item.icon,
          label: item.name,
          desc: item.desc,
          keywords: `${item.name} ${item.desc} ${group.group}`,
          run: () => switchView(item.view),
        });
      });
    });
    const account = (state.cloud && state.cloud.user) || {};
    items.push(
      {
        group: "账户",
        icon: "user",
        label: "账号与额度",
        desc: state.cloud && state.cloud.logged_in ? account.display_name || "查看个人中心" : "登录账号",
        keywords: "账号 额度 个人中心 登录 订阅",
        run: () => clickButton("#btn-account"),
      },
      {
        group: "账户",
        icon: "settings",
        label: "设置",
        desc: "发布节奏、配图模板与通知",
        keywords: "设置 偏好 参数 模板 通知 备份 代理",
        run: () => clickButton("#btn-settings"),
      },
      {
        group: "操作",
        icon: "plus",
        label: "写新笔记",
        desc: "打开创作台",
        keywords: "新建 写 笔记 创作 草稿",
        run: () => {
          switchView("studio");
          clickButton("#btn-new-note");
        },
      },
      {
        group: "操作",
        icon: "calendar",
        label: "新建发布计划",
        desc: "定时找选题 / 写稿 / 发布",
        keywords: "计划 定时 排期 自动",
        run: () => {
          switchView("schedule");
          window.setTimeout(() => clickButton("#btn-new-schedule"), 120);
        },
      },
      {
        group: "操作",
        icon: "user",
        label: "添加账号",
        desc: "扫码或粘贴登录信息",
        keywords: "账号 添加 扫码 登录 cookie",
        run: () => {
          switchView("accounts");
          window.setTimeout(() => clickButton("#btn-add-account"), 120);
        },
      },
      {
        group: "操作",
        icon: "queue",
        label: "跑一遍发布队列",
        desc: "立即执行一次待发布任务",
        keywords: "队列 发布 执行 tick",
        run: () => {
          switchView("queue");
          window.setTimeout(() => clickButton("#btn-tick"), 150);
        },
      },
      {
        group: "操作",
        icon: "bell",
        label: "通知渠道",
        desc: "配置站外推送",
        keywords: "通知 渠道 webhook 推送",
        run: () => {
          if (typeof openNotifyChannels === "function") openNotifyChannels();
        },
      },
      {
        group: "操作",
        icon: "file",
        label: "备份与恢复",
        desc: "导出或恢复本机数据",
        keywords: "备份 恢复 数据",
        run: () => {
          if (typeof openBackups === "function") openBackups();
        },
      }
    );
    return items;
  }

  function ensurePalette() {
    if (palette.node) return palette.node;
    const mask = document.createElement("div");
    mask.className = "cmd-mask";
    mask.id = "cmd-mask";
    mask.hidden = true;
    mask.innerHTML = `
      <div class="cmd-panel" role="dialog" aria-label="命令面板">
        <div class="cmd-input-row">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><circle cx="11" cy="11" r="6.2"></circle><path d="M15.6 15.6L20 20"></path></svg>
          <input id="cmd-input" type="text" placeholder="搜索页面、账号与操作" autocomplete="off" spellcheck="false" />
        </div>
        <div class="cmd-list" id="cmd-list"></div>
        <div class="cmd-foot"><span>↑↓ 选择</span><span>↵ 执行</span><span>Esc 关闭</span></div>
      </div>`;
    document.body.appendChild(mask);
    mask.addEventListener("click", (event) => {
      if (event.target === mask) closePalette();
    });
    const input = mask.querySelector("#cmd-input");
    input.addEventListener("input", () => renderPalette(input.value));
    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        movePalette(1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        movePalette(-1);
      } else if (event.key === "Enter") {
        event.preventDefault();
        runPalette();
      }
    });
    palette.node = mask;
    return mask;
  }

  function openPalette() {
    const mask = ensurePalette();
    palette.items = buildPaletteItems();
    mask.hidden = false;
    const input = mask.querySelector("#cmd-input");
    input.value = "";
    renderPalette("");
    window.setTimeout(() => input.focus(), 20);
  }

  function closePalette() {
    if (!palette.node) return;
    palette.node.hidden = true;
    const input = palette.node.querySelector("#cmd-input");
    if (input) input.value = "";
  }

  function renderPalette(keyword) {
    const list = palette.node.querySelector("#cmd-list");
    const query = String(keyword || "").trim().toLowerCase();
    palette.filtered = palette.items.filter((item) => !query || item.keywords.toLowerCase().includes(query));
    palette.index = 0;
    if (!palette.filtered.length) {
      list.innerHTML = `<div class="cmd-empty">没有匹配的页面或操作</div>`;
      return;
    }
    let lastGroup = "";
    list.innerHTML = palette.filtered
      .map((item, index) => {
        const head = item.group !== lastGroup ? `<div class="cmd-group-label">${item.group}</div>` : "";
        lastGroup = item.group;
        return `${head}<button class="cmd-item${index === 0 ? " active" : ""}" type="button" data-cmd-index="${index}">
          ${icon(item.icon)}
          <span>${safeEsc(item.label)}</span>
          <span class="cmd-desc">${safeEsc(item.desc || "")}</span>
        </button>`;
      })
      .join("");
    list.querySelectorAll(".cmd-item").forEach((node) => {
      node.addEventListener("click", () => {
        palette.index = Number(node.dataset.cmdIndex);
        runPalette();
      });
    });
  }

  function movePalette(step) {
    if (!palette.filtered.length) return;
    palette.index = (palette.index + step + palette.filtered.length) % palette.filtered.length;
    const items = palette.node.querySelectorAll(".cmd-item");
    items.forEach((node, index) => {
      const active = index === palette.index;
      node.classList.toggle("active", active);
      if (active) node.scrollIntoView({ block: "nearest" });
    });
  }

  function runPalette() {
    const item = palette.filtered[palette.index];
    if (!item) return;
    closePalette();
    try {
      item.run();
    } catch (error) {
      toast(error.message, true);
    }
  }

  function bindPalette() {
    const trigger = $("#btn-command");
    if (trigger) trigger.addEventListener("click", openPalette);
    // 捕获阶段先处理 Esc，避免同时触发设置/确认弹层的关闭。
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape" && palette.node && !palette.node.hidden) {
          event.stopImmediatePropagation();
          event.preventDefault();
          closePalette();
        }
      },
      true
    );
    document.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (palette.node && !palette.node.hidden) closePalette();
        else openPalette();
      }
    });
  }

  /* ------------------------------------------------------------------ 设置浮窗 */

  const SETTING_GROUPS = [
    { id: "general", label: "通用", match: ["publish_daily_limit", "publish_min_interval_sec", "publish_jitter_sec"] },
    { id: "safety", label: "发布安全", match: ["job_max_attempts", "worker_poll_sec", "health_check_hours"] },
    {
      id: "content",
      label: "内容与配图",
      match: [
        "focus_keywords",
        "product_name",
        "product_pitch",
        "draft_style",
        "card_style",
        "card_layout",
        "card_palette",
      ],
    },
  ];

  function decorateModal() {
    const mask = $("#modal-mask");
    if (!mask || mask.classList.contains("hidden")) return;
    const modal = mask.querySelector(".modal");
    const titleNode = $("#modal-title");
    if (!modal || !titleNode) return;
    const title = (titleNode.textContent || "").trim();
    if (title === "设置") {
      decorateSettings(modal);
      if (modal.dataset.window !== "settings") modal.dataset.window = "settings";
    } else if (title === "账号与额度") {
      if (modal.dataset.window !== "profile") modal.dataset.window = "profile";
    } else if (modal.dataset.window) {
      delete modal.dataset.window;
    }
  }

  function decorateSettings(modal) {
    const body = $("#modal-body");
    const form = $("#settings-form");
    if (!body || !form || !form.querySelector(".field")) return;

    if (!body.classList.contains("win-split")) body.classList.add("win-split");
    let pane = body.querySelector(".win-pane");
    if (!pane) {
      pane = document.createElement("div");
      pane.className = "win-pane";
      const settingsBody = $("#settings-body");
      if (settingsBody) {
        body.appendChild(pane);
        pane.appendChild(settingsBody);
      }
    }

    const fields = Array.from(form.querySelectorAll(".field"));
    if (!form.querySelector(".settings-section") && fields.length) {
      const used = new Set();
      const bucket = (names) => {
        const list = [];
        fields.forEach((field) => {
          const input = field.querySelector("[name]");
          if (input && names.includes(input.name)) {
            list.push(field);
            used.add(field);
          }
        });
        return list;
      };
      const groups = SETTING_GROUPS.map((group) => ({ ...group, fields: bucket(group.match) }));
      const rest = fields.filter((field) => !used.has(field));
      if (rest.length) groups.push({ id: "more", label: "其他", fields: rest });

      form.classList.remove("settings-grid");
      form.classList.add("settings-sections");
      form.innerHTML = "";
      groups.forEach((group) => {
        if (!group.fields.length) return;
        const section = document.createElement("section");
        section.className = "settings-section";
        section.id = `set-${group.id}`;
        const title = document.createElement("h4");
        title.textContent = group.label;
        const grid = document.createElement("div");
        grid.className = "settings-section-grid";
        group.fields.forEach((field) => grid.appendChild(field));
        section.appendChild(title);
        section.appendChild(grid);
        form.appendChild(section);
      });
    }

    const sections = $$(".settings-section", form);
    const signature = sections.map((section) => section.id).join("|");
    let nav = body.querySelector(".win-nav");
    if (!nav) {
      nav = document.createElement("nav");
      nav.className = "win-nav";
      body.insertBefore(nav, pane);
    }
    if (nav.dataset.sig === signature) return;
    nav.dataset.sig = signature;
    nav.innerHTML =
      sections
        .map(
          (section, index) =>
            `<button type="button" data-set-go="${section.id}" class="${index === 0 ? "active" : ""}">${
              section.querySelector("h4").textContent
            }</button>`
        )
        .join("") + `<button type="button" data-set-go="settings-note">说明</button>`;
    nav.onclick = (event) => {
      const target = event.target.closest("[data-set-go]");
      if (!target) return;
      nav.querySelectorAll("button").forEach((node) => node.classList.toggle("active", node === target));
      const section = document.getElementById(target.dataset.setGo);
      if (section) section.scrollIntoView({ block: "start", behavior: "smooth" });
    };
  }

  function observeModal() {
    const mask = $("#modal-mask");
    if (!mask) return;
    let scheduled = false;
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(() => {
        scheduled = false;
        decorateModal();
      });
    };
    new MutationObserver(schedule).observe(mask, {
      attributes: true,
      attributeFilter: ["class"],
      childList: true,
      subtree: true,
    });
    const title = $("#modal-title");
    if (title) {
      new MutationObserver(schedule).observe(title, { childList: true, characterData: true, subtree: true });
    }
  }

  /* ------------------------------------------------------------------ 发布计划 · 本周排期 */

  const PLATFORM_DOTS = { xhs: "#ff2442", dy: "#161823", gzh: "#07c160", ks: "#ff7a00", bili: "#00a1d6", wb: "#e6162d" };
  let weekCache = { at: 0, jobs: [] };

  function weekStart(date) {
    const day = new Date(date);
    day.setHours(0, 0, 0, 0);
    const offset = (day.getDay() + 6) % 7;
    day.setDate(day.getDate() - offset);
    return day;
  }

  async function loadJobs() {
    if (Date.now() - weekCache.at < 20000) return weekCache.jobs;
    const payload = await uGet("/api/jobs?limit=100");
    weekCache = { at: Date.now(), jobs: Array.isArray(payload.data) ? payload.data : [] };
    return weekCache.jobs;
  }

  function jobTime(job) {
    return Number(job.next_run_at || job.created_at || 0);
  }

  async function renderWeekBoard() {
    const board = $("#week-board");
    if (!board) return;
    let jobs = [];
    try {
      jobs = await loadJobs();
    } catch (error) {
      board.hidden = true;
      return;
    }
    const start = weekStart(new Date());
    const end = new Date(start.getTime() + 7 * 86400000);
    const dayNames = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
    const days = dayNames.map((name, index) => {
      const date = new Date(start.getTime() + index * 86400000);
      return { name, date, key: `${date.getMonth()}-${date.getDate()}`, events: [] };
    });
    const map = new Map(days.map((day) => [day.key, day]));
    jobs.forEach((job) => {
      if (job.status === "success" || job.status === "cancelled") return;
      const stamp = jobTime(job);
      if (!stamp) return;
      const date = new Date(stamp * 1000);
      if (date < start || date >= end) return;
      const bucket = map.get(`${date.getMonth()}-${date.getDate()}`);
      if (bucket) bucket.events.push(job);
    });
    days.forEach((day) => day.events.sort((a, b) => jobTime(a) - jobTime(b)));
    const total = days.reduce((sum, day) => sum + day.events.length, 0);
    const now = new Date();
    const sameDay = (a, b) =>
      a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

    const platMeta = {
      xiaohongshu: ["xhs", "红"],
      douyin: ["dy", "抖"],
      wechat_mp: ["wx", "公"],
    };
    const columns = days
      .map((day) => {
        const events = day.events
          .slice(0, 4)
          .map((job) => {
            const date = new Date(jobTime(job) * 1000);
            const hh = String(date.getHours()).padStart(2, "0");
            const mm = String(date.getMinutes()).padStart(2, "0");
            const [cls, label] = platMeta[job.platform] || ["", ""];
            const platform = typeof platformName === "function" ? platformName(job.platform) : job.platform;
            const movable = ["pending", "retry"].includes(job.status);
            return `<button class="cal-ev" type="button" draggable="${movable}" data-job-id="${
              job.id
            }" data-week-go="queue" title="${safeEsc(job.draft_title || "")}${
              job.account_name ? ` · ${safeEsc(job.account_name)}` : ""
            }${movable ? "（可拖动改期）" : ""}">
              <span class="plat ${cls}">${label || safeEsc(String(platform || "?").slice(0, 1))}</span>
              <span class="ce-t">${safeEsc(job.draft_title || "未命名内容")}</span>
              <span class="ce-m">${hh}:${mm}</span>
            </button>`;
          })
          .join("");
        const more = day.events.length > 4 ? `<span class="week-more">还有 ${day.events.length - 4} 个</span>` : "";
        return `<div class="cal-col${sameDay(day.date, now) ? " today" : ""}" data-day="${Math.floor(
          day.date.getTime() / 1000
        )}">
          <div class="cal-day"><b>${day.name}</b>${sameDay(day.date, now) ? "<span>今天</span>" : ""}</div>
          <div class="cal-drop">${events || '<span class="week-empty">—</span>'}${more}</div>
        </div>`;
      })
      .join("");

    board.hidden = false;
    board.innerHTML = `
      <div class="cal-head">
        <h3>循环排期</h3>
        <span class="muted">每周一至周日循环执行 · 拖动卡片可改到对应星期</span>
        <span class="spacer"></span>
        <span class="muted tabular">${total} 个待执行</span>
      </div>
      <div class="cal">${columns}</div>`;
  }

  function bindWeekBoard() {
    const board = $("#week-board");
    if (!board) return;
    let dragId = 0;
    board.addEventListener("click", (event) => {
      const go = event.target.closest("[data-week-go]");
      if (go) switchView(go.dataset.weekGo);
    });
    board.addEventListener("dragstart", (event) => {
      const card = event.target.closest(".cal-ev");
      if (!card || card.getAttribute("draggable") !== "true") return;
      dragId = Number(card.dataset.jobId || 0);
      if (!dragId) return;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(dragId));
      card.classList.add("dragging");
    });
    board.addEventListener("dragend", (event) => {
      const card = event.target.closest(".cal-ev");
      if (card) card.classList.remove("dragging");
      dragId = 0;
      $$(".cal-col", board).forEach((col) => col.classList.remove("drop-target"));
    });
    board.addEventListener("dragover", (event) => {
      if (!dragId) return;
      const col = event.target.closest(".cal-col");
      if (!col) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      $$(".cal-col", board).forEach((node) => node.classList.toggle("drop-target", node === col));
    });
    board.addEventListener("drop", async (event) => {
      const col = event.target.closest(".cal-col");
      if (!col || !dragId) return;
      event.preventDefault();
      const job = weekCache.jobs.find((item) => Number(item.id) === dragId);
      const dayStamp = Number(col.dataset.day || 0);
      dragId = 0;
      $$(".cal-col", board).forEach((node) => node.classList.remove("drop-target"));
      if (!job || !dayStamp) return;
      const original = new Date(jobTime(job) * 1000);
      const target = new Date(dayStamp * 1000);
      target.setHours(original.getHours(), original.getMinutes(), 0, 0);
      // 循环排期按星期生效：拖到已经过去的星期就顺延到下周同一天。
      if (target.getTime() <= Date.now() + 60000) target.setDate(target.getDate() + 7);
      const at = Math.floor(target.getTime() / 1000);
      const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][target.getDay()];
      const label = `${weekday} ${String(target.getHours()).padStart(2, "0")}:${String(
        target.getMinutes()
      ).padStart(2, "0")}`;
      const conflict = weekCache.jobs.find(
        (other) =>
          Number(other.id) !== Number(job.id) &&
          other.platform === job.platform &&
          ["pending", "retry"].includes(other.status) &&
          Math.abs(jobTime(other) - at) < 1800
      );
      if (conflict) {
        const ok = await confirmDialog(
          `同平台在 ${label} 前后 30 分钟内还有一条任务，仍然改到 ${label} 吗？`,
          "仍然改期"
        );
        if (!ok) return;
      }
      try {
        await api(`/api/jobs/${job.id}/schedule`, { method: "POST", body: { at } });
        toast(`已改到 ${label}`);
        weekCache = { at: 0, jobs: [] };
        await renderWeekBoard();
        if (typeof refreshSchedules === "function") await refreshSchedules();
      } catch (error) {
        toast(error.message, true);
      }
    });
    const refresh = $("#btn-refresh-schedules");
    if (refresh) {
      refresh.addEventListener("click", () => {
        weekCache = { at: 0, jobs: [] };
        window.setTimeout(renderWeekBoard, 500);
      });
    }
  }

  /* ------------------------------------------------------------------ 账号卡片去重徽章 */

  function dedupeAccountBadges() {
    $$("#account-grid .account-tags").forEach((tags) => {
      const seen = new Set();
      $$(".badge", tags).forEach((node) => {
        const text = (node.textContent || "").trim();
        if (!text) return;
        if (seen.has(text)) node.style.display = "none";
        else seen.add(text);
      });
    });
  }

  function observeAccounts() {
    const grid = $("#account-grid");
    if (!grid) return;
    new MutationObserver(dedupeAccountBadges).observe(grid, { childList: true, subtree: true });
    dedupeAccountBadges();
  }

  /* ------------------------------------------------------------------ 通知去重（仅视觉层） */

  function dedupeNotifications() {
    const list = $("#notify-list");
    if (!list) return;
    $$(".notify-count", list).forEach((node) => node.remove());
    const seen = new Map();
    $$(".notify-item", list).forEach((item) => {
      const titleNode = item.querySelector(".notify-main b");
      const title = titleNode ? (titleNode.textContent || "").trim() : "";
      const bodyNode = item.querySelector(".notify-main small");
      const body = bodyNode ? (bodyNode.textContent || "").trim() : "";
      const key = `${title}|${body}`;
      if (!seen.has(key)) {
        seen.set(key, { item, titleNode, count: 1 });
        item.style.display = "";
        return;
      }
      const entry = seen.get(key);
      entry.count += 1;
      item.style.display = "none";
      let badge = entry.item.querySelector(".notify-count");
      if (!badge) {
        badge = document.createElement("em");
        badge.className = "notify-count";
        if (entry.titleNode) entry.titleNode.appendChild(badge);
      }
      badge.textContent = `×${entry.count}`;
    });
  }

  function observeNotifications() {
    const list = $("#notify-list");
    if (!list) return;
    new MutationObserver(dedupeNotifications).observe(list, { childList: true });
    dedupeNotifications();
  }

  /* ------------------------------------------------------------------ 内容库：网格 / 列表 / 密度 / 本地搜索 */

  function initLibraryView() {
    const grid = $("#draft-grid");
    const seg = $("#draft-view");
    const density = $("#draft-density");
    const search = $("#draft-search");
    if (!grid) return;
    let view = localStorage.getItem("echoq.library.view") || "grid";
    let compact = localStorage.getItem("echoq.library.density") === "compact";
    const apply = () => {
      grid.classList.toggle("list", view === "list");
      grid.classList.toggle("compact", compact);
      if (seg) {
        $$("[data-lib-view]", seg).forEach((btn) => {
          btn.classList.toggle("active", btn.dataset.libView === view);
        });
      }
      if (density) density.classList.toggle("active", compact);
    };
    const filter = () => {
      const keyword = ((search && search.value) || "").trim().toLowerCase();
      $$(".draft-tile", grid).forEach((tile) => {
        if (tile.classList.contains("loading")) return;
        tile.hidden = Boolean(keyword) && !(tile.textContent || "").toLowerCase().includes(keyword);
      });
    };
    if (seg) {
      seg.addEventListener("click", (event) => {
        const btn = event.target.closest("[data-lib-view]");
        if (!btn) return;
        view = btn.dataset.libView === "list" ? "list" : "grid";
        localStorage.setItem("echoq.library.view", view);
        apply();
      });
    }
    if (density) {
      density.addEventListener("click", () => {
        compact = !compact;
        localStorage.setItem("echoq.library.density", compact ? "compact" : "comfortable");
        apply();
      });
    }
    if (search) {
      let timer = 0;
      search.addEventListener("input", () => {
        window.clearTimeout(timer);
        timer = window.setTimeout(filter, 120);
      });
    }
    new MutationObserver(filter).observe(grid, { childList: true });
    apply();
  }

  /* ------------------------------------------------------------------ 创作台预览 */

  function initStudioPreview() {
    const tabs = $("#preview-tabs");
    if (!tabs) return;

    /* 预览 tab 只切换查看（state.previewPlatform），不影响编辑平台与发布范围。 */
    const sync = () => {
      $$("#preview-tabs [data-pv-platform]").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.pvPlatform === state.previewPlatform);
      });
      const names = { xiaohongshu: "小红书", douyin: "抖音", wechat_mp: "公众号" };
      const tag = $("#pv-platform");
      if (tag) tag.textContent = names[state.previewPlatform] || "小红书";
      const editorTag = $("#editor-platform-tag");
      if (editorTag) {
        const typeNode = $("#f-content-type button.active");
        const mainName = names[state.studio.platform] || "小红书";
        editorTag.textContent = `${mainName} · ${typeNode ? typeNode.textContent.trim() : "图文"}`;
      }
    };

    tabs.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-pv-platform]");
      if (!btn) return;
      state.previewPlatform = btn.dataset.pvPlatform || "xiaohongshu";
      if (typeof renderPreview === "function") renderPreview();
      /* 媒体区与灯箱同步只显示当前平台的图。 */
      if (typeof renderMedia === "function") renderMedia();
      sync();
    });
    sync();

    const all = $("#btn-preview-all");
    if (all) {
      all.addEventListener("click", () => {
        const existing = $(".threeup-layer");
        if (existing) {
          existing.remove();
          return;
        }
        const keys = [["小红书", "xiaohongshu"], ["抖音", "douyin"], ["公众号", "wechat_mp"]];
        let active = "xiaohongshu";
        const layer = document.createElement("div");
        layer.className = "threeup-layer";
        const gallery = document.createElement("div");
        gallery.className = "threeup-gallery";
        layer.appendChild(gallery);

        const cloneDevice = (key) => {
          const source = document.querySelector(`.preview-pane .preview-device[data-preview="${key}"]`);
          if (!source) return null;
          const clone = source.cloneNode(true);
          clone.removeAttribute("hidden");
          clone.hidden = false;
          clone.removeAttribute("id");
          clone.querySelectorAll("[id]").forEach((node) => node.removeAttribute("id"));
          clone.querySelectorAll("[hidden]").forEach((node) => node.removeAttribute("hidden"));
          return clone;
        };

        const render = () => {
          gallery.innerHTML = "";
          const main = document.createElement("div");
          main.className = "threeup-item threeup-main";
          const mainTitle = document.createElement("div");
          mainTitle.className = "threeup-title";
          const activeMeta = keys.find((item) => item[1] === active) || keys[0];
          mainTitle.textContent = activeMeta[0];
          main.appendChild(mainTitle);
          const mainDevice = cloneDevice(active);
          if (mainDevice) main.appendChild(mainDevice);

          const side = document.createElement("div");
          side.className = "threeup-side";
          keys.filter((item) => item[1] !== active).forEach(([name, key]) => {
            const mini = document.createElement("div");
            mini.className = "threeup-mini";
            mini.dataset.key = key;
            const title = document.createElement("div");
            title.className = "threeup-title";
            title.textContent = name;
            const frame = document.createElement("div");
            frame.className = "threeup-mini-frame";
            const device = cloneDevice(key);
            if (device) frame.appendChild(device);
            mini.appendChild(title);
            mini.appendChild(frame);
            side.appendChild(mini);
          });
          gallery.append(main, side);
        };

        layer.addEventListener("click", (event) => {
          if (event.target === layer || event.target === gallery) {
            layer.remove();
            return;
          }
          const mini = event.target.closest(".threeup-mini");
          if (mini) {
            active = mini.dataset.key;
            render();
          }
        });

        render();
        document.body.appendChild(layer);
      });
    }
    sync();
  }

  function initStudioTools() {
    const bar = $("#editor-toolbar");
    const desc = $("#f-desc");
    if (bar && desc && !bar.dataset.ready) {
      bar.dataset.ready = "1";
      const applyMarkdown = (kind) => {
        desc.focus();
        const start = desc.selectionStart || 0;
        const end = desc.selectionEnd || 0;
        const value = desc.value;
        const selected = value.slice(start, end) || (kind === "h2" || kind === "quote" || kind === "bullet" || kind === "ordered" ? "小标题" : "正文");
        const affix = {
          bold: ["**", "**"],
          italic: ["*", "*"],
          h2: ["## ", ""],
          quote: ["> ", ""],
          bullet: ["- ", ""],
          ordered: ["1. ", ""],
        }[kind];
        if (!affix) return;
        desc.value = value.slice(0, start) + affix[0] + selected + affix[1] + value.slice(end);
        desc.dispatchEvent(new Event("input", { bubbles: true }));
        desc.setSelectionRange(start + affix[0].length, start + affix[0].length + selected.length);
        const mdButton = $('#body-format [data-body-format="markdown"]');
        if (mdButton) mdButton.click();
      };
      bar.addEventListener("click", (event) => {
        const button = event.target.closest("[data-md]");
        if (button) applyMarkdown(button.dataset.md);
        if (event.target.closest("#btn-wx-theme-2")) clickButton("#btn-wx-theme");
      });
    }

    const card = $("#compliance-card");
    const tag = $("#editor-check-tag");
    if (card && tag) {
      const syncTag = () => {
        const className = card.className || "";
        if (className.includes("bad")) {
          tag.className = "pill bad";
          tag.textContent = "需修改";
        } else if (className.includes("ok")) {
          tag.className = "pill ok";
          tag.textContent = "合规通过";
        } else {
          tag.className = "pill idle";
          tag.textContent = "待检查";
        }
      };
      new MutationObserver(syncTag).observe(card, { attributes: true, attributeFilter: ["class"] });
      syncTag();
    }

    const meta = $("#studio-meta");
    const saveState = $("#studio-save-state");
    if (meta && saveState) {
      const syncSave = () => {
        const text = meta.textContent || "";
        saveState.textContent = /未保存|保存中|失败/.test(text) ? "有未保存修改" : "草稿已自动保存";
      };
      new MutationObserver(syncSave).observe(meta, { childList: true, characterData: true, subtree: true });
      syncSave();
    }
  }

  function initStudioResize() {
    const studio = $(".studio");
    if (!studio || studio.dataset.resizeReady) return;
    studio.dataset.resizeReady = "1";
    const STORE_KEY = "echoq-studio-cols-v4";
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    /* 存的是占创作台宽度的比例，窗口放大缩小时三栏跟着等比分配，
       不再像以前那样左栏固定 300px、窗口一大就显得很窄。 */
    const DEFAULT_LEFT = 0.255;
    const DEFAULT_RIGHT = 0.325;
    let config = { left: DEFAULT_LEFT, right: DEFAULT_RIGHT };
    try {
      const stored = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
      if (stored && (stored.leftRatio != null || stored.rightRatio != null)) {
        config.left = clamp(Number(stored.leftRatio) || DEFAULT_LEFT, 0.18, 0.4);
        config.right = clamp(Number(stored.rightRatio) || DEFAULT_RIGHT, 0.2, 0.46);
      } else if (stored && stored.left) {
        // 旧版存的是像素，按 1180 基准折算成比例
        config.left = clamp(Number(stored.left) / 1180 || DEFAULT_LEFT, 0.18, 0.4);
        config.right = clamp((Number(stored.right) || 380) / 1180, 0.2, 0.46);
      }
    } catch (error) {
      /* ignore */
    }
    const apply = () => {
      const width = studio.clientWidth;
      if (!width) return;
      const gaps = 24;
      const minCenter = width < 900 ? 280 : 340;
      let left = clamp(width * config.left, 250, 420);
      let right = clamp(width * config.right, 300, 500);
      if (left + right + minCenter + gaps > width) {
        right = Math.max(258, width - left - minCenter - gaps);
      }
      if (left + right + minCenter + gaps > width) {
        left = Math.max(228, width - right - minCenter - gaps);
      }
      studio.style.setProperty("--studio-left", `${Math.round(left)}px`);
      studio.style.setProperty("--studio-right", `${Math.round(right)}px`);
      studio.classList.toggle("compact", width < 940);
    };
    const persist = () => {
      try {
        localStorage.setItem(
          STORE_KEY,
          JSON.stringify({ leftRatio: config.left, rightRatio: config.right })
        );
      } catch (error) {
        /* ignore */
      }
    };
    apply();

    const makeHandle = (side) => {
      const handle = document.createElement("div");
      handle.className = `studio-resizer ${side}`;
      handle.dataset.side = side;
      handle.title = "拖动调整栏宽，双击恢复默认";
      handle.addEventListener("dblclick", () => {
        if (side === "left") config.left = DEFAULT_LEFT;
        else config.right = DEFAULT_RIGHT;
        apply();
        persist();
      });
      handle.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        handle.setPointerCapture(event.pointerId);
        const startX = event.clientX;
        const startWidth = studio.clientWidth || 1180;
        const base = side === "left" ? config.left * startWidth : config.right * startWidth;
        const onMove = (moveEvent) => {
          const delta = moveEvent.clientX - startX;
          const width = studio.clientWidth || startWidth;
          if (side === "left") {
            config.left = clamp((base + delta) / width, 0.18, 0.4);
          } else {
            config.right = clamp((base - delta) / width, 0.2, 0.46);
          }
          apply();
        };
        const onUp = () => {
          handle.removeEventListener("pointermove", onMove);
          handle.removeEventListener("pointerup", onUp);
          document.body.classList.remove("col-resizing");
          persist();
        };
        document.body.classList.add("col-resizing");
        handle.addEventListener("pointermove", onMove);
        handle.addEventListener("pointerup", onUp);
      });
      studio.appendChild(handle);
    };
    makeHandle("left");
    makeHandle("right");
    if (typeof ResizeObserver === "function") new ResizeObserver(apply).observe(studio);
  }

  /* 手机预览等比缩放：机身固定 390×844，按预览列可用空间整体 zoom，
     文字、图标、灵动岛一起缩小，避免窗口变窄时被压成长条。 */
  function initPhoneZoom() {
    const view = $("#view-studio");
    const pane = view && view.querySelector(".preview-pane");
    if (!view || !pane) return;
    const apply = () => {
      const stage = pane.querySelector(".preview-device:not([hidden])");
      if (!stage) return;
      const style = getComputedStyle(stage);
      const padX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
      const padY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
      const width = stage.clientWidth - padX;
      const height = stage.clientHeight - padY;
      if (width <= 40 || height <= 40) return;
      const scale = Math.max(0.35, Math.min(width / 390, height / 844, 1));
      view.style.setProperty("--phone-zoom", String(Math.round(scale * 1000) / 1000));
    };
    apply();
    if (typeof ResizeObserver === "function") {
      new ResizeObserver(apply).observe(pane);
    }
    window.addEventListener("resize", apply);
    // 切换平台标签会换一个可见的 preview-device，延后重算一次。
    $$(".preview-tabs button").forEach((button) =>
      button.addEventListener("click", () => window.setTimeout(apply, 30))
    );
  }

  function initStudioSteps() {
    const nav = $(".studio-steps");
    if (!nav || nav.dataset.stepsReady) return;
    nav.dataset.stepsReady = "1";
    const steps = $$(".studio-step", nav);
    const panels = $$(".step-panel");
    const scroll = $(".publish-scroll");

    // 完成态按内容判断，而不是点过就算做完
    const doneState = {
      copy: () => !!($("#f-title") && $("#f-title").value.trim() && $("#f-desc") && $("#f-desc").value.trim()),
      media: () => {
        const card = $(".media-card");
        const grid = $(".media-grid");
        return !!((card && card.classList.contains("has-media")) || (grid && grid.children.length));
      },
      publish: () => !!(document.querySelector("#f-platform .active") && $("#account-chips .active")),
    };

    function refreshDone() {
      steps.forEach((step) => {
        const name = step.dataset.studioStep;
        const active = step.classList.contains("active");
        const done = !active && !!(doneState[name] && doneState[name]());
        step.classList.toggle("done", done);
      });
    }

    const setStep = (name) => {
      const index = steps.findIndex((step) => step.dataset.studioStep === name);
      if (index < 0) return;
      steps.forEach((step, i) => {
        const active = i === index;
        step.classList.toggle("active", active);
        step.setAttribute("aria-selected", active ? "true" : "false");
      });
      panels.forEach((panel) => {
        panel.hidden = panel.dataset.stepPanel !== name;
      });
      if (scroll) scroll.scrollTop = 0;
      refreshDone();
    };

    nav.addEventListener("click", (event) => {
      const button = event.target.closest(".studio-step");
      if (button) setStep(button.dataset.studioStep);
    });
    document.addEventListener("input", (event) => {
      if (event.target.closest("#view-studio")) refreshDone();
    }, true);
    document.addEventListener("change", (event) => {
      if (event.target.closest("#view-studio")) refreshDone();
    }, true);
    if (scroll) {
      new MutationObserver(refreshDone).observe(scroll, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["class"],
      });
    }
    refreshDone();
  }

  /* 创作台初次使用引导：只在第一次进入创作台时出现 */
  function initStudioTour() {
    const KEY = "echoq.studio.tour.v1";
    const steps = [
      { icon: "i-users", kicker: "第 1 步 / 共 3 步", title: "先绑定你的发布账号", desc: "小红书、抖音、公众号逐个扫码授权，之后发布、定时与失败重试都由应声运营代劳。" },
      { icon: "i-pen", kicker: "第 2 步 / 共 3 步", title: "用 AI 起草第一版文案", desc: "写一句需求就能出标题、正文和话题；语气风格会影响起草结果，随时可换。" },
      { icon: "i-send", kicker: "第 3 步 / 共 3 步", title: "配图、检查、发布", desc: "生成配图并过一遍发布前检查，三个步骤走完就能一键发出。" },
    ];
    let index = 0;
    let layer = null;

    const close = () => {
      localStorage.setItem(KEY, "done");
      if (layer) {
        layer.remove();
        layer = null;
      }
    };

    const render = () => {
      if (!layer) return;
      const step = steps[index];
      layer.querySelector(".studio-tour-kicker").textContent = step.kicker;
      layer.querySelector(".studio-tour-body h2").textContent = step.title;
      layer.querySelector(".studio-tour-body p").textContent = step.desc;
      const use = layer.querySelector(".art-badge use");
      if (use) use.setAttribute("href", "#" + step.icon);
      layer.querySelectorAll(".studio-tour-dots i").forEach((dot, i) => dot.classList.toggle("on", i === index));
      layer.querySelector("[data-tour-next]").textContent = index === steps.length - 1 ? "开始创作" : "下一步";
    };

    const open = () => {
      if (layer || localStorage.getItem(KEY) === "done") return;
      layer = document.createElement("div");
      layer.className = "studio-tour";
      layer.innerHTML = `
        <div class="studio-tour-card" role="dialog" aria-modal="true" aria-label="创作台使用引导">
          <button class="studio-tour-close" type="button" aria-label="关闭">×</button>
          <div class="studio-tour-art"><span class="art-badge"><svg class="ico" width="26" height="26"><use href="#i-users"></use></svg></span></div>
          <div class="studio-tour-body">
            <div class="studio-tour-kicker"></div>
            <h2></h2>
            <p></p>
            <div class="studio-tour-dots"><i class="on"></i><i></i><i></i></div>
            <div class="studio-tour-foot">
              <button class="studio-tour-skip" type="button" data-tour-skip>稍后再说</button>
              <button class="btn primary" type="button" data-tour-next>下一步</button>
            </div>
          </div>
        </div>`;
      layer.addEventListener("click", (event) => {
        if (event.target === layer || event.target.closest(".studio-tour-close") || event.target.closest("[data-tour-skip]")) {
          close();
          return;
        }
        if (event.target.closest("[data-tour-next]")) {
          if (index === steps.length - 1) {
            close();
            return;
          }
          index += 1;
          render();
        }
      });
      document.body.appendChild(layer);
      render();
    };

    document.addEventListener("click", (event) => {
      if (event.target.closest('[data-view="studio"]')) window.setTimeout(open, 320);
    });
  }

  function initRecordFilters() {
    const search = $("#record-search");
    const table = $("#record-table tbody");
    if (!search || !table) return;
    const platform = $("#record-platform");
    const result = $("#record-result");
    const apply = () => {
      const query = search.value.trim().toLowerCase();
      const plat = platform ? platform.value : "";
      const res = result ? result.value : "";
      $$("#record-table tbody tr").forEach((row) => {
        if (row.querySelector("td[colspan]")) return;
        const text = row.textContent.toLowerCase();
        let show = true;
        if (query && !text.includes(query)) show = false;
        if (plat && row.dataset.platform !== plat) show = false;
        if (res && row.dataset.result !== res) show = false;
        row.style.display = show ? "" : "none";
      });
    };
    search.addEventListener("input", apply);
    if (platform) platform.addEventListener("change", apply);
    if (result) result.addEventListener("change", apply);
    new MutationObserver(apply).observe(table, { childList: true });
    const refresh = $("#btn-refresh-records-2");
    if (refresh) refresh.addEventListener("click", () => clickButton("#btn-refresh-records"));
    const summary = $("#record-summary");
    if (summary && !summary.dataset.ready) {
      summary.dataset.ready = "1";
      summary.addEventListener("click", (event) => {
        if (!event.target.closest("#record-failed-only") || !result) return;
        result.value = "failed";
        result.dispatchEvent(new Event("change"));
      });
    }
  }

  function initQueueFilters() {
    const view = $("#view-queue");
    if (!view || view.dataset.queueReady) return;
    view.dataset.queueReady = "1";
    view.addEventListener("click", (event) => {
      const chip = event.target.closest("[data-queue-filter]");
      if (!chip) return;
      $$("#queue-filter button").forEach((node) => node.classList.toggle("active", node === chip));
      const mode = chip.dataset.queueFilter;
      const wanted = {
        pending: ["pending", "running", "pending_confirm"],
        failed: ["failed", "cancelled"],
        retry: ["retry"],
      }[mode];
      $$("#job-list .q-row").forEach((row) => {
        row.style.display = !wanted || wanted.includes(row.dataset.jobStatus) ? "" : "none";
      });
      $$("#job-list .queue-group").forEach((group) => {
        const visible = $$(".q-row", group).some((row) => row.style.display !== "none");
        group.style.display = visible ? "" : "none";
      });
    });
  }

  function initScheduleFilters() {
    const summary = $("#schedule-summary");
    if (!summary || summary.dataset.ready) return;
    summary.dataset.ready = "1";
    summary.addEventListener("click", (event) => {
      const chip = event.target.closest("[data-sched-filter]");
      if (!chip) return;
      $$("#schedule-summary .seg button").forEach((node) => node.classList.toggle("active", node === chip));
      const mode = chip.dataset.schedFilter;
      $$("#schedule-list .schedule-plan").forEach((card) => {
        const enabled = card.dataset.enabled === "1";
        card.style.display = !mode || (mode === "on" ? enabled : !enabled) ? "" : "none";
      });
      $$("#schedule-list .schedule-group").forEach((group) => {
        const cards = $$(".schedule-plan", group);
        const visible = cards.some((card) => card.style.display !== "none");
        group.style.display = visible ? "" : "none";
      });
    });
  }

  /* ------------------------------------------------------------------ 外壳（标题栏 / 主题 / 视图跳转） */

  const THEME_KEY = "echoq-theme";
  const mediaDark = window.matchMedia("(prefers-color-scheme: dark)");

  function resolveTheme(pref) {
    return pref === "auto" ? (mediaDark.matches ? "dark" : "light") : pref;
  }

  function currentTheme() {
    return document.documentElement.dataset.theme || "light";
  }

  function applyThemePref(pref, persist = true) {
    const theme = resolveTheme(pref);
    document.documentElement.dataset.theme = theme;
    const icon = $("#theme-icon use");
    if (icon) icon.setAttribute("href", theme === "dark" ? "#i-sun" : "#i-moon");
    const label = $("#up-theme-label");
    if (label) label.textContent = theme === "dark" ? "深色" : "浅色";
    $$(".theme-card").forEach((card) => {
      card.classList.toggle("active", card.dataset.themeValue === pref);
    });
    const switchNode = $("#profile-theme-switch");
    if (switchNode) switchNode.classList.toggle("on", theme === "dark");
    if (persist) {
      try {
        localStorage.setItem(THEME_KEY, pref);
      } catch (error) {
        /* ignore */
      }
    }
  }

  function toggleTheme() {
    applyThemePref(currentTheme() === "dark" ? "light" : "dark");
  }

  function initShell() {
    let pref = "light";
    try {
      pref = localStorage.getItem(THEME_KEY) || (mediaDark.matches ? "auto" : "light");
    } catch (error) {
      /* ignore */
    }
    applyThemePref(pref, false);
    const dark = $("#btn-dark");
    if (dark) dark.addEventListener("click", toggleTheme);

    if (window.electronWin) {
      const bind = (selector, action) => {
        const node = $(selector);
        if (node) node.addEventListener("click", action);
      };
      bind("#app-min", () => window.electronWin.minimize());
      bind("#app-max", () => window.electronWin.toggleMaximize());
      bind("#app-close", () => window.electronWin.close());
      const drag = $(".tb-drag");
      if (drag) drag.addEventListener("dblclick", () => window.electronWin.toggleMaximize());
      if (typeof window.electronWin.onMaximized === "function") {
        window.electronWin.onMaximized((maximized) => {
          document.documentElement.classList.toggle("win-maximized", maximized);
        });
      }
    }

    document.addEventListener("click", (event) => {
      const viewBtn = event.target.closest("[data-view]");
      if (viewBtn && !viewBtn.classList.contains("tab")) {
        event.preventDefault();
        closeUserPop();
        const name = viewBtn.dataset.view;
        if (name === "settings" || name === "profile") {
          openWindow(name);
          return;
        }
        switchView(name);
      }
    });

    const menu = $("#tb-menu");
    if (menu) {
      menu.addEventListener("click", (event) => {
        const head = event.target.closest(".tb-m > button");
        if (head) {
          const group = head.parentElement;
          const open = group.classList.contains("open");
          $$("#tb-menu .tb-m.open").forEach((node) => node.classList.remove("open"));
          if (!open) group.classList.add("open");
          return;
        }
        const item = event.target.closest("[data-act]");
        if (!item) return;
        const act = item.dataset.act;
        if (act.startsWith("go-")) {
          switchView(act.slice(3));
        } else if (act === "new") {
          switchView("studio");
          clickButton("#btn-new-note");
        } else if (act === "palette") {
          openPalette();
        } else if (act === "theme") {
          const darkBtn = $("#btn-dark");
          if (darkBtn) darkBtn.click();
        } else if (act === "help" || act === "shortcuts" || act === "about" || act === "update") {
          toast(
            act === "about"
              ? versionToast("应声运营 EchoQ Ops ·")
              : "帮助中心正在准备中"
          );
        } else if (act === "find") {
          openPalette();
        } else if (act === "quit") {
          window.close();
        } else if (act === "export") {
          toast("导出功能请在各页面使用对应按钮");
        } else if (act === "undo" || act === "redo") {
          document.execCommand(act);
        }
        $$("#tb-menu .tb-m.open").forEach((node) => node.classList.remove("open"));
      });
    }
    document.addEventListener("click", (event) => {
      if (!event.target.closest("#tb-menu .tb-m")) {
        $$("#tb-menu .tb-m.open").forEach((node) => node.classList.remove("open"));
      }
    });
  }

  /* ------------------------------------------------------------------ 账户菜单 / 设置 / 个人中心 */

  let winView = null;
  let winPlaceholder = null;

  function cloudUser() {
    return (state.cloud && state.cloud.user) || {};
  }

  function cloudSub() {
    return (state.cloud && state.cloud.subscription) || {};
  }

  function syncUserPop() {
    const user = cloudUser();
    const sub = cloudSub();
    const cloud = state.cloud || {};
    const overview = state.overview || {};
    const accounts = Array.isArray(state.accounts) ? state.accounts : [];
    const name = user.display_name || user.nickname || user.phone || user.email || ($("#side-user-name") || {}).textContent || "本地用户";
    const email = user.email || (cloud.logged_in ? user.phone || "已登录" : "本地模式 · 未登录云端");
    const first = String(name).trim().slice(0, 1);
    const avatarText = first && !/\d/.test(first) ? first : "应";
    const planName = sub.plan_name || (cloud.logged_in ? "已登录" : "本地版");
    const used = Number(sub.used_units || 0);
    const quota = Number(sub.quota_units || 0);
    const today = Number(overview.today_published || 0);
    const left = sub.remaining_units != null ? Number(sub.remaining_units) : quota ? Math.max(0, quota - used) : 0;
    const days = sub.days_left != null ? Number(sub.days_left) : 0;

    const set = (sel, text) => {
      const node = $(sel);
      if (node) node.textContent = text;
    };
    set("#up-avatar", avatarText);
    set("#up-name", name);
    set("#up-email", email);
    set("#up-plan", planName);
    set("#up-quota-value", quota ? `${used} / ${quota}` : `${today} 篇`);
    set("#up-quota-foot", quota ? `剩余 ${left} 次${days ? ` · ${days} 天后重置` : ""}` : "本地模式 · 未连接云端");
    set("#up-accounts", `${accounts.length} 个账号`);
    const bar = $("#up-quota-bar");
    if (bar) bar.style.width = quota ? `${Math.min(100, Math.round((used / quota) * 100))}%` : `${today ? 12 : 0}%`;
    const unread = Number(state.notificationsUnread || 0);
    const badge = $("#up-notify-badge");
    if (badge) {
      badge.textContent = String(unread);
      badge.hidden = !unread;
    }
  }

  function openUserPop() {
    const pop = $("#user-pop");
    const btn = $("#btn-account");
    if (!pop || !btn) return;
    syncUserPop();
    pop.hidden = false;
    const rect = btn.getBoundingClientRect();
    const width = pop.offsetWidth;
    const height = pop.offsetHeight;
    let left = Math.min(Math.max(8, rect.left - 4), window.innerWidth - width - 8);
    let top = rect.top - height - 8;
    if (top < 8) top = Math.min(rect.bottom + 8, window.innerHeight - height - 8);
    pop.style.left = `${left}px`;
    pop.style.top = `${Math.max(8, top)}px`;
  }

  function closeUserPop() {
    const pop = $("#user-pop");
    if (pop) pop.hidden = true;
  }

  function initAccountUI() {
    const pop = $("#user-pop");
    const btn = $("#btn-account");
    if (!pop || !btn) return;

    document.addEventListener(
      "click",
      (event) => {
        if (!event.target.closest("#btn-account")) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (pop.hidden) openUserPop();
        else closeUserPop();
      },
      true
    );

    pop.addEventListener("click", (event) => {
      if (event.target.closest("#up-theme")) {
        toggleTheme();
        syncUserPop();
        return;
      }
      if (event.target.closest("#up-notify")) {
        closeUserPop();
        const bell = $("#btn-notify");
        if (bell) bell.click();
        return;
      }
      if (event.target.closest("#up-help")) {
        closeUserPop();
        toast("帮助中心正在准备中");
        return;
      }
      if (event.target.closest("#up-update")) {
        toast(versionToast("已是最新版本"));
        return;
      }
      if (event.target.closest("#up-quit")) {
        closeUserPop();
        confirmDialog("退出后将停止所有定时发布任务，重新登录即可恢复。", "退出登录").then((ok) => {
          if (ok && typeof logoutCloud === "function") logoutCloud();
        });
      }
    });

    document.addEventListener("pointerdown", (event) => {
      if (pop.hidden) return;
      if (event.target.closest("#user-pop") || event.target.closest("#btn-account")) return;
      closeUserPop();
    });
    window.addEventListener("resize", closeUserPop);
  }

  function openWindow(name) {
    const view = $(`#view-${name}`);
    const body = $("#win-body");
    const layer = $("#win-layer");
    if (!view || !body || !layer) return;
    if (winView) closeWindow();
    winPlaceholder = document.createComment("win-host");
    view.parentNode.insertBefore(winPlaceholder, view);
    body.appendChild(view);
    view.classList.add("active", "in-win");
    winView = view;
    const isProfile = name === "profile";
    const title = $("#win-title");
    const sub = $("#win-sub");
    if (title) title.textContent = isProfile ? "个人中心" : "设置";
    if (sub) sub.textContent = isProfile ? "账号、订阅与偏好" : "修改后立即生效";
    $("#win").classList.toggle("profile", isProfile);
    layer.hidden = false;
    closeUserPop();
    const bell = $("#notify-pop");
    if (bell) bell.hidden = true;
    const scroller = view.querySelector(".view-scroll");
    if (scroller) scroller.scrollTop = 0;
    if (isProfile) syncProfile();
    else syncSettings();
  }

  function closeWindow() {
    const layer = $("#win-layer");
    if (!winView) {
      if (layer) layer.hidden = true;
      return;
    }
    winView.classList.remove("active", "in-win");
    if (winPlaceholder && winPlaceholder.parentNode) {
      winPlaceholder.parentNode.insertBefore(winView, winPlaceholder);
      winPlaceholder.remove();
    }
    winView = null;
    winPlaceholder = null;
    if (layer) layer.hidden = true;
  }

  function initWindows() {
    const layer = $("#win-layer");
    const close = $("#win-close");
    if (close) close.addEventListener("click", closeWindow);
    if (layer) {
      layer.addEventListener("click", (event) => {
        if (event.target === layer) closeWindow();
      });
    }
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      if (winView) closeWindow();
      else closeUserPop();
    });
    document.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === ",") {
        event.preventDefault();
        closeUserPop();
        openWindow("settings");
      }
    });
  }

  function syncProfile() {
    const user = cloudUser();
    const sub = cloudSub();
    const cloud = state.cloud || {};
    const overview = state.overview || {};
    const accounts = Array.isArray(state.accounts) ? state.accounts : [];
    const name = user.display_name || user.nickname || user.phone || "本地用户";
    const emailText = user.email || user.phone || "本地模式 · 未登录云端";
    const joined = user.created_at ? String(user.created_at).slice(0, 10) : "本地模式";
    const set = (sel, text) => {
      const node = $(sel);
      if (node) node.textContent = text;
    };
    const first = String(name).trim().slice(0, 1);
    set("#profile-avatar", first && !/\d/.test(first) ? first : "应");
    set("#profile-name", name);
    set("#profile-email", emailText);
    set("#profile-joined", joined);
    set("#profile-plan-pill", sub.plan_name || (cloud.logged_in ? "已登录" : "本地模式"));
    set("#profile-plan-name", sub.plan_name || (cloud.logged_in ? "已登录" : "未订阅"));
    set("#profile-plan-meta", sub.plan_name
      ? `${sub.ends_at ? `${String(sub.ends_at).slice(0, 10)} 到期` : "长期有效"}${sub.days_left ? ` · 剩余 ${sub.days_left} 天` : ""}`
      : "登录云端后可查看订阅信息");

    const used = Number(sub.used_units || 0);
    const quota = Number(sub.quota_units || 0);
    const today = Number(overview.today_published || 0);
    const postValue = quota ? `${used} / ${quota}` : `${today} 篇`;
    set("#profile-usage-posts", postValue);
    const postBar = $("#profile-usage-posts-bar");
    if (postBar) postBar.style.width = quota ? `${Math.min(100, Math.round((used / quota) * 100))}%` : `${today ? 12 : 0}%`;
    set("#profile-usage-ai", quota ? `${used} / ${quota}` : "本地模式");
    const aiBar = $("#profile-usage-ai-bar");
    if (aiBar) aiBar.style.width = quota ? `${Math.min(100, Math.round((used / quota) * 100))}%` : "0%";
    set("#profile-usage-accounts", `${accounts.length} / 10`);
    const accBar = $("#profile-usage-accounts-bar");
    if (accBar) accBar.style.width = `${Math.min(100, accounts.length * 10)}%`;

    const nameInput = $("#profile-input-name");
    const phoneInput = $("#profile-input-phone");
    const emailInput = $("#profile-input-email");
    if (nameInput) nameInput.value = user.display_name || user.nickname || "";
    if (phoneInput) phoneInput.value = user.phone || "";
    if (emailInput) emailInput.value = user.email || "";
    const themeSwitch = $("#profile-theme-switch");
    if (themeSwitch) themeSwitch.classList.toggle("on", currentTheme() === "dark");
  }

  function initProfile() {
    const view = $("#view-profile");
    if (!view) return;
    const save = $("#profile-save");
    if (save) {
      save.addEventListener("click", () => {
        const user = cloudUser();
        const name = ($("#profile-input-name") || {}).value || "";
        if (name) {
          user.display_name = name;
          const sideName = $("#side-user-name");
          if (sideName) sideName.textContent = name;
          const avatar = $("#side-avatar");
          if (avatar) avatar.textContent = String(name).trim().slice(0, 1) || "应";
        }
        syncUserPop();
        syncProfile();
        toast("资料已保存");
      });
    }
    const themeSwitch = $("#profile-theme-switch");
    if (themeSwitch) {
      themeSwitch.addEventListener("click", () => {
        toggleTheme();
        syncProfile();
      });
    }
    const logout = $("#profile-logout");
    if (logout) {
      logout.addEventListener("click", () => {
        confirmDialog("退出后将停止所有定时发布任务，重新登录即可恢复。", "退出登录").then((ok) => {
          if (ok && typeof logoutCloud === "function") {
            logoutCloud();
            closeWindow();
          }
        });
      });
    }
    const simple = {
      "#profile-password": "修改密码功能请前往账号与登录",
      "#profile-help": "帮助中心正在准备中",
      "#profile-update": versionToast("已是最新版本"),
      "#profile-feedback": "帮助中心正在准备中",
      "#profile-manage-plan": "订阅管理请前往云端控制台",
      "#profile-delete": "删除账号前请先导出数据",
    };
    Object.entries(simple).forEach(([selector, message]) => {
      const node = $(selector);
      if (node) node.addEventListener("click", () => toast(message));
    });
    $$("[data-profile-action]").forEach((node) => {
      node.addEventListener("click", () => toast("该功能请前往账号与登录"));
    });
  }

  const SETTINGS_KEY = "echoq-settings";

  function settingsMap() {
    try {
      return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") || {};
    } catch (error) {
      return {};
    }
  }

  function saveSetting(key, value) {
    const data = settingsMap();
    data[key] = value;
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(data));
    } catch (error) {
      /* ignore */
    }
  }

  function syncSettings() {
    const data = settingsMap();
    $$("[data-toggle]").forEach((node) => {
      const key = node.dataset.toggle;
      const value = data[key];
      if (typeof value === "boolean") node.classList.toggle("on", value);
    });
    const platform = $("#set-default-platform");
    if (platform && data.default_platform) platform.value = data.default_platform;
  }

  function initSettings() {
    const nav = $("#set-nav");
    if (nav) {
      nav.addEventListener("click", (event) => {
        const button = event.target.closest("[data-set]");
        if (!button) return;
        $$("#set-nav button").forEach((node) => node.classList.toggle("active", node === button));
        $$("#set-panels [data-panel]").forEach((panel) => {
          panel.hidden = panel.dataset.panel !== button.dataset.set;
        });
      });
    }
    $$("[data-toggle]").forEach((node) => {
      node.addEventListener("click", () => {
        node.classList.toggle("on");
        saveSetting(node.dataset.toggle, node.classList.contains("on"));
      });
    });
    $$(".theme-card").forEach((card) => {
      card.addEventListener("click", () => applyThemePref(card.dataset.themeValue));
    });
    const platform = $("#set-default-platform");
    if (platform) platform.addEventListener("change", () => saveSetting("default_platform", platform.value));
    const backup = $("#set-backup-now");
    if (backup) {
      backup.addEventListener("click", async () => {
        try {
          await api("/api/backups", { method: "POST" });
          toast("备份已生成");
        } catch (error) {
          toast(error.message || "备份失败", true);
        }
      });
    }
    const exportAll = $("#set-export-all");
    if (exportAll) exportAll.addEventListener("click", () => toast("导出功能请前往发布记录"));
    const onboarding = $("#set-onboarding");
    if (onboarding) onboarding.addEventListener("click", () => toast("引导已重置，下次启动时展示"));
  }

  /* ------------------------------------------------------------------ 启动 */

  function init() {
    initShell();
    initWindows();
    initAccountUI();
    initProfile();
    initSettings();
    initCollapse();
    initRailTips();
    wrapSwitchView();
    bindHome();
    bindDashboard();
    bindPalette();
    bindWeekBoard();
    initLibraryView();
    initStudioPreview();
    initStudioTools();
    initStudioResize();
    initPhoneZoom();
    initStudioSteps();
    initStudioTour();
    initRecordFilters();
    initQueueFilters();
    initScheduleFilters();
    observeAccounts();
    observeNotifications();
    observeModal();

    const tasks = $("#btn-status-tasks");
    if (tasks) tasks.addEventListener("click", () => switchView("queue"));

    switchView("home");
    window.setInterval(syncChrome, 1500);
    window.setInterval(() => {
      if (state.view === "home" && !homeEditing && homeSig() !== homeSignature) renderHome();
    }, 1500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
