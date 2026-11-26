/**
 * 配图/卡片/封面业务入口：草稿 → HTML → Electron 截图 → 写入 assets。
 *
 * 对应 Python 版的 /cards、/design-cards、/design/cover、/artwork-inline、/motion。
 * 所有图片落在 {@link ASSETS_DIR}/draft-{id}/ 下，返回 `/assets/...` 可访问路径。
 */
import fs from "node:fs";
import path from "node:path";
import { ASSETS_DIR, DESIGN_DIR } from "../core/config";
import { execute, queryAll, queryOne } from "../core/db";
import { log } from "../core/log";
import { normalizePlatform } from "../core/platform";
import { getSetting } from "../core/settings";
import { getDraft, updateDraft } from "../services/drafts";
import { captureHtml, captureHtmlWithProbe, checkBlocks, isRenderAvailable } from "./renderer";
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
import { customTemplateId, isCustomStyleKey, parseTemplateSchema, renderCustomDocument, type CustomTemplateDoc } from "./custom";
import { ALL_PLATFORMS, applyPlatformPolicy, platformCanvas, platformCanvasList, platformContentLimit, platformProfile } from "./kit";

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
  imageMeta?: ImageMeta[];
  style: string;
  palette: string;
  canvas: CanvasInfo;
  renderer: string;
}

/* M3-a：动效管线迁至 render/motion.ts（含 MotionInfo/MotionResult/MotionOptions 类型），
 * 这里保留薄转发，兼容既有 `from "./cards"` 引用。 */
export { renderMotion } from "./motion";
export type { MotionInfo, MotionResult, MotionOptions, NormalizedMotionOptions } from "./motion";

const RENDERER = "node-electron-html-v1";
const PORTRAIT: CanvasInfo = { key: "portrait", width: 1080, height: 1440, aspect: "3:4", label: "竖版图文" };
const WIDE: CanvasInfo = { key: "wide", width: 1080, height: 460, aspect: "2.35:1", label: "公众号宽幅封面" };
const INLINE: CanvasInfo = { key: "inline", width: 1080, height: 680, aspect: "27:17", label: "正文插画" };

function canvasCopy(base: CanvasInfo, width = base.width, height = base.height): CanvasInfo {
  const key = width > height * 1.5 ? "wide" : base.key === "inline" ? "inline" : "portrait";
  return { ...base, key, width, height };
}

/** 平台画布 → CanvasInfo（补 key/aspect/label，前端展示用）。 */
function canvasInfo(platform: string, size: { width: number; height: number }): CanvasInfo {
  const key = size.width > size.height * 1.5 ? "wide" : size.width === size.height ? "square" : "portrait";
  const label =
    key === "wide"
      ? "公众号宽幅封面"
      : key === "square"
        ? "公众号方图封面"
        : platform === "douyin"
          ? "抖音竖版 9:16"
          : "竖版图文 3:4";
  return { key, width: size.width, height: size.height, aspect: `${size.width}:${size.height}`, label };
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
  folder: string,
  canvasTag = ""
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
    const slug = `${canvasTag}${String(page.index).padStart(2, "0")}-${page.kind}`;
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
  const platform = normalizePlatform(options.platform || draft.platform || "xiaohongshu");
  const canvas = canvasInfo(platform, platformCanvas(platform));
  const style = normalizeCardStyle(options.style || getSetting("card_style", "paper"));
  const layout = normalizeLayout(options.layout || getSetting("card_layout", "balanced"));
  const palette = paletteFor(options, style);
  const brand = brandMeta(options);
  const pages = applyPlatformPolicy(
    limitPages(buildCardPages(draft, { layout, brand }), options.limit),
    platform
  );
  const images = await shootPages(
    pages,
    { style, palette, layout, brand, width: canvas.width, height: canvas.height, variant: options.variant },
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
    canvas: { ...canvas },
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
    // M1 出图 2.0 + M2.5 三端一次生成：未指定平台时三端齐出。
    const result = await renderV2Cards(draft, id, styleKey, options, options.platform ? platform : "all");
    const updated = updateDraft(id, { images: result.images });
    return { ...updated, ...result };
  }

  if (isSketchStyleKey(styleKey)) {
    // M2 手绘引擎：种子化构图 + 版式体检；variant 变化即「换一张」。
    const result = await renderSketchCards(draft, id, styleKey, options, options.platform ? platform : "all");
    const updated = updateDraft(id, { images: result.images });
    return { ...updated, ...result };
  }

  if (isCustomStyleKey(styleKey)) {
    // M3 自定义模板：编辑器 schema 直接出图；默认三端一次生成。
    const result = await renderCustomCards(draft, id, styleKey, options, options.platform ? platform : "all");
    const updated = updateDraft(id, { images: result.images });
    return { ...updated, ...result };
  }

  if (isArtStyle(styleKey)) {
    const images: string[] = [];
    const canvases = platformCanvasList(platform);
    let lastCanvas = canvasInfo(platform, canvases[0]);
    // 一稿多版：公众号横幅 + 方图；其余平台按平台画布。
    for (const canvas of canvases) {
      const html = renderArtworkDocument(draft, {
        style: styleKey,
        platform,
        scope: canvas.width > canvas.height ? "wide" : "portrait",
        width: canvas.width,
        height: canvas.height,
        brand,
        variant,
      });
      const slug = `${styleKey}-${canvas.width}x${canvas.height}.png`;
      images.push(writeAsset(id, `artwork/${slug}`, await captureHtml(html, canvas.width, canvas.height)));
      lastCanvas = canvasInfo(platform, canvas);
    }
    const updated = updateDraft(id, { images });
    return {
      ...updated,
      images,
      style: styleKey,
      template: { key: styleKey, name: artStyleName(styleKey) },
      palette: "",
      canvas: lastCanvas,
      platform,
      artwork: true,
      renderer: RENDERER,
    };
  }

  const normalized = normalizeCardStyle(styleKey);
  const palette = paletteFor(options, normalized);
  const layout = "balanced";
  let pages = applyPlatformPolicy(buildCardPages(draft, { layout, brand }), platform);
  if (platform === "wechat_mp") pages = pages.slice(0, 1);
  else pages = limitPages(pages, options.limit);
  const canvases = platformCanvasList(platform);
  const images: string[] = [];
  let lastCanvas = canvasInfo(platform, canvases[0]);
  for (const canvas of canvases) {
    const tag = canvases.length > 1 ? `${canvas.width}x${canvas.height}-` : "";
    images.push(
      ...(await shootPages(
        pages,
        { style: normalized, palette, layout, brand, width: canvas.width, height: canvas.height, variant },
        id,
        `designs/${normalized}`,
        tag
      ))
    );
    lastCanvas = canvasInfo(platform, canvas);
  }
  if (!images.length) throw new Error("设计卡片生成失败：没有可渲染的页面");
  const updated = updateDraft(id, { images });
  return {
    ...updated,
    images,
    style: normalized,
    template: { key: normalized, name: styleInfo(normalized).name },
    palette: palette.key,
    canvas: lastCanvas,
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
  const width = Math.max(320, Math.round(options.width || platformCanvas(platform).width));
  const height = Math.max(
    200,
    Math.round(options.height || platformCanvas(platform).height)
  );
  const source: RenderDraft = options.title ? { ...draft, title: options.title } : draft;
  const page = applyPlatformPolicy(
    buildCardPages(source, { layout: "sparse", brand, lead: options.subtitle }),
    platform
  )[0];
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

/* M3-a：renderMotion / encodeMotion 已迁至 render/motion.ts 与 render/ffmpeg.ts。 */

/* ------------------------------------------------------------------ M1 出图 2.0 */

/** 媒体元数据：前端按平台分组展示、标注用途（头图/封面/内容页/尾页/动图）。 */
export interface ImageMeta {
  url: string;
  platform: string;
  kind: string;
  label: string;
  width: number;
  height: number;
}

function metaLabel(platform: string, kind: string, canvas: { width: number; height: number }): string {
  const name = platformProfile(platform).name;
  if (kind === "motion") return `${name} · 动图`;
  if (canvas.width > canvas.height * 1.5) return `${name} · 头图`;
  if (canvas.width === canvas.height) return `${name} · 方图封面`;
  if (kind === "cover") return `${name} · 封面`;
  if (kind === "ending") return `${name} · 尾页`;
  return `${name} · 内容页`;
}

/** 张数策略：封面 + 内容页(≤上限) + 尾页，不把全部文字都摊成图。 */
function slimPages(pages: CardPage[], contentLimit: number): CardPage[] {
  const cover = pages.find((p) => p.kind === "cover");
  const content = pages.filter((p) => p.kind === "content").slice(0, contentLimit);
  const ending = pages.find((p) => p.kind === "ending");
  return [...(cover ? [cover] : []), ...content, ...(ending ? [ending] : [])];
}

/**
 * V2 引擎出图：默认一次覆盖三端（小红书 3:4 / 抖音 9:16 / 公众号横幅+方图），
 * platformScope 传具体平台时只出该端。逐页「渲染 → 探针体检 → 截图」，
 * errors 拦截整组，warnings 只记日志。最后附小红书封面 6 秒动图（置于首位）。
 */
async function renderV2Cards(
  draft: RenderDraft,
  id: number,
  styleKey: string,
  options: RenderOptions,
  platformScope: string
): Promise<CardRenderResult> {
  assertRenderable();
  const style = v2StyleInfo(styleKey);
  const layout = isV2LayoutKey(options.layout) ? String(options.layout).trim() : DEFAULT_V2_LAYOUT;
  const palette = V2_PALETTE_KEYS.includes(String(options.palette || "").trim())
    ? String(options.palette).trim()
    : DEFAULT_V2_PALETTE;
  const targets = platformScope === "all" ? [...ALL_PLATFORMS] : [normalizePlatform(platformScope)];
  const images: string[] = [];
  const imageMeta: ImageMeta[] = [];
  let lastCanvas = canvasInfo(targets[0], platformProfile(targets[0]).canvas);
  for (const platform of targets) {
    const profile = platformProfile(platform);
    let pages = applyPlatformPolicy(buildCardPages(draft, { layout: "balanced" }), platform);
    pages =
      platform === "wechat_mp"
        ? pages.slice(0, 1)
        : slimPages(limitPages(pages, options.limit), platformContentLimit(platform));
    // 一稿多版：公众号横幅 2.35:1 + 方图 1:1；其余平台单画布。
    for (const canvas of platformCanvasList(platform)) {
      for (const page of pages) {
        const html = renderV2Document(page, style.key, layout, palette, canvas.width, canvas.height, profile.safe);
        const { png, blocks } = await captureHtmlWithProbe(html, canvas.width, canvas.height);
        const check = checkBlocks(blocks, canvas.width, canvas.height, profile.safe);
        if (check.warnings.length) {
          log.warn(`版式体检提示（${style.key}/${page.kind}）：${check.warnings.join("；")}`);
        }
        if (check.errors.length) {
          throw new Error(
            `版式自检失败（${style.key} ${platform} 第 ${page.index} 页）：${check.errors.slice(0, 4).join("；")}`
          );
        }
        const slug = `${platform}-${layout}-${palette}-${canvas.width}x${canvas.height}-${String(page.index).padStart(2, "0")}-${page.kind}`;
        const url = writeAsset(id, `v2-${style.key}/${slug}.png`, png);
        images.push(url);
        imageMeta.push({
          url,
          platform,
          kind: page.kind,
          label: metaLabel(platform, page.kind, canvas),
          width: canvas.width,
          height: canvas.height,
        });
        lastCanvas = canvasInfo(platform, canvas);
      }
    }
  }
  if (!images.length) throw new Error("设计卡片生成失败：没有可渲染的页面");
  return {
    images,
    imageMeta,
    style: style.key,
    template: { key: style.key, name: style.name },
    layout,
    palette,
    canvas: lastCanvas,
    platform: targets.join(","),
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
 * 默认一次覆盖三端；文字层走与 V2 相同的探针体检。
 */
async function renderSketchCards(
  draft: RenderDraft,
  id: number,
  styleKey: string,
  options: RenderOptions,
  platformScope: string
): Promise<CardRenderResult> {
  assertRenderable();
  const style = sketchStyleInfo(styleKey);
  const variant = Math.max(0, Math.trunc(Number(options.variant) || 0));
  const seed = sketchSeed(id, variant);
  const targets = platformScope === "all" ? [...ALL_PLATFORMS] : [normalizePlatform(platformScope)];
  const images: string[] = [];
  const imageMeta: ImageMeta[] = [];
  let lastCanvas = canvasInfo(targets[0], platformProfile(targets[0]).canvas);
  for (const platform of targets) {
    const profile = platformProfile(platform);
    let pages = applyPlatformPolicy(buildCardPages(draft, { layout: "balanced" }), platform);
    pages =
      platform === "wechat_mp"
        ? pages.slice(0, 1)
        : slimPages(limitPages(pages, options.limit), platformContentLimit(platform));
    for (const canvas of platformCanvasList(platform)) {
      for (const page of pages) {
        const html = renderSketchDocument(page, style.key, seed, canvas.width, canvas.height, profile.safe);
        const { png, blocks } = await captureHtmlWithProbe(html, canvas.width, canvas.height);
        const check = checkBlocks(blocks, canvas.width, canvas.height, profile.safe);
        if (check.warnings.length) {
          log.warn(`版式体检提示（${style.key}/${page.kind}）：${check.warnings.join("；")}`);
        }
        if (check.errors.length) {
          throw new Error(
            `版式自检失败（${style.key} ${platform} 第 ${page.index} 页）：${check.errors.slice(0, 4).join("；")}`
          );
        }
        const slug = `${platform}-seed${seed}-${canvas.width}x${canvas.height}-${String(page.index).padStart(2, "0")}-${page.kind}`;
        const url = writeAsset(id, `sketch-${style.key}/${slug}.png`, png);
        images.push(url);
        imageMeta.push({
          url,
          platform,
          kind: page.kind,
          label: metaLabel(platform, page.kind, canvas),
          width: canvas.width,
          height: canvas.height,
        });
        lastCanvas = canvasInfo(platform, canvas);
      }
    }
  }
  if (!images.length) throw new Error("手绘配图生成失败：没有可渲染的页面");
  return {
    images,
    imageMeta,
    style: style.key,
    template: { key: style.key, name: style.name },
    layout: "sketch",
    palette: "",
    canvas: lastCanvas,
    platform: targets.join(","),
    seed,
    variant,
    renderer: RENDERER,
  };
}

/**
 * M3 自定义模板出图：结构仿 renderSketchCards，但 HTML 来自模板编辑器 schema。
 * 版式体检只记 warning 不拦截（用户构图重叠是有意的）；模板缺页时渲染器内部兜底。
 */
async function renderCustomCards(
  draft: RenderDraft,
  id: number,
  styleKey: string,
  options: RenderOptions,
  platformScope: string
): Promise<CardRenderResult> {
  assertRenderable();
  const tplId = customTemplateId(styleKey);
  const row = queryOne<{ id: number; name: string; schema: string; preview?: string }>(
    "SELECT id, name, schema, preview FROM custom_templates WHERE id = ?",
    tplId
  );
  if (!row) throw new Error(`自定义模板不存在（已被删除？）: ${tplId}`);
  const tpl: CustomTemplateDoc | null = parseTemplateSchema(row);
  if (!tpl) throw new Error(`自定义模板「${row.name}」数据损坏，无法出图`);
  const targets = platformScope === "all" ? [...ALL_PLATFORMS] : [normalizePlatform(platformScope)];
  const images: string[] = [];
  const imageMeta: ImageMeta[] = [];
  let lastCanvas = canvasInfo(targets[0], platformProfile(targets[0]).canvas);
  for (const platform of targets) {
    const profile = platformProfile(platform);
    let pages = applyPlatformPolicy(buildCardPages(draft, { layout: "balanced" }), platform);
    pages =
      platform === "wechat_mp"
        ? pages.slice(0, 1)
        : slimPages(limitPages(pages, options.limit), platformContentLimit(platform));
    for (const canvas of platformCanvasList(platform)) {
      for (const page of pages) {
        const html = renderCustomDocument(page, tpl, canvas.width, canvas.height);
        const { png, blocks } = await captureHtmlWithProbe(html, canvas.width, canvas.height);
        const check = checkBlocks(blocks, canvas.width, canvas.height, profile.safe);
        if (check.warnings.length) {
          log.warn(`自定义模板体检提示（${tpl.name}/${page.kind}）：${check.warnings.join("；")}`);
        }
        // 有意不因 errors 抛错：自定义布局的重叠/留白由用户负责，越界元素已 clamp 进画布。
        const slug = `${platform}-${canvas.width}x${canvas.height}-${String(page.index).padStart(2, "0")}-${page.kind}`;
        const url = writeAsset(id, `custom-${tpl.id}/${slug}.png`, png);
        images.push(url);
        imageMeta.push({
          url,
          platform,
          kind: page.kind,
          label: metaLabel(platform, page.kind, canvas),
          width: canvas.width,
          height: canvas.height,
        });
        lastCanvas = canvasInfo(platform, canvas);
      }
    }
  }
  if (!images.length) throw new Error("自定义模板出图失败：没有可渲染的页面");
  return {
    images,
    imageMeta,
    style: styleKey,
    template: { key: styleKey, name: tpl.name },
    layout: "custom",
    palette: "",
    canvas: lastCanvas,
    platform: targets.join(","),
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
  const result = await renderV2Cards(draft, id, styleKey, options, options.platform ? platform : "all");
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
  const pageKinds: Array<{ kind: CardPage["kind"]; label: string }> = [
    { kind: "cover", label: "封面" },
    { kind: "content", label: "内容页" },
    { kind: "ending", label: "末页" },
  ];
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
  // 三页样张：模板编辑器按页型预览用，与真实出图同源（内容/末页取 stack 版式）。
  for (const style of V2_STYLES) {
    for (const { kind, label } of pageKinds) {
      const page = pages.find((p) => p.kind === kind) || pages[0];
      const key = `${style.key}-page-${kind}`;
      const file = path.join(dir, `${key}.png`);
      if (force || !fs.existsSync(file)) {
        try {
          const html = renderV2Document(
            page,
            style.key,
            "stack",
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
          layout: `page-${kind}`,
          layout_name: label,
          colors: style.colors,
          url: `/designs/samples/${key}.png`,
        });
      }
    }
  }
  // M2 手绘风格样张：封面 / 内容 / 末页各一张，与真实出图同源（固定种子）。
  for (const style of SKETCH_STYLES) {
    for (const { kind, label } of pageKinds) {
      const page = pages.find((p) => p.kind === kind) || pages[0];
      const key = `${style.key}-${kind}`;
      const file = path.join(dir, `${key}.png`);
      const artFile = path.join(dir, `${key}-art.png`);
      /* 模板编辑器底图：只保留插画层（隐藏文字面板），保证可编辑版与样张同一张图 */
      if (force || !fs.existsSync(artFile)) {
        try {
          const artHtml = renderSketchDocument(
            applyPlatformPolicy([page], "xiaohongshu")[0],
            style.key,
            42,
            PORTRAIT.width,
            PORTRAIT.height,
            { top: 0, bottom: 0 },
            false,
            6,
            "fade-seq",
            true
          );
          const artPng = await captureHtml(artHtml, PORTRAIT.width, PORTRAIT.height);
          fs.writeFileSync(artFile, artPng);
        } catch (error) {
          log.warn(`手绘底图生成失败 ${key}: ${String(error)}`);
        }
      }
      if (force || !fs.existsSync(file)) {
        try {
          const html = renderSketchDocument(
            applyPlatformPolicy([page], "xiaohongshu")[0],
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
          layout: kind,
          layout_name: `手绘 · ${label}`,
          colors: style.colors,
          url: `/designs/samples/${key}.png`,
        });
      }
    }
  }
  return out;
}
