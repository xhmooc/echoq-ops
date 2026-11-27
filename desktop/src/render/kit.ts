/**
 * M2.5 三端适配层：把 design-lab/kit（adapt.js + profiles.json）的设计规则
 * 移植进 Next 版出图管线。
 *
 * 三条硬原则（design-lab/docs/design-system.md「美育系统 v1.1」）：
 *  - 一稿多版，不裁切：每个比例单独起版；
 *  - 一页一个主角：图、标题、数字只选一个；
 *  - 先有内容，再有版式：页数由内容量决定。
 *
 * 平台政策：
 *  - 标题按平台压缩（小红书 10 / 抖音 12 / 公众号 14 字），保留 `|` 手动断行，
 *    截断不补省略号——完整句子留给副标题或内页；
 *  - 封面不塞目录/页码回顾；
 *  - 标签数量按平台收敛（小红书 8 / 公众号 3 / 抖音 3）；
 *  - 抖音图文 3:4 画布，安全区顶/底各 40px 内不放文字。
 */
import type { CardPage } from "./templates";

export interface PlatformProfile {
  key: string;
  name: string;
  /** 主画布（一稿多版：公众号另有方图 extraCanvas） */
  canvas: { width: number; height: number };
  extraCanvas?: { width: number; height: number };
  titleMax: number;
  perPage: number;
  tagsMax: number;
  /** 文字禁入区（设计 px，画布宽 1080） */
  safe: { top: number; bottom: number };
}

export const PLATFORM_PROFILES: Record<string, PlatformProfile> = {
  xiaohongshu: {
    key: "xiaohongshu",
    name: "小红书",
    canvas: { width: 1080, height: 1440 },
    titleMax: 10,
    perPage: 3,
    tagsMax: 8,
    safe: { top: 0, bottom: 0 },
  },
  wechat_mp: {
    key: "wechat_mp",
    name: "公众号",
    canvas: { width: 1080, height: 460 },
    extraCanvas: { width: 1080, height: 1080 },
    titleMax: 14,
    perPage: 3,
    tagsMax: 3,
    safe: { top: 0, bottom: 0 },
  },
  douyin: {
    key: "douyin",
    name: "抖音",
    // 抖音图文与小红书同为 3:4（1080×1440）；9:16 只用于沉浸式开屏，不作为图文画布。
    canvas: { width: 1080, height: 1440 },
    titleMax: 12,
    perPage: 3,
    tagsMax: 3,
    safe: { top: 40, bottom: 40 },
  },
};

export function platformProfile(platform: unknown): PlatformProfile {
  return PLATFORM_PROFILES[String(platform || "").trim()] || PLATFORM_PROFILES.xiaohongshu;
}

/** 主画布尺寸（按平台自动适配）。 */
export function platformCanvas(platform: unknown): { width: number; height: number } {
  return platformProfile(platform).canvas;
}

/**
 * 标题按平台压缩：保留 `|` 手动断行（不做中文自动断行），
 * 按字符截断且不补省略号。
 */
export function clampTitle(raw: unknown, max: number): string {
  const text = String(raw || "").trim();
  const chars = Array.from(text.replace(/\|/g, "").trim());
  if (chars.length <= max) return text;
  const parts = text.split("|").map((part) => part.trim()).filter(Boolean);
  if (parts.length <= 1) return chars.slice(0, max).join("");
  let used = 0;
  const out: string[] = [];
  for (const part of parts) {
    const room = max - used;
    if (room <= 0) break;
    const piece = Array.from(part).slice(0, room).join("");
    out.push(piece);
    used += Array.from(piece).length;
  }
  return out.join("|");
}

/**
 * 平台化精简 pass：标题压缩、封面去目录、标签收敛。
 * 条目分页沿用 buildCardPages 的每页 capacity（balanced=3，与平台政策一致）。
 */
export function applyPlatformPolicy(pages: CardPage[], platform: unknown): CardPage[] {
  const profile = platformProfile(platform);
  return pages.map((page) => {
    const next: CardPage = { ...page };
    if (next.kind === "cover") {
      next.title = clampTitle(next.title, profile.titleMax);
      // 封面只留主角：不塞目录、不放页码回顾
      next.toc = [];
    }
    next.tags = next.tags.slice(0, profile.tagsMax);
    return next;
  });
}

/** 公众号「一稿多版」：横幅 + 方图；其余平台单画布。 */
export function platformCanvasList(platform: unknown): Array<{ width: number; height: number }> {
  const profile = platformProfile(platform);
  return profile.extraCanvas ? [profile.canvas, profile.extraCanvas] : [profile.canvas];
}

/** 一次生成固定覆盖三端（大部分内容要同发三端）。 */
export const ALL_PLATFORMS = ["xiaohongshu", "douyin", "wechat_mp"] as const;

/* --------------------------- M3 动效/视频画幅档案 --------------------------- */

export interface MotionCanvasSpec {
  width: number;
  height: number;
  label: string;
}

/** 动效/图组视频支持的画幅（motion/slideshow API 的 canvas 参数同源维护）。 */
export const MOTION_CANVASES: Record<string, MotionCanvasSpec> = {
  portrait: { width: 1080, height: 1440, label: "竖版 3:4" },
  square: { width: 1080, height: 1080, label: "方图 1:1" },
  wide: { width: 1080, height: 460, label: "公众号头图 2.35:1" },
  landscape: { width: 1920, height: 1080, label: "横版 16:9" },
  story: { width: 1080, height: 1920, label: "抖音竖版 9:16" },
};

export type MotionCanvasKey = keyof typeof MOTION_CANVASES;

/**
 * 每端内容页上限（张数收紧：封面 + 内容页 + 尾页，不把全部文字都摊成图）。
 * 小红书 ≤4 张、抖音 ≤3 张、公众号横幅+方图 2 张，三端一次共 ≤9 张。
 */
export function platformContentLimit(platform: string): number {
  if (platform === "douyin") return 1;
  if (platform === "wechat_mp") return 0;
  return 2;
}
