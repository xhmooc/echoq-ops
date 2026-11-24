/**
 * M1 出图体系 2.0（V2）：风格（视觉 token）× 版式（信息结构）正交模板。
 *
 * 与 Python 版 ops/designs.py 的 V2 引擎保持同构：同一批风格 token、
 * 同一套版式骨架（hero/stack/split/strip）与三档调色板（default/warm/cool），
 * 前端选择器与体检规则共用。只负责「草稿页 → HTML」，截图见 renderer.ts。
 */
import { escapeHtml } from "../core/contentText";
import type { CardPage } from "./templates";

const esc = (value: unknown): string => escapeHtml(value === null || value === undefined ? "" : String(value));

/* ------------------------------------------------------------------ 类型 */

export interface V2Palette {
  bg: string;
  ink: string;
  accent: string;
  soft: string;
}

export interface V2StyleInfo {
  key: string;
  name: string;
  tagline: string;
  desc: string;
  fit: string;
  colors: string[];
  temperature: "neutral" | "bold" | "calm";
  group: string;
  font: string;
  palettes: Record<string, V2Palette>;
}

/* ------------------------------------------------------------ 风格与版式 */

const EMOJI_FONTS = ',"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji"';
const SANS = '"Microsoft YaHei","PingFang SC","Hiragino Sans GB",sans-serif';

export const V2_STYLES: V2StyleInfo[] = [
  {
    key: "knowledge",
    name: "知识卡片",
    tagline: "Knowledge Card",
    desc: "米白底、深墨正文、单点蓝强调，编号要点层级清晰",
    fit: "概念解释、干货整理、读书笔记",
    colors: ["#FAF7F0", "#1F2937", "#2563EB"],
    temperature: "neutral",
    group: "info",
    font: `${SANS}${EMOJI_FONTS}`,
    palettes: {
      default: { bg: "#FAF7F0", ink: "#1F2937", accent: "#2563EB", soft: "#EAE4D6" },
      warm: { bg: "#FBF3E7", ink: "#3B2F23", accent: "#D97706", soft: "#F0E4CF" },
      cool: { bg: "#F2F6FA", ink: "#1E2A38", accent: "#0E7490", soft: "#DCE7F0" },
    },
  },
  {
    key: "steps",
    name: "步骤清单",
    tagline: "Step List",
    desc: "白底粗黑字、橙色编号徽章，一步一步照着做",
    fit: "教程、操作指南、检查清单",
    colors: ["#FFFFFF", "#17181C", "#F97316"],
    temperature: "neutral",
    group: "info",
    font: `${SANS}${EMOJI_FONTS}`,
    palettes: {
      default: { bg: "#FFFFFF", ink: "#17181C", accent: "#F97316", soft: "#FFEDD5" },
      warm: { bg: "#FFF9F2", ink: "#2A1D12", accent: "#EA580C", soft: "#FFE4C7" },
      cool: { bg: "#F7FAFC", ink: "#16232E", accent: "#0284C7", soft: "#DDEAF4" },
    },
  },
  {
    key: "datachart",
    name: "数据信息图",
    tagline: "Data Sheet",
    desc: "浅灰白底、超大数字、涨绿跌红，一眼看到结论",
    fit: "数据结论、测评结果、榜单盘点",
    colors: ["#F8FAF9", "#0F172A", "#0E9F6E"],
    temperature: "neutral",
    group: "info",
    font: `"Helvetica Neue",Arial,${SANS}${EMOJI_FONTS}`,
    palettes: {
      default: { bg: "#F8FAF9", ink: "#0F172A", accent: "#0E9F6E", soft: "#DCE9E3" },
      warm: { bg: "#FAF6F0", ink: "#26201A", accent: "#DC6803", soft: "#EFE5D8" },
      cool: { bg: "#F4F7FB", ink: "#101A2B", accent: "#2563EB", soft: "#DEE8F5" },
    },
  },
  {
    key: "versus",
    name: "对比测评",
    tagline: "Versus",
    desc: "左右对撞色块、居中 VS 徽章，优劣势一眼分清",
    fit: "产品对比、方案取舍、优劣势盘点",
    colors: ["#FDFDFB", "#111827", "#EA580C"],
    temperature: "bold",
    group: "info",
    font: `${SANS}${EMOJI_FONTS}`,
    palettes: {
      default: { bg: "#FDFDFB", ink: "#111827", accent: "#EA580C", soft: "#FDE8DC" },
      warm: { bg: "#FBF5EC", ink: "#231A10", accent: "#C2410C", soft: "#F5E3D3" },
      cool: { bg: "#F5F8FC", ink: "#0F1B2D", accent: "#1D4ED8", soft: "#DEE7F6" },
    },
  },
  {
    key: "poster",
    name: "大字公告",
    tagline: "Big Type",
    desc: "深底白字、超大标语、黄色强调线，三米外也能读完",
    fit: "活动公告、重要提醒、一句话观点",
    colors: ["#111318", "#FFFFFF", "#FFD447"],
    temperature: "bold",
    group: "info",
    font: `${SANS}${EMOJI_FONTS}`,
    palettes: {
      default: { bg: "#111318", ink: "#FFFFFF", accent: "#FFD447", soft: "#2A2E38" },
      warm: { bg: "#1D1210", ink: "#FFF7EC", accent: "#FF9F45", soft: "#33231C" },
      cool: { bg: "#0E1A24", ink: "#EFF8FF", accent: "#5EEAD4", soft: "#1D2E3C" },
    },
  },
  {
    key: "caption",
    name: "图注解读",
    tagline: "Caption Notes",
    desc: "浅灰底、宋体标题、细线分隔，安静耐看的注解风",
    fit: "长文注解、观点补充、慢读内容",
    colors: ["#F5F5F2", "#2D2A26", "#8A8F98"],
    temperature: "calm",
    group: "info",
    font: `"Songti SC","STSong","SimSun",Georgia,serif${EMOJI_FONTS}`,
    palettes: {
      default: { bg: "#F5F5F2", ink: "#2D2A26", accent: "#7C8188", soft: "#E4E4DE" },
      warm: { bg: "#F7F2EA", ink: "#33291F", accent: "#9A7B4F", soft: "#EAE0D0" },
      cool: { bg: "#F0F3F4", ink: "#243036", accent: "#5B7A8C", soft: "#DEE6E9" },
    },
  },
];

export const V2_LAYOUTS = [
  { key: "hero", name: "单图大标题", desc: "一图一件事，超大标题承载全部信息，适合封面与公告" },
  { key: "stack", name: "上下图文", desc: "标题在上、条目纵向展开，最通用的正文版式" },
  { key: "split", name: "左右分栏", desc: "左栏标题编号、右栏条目，双栏对照阅读" },
  { key: "strip", name: "长图分页", desc: "连续行式条目铺满版心，适合多要点长文" },
];

export const V2_PALETTE_KEYS = ["default", "warm", "cool"];
export const DEFAULT_V2_STYLE = "knowledge";
export const DEFAULT_V2_LAYOUT = "stack";
export const DEFAULT_V2_PALETTE = "default";

export function isV2StyleKey(key: unknown): boolean {
  return V2_STYLES.some((item) => item.key === String(key || "").trim());
}

export function isV2LayoutKey(key: unknown): boolean {
  return V2_LAYOUTS.some((item) => item.key === String(key || "").trim());
}

export function v2StyleInfo(key: unknown): V2StyleInfo {
  const found = V2_STYLES.find((item) => item.key === String(key || "").trim());
  return found || V2_STYLES[0];
}

function v2Palette(style: V2StyleInfo, palette: unknown): V2Palette {
  const key = String(palette || "").trim();
  return style.palettes[key] || style.palettes.default;
}

/* ------------------------------------------------------------------ CSS */

const PAGE_CSS = (width: number, height: number): string => `
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:100%;height:100%;overflow:hidden;background:var(--bg)}
body{-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision}
.page{position:relative;width:${width}px;height:${height}px;overflow:hidden}
`;

const V2_CSS = (font: string): string => `
.v2{background:var(--bg);color:var(--ink);font-family:${font}}
.v2 .v-kicker{position:absolute;left:84px;top:74px;font-size:24px;letter-spacing:.26em;
color:var(--accent);font-weight:700;z-index:3}
.v2 .v-foot{position:absolute;left:84px;right:84px;bottom:46px;display:flex;
justify-content:space-between;font-size:24px;letter-spacing:.16em;opacity:.55;z-index:3}
.v2 .v-rule{position:absolute;left:84px;right:84px;top:126px;height:3px;background:var(--ink);opacity:.16;z-index:2}

/* —— hero 单图大标题 —— */
.v2 .v-hero{position:absolute;left:84px;right:84px;top:250px}
.v2 .v-title{font-size:112px;line-height:1.22;font-weight:800;letter-spacing:.01em}
.v2 .v-sub{margin-top:34px;font-size:38px;line-height:1.62;color:var(--ink);opacity:.72}
.v2 .v-toc{position:absolute;left:84px;right:84px;top:950px}
.v2 .v-toc .v-row{display:flex;align-items:baseline;gap:16px;font-size:32px;line-height:1.9;color:var(--ink);opacity:.82}
.v2 .v-toc .v-row b{color:var(--accent);font-size:28px}
.v2 .v-toc .v-row i{flex:1;border-bottom:2px dashed var(--soft);transform:translateY(-8px)}

/* —— stack 上下图文 —— */
.v2 .v-head{position:absolute;left:84px;right:84px;top:170px}
.v2 .v-sec{font-size:54px;font-weight:800;line-height:1.3}
.v2 .v-sec small{display:block;margin-top:10px;font-size:26px;letter-spacing:.2em;color:var(--accent);font-weight:700}
.v2 .v-list{position:absolute;left:84px;right:84px;top:400px;bottom:150px;display:flex;flex-direction:column;justify-content:space-evenly}
.v2 .v-item{display:flex;gap:26px;align-items:flex-start;font-size:40px;line-height:1.55;font-weight:600}
.v2 .v-item .v-no{flex:none;min-width:74px;height:74px;border-radius:18px;background:var(--accent);color:var(--bg);
display:flex;align-items:center;justify-content:center;font-size:32px;font-weight:800}
.v2 .v-item p{flex:1}

/* —— split 左右分栏 —— */
.v2 .v-side{position:absolute;left:0;top:0;bottom:0;width:352px;background:var(--soft);padding:150px 44px 0}
.v2 .v-side .v-sec{font-size:46px}
.v2 .v-side .v-page{margin-top:26px;font-size:24px;letter-spacing:.2em;color:var(--accent);font-weight:700}
.v2 .v-main{position:absolute;left:420px;right:84px;top:190px;bottom:150px;display:flex;flex-direction:column;justify-content:space-evenly}
.v2 .v-main .v-item{font-size:37px;line-height:1.55}
.v2 .v-main .v-item .v-no{min-width:64px;height:64px;border-radius:14px;font-size:28px}

/* —— strip 长图分页 —— */
.v2 .v-strip{position:absolute;left:84px;right:84px;top:318px;bottom:150px;display:flex;flex-direction:column;justify-content:space-evenly}
.v2 .v-strip .v-line{display:flex;gap:22px;align-items:baseline;border-bottom:2px solid var(--soft);padding-bottom:26px}
.v2 .v-strip .v-line:last-child{border-bottom:none}
.v2 .v-strip .v-no{flex:none;font-size:34px;font-weight:800;color:var(--accent);min-width:64px}
.v2 .v-strip .v-line p{flex:1;font-size:34px;line-height:1.5;font-weight:500}

/* —— ending 结尾页 —— */
.v2 .v-end{position:absolute;left:84px;right:84px;top:420px}
.v2 .v-end .v-big{font-size:76px;line-height:1.4;font-weight:800}
.v2 .v-end .v-note{margin-top:40px;font-size:36px;line-height:1.6;opacity:.72}
.v2 .v-tags{position:absolute;left:84px;right:84px;top:1010px;display:flex;gap:18px;flex-wrap:wrap}
.v2 .v-tags .v-tag{border:2px solid var(--accent);color:var(--accent);border-radius:999px;
padding:12px 30px;font-size:26px;font-weight:700}

/* —— 公众号 2.35:1 宽幅封面 —— */
.v2 .w-band{position:absolute;left:84px;right:84px;top:96px;display:flex;align-items:center;gap:44px}
.v2 .w-band .w-title{flex:1;font-size:72px;line-height:1.25;font-weight:800}
.v2 .w-band .w-mark{flex:none;font-size:24px;letter-spacing:.3em;color:var(--accent);font-weight:800;
border:3px solid var(--accent);border-radius:14px;padding:16px 22px;text-align:center;line-height:1.5}
.v2 .w-sub{position:absolute;left:84px;right:84px;top:300px;font-size:32px;line-height:1.55;opacity:.72}
`;

const V2_STYLE_CSS: Record<string, string> = {
  knowledge: `
.v2.knowledge .v-deco{position:absolute;right:-120px;top:-120px;width:340px;height:340px;border-radius:50%;
border:26px solid var(--soft);z-index:1}
`,
  steps: `
.v2.steps .v-deco{position:absolute;left:84px;right:84px;top:118px;height:8px;background:var(--accent);opacity:.9;z-index:2}
.v2.steps .v-item .v-no{border-radius:50%}
`,
  datachart: `
.v2.datachart .v-deco{position:absolute;right:84px;top:74px;display:flex;gap:10px;align-items:flex-end;z-index:2}
.v2.datachart .v-deco i{display:block;width:22px;background:var(--accent);opacity:.85;border-radius:4px 4px 0 0}
.v2.datachart .v-deco i:nth-child(1){height:26px}.v2.datachart .v-deco i:nth-child(2){height:44px}
.v2.datachart .v-deco i:nth-child(3){height:34px}.v2.datachart .v-deco i:nth-child(4){height:58px}
`,
  versus: `
.v2.versus .v-deco{position:absolute;left:50%;top:150px;bottom:140px;width:3px;margin-left:-1px;
background:var(--ink);opacity:.14;z-index:1}
.v2.versus .v-badge{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);z-index:3;
background:var(--accent);color:#fff;font-size:30px;font-weight:800;border-radius:50%;
width:104px;height:104px;display:flex;align-items:center;justify-content:center;letter-spacing:.05em}
`,
  poster: `
.v2.poster{background-image:repeating-linear-gradient(135deg,rgba(255,255,255,.045) 0 2px,transparent 2px 26px)}
.v2.poster .v-title{text-shadow:0 10px 0 rgba(0,0,0,.28)}
.v2.poster .v-rule{background:var(--accent);opacity:1;height:6px}
`,
  caption: `
.v2.caption .v-rule{height:1px;opacity:.4}
.v2.caption .v-title{font-weight:700}
.v2.caption .v-item{font-weight:400}
.v2.caption .v-deco{position:absolute;left:84px;top:70px;font-size:22px;letter-spacing:.3em;opacity:.5;z-index:3}
`,
};

/* ------------------------------------------------------------------ 骨架 */

function fitTitle(text: string, base: number, width = 880, maxLines = 3): number {
  const units = Math.max(1, Array.from(text).length);
  for (const factor of [1, 0.92, 0.85, 0.78, 0.72, 0.66, 0.6]) {
    const size = Math.round(base * factor);
    if (size < 34) break;
    const perLine = Math.max(1, width / size);
    if (units / perLine <= maxLines - 0.2) return size;
  }
  return 34;
}

function v2Deco(style: string): string {
  if (style === "datachart") {
    return '<div class="v-deco"><i></i><i></i><i></i><i></i></div>';
  }
  return '<div class="v-deco"></div>';
}

function v2Items(page: CardPage, start = 1): string {
  return page.items
    .map((item, offset) => {
      const text = item.icon ? `${item.icon} ${item.text}` : item.text;
      return `<div class="v-item"><span class="v-no">${String(start + offset).padStart(2, "0")}</span><p>${esc(text)}</p></div>`;
    })
    .join("");
}

function v2Toc(page: CardPage, limit = 4): string {
  return page.toc
    .slice(0, limit)
    .map(
      (row) =>
        `<div class="v-row"><b>P${String(row.page).padStart(2, "0")}</b><span>${esc(row.label)}</span><i></i></div>`
    )
    .join("");
}

function kicker(style: V2StyleInfo): string {
  return `<div class="v-kicker">ECHOQ · ${esc(style.tagline.toUpperCase())}</div>`;
}

function foot(page: CardPage, left: string): string {
  return `<div class="v-foot"><span>${esc(left)}</span><span>P${String(page.index).padStart(2, "0")} · ${String(page.total).padStart(2, "0")}</span></div>`;
}

function v2Cover(page: CardPage, style: V2StyleInfo, layout: string): string {
  const size = fitTitle(page.title, layout === "hero" || layout === "strip" ? 118 : 98);
  const toc = v2Toc(page);
  const tocHtml = toc ? `<div class="v-toc">${toc}</div>` : "";
  if (layout === "split") {
    return `${kicker(style)}${v2Deco(style.key)}<div class="v-rule"></div>` +
      `<div class="v-side"><div class="v-sec">${esc(page.title)}</div>` +
      `<div class="v-page">COVER · P${String(page.index).padStart(2, "0")}</div></div>` +
      `<div class="v-main"><div class="v-sub" style="margin-top:0;font-size:40px">${esc(page.subtitle)}</div></div>` +
      foot(page, `${style.tagline} / 实用信息流`);
  }
  return `${kicker(style)}${v2Deco(style.key)}<div class="v-rule"></div>` +
    `<div class="v-hero"><h1 class="v-title" style="font-size:${size}px">${esc(page.title)}</h1>` +
    `<div class="v-sub">${esc(page.subtitle)}</div></div>${tocHtml}` +
    foot(page, `${style.tagline} / 实用信息流`);
}

function v2Content(page: CardPage, style: V2StyleInfo, layout: string): string {
  const sectionText = `${page.sectionIcon} ${page.section}`.trim();
  const heading = sectionText || "重点";
  const secHtml = `<div class="v-sec">${esc(heading)}<small>SECTION ${String(Math.max(1, page.index - 1)).padStart(2, "0")}</small></div>`;
  if (layout === "split") {
    return `${kicker(style)}${v2Deco(style.key)}<div class="v-rule"></div>` +
      `<div class="v-side">${secHtml}<div class="v-page">P${String(page.index).padStart(2, "0")} / ${String(page.total).padStart(2, "0")}</div></div>` +
      `<div class="v-main">${v2Items(page)}</div>` +
      foot(page, page.section || "要点");
  }
  if (layout === "strip") {
    const lines = page.items
      .map(
        (item, offset) =>
          `<div class="v-line"><span class="v-no">${String(offset + 1).padStart(2, "0")}</span><p>${esc(item.icon ? `${item.icon} ${item.text}` : item.text)}</p></div>`
      )
      .join("");
    // section 标题放进 v-head（绝对定位），否则流内块会从 (0,0) 铺满整页、触发越界体检。
    return `${kicker(style)}${v2Deco(style.key)}<div class="v-rule"></div>` +
      `<div class="v-head">${secHtml}</div>` +
      `<div class="v-strip">${lines}</div>` +
      foot(page, page.section || "要点");
  }
  // hero / stack 共用上下结构；hero 条目更大。
  const itemStyle = layout === "hero" ? ' style="font-size:46px"' : "";
  const items = v2Items(page).replace(/class="v-item"/g, `class="v-item"${itemStyle}`);
  return `${kicker(style)}${v2Deco(style.key)}<div class="v-rule"></div>` +
    `<div class="v-head">${secHtml}</div><div class="v-list">${items}</div>` +
    foot(page, page.section || "要点");
}

function v2Ending(page: CardPage, style: V2StyleInfo): string {
  const tags = page.tags
    .slice(0, 3)
    .map((tag) => `<span class="v-tag">#${esc(tag)}</span>`)
    .join("");
  const big = fitTitle(page.subtitle, 72);
  return `${kicker(style)}${v2Deco(style.key)}<div class="v-rule"></div>` +
    `<div class="v-end"><div class="v-big" style="font-size:${big}px">${esc(page.subtitle)}</div>` +
    `<div class="v-note">${esc(page.title)}</div></div>` +
    `<div class="v-tags">${tags}</div>` +
    foot(page, style.tagline);
}

function v2WideCover(page: CardPage, style: V2StyleInfo): string {
  const size = fitTitle(page.title, 68, 760, 2);
  return `<div class="w-band"><div class="w-title" style="font-size:${size}px">${esc(page.title)}</div>` +
    `<div class="w-mark">实用<br>信息流</div></div>` +
    `<div class="w-sub">${esc(page.subtitle)}</div>`;
}

/**
 * V2 单页 HTML。width>height 视为公众号宽幅封面（只渲染封面页）。
 */
export function renderV2Document(
  page: CardPage,
  styleKey: string,
  layoutKey: string,
  paletteKey: string,
  width: number,
  height: number
): string {
  const style = v2StyleInfo(styleKey);
  const layout = isV2LayoutKey(layoutKey) ? String(layoutKey).trim() : DEFAULT_V2_LAYOUT;
  const palette = v2Palette(style, paletteKey);
  const wide = width > height;
  const body = wide
    ? v2WideCover(page, style)
    : page.kind === "cover"
      ? v2Cover(page, style, layout)
      : page.kind === "ending"
        ? v2Ending(page, style)
        : v2Content(page, style, layout);
  const css =
    PAGE_CSS(width, height) +
    V2_CSS(style.font) +
    (V2_STYLE_CSS[style.key] || "") +
    `.v2{--bg:${palette.bg};--ink:${palette.ink};--accent:${palette.accent};--soft:${palette.soft}}`;
  const classes = `page v2 ${style.key} ${layout}${wide ? " wide" : ""}`;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<title>${esc(page.title)} · ${esc(style.key)}/${esc(layout)}</title>
<style>${css}</style></head>
<body><main class="${classes}">${body}</main></body></html>`;
}
