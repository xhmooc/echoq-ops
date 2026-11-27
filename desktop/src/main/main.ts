/**
 * Electron 主进程：先起本地 HTTP 服务，再打开界面。
 *
 * 与旧版 main.js 的区别：不再拉起 Python/PyInstaller 后端，业务直接跑在
 * Electron 的 Node 主进程里；端口改用 8711，迁移期可与 Python 版并存。
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { app, BrowserWindow, dialog, ipcMain, shell, type Session } from "electron";
import {
  APP_NAME,
  DATA_DIR,
  HOST,
  PORT,
  UPLOAD_DIR,
  WEB_STATIC_DIR,
  ensureDirs,
} from "../core/config";
import { closeDb } from "../core/db";
import { log } from "../core/log";
import { startServer } from "../server/http";
import { buildRouter } from "../server/routes";
import { startLoop, stopLoop } from "../services/worker";
import { recoverSchedules, tickSchedules } from "../services/schedulerEngine";
import { disposeRenderer } from "../render/renderer";

let win: BrowserWindow | null = null;
let scheduleTimer: NodeJS.Timeout | null = null;
const SCHEDULE_POLL_MS = 30_000;
// 优先服务真实前端；迁移验证台只作为兜底，方便单独调试 Node 端点。
const WEB_DIR = fs.existsSync(path.join(WEB_STATIC_DIR, "index.html"))
  ? WEB_STATIC_DIR
  : path.join(__dirname, "..", "..", "public");

process.on("uncaughtException", (error) => {
  log.error(`uncaughtException: ${error?.stack || String(error)}`);
  // 进程状态已经不可信，继续运行可能带着损坏状态写库，直接退出。
  app.exit(1);
});
process.on("unhandledRejection", (reason) => {
  log.error(
    `unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`
  );
  app.exit(1);
});

// Windows 会把带本机 UDP 监听的桌面程序当成服务并弹防火墙提示。抖音登录页会
// 初始化 QUIC / WebRTC 探测，便携版每次解压路径不同，于是每次都弹一次。关掉
// QUIC 与非代理 UDP 后页面仍走 HTTP/2，登录流程不受影响。
app.commandLine.appendSwitch("disable-quic");
app.commandLine.appendSwitch("force-webrtc-ip-handling-policy", "disable_non_proxied_udp");

// 兜底：任何窗口（含后续新建的）都不允许把非 http(s) 协议交给系统，
// 否则 Chromium 会弹「获取打开此 'bitbrowser' 链接的应用」这类系统窗口。
// 抖音登录页实测会探测 bitbrowser://，扫码成功后又尝试 bytedance://dispatch_message/。
const BLOCKED_SCHEMES = [
  "bitbrowser",
  "bytedance",
  "snssdk1128",
  "douyin",
  "xhsdiscover",
  "xiaohongshu",
  "weixin",
  "wechat",
];
const guardedSessions = new WeakSet<Session>();
app.on("web-contents-created", (_event, contents) => {
  // 在 session 层注册同名协议处理器，Chromium 就不会再交给 Windows 弹
  // 「获取打开此链接的应用」。
  const guarded = guardedSessions.has(contents.session);
  if (!guarded) {
    guardedSessions.add(contents.session);
    for (const scheme of BLOCKED_SCHEMES) {
      try {
        contents.session.protocol.handle(scheme, () => {
          log.warn(`已拦截页面发起的外部协议: ${scheme}://`);
          return new Response("", { status: 204 });
        });
      } catch {
        /* 该协议已注册过，忽略 */
      }
    }
    log.info(`已为当前会话注册外部协议拦截: ${BLOCKED_SCHEMES.join(", ")}`);
  }
  contents.setWindowOpenHandler(({ url }) => {
    if (!/^https?:/i.test(url)) {
      log.warn(`已拦截弹窗中的非网页协议: ${url.slice(0, 120)}`);
    }
    return { action: "deny" };
  });
  const blockExternal = (event: Electron.Event, url: string): void => {
    if (/^https?:/i.test(url)) return;
    event.preventDefault();
    log.warn(`已拦截非网页协议跳转: ${url.slice(0, 120)}`);
  };
  contents.on("will-navigate", blockExternal);
  contents.on("will-redirect", blockExternal);
  contents.on("will-frame-navigate", (details) => {
    if (/^https?:/i.test(details.url)) return;
    details.preventDefault();
    log.warn(`已拦截子框架非网页协议: ${details.url.slice(0, 120)}`);
  });
  contents.on("will-attach-webview", (event) => {
    event.preventDefault();
  });
});

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 880,
    minWidth: 1080,
    minHeight: 720,
    title: APP_NAME,
    backgroundColor: "#f6f4ef",
    autoHideMenuBar: true,
    // 页面自带标题栏（含窗口按钮），去掉系统边框避免出现两层功能栏。
    frame: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  win.removeMenu();
  win.loadURL(`http://${HOST}:${PORT}/`);
  win.once("ready-to-show", () => win?.show());
  const notifyMaximized = (): void => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send("echoq:maximized", win.isMaximized());
  };
  win.on("maximize", notifyMaximized);
  win.on("unmaximize", notifyMaximized);
  win.webContents.setWindowOpenHandler(({ url }) => {
    // 只放行普通网页链接，避免把 file://、ms-* 等协议交给系统执行。
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        void shell.openExternal(url).catch(() => undefined);
      }
    } catch {
      /* 非法链接直接忽略 */
    }
    return { action: "deny" };
  });
  // 站内误点到 bitbrowser:// 等自定义协议时，不让系统弹「获取应用」窗口。
  win.webContents.on("will-navigate", (event, url) => {
    if (!/^https?:/i.test(url)) {
      event.preventDefault();
      log.warn(`已拦截非网页协议跳转: ${url.slice(0, 120)}`);
    }
  });
  win.on("closed", () => {
    win = null;
    // 渲染模块常驻一个隐藏窗口，window-all-closed 不会触发；主窗口关闭即主动退出。
    app.quit();
  });
}

const locked = app.requestSingleInstanceLock();
if (!locked) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(() => {
    ensureDirs();
    log.info(`desktop 启动，数据目录 ${DATA_DIR}`);
    ipcMain.handle("echoq:pick-image", async () => {
      const result = await dialog.showOpenDialog({
        title: "选择公众号封面",
        properties: ["openFile"],
        filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg"] }],
      });
      const source = result.canceled ? "" : result.filePaths[0] || "";
      if (!source) return "";
      // 复制到数据目录后再交给发布流程：发布侧只信任数据目录内的素材路径。
      const suffix = path.extname(source).toLowerCase() || ".png";
      const target = path.join(UPLOAD_DIR, `cover-${randomBytes(8).toString("hex")}${suffix}`);
      try {
        fs.mkdirSync(UPLOAD_DIR, { recursive: true });
        fs.copyFileSync(source, target);
        return target;
      } catch (error) {
        log.error(`复制封面到数据目录失败: ${String(error)}`);
        return "";
      }
    });
    // 页面自绘标题栏的窗口按钮。
    ipcMain.handle("echoq:open-external", async (_event, url: unknown) => {
      const value = String(url || "");
      try {
        const parsed = new URL(value);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
        await shell.openExternal(value);
        return true;
      } catch {
        return false;
      }
    });
    ipcMain.on("echoq:win", (event, action: unknown) => {
      const target = BrowserWindow.fromWebContents(event.sender);
      if (!target) return;
      if (action === "minimize") target.minimize();
      else if (action === "maximize") {
        if (target.isMaximized()) target.unmaximize();
        else target.maximize();
      } else if (action === "close") target.close();
    });
    const server = startServer({
      router: buildRouter(),
      webDir: WEB_DIR,
      port: PORT,
      host: HOST,
    });
    server.on("error", (error) => {
      log.error(`本地服务启动失败: ${error.message}`);
      dialog.showErrorBox("启动失败", `本地服务端口 ${PORT} 启动失败：${error.message}`);
      app.quit();
    });
    // 等端口真正监听后再加载页面，避免拿不到本地服务首页。
    server.once("listening", () => {
      const recovered = recoverSchedules();
      if (recovered.interrupted) {
        log.info(`已清理 ${recovered.interrupted} 条中断的定时执行记录`);
      }
      startLoop();
      // 主进程定时驱动调度器；HTTP 手动 tick 入口仍然保留。
      scheduleTimer = setInterval(() => {
        void tickSchedules(2).catch((error) => {
          log.error(`定时调度执行失败: ${String(error)}`);
        });
      }, SCHEDULE_POLL_MS);
      scheduleTimer.unref();
      log.info(`定时调度器已启动：每 ${SCHEDULE_POLL_MS / 1000} 秒检查一次`);
      createWindow();
    });
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("before-quit", () => {
    if (scheduleTimer) {
      clearInterval(scheduleTimer);
      scheduleTimer = null;
    }
    stopLoop();
    disposeRenderer();
    closeDb();
  });
}
