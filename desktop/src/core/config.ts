/**
 * 运行期路径与开关。
 *
 * 与 Python 版保持同一份数据：`%LOCALAPPDATA%\EchoQ-Ops\data` 与
 * `%LOCALAPPDATA%\EchoQ-Ops\secret.key`。迁移期两个进程指向同一份 SQLite，
 * 用 WAL 保证互不阻塞；也可以用 OPS_DATA_DIR / OPS_KEY_PATH 隔离调试。
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const userBase =
  process.env.LOCALAPPDATA ||
  process.env.APPDATA ||
  path.join(os.homedir(), ".local", "share");

export const APP_NAME = "应声运营";
export const USER_DIR = process.env.OPS_USER_DIR
  ? path.resolve(process.env.OPS_USER_DIR)
  : path.join(userBase, "EchoQ-Ops");

export const DATA_DIR = path.resolve(
  process.env.OPS_DATA_DIR || path.join(USER_DIR, "data")
);
export const KEY_PATH = path.resolve(
  process.env.OPS_KEY_PATH || path.join(USER_DIR, "secret.key")
);
export const DB_PATH = path.join(DATA_DIR, "ops.db");
export const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
export const ASSETS_DIR = path.join(DATA_DIR, "assets");
export const DESIGN_DIR = path.join(DATA_DIR, "designs");
export const LOG_DIR = path.join(DATA_DIR, "logs");
export const BACKUP_DIR = path.join(DATA_DIR, "backups");
export const EVIDENCE_DIR = path.join(DATA_DIR, "evidence");
export const TMP_DIR = path.join(DATA_DIR, "tmp");
// 源码运行时前端在仓库的 ops/web/static；打包后由 electron-builder 复制到 resources/web。
export const WEB_STATIC_DIR = (() => {
  const packaged = process.resourcesPath ? path.join(process.resourcesPath, "web") : "";
  if (packaged && fs.existsSync(path.join(packaged, "index.html"))) return packaged;
  return path.join(__dirname, "..", "..", "..", "ops", "web", "static");
})();

export const PORT = Number(process.env.OPS_DESKTOP_PORT || 8711);
export const HOST = "127.0.0.1";

export const MP_HOME = "https://mp.weixin.qq.com/";
export const MP_ORIGIN = "https://mp.weixin.qq.com";

const DIRS = [
  DATA_DIR,
  UPLOAD_DIR,
  ASSETS_DIR,
  DESIGN_DIR,
  LOG_DIR,
  BACKUP_DIR,
  EVIDENCE_DIR,
  TMP_DIR,
];

export function ensureDirs(): void {
  for (const dir of DIRS) fs.mkdirSync(dir, { recursive: true });
}

export function now(): number {
  return Math.floor(Date.now() / 1000);
}
