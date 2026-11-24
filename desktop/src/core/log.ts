import fs from "node:fs";
import path from "node:path";
import { LOG_DIR } from "./config";

const LOG_FILE = path.join(LOG_DIR, "desktop.log");
const BACKUP_FILE = path.join(LOG_DIR, "desktop.1.log");
const MAX_LOG_BYTES = 5 * 1024 * 1024;

function rotateIfNeeded(): void {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size < MAX_LOG_BYTES) return;
    // Windows 下 rename 覆盖已存在文件会失败，先删旧备份。
    try {
      fs.unlinkSync(BACKUP_FILE);
    } catch {
      /* 备份不存在 */
    }
    fs.renameSync(LOG_FILE, BACKUP_FILE);
  } catch {
    /* 文件不存在或轮转失败都不影响写日志 */
  }
}

function write(level: string, message: string): void {
  const line = `[${new Date().toISOString()}] ${level} ${message}`;
  // 控制台给开发看；文件给用户回查，和 Python 版的 logs 目录放在一起。
  if (process.env.OPS_DESKTOP_QUIET !== "1") console.log(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    rotateIfNeeded();
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {
    /* 日志失败不影响主流程 */
  }
}

export const log = {
  info: (message: string) => write("INFO", message),
  warn: (message: string) => write("WARN", message),
  error: (message: string) => write("ERROR", message),
};
