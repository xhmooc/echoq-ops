/**
 * 站内备份与恢复：数据库 + 可选图片 + 可选密钥，整体加密成一个 .eqbak 文件。
 *
 * 与 Python 版 ops/backup.py 保持一致：数据库用 SQLite 在线备份接口取快照，
 * 压缩后再用 Fernet 加密；恢复前自动留一份「恢复前备份」，恢复错了还能回来。
 */
import fs from "node:fs";
import path from "node:path";
import {
  ASSETS_DIR,
  BACKUP_DIR,
  DB_PATH,
  KEY_PATH,
  TMP_DIR,
  UPLOAD_DIR,
  now,
} from "../core/config";
import { closeDb, getDb } from "../core/db";
import { decryptBytes, encryptBytes } from "../core/fernet";
import { zipCreate, zipExtract, type ZipEntry } from "../core/zip";

const NAME_RE = /^[A-Za-z0-9_.-]+\.eqbak$/;
const MAX_RESTORE_BYTES = 8 * 1024 * 1024 * 1024;
const ASSET_BUDGET_BYTES = 1500 * 1024 * 1024;
const IMAGE_SUFFIXES = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

function stamp(): string {
  const date = new Date();
  const pad = (num: number, size = 2) => String(num).padStart(size, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-` +
    `${pad(date.getMilliseconds(), 3)}`
  );
}

function collectTree(
  root: string,
  arcRoot: string,
  budget: { used: number }
): { files: ZipEntry[]; count: number } {
  const files: ZipEntry[] = [];
  if (!fs.existsSync(root)) return { files, count: 0 };
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(target);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!IMAGE_SUFFIXES.has(path.extname(entry.name).toLowerCase())) continue;
      let size = 0;
      try {
        size = fs.statSync(target).size;
      } catch {
        continue;
      }
      if (budget.used + size > ASSET_BUDGET_BYTES) continue;
      budget.used += size;
      const relative = path.relative(root, target).split(path.sep).join("/");
      files.push({ name: `${arcRoot}/${relative}`, data: fs.readFileSync(target) });
    }
  };
  walk(root);
  return { files, count: files.length };
}

export interface BackupOptions {
  include_images?: boolean;
  include_key?: boolean;
  prefix?: string;
}

export async function createBackup(options: BackupOptions = {}): Promise<Record<string, unknown>> {
  const includeImages = Boolean(options.include_images);
  const includeKey = Boolean(options.include_key);
  const prefix = options.prefix || "backup";
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const work = path.join(TMP_DIR, `backup-${stamp()}-${process.pid}`);
  fs.mkdirSync(work, { recursive: true });
  const workDb = path.join(work, "ops.db");
  try {
    // SQLite 在线备份：拿一致性快照，避免直接拷贝 WAL 库。
    await getDb().backup(workDb);
    const manifest: Record<string, unknown> = {
      created_at: now(),
      include_images: includeImages,
      include_key: includeKey,
      app: "EchoQ-Ops",
    };
    const entries: ZipEntry[] = [{ name: "ops.db", data: fs.readFileSync(workDb) }];
    if (includeImages) {
      const budget = { used: 0 };
      const assets = collectTree(ASSETS_DIR, "assets", budget);
      const uploads = collectTree(UPLOAD_DIR, "uploads", budget);
      entries.push(...assets.files, ...uploads.files);
      manifest.images = assets.count;
      manifest.uploads = uploads.count;
      manifest.asset_bytes = budget.used;
    }
    if (includeKey && fs.existsSync(KEY_PATH)) {
      entries.push({ name: "secret.key", data: fs.readFileSync(KEY_PATH) });
    }
    entries.push({
      name: "manifest.json",
      data: Buffer.from(JSON.stringify(manifest, null, 2), "utf8"),
    });
    const payload = encryptBytes(await zipCreate(entries));
    const name =
      `${prefix}-${stamp()}` +
      `${includeImages ? "-with-images" : ""}` +
      `${includeKey ? "-with-key" : ""}.eqbak`;
    const target = path.join(BACKUP_DIR, name);
    fs.writeFileSync(target, payload);
    return {
      name,
      size: Buffer.byteLength(payload),
      created_at: Math.floor(fs.statSync(target).mtimeMs / 1000),
      include_images: includeImages,
      include_key: includeKey,
      message: "备份已创建，建议下载后放到另一块磁盘",
    };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

export async function restoreBackup(name: string): Promise<Record<string, unknown>> {
  if (!NAME_RE.test(name || "")) throw new Error("备份文件名不合法");
  const source = path.join(BACKUP_DIR, name);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
    throw Object.assign(new Error(`备份不存在: ${name}`), { status: 404 });
  }
  if (fs.statSync(source).size > MAX_RESTORE_BYTES) {
    throw new Error("备份文件过大，无法在站内恢复");
  }
  // 先给当前状态留一份自动备份，恢复错了还能回来。
  const safety = await createBackup({ include_images: false, include_key: false, prefix: "prerestore" });

  const work = path.join(TMP_DIR, `restore-${stamp()}-${process.pid}`);
  fs.mkdirSync(work, { recursive: true });
  try {
    const raw = decryptBytes(fs.readFileSync(source));
    const entries = await zipExtract(raw);
    const root = path.resolve(work);
    for (const entry of entries) {
      const target = path.resolve(work, entry.name);
      if (target !== root && !target.startsWith(root + path.sep)) {
        throw new Error("备份内容包含非法路径，已拒绝恢复");
      }
    }
    let restoredDb: Uint8Array | null = null;
    let keyBundle: Uint8Array | null = null;
    let filesRestored = 0;
    for (const entry of entries) {
      if (entry.name === "ops.db") {
        restoredDb = entry.data;
        continue;
      }
      if (entry.name === "secret.key") {
        keyBundle = entry.data;
        continue;
      }
      if (entry.name === "manifest.json") continue;
      const target = path.resolve(work, entry.name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.data);
      if (entry.name.startsWith("assets/") || entry.name.startsWith("uploads/")) filesRestored += 1;
    }
    if (!restoredDb) throw new Error("备份里没有数据库文件，可能已损坏");

    // 关闭当前连接后覆盖数据库，并清掉旧的 WAL/SHM，随后重新打开。
    closeDb();
    fs.writeFileSync(DB_PATH, restoredDb);
    for (const suffix of ["-wal", "-shm"]) {
      const extra = `${DB_PATH}${suffix}`;
      if (fs.existsSync(extra)) fs.rmSync(extra, { force: true });
    }
    getDb();

    for (const [dir, prefix] of [
      [ASSETS_DIR, "assets"],
      [UPLOAD_DIR, "uploads"],
    ] as const) {
      const source_dir = path.join(work, prefix);
      if (!fs.existsSync(source_dir)) continue;
      copyTree(source_dir, dir);
    }

    let keyRestored = false;
    if (keyBundle) {
      if (fs.existsSync(KEY_PATH)) {
        fs.copyFileSync(KEY_PATH, path.join(BACKUP_DIR, `secret-${stamp()}.key.bak`));
      }
      fs.mkdirSync(path.dirname(KEY_PATH), { recursive: true });
      fs.writeFileSync(KEY_PATH, keyBundle);
      keyRestored = true;
    }
    return {
      name,
      safety_backup: String(safety.name || ""),
      files_restored: filesRestored,
      key_restored: keyRestored,
      message: "恢复完成；如正在发布，建议重启应用以清理旧连接",
    };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function copyTree(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyTree(source, target);
    } else if (entry.isFile()) {
      fs.copyFileSync(source, target);
    }
  }
}
