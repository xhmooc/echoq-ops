/**
 * 公众号富文本：Markdown→HTML、白名单清洗与一键排版主题。
 *
 * 与 Python 版 ops/richtext.py 对齐：清洗时只保留白名单标签并获得默认内联样式；
 * 排版时把每个标签的 style 整体替换为所选主题的样式，并处理标题内行内元素、
 * 连续图片网格与首块外边距。主题数据见 src/data/themes.ts。
 */
import { escapeHtml } from "../core/contentText";
import { THEME_ALIASES, THEME_GROUPS, THEMES } from "../data/themes";

const ALLOWED_TAGS = new Set([
  "p", "br", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i", "u", "s", "del",
  "blockquote", "ul", "ol", "li", "hr", "img", "a", "figure", "figcaption",
  "section", "span", "div", "pre", "code", "table", "thead", "tbody", "tr",
  "th", "td",
]);
const VOID_TAGS = new Set(["br", "hr", "img"]);
const DROP_WITH_CONTENT = [
  "script", "style", "iframe", "object", "embed", "form", "textarea", "select",
  "svg", "video", "audio", "math", "noscript", "template",
];

const DEFAULT_STYLES: Record<string, string> = {
  p: "margin:0 0 22px;line-height:1.9;font-size:16px;color:#3f3f3f;",
  div: "margin:0 0 22px;line-height:1.9;font-size:16px;color:#3f3f3f;",
  h1: "margin:34px 0 16px;font-size:21px;line-height:1.45;font-weight:700;color:#111;",
  h2: "margin:32px 0 14px;font-size:19px;line-height:1.5;font-weight:700;color:#111;",
  h3: "margin:26px 0 12px;font-size:17px;font-weight:700;color:#111;",
  h4: "margin:22px 0 10px;font-size:16px;font-weight:700;color:#111;",
  blockquote:
    "margin:0 0 22px;padding:12px 16px;border-left:3px solid #d9d9d9;" +
    "background:#f7f7f7;color:#555;font-size:15px;line-height:1.85;",
  ul: "margin:0 0 22px;padding-left:22px;",
  ol: "margin:0 0 22px;padding-left:22px;",
  li: "margin:6px 0;line-height:1.85;font-size:16px;color:#3f3f3f;",
  hr: "border:none;border-top:1px solid #e6e6e6;margin:28px 0;",
  img: "max-width:100%;height:auto;display:block;margin:10px 0 22px;",
  figure: "margin:10px 0 22px;",
  figcaption: "margin:6px 0 0;font-size:13px;color:#999;text-align:center;",
  a: "color:#576b95;text-decoration:none;",
  pre:
    "margin:0 0 22px;padding:14px 16px;background:#f6f8fa;border-radius:6px;" +
    "overflow-x:auto;font-size:14px;line-height:1.7;",
  code: "font-family:Menlo,Consolas,monospace;font-size:0.92em;",
  table: "width:100%;border-collapse:collapse;margin:0 0 22px;font-size:15px;",
  th: "border:1px solid #e6e6e6;padding:8px 10px;background:#fafafa;text-align:left;",
  td: "border:1px solid #e6e6e6;padding:8px 10px;",
};

/** 与 Python 的 _TAG_RE 一致：允许属性里出现成对引号与跨行。 */
const TAG_RE = /<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/gs;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function attrEsc(value: string): string {
  return escapeHtml(String(value ?? ""));
}

function badCss(value: string): boolean {
  const lowered = String(value || "").toLowerCase();
  return ["javascript:", "expression(", "behavior:", "@import"].some((token) =>
    lowered.includes(token)
  );
}

function safeUrl(value: string, allowData = false): string {
  let raw = String(value || "").trim();
  // 去掉不可见控制字符，避免 java\nscript: 这类绕过。
  raw = raw.replace(/[\x00-\x20]+/g, "");
  const lowered = raw.toLowerCase();
  if (!raw) return "";
  if (
    lowered.startsWith("http://") ||
    lowered.startsWith("https://") ||
    lowered.startsWith("/") ||
    lowered.startsWith("#") ||
    lowered.startsWith("mailto:")
  ) {
    return raw;
  }
  if (allowData && lowered.startsWith("data:image/")) return raw;
  return "";
}

const DROP_ATTRS = new Set([
  "srcdoc", "formaction", "xlink:href", "srcset",
  "contenteditable", "spellcheck", "draggable", "tabindex",
]);

function cleanAttrs(attrsText: string): string[] {
  const attrs: string[] = [];
  ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_RE.exec(attrsText || "")) !== null) {
    const name = match[1].toLowerCase();
    let value = match[3] !== undefined ? match[3] : match[4] !== undefined ? match[4] : match[5] || "";
    if (name.startsWith("on") || DROP_ATTRS.has(name)) continue;
    if (name === "style") {
      if (badCss(value)) continue;
      value = value.replace(/\s+/g, " ").trim();
      if (!value) continue;
    }
    if (name === "href" || name === "src") {
      value = safeUrl(value, name === "src");
      if (!value) continue;
    }
    attrs.push(`${name}="${attrEsc(value)}"`);
  }
  return attrs;
}

/** 白名单清洗：删危险标签/事件属性，给常见标签补默认排版样式。 */
export function sanitizeHtml(raw: string): string {
  let text = String(raw || "");
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  for (const tag of DROP_WITH_CONTENT) {
    text = text.replace(new RegExp(`<\\s*${tag}\\b[^>]*>[\\s\\S]*?<\\s*/\\s*${tag}\\s*>`, "gi"), "");
    // 未闭合的危险标签：从开标签开始整段丢弃，避免内容以纯文本残留。
    text = text.replace(new RegExp(`<\\s*${tag}\\b[^>]*>[\\s\\S]*$`, "gi"), "");
    text = text.replace(new RegExp(`<\\s*/?\\s*${tag}\\b[^>]*>`, "gi"), "");
  }
  let cleaned = text
    .replace(TAG_RE, (_all, closing: string, rawTag: string, attrsText: string) => {
      const tag = rawTag.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) return "";
      if (closing) return VOID_TAGS.has(tag) ? "" : `</${tag}>`;
      const attrs = cleanAttrs(attrsText || "");
      if (tag === "img" && !attrs.some((item) => item.startsWith("src="))) return "";
      const preset = DEFAULT_STYLES[tag];
      if (preset && !attrs.some((item) => item.startsWith("style="))) {
        attrs.push(`style="${preset}"`);
      }
      const joined = attrs.length ? ` ${attrs.join(" ")}` : "";
      return VOID_TAGS.has(tag) ? `<${tag}${joined}/>` : `<${tag}${joined}>`;
    })
    .trim();
  // 纯文字没有块级标签时补一层段落，否则微信后台会把整篇挤成一段。
  if (
    cleaned &&
    !/<\s*(p|div|h[1-6]|ul|ol|li|blockquote|section|figure|table|pre|hr)\b/i.test(cleaned)
  ) {
    let body = cleaned.replace(/(?:\s*<br\s*\/?>\s*)+/gi, "<br/>");
    body = body.replace(/^(?:<br\/>)+|(?:<br\/>)+$/g, "").trim();
    body = body.replace(/\r\n/g, "\n").replace(/\n/g, "<br/>");
    if (body) cleaned = `<p>${body}</p>`;
  }
  return cleaned;
}

export function htmlToText(raw: string): string {
  let text = String(raw || "").replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "");
  text = text.replace(/<\s*(br|hr)\s*\/?\s*>/gi, "\n");
  text = text.replace(
    /<\s*\/?\s*(p|div|h[1-6]|li|blockquote|section|figure|figcaption|tr|pre)\b[^>]*>/gi,
    "\n\n"
  );
  text = text.replace(/<[^>]+>/g, "");
  text = decodeEntities(text).replace(/\u00a0/g, " ");
  const lines = text.split("\n").map((line) => line.trim());
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&");
}

function inline(text: string): string {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" />');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return out;
}

export function markdownToHtml(markdown: string, images: string[] = []): string {
  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  const flushParagraph = (): void => {
    if (!paragraph.length) return;
    blocks.push(`<p>${paragraph.map(inline).join("<br/>")}</p>`);
    paragraph = [];
  };
  const flushList = (): void => {
    if (!list.length) return;
    blocks.push(`<ul>${list.map((item) => `<li>${inline(item)}</li>`).join("")}</ul>`);
    list = [];
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      blocks.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = line.match(/^[-*+]\s+(.*)$/);
    const ordered = line.match(/^\d+[.、]\s+(.*)$/);
    if (bullet || ordered) {
      flushParagraph();
      list.push((bullet || ordered || [])[1]);
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  for (const image of images) {
    blocks.push(`<p><img src="${escapeHtml(image)}" alt="" /></p>`);
  }
  return blocks.join("\n");
}

export function plainToHtml(text: string): string {
  const blocks = String(text || "")
    .trim()
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);
  return blocks.map((item) => `<p>${escapeHtml(item).replace(/\n/g, "<br/>")}</p>`).join("");
}

export function render(text: string, format = "markdown", images: string[] = []): Record<string, unknown> {
  const source = String(text || "");
  if (format === "to_markdown") {
    const plain = htmlToText(source);
    return { html: sanitizeHtml(source), markdown: plain, plain, text: plain };
  }
  const html = format === "html" ? sanitizeHtml(source) : sanitizeHtml(markdownToHtml(source, images));
  const plain = htmlToText(html);
  return { html, markdown: source, plain, text: plain };
}

// ------------------------------------------------------------------ 一键排版

const DEFAULT_THEME = "wechat-default";

function themeKey(theme: string): string {
  const raw = String(theme || "").trim();
  const key = THEME_ALIASES[raw] || raw;
  return THEMES[key] ? key : DEFAULT_THEME;
}

export function listThemes(): Record<string, unknown>[] {
  const order = new Map(THEME_GROUPS.map((group, index) => [group, index]));
  const items = Object.entries(THEMES).map(([key, def]) => ({
    key,
    name: def.name || key,
    accent: def.accent || "#3498db",
    group: def.group || "",
    hint: def.hint || "",
  }));
  items.sort((left, right) => (order.get(left.group) ?? 99) - (order.get(right.group) ?? 99));
  return items;
}

const HEADING_INLINE_OVERRIDES: Record<string, string> = {
  strong: "font-weight:700;color:inherit !important;background-color:transparent !important;",
  b: "font-weight:700;color:inherit !important;background-color:transparent !important;",
  em: "font-style:italic;color:inherit !important;background-color:transparent !important;",
  i: "font-style:italic;color:inherit !important;background-color:transparent !important;",
  a:
    "color:inherit !important;text-decoration:none !important;" +
    "border-bottom:1px solid currentColor !important;background-color:transparent !important;",
  code:
    "color:inherit !important;background-color:transparent !important;" +
    "border:none !important;padding:0 !important;",
  span: "color:inherit !important;background-color:transparent !important;",
  del: "color:inherit !important;background-color:transparent !important;",
  s: "color:inherit !important;background-color:transparent !important;",
  u: "color:inherit !important;text-decoration:underline !important;background-color:transparent !important;",
  ins: "color:inherit !important;text-decoration:underline !important;background-color:transparent !important;",
  mark: "color:inherit !important;background-color:transparent !important;",
  kbd: "color:inherit !important;background-color:transparent !important;border:none !important;padding:0 !important;",
  sub: "color:inherit !important;background-color:transparent !important;",
  sup: "color:inherit !important;background-color:transparent !important;",
};
const HEADING_TAG_RE = /<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1\s*>/gi;
const INLINE_TAG_RE = /<(\/?)(strong|b|em|i|a|code|span|del|s|u|ins|mark|kbd|sub|sup)\b([^>]*)>/gi;
const HEADING_DROP_PROPS = [
  "color", "background", "background-color", "border", "border-bottom",
  "text-decoration", "box-shadow", "padding",
];

function dropStyleProps(style: string, props: string[]): string {
  const kept: string[] = [];
  for (const item of String(style || "").split(";")) {
    const name = item.split(":", 1)[0].trim().toLowerCase();
    if (!name || props.includes(name)) continue;
    kept.push(item.trim());
  }
  return kept.join("; ");
}

function mergeStyleAttr(attrs: string, extra: string): string {
  const match = /style="([^"]*)"/i.exec(attrs || "");
  if (match) {
    const merged = [match[1].trim().replace(/^;|;$/g, ""), extra].filter(Boolean).join("; ");
    return attrs.slice(0, match.index) + `style="${merged}"` + attrs.slice(match.index + match[0].length);
  }
  return attrs ? `${attrs} style="${extra}"` : ` style="${extra}"`;
}

function headingInlineOverride(body: string): string {
  return body.replace(HEADING_TAG_RE, (_all, level: string, attrs: string, inner: string) => {
    const replaced = inner.replace(
      INLINE_TAG_RE,
      (node: string, closing: string, rawTag: string, nodeAttrs: string) => {
        const tag = rawTag.toLowerCase();
        const override = HEADING_INLINE_OVERRIDES[tag];
        if (!override || closing) return node;
        const styleMatch = /style="([^"]*)"/i.exec(nodeAttrs || "");
        const style = styleMatch ? dropStyleProps(styleMatch[1], HEADING_DROP_PROPS) : "";
        const merged = [style, override].filter(Boolean).join("; ");
        let nextAttrs = nodeAttrs || "";
        if (styleMatch) {
          nextAttrs =
            nextAttrs.slice(0, styleMatch.index) +
            `style="${merged}"` +
            nextAttrs.slice(styleMatch.index + styleMatch[0].length);
        } else {
          nextAttrs = `${nextAttrs} style="${merged}"`;
        }
        return `<${tag}${nextAttrs}>`;
      }
    );
    return `<h${level}${attrs}>${replaced}</h${level}>`;
  });
}

const IMG_ONLY_BLOCK_RE =
  /(?:\s*(?:<p\b[^>]*>\s*(?:<img\b[^>]*?\/?>\s*)+<\/p>|<figure\b[^>]*>[\s\S]*?<\/figure>))+\s*/gi;
const IMG_TAG_RE = /<img\b[^>]*?\/?>/gi;
const STYLE_ATTR_RE = /\sstyle="[^"]*"/gi;

function gridColumns(count: number): number {
  if (count === 2) return 2;
  if (count === 3) return 3;
  if (count === 4) return 2;
  return 3;
}

/** 连续 2 张以上图片排成表格网格：公众号能稳定保留，不会挤成一条线。 */
function groupImagesAsTable(body: string): string {
  return body.replace(IMG_ONLY_BLOCK_RE, (block: string) => {
    const images = block.match(IMG_TAG_RE) || [];
    if (images.length < 2) return block;
    const columns = gridColumns(images.length);
    const width = `${(100 / columns).toFixed(2)}%`;
    const cells = images.map((image) => {
      const cleaned = image
        .replace(STYLE_ATTR_RE, "")
        .replace("<img", '<img style="width:100%;height:auto;display:block;border-radius:8px;"');
      return `<td style="width:${width};padding:4px;vertical-align:top;">${cleaned}</td>`;
    });
    const rows: string[] = [];
    for (let index = 0; index < cells.length; index += columns) {
      rows.push(`<tr>${cells.slice(index, index + columns).join("")}</tr>`);
    }
    return (
      '<table style="width:100%;margin:20px auto;border-collapse:collapse;' +
      `table-layout:fixed;"><tbody>${rows.join("")}</tbody></table>`
    );
  });
}

function zeroFirstMargin(body: string): string {
  const match = /^\s*<([a-z][a-z0-9]*)\b([^>]*)>/i.exec(body);
  if (!match || VOID_TAGS.has(match[1].toLowerCase())) return body;
  const attrs = mergeStyleAttr(match[2] || "", "margin-top:0 !important;");
  return `<${match[1]}${attrs}>` + body.slice(match.index + match[0].length);
}

/** 把正文里的内联样式整体换成指定主题，返回可直接发布的 HTML。 */
export function applyTheme(html: string, theme = "huasheng"): string {
  const key = themeKey(theme);
  const definition = THEMES[key];
  const styles = definition.styles;
  let cleaned = sanitizeHtml(html);
  // 重复排版时先摘掉上一次加的外层容器，避免 section 越套越多。
  const wrapper = /^\s*<section[^>]*data-wx-theme="[^"]*"[^>]*>/i.exec(cleaned);
  if (wrapper && cleaned.replace(/\s+$/, "").endsWith("</section>")) {
    cleaned = cleaned.slice(wrapper[0].length).replace(/\s+$/, "");
    cleaned = cleaned.slice(0, cleaned.length - "</section>".length).trim();
  }
  let body = cleaned.replace(TAG_RE, (all: string, closing: string, rawTag: string, attrsText: string) => {
    const tag = rawTag.toLowerCase();
    const style = styles[tag];
    if (!style) return all;
    if (closing) return VOID_TAGS.has(tag) ? "" : `</${tag}>`;
    const attrs = cleanAttrs(attrsText || "").filter((item) => !item.startsWith("style="));
    attrs.push(`style="${style}"`);
    const joined = ` ${attrs.join(" ")}`;
    return VOID_TAGS.has(tag) ? `<${tag}${joined}/>` : `<${tag}${joined}>`;
  });
  body = headingInlineOverride(body);
  body = groupImagesAsTable(body);
  body = zeroFirstMargin(body);
  const container = definition.container || "";
  if (container) {
    return `<section data-wx-theme="${key}" style="${container}">${body}</section>`;
  }
  return body;
}
