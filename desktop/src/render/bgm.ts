/**
 * M3-g 内置配乐：vendor/bgm（开发）或安装目录 resources/bgm（打包）下的免版权短 loop。
 * 由 scripts/gen-bgm.mjs 纯代码合成（AAC 单声道，每条 ≤100KB）。
 */

export interface BgmTrack {
  key: string;
  name: string;
}

import fs from "node:fs";
import path from "node:path";
import { HttpError } from "../server/http";

/** 固定展示顺序与中文名；未登记的文件以文件名兜底。 */
const BGM_NAMES: Record<string, string> = {
  sunrise: "晨光 · 轻快",
  cloud: "云层 · 舒缓",
  spark: "火花 · 活力",
};

let cache: BgmTrack[] | undefined;

/** 配乐目录：打包后 resources/bgm，开发期 desktop/vendor/bgm。 */
export function bgmDir(): string | null {
  const candidates: string[] = [];
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) candidates.push(path.join(resourcesPath, "bgm"));
  try {
    // 编译后 __dirname = desktop/dist/render → 上两级即 desktop/
    candidates.push(path.join(__dirname, "..", "..", "vendor", "bgm"));
  } catch {
    /* 忽略 */
  }
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {
      /* 忽略 */
    }
  }
  return null;
}

/** 可用配乐清单（固定顺序）。 */
export function listBgm(): BgmTrack[] {
  if (cache) return cache;
  const dir = bgmDir();
  if (!dir) {
    cache = [];
    return cache;
  }
  try {
    const files = fs
      .readdirSync(dir)
      .filter((file) => /\.m4a$/i.test(file))
      .map((file) => file.replace(/\.m4a$/i, ""));
    const keys = [...Object.keys(BGM_NAMES), ...files.filter((f) => !(f in BGM_NAMES))];
    cache = keys
      .filter((key) => files.includes(key))
      .map((key) => ({ key, name: BGM_NAMES[key] || key }));
  } catch {
    cache = [];
  }
  return cache;
}

/** key → 本地文件；"none" 或未知 key 返回 null。 */
export function bgmFile(key: string): string | null {
  if (!key || key === "none") return null;
  const dir = bgmDir();
  if (!dir) return null;
  const file = path.join(dir, `${key}.m4a`);
  try {
    return fs.existsSync(file) ? file : null;
  } catch {
    return null;
  }
}

/** 校验 bgm 入参：允许 "none"、空或清单内 key。 */
export function assertBgmKey(key: string | undefined): void {
  if (!key || key === "none") return;
  if (!listBgm().some((track) => track.key === key)) {
    const choices = ["none", ...listBgm().map((track) => track.key)].join("、");
    throw new HttpError(400, `不支持的配乐「${key}」，可选：${choices}`);
  }
}
