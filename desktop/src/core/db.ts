/**
 * SQLite 访问层：直接打开 Python 版已有的库，不复制、不重建。
 *
 * 迁移期必须与 Python 版共存：WAL + busy_timeout 让两个进程轮流写入而不
 * 报 database is locked。表结构仍由 Python 版迁移，这里只读写已存在的表。
 */
import fs from "node:fs";
import Database from "better-sqlite3";
import { DB_PATH, ensureDirs } from "./config";
import { log } from "./log";

let database: Database.Database | null = null;

interface CachedStatement {
  all(...args: unknown[]): unknown[];
  get(...args: unknown[]): unknown;
  run(...args: unknown[]): { lastInsertRowid: number | bigint; changes: number | bigint };
}

// 热路径复用已编译语句，避免每次查询重新 prepare。
const statements = new Map<string, CachedStatement>();

function prepare(sql: string): CachedStatement {
  let statement = statements.get(sql);
  if (!statement) {
    statement = getDb().prepare(sql) as unknown as CachedStatement;
    statements.set(sql, statement);
  }
  return statement;
}

export function getDb(): Database.Database {
  if (database) return database;
  ensureDirs();
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(
      `未找到现有数据库：${DB_PATH}。迁移阶段请先用原版启动一次生成数据。`
    );
  }
  database = new Database(DB_PATH);
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = NORMAL");
  database.pragma("busy_timeout = 10000");
  database.pragma("foreign_keys = ON");
  migrate(database);
  log.info(`已打开数据库 ${DB_PATH}`);
  return database;
}

/** 轻量迁移：只补 Node 版新增、Python 版没有的列，不动已有数据。 */
function migrate(db: Database.Database): void {
  try {
    const columns = db.prepare("PRAGMA table_info(accounts)").all() as { name?: string }[];
    if (!columns.length) return;
    if (!columns.some((column) => column.name === "avatar")) {
      db.exec("ALTER TABLE accounts ADD COLUMN avatar TEXT NOT NULL DEFAULT ''");
      log.info("accounts 表已补充 avatar 列");
    }
  } catch (error) {
    log.error(`账号表结构检查失败: ${String(error)}`);
  }
}

export function queryAll<T = Record<string, unknown>>(
  sql: string,
  ...args: unknown[]
): T[] {
  return prepare(sql).all(...args) as T[];
}

export function queryOne<T = Record<string, unknown>>(
  sql: string,
  ...args: unknown[]
): T | undefined {
  return prepare(sql).get(...args) as T | undefined;
}

export function execute(sql: string, ...args: unknown[]): number {
  const result = prepare(sql).run(...args);
  return Number(result.lastInsertRowid || 0);
}

export function closeDb(): void {
  statements.clear();
  database?.close();
  database = null;
}
