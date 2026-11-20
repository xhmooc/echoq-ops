const { app, BrowserWindow, Tray, Menu, dialog, shell, nativeImage } = require("electron");
const { spawn, execFileSync } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");

const PORT = 8710;
const APP_URL = `http://127.0.0.1:${PORT}`;
const APP_NAME = "应声运营";

let win = null;
let tray = null;
let backend = null;
let backendPid = null;
let ownsBackend = false;
let quitting = false;
let trayHintShown = false;

function log(message) {
  try {
    const dir = path.join(process.env.LOCALAPPDATA || ".", "EchoQ-Ops", "logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, "electron.log"),
      `[${new Date().toISOString()}] ${message}\n`
    );
  } catch (_) {
    /* 日志失败不影响主流程 */
  }
}

process.on("uncaughtException", (error) => {
  log(`uncaughtException: ${error && error.stack ? error.stack : error}`);
});
process.on("unhandledRejection", (reason) => {
  log(`unhandledRejection: ${reason && reason.stack ? reason.stack : reason}`);
});
log("electron start");

function asset(name) {
  return path.join(__dirname, "assets", name);
}

function backendExe() {
  if (process.env.OPS_BACKEND) return process.env.OPS_BACKEND;
  const packaged = path.join(process.resourcesPath, "backend", "EchoQ-Ops.exe");
  if (fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, "..", "build", "_backend", "EchoQ-Ops.exe");
}

function dataDir() {
  return path.join(process.env.LOCALAPPDATA || "", "EchoQ-Ops", "data");
}

function ping() {
  return new Promise((resolve) => {
    const request = http.get(`${APP_URL}/api/health`, { timeout: 1500 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on("error", () => resolve(false));
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
  });
}

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ping()) return true;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

/* PyInstaller 单文件包会再派生一个子进程，只杀父进程会留下子进程占着端口，
   所以统一按进程树杀。 */
function taskkillTree(pid) {
  if (!pid) return;
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch (_) {
    /* 进程已经退出 */
  }
}

function listeningPids(port) {
  try {
    const out = execFileSync("netstat", ["-ano", "-p", "TCP"], {
      encoding: "utf8",
      windowsHide: true,
    });
    const pids = new Set();
    out.split(/\r?\n/).forEach((line) => {
      if (!line.includes(`:${port}`) || !line.includes("LISTENING")) return;
      const parts = line.trim().split(/\s+/);
      const pid = Number(parts[parts.length - 1]);
      if (pid) pids.add(pid);
    });
    return Array.from(pids);
  } catch (_) {
    return [];
  }
}

function imageName(pid) {
  try {
    const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
      encoding: "utf8",
      windowsHide: true,
    });
    const match = out.match(/"([^"]+\.exe)"/i);
    return match ? match[1] : "";
  } catch (_) {
    return "";
  }
}

async function waitUntilFree(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!listeningPids(port).length) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

/* 端口上的服务如果是本程序残留的后端（比如上次没退出干净），先清掉再起新的，
   否则新包会复用到旧后端，界面一直是旧版。开发用的 python 服务不碰。 */
async function clearStaleBackend() {
  const pids = listeningPids(PORT);
  const stale = pids.filter((pid) => /^EchoQ-Ops\.exe$/i.test(imageName(pid)));
  if (!stale.length) return false;
  log(`stale backend pids: ${stale.join(",")}`);
  stale.forEach(taskkillTree);
  await waitUntilFree(PORT, 6000);
  return true;
}

async function startBackend() {
  if (await clearStaleBackend()) {
    log("stale backend cleared");
  }
  // 端口已有服务（开发版 python 服务）就直接复用，不再起第二个。
  if (await ping()) return true;
  const exe = backendExe();
  log(`backend exe: ${exe}`);
  if (!fs.existsSync(exe)) {
    dialog.showErrorBox(
      "缺少后端程序",
      `没找到 ${exe}\n请先运行 build\\build.ps1 打包后端。`
    );
    return false;
  }
  backend = spawn(exe, ["--headless", "--port", String(PORT)], {
    windowsHide: true,
    stdio: "ignore",
  });
  ownsBackend = true;
  backendPid = backend.pid;
  backend.on("exit", () => {
    log("backend exited");
    backend = null;
    backendPid = null;
  });
  const ready = await waitForServer(90000);
  log(`backend ready: ${ready}`);
  return ready;
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 720,
    title: APP_NAME,
    icon: asset("icon.ico"),
    backgroundColor: "#f6f4ef",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();
  win.loadURL(APP_URL);
  win.once("ready-to-show", () => {
    log("window ready-to-show");
    win.show();
  });
  win.on("closed", () => log("window closed"));
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  // 关窗口只是收进托盘，真正退出走托盘菜单。
  win.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
      if (!trayHintShown && tray) {
        trayHintShown = true;
        try {
          tray.displayBalloon({
            title: APP_NAME,
            content: "程序已收进托盘继续运行，右键托盘图标可彻底退出。",
          });
        } catch (_) {
          /* 系统不支持气泡提示就跳过 */
        }
      }
    }
  });
}

function createTray() {
  // Windows 托盘用 PNG 更稳，按 16px 缩放由系统做高 DPI 适配。
  const image = nativeImage.createFromPath(asset("icon.png")).resize({ width: 16, height: 16 });
  tray = new Tray(image);
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开发布台", click: showWindow },
      { label: "打开数据目录", click: () => shell.openPath(dataDir()) },
      { type: "separator" },
      {
        label: "退出",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on("click", showWindow);
}

const locked = app.requestSingleInstanceLock();
log(`single instance lock: ${locked}`);
if (!locked) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.whenReady().then(async () => {
    log("app ready");
    const ready = await startBackend();
    if (!ready) {
      log("backend failed, quit");
      await dialog.showMessageBox({
        type: "error",
        title: APP_NAME,
        message: "后端服务没有启动成功，请查看日志后再试。",
        detail: path.join(dataDir(), "logs", "launcher.log"),
      });
      quitting = true;
      app.quit();
      return;
    }
    createWindow();
    createTray();
    log("window and tray created");
  });
}

app.on("before-quit", () => {
  log("before-quit");
  quitting = true;
  // 只杀启动器会留下 PyInstaller 的子进程继续占端口，这里杀整棵进程树。
  if (ownsBackend && backendPid) {
    taskkillTree(backendPid);
    backendPid = null;
    backend = null;
  }
});

// 万一退出流程被打断，也在进程结束时兜底清理一次。
process.on("exit", () => {
  if (ownsBackend && backendPid) taskkillTree(backendPid);
});

// 关掉窗口后留在托盘，不退出应用。
app.on("window-all-closed", () => {});
