/**
 * HTML 截图：把 HTML 写到临时文件，用 Electron 隐藏窗口加载后 capturePage 取 PNG。
 *
 * 不引入 Playwright / Puppeteer。所有渲染串行排队，避免同时创建多个
 * BrowserWindow 抢占 GPU；无论成功失败都会销毁窗口。
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { BrowserWindow as ElectronBrowserWindow } from "electron";
import { TMP_DIR } from "../core/config";

const RENDER_TIMEOUT_MS = 30_000;
const WINDOW_READY_DELAY_MS = 150;

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

/**
 * 把 HTML 渲染成 PNG。
 *
 * @param html 完整 HTML 文档（须自带尺寸样式，可引用本机字体）
 * @param width 画布宽度（CSS 像素，等于输出像素）
 * @param height 画布高度
 */
export async function captureHtml(html: string, width: number, height: number): Promise<Buffer> {
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
