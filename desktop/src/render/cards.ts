/**
 * 配图/卡片/封面业务入口：草稿 → HTML → Electron 截图 → 写入 assets。
 *
 * 对应 Python 版的 /cards、/design-cards、/design/cover、/artwork-inline、/motion。
 * 所有图片落在 {@link ASSETS_DIR}/draft-{id}/ 下，返回 `/assets/...` 可访问路径。
 */
import fs from "node:fs";
import path from "node:path";
import { ASSETS_DIR } from "../core/config";
import { normalizePlatform } from "../core/platform";
import { getSetting } from "../core/settings";
import { getDraft, updateDraft } from "../services/drafts";
import { captureHtml, isRenderAvailable } from "./renderer";
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
  static: true;
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

/**
 * `/api/drafts/:id/motion`：Node 版动效暂只输出静态首帧 PNG，返回路径仍放在
 * motion.gif / motion.still，前端可直接打开；后续可用 Electron 录帧替换。
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
  const url = writeAsset(
    id,
    "motion/01-cover-still.png",
    await captureHtml(html, PORTRAIT.width, PORTRAIT.height)
  );
  const motion: MotionInfo = {
    gif: url,
    mp4: "",
    still: url,
    static: true,
    note: "Node 版动效暂为静态首帧 PNG，尚未生成 GIF / MP4",
  };
  const current = draft.content_json;
  const content =
    current && typeof current === "object" && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};
  content.motion = motion;
  updateDraft(id, { content_json: content });
  return { motion, draft_id: id, images: [url] };
}
