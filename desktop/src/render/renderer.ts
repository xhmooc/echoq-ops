/**
 * HTML 截图：把 HTML 写到临时文件，用 Electron 隐藏窗口加载后 capturePage 取 PNG。
 *
 * 不引入 Playwright / Puppeteer。所有渲染串行排队，避免同时创建多个
 * BrowserWindow 抢占 GPU；无论成功失败都会销毁窗口。
 * M1 体检：captureHtml 可附带「版式探针」，采集每个文字块的真实盒模型与字号，
 * 供 checkBlocks 做 越界/重叠/字号量级 检查（与 Python 版 designs.py 同规则）。
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { BrowserWindow as ElectronBrowserWindow } from "electron";
import { TMP_DIR } from "../core/config";

const RENDER_TIMEOUT_MS = 30_000;
const WINDOW_READY_DELAY_MS = 150;

export interface LayoutBlock {
  t: string;
  c: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fs: number;
}

export interface LayoutCheck {
  errors: string[];
  warnings: string[];
}

let cachedElectron: typeof import("electron") | null | undefined;

function loadElectron(): typeof import("electron") | null {
  if (cachedElectron !== undefined) return cachedElectron;
  try {
    // 非 Electron 环境里 require("electron") 返回可执行文件路径字符串。
    const mod = require("electron") as typeof import("electron") | string;
    cachedElectron =
      mod && typeof mod === "object" && typeof mod.BrowserWindow === "function" ? mod : null;
  } catch {
    cachedElectron = null;
  }
  return cachedElectron;
}

/** 当前进程是否具备图片渲染能力（必须在 Electron 主进程中调用）。 */
export function isRenderAvailable(): boolean {
  const electron = loadElectron();
  return Boolean(electron && typeof electron.BrowserWindow === "function");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(task: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/** 全局渲染队列：截图必须串行，避免多个隐藏窗口互相争用渲染进程。 */
let renderChain: Promise<unknown> = Promise.resolve();

function enqueueRender<T>(task: () => Promise<T>): Promise<T> {
  const run = renderChain.then(task, task);
  renderChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/** 等待字体与页面内图片就绪；没有图片时立即返回。 */
const WAIT_ASSETS_SCRIPT = `
(async () => {
  try {
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
  } catch (error) {
    /* 字体加载失败不影响截图 */
  }
  try {
    const images = Array.from(document.images || []);
    await Promise.all(images.map((image) => {
      if (image.complete) return Promise.resolve();
      return new Promise((resolve) => {
        image.addEventListener("load", resolve, { once: true });
        image.addEventListener("error", resolve, { once: true });
      });
    }));
  } catch (error) {
    /* 图片缺失交给页面兜底样式 */
  }
  return true;
})()
`;

/** 版式探针：采集文字块盒模型（类名白名单，避免父子重复计数）。 */
const PROBE_SELECTOR_LIST = [
  // 旧模板（templates.ts）
  ".kicker", ".title", ".lead", ".toc .row", ".section-title", ".item",
  ".item-text", ".outro", ".tag-row .tag", ".seal", ".top", ".foot",
  // V2 出图 2.0（v2templates.ts）
  ".v-kicker", ".v-title", ".v-sub", ".v-sec",
  ".v-item", ".v-toc .v-row", ".v-side .v-sec", ".v-side .v-page",
  ".v-line", ".v-end .v-big", ".v-end .v-note", ".v-tags .v-tag",
  ".v-foot", ".w-band .w-title", ".w-mark", ".w-sub",
  // M2 手绘引擎（sketch.ts）
  ".sk-kicker", ".sk-title", ".sk-sub", ".sk-sec", ".sk-item",
  ".sk-big", ".sk-note", ".sk-tag", ".sk-foot",
].join(",");

const PROBE_SCRIPT = `
(() => {
  try {
    const out = [];
    document.querySelectorAll(${JSON.stringify(PROBE_SELECTOR_LIST)}).forEach((el) => {
      const text = String(el.innerText || el.textContent || "").trim();
      if (!text) return;
      const st = getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden") return;
      if (parseFloat(st.opacity) === 0) return;
      const box = el.getBoundingClientRect();
      if (box.width < 4 || box.height < 4) return;
      out.push({
        t: text.slice(0, 36),
        c: String(el.className || "").slice(0, 40),
        x: box.x, y: box.y, w: box.width, h: box.height,
        fs: parseFloat(st.fontSize) || 0
      });
    });
    return out;
  } catch (e) {
    return [{ t: "__PROBE_ERROR__", c: String((e && e.message) || e), x: 0, y: 0, w: 0, h: 0, fs: 0 }];
  }
})()`;

/**
 * 把 HTML 渲染成 PNG。
 *
 * @param html 完整 HTML 文档（须自带尺寸样式，可引用本机字体）
 * @param width 画布宽度（CSS 像素，等于输出像素）
 * @param height 画布高度
 * @param probe true 时额外采集文字块（与截图同帧，见 captureHtmlWithProbe）
 */
export async function captureHtml(
  html: string,
  width: number,
  height: number,
  probe: boolean = false
): Promise<Buffer> {
  const electron = loadElectron();
  if (!electron) {
    throw new Error(
      "当前环境不支持图片渲染：没有检测到 Electron 的 BrowserWindow，请在桌面版主进程中调用"
    );
  }
  const { app, BrowserWindow } = electron;
  if (app && typeof app.isReady === "function" && !app.isReady()) {
    throw new Error("图片渲染失败：Electron 尚未就绪，请稍后重试");
  }
  const canvasWidth = Math.max(1, Math.round(width));
  const canvasHeight = Math.max(1, Math.round(height));

  return enqueueRender(async () => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    // 复用同一个隐藏窗口：连续创建/销毁窗口会让后续 file:// 加载报 ERR_FAILED。
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) {
        destroySharedWindow();
        await delay(250);
      }
      const htmlFile = path.join(
        TMP_DIR,
        `render-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.html`
      );
      try {
        fs.writeFileSync(htmlFile, html, "utf8");
        const win = ensureSharedWindow(BrowserWindow, canvasWidth, canvasHeight);
        win.setContentSize(canvasWidth, canvasHeight);
        loadFailure = "";
        await withTimeout(
          win.loadURL(pathToFileURL(htmlFile).href),
          RENDER_TIMEOUT_MS,
          "图片渲染超时：页面加载超过 30 秒"
        );
        await win.webContents.executeJavaScript(WAIT_ASSETS_SCRIPT, true).catch(() => undefined);
        // 留一点时间给字体栅格化和 CSS 渐变稳定。
        await delay(WINDOW_READY_DELAY_MS);
        if (probe) {
          const blocks = (await win.webContents
            .executeJavaScript(PROBE_SCRIPT, true)
            .catch((error: unknown) => {
              console.error("[probe] 版式探针执行失败:", error);
              return [] as LayoutBlock[];
            })) as LayoutBlock[];
          lastBlocks = Array.isArray(blocks) ? blocks : [];
        }
        const image = await withTimeout(
          win.webContents.capturePage({ x: 0, y: 0, width: canvasWidth, height: canvasHeight }),
          RENDER_TIMEOUT_MS,
          "图片渲染超时：截图超过 30 秒"
        );
        if (image.isEmpty()) throw new Error("截取到的图片为空，请检查模板内容");
        return image.toPNG();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        lastError = new Error(`图片渲染失败：${loadFailure || message}`);
        if (/^图片渲染失败：Electron 尚未就绪/.test(message)) break;
        if (!/ERR_FAILED|超时|渲染进程退出/.test(`${message} ${loadFailure}`)) {
          // 非环境类错误（例如模板问题）不必重试。
          break;
        }
      } finally {
        try {
          fs.rmSync(htmlFile, { force: true });
        } catch {
          /* 临时文件清理失败不影响截图结果 */
        }
      }
    }
    throw lastError || new Error("图片渲染失败：未知原因");
  });
}

let lastBlocks: LayoutBlock[] = [];

/** 渲染并采集版式探针（截图 + 文字块盒模型同帧完成）。 */
export async function captureHtmlWithProbe(
  html: string,
  width: number,
  height: number
): Promise<{ png: Buffer; blocks: LayoutBlock[] }> {
  lastBlocks = [];
  const png = await captureHtml(html, width, height, true);
  return { png, blocks: lastBlocks };
}

/**
 * 逐帧截图（动效管线）：一次加载页面，对每个时间点 t 调用 window.__seek(t)
 * 后等两帧 rAF 再截图——画面是 t 的纯函数，同 t 同像素。
 * 页面须实现动效契约（templates.ts 的 MOTION_SCRIPT）。
 */
export async function captureFrames(
  html: string,
  width: number,
  height: number,
  times: number[]
): Promise<Buffer[]> {
  const electron = loadElectron();
  if (!electron) {
    throw new Error(
      "当前环境不支持图片渲染：没有检测到 Electron 的 BrowserWindow，请在桌面版主进程中调用"
    );
  }
  const { app, BrowserWindow } = electron;
  if (app && typeof app.isReady === "function" && !app.isReady()) {
    throw new Error("图片渲染失败：Electron 尚未就绪，请稍后重试");
  }
  const canvasWidth = Math.max(1, Math.round(width));
  const canvasHeight = Math.max(1, Math.round(height));
  return enqueueRender(async () => {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    const htmlFile = path.join(
      TMP_DIR,
      `frames-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.html`
    );
    fs.writeFileSync(htmlFile, html, "utf8");
    try {
      const win = ensureSharedWindow(BrowserWindow, canvasWidth, canvasHeight);
      win.setContentSize(canvasWidth, canvasHeight);
      loadFailure = "";
      await withTimeout(
        win.loadURL(pathToFileURL(htmlFile).href),
        RENDER_TIMEOUT_MS,
        "图片渲染超时：页面加载超过 30 秒"
      );
      await win.webContents.executeJavaScript(WAIT_ASSETS_SCRIPT, true).catch(() => undefined);
      await delay(WINDOW_READY_DELAY_MS);
      const seekReady = await win.webContents
        .executeJavaScript("typeof window.__seek === 'function'", true)
        .catch(() => false);
      if (!seekReady) throw new Error("页面未实现 __seek 动效契约");
      const frames: Buffer[] = [];
      for (const t of times) {
        await win.webContents
          .executeJavaScript(`window.__seek(${Number(t).toFixed(4)})`, true)
          .catch(() => undefined);
        await win.webContents
          .executeJavaScript(
            "new Promise(function(r){ requestAnimationFrame(function(){ requestAnimationFrame(r); }); });",
            true
          )
          .catch(() => undefined);
        const image = await withTimeout(
          win.webContents.capturePage({ x: 0, y: 0, width: canvasWidth, height: canvasHeight }),
          RENDER_TIMEOUT_MS,
          "图片渲染超时：截图超过 30 秒"
        );
        if (image.isEmpty()) throw new Error("截取到的图片为空，请检查模板内容");
        frames.push(image.toPNG());
      }
      return frames;
    } finally {
      try {
        fs.rmSync(htmlFile, { force: true });
      } catch {
        /* 临时文件清理失败不影响结果 */
      }
    }
  });
}

let sharedWindow: ElectronBrowserWindow | null = null;
let loadFailure = "";

function ensureSharedWindow(
  BrowserWindow: typeof import("electron").BrowserWindow,
  width: number,
  height: number
): ElectronBrowserWindow {
  if (sharedWindow && !sharedWindow.isDestroyed()) return sharedWindow;
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    frame: false,
    resizable: false,
    backgroundColor: "#ffffff",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  win.webContents.on("did-fail-load", (_event, code, description) => {
    loadFailure = `${description} (${code})`;
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    loadFailure = `渲染进程退出：${details.reason}`;
  });
  win.on("closed", () => {
    sharedWindow = null;
  });
  sharedWindow = win;
  return win;
}

function destroySharedWindow(): void {
  if (sharedWindow && !sharedWindow.isDestroyed()) {
    try {
      sharedWindow.destroy();
    } catch {
      /* 已销毁时忽略 */
    }
  }
  sharedWindow = null;
}

/** 退出前释放常驻的隐藏渲染窗口，避免它拖住应用不退出。 */
export function disposeRenderer(): void {
  destroySharedWindow();
}

/* --------------------------- 版式体检（M1 1.5） --------------------------- */

const SAFE = { left: 44, right: 44, top: 28, bottom: 18 };
const LABEL_CLASS_HINTS = ["v-no", "v-kicker", "w-mark", "v-foot", "v-tag", "v-page", "chip", "brand", "stamp", "pageno", "sk-no", "sk-kicker", "sk-foot", "sk-tag"];

function inside(outer: LayoutBlock, inner: LayoutBlock): boolean {
  return (
    inner.x >= outer.x - 1 &&
    inner.y >= outer.y - 1 &&
    inner.x + inner.w <= outer.x + outer.w + 1 &&
    inner.y + inner.h <= outer.y + outer.h + 1
  );
}

/**
 * 版式体检：返回 {errors, warnings}。
 * errors 拦截出图（越界/重叠）；warnings 只提示不强拦（字号量级/留白/密度，
 * 对齐 UPGRADE-PLAN「先告警观察一周再切强制」）。
 */
export function checkBlocks(blocks: LayoutBlock[], width: number, height: number): LayoutCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const block of blocks) {
    const left = Number(block.x);
    const top = Number(block.y);
    const right = left + Number(block.w);
    const bottom = top + Number(block.h);
    if (left < SAFE.left - 0.5 || top < SAFE.top - 0.5) {
      errors.push(`「${block.t}」越过左上安全边距 (${left.toFixed(0)},${top.toFixed(0)})`);
    }
    if (right > width - SAFE.right + 0.5 || bottom > height - SAFE.bottom + 0.5) {
      errors.push(`「${block.t}」越过右下安全边距 (${right.toFixed(0)},${bottom.toFixed(0)})`);
    }
    const fontSize = Number(block.fs) || 0;
    if (fontSize) {
      const labelLike = LABEL_CLASS_HINTS.some((hint) => String(block.c || "").includes(hint));
      // 字号量级先走「告警观察」模式，不拦截出图。
      if (fontSize < 24) {
        warnings.push(`「${block.t}」字号 ${fontSize.toFixed(0)}px 低于建议下限 24px`);
      } else if (fontSize < 32 && !labelLike) {
        warnings.push(`「${block.t}」字号 ${fontSize.toFixed(0)}px 偏小（正文建议 ≥32px）`);
      }
    }
  }
  for (let i = 0; i < blocks.length; i += 1) {
    for (let j = i + 1; j < blocks.length; j += 1) {
      const a = blocks[i];
      const b = blocks[j];
      if (inside(a, b) || inside(b, a)) continue;
      const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (overlapX > 1 && overlapY > 1 && overlapX * overlapY > 6) {
        errors.push(`「${a.t}」与「${b.t}」重叠 ${(overlapX * overlapY).toFixed(0)}px²`);
      }
    }
  }
  if (blocks.length && !errors.length) {
    const top = Math.min(...blocks.map((b) => Number(b.y)));
    const bottom = Math.max(...blocks.map((b) => Number(b.y) + Number(b.h)));
    const coverage = (bottom - top) / height;
    if (coverage < 0.5) warnings.push(`内容纵向只占画布 ${(coverage * 100).toFixed(0)}%，留白偏多`);
    const padTop = top;
    const padBottom = height - bottom;
    if (padBottom > padTop * 2.5 && padBottom > 240) {
      warnings.push("底部留白明显大于顶部，版面头重脚轻");
    }
  }
  if (blocks.length > 16) warnings.push(`单页文字块 ${blocks.length} 个偏多，建议拆分页面`);
  return { errors, warnings };
}
