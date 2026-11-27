/**
 * 图片渲染模板：纯 HTML + CSS（+ 内联 SVG），不依赖外网字体和外部图片。
 *
 * 这里只负责「草稿 → HTML」，真正的截图见 renderer.ts。风格沿用 Python 版的
 * paper / memo / editorial / ink 四套，并支持 warm / cool 等配色覆盖；尺寸按
 * 1080×1440 竖版设计，公众号封面额外提供 1080×460 宽幅版式。
 */
import { escapeHtml } from "../core/contentText";
import { buildMotionScript } from "./motion-scripts";

const esc = (value: unknown): string => escapeHtml(asText(value));

function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map((item) => asText(item)).join(" ");
  if (typeof value === "object") return "";
  return String(value);
}

/* ------------------------------------------------------------------ 类型 */

export type CardStyleKey = "paper" | "memo" | "editorial" | "ink";

export interface CardStyleInfo {
  key: CardStyleKey;
  name: string;
  tagline: string;
  desc: string;
  group: string;
  colors: string[];
  defaultPalette: string;
  fontTitle: string;
  fontBody: string;
}

export interface CardPalette {
  key: string;
  name: string;
  bg: string;
  bgAlt: string;
  ink: string;
  muted: string;
  accent: string;
  accent2: string;
  line: string;
}

export interface BrandMeta {
  brand: string;
  column: string;
  issue: string;
}

export interface CardItem {
  icon: string;
  text: string;
}

export interface CardSection {
  icon: string;
  heading: string;
  items: CardItem[];
}

export interface CardPage {
  kind: "cover" | "content" | "ending";
  index: number;
  total: number;
  title: string;
  subtitle: string;
  section: string;
  sectionIcon: string;
  items: CardItem[];
  toc: Array<{ label: string; page: number }>;
  tags: string[];
}

export interface PageBuildOptions {
  layout?: string;
  brand?: BrandMeta;
  lead?: string;
}

export interface CardPageContext {
  style: string;
  palette: CardPalette;
  brand: BrandMeta;
  layout: string;
  width: number;
  height: number;
  variant?: number;
  motion?: boolean;
  /** 动效时长（秒，M3-a 参数化）；缺省 6s 与历史行为一致。 */
  motionDuration?: number;
  /** 动效范式 key（M3-b）；缺省 fade-seq 与历史行为一致。 */
  motionTemplate?: string;
}

export interface ArtworkContext {
  style: string;
  platform: string;
  scope: "inline" | "portrait" | "wide";
  width: number;
  height: number;
  brand: BrandMeta;
  variant?: number;
}

/* ------------------------------------------------------------ 风格与配色 */

export const CARD_STYLES: CardStyleInfo[] = [
  {
    key: "paper",
    name: "纸感手记",
    tagline: "Paper Note",
    desc: "暖纸底、手绘下划线、圆形编号，适合经验与方法",
    group: "排版模板",
    colors: ["#F7F3E8", "#241F18", "#C0492B"],
    defaultPalette: "warm",
    fontTitle: "'Microsoft YaHei','PingFang SC','Hiragino Sans GB',sans-serif",
    fontBody: "'Microsoft YaHei','PingFang SC','Hiragino Sans GB',sans-serif",
  },
  {
    key: "memo",
    name: "便签纸",
    tagline: "Memo & Doodle",
    desc: "白底点阵、胶带与马克笔高亮，适合清单与学习笔记",
    group: "排版模板",
    colors: ["#FFFFFF", "#232323", "#FFE07A"],
    defaultPalette: "macaron",
    fontTitle: "'Kaiti SC','KaiTi','STKaiti','Microsoft YaHei',serif",
    fontBody: "'Kaiti SC','KaiTi','STKaiti','Microsoft YaHei',serif",
  },
  {
    key: "editorial",
    name: "杂志奶油",
    tagline: "Editorial Cream",
    desc: "衬线大标题、发丝线与分节编号，适合长文复盘",
    group: "排版模板",
    colors: ["#FAF6EE", "#1B1917", "#8B2E2E"],
    defaultPalette: "warm",
    fontTitle: "'Songti SC','STSong','SimSun','Georgia',serif",
    fontBody: "'Songti SC','STSong','SimSun','Georgia',serif",
  },
  {
    key: "ink",
    name: "索引墨",
    tagline: "Index & Ink",
    desc: "墨底黄字、等距索引行与巨大页码，适合清单与干货",
    group: "排版模板",
    colors: ["#181614", "#F4F1EA", "#FFD447"],
    defaultPalette: "ink",
    fontTitle: "'Songti SC','STSong','SimSun','Georgia',serif",
    fontBody: "'Microsoft YaHei','PingFang SC',sans-serif",
  },
];

export const CARD_LAYOUTS = [
  { key: "balanced", name: "均衡", hint: "3-4 个信息点，通用" },
  { key: "sparse", name: "留白", hint: "1-2 个信息点，封面与金句" },
  { key: "dense", name: "知识卡", hint: "4-8 个信息点，双栏排列" },
  { key: "list", name: "清单", hint: "4-7 条，编号纵排" },
  { key: "comparison", name: "对比", hint: "左右两栏对照" },
  { key: "flow", name: "流程", hint: "3-6 步，箭头串联" },
  { key: "quadrant", name: "四象限", hint: "2×2 四宫格" },
  { key: "mindmap", name: "思维导图", hint: "中心词向外分支" },
];

export const PALETTES: Record<string, CardPalette> = {
  warm: {
    key: "warm",
    name: "暖色",
    bg: "#F7F3E8",
    bgAlt: "#EFE6D3",
    ink: "#241F18",
    muted: "#7A6E5C",
    accent: "#C0492B",
    accent2: "#D9A441",
    line: "rgba(36,31,24,0.14)",
  },
  cool: {
    key: "cool",
    name: "冷色",
    bg: "#EDF2F7",
    bgAlt: "#DEE8F2",
    ink: "#17212B",
    muted: "#66727F",
    accent: "#2E6F8E",
    accent2: "#4E7FC1",
    line: "rgba(23,33,43,0.14)",
  },
  macaron: {
    key: "macaron",
    name: "马卡龙",
    bg: "#FDF8F5",
    bgAlt: "#F7E8E4",
    ink: "#3B2F2F",
    muted: "#8A7674",
    accent: "#E9899A",
    accent2: "#8FC6B4",
    line: "rgba(59,47,47,0.12)",
  },
  neon: {
    key: "neon",
    name: "霓虹",
    bg: "#121218",
    bgAlt: "#1C1C26",
    ink: "#F7F4EE",
    muted: "#A9A6B8",
    accent: "#F5C542",
    accent2: "#FF5D73",
    line: "rgba(247,244,238,0.16)",
  },
  ink: {
    key: "ink",
    name: "墨色",
    bg: "#151310",
    bgAlt: "#211D18",
    ink: "#F4F1EA",
    muted: "#B7B0A2",
    accent: "#FFD447",
    accent2: "#E28A5B",
    line: "rgba(244,241,234,0.18)",
  },
};

export const CARD_PALETTES = Object.values(PALETTES).map((item) => ({
  key: item.key,
  name: item.name,
  hint: "覆盖模板自带配色",
}));

const STYLE_ALIASES: Record<string, CardStyleKey> = {
  paper: "paper",
  memo: "memo",
  editorial: "editorial",
  ink: "ink",
  magazine: "editorial",
  daily: "editorial",
  specimen: "editorial",
  minimal: "ink",
  cool: "editorial",
  guide: "memo",
  cards: "memo",
  warm: "paper",
};

export function normalizeCardStyle(key: unknown): CardStyleKey {
  const value = String(key || "").trim();
  return STYLE_ALIASES[value] || "paper";
}

export function styleInfo(key: unknown): CardStyleInfo {
  const normalized = normalizeCardStyle(key);
  return CARD_STYLES.find((item) => item.key === normalized) || CARD_STYLES[0];
}

export function normalizeLayout(key: unknown): string {
  const value = String(key || "").trim();
  return CARD_LAYOUTS.some((item) => item.key === value) ? value : "balanced";
}

const HEX_RE = /^#[0-9a-fA-F]{3,8}$/;

export function resolvePalette(key: unknown, styleKey: unknown, overrideAccent = ""): CardPalette {
  const style = styleInfo(styleKey);
  const value = String(key || "").trim();
  const base = PALETTES[value] || PALETTES[style.defaultPalette] || PALETTES.warm;
  const palette: CardPalette = { ...base };
  if (HEX_RE.test(overrideAccent.trim())) palette.accent = overrideAccent.trim();
  return palette;
}

/* --------------------------------------------------------------- 文解析 */

const BULLET_ICONS = "✅💡🔹🔸☑⚠❌👉👍🔖➡️▪▫";

function isIconCode(code: number): boolean {
  return (
    (code >= 0x1f000 && code <= 0x1faff) ||
    (code >= 0x2600 && code <= 0x27bf) ||
    (code >= 0x2b00 && code <= 0x2bff)
  );
}

function leadingIcon(text: string): string {
  if (!text) return "";
  let index = 0;
  let end = 0;
  while (index < text.length) {
    const code = text.codePointAt(index) || 0;
    const char = String.fromCodePoint(code);
    if (isIconCode(code) || code === 0xfe0f || code === 0x200d) {
      index += char.length;
      end = index;
      continue;
    }
    break;
  }
  return text.slice(0, end);
}

export function cleanInline(value: unknown): string {
  return asText(value)
    .replace(/\*\*|__|`/g, "")
    .replace(/^[\s>*\-·•\u2022#]+/, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function stripMarkdown(text: string): string {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*|__|`/g, "")
    .trim();
}

function shorten(text: string, limit: number): string {
  const value = text.trim();
  if (value.length <= limit) return value;
  const window = value.slice(0, limit);
  const cut = Math.max(
    window.lastIndexOf("。"),
    window.lastIndexOf("！"),
    window.lastIndexOf("？"),
    window.lastIndexOf("，"),
    window.lastIndexOf("；")
  );
  if (cut >= Math.floor(limit * 0.5)) return window.slice(0, cut + 1);
  return window.replace(/[，,、：:；;—\s]+$/, "") + "…";
}

/** 长句按标点拆成多条，交给分页逻辑自然摊到多页，避免一页塞爆。 */
function splitLongText(text: string, limit = 88): string[] {
  const clean = text.trim();
  if (clean.length <= limit) return clean ? [clean] : [];
  const parts: string[] = [];
  let rest = clean;
  while (rest.length > limit) {
    let cut = -1;
    for (const sep of ["。", "！", "？", "；", "!", "?", ";"]) {
      const found = rest.lastIndexOf(sep, limit);
      if (found > cut) cut = found + sep.length;
    }
    if (cut < limit * 0.45) {
      const found = rest.lastIndexOf("，", limit);
      if (found > limit * 0.5) cut = found + 1;
    }
    if (cut <= 0) cut = limit;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
}

function isSectionLine(line: string): boolean {
  const icon = leadingIcon(line);
  if (!icon) return false;
  const rest = line.slice(icon.length).trim();
  return Boolean(rest) && rest.length <= 24;
}

function isBulletLine(line: string): boolean {
  const icon = leadingIcon(line);
  if (icon && BULLET_ICONS.includes(icon)) return true;
  return /^(?:\d{1,2}[.、)）]|[-*·•—])\s+/.test(line);
}

export interface ParsedContent {
  lead: string;
  sections: CardSection[];
  outro: string;
}

export function parseContent(draft: Record<string, unknown>): ParsedContent {
  const desc = String(draft.desc || "").trim();
  const raw = desc || stripMarkdown(asText(draft.body_md));
  const lines = raw.split(/\r?\n/);
  let lead = "";
  let outro = "";
  const sections: CardSection[] = [];
  const loose: CardItem[] = [];

  const pushItem = (item: CardItem): void => {
    if (!item.text) return;
    if (sections.length) sections[sections.length - 1].items.push(item);
    else loose.push(item);
  };

  for (const original of lines) {
    const rawLine = String(original).trim();
    if (!rawLine) continue;
    // 纯话题行不进入卡片正文（cleanInline 会去掉开头的 #，所以先判断原文）。
    if (/^\s*(#[^\s#]+#?\s*)+$/.test(rawLine)) continue;
    const line = cleanInline(rawLine);
    if (!line) continue;
    const heading = /^#{1,6}\s+(.+)$/.exec(rawLine);
    if (heading) {
      const text = cleanInline(heading[1]).replace(/[#\s]+$/, "");
      if (text) sections.push({ icon: leadingIcon(text), heading: text.replace(leadingIcon(text), "").trim(), items: [] });
      continue;
    }
    if (isSectionLine(line) && !isBulletLine(line)) {
      const icon = leadingIcon(line);
      const text = line.slice(icon.length).replace(/[\s✨🔍📌🎯🧩📎🔥⭐📝📚]+$/, "").trim();
      if (text) sections.push({ icon, heading: text, items: [] });
      continue;
    }
    if (isBulletLine(line)) {
      const icon = leadingIcon(line);
      const text = cleanInline(line.slice(icon.length).replace(/^(?:\d{1,2}[.、)）]|[-*·•—])\s*/, ""));
      for (const part of splitLongText(text)) pushItem({ icon, text: part });
      continue;
    }
    if (!lead && !sections.length) {
      lead = shorten(line, 84);
      continue;
    }
    for (const part of splitLongText(line)) pushItem({ icon: "", text: part });
  }

  if (loose.length) {
    if (sections.length) {
      sections[0].items.unshift(...loose);
    } else {
      sections.push({ icon: "", heading: "重点", items: loose });
    }
  }
  if (!sections.length && lead) {
    sections.push({ icon: "", heading: "重点", items: [{ icon: "", text: lead }] });
    lead = "";
  }
  if (!outro) {
    for (let index = sections.length - 1; index >= 0; index -= 1) {
      const items = sections[index].items;
      const found = items.findIndex((item) => item.text.includes("？") || item.text.includes("?"));
      if (found >= 0) {
        outro = items.splice(found, 1)[0].text;
        break;
      }
    }
  }
  const trimmed = sections
    .map((section) => ({ ...section, items: section.items.slice(0, 16) }))
    .filter((section) => section.heading || section.items.length);
  return { lead, sections: trimmed.slice(0, 10), outro };
}

/* --------------------------------------------------------------- 分页 */

const LAYOUT_CAPACITY: Record<string, number> = {
  sparse: 2,
  balanced: 3,
  dense: 4,
  list: 5,
  comparison: 4,
  flow: 5,
  quadrant: 4,
  mindmap: 4,
};

function chunkItems(items: CardItem[], size: number): CardItem[][] {
  const groups: CardItem[][] = [];
  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size));
  }
  return groups.length ? groups : [[]];
}

function draftTags(draft: Record<string, unknown>): string[] {
  const raw = draft.topics;
  const list: string[] = [];
  const add = (value: unknown): void => {
    const text = String(value ?? "").replace(/^#+/, "").trim();
    if (text && text.length <= 16 && !list.includes(text) && list.length < 6) list.push(text);
  };
  if (Array.isArray(raw)) raw.forEach(add);
  else if (typeof raw === "string") raw.split(/[,，;；\s#]+/).forEach(add);
  return list;
}

export function buildCardPages(draft: Record<string, unknown>, options: PageBuildOptions = {}): CardPage[] {
  const layout = normalizeLayout(options.layout);
  const parsed = parseContent(draft);
  const title = cleanInline(draft.title) || "未命名笔记";
  const lead = options.lead
    ? cleanInline(options.lead)
    : parsed.lead || cleanInline(draft.angle) || "把这件事讲清楚，比背模板有用";
  const capacity = LAYOUT_CAPACITY[layout] || 3;
  const sections = parsed.sections.length
    ? parsed.sections
    : [{ icon: "", heading: "重点", items: [{ icon: "", text: shorten(lead || title, 88) }] }];

  const pages: CardPage[] = [
    {
      kind: "cover",
      index: 1,
      total: 1,
      title,
      subtitle: shorten(lead, 72),
      section: "",
      sectionIcon: "",
      items: [],
      toc: [],
      tags: draftTags(draft),
    },
  ];

  for (const section of sections) {
    const groups = chunkItems(section.items, capacity);
    groups.forEach((items, groupIndex) => {
      if (!items.length) return;
      let heading = section.heading || (sections.length === 1 ? "重点" : "");
      if (groupIndex > 0) heading = heading ? `${heading}（续）` : "接着看";
      pages.push({
        kind: "content",
        index: pages.length + 1,
        total: 1,
        title,
        subtitle: "",
        section: heading,
        sectionIcon: section.icon,
        items,
        toc: [],
        tags: draftTags(draft),
      });
    });
  }

  const outro = parsed.outro || "先存着，用得上时翻出来";
  const cta = parsed.outro ? "换个场景，你会怎么处理？" : "";
  pages.push({
    kind: "ending",
    index: pages.length + 1,
    total: 1,
    title: "先存着，用得上时翻出来",
    subtitle: cta ? `${shorten(outro, 60)}\n${cta}` : shorten(outro, 60),
    section: "",
    sectionIcon: "",
    items: [],
    toc: [],
    tags: draftTags(draft),
  });

  const total = pages.length;
  const toc = pages
    .filter((page) => page.kind === "content" && !page.section.endsWith("（续）"))
    .slice(0, 5)
    .map((page) => ({ label: page.section || "重点", page: page.index }));
  for (const page of pages) {
    page.index = pages.indexOf(page) + 1;
    page.total = total;
    page.toc = page.kind === "cover" ? toc : [];
  }
  return pages;
}

/* --------------------------------------------------------------- 尺寸 */

function textUnits(text: string): number {
  let units = 0;
  for (const char of Array.from(text)) {
    const code = char.codePointAt(0) || 0;
    if (isIconCode(code)) units += 1.6;
    else if (/[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/.test(char)) units += 1;
    else if (/[A-Za-z0-9]/.test(char)) units += 0.56;
    else if (/\s/.test(char)) units += 0.3;
    else units += 0.6;
  }
  return units;
}

function fitFont(text: string, base: number, width: number, maxLines: number, minimum = 34): number {
  const units = Math.max(1, textUnits(text));
  for (const factor of [1, 0.96, 0.92, 0.88, 0.84, 0.8, 0.76, 0.72, 0.68]) {
    const size = Math.round(base * factor);
    if (size < minimum) break;
    const perLine = Math.max(1, width / size);
    if (units / perLine <= maxLines - 0.2) return size;
  }
  return minimum;
}

function itemFontSize(items: CardItem[], layout: string): number {
  const longest = Math.max(0, ...items.map((item) => textUnits(item.text)));
  let size = 48;
  if (longest > 36) size = 44;
  if (longest > 56) size = 40;
  if (longest > 76) size = 36;
  if (["dense", "comparison", "quadrant", "mindmap"].includes(layout)) size = Math.min(size, 34);
  if (layout === "list") size = Math.min(size, 40);
  if (layout === "sparse") size = 56;
  return size;
}

/* --------------------------------------------------------------- CSS */

const BASE_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:100%;height:100%;overflow:hidden;background:var(--bg)}
body{-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision}
.page{position:relative;width:100%;height:100%;overflow:hidden;background:var(--bg);color:var(--ink);
font-family:var(--font-body);display:flex;flex-direction:column;padding:84px 84px 100px;
word-break:break-word;overflow-wrap:anywhere;line-break:strict}
.topline{flex:0 0 auto;display:flex;justify-content:space-between;align-items:center;
font-size:21px;letter-spacing:.16em;color:var(--muted);text-transform:uppercase}
.topline .brand{color:var(--ink);font-weight:700;letter-spacing:.24em}
.cover-body{flex:1;display:flex;flex-direction:column;justify-content:center;gap:26px;min-height:0;position:relative;z-index:2}
.kicker{font-size:22px;letter-spacing:.4em;color:var(--accent);font-weight:700}
.title{font-family:var(--font-title);font-weight:800;line-height:1.2;letter-spacing:-.01em;max-width:100%}
.underline{height:14px;border-radius:9px;background:var(--accent);opacity:.75;transform:rotate(-1deg)}
.lead{font-size:34px;line-height:1.62;color:var(--muted);max-width:860px}
.toc{list-style:none;display:flex;flex-direction:column;gap:14px;margin-top:14px;max-width:860px}
.toc li{display:flex;align-items:baseline;gap:16px;font-size:27px;color:var(--muted)}
.toc li i{flex:1;border-bottom:2px dashed var(--line);transform:translateY(-6px)}
.toc li b{font-weight:600;color:var(--ink)}
.content{flex:1;display:flex;flex-direction:column;justify-content:center;gap:40px;min-height:0;position:relative;z-index:2}
.section-title{font-family:var(--font-title);font-weight:800;line-height:1.24;display:flex;align-items:center;gap:16px}
.section-icon{flex:0 0 auto}
.items{list-style:none;display:flex;flex-direction:column;gap:34px}
.item{display:flex;align-items:flex-start;gap:24px;break-inside:avoid}
.chip{flex:0 0 62px;height:62px;border-radius:50%;display:flex;align-items:center;justify-content:center;
font-size:25px;font-weight:700;color:var(--bg);background:var(--accent);letter-spacing:.02em}
.item-text{font-size:var(--item-size,48px);line-height:1.48;font-weight:600}
.ending-body{flex:1;display:flex;flex-direction:column;justify-content:center;align-items:flex-start;gap:30px;position:relative;z-index:2}
.quote-mark{font-family:var(--font-title);font-size:150px;line-height:.7;color:var(--accent);opacity:.8;height:80px}
.outro{font-size:38px;line-height:1.55;color:var(--ink);max-width:880px;white-space:pre-line}
.tag-row{display:flex;flex-wrap:wrap;gap:14px;margin-top:6px}
.tag{font-size:26px;padding:9px 20px;border:2px solid var(--line);border-radius:999px;color:var(--muted)}
.foot{position:absolute;left:84px;right:84px;bottom:48px;display:flex;justify-content:space-between;
font-size:22px;letter-spacing:.14em;color:var(--muted);z-index:8}
.ghost{position:absolute;right:-18px;top:-66px;font-size:520px;line-height:1;font-weight:900;
color:rgba(127,127,127,.07);letter-spacing:-.06em;z-index:0;pointer-events:none}
.layout-list .items{gap:22px}
.layout-list .item{padding-bottom:22px;border-bottom:2px dashed var(--line)}
.layout-list .chip{flex-basis:auto;height:auto;padding:0 14px;border-radius:12px;font-size:24px}
.layout-dense .content,.layout-quadrant .content,.layout-mindmap .content,.layout-comparison .content{gap:30px}
.layout-dense .items{display:grid;grid-template-columns:1fr 1fr;gap:24px}
.layout-dense .item{flex-direction:column;gap:14px;padding:24px;border:2px solid var(--line);border-radius:22px}
.layout-dense .chip{width:54px;height:54px;flex-basis:54px;font-size:22px}
.layout-comparison .items{display:grid;grid-template-columns:1fr 1fr;gap:24px}
.layout-comparison .item{flex-direction:column;gap:14px;padding:26px;border:2px solid var(--line);border-radius:20px}
.layout-quadrant .items{display:grid;grid-template-columns:1fr 1fr;gap:24px}
.layout-quadrant .item{flex-direction:column;gap:14px;padding:26px;border:2px solid var(--line);border-radius:20px}
.layout-mindmap .items{display:grid;grid-template-columns:1fr 1fr;gap:22px}
.layout-mindmap .item{padding:22px 26px;border:2px solid var(--line);border-radius:999px}
.layout-flow .item{position:relative}
.layout-flow .item + .item::before{content:"↓";position:absolute;left:20px;top:-34px;width:20px;
color:var(--accent);font-size:26px;line-height:1;text-align:center}
.layout-sparse .item-text{font-size:var(--item-size,56px)}

.paper{background-image:radial-gradient(var(--line) 1.5px,transparent 1.6px);background-size:30px 30px}
.paper .chip{background:transparent;border:3px solid var(--accent);color:var(--accent)}
.paper .item{padding:24px 28px;background:var(--bg-alt);border:2px solid var(--line);
border-radius:26px 30px 24px 32px}
.paper .section-title{padding-bottom:12px;border-bottom:3px solid var(--ink)}

.memo{background-image:radial-gradient(var(--line) 2.4px,transparent 2.6px);background-size:34px 34px}
.memo .tape{position:absolute;left:50%;top:42px;width:222px;height:56px;margin-left:-111px;
background:#FFE9A8;opacity:.9;transform:rotate(-3deg);z-index:1}
.memo .cover-body{background:var(--bg-alt);border:2px solid var(--line);border-radius:8px;
box-shadow:0 22px 52px rgba(120,105,80,.13);padding:70px 54px;margin:44px 0 24px}
.memo .title{font-weight:700}
.memo .chip{background:var(--ink);color:var(--bg)}
.memo .item-text{background:linear-gradient(transparent 64%,var(--accent2) 64%,var(--accent2) 92%,transparent 92%);
display:inline;padding:0 4px;box-decoration-break:clone}
.memo .section-title{border-bottom:3px solid var(--ink);padding-bottom:10px}

.editorial .title{font-weight:700;letter-spacing:-.015em}
.editorial .kicker{letter-spacing:.34em}
.editorial .lead{font-style:italic}
.editorial .section-title{padding-bottom:16px;border-bottom:3px solid var(--ink)}
.editorial .item{padding-bottom:24px;border-bottom:1px solid var(--line);gap:18px}
.editorial .chip{flex-basis:74px;width:auto;height:auto;border-radius:0;background:transparent;
color:var(--accent);font-family:var(--font-title);font-size:30px;justify-content:flex-start}
.editorial .item-text{font-family:var(--font-title);font-weight:500}
.editorial .quote-mark{font-size:190px;height:96px}

.ink{background:radial-gradient(120% 100% at 50% 0%,var(--bg-alt) 0%,var(--bg) 58%,var(--bg) 100%)}
.ink .ghost{color:rgba(127,127,127,.07)}
.ink .chip{background:transparent;color:var(--accent);font-family:var(--font-title);border-radius:0;
border-bottom:4px solid var(--accent);width:auto;flex-basis:78px;height:auto;padding-bottom:6px}
.ink .item{padding-bottom:20px;border-bottom:1px dotted var(--line)}
.ink .section-title{color:var(--ink)}
.ink .tag{border-color:var(--line);color:var(--muted)}

.wide{padding:46px 64px 62px}
.wide .topline{font-size:17px}
.wide .wide-body{flex:1;display:flex;align-items:center;justify-content:space-between;gap:40px;min-height:0;position:relative;z-index:2}
.wide .copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:14px}
.wide .kicker{font-size:17px;letter-spacing:.32em}
.wide .title{font-weight:800}
.wide .underline{height:10px}
.wide .lead{font-size:24px;line-height:1.55;-webkit-line-clamp:2;display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden}
.wide .seal{flex:0 0 196px;width:196px;height:196px;border:3px solid var(--accent);border-radius:50%;
display:flex;flex-direction:column;align-items:center;justify-content:center;color:var(--accent);transform:rotate(-6deg)}
.wide .seal b{font-size:58px;line-height:1;font-family:var(--font-title)}
.wide .seal span{font-size:15px;letter-spacing:.26em;margin-top:8px}
.wide .foot{left:64px;right:64px;bottom:24px;font-size:16px}
.wide .tag{font-size:17px;padding:5px 14px}
`;

/* ----------------------------------------------------------- 页面片段 */

function pageVars(ctx: CardPageContext): string {
  const style = styleInfo(ctx.style);
  const palette = ctx.palette;
  return [
    `--bg:${palette.bg}`,
    `--bg-alt:${palette.bgAlt}`,
    `--ink:${palette.ink}`,
    `--muted:${palette.muted}`,
    `--accent:${palette.accent}`,
    `--accent2:${palette.accent2}`,
    `--line:${palette.line}`,
    `--font-title:${style.fontTitle}`,
    `--font-body:${style.fontBody}`,
  ].join(";");
}

function coverKicker(style: string): string {
  if (style === "memo") return "MEMO / 便签";
  if (style === "editorial") return "ESSAY / 长文";
  if (style === "ink") return "INDEX / 索引";
  return "NOTE / 手记";
}

function topLine(brand: BrandMeta, compact = false): string {
  const meta = compact ? `${esc(brand.column)} · ${esc(brand.issue)}` : `${esc(brand.column)} · NO.${esc(brand.issue)}`;
  return `<header class="topline"><span class="brand">${esc(brand.brand)}</span><span class="meta">${meta}</span></header>`;
}

function footLine(page: CardPage, brand: BrandMeta): string {
  return `<footer class="foot"><span>${esc(brand.brand)} · ${esc(brand.column)}</span><span>${String(page.index).padStart(2, "0")} / ${String(page.total).padStart(2, "0")}</span></footer>`;
}

function coverBody(page: CardPage, ctx: CardPageContext, wide: boolean): string {
  const width = wide ? Math.round(ctx.width - 420) : 900;
  const titleSize = fitFont(page.title, wide ? 58 : 120, width, wide ? 3 : 4, wide ? 32 : 56);
  const leadSize = wide ? 24 : fitFont(page.subtitle, 34, 840, 2, 26);
  const underline = Math.min(wide ? 220 : 320, Math.max(120, textUnits(page.title) * 12));
  const toc = page.toc.length
    ? `<ul class="toc">${page.toc
        .map(
          (row, index) =>
            `<li><b>${String(index + 1).padStart(2, "0")}</b><span>${esc(row.label)}</span><i></i><span>P${String(
              row.page
            ).padStart(2, "0")}</span></li>`
        )
        .join("")}</ul>`
    : "";
  const tags = page.tags.length
    ? `<div class="tag-row">${page.tags.map((tag) => `<span class="tag">#${esc(tag)}</span>`).join("")}</div>`
    : "";
  if (wide) {
    return `<div class="wide-body">
  <div class="copy">
    <span class="kicker">${esc(coverKicker(ctx.style))}</span>
    <h1 class="title" style="font-size:${titleSize}px">${esc(page.title)}</h1>
    <div class="underline" style="width:${underline}px"></div>
    <p class="lead" style="font-size:${leadSize}px">${esc(page.subtitle)}</p>
    ${tags}
  </div>
  <div class="seal"><b>${esc(ctx.brand.issue)}</b><span>VOLUME</span></div>
</div>`;
  }
  return `<div class="cover-body">
  <span class="kicker">${esc(coverKicker(ctx.style))}</span>
  <h1 class="title" style="font-size:${titleSize}px">${esc(page.title)}</h1>
  <div class="underline" style="width:${underline}px"></div>
  <p class="lead" style="font-size:${leadSize}px">${esc(page.subtitle)}</p>
  ${toc}
  ${tags}
</div>`;
}

function contentBody(page: CardPage, ctx: CardPageContext): string {
  const sectionText = `${page.sectionIcon} ${page.section}`.trim();
  const headingSize = fitFont(sectionText, 66, 900, 2, 38);
  const itemSize = itemFontSize(page.items, ctx.layout);
  const items = page.items
    .map(
      (item, index) =>
        `<li class="item"><span class="chip">${String(index + 1).padStart(2, "0")}</span>` +
        `<p class="item-text">${esc(item.icon ? `${item.icon} ${item.text}` : item.text)}</p></li>`
    )
    .join("");
  return `<div class="content">
  <h2 class="section-title" style="font-size:${headingSize}px">${
    page.sectionIcon ? `<span class="section-icon">${esc(page.sectionIcon)}</span>` : ""
  }<span>${esc(page.section || "重点")}</span></h2>
  <ul class="items" style="--item-size:${itemSize}px">${items}</ul>
</div>`;
}

function endingBody(page: CardPage, ctx: CardPageContext): string {
  const width = 900;
  const titleSize = fitFont(page.title, 86, width, 2, 48);
  const outroSize = fitFont(page.subtitle, 40, width, 3, 28);
  const tags = page.tags.length
    ? `<div class="tag-row">${page.tags.map((tag) => `<span class="tag">#${esc(tag)}</span>`).join("")}</div>`
    : "";
  return `<div class="ending-body">
  <div class="quote-mark">“</div>
  <h1 class="title" style="font-size:${titleSize}px">${esc(page.title)}</h1>
  <p class="outro" style="font-size:${outroSize}px">${esc(page.subtitle)}</p>
  ${tags}
  <p class="lead" style="font-size:24px">${esc(ctx.brand.brand)} · 每天一个能直接用的小方法</p>
</div>`;
}

export function renderCardDocument(page: CardPage, ctx: CardPageContext): string {
  const styleKey = normalizeCardStyle(ctx.style);
  const wide = ctx.width > ctx.height * 1.5;
  const body = wide || page.kind === "cover" ? coverBody(page, ctx, wide) : page.kind === "content" ? contentBody(page, ctx) : endingBody(page, ctx);
  const tape = styleKey === "memo" && page.kind === "cover" && !wide ? '<div class="tape"></div>' : "";
  const ghost = styleKey === "ink" && page.kind !== "cover" ? `<div class="ghost">${String(page.index).padStart(2, "0")}</div>` : "";
  const motion = ctx.motion ? " motion" : "";
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<title>${esc(page.title)}</title>
<style>${BASE_CSS}${ctx.motion ? MOTION_CSS : ""}</style></head>
<body>
<main class="page ${styleKey} ${page.kind} layout-${normalizeLayout(ctx.layout)}${wide ? " wide" : ""}${motion}" style="${pageVars(ctx)}">
${tape}${ghost}
${wide ? topLine(ctx.brand, true) : topLine(ctx.brand)}
${body}
${footLine(page, ctx.brand)}
${ctx.motion ? MOTION_BAR : ""}
</main>
${ctx.motion ? `<script>${MOTION_SCRIPT(ctx.motionDuration ?? 6, ctx.motionTemplate)}</script>` : ""}
</body></html>`;
}

/* ------------------------------------------------------------- 动效契约（M3 同构） */

const MOTION_CSS = `
.motion #motion-bar{position:absolute;left:0;right:auto;bottom:0;height:10px;width:0;
background:rgba(17,24,39,.42);z-index:9;border-radius:0 6px 6px 0}
`;

const MOTION_BAR = '<div id="motion-bar"></div>';

/**
 * 确定性动效契约：__ready / __recording / __seek(t)。
 * 页面不使用 CSS animation，画面是 t 的纯函数——逐帧截图前调用 __seek(t)
 * 再等两帧 rAF，同 t 同像素（与 huashu-design render-video-seek 同构）。
 * M3-a 参数化时长；M3-b 范式化（fade-seq/type-in/kenburns/sketch-grow/pop-sticker）。
 */
const MOTION_SCRIPT = (duration: number, template: string = "fade-seq"): string =>
  buildMotionScript({
    template,
    duration,
    els: ".kicker,.title,.lead,.toc,.section-title,.item,.item-text,.outro,.tag-row,.seal",
    title: ".title",
    badges: ".seal",
  });

/* ------------------------------------------------------------- 插画版式 */

const ART_PALETTES: Record<string, { paper: string; ink: string; soft: string; accent: string; second: string; third: string }> = {
  "art-chalk": { paper: "#22352C", ink: "#F4F1E4", soft: "rgba(244,241,228,.66)", accent: "#F2D06B", second: "#E98D8D", third: "#9FD6C0" },
  "art-blueprint": { paper: "#1B4F8A", ink: "#F2F6F2", soft: "rgba(242,246,242,.7)", accent: "#BFE0F2", second: "#8FC3E8", third: "#D8ECF7" },
  "art-engrave": { paper: "#F3EDE0", ink: "#2C2620", soft: "rgba(44,38,32,.64)", accent: "#8A6A45", second: "#4B3B2C", third: "#A78A67" },
  "art-watercolor": { paper: "#FBF7EE", ink: "#4A4A46", soft: "rgba(74,74,70,.6)", accent: "#E9A23B", second: "#7FA8C9", third: "#C0705F" },
};

export const ART_STYLES = [
  { key: "art-chalk", name: "黑板粉笔", group: "插画风格" },
  { key: "art-blueprint", name: "蓝图制图", group: "插画风格" },
  { key: "art-engrave", name: "单线雕刻", group: "插画风格" },
  { key: "art-watercolor", name: "铅笔水彩", group: "插画风格" },
];

export const DEFAULT_ART_STYLE = "art-chalk";

export function isArtStyle(key: unknown): boolean {
  return ART_STYLES.some((item) => item.key === String(key || "").trim());
}

export function artStyleName(key: unknown): string {
  const found = ART_STYLES.find((item) => item.key === String(key || "").trim());
  return found ? found.name : "黑板粉笔";
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seeded(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function artworkBackground(style: string, width: number, height: number, rand: () => number): string {
  const palette = ART_PALETTES[style] || ART_PALETTES[DEFAULT_ART_STYLE];
  const parts: string[] = [`<rect x="0" y="0" width="${width}" height="${height}" fill="${palette.paper}"/>`];
  if (style === "art-blueprint") {
    const step = 48;
    for (let x = step; x < width; x += step) {
      parts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${height}" stroke="${palette.ink}" stroke-opacity=".12" stroke-width="1"/>`);
    }
    for (let y = step; y < height; y += step) {
      parts.push(`<line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="${palette.ink}" stroke-opacity=".12" stroke-width="1"/>`);
    }
    parts.push(
      `<rect x="34" y="34" width="${width - 68}" height="${height - 68}" fill="none" stroke="${palette.ink}" stroke-opacity=".55" stroke-width="3"/>`,
      `<path d="M34 90 h56 M90 34 v56" stroke="${palette.ink}" stroke-opacity=".7" stroke-width="2"/>`,
      `<path d="M${width - 34} ${height - 90} h-56 M${width - 90} ${height - 34} v-56" stroke="${palette.ink}" stroke-opacity=".7" stroke-width="2"/>`,
      `<path d="M120 ${height - 52} h${width - 240}" stroke="${palette.accent}" stroke-width="1.6" stroke-dasharray="8 6"/>`
    );
  } else if (style === "art-engrave") {
    for (let index = 0; index < 26; index += 1) {
      const y = 130 + index * 34;
      parts.push(`<line x1="${width * 0.06}" y1="${y}" x2="${width * 0.94}" y2="${y}" stroke="${palette.ink}" stroke-opacity=".07" stroke-width="1.4"/>`);
    }
    parts.push(`<rect x="40" y="40" width="${width - 80}" height="${height - 80}" fill="none" stroke="${palette.ink}" stroke-opacity=".32" stroke-width="2"/>`);
  } else if (style === "art-watercolor") {
    const colors = [palette.accent, palette.second, palette.third];
    for (let index = 0; index < 7; index += 1) {
      const cx = width * (0.12 + rand() * 0.76);
      const cy = height * (0.12 + rand() * 0.76);
      const rx = 90 + rand() * 180;
      const ry = 60 + rand() * 140;
      parts.push(
        `<ellipse cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}" fill="${colors[index % 3]}" opacity=".22"/>`
      );
    }
  } else {
    for (let index = 0; index < 12; index += 1) {
      const y = height * (0.05 + rand() * 0.9);
      parts.push(
        `<path d="M${(width * rand()).toFixed(1)} ${y.toFixed(1)} h${(80 + rand() * 260).toFixed(1)}" stroke="${palette.ink}" stroke-opacity="${(0.04 + rand() * 0.07).toFixed(2)}" stroke-width="${(10 + rand() * 18).toFixed(0)}" stroke-linecap="round" stroke-dasharray="${(26 + rand() * 40).toFixed(0)} ${(8 + rand() * 18).toFixed(0)}"/>`
      );
    }
    for (let index = 0; index < 40; index += 1) {
      parts.push(
        `<circle cx="${(width * rand()).toFixed(1)}" cy="${(height * rand()).toFixed(1)}" r="${(1 + rand() * 2.6).toFixed(1)}" fill="${palette.ink}" opacity="${(0.05 + rand() * 0.14).toFixed(2)}"/>`
      );
    }
  }
  return parts.join("");
}

function artworkMotif(style: string, seed: number, width: number, height: number): string {
  const palette = ART_PALETTES[style] || ART_PALETTES[DEFAULT_ART_STYLE];
  const kind = seed % 5;
  const stroke =
    style === "art-chalk"
      ? `stroke="${palette.ink}" stroke-width="5" stroke-dasharray="7 4" stroke-linecap="round" stroke-linejoin="round" fill="none"`
      : style === "art-blueprint"
        ? `stroke="${palette.ink}" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" fill="none"`
        : `stroke="${palette.ink}" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round" fill="none"`;
  const accentLine =
    style === "art-chalk"
      ? `stroke="${palette.accent}" stroke-width="5" stroke-dasharray="6 5" stroke-linecap="round" fill="none"`
      : `stroke="${palette.accent}" stroke-width="4.6" stroke-linecap="round" fill="none"`;
  const secondLine = `stroke="${palette.second}" stroke-width="4" stroke-linecap="round" fill="none"`;
  const fills = style === "art-watercolor";
  const boxW = 620;
  const boxH = 620;
  const scale = Math.min(width / boxW, height / boxH) * 0.86;
  const offsetX = (width - boxW * scale) / 2;
  const offsetY = (height - boxH * scale) / 2;

  let motif = "";
  if (kind === 0) {
    motif = `
<circle cx="470" cy="150" r="76" ${accentLine}/>
<circle cx="470" cy="150" r="112" ${secondLine} stroke-dasharray="10 12"/>
<path d="M272 548 C268 462 256 398 292 324" ${stroke}/>
<path d="M288 432 C206 404 164 348 176 286 C246 306 280 352 286 410" ${stroke}${fills ? ` fill="${palette.third}" fill-opacity=".28"` : ""}/>
<path d="M288 384 C356 354 404 306 410 246 C338 262 296 306 286 360" ${stroke}${fills ? ` fill="${palette.accent}" fill-opacity=".24"` : ""}/>
<path d="M214 548 h132 l-20 56 h-92z" ${stroke}${fills ? ` fill="${palette.second}" fill-opacity=".22"` : ""}/>
<path d="M176 604 h208" ${stroke}/>`;
  } else if (kind === 1) {
    motif = `
<circle cx="310" cy="246" r="118" ${stroke}${fills ? ` fill="${palette.accent}" fill-opacity=".2"` : ""}/>
<path d="M252 362 h116" ${stroke}/>
<path d="M264 402 h92" ${stroke}/>
<path d="M282 442 h56" ${stroke}/>
<path d="M310 108 v-58" ${accentLine}/>
<path d="M180 130 l-42 -44" ${secondLine}/>
<path d="M440 130 l42 -44" ${secondLine}/>
<path d="M140 292 h-52" ${secondLine}/>
<path d="M480 292 h52" ${secondLine}/>
<path d="M210 520 C250 480 370 480 410 520" ${secondLine} stroke-dasharray="10 10"/>`;
  } else if (kind === 2) {
    motif = `
<path d="M112 502 C212 462 292 470 310 428 C328 470 408 462 508 502" ${stroke}${fills ? ` fill="${palette.third}" fill-opacity=".18"` : ""}/>
<path d="M310 428 V206" ${stroke}/>
<path d="M112 502 V226 C202 196 276 202 310 236 C344 202 418 196 508 226 V502" ${stroke}/>
<path d="M156 296 C216 282 266 288 284 304" ${secondLine}/>
<path d="M156 356 C216 342 266 348 284 364" ${secondLine}/>
<path d="M336 304 C354 288 404 282 464 296" ${secondLine}/>
<path d="M336 364 C354 348 404 342 464 356" ${secondLine}/>
<path d="M252 512 h116" ${accentLine}/>`;
  } else if (kind === 3) {
    motif = `
<rect x="106" y="176" width="302" height="182" rx="42" ${stroke}${fills ? ` fill="${palette.accent}" fill-opacity=".16"` : ""}/>
<path d="M172 356 l-24 74 l92 -48" ${stroke}/>
<rect x="300" y="330" width="222" height="132" rx="36" ${stroke}${fills ? ` fill="${palette.second}" fill-opacity=".2"` : ""}/>
<path d="M462 460 l26 54 l-84 -36" ${stroke}/>
<circle cx="186" cy="266" r="10" fill="${palette.ink}"/>
<circle cx="246" cy="266" r="10" fill="${palette.ink}"/>
<circle cx="306" cy="266" r="10" fill="${palette.ink}"/>
<path d="M352 394 h118" ${accentLine}/>
<path d="M352 424 h78" ${secondLine}/>`;
  } else {
    motif = `
<circle cx="324" cy="310" r="176" ${stroke}/>
<circle cx="324" cy="310" r="114" ${stroke}/>
<circle cx="324" cy="310" r="52" ${accentLine}${fills ? ` fill="${palette.accent}" fill-opacity=".24"` : ""}/>
<path d="M118 516 L448 186" ${stroke}/>
<path d="M448 186 l-6 48 M448 186 l-48 -6" ${stroke}/>
<path d="M116 514 l-4 34 M116 514 l34 -4" ${stroke}/>
<path d="M466 454 C520 418 548 370 552 322" ${secondLine} stroke-dasharray="8 12"/>`;
  }
  return `<g transform="translate(${offsetX.toFixed(1)},${offsetY.toFixed(1)}) scale(${scale.toFixed(3)})">${motif}</g>`;
}

export function renderArtworkDocument(draft: Record<string, unknown>, ctx: ArtworkContext): string {
  const style = isArtStyle(ctx.style) ? ctx.style : DEFAULT_ART_STYLE;
  const palette = ART_PALETTES[style];
  const title = cleanInline(draft.title) || "未命名笔记";
  const firstLine = String(draft.desc || "")
    .split(/\r?\n/)
    .map((line) => cleanInline(line))
    .find((line) => line && !/^\s*#/.test(line)) || "";
  const subtitle = shorten(cleanInline(draft.angle) || firstLine, ctx.scope === "wide" ? 20 : 26);
  const seed = stableHash(`${title}|${style}|${String(draft.id || "")}|${ctx.variant || 0}`);
  const rand = seeded(seed);
  const KICKERS: Record<string, string> = {
    "art-chalk": "CHALK TALK / 黑板报",
    "art-blueprint": "DRAWING / FIG.01",
    "art-engrave": "ONE LINE / 一笔",
    "art-watercolor": "SKETCH / 手绘",
  };
  const kicker = KICKERS[style] || "FIGURE";
  const wide = ctx.scope === "wide";
  const inline = ctx.scope === "inline";
  const copyWidth = wide ? 440 : inline ? 420 : 900;
  const titleSize = fitFont(title, wide ? 54 : inline ? 46 : 92, copyWidth, wide ? 3 : inline ? 2 : 3, wide ? 30 : 30);
  const subtitleSize = wide ? 22 : inline ? 22 : 27;

  const copy = `<div class="copy">
  <span class="kicker">${esc(kicker)}</span>
  <h1 style="font-size:${titleSize}px">${esc(title)}</h1>
  ${subtitle ? `<p class="sub" style="font-size:${subtitleSize}px">${esc(subtitle)}</p>` : ""}
</div>`;
  const brand = `<span class="brand">${esc(ctx.brand.brand)} · ${esc(ctx.brand.column)}</span>`;
  const bg = artworkBackground(style, ctx.width, ctx.height, rand);
  const figure = artworkMotif(style, seed, ctx.width, ctx.height);
  const scopeClass = inline ? "inline" : wide ? "wide" : "portrait";
  const vars = `--paper:${palette.paper};--ink:${palette.ink};--soft:${palette.soft};--accent:${palette.accent};--second:${palette.second};--third:${palette.third}`;

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"/>
<title>${esc(title)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:100%;height:100%;overflow:hidden;background:var(--paper)}
.art{position:relative;width:100%;height:100%;overflow:hidden;background:var(--paper);color:var(--ink);
font-family:'Microsoft YaHei','PingFang SC','Hiragino Sans GB',sans-serif;word-break:break-word;overflow-wrap:anywhere}
.art .bg{position:absolute;inset:0;width:100%;height:100%;display:block}
.copy{position:absolute;z-index:3}
.kicker{display:inline-block;font-size:19px;letter-spacing:.3em;color:var(--accent);font-weight:700;margin-bottom:16px}
h1{line-height:1.22;font-weight:800;letter-spacing:.01em;color:var(--ink)}
.sub{margin-top:14px;line-height:1.6;color:var(--soft)}
.brand{position:absolute;z-index:3;font-size:17px;letter-spacing:.2em;color:var(--soft)}
.art.inline .copy{left:64px;top:74px;width:420px}
.art.inline .brand{left:64px;bottom:52px}
.art.inline .fig{position:absolute;right:-24px;bottom:-40px;width:640px;height:640px}
.art.portrait .copy{left:84px;right:84px;bottom:120px}
.art.portrait .brand{left:84px;top:64px}
.art.portrait .fig{position:absolute;left:50%;top:90px;width:760px;height:760px;margin-left:-380px}
.art.wide .copy{left:64px;top:54px;width:440px}
.art.wide .brand{left:64px;bottom:44px}
.art.wide .fig{position:absolute;right:10px;top:-24px;width:560px;height:560px}
</style></head>
<body>
<main class="art ${style} ${scopeClass}" style="${vars}">
<svg class="bg" viewBox="0 0 ${ctx.width} ${ctx.height}" preserveAspectRatio="none">${bg}</svg>
<svg class="fig" viewBox="0 0 ${ctx.width} ${ctx.height}" aria-hidden="true">${figure}</svg>
${copy}
${brand}
</main>
</body></html>`;
}
