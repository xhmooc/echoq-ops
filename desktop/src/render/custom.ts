/**
 * M3 自定义模板渲染器：消费模板编辑器保存的 schema（custom_templates.schema），
 * 把编辑器元素（text/shape/image/badge/chip/divider/dots/qrcode/circle）转成
 * absolute 定位的 HTML，再走与 V2/手绘相同的 capture → 体检 → writeAsset 管线。
 *
 * 模板坐标基于编辑器画布（通常 1080×1440）；不同平台画布通过「缩放居中/顶部裁切」
 * 适配（见 fitCanvas）。占位符 {标题}{正文摘要}{日期}{结尾金句} 在渲染时用草稿内容填充。
 */
import { escapeHtml } from "../core/contentText";
import { log } from "../core/log";
import type { CardPage } from "./templates";

const esc = (value: unknown): string => escapeHtml(value === null || value === undefined ? "" : String(value));

export interface CustomTemplateDoc {
  id: number;
  name: string;
  schema: {
    pages?: Record<string, { canvas?: { w: number; h: number }; elements?: CustomElement[] }>;
  };
  preview?: string;
}

export interface CustomElement {
  id?: string;
  type: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotate?: number;
  z?: number;
  style?: Record<string, unknown>;
}

/** custom:<id> 形式的风格 key 识别。 */
export function isCustomStyleKey(key: string): boolean {
  return String(key || "").startsWith("custom:");
}

export function customTemplateId(key: string): number {
  const id = Number(String(key).slice("custom:".length));
  return Number.isFinite(id) && id > 0 ? Math.trunc(id) : 0;
}

const SANS = '"Microsoft YaHei","PingFang SC","Hiragino Sans GB",sans-serif';
const EMOJI_FONTS = ',"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji"';

/** 编辑器默认基准画布。 */
const BASE_W = 1080;
const BASE_H = 1440;

/**
 * 目标画布适配：返回 (scale, offsetX, offsetY)。
 * - 1080×1440：原样。
 * - 1080×1080（公众号方图）：等比 0.75 居中。
 * - 1080×460（公众号头图）：等比缩放后顶部对齐裁切。
 */
function fitTransform(canvasW: number, canvasH: number): { scale: number; dx: number; dy: number } {
  if (canvasW === BASE_W && canvasH === BASE_H) return { scale: 1, dx: 0, dy: 0 };
  const scale = Math.min(canvasW / BASE_W, canvasH / BASE_H);
  return {
    scale,
    dx: (canvasW - BASE_W * scale) / 2,
    dy: canvasH < BASE_H * scale ? 0 : (canvasH - BASE_H * scale) / 2,
  };
}

function gradCss(style: Record<string, unknown>): string {
  const to = String(style.gradTo || "");
  if (!to) return "";
  const from = String(style.bg || "#e8503a");
  const angle = Number(style.gradAngle ?? 90);
  return `linear-gradient(${angle}deg, ${from}, ${to})`;
}

function fillCss(style: Record<string, unknown>): string {
  const bg = String(style.bg || "transparent");
  if (bg === "transparent") return "transparent";
  return gradCss(style) || bg;
}

/** 把占位符替换成草稿内容。 */
function fillPlaceholders(text: string, page: CardPage): string {
  return String(text || "")
    .split("{标题}").join(page.title || "")
    .split("{正文摘要}").join(page.subtitle || "")
    .split("{日期}").join(new Date().toISOString().slice(0, 10))
    .split("{结尾金句}").join(page.kind === "ending" ? page.subtitle || "" : "");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function elementHtml(el: CustomElement, page: CardPage): string {
  const s = el.style || {};
  const x = clamp(Number(el.x) || 0, -200, 3000);
  const y = clamp(Number(el.y) || 0, -200, 3000);
  const w = clamp(Number(el.w) || 10, 4, 3000);
  const h = clamp(Number(el.h) || 10, 4, 3000);
  const rotate = Number(el.rotate) || 0;
  const z = Math.max(0, Math.trunc(Number(el.z) || 1));
  const opacity = clamp(Number(s.opacity ?? 100) / 100, 0.05, 1);
  const base =
    `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;` +
    (rotate ? `transform:rotate(${rotate}deg);` : "") +
    `z-index:${z};opacity:${opacity};box-sizing:border-box;`;
  const type = String(el.type || "text");
  if (type === "text" || type === "title") {
    const fontSize = clamp(Number(s.fontSize) || 40, 8, 400);
    return `<div class="cu-text" style="${base}font-size:${fontSize}px;font-weight:${esc(s.fontWeight || 400)};` +
      `color:${esc(s.color || "#1f2328")};text-align:${esc(s.align || "left")};line-height:${Number(s.lineHeight) || 1.5};` +
      `letter-spacing:${Number(s.letterSpacing) || 0}px;background:${fillCss(s)};border-radius:${Number(s.radius) || 0}px;` +
      `font-family:${SANS}${EMOJI_FONTS};display:flex;align-items:flex-start;overflow:hidden;">` +
      `<span style="width:100%;">${esc(fillPlaceholders(String(s.content || ""), page))}</span></div>`;
  }
  if (type === "image") {
    const src = String(s.src || "");
    const inner = src
      ? `<img src="${esc(src)}" style="width:100%;height:100%;object-fit:cover;border-radius:${Number(s.radius) || 0}px;display:block;" />`
      : `<div style="width:100%;height:100%;border-radius:${Number(s.radius) || 0}px;background:${gradCss(s) || `linear-gradient(135deg, ${esc(s.bg || "#f3f1ec")}, #e6e1d8)`};"></div>`;
    return `<div class="cu-image" style="${base}overflow:hidden;">${inner}</div>`;
  }
  if (type === "shape" || type === "circle") {
    const radius = type === "circle" ? "50%" : `${Number(s.radius) || 0}px`;
    return `<div class="cu-shape" style="${base}background:${fillCss(s)};border-radius:${radius};"></div>`;
  }
  if (type === "badge") {
    return `<div class="cu-badge" style="${base}background:${fillCss(s)};border-radius:${Number(s.radius) || 18}px;` +
      `color:${esc(s.color || "#ffffff")};font-size:${clamp(Number(s.fontSize) || 40, 8, 200)}px;font-weight:${esc(s.fontWeight || 800)};` +
      `font-family:${SANS}${EMOJI_FONTS};display:flex;align-items:center;justify-content:center;overflow:hidden;">` +
      esc(fillPlaceholders(String(s.content || ""), page)) + `</div>`;
  }
  if (type === "chip") {
    return `<div class="cu-chip" style="${base}border:3px solid ${esc(s.color || "#e8503a")};border-radius:${Number(s.radius) || 999}px;` +
      `color:${esc(s.color || "#e8503a")};font-size:${clamp(Number(s.fontSize) || 28, 8, 200)}px;font-weight:${esc(s.fontWeight || 700)};` +
      `background:${s.bg && s.bg !== "transparent" ? fillCss(s) : "transparent"};font-family:${SANS}${EMOJI_FONTS};` +
      `display:flex;align-items:center;justify-content:center;overflow:hidden;">` +
      esc(fillPlaceholders(String(s.content || ""), page)) + `</div>`;
  }
  if (type === "divider") {
    return `<div class="cu-divider" style="${base}background:${fillCss(s)};border-radius:${Number(s.radius) || 3}px;"></div>`;
  }
  if (type === "dots") {
    let dots = "";
    for (let i = 0; i < 8; i += 1) dots += "<i></i>";
    return `<div class="cu-dots" style="${base}color:${esc(s.color || "#e8503a")};display:grid;grid-template-columns:repeat(4,1fr);` +
      `gap:14%;padding:6%;">${dots}</div>`;
  }
  if (type === "qrcode") {
    let cells = "";
    for (let i = 0; i < 25; i += 1) {
      const on = (i * 7 + 3) % 5 < 2;
      cells += `<i style="background:${on ? "#16181b" : "transparent"};"></i>`;
    }
    return `<div class="cu-qrcode" style="${base}background:#fff;border:1px solid #e4e1da;border-radius:${Number(s.radius) || 0}px;` +
      `display:grid;grid-template-columns:repeat(5,1fr);grid-template-rows:repeat(5,1fr);gap:2px;padding:5px;">${cells}</div>`;
  }
  return "";
}

/**
 * 渲染一页：模板该页型元素 → HTML。模板缺该页型时回落空白底 + 标题，
 * 保证出图永不因 schema 缺页而失败。
 */
export function renderCustomDocument(page: CardPage, tpl: CustomTemplateDoc, width: number, height: number): string {
  const pageKey = page.kind === "cover" ? "cover" : page.kind === "ending" ? "ending" : "content";
  const doc = tpl.schema?.pages?.[pageKey];
  const elements = Array.isArray(doc?.elements) ? doc.elements : [];
  const fit = fitTransform(width, height);
  const baseW = doc?.canvas?.w || BASE_W;
  const baseH = doc?.canvas?.h || BASE_H;
  const body = elements.map((el) => elementHtml(el, page)).join("");
  const fallback =
    elements.length
      ? ""
      : `<div class="cu-text" style="position:absolute;left:84px;top:120px;right:84px;font-size:96px;font-weight:800;` +
        `color:#1f2328;font-family:${SANS}${EMOJI_FONTS};line-height:1.3;">${esc(page.title)}</div>` +
        `<div class="cu-text" style="position:absolute;left:84px;top:340px;right:84px;font-size:40px;color:#5b6570;` +
        `font-family:${SANS}${EMOJI_FONTS};line-height:1.6;">${esc(page.subtitle)}</div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { width:${width}px; height:${height}px; overflow:hidden; background:#f6f5f2; }
  #stage { position:relative; width:${width}px; height:${height}px; overflow:hidden; }
  #base { position:absolute; left:${fit.dx}px; top:${fit.dy}px; width:${baseW}px; height:${baseH}px;
    transform:scale(${fit.scale}); transform-origin:top left; }
  .cu-dots i { background:currentColor; border-radius:50%; width:100%; aspect-ratio:1; display:block; }
  .cu-qrcode i { display:block; border-radius:1px; }
  .cu-text span { white-space:pre-wrap; }
  </style></head><body><div id="stage"><div id="base">${body}${fallback}</div></div></body></html>`;
}

/** 渲染前兜底：schema 结构异常时给出可读日志并返回 null（由调用方决定报错文案）。 */
export function parseTemplateSchema(row: { id: number; name: string; schema: string; preview?: string }): CustomTemplateDoc | null {
  try {
    const schema = JSON.parse(row.schema || "{}");
    if (!schema || typeof schema !== "object") throw new Error("schema 不是对象");
    return { id: row.id, name: row.name, schema, preview: row.preview };
  } catch (error) {
    log.warn(`自定义模板 ${row.id}（${row.name}）schema 解析失败: ${String(error)}`);
    return null;
  }
}
