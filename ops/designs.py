"""零费用设计卡片库（免费模板）。

四套风格都来自对小红书真实高赞图文笔记的拆解（2026-11 抓样 24 篇）：

- 便签纸：白底点阵 + 撕纸/纸张标题 + 手写体 + 马克笔高亮，贴近学生笔记；
- 信息卡：米白底 + 手绘下划线大标题 + 分节图标与编号，适合攻略清单；
- 杂志奶油：衬线大标题 + 细线 + 双栏条目，适合长文复盘；
- 极简黑白：近白底 + 超大黑标题 + 细编号，只留一个红色强调点。

正文按结构自动分页：封面 → 每个分节一页（≤4 条）→ 结尾页。
随机性只作用于装饰位置（胶带、下划线长度、装饰点），正文版式稳定。
渲染为本地 HTML/CSS + 无头浏览器截图，1080×1440，零费用。
"""

from __future__ import annotations

import hashlib
import html
import json
import random
import re
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import Any

from loguru import logger

from ops import config, db, proc
from ops.illustrator import _browser, _shoot

WIDTH = 1080
HEIGHT = 1440
# 公众号封面是 2.35:1 的宽幅横图（1080×460），单独一套画布与封面版式。
WIDE_WIDTH = 1080
WIDE_HEIGHT = 460
WIDE_ASPECT = "2.35:1"
RENDERER = "design-local-v4"

_LOCK = threading.Lock()

DESIGN_STYLES: list[dict[str, Any]] = [
    {
        "key": "paper",
        "name": "实拍纸感",
        "tagline": "Photo & Paper",
        "desc": "实拍封面 + 纸面带 + 手绘下划线，内页三步结构",
        "fit": "经验、方法、避坑、日常分享",
        "colors": ["#F7F4EC", "#211E19", "#C0492B"],
        "group": "new",
    },
    {
        "key": "memo",
        "name": "便签纸",
        "tagline": "Memo & Doodle",
        "desc": "白底点阵、撕纸标题、手写体与马克笔高亮",
        "fit": "学生笔记、经验分享、避坑清单",
        "colors": ["#FFFFFF", "#232323", "#FFE07A"],
        "group": "classic",
    },
    {
        "key": "guide",
        "name": "信息卡",
        "tagline": "Travel Info Card",
        "desc": "米白底、手绘下划线大标题、分节图标与编号",
        "fit": "攻略、路线、清单型干货",
        "colors": ["#FDF6E8", "#5B3A1E", "#C0492B"],
        "group": "classic",
    },
    {
        "key": "magazine",
        "name": "杂志奶油",
        "tagline": "Editorial Cream",
        "desc": "衬线大标题、发丝线、双栏条目与引文",
        "fit": "长文复盘、故事、观点",
        "colors": ["#FAF6EE", "#1B1917", "#8B2E2E"],
        "group": "classic",
    },
    {
        "key": "minimal",
        "name": "极简黑白",
        "tagline": "Quiet Minimal",
        "desc": "近白底、超大黑标题、细编号，只留一个红点",
        "fit": "专业表达、金句、方法论",
        "colors": ["#FCFCFA", "#141414", "#FF3B30"],
        "group": "classic",
    },
    {
        "key": "ink",
        "name": "索引墨",
        "tagline": "Index & Ink",
        "desc": "墨底黄数字、等距索引行、编号规则线",
        "fit": "清单、方法、数字结论、干货合集",
        "colors": ["#181614", "#F4F1EA", "#FFD447"],
        "group": "new",
    },
    {
        "key": "specimen",
        "name": "标本志",
        "tagline": "Field Notes",
        "desc": "点阵纸底、宋体巨号图版编号、博物侧栏",
        "fit": "文化、自然、知识型长文",
        "colors": ["#F7F4EC", "#241F1A", "#B8863B"],
        "group": "new",
    },
    {
        "key": "daily",
        "name": "日报",
        "tagline": "Daily Paper",
        "desc": "报纸头版、双线刊头、双栏条目与导读框",
        "fit": "复盘、事件、深度经验稿",
        "colors": ["#F3EFE6", "#1A1815", "#A63228"],
        "group": "new",
    },
    {
        "key": "cards",
        "name": "收藏卡",
        "tagline": "Field Cards",
        "desc": "深色桌面、奶油卡纸、金色描边与编号徽章",
        "fit": "清单、收藏型干货、攻略",
        "colors": ["#161412", "#F6EFDF", "#8C6B36"],
        "group": "new",
    },
]


def list_design_styles() -> list[dict[str, Any]]:
    return [
        {**dict(item), "wide": True, "canvas": design_canvas("wechat_mp")}
        for item in DESIGN_STYLES
    ]


def _style_keys() -> set[str]:
    return {item["key"] for item in DESIGN_STYLES}


def design_style(key: str) -> dict[str, Any]:
    """按 key 取模板信息；未知 key 回落到第一套，避免接口返回空模板名。"""
    for item in DESIGN_STYLES:
        if item["key"] == key:
            return dict(item)
    return dict(DESIGN_STYLES[0])


def count_design_pages(draft: dict[str, Any], platform: str = "", style: str = "") -> int:
    """这套内容在设计里一共有几页；公众号宽幅封面固定只算 1 页。

    预览里的页码（01 / 07）与这里必须一致，否则会出现「看到 7 页、只出 4 张」。
    """
    if style == "paper":
        return 1 if design_canvas(platform or draft.get("platform") or "")["key"] == "wide" else 5
    if design_canvas(platform or draft.get("platform") or "")["key"] == "wide":
        return 1
    return len(_design_pages(draft))


def design_canvas(platform: str = "") -> dict[str, Any]:
    """按平台决定画布：公众号走 2.35:1 宽幅封面，其余保持 3:4 竖版。

    返回的 ``key`` 同时用作渲染模式（``wide`` / ``portrait``），前端据此
    选择展示比例；尺寸就是最终出图像素，不再依赖裁切。
    """
    if str(platform or "").strip() == "wechat_mp":
        return {
            "key": "wide",
            "width": WIDE_WIDTH,
            "height": WIDE_HEIGHT,
            "aspect": WIDE_ASPECT,
            "label": "公众号宽幅封面",
        }
    return {
        "key": "portrait",
        "width": WIDTH,
        "height": HEIGHT,
        "aspect": "3:4",
        "label": "竖版图文",
    }


def _esc(value: Any) -> str:
    return html.escape(str(value or ""))


def _title(page: dict[str, Any]) -> str:
    if page.get("title"):
        return str(page["title"])
    for item in page.get("items") or []:
        if item.startswith("Title: "):
            return item[7:]
    return page.get("heading") or ""


def _item_text(item: dict[str, Any]) -> str:
    icon = str(item.get("icon") or "").strip()
    text = str(item.get("text") or "").strip()
    return f"{icon} {text}".strip()


def _font_size(d: dict[str, Any], base: int) -> int:
    return max(18, round(base * float(d.get("density") or 1)))


def _heading(d: dict[str, Any]) -> str:
    icon = str(d.get("subtitle") or "").strip()
    text = d.get("section") or d.get("title") or ""
    return f"{icon} {text}".strip() if icon and icon != text else text


def _split_heading(d: dict[str, Any]) -> tuple[str, str]:
    """分节标题拆成「图标 + 文字」，方便把 emoji 单独放大。"""
    icon = str(d.get("subtitle") or "").strip()
    text = str(d.get("section") or d.get("title") or "").strip()
    if icon and text.startswith(icon):
        text = text[len(icon):].strip()
    return icon, text


def _title_units(text: str) -> float:
    """按字符宽度估算标题占位：中文 1，emoji 约 1.6。"""
    icon_count = len(_ICON_RE.findall(text))
    return len(text) - icon_count + icon_count * 1.6


def _fit_title(text: str, base: int, width: int = 860, max_lines: int = 3) -> int:
    """标题优先靠换行解决：只有三行都放不下时才小幅缩字号。"""
    units = _title_units(text)
    for factor in (1.0, 0.96, 0.92, 0.88, 0.84):
        size = round(base * factor)
        per_line = max(1.0, width / size)
        if units / per_line <= max_lines - 0.35:
            return size
    return round(base * 0.8)


def _fit_wide_title(text: str, base: int, width: int, max_lines: int = 3) -> int:
    """宽幅横版的高度只有 460：标题必须收敛到 max_lines 行内，必要时继续降字号。"""
    units = _title_units(text)
    size = _fit_title(text, base, width=width, max_lines=max_lines)
    while size > 28:
        per_line = max(1.0, width / size)
        if units / per_line <= max_lines - 0.2:
            return size
        size -= 2
    # 极端长标题兜底：允许排到第 4 行，但字号不低于 32，避免横版只剩一小撮字。
    for fallback in (40, 38, 36, 34, 32):
        per_line = max(1.0, width / fallback)
        if units / per_line <= 3.85:
            return fallback
    return 30


def _fit_quote(text: str, base: int, width: int, max_lines: int = 5) -> int:
    """结尾问句按可用行数收敛字号，避免把目录顶出画布。"""
    units = _title_units(text)
    for factor in (1.0, 0.94, 0.88, 0.82, 0.78):
        size = round(base * factor)
        per_line = max(1.0, width / size)
        if units / per_line <= max_lines - 0.3:
            return size
    return round(base * 0.74)


def _list_style(top: int, bottom: int, spread: str = "space-evenly") -> str:
    """列表按可用高度均匀分布；条目少时也能撑满版心。"""
    return (
        f"top:{top}px;bottom:auto;height:{bottom - top}px;display:flex;"
        f"flex-direction:column;justify-content:{spread}"
    )


def _aside_text(d: dict[str, Any]) -> tuple[str, str]:
    """条目少时用「下一页」便签把底部收住。"""
    nxt = str(d.get("next") or "").strip()
    if nxt:
        return f"NEXT / P{d['next_page']:02d}", nxt
    return "NOTES", "先存着，出发前再看"


def _page_data(page: dict[str, Any]) -> dict[str, Any]:
    items = [dict(item) for item in page.get("items") or []]
    return {
        "title": page.get("title") or "",
        "subtitle": page.get("subtitle") or "",
        "lead": page.get("lead") or "",
        "section": page.get("section") or "",
        "items": items,
        "density": _density(items),
        "toc": list(page.get("toc") or []),
        "next": page.get("next") or "",
        "next_page": page.get("next_page") or 0,
        "kind": page["type"],
        "index": page.get("index", 1),
        "total": page.get("total", 3),
    }


# ---------------------------------------------------------------------------
# 长文案结构解析：✨/🔍 分节标题、✅/💡 条目、结尾问句
# ---------------------------------------------------------------------------

_ICON_RE = re.compile(
    "[\U0001F300-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF\u2190-\u21FF\uFE0F\u200D]"
)
_SECTION_ICONS = "✨🔍📌🎯🧩📎🔥⭐"
_BULLET_ICONS = "✅💡🔹🔸☑⚠❌👉👍🔖"


def _strip_marks(text: str) -> str:
    """只去掉 Markdown 标记和多余空白，保留 emoji 与正文。"""
    value = str(text or "").replace("**", "").replace("__", "").replace("`", "")
    value = re.sub(r"^[\s>*\-\u00b7\u2022]+", "", value)
    return re.sub(r"[ \t]+", " ", value).strip()


def _leading_icon(line: str) -> str:
    match = _ICON_RE.match(line or "")
    return match.group(0) if match else ""


def _is_section(line: str) -> bool:
    icon = _leading_icon(line)
    if not icon or icon[:1] not in _SECTION_ICONS:
        return False
    text = _ICON_RE.sub("", line).strip()
    return 0 < len(text) <= 22


def _is_bullet(line: str) -> bool:
    if not line:
        return False
    icon = _leading_icon(line)
    if icon and icon[:1] in _BULLET_ICONS:
        return True
    return bool(re.match(r"^(?:[1-9]\ufe0f?\u20e3|[\u00b7\u2022\-*]\s)", line))


def _split_line(line: str) -> tuple[str, str]:
    icon = _leading_icon(line)
    text = _strip_marks(line[len(icon):] if icon else line)
    return icon, text


def _parse_desc(desc: str) -> dict[str, Any]:
    """把正文拆成「开篇引语 + 分节条目 + 结尾问句」。"""
    lead = ""
    outro = ""
    sections: list[dict[str, Any]] = []
    loose: list[dict[str, str]] = []
    for raw in str(desc or "").splitlines():
        line = _strip_marks(raw)
        if not line or line.startswith("#"):
            continue
        if re.fullmatch(r"(#[^\s#]+\s*)+", line):
            continue
        if _is_section(line):
            icon, text = _split_line(line)
            text = re.sub(r"[\s✨🔍📌🎯🧩📎🔥⭐]+$", "", text).strip()
            sections.append({"icon": icon, "heading": text, "items": []})
            continue
        if _is_bullet(line):
            icon, text = _split_line(line)
            item = {"icon": icon, "text": text}
            if sections:
                sections[-1]["items"].append(item)
            else:
                loose.append(item)
            continue
        if not lead:
            lead = line
        elif len(line) <= 40 and sections:
            sections[-1]["items"].append({"icon": "", "text": line})
        else:
            outro = line
    if loose:
        sections.insert(0, {"icon": "", "heading": "", "items": loose})
    if not sections and lead:
        sections.append({"icon": "", "heading": "", "items": [{"icon": "", "text": lead}]})
        lead = ""
    if not outro:
        for section in reversed(sections):
            for item in reversed(section["items"]):
                if "？" in item["text"] or "?" in item["text"]:
                    outro = item["text"]
                    section["items"].remove(item)
                    break
            if outro:
                break
    return {"lead": lead, "sections": sections, "outro": outro}


def _chunk(items: list[dict[str, str]], size: int = 3) -> list[list[dict[str, str]]]:
    """每页最多 3 条；余 1 条时与上一页对半，避免出现单条页。"""
    groups = [items[i : i + size] for i in range(0, len(items), size)] or [[]]
    if len(groups) > 1 and len(groups[-1]) == 1:
        groups[-1].insert(0, groups[-2].pop())
    return groups


def _density(items: list[dict[str, Any]]) -> float:
    """条目再长也只做轻微让步，保证正文字号不低于 52px。"""
    longest = max([len(item.get("text") or "") for item in items] or [0])
    if longest <= 24:
        return 1.0
    if longest <= 38:
        return 0.98
    return 0.96


def _design_pages(draft: dict[str, Any]) -> list[dict[str, Any]]:
    parsed = _parse_desc(str(draft.get("desc") or ""))
    title = _strip_marks(draft.get("title") or "未命名笔记")
    lead = parsed["lead"] or "把这件事讲清楚，比背模板有用"
    pages: list[dict[str, Any]] = [
        {
            "type": "cover",
            "title": title,
            "subtitle": lead,
            "section": "",
            "items": [],
        }
    ]
    for section in parsed["sections"]:
        chunks = _chunk(section["items"], 3)
        for index, chunk in enumerate(chunks):
            heading = section["heading"]
            if not heading:
                heading = "重点" if len(parsed["sections"]) == 1 else ""
            continued = index > 0
            if continued:
                heading = f"{heading}（续）" if heading else "接着看"
            pages.append(
                {
                    "type": "content",
                    "title": title,
                    "subtitle": section["icon"],
                    "section": heading,
                    "continued": continued,
                    "items": chunk,
                }
            )
    outro = parsed["outro"] or "这趟下来，你最想先去哪一站？"
    pages.append(
        {
            "type": "ending",
            "title": "先存着，用得上时翻出来",
            "subtitle": outro,
            "section": "",
            "items": [],
        }
    )
    total = len(pages)
    for index, page in enumerate(pages, start=1):
        page["index"] = index
        page["total"] = total
        page["lead"] = lead
    # 目录只列真正的分节；「（续）」页是同一节的翻页，不该多算一节。
    toc = [
        {"title": page["section"] or "重点", "page": page["index"]}
        for page in pages
        if page["type"] == "content" and not page.get("continued")
    ]
    for page in pages:
        page["toc"] = toc
    content_pages = [page for page in pages if page["type"] == "content"]
    for pos, page in enumerate(content_pages):
        follower = content_pages[pos + 1] if pos + 1 < len(content_pages) else None
        page["next"] = follower["section"] if follower else ""
        page["next_page"] = follower["index"] if follower else 0
    return pages


def _foot(d: dict[str, Any], label: str) -> str:
    return (
        f'<div class="foot"><span>{_esc(label)}</span>'
        f'<span>{d["index"]:02d} / {d["total"]:02d}</span></div>'
    )


BASE_CSS = """
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:__W__px;height:__H__px}
body{overflow:hidden}
.page{position:relative;width:__W__px;height:__H__px;overflow:hidden;
word-break:break-word;overflow-wrap:anywhere}
.page h1{font-weight:inherit}
.foot{position:absolute;left:84px;right:84px;bottom:50px;display:flex;justify-content:space-between;
font-size:24px;letter-spacing:.12em;opacity:.45;z-index:8}
"""

STYLE_FONTS = {
    "memo": '"Kaiti SC","KaiTi","STKaiti","Microsoft YaHei",serif',
    "guide": '"Microsoft YaHei","PingFang SC",sans-serif',
    "magazine": '"Songti SC","STSong","SimSun",Georgia,serif',
    "minimal": '"Helvetica Neue",Arial,"Microsoft YaHei",sans-serif',
    "ink": '"Helvetica Neue",Arial,"Microsoft YaHei",sans-serif',
    "specimen": '"Songti SC","STSong","SimSun",Georgia,serif',
    "daily": '"Songti SC","STSong","SimSun",Georgia,serif',
    "cards": '"Microsoft YaHei","PingFang SC",sans-serif',
}

EMOJI_FONTS = '"Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji"'


def _font(style: str) -> str:
    """正文走设计字体，emoji 交给系统彩色字体，避免变方框或丢失。"""
    base = STYLE_FONTS[style]
    for generic in ("sans-serif", "monospace", "serif"):
        if base.endswith(generic):
            return f"{base[:-len(generic)]}{EMOJI_FONTS},{generic}"
    return f"{base},{EMOJI_FONTS}"


STYLE_CSS = {
    "memo": """
.memo{background:#fff;color:#232323;
background-image:radial-gradient(#E7E3DA 2.4px,transparent 2.4px);background-size:34px 34px}
.memo .brand{position:absolute;left:84px;top:78px;font-size:21px;letter-spacing:.3em;color:#ABA69D;z-index:2}
.memo .tape{position:absolute;width:196px;height:54px;background:#FFE9A8;opacity:.92;z-index:1}
.memo .paper{position:absolute;left:70px;right:70px;top:250px;background:#FFFDF8;
border:1px solid #EFE9DC;box-shadow:0 18px 42px rgba(120,105,80,.10);padding:64px 50px 58px}
.memo .paper h1{font-size:104px;line-height:1.26;letter-spacing:.01em;text-align:center}
.memo .paper .sub{margin-top:32px;text-align:center;font-size:41px;line-height:1.6;color:#8C877E}
.memo .cover-tip{position:absolute;left:0;right:0;top:1230px;text-align:center;font-size:35px;color:#B4AFA6;letter-spacing:.1em}
.memo .cover-toc{position:absolute;left:150px;right:150px;top:956px}
.memo .cover-toc .row{display:flex;align-items:baseline;gap:12px;font-size:32px;line-height:1.8;color:#6E685E}
.memo .cover-toc .row i{flex:1;border-bottom:1px dashed #DDD6C8;transform:translateY(-6px)}
.memo .cover-toc .row span:last-child{font-size:28px;color:#ABA69D}
.memo .arrow{position:absolute;left:492px;top:890px}
.memo .h{position:absolute;left:96px;right:96px;top:140px;font-size:76px;font-weight:700;line-height:1.24;z-index:2}
.memo .h .ico{font-size:70px;margin-right:12px}
.memo .h em{font-style:normal;background:linear-gradient(transparent 64%,#FFE07A 64%,#FFE07A 94%,transparent 94%)}
.memo .list{position:absolute;left:96px;right:96px;top:320px;bottom:150px}
.memo .item{display:flex;gap:18px;padding:26px 0;border-bottom:1px dashed #E3DDD1;align-items:flex-start}
.memo .item:last-child{border-bottom:0}
.memo .mk{width:18px;height:18px;border-radius:50%;margin-top:24px;flex:none}
.memo .item b{display:block;font-size:54px;line-height:1.56;font-weight:600;color:#2A2A2C}
.memo .aside{position:absolute;left:96px;right:96px;top:1038px;background:#FFF6D8;border:1px dashed #E6D9A8;
padding:32px 36px;transform:rotate(-1deg);box-shadow:0 10px 22px rgba(120,105,80,.08)}
.memo .aside .k{font-size:31px;line-height:1.2;letter-spacing:.14em;color:#A9976D;margin-bottom:14px}
.memo .aside .v{font-size:48px;line-height:1.45;color:#4A443A;font-weight:600}
.memo .end-sheet{position:absolute;left:64px;right:64px;top:140px;bottom:250px;background:#FFFDF8;
border:1px solid #EFE9DC;box-shadow:0 18px 42px rgba(120,105,80,.10)}
.memo .end-kicker{position:absolute;left:120px;top:196px;font-size:24px;letter-spacing:.26em;color:#ABA69D}
.memo .end-q{position:absolute;left:120px;right:120px;top:270px;bottom:270px;display:flex;
align-items:center;font-size:92px;line-height:1.52;font-weight:600;color:#2A2A2C}
.memo .end-tags{position:absolute;left:0;right:0;bottom:150px;text-align:center;font-size:30px;
letter-spacing:.06em;color:#9C968B}
.memo .fill{position:absolute;right:96px;bottom:150px;background:#FFF6D8;border:1px dashed #E6D9A8;
padding:18px 26px;font-size:33px;color:#8F887C;transform:rotate(-2deg);
box-shadow:0 8px 18px rgba(120,105,80,.08)}
""",
    "guide": """
.guide{background:#FDF6E8;color:#4A3524}
.guide .top{position:absolute;left:84px;top:74px;font-size:21px;letter-spacing:.3em;color:#B08A5A}
.guide .title{position:absolute;left:84px;right:84px;top:172px;text-align:center;font-size:112px;
font-weight:800;line-height:1.2;color:#5B3A1E;letter-spacing:.01em}
.guide .brush{position:absolute;left:50%;transform:translateX(-50%);top:596px}
.guide .sub{position:absolute;left:130px;right:130px;top:650px;text-align:center;font-size:41px;
line-height:1.66;color:#8B6A45}
.guide .toc{position:absolute;left:0;right:0;top:872px;display:flex;justify-content:center;gap:14px;flex-wrap:wrap}
.guide .pill{background:#F6E3C4;color:#8B5E2A;font-size:31px;padding:14px 30px;border-radius:999px}
.guide .cover-quote{position:absolute;left:130px;right:130px;top:1004px;text-align:center;font-size:39px;
line-height:1.7;color:#6B4A28;border-top:1px dashed #E0C9A6;padding-top:30px}
.guide .stamp{position:absolute;left:84px;bottom:148px;font-size:35px;letter-spacing:.16em;color:#C0492B}
.guide .emoji{bottom:144px;right:84px;position:absolute;font-size:56px;letter-spacing:14px;opacity:.8}
.guide .h{position:absolute;left:84px;right:84px;top:108px;display:flex;align-items:center;gap:20px;z-index:2}
.guide .h .ico{font-size:74px;line-height:1}
.guide .h .sec{font-size:80px;font-weight:800;color:#5B3A1E;line-height:1.2}
.guide .list{position:absolute;left:84px;right:84px;top:284px;bottom:148px}
.guide .item{display:grid;grid-template-columns:64px 1fr;gap:16px;padding:26px 0;
border-bottom:1px solid #EDDFC6;align-items:flex-start}
.guide .item:last-child{border-bottom:0}
.guide .idx{font-size:37px;font-weight:800;color:#C0492B;padding-top:12px;letter-spacing:.02em}
.guide .item b{display:block;font-size:54px;line-height:1.56;font-weight:500;color:#4A3524}
.guide .aside{position:absolute;left:84px;right:84px;top:1090px;border-top:1px dashed #E0C9A6;padding-top:28px}
.guide .aside .k{font-size:31px;line-height:1.2;letter-spacing:.16em;color:#B08A5A;margin-bottom:16px}
.guide .aside .v{font-size:50px;line-height:1.42;color:#5B3A1E;font-weight:700}
.guide .fill{position:absolute;left:84px;right:84px;bottom:136px;border-top:1px dashed #E0C9A6;
padding-top:20px;font-size:33px;letter-spacing:.12em;color:#B08A5A;text-align:center}
.guide .end-kicker{position:absolute;left:84px;top:74px;font-size:21px;letter-spacing:.3em;color:#B08A5A}
.guide .end-q{position:absolute;left:84px;right:84px;top:200px;bottom:190px;display:flex;
align-items:center;font-size:96px;line-height:1.55;font-weight:700;color:#4A3524}
.guide .end-tags{position:absolute;left:84px;right:84px;bottom:150px;text-align:center;font-size:30px;
letter-spacing:.08em;color:#8B6A45}
""",
    "magazine": """
.magazine{background:#FAF6EE;color:#1B1917}
.magazine .mast{position:absolute;left:84px;right:84px;top:72px;display:flex;justify-content:space-between;
font-size:19px;letter-spacing:.26em;border-bottom:1px solid #1B1917;padding-bottom:14px}
.magazine .title{position:absolute;left:84px;right:96px;top:250px;font-size:108px;line-height:1.22;
font-weight:600;letter-spacing:.01em}
.magazine .deck{position:absolute;left:84px;top:666px;width:660px;font-size:39px;line-height:1.7;color:#5C5346}
.magazine .orn{position:absolute;width:210px;height:210px;border:1px solid #8B2E2E;border-radius:50%;opacity:.55}
.magazine .meta{position:absolute;right:84px;top:672px;width:210px;font-size:23px;line-height:1.9;color:#8A8174;text-align:center}
.magazine .toc{position:absolute;left:84px;right:84px;bottom:124px}
.magazine .toc-row{display:flex;align-items:baseline;gap:14px;font-size:31px;line-height:2.05;color:#3B342A}
.magazine .toc-row i{flex:1;border-bottom:1px dotted #BDB3A2;transform:translateY(-6px)}
.magazine .toc-row span:last-child{font-size:25px;color:#8A8174;letter-spacing:.1em}
.magazine .kicker{position:absolute;left:84px;top:114px;font-size:27px;line-height:1.2;
letter-spacing:.26em;color:#8B2E2E;z-index:2}
.magazine .h{position:absolute;left:84px;right:84px;top:176px;font-size:78px;line-height:1.26;
font-weight:600;border-bottom:1px solid #1B1917;padding-bottom:24px;z-index:2}
.magazine .rows{position:absolute;left:84px;right:150px;top:342px;height:758px;display:flex}
.magazine .cover-note{position:absolute;left:84px;right:84px;top:918px;border-top:1px solid #1B1917;
padding-top:22px;font-size:30px;letter-spacing:.14em;color:#8A8174}
.magazine .rows.single{right:150px}
.magazine .col{flex:1;display:flex;flex-direction:column;justify-content:space-evenly}
.magazine .item{padding:18px 0 20px;border-bottom:1px solid #E0D7C6}
.magazine .num{font-size:31px;letter-spacing:.14em;color:#8B2E2E;margin-bottom:8px}
.magazine .item b{display:block;font-size:56px;line-height:1.5;font-weight:400}
.magazine .rows.single .item b{font-size:56px;line-height:1.5}
.magazine .pull{position:absolute;left:84px;bottom:136px;width:700px;font-size:35px;line-height:1.65;
color:#8B2E2E;font-style:italic;border-top:1px solid #8B2E2E;border-bottom:1px solid #8B2E2E;padding:18px 0}
.magazine .fill{position:absolute;left:84px;right:84px;bottom:122px;border-top:1px solid #1B1917;
padding-top:20px;font-size:28px;letter-spacing:.16em;color:#8A8174;text-align:center}
.magazine .end-kicker{position:absolute;left:84px;right:84px;top:72px;display:flex;
justify-content:space-between;font-size:19px;letter-spacing:.26em;border-bottom:1px solid #1B1917;
padding-bottom:14px}
.magazine .end-mark{position:absolute;left:74px;top:210px;font-family:Georgia,"Songti SC",serif;
font-size:220px;line-height:.7;color:#8B2E2E}
.magazine .end-q{position:absolute;left:84px;right:84px;top:400px;bottom:190px;display:flex;
align-items:center;font-size:96px;line-height:1.55;font-weight:600}
.magazine .end-tags{position:absolute;left:84px;right:84px;bottom:150px;text-align:center;font-size:29px;
letter-spacing:.08em;color:#8A8174}
""",
    "minimal": """
.minimal{background:#FCFCFA;color:#141414}
.minimal .dot{position:absolute;width:12px;height:12px;border-radius:50%;background:#FF3B30}
.minimal .title{position:absolute;left:110px;right:110px;top:286px;text-align:center;font-size:106px;
font-weight:800;line-height:1.26;letter-spacing:-.01em}
.minimal .sub{position:absolute;left:130px;right:130px;top:742px;text-align:center;font-size:38px;
line-height:1.72;color:#8A8A8A}
.minimal .cover-list{position:absolute;left:130px;right:130px;top:980px;text-align:center;
font-size:35px;line-height:2.05;color:#A7A7A2;letter-spacing:.02em}
.minimal .cover-note{position:absolute;left:0;right:0;top:1210px;text-align:center;
font-size:31px;letter-spacing:.4em;color:#C9C9C4}
.minimal .h{position:absolute;left:110px;right:110px;top:152px;display:flex;align-items:baseline;gap:22px}
.minimal .h .ico{font-size:68px}
.minimal .h .sec{font-size:80px;font-weight:700;letter-spacing:-.01em;line-height:1.16}
.minimal .list{position:absolute;left:110px;right:110px;top:330px;bottom:160px}
.minimal .item{display:grid;grid-template-columns:92px 1fr;gap:24px;padding:32px 0;align-items:flex-start}
.minimal .idx{font-size:35px;letter-spacing:.12em;color:#B9B9B4;padding-top:14px}
.minimal .item b{display:block;font-size:54px;line-height:1.56;font-weight:500}
.minimal .aside{position:absolute;left:110px;right:110px;top:1058px;border-top:1px solid #E6E6E2;padding-top:30px}
.minimal .aside .k{font-size:29px;line-height:1.2;letter-spacing:.18em;color:#B9B9B4;margin-bottom:16px}
.minimal .aside .v{font-size:48px;line-height:1.45;font-weight:600}
.minimal .fill{position:absolute;left:110px;right:110px;bottom:116px;border-top:1px solid #ECECE8;
padding-top:20px;display:flex;justify-content:space-between;font-size:28px;letter-spacing:.2em;color:#B9B9B4}
.minimal .end-kicker{position:absolute;left:110px;top:130px;font-size:29px;letter-spacing:.34em;color:#B9B9B4}
.minimal .end-q{position:absolute;left:110px;right:110px;top:210px;bottom:190px;display:flex;
align-items:center;font-size:104px;line-height:1.5;font-weight:700;letter-spacing:-.01em}
.minimal .end-tags{position:absolute;left:110px;right:110px;bottom:150px;font-size:30px;
letter-spacing:.16em;color:#A7A7A2}
""",
    "ink": """
.ink{background:#F4F1EA;color:#181614}
.ink .top{position:absolute;left:84px;right:84px;top:68px;display:flex;justify-content:space-between;
font-size:22px;letter-spacing:.28em;color:#8B8578}
.ink .big{position:absolute;left:70px;top:210px;font-size:260px;line-height:.9;font-weight:900;
letter-spacing:-.05em;color:#FFD447}
.ink .title{position:absolute;left:84px;right:96px;top:540px;font-size:100px;line-height:1.26;
font-weight:900;letter-spacing:-.01em}
.ink .sub{position:absolute;left:84px;right:180px;top:940px;font-size:38px;line-height:1.7;color:#6E685C}
.ink .cover-index{position:absolute;left:84px;right:84px;top:1080px;bottom:170px;display:flex;
flex-direction:column;justify-content:space-evenly;border-top:2px solid #181614;padding-top:10px}
.ink .cover-index .row{display:flex;align-items:baseline;gap:14px;font-size:30px;line-height:1.7;color:#3A362E}
.ink .cover-index .row b{font-weight:600}
.ink .cover-index .row i{flex:1;border-bottom:1px dotted #BFB9AB;transform:translateY(-5px)}
.ink .cover-index .row span:last-child{font-size:26px;color:#8B8578}
.ink .kicker{position:absolute;left:84px;top:92px;font-size:24px;letter-spacing:.24em;color:#8B8578}
.ink .head{position:absolute;left:84px;right:84px;top:196px;display:grid;
grid-template-columns:minmax(0,1fr) auto;column-gap:30px;align-items:start}
.ink .pageno{font-size:110px;font-weight:900;line-height:1;color:#E2DCCD;justify-self:end;
white-space:nowrap}
.ink .h{font-size:86px;font-weight:900;line-height:1.22;letter-spacing:-.01em;min-width:0}
.ink .h .ico{margin-right:14px}
.ink .rule{position:absolute;left:84px;right:84px;top:470px;height:8px;background:#181614}
.ink .list{position:absolute;left:84px;right:84px;top:510px;bottom:250px;display:flex;
flex-direction:column;justify-content:space-evenly}
.ink .item{display:grid;grid-template-columns:96px 1fr;gap:20px;padding:26px 0;
border-bottom:2px solid #181614;align-items:flex-start}
.ink .item:first-child{border-top:2px solid #181614}
.ink .no{font-size:40px;font-weight:900;color:#B39A3F;padding-top:10px}
.ink .item b{display:block;font-size:54px;line-height:1.55;font-weight:500}
.ink .foot-note{position:absolute;left:84px;right:84px;bottom:172px;display:flex;justify-content:space-between;
border-top:1px solid #C9C2B2;padding-top:18px;font-size:26px;letter-spacing:.14em;color:#8B8578}
.ink .stripe{position:absolute;left:0;right:0;bottom:0;height:14px;background:#FFD447}
.ink .end-ink{position:absolute;inset:0;background:#181614}
.ink .end-kicker{position:absolute;left:84px;top:70px;font-size:22px;letter-spacing:.28em;color:#8B8578}
.ink .end-mark{position:absolute;left:60px;top:150px;font-family:Georgia,"Songti SC",serif;
font-size:240px;line-height:.8;font-weight:900;color:#FFD447}
.ink .end-q{position:absolute;left:84px;right:84px;top:400px;bottom:190px;display:flex;
align-items:center;font-size:96px;line-height:1.56;font-weight:700;color:#F7F3E8}
.ink .end-tags{position:absolute;left:84px;right:84px;bottom:150px;font-size:28px;letter-spacing:.12em;
color:#C9C2B2}
.ink .end-ink ~ .foot{color:#C9C2B2}
""",
    "specimen": """
.specimen{background:#F7F4EC;color:#241F1A;
background-image:radial-gradient(#DED8CA 2px,transparent 2px);background-size:38px 38px}
.specimen .mast{position:absolute;left:84px;right:84px;top:62px;display:flex;align-items:flex-end;
justify-content:space-between;border-bottom:2px solid #241F1A;padding-bottom:14px;
font-size:22px;letter-spacing:.2em;color:#6E6558}
.specimen .plate-no{position:absolute;left:68px;top:170px;font-family:Georgia,"Songti SC",serif;
font-size:310px;line-height:.88;letter-spacing:-.04em;color:#B8863B}
.specimen .title{position:absolute;left:84px;right:90px;top:530px;font-size:100px;line-height:1.28;
font-weight:900}
.specimen .sub{position:absolute;left:84px;right:120px;top:940px;font-size:37px;line-height:1.72;color:#6E6558}
.specimen .facts{position:absolute;left:84px;right:84px;top:1110px;display:grid;
grid-template-columns:1fr 1fr;gap:30px}
.specimen .fact{border-top:1px solid #241F1A;padding-top:14px}
.specimen .fact b{display:block;font-family:Georgia,serif;font-size:72px;line-height:1;font-weight:500}
.specimen .fact span{display:block;margin-top:8px;font-size:23px;line-height:1.5;color:#6E6558}
.specimen .cover-foot{position:absolute;left:84px;right:84px;bottom:120px;display:flex;
justify-content:space-between;font-size:24px;letter-spacing:.14em;color:#6E6558}
.specimen .kicker{position:absolute;left:84px;top:92px;font-size:23px;letter-spacing:.24em;color:#6E6558}
.specimen .plate-tag{position:absolute;right:84px;top:92px;font-family:Georgia,serif;font-size:23px;
letter-spacing:.16em;color:#B8863B}
.specimen .h{position:absolute;left:84px;right:84px;top:180px;font-size:92px;font-weight:900;line-height:1.26}
.specimen .rule{position:absolute;left:84px;right:84px;top:560px;border-top:2px solid #241F1A}
.specimen .list{position:absolute;left:84px;right:84px;top:600px;bottom:260px;display:flex;
flex-direction:column;justify-content:space-evenly}
.specimen .item{display:grid;grid-template-columns:82px 1fr;gap:20px;align-items:flex-start;
padding:18px 0;border-bottom:1px solid #C9C2B2}
.specimen .item:last-child{border-bottom:0}
.specimen .badge{width:60px;height:60px;border-radius:50%;border:2px solid #241F1A;color:#241F1A;
font-family:Georgia,serif;font-size:30px;display:flex;align-items:center;justify-content:center;margin-top:4px}
.specimen .item b{display:block;font-size:53px;line-height:1.58;font-weight:500}
.specimen .strip{position:absolute;left:84px;right:84px;bottom:160px;display:flex;align-items:center;
gap:24px;border-top:2px solid #241F1A;padding-top:18px}
.specimen .strip .ico{font-size:76px;line-height:1}
.specimen .strip .cap{font-size:26px;line-height:1.5;letter-spacing:.1em;color:#6E6558}
.specimen .end-kicker{position:absolute;left:84px;top:92px;font-size:23px;letter-spacing:.24em;color:#6E6558}
.specimen .end-label{position:absolute;left:84px;right:84px;top:220px;bottom:320px;
border:2px solid #241F1A;background:rgba(247,244,236,.72)}
.specimen .end-q{position:absolute;left:140px;right:140px;top:260px;bottom:340px;display:flex;
align-items:center;font-size:96px;line-height:1.56;font-weight:700}
.specimen .end-tags{position:absolute;left:84px;right:84px;bottom:150px;text-align:center;font-size:29px;
letter-spacing:.08em;color:#6E6558}
""",
    "daily": """
.daily{background:#F3EFE6;color:#1A1815}
.daily .mast{position:absolute;left:84px;right:84px;top:58px;text-align:center}
.daily .mast b{display:block;font-size:80px;letter-spacing:.28em;font-weight:900}
.daily .mast .meta{display:flex;justify-content:space-between;margin-top:16px;font-size:21px;
letter-spacing:.16em;color:#6E675D}
.daily .rules{position:absolute;left:84px;right:84px;top:212px;height:18px;
border-top:7px solid #1A1815;border-bottom:2px solid #1A1815}
.daily .headline{position:absolute;left:84px;right:84px;top:286px;font-size:96px;line-height:1.28;font-weight:900}
.daily .dek{position:absolute;left:84px;right:84px;top:700px;font-size:36px;line-height:1.72;color:#4E473C;
border-top:1px solid #1A1815;border-bottom:1px solid #1A1815;padding:24px 0}
.daily .brief{position:absolute;left:84px;right:84px;top:930px;bottom:170px;
border:3px solid #1A1815;padding:24px 30px}
.daily .brief .k{font-size:23px;letter-spacing:.2em;color:#A63228;margin-bottom:14px}
.daily .brief .row{display:flex;gap:12px;align-items:baseline;font-size:29px;line-height:1.95}
.daily .brief .row span:first-child{font-weight:900;color:#A63228;flex:none}
.daily .brief .row i{flex:1;border-bottom:1px dotted #B9B1A2;transform:translateY(-5px)}
.daily .brief .row span:last-child{font-size:25px;color:#6E675D}
.daily .band{position:absolute;left:84px;right:84px;top:86px;background:#1A1815;color:#F3EFE6;
padding:20px 26px;display:flex;justify-content:space-between;align-items:center;gap:18px}
.daily .band .s{font-size:24px;letter-spacing:.14em;color:#C9C2B2;flex:none}
.daily .band .sec{font-size:76px;font-weight:900;line-height:1.22;text-align:right}
.daily .list{position:absolute;left:84px;right:84px;top:380px;bottom:300px;display:grid;
grid-template-columns:1fr 1fr;grid-auto-rows:1fr;gap:0 44px}
.daily .list.two{display:flex;flex-direction:column;justify-content:space-evenly}
.daily .list.two .item{align-self:stretch}
.daily .item{padding:24px 0;border-bottom:1px solid #1A1815;align-self:start}
.daily .item.wide{grid-column:1 / -1}
.daily .num{font-size:25px;font-weight:900;color:#A63228;letter-spacing:.12em;margin-bottom:6px}
.daily .item b{display:block;font-size:53px;line-height:1.55;font-weight:500}
.daily .note{position:absolute;left:84px;right:84px;bottom:160px;border:2px solid #1A1815;
padding:18px 24px;font-size:28px;line-height:1.6;color:#4E473C}
.daily .note b{display:block;font-size:23px;letter-spacing:.16em;color:#A63228;margin-bottom:4px}
.daily .end-head{position:absolute;left:84px;right:84px;top:320px;bottom:300px;display:flex;
align-items:center;font-size:96px;line-height:1.3;font-weight:900}
.daily .end-kw{position:absolute;left:84px;right:84px;bottom:210px;font-size:23px;
letter-spacing:.2em;color:#A63228}
.daily .end-tags{position:absolute;left:84px;right:84px;bottom:126px;font-size:29px;line-height:1.7;
color:#4E473C}
""",
    "cards": """
.cards{background:#161412;color:#F2EBDD;
background-image:radial-gradient(circle at 50% 0%,#2E2821 0%,#161412 62%)}
.cards .top{position:absolute;left:84px;right:84px;top:66px;display:flex;justify-content:space-between;
font-size:21px;letter-spacing:.24em;color:#A79C89}
.cards .backcard{position:absolute;left:116px;right:116px;top:236px;bottom:344px;border:2px solid #8C6B36;
border-radius:26px;transform:rotate(2.4deg);opacity:.55}
.cards .bigcard{position:absolute;left:84px;right:84px;top:200px;bottom:300px;background:#F6EFDF;
color:#1D1913;border-radius:26px;padding:50px 46px;box-shadow:0 30px 60px rgba(0,0,0,.45);
transform:rotate(-1.2deg)}
.cards .bigcard .k{font-size:22px;letter-spacing:.24em;color:#8C6B36}
.cards .bigcard .stamp{position:absolute;right:40px;top:36px;border:2px solid #8C6B36;border-radius:999px;
padding:8px 20px;font-size:20px;letter-spacing:.14em;color:#8C6B36}
.cards .bigcard .title{position:absolute;left:46px;right:46px;top:140px;font-size:96px;
line-height:1.26;font-weight:900;letter-spacing:-.01em}
.cards .bigcard .sub{position:absolute;left:46px;right:46px;bottom:110px;font-size:35px;
line-height:1.7;color:#6E6252}
.cards .chips{position:absolute;left:84px;right:84px;bottom:160px;display:flex;gap:12px;
flex-wrap:wrap;justify-content:center}
.cards .chip{border:1px solid #5A5145;border-radius:999px;padding:9px 20px;font-size:23px;color:#C9C0AF}
.cards .h{position:absolute;left:84px;right:84px;top:92px;display:flex;align-items:baseline;
justify-content:space-between;gap:20px}
.cards .h .sec{font-size:80px;font-weight:900;line-height:1.2}
.cards .h .no{font-size:24px;letter-spacing:.2em;color:#A79C89;flex:none}
.cards .list{position:absolute;left:84px;right:84px;top:260px;bottom:180px;display:flex;
flex-direction:column;justify-content:space-evenly;gap:22px}
.cards .item{background:#F6EFDF;color:#1D1913;border-radius:20px;padding:24px 30px;
border:2px solid #8C6B36;box-shadow:0 16px 32px rgba(0,0,0,.35);display:grid;
grid-template-columns:80px 1fr;gap:14px;align-items:start}
.cards .item:nth-child(2){transform:rotate(.5deg)}
.cards .item:nth-child(3){transform:rotate(-.5deg)}
.cards .badge{width:60px;height:60px;border-radius:50%;background:#1D1913;color:#F6EFDF;
font-size:26px;font-weight:900;display:flex;align-items:center;justify-content:center;margin-top:4px}
.cards .item b{display:block;font-size:53px;line-height:1.55;font-weight:500}
.cards .tip{position:absolute;left:84px;right:84px;bottom:120px;text-align:center;font-size:24px;
letter-spacing:.2em;color:#A79C89}
.cards .end-card{position:absolute;left:84px;right:84px;top:150px;bottom:290px;background:#F6EFDF;
color:#1D1913;border-radius:26px;border:2px solid #8C6B36;padding:56px 48px;
box-shadow:0 30px 60px rgba(0,0,0,.45)}
.cards .end-kicker{position:absolute;left:132px;top:210px;font-size:22px;letter-spacing:.24em;
color:#8C6B36}
.cards .end-q{position:absolute;left:132px;right:132px;top:290px;bottom:330px;display:flex;
align-items:center;font-size:92px;line-height:1.56;font-weight:700;color:#1D1913}
.cards .end-tags{position:absolute;left:84px;right:84px;bottom:150px;text-align:center;font-size:27px;
letter-spacing:.1em;color:#C9C0AF}
""",
}


WIDE_CSS = """
.wide .foot{left:56px;right:56px;bottom:22px;font-size:18px;letter-spacing:.16em;opacity:.5}
.w-stage{position:absolute;left:56px;right:56px;top:34px;bottom:56px;display:flex;
align-items:center;gap:38px;z-index:2}
.w-copy{position:relative;flex:1;min-width:0}
.w-title{font-size:58px;line-height:1.2;font-weight:800;letter-spacing:-.005em}
.w-sub{margin-top:12px;font-size:21px;line-height:1.55;opacity:.68;max-width:720px}
.w-kicker{font-size:17px;line-height:1.4;letter-spacing:.26em;opacity:.55;margin-bottom:12px}
.w-note{font-size:18px;line-height:1.65;letter-spacing:.06em;opacity:.62}
.w-tags{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.w-tag{font-size:16px;line-height:1.3;padding:4px 12px;border:1px solid currentColor;
border-radius:999px;opacity:.6;white-space:nowrap}
.w-side{position:relative;flex:none;align-self:center;display:flex;flex-direction:column;
justify-content:center;gap:12px}
.w-toc{display:flex;flex-direction:column;gap:8px}
.w-toc .row{display:flex;align-items:baseline;gap:10px;font-size:16px;line-height:1.5;opacity:.72}
.w-toc .row i{flex:1;border-bottom:1px dashed currentColor;opacity:.35;transform:translateY(-4px)}
.w-toc .row span:last-child{font-size:14px;opacity:.85}
"""

WIDE_STYLE_CSS = {
    "memo": """
.memo.wide{background:#fff}
.memo.wide::after{content:"";position:absolute;left:46px;right:46px;top:22px;bottom:46px;
background:#FFFDF8;border:1px solid #EFE9DC;box-shadow:0 14px 34px rgba(120,105,80,.10);z-index:1}
.memo.wide .w-stage{left:82px;right:82px;top:38px;bottom:60px}
.memo.wide .w-tape{position:absolute;width:126px;height:30px;background:#FFE9A8;opacity:.9;z-index:3}
.memo.wide .brand{position:static;color:#ABA69D;margin-bottom:10px}
.memo.wide .w-title{color:#232323}
.memo.wide .w-sub{color:#8C877E;opacity:1}
.memo.wide .w-note{color:#8C877E}
.memo.wide .w-tag{color:#8C877E}
.memo.wide .w-side{width:250px;align-items:flex-start}
.memo.wide .w-arrow{display:block;margin-top:6px;color:#CFC8BB}
""",
    "guide": """
.guide.wide .w-stage{left:72px;right:72px;top:40px;bottom:58px}
.guide.wide .top{position:static;color:#B08A5A;margin-bottom:10px}
.guide.wide .w-title{color:#5B3A1E;font-weight:800}
.guide.wide .w-brush{display:block;margin:8px 0 2px}
.guide.wide .w-sub{color:#8B6A45;opacity:1}
.guide.wide .w-side{width:286px;align-items:stretch}
.guide.wide .toc{position:static;display:flex;flex-direction:column;align-items:flex-start;gap:9px}
.guide.wide .w-note{color:#C0492B;letter-spacing:.12em;margin-top:4px}
""",
    "magazine": """
.magazine.wide .mast{top:30px;font-size:16px;padding-bottom:8px}
.magazine.wide .w-stage{left:84px;right:84px;top:54px;bottom:96px;gap:46px}
.magazine.wide .w-title{color:#1B1917;font-weight:600;letter-spacing:.005em}
.magazine.wide .w-sub{color:#5C5346;opacity:1}
.magazine.wide .w-side{width:196px;align-items:center;text-align:center}
.magazine.wide .orn{position:static;width:132px;height:132px;margin:0 auto}
.magazine.wide .meta{position:static;width:auto;font-size:15px;line-height:1.9;color:#8A8174}
.magazine.wide .w-rule{position:absolute;left:84px;right:84px;bottom:76px;border-top:1px solid #1B1917;
padding-top:8px;font-size:16px;letter-spacing:.14em;color:#8A8174;z-index:2}
""",
    "minimal": """
.minimal.wide .w-stage{left:104px;right:96px;top:40px;bottom:58px;gap:52px}
.minimal.wide .w-dot{position:absolute;left:60px;top:56px;width:10px;height:10px;border-radius:50%;
background:#FF3B30}
.minimal.wide .w-title{color:#141414;font-weight:800;letter-spacing:-.01em}
.minimal.wide .w-sub{color:#8A8A8A;opacity:1}
.minimal.wide .w-side{width:250px;align-items:flex-start}
.minimal.wide .cover-list{position:static;text-align:left;font-size:17px;line-height:1.9;
color:#A7A7A2;letter-spacing:.02em}
.minimal.wide .w-note{color:#C9C9C4;letter-spacing:.32em}
""",
    "ink": """
.ink.wide .w-stage{left:84px;right:84px;top:36px;bottom:60px;gap:30px}
.ink.wide .w-big{position:absolute;right:40px;top:4px;font-size:188px;line-height:.9;font-weight:900;
letter-spacing:-.06em;color:#FFD447;z-index:1}
.ink.wide .top{position:static;color:#8B8578;margin-bottom:12px;justify-content:flex-start;gap:26px}
.ink.wide .w-title{color:#181614;font-weight:900;letter-spacing:-.01em}
.ink.wide .w-copy{max-width:660px}
.ink.wide .w-sub{color:#6E685C;opacity:1;max-width:620px}
.ink.wide .w-note{color:#8B8578;margin-top:14px;letter-spacing:.14em}
.ink.wide .w-stripe{position:absolute;left:0;right:0;bottom:0;height:10px;background:#FFD447;z-index:2}
""",
    "specimen": """
.specimen.wide{background:#F7F4EC}
.specimen.wide .mast{top:32px;padding-bottom:8px;font-size:16px}
.specimen.wide .w-plate{position:absolute;right:52px;top:40px;font-family:Georgia,"Songti SC",serif;
font-size:132px;line-height:.9;letter-spacing:-.04em;color:#B8863B;opacity:.9;z-index:1}
.specimen.wide .w-stage{left:84px;right:84px;top:66px;bottom:136px;gap:34px}
.specimen.wide .w-copy{max-width:700px}
.specimen.wide .w-title{color:#241F1A;font-weight:900}
.specimen.wide .w-sub{color:#6E6558;opacity:1}
.specimen.wide .facts{position:absolute;left:84px;right:84px;bottom:64px;top:auto;display:flex;
gap:66px;border-top:1px solid #241F1A;padding-top:10px;z-index:2}
.specimen.wide .fact{border-top:0;padding-top:0}
.specimen.wide .fact b{font-size:34px}
.specimen.wide .fact span{font-size:15px;margin-top:2px}
""",
    "daily": """
.daily.wide .mast{top:30px;text-align:left}
.daily.wide .mast b{font-size:30px;letter-spacing:.2em}
.daily.wide .mast .meta{justify-content:flex-start;gap:22px;margin-top:4px;font-size:14px}
.daily.wide .rules{top:100px;height:13px;border-top:5px solid #1A1815;border-bottom:2px solid #1A1815}
.daily.wide .w-stage{left:84px;right:84px;top:128px;bottom:58px;gap:40px}
.daily.wide .w-title{color:#1A1815;font-weight:900}
.daily.wide .w-sub{color:#4E473C;opacity:1;border-top:1px solid #1A1815;
border-bottom:1px solid #1A1815;padding:8px 0;max-width:640px}
.daily.wide .brief{position:static;width:286px;border:2px solid #1A1815;padding:10px 14px}
.daily.wide .brief .k{font-size:14px;margin-bottom:6px}
.daily.wide .brief .row{font-size:15px;line-height:1.7;gap:8px}
.daily.wide .brief .row span:last-child{font-size:13px}
""",
    "cards": """
.cards.wide::after{content:"";position:absolute;left:48px;right:48px;top:20px;bottom:58px;
background:#F6EFDF;color:#1D1913;border:2px solid #8C6B36;border-radius:22px;
box-shadow:0 20px 44px rgba(0,0,0,.42);z-index:1}
.cards.wide .w-stage{left:84px;right:84px;top:38px;bottom:60px;gap:40px}
.cards.wide .w-kicker{color:#8C6B36;opacity:1}
.cards.wide .w-title{color:#1D1913;font-weight:900}
.cards.wide .w-sub{color:#6E6252;opacity:1}
.cards.wide .w-side{width:262px;align-items:flex-end;text-align:right}
.cards.wide .chips{position:static;display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end}
.cards.wide .chip{border-color:#8C6B36;color:#8C6B36;background:transparent;font-size:15px;
padding:5px 12px}
.cards.wide .w-stamp{border:2px solid #8C6B36;border-radius:999px;padding:4px 14px;font-size:14px;
letter-spacing:.14em;color:#8C6B36}
.cards.wide .foot{color:#C9C0AF;opacity:1}
""",
}


# ---------------------------------------------------------------------------
# 便签纸
# ---------------------------------------------------------------------------


def _toc_rows(d: dict[str, Any], cls: str = "row", limit: int = 0) -> str:
    entries = d["toc"][:limit] if limit and limit > 0 else d["toc"]
    return "".join(
        f'<div class="{cls}"><span>{_esc(entry["title"])}</span><i></i>'
        f'<span>{entry["page"]:02d}</span></div>'
        for entry in entries
    )


def _end_tags(d: dict[str, Any], limit: int = 3) -> str:
    """尾页唯一附带的实用信息：一行话题标签，取分节标题前 8 个字。"""
    tags: list[str] = []
    seen: set[str] = set()
    for entry in d["toc"]:
        title = re.sub(r"[\s·—\-/，。！？、,.!?]+", "", _ICON_RE.sub("", str(entry["title"])))
        if not title or title[:6] in seen:
            continue
        seen.add(title[:6])
        tags.append("#" + (title[:8] + ("…" if len(title) > 8 else "")))
        if len(tags) >= limit:
            break
    return "  ".join(tags)


def _cover_memo(d: dict[str, Any], rng: random.Random) -> str:
    tape_left = rng.choice([150, 210, 270])
    tape_top = rng.choice([180, 196, 212])
    size = _fit_title(d["title"], 104, width=840)
    # 封面目录最多 4 行：再多会顶到下方提示语，超出部分收成一行「其余 N 节」。
    if len(d["toc"]) > 4:
        toc = _toc_rows(d, limit=3) + (
            f'<div class="row"><span>其余 {len(d["toc"]) - 3} 节</span>'
            '<i></i><span>…</span></div>'
        )
    else:
        toc = _toc_rows(d)
    return (
        f'<div class="brand">NOTES / MEMO</div>'
        f'<div class="tape" style="left:{tape_left}px;top:{tape_top}px;transform:rotate(-8deg)"></div>'
        f'<div class="tape" style="right:{tape_left}px;top:{tape_top + 40}px;transform:rotate(7deg)"></div>'
        f'<div class="paper" style="transform:rotate(-1.2deg);top:250px">'
        f'<h1 style="font-size:{size}px">{_esc(d["title"])}</h1>'
        f'<div class="sub">{_esc(d["subtitle"])}</div></div>'
        f'<svg class="arrow" width="96" height="120" viewBox="0 0 96 120" fill="none">'
        f'<path d="M48 6C64 38 32 62 48 100" stroke="#CFC8BB" stroke-width="4" stroke-linecap="round"/>'
        f'<path d="M32 86L48 106L64 86" stroke="#CFC8BB" stroke-width="4" '
        f'stroke-linecap="round" stroke-linejoin="round"/></svg>'
        f'<div class="cover-toc">{toc}</div>'
        f'<div class="cover-tip">往后翻，都是自己踩过的坑</div>'
        f"{_foot(d, 'MEMO / 便签纸')}"
    )


def _content_memo(d: dict[str, Any], rng: random.Random) -> str:
    icon, heading = _split_heading(d)
    colors = ["#E4572E", "#2F6FED", "#2A9D8F", "#D4A017"]
    count = len(d["items"])
    rows = "".join(
        f'<div class="item"><span class="mk" style="background:{colors[i % len(colors)]}"></span>'
        f'<div><b style="font-size:{_font_size(d, 54)}px">{_esc(_item_text(item))}</b></div></div>'
        for i, item in enumerate(d["items"])
    )
    if count >= 3:
        tail = '<div class="fill">✎ 记一笔自己的</div>'
        bottom = 1206
    else:
        key, value = _aside_text(d)
        tail = (
            f'<div class="aside"><div class="k">{_esc(key)}</div>'
            f'<div class="v">{_esc(value)}</div></div>'
        )
        bottom = 960
    return (
        f'<div class="h"><span class="ico">{_esc(icon)}</span><em>{_esc(heading)}</em></div>'
        f'<div class="list" style="{_list_style(340, bottom)}">{rows}</div>{tail}'
        f"{_foot(d, 'MEMO / 便签纸')}"
    )


def _ending_memo(d: dict[str, Any], rng: random.Random) -> str:
    quote = _fit_quote(d["subtitle"], 92, 840, max_lines=5)
    return (
        '<div class="end-sheet"></div>'
        '<div class="end-kicker">NOTES / 收尾</div>'
        f'<div class="end-q" style="font-size:{quote}px">{_esc(d["subtitle"])}</div>'
        f'<div class="end-tags">{_esc(_end_tags(d))}</div>'
        f"{_foot(d, 'MEMO / 便签纸')}"
    )


# ---------------------------------------------------------------------------
# 信息卡
# ---------------------------------------------------------------------------


def _cover_guide(d: dict[str, Any], rng: random.Random) -> str:
    width = rng.choice([560, 620, 680])
    size = _fit_title(d["title"], 112, width=912)
    pills = "".join(
        f'<span class="pill">{_esc(entry["title"])}</span>' for entry in d["toc"][:3]
    )
    quote = (
        f'把 {len(d["toc"])} 个重点按顺序排好了，照着走就行'
        if d["toc"]
        else "把重点按顺序排好了，照着走就行"
    )
    return (
        f'<div class="top">TRAVEL NOTES / {d["index"]:02d}</div>'
        f'<div class="title" style="font-size:{size}px">{_esc(d["title"])}</div>'
        f'<svg class="brush" width="{width}" height="28" viewBox="0 0 {width} 28" fill="none">'
        f'<path d="M6 20C{width * 0.2:.0f} 8 {width * 0.55:.0f} 22 {width - 8} 10" stroke="#E08A3C" '
        f'stroke-width="12" stroke-linecap="round"/></svg>'
        f'<div class="sub">{_esc(d["subtitle"])}</div>'
        f'<div class="toc">{pills}</div>'
        f'<div class="cover-quote">{_esc(quote)}</div>'
        f'<div class="stamp">收藏 · 出发前再看一遍</div>'
        f'<div class="emoji">📍 🚶 🍜</div>'
        f"{_foot(d, 'GUIDE / 信息卡')}"
    )


def _content_guide(d: dict[str, Any], rng: random.Random) -> str:
    icon, heading = _split_heading(d)
    count = len(d["items"])
    rows = "".join(
        f'<div class="item"><span class="idx">{i:02d}</span>'
        f'<div><b style="font-size:{_font_size(d, 54)}px">{_esc(_item_text(item))}</b></div></div>'
        for i, item in enumerate(d["items"], start=1)
    )
    if count >= 3:
        tail, bottom = '<div class="fill">先收藏 · 到了照着走</div>', 1198
    else:
        key, value = _aside_text(d)
        tail = (
            f'<div class="aside"><div class="k">{_esc(key)}</div>'
            f'<div class="v">{_esc(value)}</div></div>'
        )
        bottom = 946
    return (
        f'<div class="h"><span class="ico">{_esc(icon)}</span>'
        f'<span class="sec">{_esc(heading)}</span></div>'
        f'<div class="list" style="{_list_style(284, bottom)}">{rows}</div>{tail}'
        f"{_foot(d, 'GUIDE / 信息卡')}"
    )


def _ending_guide(d: dict[str, Any], rng: random.Random) -> str:
    quote = _fit_quote(d["subtitle"], 96, 912, max_lines=5)
    return (
        '<div class="end-kicker">TRAVEL NOTES / 收尾</div>'
        f'<div class="end-q" style="font-size:{quote}px">{_esc(d["subtitle"])}</div>'
        f'<div class="end-tags">{_esc(_end_tags(d))}</div>'
        f"{_foot(d, 'GUIDE / 信息卡')}"
    )


# ---------------------------------------------------------------------------
# 杂志奶油
# ---------------------------------------------------------------------------


def _cover_magazine(d: dict[str, Any], rng: random.Random) -> str:
    size = _fit_title(d["title"], 108, width=900)
    toc = _toc_rows(d, "toc-row")
    return (
        f'<div class="mast"><span>THE ECHOQ REVIEW</span><span>NO. {d["index"]:02d} / {d["total"]:02d}</span></div>'
        f'<div class="title" style="font-size:{size}px">{_esc(d["title"])}</div>'
        f'<div class="orn" style="right:84px;top:{rng.choice([560, 600])}px"></div>'
        f'<div class="deck">{_esc(d["subtitle"])}</div>'
        f'<div class="meta">LOCAL NOTES<br>全文手打 · 无广<br>阅读约 2 分钟</div>'
        f'<div class="cover-note">{len(d["toc"])} 个分节 · 全程手打 · 无广</div>'
        f'<div class="toc">{toc}</div>'
        f"{_foot(d, 'EDITORIAL / 杂志奶油')}"
    )


def _content_magazine(d: dict[str, Any], rng: random.Random) -> str:
    icon, heading = _split_heading(d)
    rows = [
        f'<div class="item"><div class="num">{i:02d}</div>'
        f'<b style="font-size:{_font_size(d, 56)}px">{_esc(_item_text(item))}</b></div>'
        for i, item in enumerate(d["items"], start=1)
    ]
    grid = f'<div class="rows single"><div class="col">{"".join(rows)}</div></div>'
    lead = str(d["lead"] or "")
    if len(d["items"]) <= 2:
        tail = f'<div class="pull">{_esc(lead)}</div>' if 0 < len(lead) <= 48 else ""
    else:
        tail = '<div class="fill">记一笔你自己的 · 写在评论区</div>'
    return (
        f'<div class="kicker">FEATURE / {d["index"]:02d}</div>'
        f'<div class="h">{_esc(icon)} {_esc(heading)}</div>'
        f"{grid}{tail}"
        f"{_foot(d, 'EDITORIAL / 杂志奶油')}"
    )


def _ending_magazine(d: dict[str, Any], rng: random.Random) -> str:
    quote = _fit_quote(d["subtitle"], 96, 912, max_lines=5)
    return (
        '<div class="end-kicker"><span>THE ECHOQ REVIEW</span><span>收尾 / CODA</span></div>'
        '<div class="end-mark">”</div>'
        f'<div class="end-q" style="font-size:{quote}px">{_esc(d["subtitle"])}</div>'
        f'<div class="end-tags">{_esc(_end_tags(d))}</div>'
        f"{_foot(d, 'EDITORIAL / 杂志奶油')}"
    )


# ---------------------------------------------------------------------------
# 极简黑白
# ---------------------------------------------------------------------------


def _cover_minimal(d: dict[str, Any], rng: random.Random) -> str:
    dot_left = rng.choice([330, 534, 720])
    size = _fit_title(d["title"], 106, width=860)
    sections = " · ".join(entry["title"] for entry in d["toc"]) or "一篇讲清楚"
    return (
        f'<div class="dot" style="left:{dot_left}px;top:214px"></div>'
        f'<div class="title" style="font-size:{size}px">{_esc(d["title"])}</div>'
        f'<div class="sub">{_esc(d["subtitle"])}</div>'
        f'<div class="cover-list">{_esc(sections)}</div>'
        f'<div class="cover-note">· · ·</div>'
        f'<div class="foot"><span>NO. {d["index"]:02d} / {d["total"]:02d}</span><span>应声运营</span></div>'
    )


def _content_minimal(d: dict[str, Any], rng: random.Random) -> str:
    icon, heading = _split_heading(d)
    base = 64 if len(d["items"]) <= 2 else 58
    rows = "".join(
        f'<div class="item"><span class="idx">{i:02d}</span>'
        f'<div><b style="font-size:{_font_size(d, base)}px">{_esc(_item_text(item))}</b></div></div>'
        for i, item in enumerate(d["items"], start=1)
    )
    return (
        f'<div class="h"><span class="ico">{_esc(icon)}</span>'
        f'<span class="sec">{_esc(heading)}</span></div>'
        f'<div class="list" style="{_list_style(365, 1225, "space-between")}">{rows}</div>'
        f"{_foot(d, 'MINIMAL / 极简黑白')}"
    )


def _ending_minimal(d: dict[str, Any], rng: random.Random) -> str:
    quote = _fit_quote(d["subtitle"], 104, 860, max_lines=6)
    return (
        '<div class="end-kicker">AFTERWORD / 结语</div>'
        f'<div class="end-q" style="font-size:{quote}px">{_esc(d["subtitle"])}</div>'
        f'<div class="end-tags">{_esc(_end_tags(d))}</div>'
        f"{_foot(d, 'MINIMAL / 极简黑白')}"
    )


# ---------------------------------------------------------------------------
# 索引墨 / 标本志 / 日报 / 收藏卡
# 版式语言取自 huashu-design：巨号数字、细线网格、博物图版、报纸刊头、卡纸描边。
# ---------------------------------------------------------------------------


def _section_size(heading: str, base: int, width: int, max_lines: int = 2) -> int:
    """分节标题不小于 76px，放不下先靠换行解决。"""
    return max(76, _fit_title(heading, base, width=width, max_lines=max_lines))


def _cover_ink(d: dict[str, Any], rng: random.Random) -> str:
    size = _fit_title(d["title"], 100, width=900)
    sub_size = max(34, _fit_quote(d["subtitle"], 38, 816, max_lines=2))
    rows = "".join(
        f'<div class="row"><span>{i:02d}</span><b>{_esc(entry["title"])}</b><i></i>'
        f'<span>{entry["page"]:02d}</span></div>'
        for i, entry in enumerate(d["toc"][:5], start=1)
    )
    if len(d["toc"]) > 5:
        rows += (
            f'<div class="row"><span>··</span><b>其余 {len(d["toc"]) - 5} 节</b><i></i>'
            f'<span>—</span></div>'
        )
    return (
        f'<div class="top"><span>ECHOQ INDEX</span><span>2026</span></div>'
        f'<div class="big">{d["total"]:02d}</div>'
        f'<div class="title" style="font-size:{size}px">{_esc(d["title"])}</div>'
        f'<div class="sub" style="font-size:{sub_size}px">{_esc(d["subtitle"])}</div>'
        f'<div class="cover-index">{rows}</div>'
        f"{_foot(d, 'INDEX / 索引墨')}"
    )


def _content_ink(d: dict[str, Any], rng: random.Random) -> str:
    icon, heading = _split_heading(d)
    # 页码列由网格自动占位：标题只在其剩余宽度内换行，两者永远不会叠在一起。
    pageno_width = 160
    size = _section_size(heading, 86, 912 - pageno_width - 30, 2)
    rows = "".join(
        f'<div class="item"><div class="no">{i:02d}</div>'
        f'<div><b style="font-size:{_font_size(d, 54)}px">{_esc(_item_text(item))}</b></div></div>'
        for i, item in enumerate(d["items"], start=1)
    )
    return (
        f'<div class="kicker">INDEX / {d["index"]:02d}</div>'
        f'<div class="head"><div class="h" style="font-size:{size}px">'
        f'<span class="ico">{_esc(icon)}</span>{_esc(heading)}</div>'
        f'<div class="pageno">{d["index"]:02d}</div></div>'
        f'<div class="rule"></div>'
        f'<div class="list">{rows}</div>'
        f'<div class="foot-note"><span>本节 {len(d["items"]):02d} 条</span>'
        f'<span>先记一条，再用得上</span></div>'
        f'<div class="stripe"></div>'
        f"{_foot(d, 'INDEX / 索引墨')}"
    )


def _ending_ink(d: dict[str, Any], rng: random.Random) -> str:
    quote = _fit_quote(d["subtitle"], 96, 912, max_lines=5)
    return (
        '<div class="end-ink"></div>'
        '<div class="end-kicker">ECHOQ INDEX / 收尾</div>'
        '<div class="end-mark">”</div>'
        f'<div class="end-q" style="font-size:{quote}px">{_esc(d["subtitle"])}</div>'
        f'<div class="end-tags">{_esc(_end_tags(d))}</div>'
        f"{_foot(d, 'INDEX / 索引墨')}"
    )


def _cover_specimen(d: dict[str, Any], rng: random.Random) -> str:
    size = _fit_title(d["title"], 100, width=900)
    sub_size = max(32, _fit_quote(d["subtitle"], 37, 876, max_lines=2))
    return (
        f'<div class="mast"><span>THE FIELD NOTES / 应声标本志</span>'
        f'<span>NO. {d["index"]:02d}</span></div>'
        f'<div class="plate-no">{d["total"]:02d}</div>'
        f'<div class="title" style="font-size:{size}px">{_esc(d["title"])}</div>'
        f'<div class="sub" style="font-size:{sub_size}px">{_esc(d["subtitle"])}</div>'
        f'<div class="facts">'
        f'<div class="fact"><b>{len(d["toc"]):02d}</b><span>个分节 · 逐页编号</span></div>'
        f'<div class="fact"><b>{d["total"]:02d}</b><span>页图卡 · 手打无广</span></div></div>'
        f'<div class="cover-foot"><span>COLLECTED NOTES</span><span>应声运营 · 2026</span></div>'
        f"{_foot(d, 'FIELD NOTES / 标本志')}"
    )


def _content_specimen(d: dict[str, Any], rng: random.Random) -> str:
    icon, heading = _split_heading(d)
    size = _section_size(heading, 92, 912, 2)
    rows = "".join(
        f'<div class="item"><span class="badge">{i:02d}</span>'
        f'<div><b style="font-size:{_font_size(d, 53)}px">{_esc(_item_text(item))}</b></div></div>'
        for i, item in enumerate(d["items"], start=1)
    )
    count = len(d["items"])
    if count >= 3:
        tail, bottom = "", 1250
    else:
        tail = (
            f'<div class="strip"><span class="ico">{_esc(icon or "§")}</span>'
            f'<span class="cap">第 {d["index"]:02d} 版 · {count} 条记录</span></div>'
        )
        bottom = 1120
    return (
        f'<div class="kicker">THE FIELD NOTES</div>'
        f'<div class="plate-tag">PLATE {d["index"]:02d}</div>'
        f'<div class="h" style="font-size:{size}px">{_esc(icon)} {_esc(heading)}</div>'
        f'<div class="rule"></div>'
        f'<div class="list" style="{_list_style(600, bottom)}">{rows}</div>'
        f"{tail}{_foot(d, 'FIELD NOTES / 标本志')}"
    )


def _ending_specimen(d: dict[str, Any], rng: random.Random) -> str:
    quote = _fit_quote(d["subtitle"], 96, 800, max_lines=5)
    return (
        '<div class="end-kicker">THE FIELD NOTES / 应声标本志</div>'
        '<div class="plate-tag">CODA / 结语</div>'
        '<div class="end-label"></div>'
        f'<div class="end-q" style="font-size:{quote}px">{_esc(d["subtitle"])}</div>'
        f'<div class="end-tags">{_esc(_end_tags(d))}</div>'
        f"{_foot(d, 'FIELD NOTES / 标本志')}"
    )


def _cover_daily(d: dict[str, Any], rng: random.Random) -> str:
    size = _fit_title(d["title"], 96, width=912)
    dek_size = max(32, _fit_quote(d["subtitle"], 36, 912, max_lines=2))
    rows = "".join(
        f'<div class="row"><span>{i:02d}</span><span>{_esc(entry["title"])}</span>'
        f'<i></i><span>{entry["page"]:02d}</span></div>'
        for i, entry in enumerate(d["toc"][:4], start=1)
    )
    return (
        f'<div class="mast"><b>应声日报</b>'
        f'<div class="meta"><span>第 {d["index"]:02d} 期</span>'
        f'<span>生活 · 经验 · 复盘</span><span>手打无广</span></div></div>'
        f'<div class="rules"></div>'
        f'<div class="headline" style="font-size:{size}px">{_esc(d["title"])}</div>'
        f'<div class="dek" style="font-size:{dek_size}px">{_esc(d["subtitle"])}</div>'
        f'<div class="brief"><div class="k">本期导读 / IN THIS ISSUE</div>{rows}</div>'
        f"{_foot(d, 'DAILY / 日报')}"
    )


def _content_daily(d: dict[str, Any], rng: random.Random) -> str:
    icon, heading = _split_heading(d)
    size = _section_size(heading, 76, 700, 2)
    rows = []
    for i, item in enumerate(d["items"], start=1):
        wide = " wide" if len(d["items"]) == 3 and i == 3 else ""
        rows.append(
            f'<div class="item{wide}"><div class="num">NO.{i:02d}</div>'
            f'<b style="font-size:{_font_size(d, 53)}px">{_esc(_item_text(item))}</b></div>'
        )
    note = (
        f'第 {d["next_page"]:02d} 版接着讲：{_esc(d["next"])}'
        if d.get("next")
        else "读到这里，先收藏，下次直接用"
    )
    return (
        f'<div class="band"><span class="s">第 {d["index"]:02d} 版</span>'
        f'<span class="sec" style="font-size:{size}px">{_esc(icon)} {_esc(heading)}</span></div>'
        f'<div class="list{" two" if len(d["items"]) <= 2 else ""}">{"".join(rows)}</div>'
        f'<div class="note"><b>编者按</b>{note}</div>'
        f"{_foot(d, 'DAILY / 日报')}"
    )


def _ending_daily(d: dict[str, Any], rng: random.Random) -> str:
    quote = _fit_quote(d["subtitle"], 96, 912, max_lines=5)
    return (
        f'<div class="mast"><b>应声日报</b>'
        f'<div class="meta"><span>结语 · 社论</span><span>手打无广</span><span>收藏备用</span></div></div>'
        f'<div class="rules"></div>'
        f'<div class="end-head" style="font-size:{quote}px">{_esc(d["subtitle"])}</div>'
        '<div class="end-kw">关键词 / KEYWORDS</div>'
        f'<div class="end-tags">{_esc(_end_tags(d))}</div>'
        f"{_foot(d, 'DAILY / 日报')}"
    )


def _cover_cards(d: dict[str, Any], rng: random.Random) -> str:
    size = _fit_title(d["title"], 96, width=800)
    sub_size = max(30, _fit_quote(d["subtitle"], 35, 812, max_lines=2))
    chips = "".join(
        f'<span class="chip">{_esc(entry["title"])}</span>' for entry in d["toc"][:4]
    )
    return (
        f'<div class="top"><span>FIELD CARDS</span><span>NO. {d["index"]:02d}</span></div>'
        '<div class="backcard"></div>'
        f'<div class="bigcard"><div class="k">COLLECTION / 应声</div>'
        f'<div class="stamp">{d["total"]:02d} CARDS</div>'
        f'<div class="title" style="font-size:{size}px">{_esc(d["title"])}</div>'
        f'<div class="sub" style="font-size:{sub_size}px">{_esc(d["subtitle"])}</div></div>'
        f'<div class="chips">{chips}</div>'
        f"{_foot(d, 'FIELD CARDS / 收藏卡')}"
    )


def _content_cards(d: dict[str, Any], rng: random.Random) -> str:
    icon, heading = _split_heading(d)
    size = _section_size(heading, 80, 760, 2)
    rows = "".join(
        f'<div class="item"><span class="badge">{i:02d}</span>'
        f'<div><b style="font-size:{_font_size(d, 53)}px">{_esc(_item_text(item))}</b></div></div>'
        for i, item in enumerate(d["items"], start=1)
    )
    return (
        f'<div class="h"><span class="sec" style="font-size:{size}px">{_esc(icon)} '
        f'{_esc(heading)}</span><span class="no">SET {d["index"]:02d}</span></div>'
        f'<div class="list">{rows}</div>'
        '<div class="tip">把这一页存进你的收藏夹</div>'
        f"{_foot(d, 'FIELD CARDS / 收藏卡')}"
    )


def _ending_cards(d: dict[str, Any], rng: random.Random) -> str:
    quote = _fit_quote(d["subtitle"], 92, 816, max_lines=5)
    return (
        '<div class="end-card"></div>'
        '<div class="end-kicker">LAST CARD / 最后一张</div>'
        f'<div class="end-q" style="font-size:{quote}px">{_esc(d["subtitle"])}</div>'
        f'<div class="end-tags">{_esc(_end_tags(d))}</div>'
        f"{_foot(d, 'FIELD CARDS / 收藏卡')}"
    )


# ---------------------------------------------------------------------------
# 宽幅封面（公众号 2.35:1，1080×460）
# 宽幅不是竖版压扁：标题按横向重排，右侧改为摘要/编号/导读，底部只留一条信息。
# ---------------------------------------------------------------------------


def _w_tags(d: dict[str, Any], limit: int = 3) -> str:
    return "".join(
        f'<span class="w-tag">{_esc(entry["title"])}</span>' for entry in d["toc"][:limit]
    )


def _cover_wide_memo(d: dict[str, Any], rng: random.Random) -> str:
    size = _fit_wide_title(d["title"], 62, width=650, max_lines=3)
    left = rng.choice([70, 96])
    return (
        f'<div class="w-tape" style="left:{left}px;top:6px;transform:rotate(-6deg)"></div>'
        f'<div class="w-tape" style="right:-8px;top:170px;transform:rotate(78deg)"></div>'
        '<div class="w-stage"><div class="w-copy">'
        '<div class="brand">NOTES / MEMO</div>'
        f'<h1 class="w-title" style="font-size:{size}px">{_esc(d["title"])}</h1>'
        f'<div class="w-sub">{_esc(d["subtitle"])}</div>'
        f'<div class="w-tags">{_w_tags(d, 2)}</div></div>'
        '<div class="w-side"><div class="w-note">往后翻<br>都是踩过的坑</div>'
        '<svg class="w-arrow" width="66" height="82" viewBox="0 0 66 82" fill="none">'
        '<path d="M33 4C45 26 21 42 33 68" stroke="currentColor" stroke-width="3" '
        'stroke-linecap="round"/><path d="M22 58L33 72L44 58" stroke="currentColor" '
        'stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></div></div>'
        f"{_foot(d, 'MEMO / 便签纸')}"
    )


def _cover_wide_guide(d: dict[str, Any], rng: random.Random) -> str:
    size = _fit_wide_title(d["title"], 62, width=620, max_lines=3)
    pills = "".join(
        f'<span class="pill">{_esc(entry["title"])}</span>' for entry in d["toc"][:3]
    )
    width = 250
    return (
        '<div class="w-stage"><div class="w-copy">'
        f'<div class="top">TRAVEL NOTES / {d["index"]:02d}</div>'
        f'<h1 class="w-title" style="font-size:{size}px">{_esc(d["title"])}</h1>'
        f'<svg class="w-brush" width="{width}" height="20" viewBox="0 0 {width} 20" fill="none">'
        f'<path d="M5 14C{width * 0.2:.0f} 4 {width * 0.55:.0f} 17 {width - 5} 7" '
        'stroke="#E08A3C" stroke-width="9" stroke-linecap="round"/></svg>'
        f'<div class="w-sub">{_esc(d["subtitle"])}</div></div>'
        f'<div class="w-side"><div class="toc">{pills}</div>'
        '<div class="w-note">收藏 · 出发前再看一遍</div></div></div>'
        f"{_foot(d, 'GUIDE / 信息卡')}"
    )


def _cover_wide_magazine(d: dict[str, Any], rng: random.Random) -> str:
    size = _fit_wide_title(d["title"], 66, width=660, max_lines=3)
    return (
        f'<div class="mast"><span>THE ECHOQ REVIEW</span>'
        f'<span>NO. {d["index"]:02d} / {d["total"]:02d}</span></div>'
        '<div class="w-stage"><div class="w-copy">'
        f'<h1 class="w-title" style="font-size:{size}px">{_esc(d["title"])}</h1>'
        f'<div class="w-sub">{_esc(d["subtitle"])}</div></div>'
        '<div class="w-side"><div class="orn"></div>'
        '<div class="meta">LOCAL NOTES<br>全文手打 · 无广<br>阅读约 2 分钟</div></div></div>'
        f'<div class="w-rule">{len(d["toc"])} 个分节 · 全程手打 · 无广</div>'
        f"{_foot(d, 'EDITORIAL / 杂志奶油')}"
    )


def _cover_wide_minimal(d: dict[str, Any], rng: random.Random) -> str:
    size = _fit_wide_title(d["title"], 66, width=640, max_lines=3)
    sections = " · ".join(entry["title"] for entry in d["toc"]) or "一篇讲清楚"
    return (
        '<div class="w-dot"></div>'
        '<div class="w-stage"><div class="w-copy">'
        f'<h1 class="w-title" style="font-size:{size}px">{_esc(d["title"])}</h1>'
        f'<div class="w-sub">{_esc(d["subtitle"])}</div></div>'
        f'<div class="w-side"><div class="cover-list">{_esc(sections)}</div>'
        '<div class="w-note">· · ·</div></div></div>'
        f"{_foot(d, 'MINIMAL / 极简黑白')}"
    )


def _cover_wide_ink(d: dict[str, Any], rng: random.Random) -> str:
    size = _fit_wide_title(d["title"], 64, width=620, max_lines=3)
    return (
        f'<div class="w-big">{d["total"]:02d}</div>'
        '<div class="w-stage"><div class="w-copy">'
        '<div class="top"><span>ECHOQ INDEX</span><span>2026</span></div>'
        f'<h1 class="w-title" style="font-size:{size}px">{_esc(d["title"])}</h1>'
        f'<div class="w-sub">{_esc(d["subtitle"])}</div>'
        f'<div class="w-note">{len(d["toc"])} 个分节 · {d["total"]} 页图卡 · 手打无广</div>'
        '</div></div><div class="w-stripe"></div>'
        f"{_foot(d, 'INDEX / 索引墨')}"
    )


def _cover_wide_specimen(d: dict[str, Any], rng: random.Random) -> str:
    size = _fit_wide_title(d["title"], 62, width=620, max_lines=3)
    return (
        f'<div class="mast"><span>THE FIELD NOTES / 应声标本志</span>'
        f'<span>NO. {d["index"]:02d}</span></div>'
        f'<div class="w-plate">{d["total"]:02d}</div>'
        '<div class="w-stage"><div class="w-copy">'
        f'<h1 class="w-title" style="font-size:{size}px">{_esc(d["title"])}</h1>'
        f'<div class="w-sub">{_esc(d["subtitle"])}</div></div></div>'
        '<div class="facts">'
        f'<div class="fact"><b>{len(d["toc"]):02d}</b><span>个分节 · 逐页编号</span></div>'
        f'<div class="fact"><b>{d["total"]:02d}</b><span>页图卡 · 手打无广</span></div>'
        '<div class="fact"><b>2026</b><span>应声运营 · 实地整理</span></div></div>'
        f"{_foot(d, 'FIELD NOTES / 标本志')}"
    )


def _cover_wide_daily(d: dict[str, Any], rng: random.Random) -> str:
    size = _fit_wide_title(d["title"], 62, width=640, max_lines=3)
    rows = "".join(
        f'<div class="row"><span>{i:02d}</span><span>{_esc(entry["title"])}</span>'
        f'<i></i><span>{entry["page"]:02d}</span></div>'
        for i, entry in enumerate(d["toc"][:3], start=1)
    )
    return (
        f'<div class="mast"><b>应声日报</b><div class="meta"><span>第 {d["index"]:02d} 期</span>'
        f'<span>生活 · 经验 · 复盘</span><span>手打无广</span></div></div>'
        '<div class="rules"></div>'
        '<div class="w-stage"><div class="w-copy">'
        f'<h1 class="w-title" style="font-size:{size}px">{_esc(d["title"])}</h1>'
        f'<div class="w-sub">{_esc(d["subtitle"])}</div></div>'
        '<div class="w-side"><div class="brief"><div class="k">本期导读 / IN THIS ISSUE</div>'
        f'{rows}</div></div></div>'
        f"{_foot(d, 'DAILY / 日报')}"
    )


def _cover_wide_cards(d: dict[str, Any], rng: random.Random) -> str:
    size = _fit_wide_title(d["title"], 60, width=620, max_lines=3)
    chips = "".join(
        f'<span class="chip">{_esc(entry["title"])}</span>' for entry in d["toc"][:3]
    )
    return (
        '<div class="w-stage"><div class="w-copy">'
        '<div class="w-kicker">COLLECTION / 应声</div>'
        f'<h1 class="w-title" style="font-size:{size}px">{_esc(d["title"])}</h1>'
        f'<div class="w-sub">{_esc(d["subtitle"])}</div></div>'
        f'<div class="w-side"><div class="w-stamp">{d["total"]:02d} CARDS</div>'
        f'<div class="chips">{chips}</div></div></div>'
        f"{_foot(d, 'FIELD CARDS / 收藏卡')}"
    )


_WIDE_COVERS = {
    "memo": _cover_wide_memo,
    "guide": _cover_wide_guide,
    "magazine": _cover_wide_magazine,
    "minimal": _cover_wide_minimal,
    "ink": _cover_wide_ink,
    "specimen": _cover_wide_specimen,
    "daily": _cover_wide_daily,
    "cards": _cover_wide_cards,
}


_BUILDERS = {
    "memo": (_cover_memo, _content_memo, _ending_memo),
    "guide": (_cover_guide, _content_guide, _ending_guide),
    "magazine": (_cover_magazine, _content_magazine, _ending_magazine),
    "minimal": (_cover_minimal, _content_minimal, _ending_minimal),
    "ink": (_cover_ink, _content_ink, _ending_ink),
    "specimen": (_cover_specimen, _content_specimen, _ending_specimen),
    "daily": (_cover_daily, _content_daily, _ending_daily),
    "cards": (_cover_cards, _content_cards, _ending_cards),
}


def _body(page: dict[str, Any], style: str, rng: random.Random) -> str:
    d = _page_data(page)
    if d["kind"] == "cover" and page.get("canvas") == "wide":
        return _WIDE_COVERS[style](d, rng)
    cover, content, ending = _BUILDERS[style]
    if d["kind"] == "cover":
        return cover(d, rng)
    if d["kind"] == "ending":
        return ending(d, rng)
    return content(d, rng)


def render_design_html(
    page: dict[str, Any],
    style: str,
    seed: str = "default",
    canvas: str = "portrait",
) -> str:
    """渲染单页 HTML。``canvas="wide"`` 时使用 1080×460 宽幅封面版式。"""
    style = style if style in _style_keys() else "memo"
    wide = canvas == "wide"
    width, height = (WIDE_WIDTH, WIDE_HEIGHT) if wide else (WIDTH, HEIGHT)
    rng = random.Random(seed)
    page = dict(page)
    if wide:
        page["canvas"] = "wide"
    body = _body(page, style, rng)
    font = _font(style)
    css = (
        BASE_CSS.replace("__W__", str(width)).replace("__H__", str(height))
        + STYLE_CSS[style].replace("__FONT__", font)
    )
    if wide:
        css += WIDE_CSS + WIDE_STYLE_CSS[style].replace("__FONT__", font)
    classes = f"page {style}{' wide' if wide else ''}"
    return f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>{_esc(_title(page))} · {style}</title>
<style>{css}</style></head>
<body><main class="{classes}">{body}</main></body></html>
"""


def _signature(html_text: str, style: str) -> str:
    return hashlib.sha256(f"{RENDERER}\n{style}\n{html_text}".encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# 出图前版式自检：读取每个文字块的真实包围盒，拦截重叠与越界
# ---------------------------------------------------------------------------

_SAFE = {"left": 44, "right": 44, "top": 28, "bottom": 18}

_LAYOUT_SELECTORS = [
    ".brand", ".mast", ".top", ".kicker", ".paper h1", ".title", ".sub", ".deck",
    ".cover-tip", ".cover-quote", ".cover-note", ".cover-list", ".cover-toc .row",
    ".toc .pill", ".toc-row", ".stamp", ".h", ".idx", ".num", ".item b",
    ".aside .k", ".aside .v", ".fill", ".pull",
    ".end-kicker", ".end-q", ".end-tags", ".end-mark", ".end-head", ".end-kw", ".foot",
    # 索引墨 / 标本志 / 日报 / 收藏卡
    ".big", ".pageno", ".cover-index .row", ".foot-note", ".end-ink ~ .foot",
    ".plate-no", ".plate-tag", ".facts .fact b", ".facts .fact span", ".cover-foot",
    ".badge", ".strip .ico", ".strip .cap",
    ".mast b", ".mast .meta", ".headline", ".dek", ".brief .k", ".brief .row",
    ".band .s", ".band .sec", ".note",
    ".bigcard .k", ".bigcard .stamp", ".bigcard .title", ".bigcard .sub",
    ".chips .chip", ".h .sec", ".h .no", ".tip",
    # 宽幅封面（1080×460）
    ".w-title", ".w-sub", ".w-kicker", ".w-note", ".w-tag", ".w-rule", ".w-stamp",
    ".meta", ".w-side .toc .pill",
    # 索引墨内容页：序号列与条目正文
    ".ink .no", ".ink .item b",
]

_LAYOUT_PROBE = """<script>
(function(){
  var sels = __SELS__;
  var out = [];
  var nodes = document.querySelectorAll(sels.join(","));
  function inkBox(el) {
    var range = document.createRange();
    range.selectNodeContents(el);
    var rects = range.getClientRects();
    var l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (var k = 0; k < rects.length; k++) {
      var q = rects[k];
      if (q.width < 1 || q.height < 1) continue;
      l = Math.min(l, q.left); t = Math.min(t, q.top);
      r = Math.max(r, q.right); b = Math.max(b, q.bottom);
    }
    if (r <= l) return null;
    return {x: l, y: t, w: r - l, h: b - t};
  }
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    var text = (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
    if (!text) continue;
    var st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden") continue;
    var box = inkBox(el);
    if (!box || box.w < 2 || box.h < 2) continue;
    out.push({
      t: text.slice(0, 36),
      c: String(el.className || "").slice(0, 40),
      x: box.x, y: box.y, w: box.w, h: box.h
    });
  }
  var pre = document.createElement("pre");
  pre.id = "__layout__";
  pre.style.display = "none";
  pre.textContent = JSON.stringify(out);
  document.body.appendChild(pre);
})();
</script>"""


def _parse_layout(raw: str | None) -> list[dict[str, Any]]:
    if not raw:
        logger.warning("版式自检未取到包围盒")
        return []
    try:
        return json.loads(html.unescape(raw))
    except json.JSONDecodeError:
        logger.warning("版式自检结果解析失败")
        return []


def _layout_blocks(html_text: str, canvas: str = "portrait") -> list[dict[str, Any]]:
    """用无头浏览器执行页面脚本，取回所有文字块的真实包围盒。

    优先 Playwright 自带 Chromium（不依赖本机浏览器）；不可用时退回
    Edge/Chrome 的 ``--dump-dom``。
    """
    width, height = (
        (WIDE_WIDTH, WIDE_HEIGHT) if canvas == "wide" else (WIDTH, HEIGHT)
    )
    probe = html_text.replace(
        "</body>", _LAYOUT_PROBE.replace("__SELS__", json.dumps(_LAYOUT_SELECTORS)) + "</body>"
    )
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        sync_playwright = None
    if sync_playwright is not None:
        with tempfile.TemporaryDirectory(prefix="ops-layout-") as tmp:
            path = Path(tmp) / "probe.html"
            path.write_text(probe, encoding="utf-8")
            try:
                with sync_playwright() as playwright:
                    browser = playwright.chromium.launch(headless=True)
                    try:
                        page = browser.new_page(
                            viewport={"width": width, "height": height},
                            device_scale_factor=1,
                        )
                        page.goto(path.as_uri(), wait_until="load", timeout=60_000)
                        page.wait_for_timeout(150)
                        raw = page.evaluate(
                            "() => (document.getElementById('__layout__') || {}).textContent || ''"
                        )
                    finally:
                        browser.close()
            except Exception as exc:  # noqa: BLE001
                logger.warning("版式自检执行失败: {}", exc)
                return []
        return _parse_layout(raw)

    browser = _browser()
    if not browser:
        logger.warning("版式自检跳过：未找到 Edge/Chrome")
        return []
    with tempfile.TemporaryDirectory(prefix="ops-layout-") as tmp:
        path = Path(tmp) / "probe.html"
        path.write_text(probe, encoding="utf-8")
        command = [
            browser,
            "--headless=new",
            "--disable-gpu",
            "--hide-scrollbars",
            "--force-device-scale-factor=1",
            f"--user-data-dir={Path(tmp) / 'profile'}",
            f"--window-size={width},{height}",
            "--dump-dom",
            path.as_uri(),
        ]
        try:
            done = proc.run(
                command, capture_output=True, text=True, encoding="utf-8",
                errors="replace", timeout=120,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            logger.warning("版式自检执行失败: {}", exc)
            return []
    match = re.search(r'<pre id="__layout__"[^>]*>(.*?)</pre>', done.stdout or "", re.S)
    return _parse_layout(match.group(1) if match else "")


def _inside(inner: dict[str, Any], outer: dict[str, Any]) -> bool:
    return (
        inner["x"] >= outer["x"] - 1
        and inner["y"] >= outer["y"] - 1
        and inner["x"] + inner["w"] <= outer["x"] + outer["w"] + 1
        and inner["y"] + inner["h"] <= outer["y"] + outer["h"] + 1
    )


def _check_blocks(
    blocks: list[dict[str, Any]], canvas: str = "portrait"
) -> list[str]:
    width, height = (
        (WIDE_WIDTH, WIDE_HEIGHT) if canvas == "wide" else (WIDTH, HEIGHT)
    )
    issues: list[str] = []
    for block in blocks:
        left, top = float(block["x"]), float(block["y"])
        right, bottom = left + float(block["w"]), top + float(block["h"])
        if left < _SAFE["left"] - 0.5 or top < _SAFE["top"] - 0.5:
            issues.append(f"「{block['t']}」越过左上安全边距 ({left:.0f},{top:.0f})")
        if right > width - _SAFE["right"] + 0.5 or bottom > height - _SAFE["bottom"] + 0.5:
            issues.append(f"「{block['t']}」越过右下安全边距 ({right:.0f},{bottom:.0f})")
    for i in range(len(blocks)):
        for j in range(i + 1, len(blocks)):
            a, b = blocks[i], blocks[j]
            if _inside(a, b) or _inside(b, a):
                continue
            overlap_x = min(a["x"] + a["w"], b["x"] + b["w"]) - max(a["x"], b["x"])
            overlap_y = min(a["y"] + a["h"], b["y"] + b["h"]) - max(a["y"], b["y"])
            if overlap_x > 1 and overlap_y > 1 and overlap_x * overlap_y > 6:
                issues.append(
                    f"「{a['t']}」与「{b['t']}」重叠 {overlap_x * overlap_y:.0f}px²"
                )
    return issues


def check_design_layout(
    draft: dict[str, Any], style: str, platform: str = ""
) -> list[dict[str, Any]]:
    """对一套风格的全部页面做版式自检，返回每页结果（供批量验收）。

    公众号只检查宽幅封面那一页，画布边界按 1080×460 计算。
    """
    style = style if style in _style_keys() else "memo"
    canvas = design_canvas(platform or draft.get("platform") or "")
    mode = canvas["key"]
    pages = _design_pages(draft)
    if mode == "wide":
        pages = pages[:1]
    report: list[dict[str, Any]] = []
    for page in pages:
        slug = f"{page['index']:02d}-{page['type']}"
        seed = f"{RENDERER}:{draft['id']}-{style}-check:{page['index']}:{mode}"
        blocks = _layout_blocks(render_design_html(page, style, seed, mode), mode)
        issues = _check_blocks(blocks, mode)
        report.append(
            {
                "page": slug,
                "canvas": mode,
                "blocks": len(blocks),
                "ok": not issues,
                "issues": issues,
            }
        )
    return report


def render_design_cards(
    draft: dict[str, Any],
    style: str,
    variant: int | None = None,
    limit: int | None = None,
    platform: str = "",
) -> list[str]:
    """按平台出图：公众号走 2.35:1 宽幅封面（只出 1 张），其余保持 3:4 竖版。"""
    if style not in _style_keys():
        style = "paper"
    if style == "paper":
        # 新版纸感：小红书与抖音图文共用一套 3:4，公众号单独两张。
        from ops.cards_v2 import render_paper_cards

        images, content_json = render_paper_cards(
            draft, platform or draft.get("platform") or ""
        )
        db.execute(
            "UPDATE drafts SET content_json = ? WHERE id = ?",
            (json.dumps(content_json, ensure_ascii=False), int(draft["id"])),
        )
        return images
    canvas = design_canvas(platform or draft.get("platform") or "")
    wide = canvas["key"] == "wide"
    source = draft
    if wide or limit == 1:
        # 封面只用精简后的正文：长文按全文排版会把目录撑爆。
        desc = str(draft.get("desc") or "")
        if len(desc) > 320:
            source = dict(draft)
            source["desc"] = desc[:320].rsplit("\n", 1)[0] or desc[:320]
    pages = _design_pages(source)
    if wide:
        pages = pages[:1]
    # 平台张数上限（公众号只要 1 张封面）由调用方传入，超出时只渲染前 N 页。
    elif limit and limit > 0:
        pages = pages[: int(limit)]
    folder = config.DESIGN_DIR / f"draft-{int(draft['id'])}" / style
    folder.mkdir(parents=True, exist_ok=True)
    meta_path = folder / "meta.json"
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        meta = {}

    run = int(variant) if variant is not None else int(meta.get("run") or 0) + 1
    run = max(1, run)
    seed_base = f"{draft['id']}-{style}-{run}"
    results: list[str] = []
    seeds: dict[str, str] = {}

    with _LOCK:
        for page in pages:
            slug = f"{page['index']:02d}-{page['type']}"
            seed = f"{RENDERER}:{seed_base}:{page['index']}:{canvas['key']}"
            html_text = render_design_html(page, style, seed, canvas["key"])
            signature = _signature(html_text, style)
            html_path = folder / f"{slug}.html"
            image_path = folder / f"{slug}.png"
            html_path.write_text(html_text, encoding="utf-8")
            if image_path.exists() and meta.get(slug) == signature:
                logger.info("复用设计卡片: {}", image_path.name)
            else:
                issues = _check_blocks(
                    _layout_blocks(html_text, canvas["key"]), canvas["key"]
                )
                if issues:
                    raise RuntimeError(
                        f"版式自检失败（{style}/{slug}，第 {page['index']}/{len(pages)} 页）："
                        + "；".join(issues[:4])
                        + "。本次整组未保存，草稿仍保留上一次的配图。"
                    )
                _shoot(
                    html_path,
                    image_path,
                    width=canvas["width"],
                    height=canvas["height"],
                )
                meta[slug] = signature
            results.append(str(image_path))
            seeds[slug] = seed

    meta_path.write_text(
        json.dumps(
            {
                "run": run,
                "seed": seed_base,
                "seeds": seeds,
                "style": style,
                "style_name": design_style(style)["name"],
                "canvas": canvas,
                "pages": len(pages),
                "updated_at": int(__import__("time").time()),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return results

