/**
 * M3 动效管线：封面动图（motion）/ 图组视频（slideshow）/ 混合图（composite）公共入口。
 *
 * - HTML 生成：按草稿最近一次配图风格匹配三套模板（手绘 / V2 / 旧版式），
 *   页面实现 __seek(t) 确定性契约（画面是 t 的纯函数，禁止读时钟）；
 * - 逐帧渲染：renderer.captureFrames（Electron 隐藏共享窗口，全局串行队列）；
 * - 合成：ffmpeg.encodeMotion（loop.gif + motion.mp4）；
 * - 失败回退：静态首帧 + note，不阻塞配图主流程。
 *
 * M3-a：自 cards.ts 迁入；motion API 扩参 {template, duration, canvas, bgm}，
 * 缺省参数与 0.2.9 行为完全一致（fade-seq / 6s / portrait / 无配乐）。
 */
import fs from "node:fs";
import path from "node:path";
import { ASSETS_DIR, UPLOAD_DIR } from "../core/config";
import { escapeHtml } from "../core/contentText";
import { log } from "../core/log";
import { getSetting } from "../core/settings";
import { getDraft, updateDraft } from "../services/drafts";
import { HttpError } from "../server/http";
import { encodeMotion, encodeVideo, hasFfmpeg, mixAudio } from "./ffmpeg";
import { assertBgmKey, bgmFile } from "./bgm";
import { applyPlatformPolicy, MOTION_CANVASES, platformProfile } from "./kit";
import {
  captureFrames,
  captureHtml,
  captureHtmlWithProbe,
  captureProbedFrames,
  checkBlocks,
  isRenderAvailable,
} from "./renderer";
import {
  buildCardPages,
  normalizeCardStyle,
  renderCardDocument,
  resolvePalette,
  type BrandMeta,
  type CardPalette,
  type CardStyleKey,
} from "./templates";
import {
  DEFAULT_V2_LAYOUT,
  DEFAULT_V2_PALETTE,
  isV2StyleKey,
  renderV2Document,
} from "./v2templates";
import { isSketchStyleKey, renderSketchDocument, sketchSeed } from "./sketch";

export type RenderDraft = Record<string, unknown>;
export type DraftInput = RenderDraft | number;

export interface MotionInfo {
  gif: string;
  mp4: string;
  still: string;
  /** true=静态首帧回退；false=已合成真动图（GIF+MP4） */
  static: boolean;
  note: string;
}

export interface MotionResult {
  motion: MotionInfo;
  draft_id: number;
  images: string[];
}

export interface MotionOptions {
  template?: string;
  duration?: number;
  canvas?: string;
  bgm?: string;
}

export interface NormalizedMotionOptions {
  template: string;
  duration: number;
  canvas: string;
  width: number;
  height: number;
  bgm?: string;
}

/** 动效帧率（确定值，禁止读时钟）。 */
export const MOTION_FPS = 25;
/** 支持的动效时长（秒）。 */
export const MOTION_DURATIONS = [4, 6, 8] as const;
export const DEFAULT_MOTION_DURATION = 6;

/** 动效范式注册表（M3-b：5 种范式，全部支持四种画幅；sketch-grow 非手绘页自动降级 fade-seq）。 */
export const MOTION_TEMPLATES = [
  {
    key: "fade-seq",
    name: "错峰入场",
    desc: "元素逐个淡入上移，底部进度条收尾（默认）",
    canvases: ["portrait", "square", "wide", "landscape"],
  },
  {
    key: "type-in",
    name: "逐字浮现",
    desc: "标题按字符依次显现，末帧定格，适合大字公告/知识卡片",
    canvases: ["portrait", "square", "wide", "landscape"],
  },
  {
    key: "kenburns",
    name: "缓推镜头",
    desc: "画面缓慢放大（插画层优先），文字错峰淡入，适合图注解读",
    canvases: ["portrait", "square", "wide", "landscape"],
  },
  {
    key: "sketch-grow",
    name: "手绘生长",
    desc: "插画自上而下生长 + 文字面板错峰入场（手绘风格专用，其它风格自动错峰入场）",
    canvases: ["portrait", "square", "wide", "landscape"],
  },
  {
    key: "pop-sticker",
    name: "贴纸弹跳",
    desc: "元素弹簧缩放入场，角标衰减抖动收尾，适合节日/剪纸/营销",
    canvases: ["portrait", "square", "wide", "landscape"],
  },
] as const;

/**
 * 校验并归一化 motion API 入参：白名单外直接 400（中文原因）。
 * 缺省值 = 0.2.9 现行为，老调用（空 body）零破坏。
 */
export function normalizeMotionOptions(
  body: Record<string, unknown> = {}
): NormalizedMotionOptions {
  const rawTemplate = body.template;
  const template =
    rawTemplate === undefined || rawTemplate === null || rawTemplate === ""
      ? "fade-seq"
      : String(rawTemplate);
  if (!MOTION_TEMPLATES.some((item) => item.key === template)) {
    throw new HttpError(
      400,
      `不支持的动效范式「${template}」，可选：${MOTION_TEMPLATES.map((item) => item.key).join("、")}`
    );
  }
  const rawDuration = body.duration ?? DEFAULT_MOTION_DURATION;
  const duration = Number(rawDuration);
  if (!Number.isFinite(duration) || !(MOTION_DURATIONS as readonly number[]).includes(duration)) {
    throw new HttpError(400, `动效时长仅支持 ${MOTION_DURATIONS.join("/")} 秒`);
  }
  const rawCanvas = body.canvas;
  const canvas =
    rawCanvas === undefined || rawCanvas === null || rawCanvas === ""
      ? "portrait"
      : String(rawCanvas);
  const canvasSpec = MOTION_CANVASES[canvas];
  if (!canvasSpec) {
    throw new HttpError(
      400,
      `不支持的画幅「${canvas}」，可选：${Object.keys(MOTION_CANVASES).join("、")}`
    );
  }
  const rawBgm = body.bgm;
  const bgm = rawBgm === undefined || rawBgm === null || rawBgm === "" ? undefined : String(rawBgm);
  assertBgmKey(bgm);
  return {
    template,
    duration,
    canvas,
    width: canvasSpec.width,
    height: canvasSpec.height,
    bgm,
  };
}

function assertRenderable(): void {
  if (!isRenderAvailable() && !process.env.ECHOQ_SMOKE) {
    throw new Error(
      "图片渲染不可用：请使用 Electron 桌面版启动；当前进程没有 BrowserWindow，无法截图"
    );
  }
}

function resolveDraft(input: DraftInput): RenderDraft {
  if (typeof input === "number") return getDraft(input);
  if (!input || typeof input !== "object") throw new Error("草稿数据无效，无法生成配图");
  return input;
}

function draftId(draft: RenderDraft): number {
  const id = Number(draft.id || 0);
  if (!Number.isFinite(id) || id <= 0) throw new Error("草稿缺少有效 ID，无法保存配图");
  return Math.trunc(id);
}

/** 把产物写到 assets/draft-{id}/ 下，返回前端可直接使用的 /assets 路径。 */
function writeAsset(ownerId: number, relative: string, data: Buffer): string {
  const clean = relative.replace(/\\/g, "/").replace(/^\/+/, "");
  const target = path.join(ASSETS_DIR, `draft-${ownerId}`, ...clean.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
  return `/assets/draft-${ownerId}/${clean}`;
}

function brandMeta(): BrandMeta {
  return {
    brand: getSetting("card_brand", "应声面试"),
    column: getSetting("card_column", "面试避坑"),
    issue: getSetting("card_issue", "07"),
  };
}

function paletteFor(style: CardStyleKey): CardPalette {
  const explicit = getSetting("card_palette", "");
  const theme = getSetting("card_theme", "warm");
  const accent = getSetting("theme_color", "");
  return resolvePalette(String(explicit || theme || ""), style, accent);
}

/**
 * `/api/drafts/:id/motion`：封面动图。逐帧渲染（__seek 确定性契约）
 * → ffmpeg 合成 loop.gif（15fps/540 宽/两阶段调色板）+ motion.mp4（H.264）。
 * 跟随草稿最近一次配图的风格；成功后 GIF 置于配图首位；
 * 渲染或合成失败时回退静态首帧，不阻塞流程。
 */
export async function renderMotion(
  input: DraftInput,
  options: MotionOptions = {}
): Promise<MotionResult> {
  assertRenderable();
  const opts = normalizeMotionOptions(options as Record<string, unknown>);
  const draft = resolveDraft(input);
  const id = draftId(draft);
  const existing = Array.isArray(draft.images) ? draft.images.map(String) : [];
  const joined = existing.join("|");
  const sketchMatch = /\/sketch-([a-z0-9-]+)\//.exec(joined);
  const v2Match = /\/v2-([a-z0-9-]+)\//.exec(joined);
  const xhs = platformProfile("xiaohongshu");
  const cover = applyPlatformPolicy(buildCardPages(draft, { layout: "balanced" }), "xiaohongshu")[0];
  let html: string;
  if (sketchMatch && isSketchStyleKey(sketchMatch[1])) {
    html = renderSketchDocument(
      cover, sketchMatch[1], sketchSeed(id, 0),
      opts.width, opts.height, xhs.safe, true, opts.duration, opts.template
    );
  } else if (v2Match && isV2StyleKey(v2Match[1])) {
    html = renderV2Document(
      cover, v2Match[1], DEFAULT_V2_LAYOUT, DEFAULT_V2_PALETTE,
      opts.width, opts.height, xhs.safe, true, opts.duration, opts.template
    );
  } else {
    const style = normalizeCardStyle(getSetting("card_style", "paper"));
    html = renderCardDocument(cover, {
      style,
      palette: paletteFor(style),
      layout: "sparse",
      brand: brandMeta(),
      width: opts.width,
      height: opts.height,
      motion: true,
      motionDuration: opts.duration,
      motionTemplate: opts.template,
    });
  }
  // M3-d：ffmpeg 缺失时明确提示，不再静默退化——仍回静态首帧，但不做无谓的逐帧渲染。
  if (!(await hasFfmpeg())) {
    let still = "";
    try {
      still = writeAsset(id, "motion/01-cover-still.png", await captureHtml(html, opts.width, opts.height));
    } catch {
      still = existing[0] || "";
    }
    const motion: MotionInfo = {
      gif: still,
      mp4: "",
      still,
      static: true,
      note: "未检测到 ffmpeg（内置目录与系统 PATH 均未找到），无法合成动图；请使用完整安装包，或在系统 PATH 安装 ffmpeg 后重试",
    };
    saveMotion(id, draft, motion);
    return { motion, draft_id: id, images: existing };
  }
  // M3-c 首末帧体检：与静态图同标准——errors 拦截出图（不落盘、不回退半成品），warnings 告警。
  const probes = await captureProbedFrames(html, {
    width: opts.width,
    height: opts.height,
    times: [0, opts.duration],
  });
  for (const frame of probes) {
    const check = checkBlocks(frame.blocks, opts.width, opts.height, xhs.safe);
    if (check.warnings.length) {
      log.warn(`动效体检提示（${opts.template}/${frame.t === 0 ? "首帧" : "末帧"}）：${check.warnings.join("；")}`);
    }
    if (check.errors.length) {
      throw new Error(
        `动效${frame.t === 0 ? "首帧" : "末帧"}体检未通过：${check.errors.slice(0, 3).join("；")}`
      );
    }
  }
  const gif = await renderStyleMotionClip(id, () => html, opts);
  if (gif) {
    const motion: MotionInfo = {
      gif,
      mp4: gif.replace(/loop\.gif$/, "motion.mp4"),
      still: existing[0] || gif,
      static: false,
      note: "",
    };
    saveMotion(id, draft, motion);
    const images = [gif, ...existing.filter((url) => !/\/motion\//.test(url))];
    updateDraft(id, { images });
    return { motion, draft_id: id, images };
  }
  // 合成失败（缺 ffmpeg 等）：回退静态首帧并说明。
  let still: string;
  try {
    still = writeAsset(id, "motion/01-cover-still.png", await captureHtml(html, opts.width, opts.height));
  } catch {
    still = existing[0] || "";
  }
  const motion: MotionInfo = {
    gif: still,
    mp4: "",
    still,
    static: true,
    note: "动效合成失败（本机缺少 ffmpeg 或逐帧渲染失败），已回退为静态首帧",
  };
  saveMotion(id, draft, motion);
  return { motion, draft_id: id, images: existing };
}

function saveMotion(id: number, draft: RenderDraft, motion: MotionInfo): void {
  const current = draft.content_json;
  const content =
    current && typeof current === "object" && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};
  content.motion = motion;
  updateDraft(id, { content_json: content });
}

/**
 * 风格封面动图：逐帧渲染（__seek 确定性契约）→ ffmpeg 合成 loop.gif + meta.json。
 * 任一步失败返回 null，不阻塞配图主流程。
 */
async function renderStyleMotionClip(
  id: number,
  buildHtml: () => string,
  opts: NormalizedMotionOptions
): Promise<string | null> {
  try {
    const frames = await captureFrames(buildHtml(), {
      width: opts.width,
      height: opts.height,
      fps: MOTION_FPS,
      duration: opts.duration,
    });
    if (frames.length < 2) return null;
    const motionDir = path.join(ASSETS_DIR, `draft-${id}`, "motion");
    fs.mkdirSync(motionDir, { recursive: true });
    if (!(await encodeMotion(frames, MOTION_FPS, motionDir, { width: opts.width, height: opts.height }))) {
      return null;
    }
    writeMotionMeta(motionDir, opts);
    // M3-g：动效 MP4 可选混入内置配乐（GIF 本身不带音轨）。
    if (opts.bgm && opts.bgm !== "none") {
      const bgmPath = bgmFile(opts.bgm);
      const mp4 = path.join(motionDir, "motion.mp4");
      if (bgmPath && fs.existsSync(mp4)) {
        const mixed = path.join(motionDir, "motion-mixed.mp4");
        if (await mixAudio(mp4, bgmPath, mixed)) {
          fs.rmSync(mp4, { force: true });
          fs.renameSync(mixed, mp4);
        } else {
          fs.rmSync(mixed, { force: true });
        }
      }
    }
    return `/assets/draft-${id}/motion/loop.gif`;
  } catch (error) {
    log.warn(`动图生成失败（不影响配图）: ${String(error)}`);
    return null;
  }
}

/** meta.json：记录动效参数，同参数同输出可复现，也是排查现场。 */
function writeMotionMeta(motionDir: string, opts: NormalizedMotionOptions): void {
  try {
    const meta = {
      template: opts.template,
      duration: opts.duration,
      fps: MOTION_FPS,
      canvas: opts.canvas,
      bgm: opts.bgm || "none",
      created_at: new Date().toISOString(),
      generator: "m3",
    };
    fs.writeFileSync(path.join(motionDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
  } catch (error) {
    log.warn(`动效 meta 写入失败: ${String(error)}`);
  }
}

/* ------------------------------------------------------------------ */
/* M3-e 实拍混合图：上传图 + 模板贴纸/边框/日期章 + 标题 → Canvas 合成单帧出图 */
/* ------------------------------------------------------------------ */

export interface CompositeResult {
  image: string;
  images: string[];
  draft_id: number;
}

export const COMPOSITE_TEMPLATES = ["border-sticker", "date-card", "clean-frame"] as const;
export const COMPOSITE_FILTERS = ["none", "film", "bw"] as const;

interface CompositeOptions {
  image: string;
  template: string;
  filter: string;
  canvas: string;
  width: number;
  height: number;
}

function normalizeCompositeOptions(body: Record<string, unknown> = {}): CompositeOptions {
  const image = String(body.image || "").trim();
  if (!image) throw new HttpError(400, "缺少实拍图：请先上传图片，再生成混合图");
  const template = String(body.template || "clean-frame");
  if (!(COMPOSITE_TEMPLATES as readonly string[]).includes(template)) {
    throw new HttpError(400, `不支持的混合图模板「${template}」，可选：${COMPOSITE_TEMPLATES.join("、")}`);
  }
  const filter = String(body.filter || "none");
  if (!(COMPOSITE_FILTERS as readonly string[]).includes(filter)) {
    throw new HttpError(400, `不支持的滤镜「${filter}」，可选：${COMPOSITE_FILTERS.join("、")}`);
  }
  const canvas = String(body.canvas || "portrait");
  const canvasSpec = MOTION_CANVASES[canvas];
  if (!canvasSpec) {
    throw new HttpError(400, `不支持的画幅「${canvas}」，可选：${Object.keys(MOTION_CANVASES).join("、")}`);
  }
  return { image, template, filter, canvas, width: canvasSpec.width, height: canvasSpec.height };
}

/** 把前端传来的 /uploads、/assets 或本机绝对路径解析到白名单目录内，防目录穿越。 */
function resolveMediaPath(image: string): string {
  const normalized = image.replace(/\\/g, "/").split("?")[0];
  let abs: string;
  if (/^\/?uploads\//.test(normalized)) {
    abs = path.join(UPLOAD_DIR, normalized.replace(/^\/?uploads\//, ""));
  } else if (/^\/assets\//.test(normalized)) {
    abs = path.join(ASSETS_DIR, normalized.slice("/assets/".length));
  } else if (path.isAbsolute(normalized)) {
    abs = normalized;
  } else {
    throw new HttpError(400, `无法识别的图片路径「${image}」，请使用上传接口返回的 /uploads/ 路径`);
  }
  const resolved = path.resolve(abs);
  const roots = [UPLOAD_DIR, ASSETS_DIR].map((item) => path.resolve(item) + path.sep);
  if (!roots.some((root) => resolved.startsWith(root))) {
    throw new HttpError(400, "图片路径越界：只允许使用本机 uploads / assets 目录内的素材");
  }
  if (!fs.existsSync(resolved)) throw new HttpError(400, `实拍图不存在：${normalized}`);
  return resolved;
}

/** 文件头白名单（与上传接口同标准）：PNG/JPEG/WEBP/GIF。 */
function assertImageFile(file: string): void {
  const head = fs.readFileSync(file).subarray(0, 12);
  const hex = head.toString("hex");
  const ok =
    hex.startsWith("89504e470d0a1a0a") || // PNG
    (head[0] === 0xff && head[1] === 0xd8) || // JPEG
    hex.startsWith("47494638") || // GIF
    (hex.startsWith("52494646") && head.toString("ascii", 8, 12) === "WEBP"); // WEBP
  if (!ok) throw new HttpError(400, "素材不是有效图片（支持 PNG / JPG / WEBP / GIF）");
}

function photoDataUrl(file: string): string {
  const ext = path.extname(file).toLowerCase();
  const mime =
    ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif" : "image/jpeg";
  return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
}

/** 标题字号：单行放得下用大字号，放不下自动降为两行字号（checkBlocks 兜底越界）。 */
function compositeTitleSize(title: string, width: number): number {
  const chars = Math.max(1, Array.from(title).length);
  const maxW = width - 168;
  const one = Math.floor(maxW / chars);
  if (one >= 48) return Math.min(80, one);
  const two = Math.floor(maxW / Math.ceil(chars / 2));
  return Math.max(40, Math.min(72, two));
}

function buildCompositeHtml(args: {
  width: number;
  height: number;
  template: string;
  filter: string;
  dataUrl: string;
  title: string;
  date: string;
  brand: string;
}): string {
  const { width, height, template, filter, dataUrl, title, date, brand } = args;
  const filterCss: Record<string, string> = {
    none: "none",
    film: "sepia(.28) saturate(1.15) contrast(1.06) brightness(1.02)",
    bw: "grayscale(1) contrast(1.1)",
  };
  const pad = Math.round(width * 0.078);
  const titleSize = compositeTitleSize(title, width);
  const layers: string[] = [];
  if (template === "border-sticker") {
    layers.push(`<div class="cp-frame"></div>`);
    layers.push(`<div class="cp-sticker">${escapeHtml(brand)} · 实拍</div>`);
  } else if (template === "date-card") {
    const [y = "", m = "01", d = "01"] = date.split("-");
    layers.push(
      `<div class="cp-date"><div class="cp-d">${escapeHtml(d)}</div><div class="cp-m">${escapeHtml(`${y}.${m}`)}</div></div>`
    );
  } else {
    layers.push(`<div class="cp-frame cp-thin"></div>`);
  }
  const vignette =
    filter === "film"
      ? `<div class="cp-vignette"></div>`
      : "";
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/><title>${escapeHtml(title)} · 混合图</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{width:${width}px;height:${height}px;overflow:hidden;background:#101014}
.page{position:relative;width:${width}px;height:${height}px;overflow:hidden;background:#101014;font-family:"PingFang SC","Microsoft YaHei",sans-serif}
.cp-photo{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;filter:${filterCss[filter] ?? "none"}}
.cp-grade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.08) 0%,rgba(0,0,0,0) 34%,rgba(0,0,0,.58) 100%)}
.cp-vignette{position:absolute;inset:0;box-shadow:inset 0 0 ${Math.round(width * 0.16)}px rgba(20,10,0,.5)}
.cp-frame{position:absolute;inset:${Math.round(pad * 0.42)}px;border:6px solid rgba(255,255,255,.94);border-radius:10px;box-shadow:0 6px 30px rgba(0,0,0,.28)}
.cp-frame.cp-thin{border-width:3px;border-color:rgba(255,255,255,.82)}
.cp-sticker{position:absolute;right:${pad}px;top:${pad}px;background:#fff;color:#14141a;font-weight:800;
font-size:${Math.round(width * 0.032)}px;padding:${Math.round(width * 0.014)}px ${Math.round(width * 0.024)}px;
border-radius:16px;transform:rotate(3deg);box-shadow:0 8px 24px rgba(0,0,0,.35);letter-spacing:.06em}
.cp-date{position:absolute;left:${pad}px;top:${pad}px;background:#fff;border-radius:18px;text-align:center;
padding:${Math.round(width * 0.016)}px ${Math.round(width * 0.026)}px;box-shadow:0 8px 24px rgba(0,0,0,.35)}
.cp-date .cp-d{font-size:${Math.round(width * 0.05)}px;font-weight:800;line-height:1.1;color:#14141a}
.cp-date .cp-m{font-size:${Math.round(width * 0.024)}px;letter-spacing:.22em;color:#6b6b74;margin-top:6px}
.cp-caption{position:absolute;left:${pad}px;right:${pad}px;bottom:${pad}px;color:#fff}
.cp-kicker{font-size:${Math.round(width * 0.03)}px;letter-spacing:.32em;opacity:.88;margin-bottom:${Math.round(width * 0.016)}px;font-weight:600}
.cp-title{font-size:${titleSize}px;line-height:1.32;font-weight:800;text-shadow:0 2px 14px rgba(0,0,0,.45)}
</style></head>
<body><main class="page">
<img class="cp-photo" src="${dataUrl}"/>
<div class="cp-grade"></div>${vignette}
${layers.join("\n")}
<div class="cp-caption"><div class="cp-kicker">${escapeHtml(brand)} · 实拍手记</div><h1 class="cp-title">${escapeHtml(title)}</h1></div>
</main></body></html>`;
}

/**
 * `/api/drafts/:id/composite`：实拍混合图。底图按画幅 cover 裁切 + 滤镜 + 模板层
 * （贴纸边框 / 日期章 / 简洁边框）+ 标题文字层，单帧截图（成本与静态图相同）。
 * 产物写入 assets/draft-{id}/composite/ 并追加到配图列表，参与体检与发布。
 */
export async function renderComposite(
  input: DraftInput,
  options: Record<string, unknown> = {}
): Promise<CompositeResult> {
  assertRenderable();
  const opts = normalizeCompositeOptions(options);
  const draft = resolveDraft(input);
  const id = draftId(draft);
  const photo = resolveMediaPath(opts.image);
  assertImageFile(photo);
  const brand = brandMeta().brand;
  const created = String(draft.created_at || "").slice(0, 10);
  const html = buildCompositeHtml({
    width: opts.width,
    height: opts.height,
    template: opts.template,
    filter: opts.filter,
    dataUrl: photoDataUrl(photo),
    title: String(draft.title || "").trim() || "实拍手记",
    date: /^\d{4}-\d{2}-\d{2}$/.test(created) ? created : "2026-01-01",
    brand,
  });
  // 体检（单帧，与静态图同标准）：errors 拦截出图。
  const shot = await captureHtmlWithProbe(html, opts.width, opts.height);
  const check = checkBlocks(shot.blocks, opts.width, opts.height, platformProfile("xiaohongshu").safe);
  if (check.warnings.length) {
    log.warn(`混合图体检提示（${opts.template}/${opts.canvas}）：${check.warnings.join("；")}`);
  }
  if (check.errors.length) {
    throw new Error(`混合图体检未通过：${check.errors.slice(0, 3).join("；")}`);
  }
  const url = writeAsset(id, "composite/01-composite.png", shot.png);
  try {
    const meta = {
      template: opts.template,
      filter: opts.filter,
      canvas: opts.canvas,
      source: opts.image,
      created_at: new Date().toISOString(),
      generator: "m3",
    };
    fs.writeFileSync(
      path.join(ASSETS_DIR, `draft-${id}`, "composite", "meta.json"),
      JSON.stringify(meta, null, 2),
      "utf8"
    );
  } catch (error) {
    log.warn(`混合图 meta 写入失败: ${String(error)}`);
  }
  const existing = Array.isArray(draft.images) ? draft.images.map(String) : [];
  const images = [...existing.filter((item) => !/\/composite\//.test(item)), url];
  updateDraft(id, { images });
  return { image: url, images, draft_id: id };
}

/* ------------------------------------------------------------------ */
/* M3-f 图组转视频：配图轮播 + 字幕时间轴 → 确定性逐帧 → 全尺寸 MP4 */
/* ------------------------------------------------------------------ */

export interface SlideshowResult {
  mp4: string;
  duration: number;
  frames: number;
  note: string;
}

export const SLIDESHOW_TRANSITIONS = ["crossfade", "slide"] as const;
/** 每张图停留秒数白名单（2.5s 标准 / 2s 降档）。 */
export const SLIDESHOW_PER_CHOICES = [2.5, 2] as const;
/** 帧率白名单（25fps 标准 / 15fps 降档）。 */
export const SLIDESHOW_FPS_CHOICES = [25, 15] as const;
/** 单条视频最多取多少张配图。 */
export const SLIDESHOW_MAX_IMAGES = 10;

interface SlideshowOptions {
  transition: string;
  canvas: string;
  width: number;
  height: number;
  fps: number;
  per: number;
  bgm?: string;
  platform?: string;
}

function normalizeSlideshowOptions(body: Record<string, unknown> = {}): SlideshowOptions {
  const transition = String(body.transition || "crossfade");
  if (!(SLIDESHOW_TRANSITIONS as readonly string[]).includes(transition)) {
    throw new HttpError(400, `不支持的转场「${transition}」，可选：${SLIDESHOW_TRANSITIONS.join("、")}`);
  }
  const canvas = String(body.canvas || "story");
  const canvasSpec = MOTION_CANVASES[canvas];
  if (!canvasSpec) {
    throw new HttpError(400, `不支持的画幅「${canvas}」，可选：${Object.keys(MOTION_CANVASES).join("、")}`);
  }
  const fps = body.fps === undefined || body.fps === null || body.fps === "" ? 25 : Number(body.fps);
  if (!(SLIDESHOW_FPS_CHOICES as readonly number[]).includes(fps)) {
    throw new HttpError(400, `帧率仅支持 ${SLIDESHOW_FPS_CHOICES.join("/")}（15 为降档）`);
  }
  const per = body.per === undefined || body.per === null || body.per === "" ? 2.5 : Number(body.per);
  if (!(SLIDESHOW_PER_CHOICES as readonly number[]).includes(per)) {
    throw new HttpError(400, `每张停留时长仅支持 ${SLIDESHOW_PER_CHOICES.join("/")} 秒（2 为降档）`);
  }
  const platform = body.platform === undefined || body.platform === null || body.platform === "" ? undefined : String(body.platform);
  const rawBgm = body.bgm;
  const bgm = rawBgm === undefined || rawBgm === null || rawBgm === "" ? undefined : String(rawBgm);
  assertBgmKey(bgm);
  return { transition, canvas, width: canvasSpec.width, height: canvasSpec.height, fps, per, bgm, platform };
}

/** 画幅 → 体检用平台档案（story=抖音禁区，square/wide=公众号，其余=小红书）。 */
function canvasPlatform(canvas: string): string {
  if (canvas === "story") return "douyin";
  if (canvas === "square" || canvas === "wide") return "wechat_mp";
  return "xiaohongshu";
}

/** 从草稿配图里取可用的图片 URL（剔除视频与空项；可按平台前缀过滤；上限 10 张）。 */
function slideshowImages(draft: RenderDraft, platform?: string): string[] {
  const all = (Array.isArray(draft.images) ? draft.images : []).map(String).filter((url) =>
    /\.(png|jpe?g|webp|gif)$/i.test(url)
  );
  let picked = all;
  if (platform) {
    const tag = `/${platform}-`;
    const filtered = all.filter((url) => url.includes(tag));
    if (filtered.length >= 2) picked = filtered;
  }
  return picked.slice(0, SLIDESHOW_MAX_IMAGES);
}

/** 字幕分句：标题 + 摘要按换行/标点切句，均分到各场景。 */
function slideshowSubtitles(draft: RenderDraft, sceneCount: number): string[] {
  const title = String(draft.title || "").trim();
  const desc = String(draft.desc || "").trim();
  const sentences = `${title}${title && desc ? "。" : ""}${desc}`
    .split(/\n+|[。！？；!?;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
  const scenes: string[] = [];
  if (!sentences.length) {
    for (let i = 0; i < sceneCount; i += 1) scenes.push("");
    return scenes;
  }
  for (let i = 0; i < sceneCount; i += 1) {
    const from = Math.floor((i * sentences.length) / sceneCount);
    const to = Math.max(from + 1, Math.floor(((i + 1) * sentences.length) / sceneCount));
    scenes.push(sentences.slice(from, to).join("，"));
  }
  return scenes;
}

function buildSlideshowHtml(args: {
  width: number;
  height: number;
  transition: string;
  per: number;
  safeTop: number;
  safeBottom: number;
  images: string[];
  subtitles: string[];
  brand: string;
}): string {
  const { width, height, transition, per, safeTop, safeBottom, images, subtitles, brand } = args;
  const scenes = images
    .map(
      (dataUrl, i) => `<div class="sl-scene" style="z-index:${i}">
<img class="sl-img" src="${dataUrl}"/>
<div class="sl-shade"></div>
<div class="sl-sub"><span>${escapeHtml(subtitles[i] || "")}</span></div>
<div class="sl-no">${escapeHtml(brand)} · ${String(i + 1).padStart(2, "0")}/${String(images.length).padStart(2, "0")}</div>
</div>`
    )
    .join("\n");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/><title>图组视频</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{width:${width}px;height:${height}px;overflow:hidden;background:#0c0c10}
.page{position:relative;width:${width}px;height:${height}px;overflow:hidden;background:#0c0c10;font-family:"PingFang SC","Microsoft YaHei",sans-serif}
.sl-scene{position:absolute;inset:0;opacity:0}
.sl-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.sl-shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.12) 0%,rgba(0,0,0,0) 30%,rgba(0,0,0,0) 62%,rgba(0,0,0,.6) 100%)}
.sl-sub{position:absolute;left:0;right:0;bottom:max(${safeBottom + 40}px,12%);display:flex;justify-content:center}
.sl-sub span{display:inline-block;max-width:86%;background:rgba(12,12,16,.62);color:#fff;
font-size:40px;line-height:1.5;padding:20px 36px;border-radius:20px;text-align:center}
.sl-no{position:absolute;right:48px;top:max(${safeTop + 20}px,4%);color:rgba(255,255,255,.85);font-size:26px;letter-spacing:.12em;
background:rgba(12,12,16,.45);border-radius:14px;padding:10px 18px}
</style></head>
<body><main class="page">
${scenes}
<script>${slideshowScript(images.length, transition, width, per)}</script>
</main></body></html>`;
}

/** 图组视频确定性时间轴：__seek(t) 是 t 的纯函数（场景索引/插值均不读时钟）。 */
function slideshowScript(count: number, transition: string, width: number, per: number): string {
  return `
(function(){
  var page = document.querySelector('.page');
  window.__recording = false;
  if (!page) { window.__seek = function(){}; window.__ready = true; return; }
  var scenes = Array.prototype.slice.call(page.querySelectorAll('.sl-scene'));
  var N = scenes.length;
  var P = ${per};                      /* 每张停留秒数（与请求参数一致） */
  var F = Math.min(0.5, P * 0.3);      /* 转场时长 */
  var MODE = ${JSON.stringify(transition)};
  var W = ${width};
  function seg(t, a, b){ return Math.max(0, Math.min(1, (t - a) / (b - a))); }
  function ease(u){ return 1 - Math.pow(1 - u, 3); }
  window.__seek = function(t){
    for (var i = 0; i < N; i++){
      var el = scenes[i];
      var start = i * P, end = (i + 1) * P;
      var inU = ease(seg(t, start - F, start));
      var outU = ease(seg(t, end, end + F));
      if (MODE === 'slide') {
        var x = (i === 0 ? 0 : (1 - inU) * W * 0.35) - (i === N - 1 ? 0 : outU * W * 0.35);
        el.style.opacity = '1';
        el.style.transform = 'translateX(' + x.toFixed(1) + 'px)';
      } else {
        var o = (i === 0 ? 1 : inU) * (i === N - 1 ? 1 : (1 - outU));
        el.style.opacity = String(o);
        el.style.transform = 'none';
      }
    }
  };
  window.__seek(0);
  window.__ready = true;
})();`;
}

/**
 * `/api/drafts/:id/slideshow`：图组转视频。当前配图（≤10 张）轮播 + 字幕时间轴，
 * 确定性逐帧渲染后 ffmpeg 合成全尺寸 MP4。10 张 × 2.5s × 25fps ≈ 626 帧，
 * 可用 fps=15、per=2 降档。产物落盘 assets/draft-{id}/slideshow/。
 */
export async function renderSlideshow(
  input: DraftInput,
  options: Record<string, unknown> = {}
): Promise<SlideshowResult> {
  assertRenderable();
  // M3-d 同源策略：ffmpeg 缺失给明确提示，不静默退化。
  if (!(await hasFfmpeg())) {
    throw new HttpError(
      400,
      "未检测到 ffmpeg（内置目录与系统 PATH 均未找到），无法合成图组视频；请使用完整安装包，或在系统 PATH 安装 ffmpeg 后重试"
    );
  }
  const opts = normalizeSlideshowOptions(options);
  const draft = resolveDraft(input);
  const id = draftId(draft);
  const urls = slideshowImages(draft, opts.platform);
  if (urls.length < 2) {
    throw new HttpError(400, "图组转视频至少需要 2 张配图，请先在创作台生成配图");
  }
  const subtitles = slideshowSubtitles(draft, urls.length);
  const html = buildSlideshowHtml({
    width: opts.width,
    height: opts.height,
    transition: opts.transition,
    per: opts.per,
    safeTop: platformProfile(canvasPlatform(opts.canvas)).safe.top,
    safeBottom: platformProfile(canvasPlatform(opts.canvas)).safe.bottom,
    images: urls.map((url) => photoDataUrl(resolveMediaPath(url))),
    subtitles,
    brand: brandMeta().brand,
  });
  // 首末帧体检（fail fast，避免 600 帧渲染后才发现越界）
  const probes = await captureProbedFrames(html, { width: opts.width, height: opts.height, times: [0, urls.length * opts.per] });
  const safe = platformProfile(canvasPlatform(opts.canvas)).safe;
  for (const frame of probes) {
    const check = checkBlocks(frame.blocks, opts.width, opts.height, safe);
    if (check.warnings.length) {
      log.warn(`图组视频体检提示（${frame.t === 0 ? "首帧" : "末帧"}）：${check.warnings.join("；")}`);
    }
    if (check.errors.length) {
      throw new Error(
        `图组视频${frame.t === 0 ? "首帧" : "末帧"}体检未通过：${check.errors.slice(0, 3).join("；")}`
      );
    }
  }
  const duration = urls.length * opts.per;
  const frames = await captureFrames(html, {
    width: opts.width,
    height: opts.height,
    fps: opts.fps,
    duration,
    onFrame: (index, total) => {
      const step = Math.max(1, Math.floor(total / 10));
      if (index % step === 0) log.info(`图组视频渲染进度 ${index}/${total}`);
    },
  });
  if (frames.length < 2) throw new Error("图组视频渲染失败：有效帧不足");
  const outDir = path.join(ASSETS_DIR, `draft-${id}`, "slideshow");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "slideshow.mp4");
  if (!(await encodeVideo(frames, opts.fps, outFile, { width: opts.width, height: opts.height }))) {
    throw new Error("图组视频合成失败：ffmpeg 未产出 slideshow.mp4");
  }
  // M3-g：可选混入内置配乐（amix + loudnorm -14 LUFS）；混音失败保留无声视频。
  if (opts.bgm && opts.bgm !== "none") {
    const bgmPath = bgmFile(opts.bgm);
    if (bgmPath) {
      const mixed = path.join(outDir, "slideshow-mixed.mp4");
      if (await mixAudio(outFile, bgmPath, mixed)) {
        fs.rmSync(outFile, { force: true });
        fs.renameSync(mixed, outFile);
      } else {
        fs.rmSync(mixed, { force: true });
        log.warn("图组视频混音失败，保留无声视频");
      }
    }
  }
  try {
    const meta = {
      transition: opts.transition,
      canvas: opts.canvas,
      fps: opts.fps,
      per: opts.per,
      imageCount: urls.length,
      duration,
      frames: frames.length,
      bgm: opts.bgm || "none",
      created_at: new Date().toISOString(),
      generator: "m3",
    };
    fs.writeFileSync(path.join(outDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
  } catch (error) {
    log.warn(`图组视频 meta 写入失败: ${String(error)}`);
  }
  const result: SlideshowResult = {
    mp4: `/assets/draft-${id}/slideshow/slideshow.mp4`,
    duration,
    frames: frames.length,
    note: "",
  };
  saveSlideshow(id, draft, result, opts.canvas, opts.transition, opts.bgm || "none");
  return result;
}

/** 图组视频结果写回草稿 content_json.slideshow，前端媒体区可持久展示。 */
function saveSlideshow(id: number, draft: RenderDraft, result: SlideshowResult, canvas: string, transition: string, bgm: string): void {
  const current = draft.content_json;
  const content =
    current && typeof current === "object" && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};
  content.slideshow = {
    mp4: result.mp4,
    duration: result.duration,
    frames: result.frames,
    canvas,
    transition,
    bgm,
  };
  updateDraft(id, { content_json: content });
}
