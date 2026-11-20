# encoding: utf-8
"""公众号富文本工具：Markdown → HTML、HTML 清洗、纯文本互转。

微信后台的正文接口接受 HTML（``content0``），实测会保留段落、标题、引用、
列表、分割线和内联样式，所以模型先写 Markdown、发布前再转成带内联样式的
HTML，比直接让模型输出 HTML 更稳。

这里只覆盖公众号排版真正用到的子集，全部用标准库实现：
- ``markdown_to_html``：标题、段落、引用、列表、分割线、图片、链接、行内样式；
- ``sanitize_html``：白名单标签，去掉脚本、事件属性与危险协议，并给常见标签
  补一套克制的中文阅读样式（已有 style 的不覆盖）；
- ``html_to_text`` / ``markdown_to_text``：派生纯文本，供字数校验和小红书复用；
- ``render``：接口层入口，返回 ``{html, text}``。
"""

from __future__ import annotations

import html as html_lib
import re
from typing import Any, Sequence

from ops.richtext_themes import HUASHENG_THEMES, THEME_ALIASES, THEME_GROUPS

__all__ = [
    "markdown_to_html",
    "markdown_to_text",
    "plain_to_html",
    "sanitize_html",
    "html_to_text",
    "html_to_markdown",
    "wrap_article",
    "render",
    "apply_theme",
    "list_themes",
    "THEMES",
]


# ------------------------------------------------------------------ 基础转义

def _esc(text: str) -> str:
    return html_lib.escape(str(text or ""), quote=False)


def _attr_esc(value: str) -> str:
    return html_lib.escape(str(value or ""), quote=True)


# ------------------------------------------------------------------ 图片

_IMAGE_ALT_SKIP = {"", "配图", "图片", "image", "img", "图"}


def _resolve_image_src(src: str, images: Sequence[str]) -> str:
    """``image:2`` 取第 2 张素材；也接受 /uploads、/assets 与 http(s) 地址。"""
    value = str(src or "").strip().strip("<>").strip()
    if not value:
        return ""
    if value.startswith("image:"):
        try:
            index = int(value.split(":", 1)[1]) - 1
        except (TypeError, ValueError):
            return ""
        if 0 <= index < len(images):
            return str(images[index])
        return ""
    if _safe_url(value, allow_data=True):
        return value
    return ""


def _image_html(alt: str, src: str, images: Sequence[str]) -> str:
    alt_text = html_lib.unescape(str(alt or "")).strip()
    url = _resolve_image_src(html_lib.unescape(str(src or "")), images)
    if not url:
        return ""
    caption = ""
    if alt_text and alt_text.lower() not in _IMAGE_ALT_SKIP:
        caption = f"<figcaption>{_esc(alt_text)}</figcaption>"
    body = f'<img src="{_attr_esc(url)}" alt="{_attr_esc(alt_text)}"/>'
    if caption:
        return f"<figure>{body}{caption}</figure>"
    return f"<p>{body}</p>"


# ------------------------------------------------------------------ 行内格式

_CODE_RE = re.compile(r"`([^`\n]+)`")
_IMAGE_RE = re.compile(r"!\[([^\]]*)\]\(([^)\n]+)\)")
_LINK_RE = re.compile(r"\[([^\]\n]+)\]\(([^)\n]+)\)")
_BOLD_RE = re.compile(r"\*\*(.+?)\*\*|__(.+?)__")
_STRIKE_RE = re.compile(r"~~(.+?)~~")
_ITALIC_RE = re.compile(r"(?<![*_])\*([^*\n]+)\*(?!\*)|(?<![A-Za-z0-9_])_([^_\n]+)_(?![A-Za-z0-9_])")


def _inline(text: str, images: Sequence[str] = ()) -> str:
    value = _esc(text)
    value = _CODE_RE.sub(lambda m: f"<code>{m.group(1)}</code>", value)
    value = _IMAGE_RE.sub(lambda m: _image_html(m.group(1), m.group(2), images), value)
    value = _LINK_RE.sub(lambda m: _link_html(m.group(1), m.group(2)), value)
    value = _BOLD_RE.sub(lambda m: f"<strong>{m.group(1) or m.group(2)}</strong>", value)
    value = _STRIKE_RE.sub(lambda m: f"<s>{m.group(1)}</s>", value)
    value = _ITALIC_RE.sub(lambda m: f"<em>{m.group(1) or m.group(2)}</em>", value)
    return value


def _link_html(label: str, href: str) -> str:
    url = _safe_url(href, allow_data=False)
    if not url:
        return label
    return f'<a href="{_attr_esc(url)}">{label}</a>'


# ------------------------------------------------------------------ Markdown 块

_FENCE_RE = re.compile(r"^```")
_HR_RE = re.compile(r"^(-{3,}|\*{3,}|_{3,})$")
_HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")
_UL_RE = re.compile(r"^[-*+]\s+(.*)$")
_OL_RE = re.compile(r"^\d+[.、]\s+(.*)$")
_IMAGE_LINE_RE = re.compile(r"^!\[([^\]]*)\]\(([^)\n]+)\)$")


def _is_block_start(line: str) -> bool:
    return bool(
        _FENCE_RE.match(line)
        or _HR_RE.match(line)
        or _HEADING_RE.match(line)
        or line.startswith(">")
        or _UL_RE.match(line)
        or _OL_RE.match(line)
        or _IMAGE_LINE_RE.match(line)
    )


def markdown_to_html(md: str, images: Sequence[str] = ()) -> str:
    """把公众号长文常用的 Markdown 子集转成 HTML（未包外层 section）。"""
    images = [str(item) for item in (images or [])]
    lines = str(md or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    blocks: list[str] = []
    index = 0
    total = len(lines)
    while index < total:
        line = lines[index]
        stripped = line.strip()
        if not stripped:
            index += 1
            continue
        if stripped.startswith("```"):
            index += 1
            buffer: list[str] = []
            while index < total and not lines[index].strip().startswith("```"):
                buffer.append(lines[index])
                index += 1
            index += 1
            blocks.append(f"<pre><code>{_esc(chr(10).join(buffer))}</code></pre>")
            continue
        if _HR_RE.match(stripped):
            blocks.append("<hr/>")
            index += 1
            continue
        heading = _HEADING_RE.match(stripped)
        if heading:
            # 标题层级收在 h2/h3，避免和外层文章标题抢层级。
            level = 3 if len(heading.group(1)) >= 3 else 2
            blocks.append(f"<h{level}>{_inline(heading.group(2), images)}</h{level}>")
            index += 1
            continue
        if stripped.startswith(">"):
            buffer = []
            while index < total and lines[index].strip().startswith(">"):
                buffer.append(lines[index].strip()[1:].strip())
                index += 1
            inner = "".join(f"<p>{_inline(item, images)}</p>" for item in buffer if item)
            blocks.append(f"<blockquote>{inner}</blockquote>")
            continue
        if _UL_RE.match(stripped):
            buffer = []
            while index < total and _UL_RE.match(lines[index].strip()):
                buffer.append(_UL_RE.match(lines[index].strip()).group(1))
                index += 1
            items = "".join(f"<li>{_inline(item, images)}</li>" for item in buffer)
            blocks.append(f"<ul>{items}</ul>")
            continue
        if _OL_RE.match(stripped):
            buffer = []
            while index < total and _OL_RE.match(lines[index].strip()):
                buffer.append(_OL_RE.match(lines[index].strip()).group(1))
                index += 1
            items = "".join(f"<li>{_inline(item, images)}</li>" for item in buffer)
            blocks.append(f"<ol>{items}</ol>")
            continue
        image_line = _IMAGE_LINE_RE.match(stripped)
        if image_line:
            html = _image_html(image_line.group(1), image_line.group(2), images)
            if html:
                blocks.append(html)
            index += 1
            continue
        buffer = [stripped]
        index += 1
        while index < total:
            following = lines[index].strip()
            if not following or _is_block_start(following):
                break
            buffer.append(following)
            index += 1
        blocks.append(f"<p>{'<br/>'.join(_inline(item, images) for item in buffer)}</p>")
    return "\n".join(blocks)


def markdown_to_text(md: str) -> str:
    text = str(md or "")
    text = re.sub(r"```[^\n]*\n", "", text)
    text = re.sub(r"!\[[^\]]*\]\([^)\n]*\)", "", text)
    text = re.sub(r"\[([^\]\n]+)\]\([^)\n]*\)", r"\1", text)
    text = re.sub(r"(?m)^\s{0,3}#{1,6}\s*", "", text)
    text = re.sub(r"(?m)^\s*>\s?", "", text)
    text = re.sub(r"(?m)^\s*[-*+]\s+", "", text)
    text = re.sub(r"(?m)^\s*\d+[.、]\s+", "", text)
    text = re.sub(r"(?m)^\s*(-{3,}|\*{3,}|_{3,})\s*$", "", text)
    text = re.sub(r"(\*\*|__|~~|`)", "", text)
    text = re.sub(r"(?<![A-Za-z0-9])[*_](?=\S)|(?<=\S)[*_](?![A-Za-z0-9])", "", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


# ------------------------------------------------------------------ HTML 清洗

_ALLOWED_TAGS = {
    "p", "br", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "b", "em", "i", "u", "s", "del",
    "blockquote", "ul", "ol", "li", "hr", "img", "a", "figure", "figcaption",
    "section", "span", "div", "pre", "code", "table", "thead", "tbody", "tr",
    "th", "td",
}
_VOID_TAGS = {"br", "hr", "img"}
_DROP_WITH_CONTENT = (
    "script", "style", "iframe", "object", "embed", "form", "textarea", "select",
    "svg", "video", "audio", "math", "noscript", "template",
)

_DEFAULT_STYLES = {
    "p": "margin:0 0 22px;line-height:1.9;font-size:16px;color:#3f3f3f;",
    "div": "margin:0 0 22px;line-height:1.9;font-size:16px;color:#3f3f3f;",
    "h1": "margin:34px 0 16px;font-size:21px;line-height:1.45;font-weight:700;color:#111;",
    "h2": "margin:32px 0 14px;font-size:19px;line-height:1.5;font-weight:700;color:#111;",
    "h3": "margin:26px 0 12px;font-size:17px;font-weight:700;color:#111;",
    "h4": "margin:22px 0 10px;font-size:16px;font-weight:700;color:#111;",
    "blockquote": (
        "margin:0 0 22px;padding:12px 16px;border-left:3px solid #d9d9d9;"
        "background:#f7f7f7;color:#555;font-size:15px;line-height:1.85;"
    ),
    "ul": "margin:0 0 22px;padding-left:22px;",
    "ol": "margin:0 0 22px;padding-left:22px;",
    "li": "margin:6px 0;line-height:1.85;font-size:16px;color:#3f3f3f;",
    "hr": "border:none;border-top:1px solid #e6e6e6;margin:28px 0;",
    "img": "max-width:100%;height:auto;display:block;margin:10px 0 22px;",
    "figure": "margin:10px 0 22px;",
    "figcaption": "margin:6px 0 0;font-size:13px;color:#999;text-align:center;",
    "a": "color:#576b95;text-decoration:none;",
    "pre": (
        "margin:0 0 22px;padding:14px 16px;background:#f6f8fa;border-radius:6px;"
        "overflow-x:auto;font-size:14px;line-height:1.7;"
    ),
    "code": "font-family:Menlo,Consolas,monospace;font-size:0.92em;",
    "table": "width:100%;border-collapse:collapse;margin:0 0 22px;font-size:15px;",
    "th": "border:1px solid #e6e6e6;padding:8px 10px;background:#fafafa;text-align:left;",
    "td": "border:1px solid #e6e6e6;padding:8px 10px;",
}

_TAG_RE = re.compile(r"<\s*(/?)\s*([a-zA-Z][a-zA-Z0-9:-]*)((?:\"[^\"]*\"|'[^']*'|[^'\">])*)>", re.S)
_ATTR_RE = re.compile(
    r"([a-zA-Z_:][-a-zA-Z0-9_:.]*)"
    r"(?:\s*=\s*(\"([^\"]*)\"|'([^']*)'|([^\s\"'=<>`]+)))?"
)


def _bad_css(value: str) -> bool:
    lowered = str(value or "").lower()
    return any(token in lowered for token in ("javascript:", "expression(", "behavior:", "@import"))


def _safe_url(value: str, *, allow_data: bool = False) -> str:
    raw = str(value or "").strip()
    # 去掉不可见控制字符，避免 ``java\nscript:`` 这类绕过。
    raw = re.sub(r"[\x00-\x20]+", "", raw)
    lowered = raw.lower()
    if not raw:
        return ""
    if lowered.startswith(("http://", "https://", "/", "#", "mailto:")):
        return raw
    if allow_data and lowered.startswith("data:image/"):
        return raw
    return ""


def _clean_attrs(attrs_text: str) -> list[str]:
    attrs: list[str] = []
    for match in _ATTR_RE.finditer(attrs_text or ""):
        name = match.group(1).lower()
        value = (
            match.group(3)
            if match.group(3) is not None
            else match.group(4)
            if match.group(4) is not None
            else match.group(5) or ""
        )
        if name.startswith("on") or name in {
            "srcdoc", "formaction", "xlink:href", "srcset",
            "contenteditable", "spellcheck", "draggable", "tabindex",
        }:
            continue
        if name == "style":
            if _bad_css(value):
                continue
            value = re.sub(r"\s+", " ", value).strip()
            if not value:
                continue
        if name in {"href", "src"}:
            value = _safe_url(value, allow_data=name == "src")
            if not value:
                continue
        attrs.append(f'{name}="{_attr_esc(value)}"')
    return attrs


def sanitize_html(raw: str) -> str:
    """白名单清洗：删危险标签/事件属性，给常见标签补默认排版样式。"""
    text = str(raw or "")
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    for tag in _DROP_WITH_CONTENT:
        text = re.sub(rf"<\s*{tag}\b[^>]*>.*?<\s*/\s*{tag}\s*>", "", text, flags=re.S | re.I)
        text = re.sub(rf"<\s*/?\s*{tag}\b[^>]*>", "", text, flags=re.I)

    def _replace(match: re.Match[str]) -> str:
        closing, tag, attrs_text = match.group(1), match.group(2).lower(), match.group(3)
        if tag not in _ALLOWED_TAGS:
            return ""
        if closing:
            return "" if tag in _VOID_TAGS else f"</{tag}>"
        attrs = _clean_attrs(attrs_text)
        if tag == "img" and not any(item.startswith("src=") for item in attrs):
            return ""
        default = _DEFAULT_STYLES.get(tag)
        if default and not any(item.startswith("style=") for item in attrs):
            attrs.append(f'style="{default}"')
        joined = (" " + " ".join(attrs)) if attrs else ""
        if tag in _VOID_TAGS:
            return f"<{tag}{joined}/>"
        return f"<{tag}{joined}>"

    cleaned = _TAG_RE.sub(_replace, text).strip()
    # 纯文字（或在预览里直接敲出来的文本）没有块级标签，补一层段落，
    # 否则微信后台会把整篇挤成一段。
    if cleaned and not re.search(
        r"<\s*(p|div|h[1-6]|ul|ol|li|blockquote|section|figure|table|pre|hr)\b",
        cleaned,
        re.I,
    ):
        body = re.sub(r"(?:\s*<br\s*/?>\s*)+", "<br/>", cleaned)
        body = re.sub(r"^(?:<br/>)+|(?:<br/>)+$", "", body).strip()
        body = body.replace("\r\n", "\n").replace("\n", "<br/>")
        if body:
            cleaned = f"<p>{body}</p>"
    return cleaned


def html_to_text(raw: str) -> str:
    text = re.sub(r"<!--.*?-->", "", str(raw or ""), flags=re.S)
    text = re.sub(
        r"<\s*(script|style)\b[^>]*>.*?<\s*/\s*\1\s*>", "", text, flags=re.S | re.I
    )
    text = re.sub(r"<\s*(br|hr)\s*/?\s*>", "\n", text, flags=re.I)
    text = re.sub(
        r"<\s*/?\s*(p|div|h[1-6]|li|blockquote|section|figure|figcaption|tr|pre)\b[^>]*>",
        "\n\n",
        text,
        flags=re.I,
    )
    text = re.sub(r"<[^>]+>", "", text)
    text = html_lib.unescape(text).replace("\xa0", " ")
    lines = [line.strip() for line in text.splitlines()]
    text = "\n".join(lines)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _img_markdown(tag: str) -> str:
    """把单个 ``<img>`` 标签还原成 ``![alt](src)``。"""
    src = re.search(r"""src\s*=\s*["']([^"']+)["']""", tag, re.I)
    if not src:
        return ""
    alt = re.search(r"""alt\s*=\s*["']([^"']*)["']""", tag, re.I)
    url = html_lib.unescape(src.group(1)).strip()
    label = html_lib.unescape(alt.group(1)).strip() if alt else ""
    if not url or url.startswith("data:"):
        return ""
    return f"![{label}]({url})"


def _quote_markdown(inner: str) -> str:
    lines = [line.strip() for line in str(inner or "").replace("\n\n", "\n").splitlines()]
    return "\n".join(f"> {line}" if line else ">" for line in lines if line)


def html_to_markdown(raw: str) -> str:
    """把公众号正文 HTML 反向转成 Markdown，供左侧 Markdown 模式继续编辑。

    只覆盖排版用到的子集；图片网格表格会摊平成逐张图片，避免 Markdown 里
    出现没有意义的表格。
    """
    text = re.sub(r"<!--.*?-->", "", str(raw or ""), flags=re.S)
    text = re.sub(
        r"<\s*(script|style)\b[^>]*>.*?<\s*/\s*\1\s*>", "", text, flags=re.S | re.I
    )

    # 表格：图片网格只保留图片；普通表格还原成 Markdown 表格。
    def _table(match: re.Match[str]) -> str:
        block = match.group(0)
        images = [_img_markdown(tag) for tag in re.findall(r"<img\b[^>]*>", block, re.I)]
        images = [item for item in images if item]
        if images:
            return "\n\n" + "\n\n".join(images) + "\n\n"
        rows: list[list[str]] = []
        for row in re.findall(r"<tr\b[^>]*>(.*?)</tr\s*>", block, re.S | re.I):
            cells = [
                html_to_text(cell).replace("\n", " ").strip()
                for cell in re.findall(r"<t[dh]\b[^>]*>(.*?)</t[dh]\s*>", row, re.S | re.I)
            ]
            if any(cells):
                rows.append(cells)
        if not rows:
            return "\n\n"
        width = max(len(cells) for cells in rows)

        def _line(cells: list[str]) -> str:
            padded = cells + [""] * (width - len(cells))
            return "| " + " | ".join(padded) + " |"

        lines = [_line(rows[0]), "| " + " | ".join("---" for _ in range(width)) + " |"]
        lines.extend(_line(cells) for cells in rows[1:])
        return "\n\n" + "\n".join(lines) + "\n\n"

    text = re.sub(r"<table\b[^>]*>.*?</table\s*>", _table, text, flags=re.S | re.I)
    def _figure(match: re.Match[str]) -> str:
        """``<figure>`` 还原成图片 +（与 alt 不同的）图注。"""
        block = match.group(0)
        image = re.search(r"<img\b[^>]*>", block, re.I)
        caption = re.search(r"<figcaption\b[^>]*>(.*?)</figcaption\s*>", block, re.S | re.I)
        parts: list[str] = []
        alt_text = ""
        if image:
            parts.append(_img_markdown(image.group(0)))
            alt = re.search(r"""alt\s*=\s*["']([^"']*)["']""", image.group(0), re.I)
            alt_text = html_lib.unescape(alt.group(1)).strip() if alt else ""
        if caption:
            text = html_to_text(caption.group(1))
            if text and text != alt_text:
                parts.append(f"*{text}*")
        parts = [item for item in parts if item]
        return "\n\n" + "\n\n".join(parts) + "\n\n"

    text = re.sub(r"<figure\b[^>]*>.*?</figure\s*>", _figure, text, flags=re.S | re.I)
    text = re.sub(
        r"<\s*h([1-6])\b[^>]*>(.*?)<\s*/\s*h\1\s*>",
        lambda m: "\n\n" + "#" * int(m.group(1)) + " " + m.group(2).strip() + "\n\n",
        text,
        flags=re.S | re.I,
    )
    text = re.sub(
        r"<\s*li\b[^>]*>(.*?)<\s*/\s*li\s*>",
        lambda m: "\n- " + m.group(1).strip(),
        text,
        flags=re.S | re.I,
    )
    text = re.sub(r"<\s*br\b[^>]*>", "\n", text, flags=re.I)
    text = re.sub(r"<\s*hr\b[^>]*>", "\n\n---\n\n", text, flags=re.I)
    text = re.sub(
        r"<\s*p\b[^>]*>(.*?)<\s*/\s*p\s*>",
        lambda m: "\n\n" + m.group(1).strip() + "\n\n",
        text,
        flags=re.S | re.I,
    )
    text = re.sub(r"<\s*/?\s*(div|section|tbody|tr)\b[^>]*>", "\n\n", text, flags=re.I)
    text = re.sub(r"<\s*/?\s*figcaption\b[^>]*>", "", text, flags=re.I)
    text = re.sub(
        r"<\s*blockquote\b[^>]*>(.*?)<\s*/\s*blockquote\s*>",
        lambda m: "\n\n" + _quote_markdown(m.group(1)) + "\n\n",
        text,
        flags=re.S | re.I,
    )
    text = re.sub(
        r"<\s*pre\b[^>]*>(.*?)<\s*/\s*pre\s*>",
        lambda m: "\n\n```\n" + html_to_text(m.group(1)) + "\n```\n\n",
        text,
        flags=re.S | re.I,
    )

    # 行内元素
    text = re.sub(r"<img\b[^>]*>", lambda m: _img_markdown(m.group(0)), text, flags=re.I)
    text = re.sub(
        r"<\s*(strong|b)\b[^>]*>(.*?)<\s*/\s*\1\s*>",
        lambda m: "**" + m.group(2).strip() + "**",
        text,
        flags=re.S | re.I,
    )
    text = re.sub(
        r"<\s*(em|i)\b[^>]*>(.*?)<\s*/\s*\1\s*>",
        lambda m: "*" + m.group(2).strip() + "*",
        text,
        flags=re.S | re.I,
    )
    text = re.sub(
        r"<\s*code\b[^>]*>(.*?)<\s*/\s*code\s*>",
        lambda m: "`" + html_to_text(m.group(1)) + "`",
        text,
        flags=re.S | re.I,
    )
    text = re.sub(
        r"""<\s*a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>(.*?)<\s*/\s*a\s*>""",
        lambda m: f"[{html_to_text(m.group(2))}]({html_lib.unescape(m.group(1))})",
        text,
        flags=re.S | re.I,
    )

    text = re.sub(r"<[^>]+>", "", text)
    text = html_lib.unescape(text).replace("\xa0", " ")
    lines = [line.rstrip() for line in text.splitlines()]
    text = "\n".join(lines)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def plain_to_html(text: str) -> str:
    """纯文本按空行分段、单换行转 ``<br/>``，用于旧草稿兜底。"""
    blocks = [item.strip() for item in re.split(r"\n{2,}", str(text or "").strip()) if item.strip()]
    if not blocks:
        return ""
    return "".join(f"<p>{_esc(item).replace(chr(10), '<br/>')}</p>" for item in blocks)


def wrap_article(html: str) -> str:
    body = str(html or "").strip()
    if not body:
        return ""
    return f'<section style="font-size:16px;line-height:1.9;color:#3f3f3f;">{body}</section>'


def render(text: str, fmt: str = "markdown", images: Sequence[str] = ()) -> dict[str, Any]:
    """接口入口：Markdown/HTML 与预览 HTML 互转。

    ``fmt="to_markdown"`` 时反过来把已有 HTML 还原成 Markdown，供左侧
    Markdown 模式继续编辑；其余情况把输入渲染成可插入预览的 HTML。
    """
    source = str(text or "")
    fmt = str(fmt or "").lower()
    if fmt == "to_markdown":
        markdown = html_to_markdown(source)
        return {"markdown": markdown, "text": markdown}
    if fmt == "html":
        html = sanitize_html(source)
    else:
        html = sanitize_html(markdown_to_html(source, images))
    return {"html": html, "text": html_to_text(html)}


# ------------------------------------------------------------------ 一键排版

# 主题来自 huasheng_editor（花生公众号编辑器）的 13 套排版：公众号只认内联样式，
# 所以每个主题直接给出每个标签的完整 style，应用时整体替换。旧的 key
# （huasheng / latepost / ft / claude / tech）通过 THEME_ALIASES 归一，不再重复
# 保留一套同名风格。
THEMES: dict[str, dict[str, Any]] = dict(HUASHENG_THEMES)

DEFAULT_THEME = "wechat-default"


def _theme_key(theme: str) -> str:
    """把旧 key / 别名归一到 THEMES 里的主题；未知主题退回默认。"""
    key = THEME_ALIASES.get(str(theme or "").strip(), str(theme or "").strip())
    return key if key in THEMES else DEFAULT_THEME


def list_themes() -> list[dict[str, Any]]:
    """主题清单，按经典公众号 → 传统媒体 → 现代数字分组排序。"""
    order = {group: index for index, group in enumerate(THEME_GROUPS)}
    items = [
        {
            "key": key,
            "name": definition.get("name", key),
            "accent": definition.get("accent", "#3498db"),
            "group": definition.get("group", ""),
            "hint": definition.get("hint", ""),
        }
        for key, definition in THEMES.items()
    ]
    items.sort(key=lambda item: order.get(item["group"], len(order)))
    return items


def apply_theme(html: str, theme: str = "huasheng") -> str:
    """把正文里的内联样式整体换成指定主题，返回可直接发布的 HTML。

    对齐 editor.huasheng.ai 的做法：先给每个标签落主题样式，再处理标题内的
    行内元素（继承标题色，避免 strong/em 自己的颜色打架），连续图片合成
    表格网格，最后清掉首块的顶部外边距。
    """
    theme_key = _theme_key(theme)
    definition = THEMES[theme_key]
    styles = definition["styles"]
    cleaned = sanitize_html(html)
    # 重复排版时先摘掉上一次加的外层容器，避免 section 越套越多。
    wrapper = re.match(
        r'^\s*<section[^>]*data-wx-theme="[^"]*"[^>]*>', cleaned, re.I
    )
    if wrapper and cleaned.rstrip().endswith("</section>"):
        cleaned = cleaned[wrapper.end() :].rstrip()
        cleaned = cleaned[: -len("</section>")].strip()

    def _replace(match: re.Match[str]) -> str:
        closing, tag, attrs_text = match.group(1), match.group(2).lower(), match.group(3)
        style = styles.get(tag)
        if not style:
            return match.group(0)
        if closing:
            return "" if tag in _VOID_TAGS else f"</{tag}>"
        attrs = [
            item for item in _clean_attrs(attrs_text) if not item.startswith("style=")
        ]
        attrs.append(f'style="{style}"')
        joined = " " + " ".join(attrs)
        if tag in _VOID_TAGS:
            return f"<{tag}{joined}/>"
        return f"<{tag}{joined}>"

    body = _TAG_RE.sub(_replace, cleaned)
    body = _heading_inline_override(body)
    body = _group_images_as_table(body)
    body = _zero_first_margin(body)
    container = definition.get("container", "")
    if container:
        return (
            f'<section data-wx-theme="{theme_key}" style="{container}">'
            f"{body}</section>"
        )
    return body


# 标题里的行内标签不能带自己的颜色/底色，否则会出现一块块撞色。
_HEADING_INLINE_OVERRIDES = {
    "strong": "font-weight:700;color:inherit !important;background-color:transparent !important;",
    "b": "font-weight:700;color:inherit !important;background-color:transparent !important;",
    "em": "font-style:italic;color:inherit !important;background-color:transparent !important;",
    "i": "font-style:italic;color:inherit !important;background-color:transparent !important;",
    "a": "color:inherit !important;text-decoration:none !important;border-bottom:1px solid currentColor !important;background-color:transparent !important;",
    "code": "color:inherit !important;background-color:transparent !important;border:none !important;padding:0 !important;",
    "span": "color:inherit !important;background-color:transparent !important;",
    "del": "color:inherit !important;background-color:transparent !important;",
    "s": "color:inherit !important;background-color:transparent !important;",
    "u": "color:inherit !important;text-decoration:underline !important;background-color:transparent !important;",
    "ins": "color:inherit !important;text-decoration:underline !important;background-color:transparent !important;",
    "mark": "color:inherit !important;background-color:transparent !important;",
    "kbd": "color:inherit !important;background-color:transparent !important;border:none !important;padding:0 !important;",
    "sub": "color:inherit !important;background-color:transparent !important;",
    "sup": "color:inherit !important;background-color:transparent !important;",
}
_HEADING_TAG_RE = re.compile(r"<h([1-6])\b([^>]*)>(.*?)</h\1\s*>", re.S | re.I)
_INLINE_TAG_RE = re.compile(
    r"<(/?)(strong|b|em|i|a|code|span|del|s|u|ins|mark|kbd|sub|sup)\b([^>]*)>",
    re.I,
)
_HEADING_DROP_PROPS = (
    "color",
    "background",
    "background-color",
    "border",
    "border-bottom",
    "text-decoration",
    "box-shadow",
    "padding",
)


def _drop_style_props(style: str, props: tuple[str, ...]) -> str:
    kept = []
    for item in style.split(";"):
        name = item.split(":", 1)[0].strip().lower()
        if not name or name in props:
            continue
        kept.append(item.strip())
    return "; ".join(kept)


def _merge_style_attr(attrs: str, extra: str) -> str:
    match = re.search(r'style="([^"]*)"', attrs or "", re.I)
    if match:
        merged = "; ".join(part for part in (match.group(1).strip("; "), extra) if part)
        return attrs[: match.start()] + f'style="{merged}"' + attrs[match.end() :]
    return f'{attrs} style="{extra}"' if attrs else f' style="{extra}"'


def _heading_inline_override(body: str) -> str:
    def heading(match: re.Match[str]) -> str:
        level, attrs, inner = match.group(1), match.group(2), match.group(3)

        def inline(node: re.Match[str]) -> str:
            closing, tag, node_attrs = node.group(1), node.group(2).lower(), node.group(3) or ""
            override = _HEADING_INLINE_OVERRIDES.get(tag)
            if not override or closing:
                return node.group(0)
            style_match = re.search(r'style="([^"]*)"', node_attrs, re.I)
            style = _drop_style_props(style_match.group(1), _HEADING_DROP_PROPS) if style_match else ""
            merged = "; ".join(part for part in (style, override) if part)
            if style_match:
                node_attrs = (
                    node_attrs[: style_match.start()]
                    + f'style="{merged}"'
                    + node_attrs[style_match.end() :]
                )
            else:
                node_attrs = f'{node_attrs} style="{merged}"'
            return f"<{tag}{node_attrs}>"

        inner = _INLINE_TAG_RE.sub(inline, inner)
        return f"<h{level}{attrs}>{inner}</h{level}>"

    return _HEADING_TAG_RE.sub(heading, body)


# 只匹配「整段只有图片」的 p / figure；带文字的段落不动，避免把图文混排拆坏。
_IMG_ONLY_BLOCK_RE = re.compile(
    r"(?:\s*(?:<p\b[^>]*>\s*(?:<img\b[^>]*?/?>\s*)+</p>|<figure\b[^>]*>.*?</figure>))+\s*",
    re.I | re.S,
)
_IMG_TAG_RE = re.compile(r"<img\b[^>]*?/?>", re.I)
_STYLE_ATTR_RE = re.compile(r'\sstyle="[^"]*"', re.I)


def _grid_columns(count: int) -> int:
    if count == 2:
        return 2
    if count == 3:
        return 3
    if count == 4:
        return 2
    return 3


def _group_images_as_table(body: str) -> str:
    """连续 2 张以上图片排成表格网格：公众号能稳定保留，不会挤成一条线。"""

    def block(match: re.Match[str]) -> str:
        images = _IMG_TAG_RE.findall(match.group(0))
        if len(images) < 2:
            return match.group(0)
        columns = _grid_columns(len(images))
        width = f"{100 / columns:.2f}%"
        cells = []
        for image in images:
            cleaned = _STYLE_ATTR_RE.sub("", image)
            cleaned = cleaned.replace(
                "<img",
                f'<img style="width:100%;height:auto;display:block;border-radius:8px;"',
                1,
            )
            cells.append(
                f'<td style="width:{width};padding:4px;vertical-align:top;">{cleaned}</td>'
            )
        rows = "".join(
            f"<tr>{''.join(cells[index:index + columns])}</tr>"
            for index in range(0, len(cells), columns)
        )
        return (
            '<table style="width:100%;margin:20px auto;border-collapse:collapse;'
            f'table-layout:fixed;"><tbody>{rows}</tbody></table>'
        )

    return _IMG_ONLY_BLOCK_RE.sub(block, body)


def _zero_first_margin(body: str) -> str:
    """容器 padding 与首块 margin 不折叠，清掉它，正文才不会凭空多一行。"""
    match = re.match(r"^\s*<([a-z][a-z0-9]*)\b([^>]*)>", body, re.I)
    if not match or match.group(1).lower() in _VOID_TAGS:
        return body
    attrs = _merge_style_attr(match.group(2) or "", "margin-top:0 !important;")
    return f"<{match.group(1)}{attrs}>" + body[match.end() :]
