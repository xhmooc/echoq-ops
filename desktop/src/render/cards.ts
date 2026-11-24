/**
 * 配图/卡片/封面业务入口：草稿 → HTML → Electron 截图 → 写入 assets。
 *
 * 对应 Python 版的 /cards、/design-cards、/design/cover、/artwork-inline、/motion。
 * 所有图片落在 {@link ASSETS_DIR}/draft-{id}/ 下，返回 `/assets/...` 可访问路径。
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { ASSETS_DIR, DESIGN_DIR, TMP_DIR } from "../core/config";
import { execute, queryAll } from "../core/db";
import { log } from "../core/log";
import { normalizePlatform } from "../core/platform";
import { getSetting } from "../core/settings";
import { getDraft, updateDraft } from "../services/drafts";
import { captureFrames, captureHtml, captureHtmlWithProbe, checkBlocks, isRenderAvailable } from "./renderer";
import {
  artStyleName,
  buildCardPages,
  DEFAULT_ART_STYLE,
  isArtStyle,
  normalizeCardStyle,
  normalizeLayout,
  renderArtworkDocument,
  renderCardDocument,
  resolvePalette,
  styleInfo,
  type BrandMeta,
  type CardPage,
  type CardPalette,
  type CardStyleKey,
} from "./templates";
import {
  DEFAULT_V2_LAYOUT,
  DEFAULT_V2_PALETTE,
  DEFAULT_V2_STYLE,
  isV2LayoutKey,
  isV2StyleKey,
  renderV2Document,
  v2StyleInfo,
  V2_LAYOUTS,
  V2_PALETTE_KEYS,
  V2_STYLES,
} from "./v2templates";
import {
  isSketchStyleKey,
  renderSketchDocument,
  sketchSeed,
  sketchStyleInfo,
  SKETCH_STYLES,
} from "./sketch";

export type RenderDraft = Record<string, unknown>;
export type DraftInput = RenderDraft | number;

export interface RenderOptions {
  style?: string;
  layout?: string;
  palette?: string;
  platform?: string;
  limit?: number;
  variant?: number;
  width?: number;
  height?: number;
  brand?: string;
  column?: string;
  issue?: string;
  themeColor?: string;
}

export interface CoverOptions extends RenderOptions {
  title?: string;
  subtitle?: string;
}

export interface CanvasInfo {
  key: string;
  width: number;
  height: number;
  aspect: string;
  label: string;
}

export interface CardRenderResult extends Record<string, unknown> {
  images: string[];
  style: string;
  palette: string;
  canvas: CanvasInfo;
  renderer: string;
}

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

const RENDERER = "node-electron-html-v1";
const PORTRAIT: CanvasInfo = { key: "portrait", width: 1080, height: 1440, aspect: "3:4", label: "竖版图文" };
const WIDE: CanvasInfo = { key: "wide", width: 1080, height: 460, aspect: "2.35:1", label: "公众号宽幅封面" };
const INLINE: CanvasInfo = { key: "inline", width: 1080, height: 680, aspect: "27:17", label: "正文插画" };

function canvasCopy(base: CanvasInfo, width = base.width, height = base.height): CanvasInfo {
  const key = width > height * 1.5 ? "wide" : base.key === "inline" ? "inline" : "portrait";
  return { ...base, key, width, height };
}

function assertRenderable(): void {
  if (!isRenderAvailable()) {
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

function brandMeta(options: RenderOptions): BrandMeta {
  return {
    brand: options.brand || getSetting("card_brand", "应声面试"),
    column: options.column || getSetting("card_column", "面试避坑"),
    issue: options.issue || getSetting("card_issue", "07"),
  };
}

function paletteFor(options: RenderOptions, style: CardStyleKey): CardPalette {
  const explicit = options.palette ?? getSetting("card_palette", "");
  const theme = getSetting("card_theme", "warm");
  const accent = options.themeColor || getSetting("theme_color", "");
  return resolvePalette(String(explicit || theme || ""), style, accent);
}

function limitPages(pages: CardPage[], limit?: number): CardPage[] {
  if (!limit || !Number.isFinite(limit) || limit <= 0) return pages;
  return pages.slice(0, Math.max(1, Math.min(18, Math.trunc(limit))));
}

/** 把图片写到 assets/draft-{id}/ 下，返回前端可直接使用的 /assets 路径。 */
function writeAsset(ownerId: number, relative: string, data: Buffer): string {
  const clean = relative.replace(/\\/g, "/").replace(/^\/+/, "");
  const target = path.join(ASSETS_DIR, `draft-${ownerId}`, ...clean.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
  return `/assets/draft-${ownerId}/${clean}`;
}

interface PageShotOptions {
  style: string;
  palette: CardPalette;
  layout: string;
  brand: BrandMeta;
  width: number;
  height: number;
  variant?: number;
  motion?: boolean;
}

async function shootPages(
  pages: CardPage[],
  shots: PageShotOptions,
  ownerId: number,
  folder: string
): Promise<string[]> {
  const urls: string[] = [];
  for (const page of pages) {
    const html = renderCardDocument(page, {
      style: shots.style,
      palette: shots.palette,
      layout: shots.layout,
      brand: shots.brand,
      width: shots.width,
      height: shots.height,
      variant: shots.variant,
      motion: shots.motion,
    });
    const buffer = await captureHtml(html, shots.width, shots.height);
    const slug = `${String(page.index).padStart(2, "0")}-${page.kind}`;
    urls.push(writeAsset(ownerId, `${folder}/${slug}.png`, buffer));
  }
  return urls;
}

/**
 * `/api/drafts/:id/cards`：按 style/layout/palette 生成整套 1080×1440 配图并写回草稿。
 */
export async function renderDraftCards(
  input: DraftInput,
  options: RenderOptions = {}
): Promise<CardRenderResult> {
  assertRenderable();
  const draft = resolveDraft(input);
  const id = draftId(draft);
  const style = normalizeCardStyle(options.style || getSetting("card_style", "paper"));
  const layout = normalizeLayout(options.layout || getSetting("card_layout", "balanced"));
  const palette = paletteFor(options, style);
  const brand = brandMeta(options);
  const pages = limitPages(buildCardPages(draft, { layout, brand }), options.limit);
  const images = await shootPages(
    pages,
    { style, palette, layout, brand, width: PORTRAIT.width, height: PORTRAIT.height, variant: options.variant },
    id,
    "cards"
  );
  if (!images.length) throw new Error("配图生成失败：没有可渲染的页面");
  const updated = updateDraft(id, { images });
  return {
    ...updated,
    images,
    style,
    layout,
    palette: palette.key,
    canvas: { ...PORTRAIT },
    renderer: RENDERER,
  };
}

/**
 * `/api/drafts/:id/design-cards`：设计模板出图；公众号只出 1 张 2.35:1 封面，
 * 其它平台出 3:4 竖版多页。art-* 风格走程序化插画。
 */
export async function renderDesignCards(
  input: DraftInput,
  style?: string | RenderOptions,
  extra: RenderOptions = {}
): Promise<CardRenderResult> {
  assertRenderable();
  const options: RenderOptions =
    style && typeof style === "object" ? { ...style } : { ...extra, style: style || extra.style };
  const draft = resolveDraft(input);
  const id = draftId(draft);
  const platform = normalizePlatform(options.platform || draft.platform || "xiaohongshu");
  const styleKey = String(options.style || "paper").trim() || "paper";
  const brand = brandMeta(options);
  const variant = options.variant;

  if (isV2StyleKey(styleKey)) {
    // M1 出图 2.0：V2 引擎（风格 × 版式 × 调色板），带版式体检。
    const result = await renderV2Cards(draft, id, styleKey, options, platform);
    const updated = updateDraft(id, { images: result.images });
    return { ...updated, ...result };
  }

  if (isSketchStyleKey(styleKey)) {
    // M2 手绘引擎：种子化构图 + 版式体检；variant 变化即「换一张」。
    const result = await renderSketchCards(draft, id, styleKey, options, platform);
    const updated = updateDraft(id, { images: result.images });
    return { ...updated, ...result };
  }

  if (isArtStyle(styleKey)) {
    const canvas = platform === "wechat_mp" ? { ...WIDE } : { ...PORTRAIT };
    const html = renderArtworkDocument(draft, {
      style: styleKey,
      platform,
      scope: platform === "wechat_mp" ? "wide" : "portrait",
      width: canvas.width,
      height: canvas.height,
      brand,
      variant,
    });
    const url = writeAsset(id, `artwork/${styleKey}.png`, await captureHtml(html, canvas.width, canvas.height));
    const updated = updateDraft(id, { images: [url] });
    return {
      ...updated,
      images: [url],
      style: styleKey,
      template: { key: styleKey, name: artStyleName(styleKey) },
      palette: "",
      canvas,
      platform,
      artwork: true,
      renderer: RENDERER,
    };
  }

  const normalized = normalizeCardStyle(styleKey);
  const palette = paletteFor(options, normalized);
  const layout = "balanced";
  let pages = buildCardPages(draft, { layout, brand });
  if (platform === "wechat_mp") pages = pages.slice(0, 1);
  else pages = limitPages(pages, options.limit);
  const canvas = platform === "wechat_mp" ? { ...WIDE } : { ...PORTRAIT };
  const images = await shootPages(
    pages,
    { style: normalized, palette, layout, brand, width: canvas.width, height: canvas.height, variant },
    id,
    `designs/${normalized}`
  );
  if (!images.length) throw new Error("设计卡片生成失败：没有可渲染的页面");
  const updated = updateDraft(id, { images });
  return {
    ...updated,
    images,
    style: normalized,
    template: { key: normalized, name: styleInfo(normalized).name },
    palette: palette.key,
    canvas,
    platform,
    renderer: RENDERER,
  };
}

/**
 * `/api/design/cover`：只出一张封面。平台为公众号时 1080×460，其余 1080×1440。
 */
export async function renderCover(
  input: DraftInput,
  options: CoverOptions = {}
): Promise<CardRenderResult> {
  assertRenderable();
  const draft = resolveDraft(input);
  const id = draftId(draft);
  const platform = normalizePlatform(options.platform || draft.platform || "xiaohongshu");
  const style = normalizeCardStyle(options.style || getSetting("card_style", "paper"));
  const palette = paletteFor(options, style);
  const brand = brandMeta(options);
  const width = Math.max(320, Math.round(options.width || PORTRAIT.width));
  const height = Math.max(
    200,
    Math.round(options.height || (platform === "wechat_mp" ? WIDE.height : PORTRAIT.height))
  );
  const source: RenderDraft = options.title ? { ...draft, title: options.title } : draft;
  const page = buildCardPages(source, { layout: "sparse", brand, lead: options.subtitle })[0];
  const html = renderCardDocument(page, {
    style,
    palette,
    layout: "sparse",
    brand,
    width,
    height,
    variant: options.variant,
  });
  const url = writeAsset(id, "cover/cover.png", await captureHtml(html, width, height));
  return {
    ...draft,
    images: [url],
    image: url,
    cover: url,
    style,
    palette: palette.key,
    canvas: canvasCopy(platform === "wechat_mp" ? WIDE : PORTRAIT, width, height),
    platform,
    renderer: RENDERER,
  };
}

/**
 * `/api/drafts/:id/artwork-inline`：生成一张 1080×680 正文插画，返回可插入路径。
 */
export async function renderArtworkInline(
  input: DraftInput,
  options: RenderOptions = {}
): Promise<CardRenderResult> {
  assertRenderable();
  const draft = resolveDraft(input);
  const id = draftId(draft);
  const style = isArtStyle(options.style) ? String(options.style) : DEFAULT_ART_STYLE;
  const platform = normalizePlatform(options.platform || draft.platform || "xiaohongshu");
  const brand = brandMeta(options);
  const html = renderArtworkDocument(draft, {
    style,
    platform,
    scope: "inline",
    width: INLINE.width,
    height: INLINE.height,
    brand,
    variant: options.variant,
  });
  const url = writeAsset(
    id,
    "artwork-inline/01-inline.png",
    await captureHtml(html, INLINE.width, INLINE.height)
  );
  return {
    ...draft,
    paths: [url],
    images: [url],
    style,
    palette: "",
    canvas: { ...INLINE },
    platform,
    renderer: RENDERER,
  };
}

const execFileAsync = promisify(execFile);

/**
 * `/api/drafts/:id/motion`：真动图。逐帧渲染（6s × 25fps，__seek 确定性契约）
 * → ffmpeg 合成 loop.gif（15fps/540 宽/两阶段调色板）+ motion.mp4（810×1080 H.264）。
 * 渲染或合成失败时回退静态首帧，不阻塞流程。
 */
export async function renderMotion(input: DraftInput): Promise<MotionResult> {
  assertRenderable();
  const draft = resolveDraft(input);
  const id = draftId(draft);
  const style = normalizeCardStyle(getSetting("card_style", "paper"));
  const palette = paletteFor({}, style);
  const brand = brandMeta({});
  const page = buildCardPages(draft, { layout: "sparse", brand })[0];
  const html = renderCardDocument(page, {
    style,
    palette,
    layout: "sparse",
    brand,
    width: PORTRAIT.width,
    height: PORTRAIT.height,
    motion: true,
  });
  const FPS = 25;
  const DURATION = 6;
  const times: number[] = [];
  for (let i = 0; i <= FPS * DURATION; i += 1) times.push(i / FPS);
  let frames: Buffer[] = [];
  try {
    frames = await captureFrames(html, PORTRAIT.width, PORTRAIT.height, times);
  } catch (error) {
    log.warn(`动效逐帧渲染失败，回退静态首帧: ${String(error)}`);
  }
  const motionDir = path.join(ASSETS_DIR, `draft-${id}`, "motion");
  fs.mkdirSync(motionDir, { recursive: true });
  if (frames.length >= 2 && (await encodeMotion(frames, FPS, motionDir))) {
    fs.writeFileSync(path.join(motionDir, "01-cover.png"), frames[0]);
    const motion: MotionInfo = {
      gif: `/assets/draft-${id}/motion/loop.gif`,
      mp4: `/assets/draft-${id}/motion/motion.mp4`,
      still: `/assets/draft-${id}/motion/01-cover.png`,
      static: false,
      note: "",
    };
    saveMotion(id, draft, motion);
    return { motion, draft_id: id, images: [motion.gif] };
  }
  const url = writeAsset(
    id,
    "motion/01-cover-still.png",
    frames[0] || (await captureHtml(html, PORTRAIT.width, PORTRAIT.height))
  );
  const motion: MotionInfo = {
    gif: url,
    mp4: "",
    still: url,
    static: true,
    note: "动效合成失败（本机缺少 ffmpeg 或逐帧渲染失败），已回退为静态首帧",
  };
  saveMotion(id, draft, motion);
  return { motion, draft_id: id, images: [url] };
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

/** ffmpeg 合成动图；任一产物缺失视为失败（调用方回退静态图）。 */
async function encodeMotion(frames: Buffer[], fps: number, outDir: string): Promise<boolean> {
  const frameDir = path.join(TMP_DIR, `motion-${process.pid}-${Date.now()}`);
  try {
    fs.mkdirSync(frameDir, { recursive: true });
    frames.forEach((png, index) =>
      fs.writeFileSync(path.join(frameDir, `f-${String(index).padStart(4, "0")}.png`), png)
    );
    await execFileAsync("ffmpeg", [
      "-y", "-framerate", String(fps), "-i", path.join(frameDir, "f-%04d.png"),
      "-vf",
      "fps=15,scale=540:-2:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle",
      path.join(outDir, "loop.gif"),
    ]);
    await execFileAsync("ffmpeg", [
      "-y", "-framerate", String(fps), "-i", path.join(frameDir, "f-%04d.png"),
      "-vf", "scale=810:1080", "-c:v", "libx264", "-pix_fmt", "yuv420p",
      "-crf", "18", "-preset", "medium", "-movflags", "+faststart",
      path.join(outDir, "motion.mp4"),
    ]);
    return (
      fs.existsSync(path.join(outDir, "loop.gif")) &&
      fs.existsSync(path.join(outDir, "motion.mp4"))
    );
  } catch (error) {
    log.warn(`ffmpeg 合成动图失败: ${String(error)}`);
    return false;
  } finally {
    try {
      fs.rmSync(frameDir, { recursive: true, force: true });
    } catch {
      /* 临时帧目录清理失败不影响结果 */
    }
  }
}

/* ------------------------------------------------------------------ M1 出图 2.0 */

/**
 * V2 引擎单套出图：6 风格 × 4 版式 × 3 调色板，逐页「渲染 → 探针体检 → 截图」。
 * errors 拦截整组（抛错），warnings 只记日志（告警观察模式）。
 * 不回写草稿——候选模式与正式模式都由调用方决定是否 updateDraft。
 */
async function renderV2Cards(
  draft: RenderDraft,
  id: number,
  styleKey: string,
  options: RenderOptions,
  platform: string
): Promise<CardRenderResult> {
  assertRenderable();
  const style = v2StyleInfo(styleKey);
  const layout = isV2LayoutKey(options.layout) ? String(options.layout).trim() : DEFAULT_V2_LAYOUT;
  const palette = V2_PALETTE_KEYS.includes(String(options.palette || "").trim())
    ? String(options.palette).trim()
    : DEFAULT_V2_PALETTE;
  const canvas = platform === "wechat_mp" ? { ...WIDE } : { ...PORTRAIT };
  let pages = buildCardPages(draft, { layout: "balanced" });
  if (platform === "wechat_mp") pages = pages.slice(0, 1);
  else pages = limitPages(pages, options.limit);
  const images: string[] = [];
  for (const page of pages) {
    const html = renderV2Document(page, style.key, layout, palette, canvas.width, canvas.height);
    const { png, blocks } = await captureHtmlWithProbe(html, canvas.width, canvas.height);
    const check = checkBlocks(blocks, canvas.width, canvas.height);
    if (check.warnings.length) {
      log.warn(`版式体检提示（${style.key}/${page.kind}）：${check.warnings.join("；")}`);
    }
    if (check.errors.length) {
      throw new Error(
        `版式自检失败（${style.key} 第 ${page.index}/${pages.length} 页）：${check.errors.slice(0, 4).join("；")}`
      );
    }
    const slug = `${layout}-${palette}-${String(page.index).padStart(2, "0")}-${page.kind}`;
    images.push(writeAsset(id, `v2-${style.key}/${slug}.png`, png));
  }
  if (!images.length) throw new Error("设计卡片生成失败：没有可渲染的页面");
  return {
    images,
    style: style.key,
    template: { key: style.key, name: style.name },
    layout,
    palette,
    canvas,
    platform,
    renderer: RENDERER,
  };
}

export interface DesignCandidate {
  style: string;
  name: string;
  tagline: string;
  temperature: string;
  layout: string;
  palette: string;
  images: string[];
}

/**
 * M2 手绘引擎出图：固定「插画 + 文字面板」构图，种子决定画面细节。
 * 同（草稿, variant）逐像素一致；variant +1 即「换一张构图」。
 * 文字层走与 V2 相同的探针体检：errors 拦截、warnings 记日志。
 */
async function renderSketchCards(
  draft: RenderDraft,
  id: number,
  styleKey: string,
  options: RenderOptions,
  platform: string
): Promise<CardRenderResult> {
  assertRenderable();
  const style = sketchStyleInfo(styleKey);
  const variant = Math.max(0, Math.trunc(Number(options.variant) || 0));
  const seed = sketchSeed(id, variant);
  const canvas = platform === "wechat_mp" ? { ...WIDE } : { ...PORTRAIT };
  let pages = buildCardPages(draft, { layout: "balanced" });
  if (platform === "wechat_mp") pages = pages.slice(0, 1);
  else pages = limitPages(pages, options.limit);
  const images: string[] = [];
  for (const page of pages) {
    const html = renderSketchDocument(page, style.key, seed, canvas.width, canvas.height);
    const { png, blocks } = await captureHtmlWithProbe(html, canvas.width, canvas.height);
    const check = checkBlocks(blocks, canvas.width, canvas.height);
    if (check.warnings.length) {
      log.warn(`版式体检提示（${style.key}/${page.kind}）：${check.warnings.join("；")}`);
    }
    if (check.errors.length) {
      throw new Error(
        `版式自检失败（${style.key} 第 ${page.index}/${pages.length} 页）：${check.errors.slice(0, 4).join("；")}`
      );
    }
    const slug = `seed${seed}-${String(page.index).padStart(2, "0")}-${page.kind}`;
    images.push(writeAsset(id, `sketch-${style.key}/${slug}.png`, png));
  }
  if (!images.length) throw new Error("手绘配图生成失败：没有可渲染的页面");
  return {
    images,
    style: style.key,
    template: { key: style.key, name: style.name },
    layout: "sketch",
    palette: "",
    canvas,
    platform,
    seed,
    variant,
    renderer: RENDERER,
  };
}

/**
 * M1 1.4 多候选：一次出 N 套「风格 × 版式」候选（风格互异、版式互异）。
 * 参考外观账本：近期用过的风格降权，连续两次同风格强制回避。
 * 不改动草稿配图，等用户点选 selectDesignCandidate 后才落正式。
 */
export async function renderDesignCandidates(
  input: DraftInput,
  options: RenderOptions = {},
  count: number = 3
): Promise<{ candidates: DesignCandidate[] }> {
  assertRenderable();
  const draft = resolveDraft(input);
  const id = draftId(draft);
  const platform = normalizePlatform(options.platform || draft.platform || "xiaohongshu");
  const wanted = Math.max(2, Math.min(4, Math.trunc(Number(count) || 3)));
  const recent = ledgerRecent(draft.account_id);
  const recentStyles = recent.map((row) => String(row.style || ""));
  // 轻量可复现随机：同草稿多次请求顺序稳定，便于测试与回放。
  let seed = (Math.trunc(Number(draft.id) || 1) * 2654435761) >>> 0;
  const rand = (): number => {
    seed = (Math.imul(seed || 1, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const combos: Array<{ style: string; layout: string; score: number }> = [];
  for (const style of V2_STYLES) {
    for (const layout of V2_LAYOUTS) {
      let score = rand();
      if (recentStyles.includes(style.key)) score -= 4;
      if (
        recentStyles.length >= 2 &&
        recentStyles[0] === style.key &&
        recentStyles[1] === style.key
      ) {
        score -= 100;
      }
      combos.push({ style: style.key, layout: layout.key, score });
    }
  }
  combos.sort((a, b) => b.score - a.score);
  const chosen: Array<{ style: string; layout: string }> = [];
  const usedStyles = new Set<string>();
  const usedLayouts = new Set<string>();
  for (const combo of combos) {
    if (usedStyles.has(combo.style) || usedLayouts.has(combo.layout)) continue;
    chosen.push({ style: combo.style, layout: combo.layout });
    usedStyles.add(combo.style);
    usedLayouts.add(combo.layout);
    if (chosen.length >= wanted) break;
  }
  const candidates: DesignCandidate[] = [];
  for (const combo of chosen) {
    const style = v2StyleInfo(combo.style);
    const result = await renderV2Cards(
      draft,
      id,
      combo.style,
      { ...options, layout: combo.layout, palette: DEFAULT_V2_PALETTE },
      platform
    );
    candidates.push({
      style: style.key,
      name: style.name,
      tagline: style.tagline,
      temperature: style.temperature,
      layout: combo.layout,
      palette: DEFAULT_V2_PALETTE,
      images: result.images,
    });
  }
  return { candidates };
}

/**
 * M1 1.4 点选候选：按同参数重渲染（命中同一批文件）并记入外观账本，
 * 然后把该组图片设为草稿正式配图。
 */
export async function selectDesignCandidate(
  input: DraftInput,
  options: RenderOptions = {}
): Promise<CardRenderResult> {
  const draft = resolveDraft(input);
  const id = draftId(draft);
  const platform = normalizePlatform(options.platform || draft.platform || "xiaohongshu");
  const styleKey = String(options.style || "").trim() || DEFAULT_V2_STYLE;
  const result = await renderV2Cards(draft, id, styleKey, options, platform);
  ledgerRecord(
    id,
    draft.account_id,
    platform,
    styleKey,
    result.layout as string,
    String(result.palette)
  );
  const updated = updateDraft(id, { images: result.images });
  return { ...updated, ...result };
}

/* ------------------------------ 外观账本（M1 1.6） ----------------------------- */

interface LedgerRow {
  style: string;
  layout: string;
  palette: string;
}

export function ledgerRecord(
  draftId: number,
  accountId: unknown,
  platform: string,
  style: string,
  layout: string,
  palette: string
): void {
  try {
    const account = Number(accountId);
    execute(
      "INSERT INTO design_ledger(account_id, draft_id, platform, style, layout, palette, created_at) VALUES(?,?,?,?,?,?,?)",
      Number.isFinite(account) && account > 0 ? Math.trunc(account) : null,
      Math.trunc(Number(draftId) || 0),
      String(platform || ""),
      String(style || ""),
      String(layout || ""),
      String(palette || ""),
      Math.floor(Date.now() / 1000)
    );
  } catch (error) {
    log.warn(`外观账本写入失败: ${String(error)}`);
  }
}

export function ledgerRecent(accountId: unknown, n: number = 8): LedgerRow[] {
  const account = Number(accountId);
  if (!Number.isFinite(account) || account <= 0) return [];
  try {
    return queryAll<LedgerRow>(
      "SELECT style, layout, palette FROM design_ledger WHERE account_id = ? ORDER BY created_at DESC LIMIT ?",
      Math.trunc(account),
      Math.max(1, Math.trunc(n))
    );
  } catch (error) {
    log.warn(`外观账本读取失败: ${String(error)}`);
    return [];
  }
}

/* ------------------------------ 样张预览（M1 1.3） ----------------------------- */

const SAMPLE_DRAFT: RenderDraft = {
  id: 0,
  title: "3 个让笔记更清晰的方法",
  desc: [
    "排版比文笔更影响完读率，这 3 个方法今天就能用",
    "✨ 大标题只说一件事",
    "✅ 一眼就知道这篇讲什么",
    "✅ 不贪多，一页一个重点",
    "✨ 每页最多三个要点",
    "✅ 超过三个就拆页",
    "✅ 条目控制在两行以内",
    "✨ 留白也是信息",
    "✅ 密的地方读者会跳过",
    "🔍 结尾",
    "你最想先试哪一个？",
  ].join("\n"),
};

/**
 * M1 1.3 样张：每个 V2 风格 × 版式渲染一张 405×540 缩略图（懒加载、落盘缓存）。
 * 样张内容固定，不需要体检；单张失败跳过，前端用色块占位。
 */
export async function ensureDesignSamples(
  force: boolean = false
): Promise<Array<Record<string, unknown>>> {
  assertRenderable();
  const dir = path.join(DESIGN_DIR, "samples");
  fs.mkdirSync(dir, { recursive: true });
  const pages = buildCardPages(SAMPLE_DRAFT, { layout: "balanced" });
  const samplePage = (layout: string): CardPage =>
    layout === "hero" || layout === "stack" ? pages[0] : pages[1] || pages[0];
  const out: Array<Record<string, unknown>> = [];
  for (const style of V2_STYLES) {
    for (const layout of V2_LAYOUTS) {
      const key = `${style.key}-${layout.key}`;
      const file = path.join(dir, `${key}.png`);
      if (force || !fs.existsSync(file)) {
        try {
          const html = renderV2Document(
            samplePage(layout.key),
            style.key,
            layout.key,
            DEFAULT_V2_PALETTE,
            PORTRAIT.width,
            PORTRAIT.height
          );
          const png = await captureHtml(html, PORTRAIT.width, PORTRAIT.height);
          fs.writeFileSync(file, png);
        } catch (error) {
          log.warn(`样张生成失败 ${key}: ${String(error)}`);
        }
      }
      if (fs.existsSync(file)) {
        out.push({
          style: style.key,
          name: style.name,
          tagline: style.tagline,
          fit: style.fit,
          temperature: style.temperature,
          layout: layout.key,
          layout_name: layout.name,
          colors: style.colors,
          url: `/designs/samples/${key}.png`,
        });
      }
    }
  }
  // M2 手绘风格样张：每风格一张封面样张（固定种子，展示构图观感）。
  for (const style of SKETCH_STYLES) {
    const key = `${style.key}-cover`;
    const file = path.join(dir, `${key}.png`);
    if (force || !fs.existsSync(file)) {
      try {
        const html = renderSketchDocument(
          pages[0],
          style.key,
          42,
          PORTRAIT.width,
          PORTRAIT.height
        );
        const png = await captureHtml(html, PORTRAIT.width, PORTRAIT.height);
        fs.writeFileSync(file, png);
      } catch (error) {
        log.warn(`样张生成失败 ${key}: ${String(error)}`);
      }
    }
    if (fs.existsSync(file)) {
      out.push({
        style: style.key,
        name: style.name,
        tagline: style.tagline,
        fit: style.fit,
        temperature: style.temperature,
        layout: "cover",
        layout_name: "手绘构图",
        colors: style.colors,
        url: `/designs/samples/${key}.png`,
      });
    }
  }
  return out;
}
