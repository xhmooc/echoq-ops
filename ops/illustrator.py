# encoding: utf-8
"""本地渲染小红书配图：HTML/CSS 模板 + 无头浏览器截图。

不调用任何付费图像接口。风格、版式、花字与配色取自
``baoyu-skills/skills/baoyu-xhs-images`` 的 presets / elements / palettes，
用 CSS 与内联 SVG 做出接近手绘卡片的效果。

流程：

1. 读取 skill 的 preset / palette，抽出文字色、背景色、强调色与字体倾向。
2. 按文案拆页（封面 / 内容 / 结尾），套用用户选择的版式。
3. 生成 1080×1440 的 HTML，落盘到 ``assets/draft-{id}/NN-type.html``。
4. 用 Playwright 自带 Chromium 截图成 PNG（缺浏览器时退回本机 Edge / Chrome）。
"""

from __future__ import annotations

import base64
import hashlib
import html
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any

from loguru import logger

from ops import cloud, config, db, proc


def _resolve_skill_dir() -> Path:
    """定位配图 skill 目录，避免换机器后风格清单静默变空。

    优先环境变量；其次仓库同级的 baoyu-skills、仓库内 vendor / datas。
    没找到时保留环境变量或默认路径，由 ``list_styles`` 回落到内置清单并打日志。
    """
    env = os.environ.get("OPS_BAOYU_XHS_SKILL", "").strip()
    candidates: list[Path] = []
    if env:
        candidates.append(Path(env))
    candidates.extend(
        [
            config.ROOT.parent / "baoyu-skills" / "skills" / "baoyu-xhs-images",
            config.ROOT / "vendor" / "baoyu-xhs-images",
            config.DATA_DIR / "skills" / "baoyu-xhs-images",
        ]
    )
    for path in candidates:
        if (path / "references" / "presets").is_dir():
            return path.resolve()
    logger.warning(
        "未找到配图 skill 预设目录，风格清单将使用内置回退："
        + "；".join(str(path) for path in candidates)
    )
    return candidates[0].resolve()


SKILL_DIR = _resolve_skill_dir()
WIDTH = 1080
HEIGHT = 1440
DEFAULT_STYLE = "warm"
DEFAULT_LAYOUT = "balanced"
DEFAULT_PALETTE = ""
RENDERER = "local-html-v1"

# 付费出图型号：云端中转的 qwen-image-3.0，1k 约 0.18 元/张。
# 免费模板走本地 HTML 渲染；只有用户在「付费出图」里二次确认后才会调用。
PAID_IMAGE_MODEL = "qwen-image-3.0"
PAID_IMAGE_PRICE = 0.18
PAID_IMAGE_COUNT = 3
PAID_IMAGE_SIZE = "1024*1024"

_LOCK = threading.Lock()

STYLE_LABELS = {
    "cute": ("奶油甜心", "甜美元气，适合日常分享与种草"),
    "fresh": ("清新自然", "干净自然，适合健康生活方式"),
    "warm": ("暖调手账", "温暖亲切，适合故事与情绪"),
    "bold": ("高冲击黑红", "强对比大字，适合警告与避坑"),
    "minimal": ("极简黑白", "克制留白，适合专业与商务"),
    "retro": ("复古胶片", "做旧怀旧，适合回顾与经典"),
    "pop": ("波普爆炸", "高饱和撞色，适合热点与娱乐"),
    "notion": ("知识线稿", "单线手绘 + 淡彩，适合知识卡"),
    "chalkboard": ("黑板粉笔", "黑板彩色粉笔，适合教程与科普"),
    "study-notes": ("手写笔记", "横线纸 + 蓝笔红批，适合学习笔记"),
    "screen-print": ("海报丝印", "双色平涂 + 半调，适合观点海报"),
    "sketch-notes": ("手绘图解", "马卡龙色块手绘，适合流程与教程"),
}

LAYOUT_LABELS = {
    "sparse": ("极简留白", "1-2 个信息点，封面/结尾"),
    "balanced": ("均衡版式", "3-4 个信息点，通用"),
    "dense": ("知识卡", "5-8 个信息点，信息密度高"),
    "list": ("清单", "4-7 条，编号纵排"),
    "comparison": ("对比", "左右两栏对照"),
    "flow": ("流程", "3-6 步，箭头串联"),
    "mindmap": ("思维导图", "中心向外 4-8 个分支"),
    "quadrant": ("四象限", "2×2 四宫格"),
}

LAYOUT_META = {
    "sparse": ("Low (1-2 elements)", "55-65% of canvas"),
    "balanced": ("Medium (3-4 key points)", "40-50% of canvas"),
    "dense": ("High (5-8 key points)", "20-30% of canvas"),
    "list": ("Medium (4-7 items)", "35-45% of canvas"),
    "comparison": ("Medium (2 columns x 2-3 items)", "30-40% of canvas"),
    "flow": ("Medium (3-6 steps)", "35-45% of canvas"),
    "mindmap": ("Medium (4-8 branches)", "30-40% of canvas"),
    "quadrant": ("Medium (4 sections)", "30-40% of canvas"),
}

_EMOJI_RE = re.compile(
    "[\U0001F000-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF\uFE0F\u200D\u20E3]"
)

# ---------------------------------------------------------------------------
# skill 文件读取
# ---------------------------------------------------------------------------

def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return ""


def _strip_frontmatter(text: str) -> str:
    if text.startswith("---"):
        parts = text.split("---", 2)
        if len(parts) >= 3:
            return parts[2].strip()
    return text.strip()


def _skill_ok() -> bool:
    return (SKILL_DIR / "references" / "presets").is_dir()


PALETTE_LABELS = {"macaron": "马卡龙", "warm": "暖色", "neon": "霓虹"}


def _style_names() -> list[str]:
    folder = SKILL_DIR / "references" / "presets"
    names = sorted(path.stem for path in folder.glob("*.md"))
    if names:
        return names
    # 预设目录缺失时回落到内置清单：接口不为空，页面不会出现「0 套风格」。
    logger.warning("配图预设目录为空，使用内置风格清单: {}", folder)
    return list(STYLE_LABELS)


def _layout_names() -> list[str]:
    return list(LAYOUT_META)


def _palette_names() -> list[str]:
    folder = SKILL_DIR / "references" / "palettes"
    names = sorted(path.stem for path in folder.glob("*.md"))
    if names:
        return names
    logger.warning("配色目录为空，使用内置配色清单: {}", folder)
    return list(PALETTE_LABELS)


def list_styles() -> list[dict[str, str]]:
    items = []
    for key in _style_names():
        label, hint = STYLE_LABELS.get(key, (key, "baoyu-xhs-images 预设风格"))
        items.append({"key": key, "label": label, "hint": hint})
    return items


def list_layouts() -> list[dict[str, str]]:
    return [
        {"key": key, "label": LAYOUT_LABELS.get(key, (key, ""))[0],
         "hint": LAYOUT_LABELS.get(key, (key, ""))[1]}
        for key in _layout_names()
    ]


def list_palettes() -> list[dict[str, str]]:
    return [
        {"key": key, "label": PALETTE_LABELS.get(key, key), "hint": "覆盖风格自带配色"}
        for key in _palette_names()
    ]


def list_presets() -> list[dict[str, str]]:
    text = _read(SKILL_DIR / "references" / "style-presets.md")
    items: list[dict[str, str]] = []
    for line in text.splitlines():
        match = re.match(
            r"\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*`?([^`|]*?)`?\s*\|",
            line,
        )
        if not match:
            continue
        name, style, layout, palette = (part.strip() for part in match.groups())
        if name in {item["key"] for item in items}:
            continue
        items.append(
            {"key": name, "style": style, "layout": layout, "palette": palette}
        )
    return items


def _browser() -> str:
    env = os.environ.get("OPS_BROWSER", "")
    if env and Path(env).is_file():
        return env
    for candidate in (
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    ):
        if Path(candidate).is_file():
            return candidate
    for name in ("msedge", "chrome"):
        found = shutil.which(name)
        if found:
            return found
    return ""


def _has_engine() -> bool:
    """有 Playwright 自带 Chromium 就算可用；否则再看系统浏览器。"""
    try:
        from playwright.sync_api import sync_playwright  # noqa: F401
    except ImportError:
        pass
    else:
        return True
    return bool(_browser())


def backend_status() -> dict[str, Any]:
    browser = _browser()
    return {
        "ok": bool(_has_engine() and _skill_ok()),
        "provider": "local",
        "model": "html-css",
        "quality": f"{WIDTH}x{HEIGHT}",
        "aspect": "3:4",
        "skill_dir": str(SKILL_DIR),
        "skill_ready": _skill_ok(),
        "counts": {
            "styles": len(list_styles()),
            "layouts": len(list_layouts()),
            "palettes": len(list_palettes()),
        },
        "ref_chain": False,
        "browser": browser,
        "paid": False,
    }


# ---------------------------------------------------------------------------
# 配色与字体
# ---------------------------------------------------------------------------

def _hexes(text: str) -> list[str]:
    return re.findall(r"#[0-9A-Fa-f]{3,8}", text or "")


def _role_colors(text: str) -> dict[str, list[str]]:
    """解析 markdown 表格里的 Role + Hex/Colors 两列。"""
    result: dict[str, list[str]] = {}
    header: list[str] | None = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line.startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        if all(re.fullmatch(r":?-{2,}:?", cell) for cell in cells if cell):
            continue
        if header is None:
            header = [cell.lower() for cell in cells]
            continue
        row = {key: (cells[i] if i < len(cells) else "") for i, key in enumerate(header)}
        role = (row.get("role") or "").strip().lower()
        if not role:
            continue
        hexes = _hexes(row.get("hex", "")) or _hexes(row.get("colors", ""))
        if hexes:
            result.setdefault(role, []).extend(hexes)
    return result


def _blend(color: str, ratio: float) -> str:
    value = (color or "").lstrip("#")
    if len(value) == 3:
        value = "".join(char * 2 for char in value)
    if len(value) != 6:
        return "#F4F1EA"
    red, green, blue = (int(value[i:i + 2], 16) for i in (0, 2, 4))
    mix = lambda channel: int(channel + (255 - channel) * ratio)
    return f"#{mix(red):02X}{mix(green):02X}{mix(blue):02X}"


def _tokens(style: str, palette: str) -> dict[str, Any]:
    preset = _role_colors(
        _strip_frontmatter(_read(SKILL_DIR / "references" / "presets" / f"{style}.md"))
    )
    primary = preset.get("primary") or ["#333333"]
    background = preset.get("background") or ["#FFFFFF"]
    accents = preset.get("accents") or primary
    font_key = style

    if palette:
        values = _role_colors(
            _strip_frontmatter(_read(SKILL_DIR / "references" / "palettes" / f"{palette}.md"))
        )
        if values.get("background"):
            background = values["background"]
        if values.get("text"):
            primary = values["text"] + primary[1:]
        if values.get("secondary text"):
            primary = primary[:1] + values["secondary text"]
        blocks = values.get("block color", []) + values.get("accent", [])
        if blocks:
            accents = blocks

    ink = primary[0]
    muted = primary[1] if len(primary) > 1 else _blend(ink, 0.45)
    bg = background[0]
    if style == "chalkboard" and _luma(bg) > 0.6:
        bg = "#23372F"
    return {
        "ink": ink,
        "muted": muted,
        "bg": bg,
        "bg2": background[-1] if len(background) > 1 else _blend(bg, 0.45),
        "a1": accents[0] if accents else ink,
        "a2": accents[1] if len(accents) > 1 else _blend(accents[0] if accents else ink, 0.55),
        "a3": accents[2] if len(accents) > 2 else _blend(accents[0] if accents else ink, 0.75),
        "tint1": _blend(accents[0] if accents else ink, 0.86),
        "tint2": _blend(accents[1] if len(accents) > 1 else (accents[0] if accents else ink), 0.86),
        "tint3": _blend(accents[2] if len(accents) > 2 else (accents[0] if accents else ink), 0.88),
        "font": _font_stack(font_key),
    }


def _luma(color: str) -> float:
    value = (color or "").lstrip("#")
    if len(value) != 6:
        return 1.0
    red, green, blue = (int(value[i:i + 2], 16) / 255 for i in (0, 2, 4))
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue


def _font_stack(style: str) -> str:
    hand = '"Kaiti SC","STKaiti","KaiTi","FangSong","Microsoft YaHei",serif'
    round_font = '"YouYuan","Microsoft YaHei","PingFang SC",sans-serif'
    sans = '"Microsoft YaHei","PingFang SC","Noto Sans CJK SC",sans-serif'
    bold = '"Microsoft YaHei","SimHei","PingFang SC",sans-serif'
    if style == "cute":
        return round_font
    if style in {"notion", "study-notes", "chalkboard", "warm", "fresh", "retro", "sketch-notes"}:
        return hand
    if style in {"bold", "pop", "screen-print"}:
        return bold
    return sans


# ---------------------------------------------------------------------------
# 文案拆页（沿用原逻辑）
# ---------------------------------------------------------------------------

def _clean(text: str) -> str:
    text = _EMOJI_RE.sub("", str(text or ""))
    text = re.sub(r"^\s*[#*>\-\u00b7\u2022\s]+", "", text)
    return re.sub(r"\s+", " ", text).strip()


_BULLET_RE = re.compile(
    r"^\s*(?:[✅💡📌🔹🔸]|[1-9]\ufe0f?\u20e3|[·•\-*])\s*"
)


def _is_section(line: str) -> bool:
    return bool(re.match(r"^[✨🔍📌🎯📎🧩]\s*.{1,12}\s*[✨🔍📌🎯📎🧩]?$", line))


def _body_lines(desc: str) -> list[tuple[str, str]]:
    lines: list[tuple[str, str]] = []
    for raw in (desc or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if re.fullmatch(r"\s*(#[^\s#]+\s*)+", line):
            continue
        if _is_section(line):
            kind = "section"
        elif _BULLET_RE.match(line):
            kind = "bullet"
        else:
            kind = "plain"
        line = _clean(line)
        if len(line) < 6:
            continue
        lines.append((line, kind))
    return lines


_SECTION_NUM_RE = re.compile(r"^(?:[一二三四五六七八九十]+[、.]|\d+[、.)]|[①-⑩])\s*(.+)$")
_VOCATIVE_RE = re.compile(r"^(姐妹们|宝子们|家人们|朋友们|大家|各位|说真的|说实话|其实)$")


def _short(text: str, limit: int) -> str:
    parts = [part.strip() for part in re.split(r"[。！？!?；;]", text) if part.strip()]
    text = parts[0] if parts else text
    if len(text) > limit:
        text = text[:limit].rstrip("，,。") + "…"
    return text


def _points(lines: list[str], kinds: list[str] | None = None) -> list[tuple[str, str]]:
    sections: list[tuple[str, list[str]]] = []
    for index, line in enumerate(lines):
        kind = kinds[index] if kinds else ""
        match = _SECTION_NUM_RE.match(line)
        if match and len(match.group(1).strip()) >= 4:
            sections.append((match.group(1).strip(), []))
            continue
        if kind == "section" or (not kinds and _is_section(line)):
            sections.append((line, []))
            continue
        if sections:
            sections[-1][1].append(line)
    if len(sections) >= 2:
        return [
            (_short(heading, 14), _short(body[0] if body else heading, 30))
            for heading, body in sections
        ][:8]

    points: list[tuple[str, str]] = []
    for index, line in enumerate(lines):
        if kinds and kinds[index] == "section":
            continue
        if _is_section(line):
            continue
        if len(line) > 34:
            parts = [part.strip() for part in re.split(r"[。！？!?；;]", line) if part.strip()]
            line = parts[0] if parts else line[:34]
        heading = ""
        body = line
        for sep in ("：", ":"):
            if sep in line:
                left, right = line.split(sep, 1)
                if 2 <= len(left.strip()) <= 12 and len(right.strip()) >= 4:
                    heading, body = left.strip(), right.strip()
                    break
        if not heading:
            for sep in ("，", ","):
                if sep in line:
                    left, right = line.split(sep, 1)
                    if (
                        2 <= len(left.strip()) <= 10
                        and len(right.strip()) >= 6
                        and not _VOCATIVE_RE.match(left.strip())
                    ):
                        heading, body = left.strip(), right.strip()
                        break
        if not heading:
            heading = f"要点 {len(points) + 1}"
        if len(body) > 30:
            body = body[:30].rstrip("，,。") + "…"
        points.append((heading, body))
        if len(points) >= 8:
            break
    return points


def _group(points: list[tuple[str, str]], layout: str) -> list[list[tuple[str, str]]]:
    if layout == "sparse":
        return [points[:2]] if points else []
    if layout == "list":
        return [points[:5]] if points else []
    if layout == "dense":
        if len(points) <= 4:
            return [points]
        return [points[:4], points[4:8]]
    if layout in {"comparison", "flow", "mindmap", "quadrant"}:
        return [points[:4] if layout != "flow" else points[:5]] if points else []
    return [points[:4]] if points else []


def _plan(draft: dict[str, Any], layout: str) -> list[dict[str, Any]]:
    title = _clean(draft.get("title") or "未命名笔记")
    raw_lines = _body_lines(str(draft.get("desc") or ""))
    plain_lines = [line for line, _ in raw_lines]
    kinds = [kind for _, kind in raw_lines]
    bullet_lines = [line for line, kind in raw_lines if kind == "bullet"]
    points = _points(bullet_lines)
    if len(points) < 3:
        points = _points(plain_lines, kinds)
    subtitle = _clean(draft.get("angle") or "")
    if not subtitle:
        body_lines = [line for line, kind in raw_lines if kind != "section"]
        subtitle = body_lines[0] if body_lines else "把这件事讲清楚，比背模板有用"
    subtitle = subtitle[:26].rstrip("，,。") + ("…" if len(subtitle) > 26 else "")

    pages: list[dict[str, Any]] = [
        {
            "type": "cover",
            "layout": "sparse",
            "items": [f"Title: {title}", f"Subtitle: {subtitle}"],
            "heading": title,
        }
    ]

    groups = _group(points, layout)
    for group_index, group in enumerate(groups, start=1):
        items = [f"Title: {title if group_index == 1 else '接着看'}"]
        if layout == "comparison":
            left = group[:2]
            right = group[2:4] or group[:2]
            items.append("Left Column Heading: 做法 A")
            for row, (heading, body) in enumerate(left, start=1):
                items.append(f"Left {row} Heading: {heading}")
                items.append(f"Left {row} Line: {body}")
            items.append("Right Column Heading: 做法 B")
            for row, (heading, body) in enumerate(right, start=1):
                items.append(f"Right {row} Heading: {heading}")
                items.append(f"Right {row} Line: {body}")
        elif layout == "flow":
            for row, (heading, body) in enumerate(group, start=1):
                items.append(f"Step {row} Heading: {heading}")
                items.append(f"Step {row} Line: {body}")
        elif layout == "mindmap":
            for row, (heading, body) in enumerate(group, start=1):
                items.append(f"Branch {row} Heading: {heading}")
                items.append(f"Branch {row} Line: {body}")
        elif layout == "quadrant":
            for row, (heading, body) in enumerate(group[:4], start=1):
                items.append(f"Section {row} Heading: {heading}")
                items.append(f"Section {row} Line: {body}")
        else:
            for row, (heading, body) in enumerate(group, start=1):
                items.append(f"Row {row} Heading: {heading}")
                items.append(f"Row {row} Line: {body}")
        pages.append(
            {
                "type": "content",
                "layout": layout,
                "items": items,
                "heading": title if group_index == 1 else "接着看",
            }
        )

    ending_line = ""
    for line in reversed(plain_lines):
        if "评论" in line or "内测" in line or "想要" in line or "需要" in line:
            ending_line = line
            break
    if not ending_line and plain_lines:
        ending_line = plain_lines[-1]
    pages.append(
        {
            "type": "ending",
            "layout": "sparse",
            "items": [
                "Title: 先存着，用得上时翻出来",
                f"Subtitle: {ending_line or '评论区聊聊你的看法'}",
            ],
            "heading": "先存着",
        }
    )
    total = len(pages)
    for index, page in enumerate(pages, start=1):
        page["index"] = index
        page["total"] = total
    return pages


# ---------------------------------------------------------------------------
# HTML 渲染
# ---------------------------------------------------------------------------

BASE_CSS = """
:root{--bg:__BG__;--bg2:__BG2__;--ink:__INK__;--muted:__MUTED__;--a1:__A1__;--a2:__A2__;--a3:__A3__;
--tint1:__TINT1__;--tint2:__TINT2__;--tint3:__TINT3__;--line:__LINE__;--font:__FONT__;--radius:__RADIUS__}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:1080px;height:1440px}
body{background:var(--bg);color:var(--ink);font-family:var(--font);overflow:hidden;position:relative}
body::before{content:"";position:absolute;inset:0;background-image:radial-gradient(var(--line) 1.1px,transparent 1.1px);
background-size:26px 26px;opacity:.45;pointer-events:none}
.card{position:relative;width:100%;height:100%;padding:84px 80px;display:flex;flex-direction:column}
.mark{background:linear-gradient(transparent 56%,var(--a2) 56%,var(--a2) 92%,transparent 92%);
padding:0 6px;border-radius:6px;box-decoration-break:clone;-webkit-box-decoration-break:clone}
h1{font-size:68px;line-height:1.32;font-weight:700;letter-spacing:.5px}
.card-title{font-size:52px;line-height:1.3;font-weight:700;margin-bottom:44px}
.sub{font-size:38px;line-height:1.55;color:var(--muted);margin-top:32px}
.num{display:flex;align-items:center;justify-content:center;width:62px;height:62px;border-radius:50%;
background:var(--a1);color:#fff;font-weight:700;font-size:32px;flex:none;border:3px solid var(--ink)}
.ic{width:64px;height:64px;flex:none;color:var(--ink)}
.ic svg{width:100%;height:100%;display:block}
b{font-weight:700}
/* cover */
.cover .copy{position:absolute;left:80px;top:400px;width:720px}
.cover h1{font-size:64px}
.cover .sub{width:620px}
.cover .doodle{position:absolute;right:46px;top:250px;width:360px;color:var(--ink)}
/* ending */
.ending .inner{margin:auto;text-align:center;max-width:840px}
.ending h1{font-size:64px}
.ending .sub{font-size:40px;margin-top:40px}
.ending .doodle{position:absolute;right:104px;top:236px;width:230px;color:var(--ink)}
/* list */
.list .rows{flex:1;display:flex;flex-direction:column;justify-content:space-evenly;padding-bottom:24px}
.list .row{display:grid;grid-template-columns:66px 76px 1fr;column-gap:26px;align-items:start;
padding:24px 6px;border-bottom:3px dashed var(--line)}
.list .row:last-child{border-bottom:none}
.list .row b{display:block;font-size:40px;line-height:1.35;margin-bottom:10px}
.list .row p{font-size:31px;line-height:1.5;color:var(--muted)}
/* flow */
.flow{flex:1;display:flex;flex-direction:column;justify-content:center;padding-bottom:30px}
.flow .step{display:grid;grid-template-columns:70px 1fr;gap:24px;align-items:center;padding:28px 34px;
border:3px solid var(--ink);border-radius:var(--radius);background:var(--bg2)}
.flow .step b{font-size:40px;line-height:1.3}
.flow .step p{font-size:29px;line-height:1.45;color:var(--muted);margin-top:8px}
.flow .arrow{height:52px;display:flex;align-items:center;justify-content:center;color:var(--ink)}
.flow .arrow svg{width:36px;height:52px}
/* grid */
.grid{flex:1;display:grid;grid-template-columns:1fr 1fr;gap:28px;align-content:center;padding-bottom:24px}
.cell{padding:30px 32px;border:3px solid var(--ink);border-radius:var(--radius);background:var(--tint1)}
.cell:nth-child(2){background:var(--tint2)}
.cell:nth-child(3){background:var(--tint3)}
.cell:nth-child(4){background:var(--tint1)}
.cell b{display:block;font-size:34px;line-height:1.3;margin-bottom:10px}
.cell p{font-size:27px;line-height:1.45;color:var(--muted)}
.dense .grid{gap:22px}
.dense .cell{padding:22px 24px}
.dense .cell b{font-size:30px}
.dense .cell p{font-size:23px}
/* comparison */
.compare{flex:1;display:grid;grid-template-columns:1fr 8px 1fr;gap:34px;align-content:center;padding-bottom:24px}
.compare .col-head{display:inline-block;padding:10px 22px;border:3px solid var(--ink);border-radius:999px;
font-size:32px;font-weight:700;background:var(--tint1);margin-bottom:26px}
.compare .col:nth-child(3) .col-head{background:var(--tint2)}
.compare .item{margin-bottom:26px}
.compare .item b{font-size:29px;display:block;margin-bottom:6px}
.compare .item p{font-size:25px;line-height:1.45;color:var(--muted)}
.divider{background:var(--ink);opacity:.22;border-radius:4px}
/* mindmap */
.mind{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:32px;padding-bottom:20px}
.mind .core{padding:22px 48px;border:3px solid var(--ink);border-radius:999px;background:var(--a2);
font-size:36px;font-weight:700}
.mind .branches{display:grid;grid-template-columns:1fr 1fr;gap:24px;width:100%}
.mind .branch{padding:22px 26px;border:3px solid var(--ink);border-left:10px solid var(--a1);
border-radius:var(--radius);background:var(--tint2)}
.mind .branch b{font-size:30px;display:block;margin-bottom:8px}
.mind .branch p{font-size:25px;line-height:1.45;color:var(--muted)}
/* quadrant */
.quad{flex:1;display:grid;grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr;gap:24px;padding-bottom:24px}
.quad .cell{padding:34px;display:flex;flex-direction:column;justify-content:center}
.quad .cell b{font-size:34px}
.quad .cell p{font-size:26px}
/* sparse content */
.sparse .rows{flex:1;display:flex;flex-direction:column;justify-content:center;gap:56px;text-align:center}
.sparse .row b{font-size:46px;display:block;margin-bottom:14px}
.sparse .row p{font-size:32px;color:var(--muted)}
"""

STYLE_CSS = {
    "study-notes": """
body{background-image:repeating-linear-gradient(transparent,transparent 63px,rgba(90,130,190,.16) 63px,
rgba(90,130,190,.16) 64px)}
body::after{content:"";position:absolute;left:96px;top:0;bottom:0;width:3px;background:#E58C8C;opacity:.32}
""",
    "chalkboard": """
body::before{opacity:.14}
.card-title,h1{text-shadow:0 0 8px rgba(255,255,255,.18)}
.cell,.flow .step,.mind .branch{background:rgba(255,255,255,.06)}
""",
    "screen-print": """
body::before{background-image:radial-gradient(var(--line) 2.2px,transparent 2.2px);background-size:18px 18px;opacity:.28}
h1,.card-title{letter-spacing:2px}
.num{border-radius:6px}
""",
    "minimal": """
body::before{opacity:.18}
.cell,.flow .step,.mind .branch,.compare .col-head{background:transparent}
""",
    "bold": """
h1,.card-title{font-weight:900;letter-spacing:1px}
.mark{background:linear-gradient(transparent 60%,var(--a2) 60%,var(--a2) 94%,transparent 94%)}
""",
}

ICON_PATHS = {
    "pen": '<path d="M16 64l8-20 28-28 12 12-28 28z"/><path d="M16 64l20-8"/>',
    "bulb": '<circle cx="40" cy="34" r="18"/><path d="M32 52h16M34 60h12M40 16v-6M12 34H6M74 34h-6M20 14l-5-5M60 14l5-5"/>',
    "book": '<path d="M14 16h38a12 12 0 0 1 12 12v38H26a12 12 0 0 1-12-12z"/><path d="M64 26v40"/><path d="M24 28h28"/>',
    "clock": '<circle cx="40" cy="40" r="26"/><path d="M40 24v18l12 8"/>',
    "leaf": '<path d="M64 16C38 18 20 34 18 62c28 2 44-16 46-46z"/><path d="M22 62c8-14 18-24 32-32"/>',
    "chat": '<path d="M14 18h52v34H36L20 66l2-14H14z"/><path d="M26 34h28M26 44h18"/>',
}
ICON_ORDER = ["pen", "bulb", "book", "clock", "leaf", "chat"]

COVER_DOODLE = """
<svg viewBox="0 0 360 320" fill="none" stroke="currentColor" stroke-width="5"
stroke-linecap="round" stroke-linejoin="round">
<path d="M40 34h150v66H100l-26 24 4-24H40z"/>
<path d="M70 66h88" stroke-width="4" stroke-dasharray="10 10"/>
<text x="238" y="112" font-size="56" font-family="sans-serif" fill="currentColor" stroke="none">?</text>
<text x="286" y="84" font-size="40" font-family="sans-serif" fill="currentColor" stroke="none">?</text>
<ellipse cx="196" cy="196" rx="50" ry="54"/>
<circle cx="180" cy="190" r="4" fill="currentColor" stroke="none"/>
<circle cx="212" cy="190" r="4" fill="currentColor" stroke="none"/>
<path d="M182 214q14 10 28 0"/>
<path d="M196 250v34"/><path d="M196 284l-30 26"/><path d="M196 284l30 26"/>
<path d="M172 264l-34-18"/><path d="M222 264l34-18"/>
</svg>
"""

ENDING_DOODLE = """
<svg viewBox="0 0 240 240" fill="none" stroke="currentColor" stroke-width="5"
stroke-linecap="round" stroke-linejoin="round">
<rect x="56" y="26" width="130" height="164" rx="12"/>
<path d="M56 78h130" stroke-width="4" stroke-dasharray="8 8"/>
<path d="M96 118h52M96 142h40M96 166h30"/>
<circle cx="186" cy="70" r="20"/>
<path d="M186 62v10l7 5"/>
</svg>
"""


def _esc(value: Any) -> str:
    return html.escape(str(value or ""))


def _highlight(text: str) -> str:
    # 只高亮末尾 4 个字，避免整段被划线后换行断裂。
    if len(text) > 4:
        return f"{_esc(text[:-4])}<span class=\"mark\">{_esc(text[-4:])}</span>"
    return f"<span class=\"mark\">{_esc(text)}</span>"


def _title(page: dict[str, Any]) -> str:
    for item in page["items"]:
        if item.startswith("Title: "):
            return item[7:]
    return page.get("heading") or ""


def _subtitle(page: dict[str, Any]) -> str:
    for item in page["items"]:
        if item.startswith("Subtitle: "):
            return item[10:]
    return ""


def _rows(page: dict[str, Any]) -> list[tuple[str, str]]:
    pairs: dict[int, dict[str, str]] = {}
    for item in page["items"]:
        match = re.match(r"(Row|Step|Branch|Section) (\d+) (Heading|Line): (.+)", item)
        if match:
            pairs.setdefault(int(match.group(2)), {})[match.group(3)] = match.group(4)
    return [
        (data.get("Heading", ""), data.get("Line", ""))
        for _, data in sorted(pairs.items())
    ]


def _compare(page: dict[str, Any]) -> tuple[str, list[tuple[str, str]], str, list[tuple[str, str]]]:
    left_head = right_head = ""
    left: dict[int, dict[str, str]] = {}
    right: dict[int, dict[str, str]] = {}
    for item in page["items"]:
        if item.startswith("Left Column Heading: "):
            left_head = item[len("Left Column Heading: "):]
        elif item.startswith("Right Column Heading: "):
            right_head = item[len("Right Column Heading: "):]
        else:
            match = re.match(r"(Left|Right) (\d+) (Heading|Line): (.+)", item)
            if match:
                target = left if match.group(1) == "Left" else right
                target.setdefault(int(match.group(2)), {})[match.group(3)] = match.group(4)
    to_list = lambda data: [
        (value.get("Heading", ""), value.get("Line", ""))
        for _, value in sorted(data.items())
    ]
    return left_head, to_list(left), right_head, to_list(right)


def _icon(name: str) -> str:
    return (
        '<span class="ic"><svg viewBox="0 0 80 80" fill="none" stroke="currentColor" '
        f'stroke-width="4" stroke-linecap="round" stroke-linejoin="round">{ICON_PATHS[name]}</svg></span>'
    )


def _rows_html(rows: list[tuple[str, str]], with_icons: bool = True) -> str:
    chunks = []
    for index, (heading, body) in enumerate(rows):
        icon = _icon(ICON_ORDER[index % len(ICON_ORDER)]) if with_icons else ""
        chunks.append(
            f'<div class="row"><span class="num">{index + 1}</span>{icon}'
            f'<div><b>{_esc(heading)}</b><p>{_esc(body)}</p></div></div>'
        )
    return "".join(chunks)


def _body_for(page: dict[str, Any], layout: str) -> str:
    kind = page["type"]
    title = _title(page)
    if kind == "cover":
        return (
            f'<div class="copy"><h1>{_highlight(title)}</h1>'
            f'<p class="sub">{_esc(_subtitle(page))}</p></div>'
            f'<div class="doodle">{COVER_DOODLE}</div>'
        )
    if kind == "ending":
        return (
            f'<div class="doodle">{ENDING_DOODLE}</div>'
            f'<div class="inner"><h1>{_highlight(title)}</h1>'
            f'<p class="sub">{_esc(_subtitle(page))}</p></div>'
        )

    head = f'<h1 class="card-title">{_highlight(title)}</h1>'
    rows = _rows(page)
    if layout == "list":
        return head + f'<div class="rows">{_rows_html(rows)}</div>'
    if layout == "flow":
        steps = []
        for index, (heading, body) in enumerate(rows):
            if index:
                steps.append(
                    '<div class="arrow"><svg viewBox="0 0 36 52" fill="none" stroke="currentColor" '
                    'stroke-width="4" stroke-linecap="round" stroke-linejoin="round">'
                    '<path d="M18 4v38"/><path d="M8 34l10 12 10-12"/></svg></div>'
                )
            steps.append(
                f'<div class="step"><span class="num">{index + 1}</span>'
                f'<div><b>{_esc(heading)}</b><p>{_esc(body)}</p></div></div>'
            )
        return head + f'<div class="flow">{"".join(steps)}</div>'
    if layout == "comparison":
        left_head, left, right_head, right = _compare(page)

        def column(name: str, items: list[tuple[str, str]]) -> str:
            body = "".join(
                f'<div class="item"><b>{_esc(heading)}</b><p>{_esc(line)}</p></div>'
                for heading, line in items
            )
            return f'<div class="col"><span class="col-head">{_esc(name)}</span>{body}</div>'

        return head + (
            f'<div class="compare">{column(left_head, left)}'
            f'<div class="divider"></div>{column(right_head, right)}</div>'
        )
    if layout == "mindmap":
        branches = "".join(
            f'<div class="branch"><b>{_esc(heading)}</b><p>{_esc(body)}</p></div>'
            for heading, body in rows
        )
        return head + (
            f'<div class="mind"><div class="core">{_esc(_short(title, 16))}</div>'
            f'<div class="branches">{branches}</div></div>'
        )
    if layout == "quadrant":
        cells = "".join(
            f'<div class="cell"><b>{_esc(heading)}</b><p>{_esc(body)}</p></div>'
            for heading, body in rows[:4]
        )
        return head + f'<div class="quad">{cells}</div>'
    if layout == "sparse":
        blocks = "".join(
            f'<div class="row"><b>{_esc(heading)}</b><p>{_esc(body)}</p></div>'
            for heading, body in rows
        )
        return head + f'<div class="rows">{blocks}</div>'
    cells = "".join(
        f'<div class="cell"><b>{_esc(heading)}</b><p>{_esc(body)}</p></div>'
        for heading, body in rows
    )
    return head + f'<div class="grid">{cells}</div>'


def _radius(style: str) -> str:
    if style in {"notion", "study-notes", "warm", "fresh", "cute", "sketch-notes"}:
        return "24px 28px 22px 30px / 28px 22px 30px 24px"
    if style in {"bold", "pop", "screen-print", "minimal"}:
        return "10px"
    return "18px"


def render_page_html(
    page: dict[str, Any],
    *,
    style: str,
    layout: str,
    palette: str = "",
) -> str:
    tokens = _tokens(style, palette)
    css = (
        BASE_CSS.replace("__BG__", tokens["bg"])
        .replace("__BG2__", tokens["bg2"])
        .replace("__INK__", tokens["ink"])
        .replace("__MUTED__", tokens["muted"])
        .replace("__A1__", tokens["a1"])
        .replace("__A2__", tokens["a2"])
        .replace("__A3__", tokens["a3"])
        .replace("__TINT1__", tokens["tint1"])
        .replace("__TINT2__", tokens["tint2"])
        .replace("__TINT3__", tokens["tint3"])
        .replace("__LINE__", _blend(tokens["ink"], 0.72))
        .replace("__FONT__", tokens["font"])
        .replace("__RADIUS__", _radius(style))
    )
    css += STYLE_CSS.get(style, "")
    body = _body_for(page, layout)
    return f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>{_esc(_title(page))}</title>
<style>{css}</style></head>
<body><main class="card {layout} {page['type']}">{body}</main></body></html>
"""


# ---------------------------------------------------------------------------
# 截图与缓存
# ---------------------------------------------------------------------------

def _backup(path: Path) -> None:
    if not path.exists():
        return
    stamp = datetime.now().strftime("%Y%m%d%H%M%S")
    path.rename(path.with_name(f"{path.stem}-backup-{stamp}{path.suffix}"))


def _signature(html_text: str, style: str, layout: str, palette: str) -> str:
    payload = f"{RENDERER}\n{style}/{layout}/{palette}\n{html_text}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _playwright_shot(
    html_path: Path, image_path: Path, width: int, height: int, timeout: float
) -> bool:
    """优先用 Playwright 自带 Chromium 截图，返回 False 表示需要系统浏览器兜底。

    自带 Chromium 不依赖本机 Edge/Chrome，也带真实超时；系统浏览器那条路
    在部分机器上会卡住管道，只作为最后兜底。
    """
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        return False
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                page = browser.new_page(
                    viewport={"width": int(width), "height": int(height)},
                    device_scale_factor=1,
                )
                page.goto(html_path.as_uri(), wait_until="load", timeout=timeout * 1000)
                page.wait_for_timeout(120)
                page.screenshot(path=str(image_path), timeout=timeout * 1000)
            finally:
                browser.close()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Playwright 截图不可用（{}），改用系统浏览器", exc)
        return False
    return image_path.exists() and image_path.stat().st_size > 0


def _shoot(
    html_path: Path,
    image_path: Path,
    timeout: float = 120,
    width: int | None = None,
    height: int | None = None,
) -> None:
    shot_width = int(width or WIDTH)
    shot_height = int(height or HEIGHT)
    limit = max(1.0, min(120.0, float(timeout)))
    logger.info("本地渲染: {} -> {}", html_path.name, image_path.name)
    if _playwright_shot(html_path, image_path, shot_width, shot_height, limit):
        return
    browser = _browser()
    if not browser:
        raise RuntimeError(
            "没有可用的渲染内核：请执行 python -m playwright install chromium，"
            "或安装 Chrome/Edge"
        )
    with tempfile.TemporaryDirectory(prefix="ops-shot-") as profile:
        command = [
            browser,
            "--headless=new",
            "--disable-gpu",
            "--hide-scrollbars",
            "--force-device-scale-factor=1",
            f"--user-data-dir={profile}",
            f"--window-size={shot_width},{shot_height}",
            f"--screenshot={image_path}",
            html_path.as_uri(),
        ]
        try:
            # 不接管道：浏览器子进程若挂住，持有管道的句柄会让 timeout 失效。
            proc.run(
                command,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=limit,
            )
        except subprocess.TimeoutExpired:
            logger.warning("系统浏览器截图超时: {}", html_path.name)
    if not image_path.exists() or image_path.stat().st_size == 0:
        raise RuntimeError("截图失败，未生成图片；请检查 Playwright Chromium 是否已安装")


def render_cards(
    draft: dict[str, Any],
    style: str | None = None,
    layout: str | None = None,
    palette: str | None = None,
) -> list[str]:
    """按本地 HTML 模板渲染整组配图，返回图片绝对路径。"""
    if not _skill_ok():
        raise RuntimeError(f"找不到 baoyu-xhs-images skill：{SKILL_DIR}")
    style = style or db.get_setting("card_style", DEFAULT_STYLE)
    layout = layout or db.get_setting("card_layout", DEFAULT_LAYOUT)
    palette = palette if palette is not None else db.get_setting("card_palette", DEFAULT_PALETTE)
    style = style if style in _style_names() else DEFAULT_STYLE
    layout = layout if layout in LAYOUT_META else DEFAULT_LAYOUT
    palette = palette if palette in _palette_names() else ""

    pages = _plan(draft, layout)
    folder = config.ASSETS_DIR / f"draft-{int(draft['id'])}"
    folder.mkdir(parents=True, exist_ok=True)
    meta_path = folder / "meta.json"
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        meta = {}

    results: list[str] = []
    deadline = time.monotonic() + config.RENDER_TIMEOUT_SEC
    # 全局渲染锁：拿不到就明确报错，不能让请求无限排队。
    if not _LOCK.acquire(timeout=max(1.0, config.RENDER_TIMEOUT_SEC)):
        raise RuntimeError("配图渲染队列繁忙，请稍后重试")
    try:
        for page in pages:
            if time.monotonic() > deadline:
                raise RuntimeError("配图渲染超时，请稍后重试")
            slug = f"{page['index']:02d}-{page['type']}"
            html_text = render_page_html(
                page, style=style, layout=page["layout"], palette=palette
            )
            signature = _signature(html_text, style, page["layout"], palette)
            html_path = folder / f"{slug}.html"
            image_path = folder / f"{slug}.png"
            if html_path.exists() and html_path.read_text(encoding="utf-8") != html_text:
                _backup(html_path)
            html_path.write_text(html_text, encoding="utf-8")

            if image_path.exists() and meta.get(slug) == signature:
                logger.info("复用已有配图: {}", image_path.name)
                results.append(str(image_path))
                continue

            _backup(image_path)
            remaining = deadline - time.monotonic()
            if remaining <= 1:
                raise RuntimeError("配图渲染超时，请稍后重试")
            _shoot(html_path, image_path, timeout=remaining)
            results.append(str(image_path))
            meta[slug] = signature
    finally:
        _LOCK.release()

    kept = {
        key: value
        for key, value in meta.items()
        if key not in {"provider", "model", "quality", "aspect", "ref_chain"}
    }
    meta_path.write_text(
        json.dumps(
            {
                **kept,
                "style": style,
                "layout": layout,
                "palette": palette,
                "renderer": RENDERER,
                "size": f"{WIDTH}x{HEIGHT}",
                "paid": False,
                "pages": [page["type"] for page in pages],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return results


# ---------------------------------------------------------------------------
# 付费出图（qwen-image-3.0）
# ---------------------------------------------------------------------------

def paid_backend_status() -> dict[str, Any]:
    """付费出图的可用状态与价格口径；可用与否取决于云端账号与配图 Key。"""
    state = cloud.status()
    image_key = state.get("keys", {}).get("image") or {}
    if not state.get("logged_in"):
        reason = "请先登录 EchoQ 账号后再付费出图"
    elif not image_key.get("ready"):
        reason = "本机还没有配图 Key，请在账号面板点一次「重置」"
    else:
        reason = cloud.blocked_reason("image")
    styles = list_styles()
    layouts = list_layouts()
    palettes = list_palettes()
    return {
        "configured": not reason,
        "provider": "EchoQ-Cloud",
        "model": PAID_IMAGE_MODEL,
        "unit_price": PAID_IMAGE_PRICE,
        "count": PAID_IMAGE_COUNT,
        "currency": "CNY",
        "size": "1k",
        "styles": styles,
        "layouts": layouts,
        "palettes": palettes,
        "available": {
            "styles": len(styles),
            "layouts": len(layouts),
            "palettes": len(palettes),
        },
        "source": "skill" if _skill_ok() else "builtin",
        "remaining_units": state.get("subscription", {}).get("remaining_units"),
        "reason": reason,
    }


def _paid_prompt(
    draft: dict[str, Any],
    page: dict[str, Any],
    style_key: str,
    layout: str,
    palette: str,
) -> str:
    title = _clean(draft.get("title") or "小红书笔记")
    heading = _clean(page.get("heading") or title)
    details = [
        _clean(item.split(": ", 1)[1])
        for item in page.get("items") or []
        if ": " in item
    ]
    detail_text = "；".join(details[:3])
    style_label, style_hint = STYLE_LABELS.get(style_key, (style_key, "小红书卡片风格"))
    layout_hint = LAYOUT_LABELS.get(layout, ("均衡版式", "3-4 个信息点"))[1]
    palette_label = next(
        (item["label"] for item in list_palettes() if item["key"] == palette), ""
    )
    return (
        f"小红书竖版知识卡片配图，3:4 构图。"
        f"视觉风格：{style_label}，{style_hint}。"
        f"版式结构：{layout_hint}。"
        + (f"配色：{palette_label}。" if palette_label else "")
        + f"主题：{title}。本页：{heading}。"
        + (f"信息要点：{detail_text}。" if detail_text else "")
        + "用图形化标题字形、标签贴纸、装饰元素与背景纹理构建版面，"
        "信息层级清晰、留白与装饰节奏讲究；不要出现可识别的文字、字母、数字或水印。"
    )


def _relay_error(exc: urllib.error.HTTPError) -> str:
    """云端中转错误是 OpenAI 风格，优先取 error.message。"""
    try:
        body = json.loads(exc.read().decode("utf-8"))
        error = body.get("error") if isinstance(body, dict) else None
        if isinstance(error, dict) and error.get("message"):
            return str(error["message"])
    except (ValueError, OSError):
        pass
    return f"配图接口返回 HTTP {exc.code}"


def _paid_generate_one(prompt: str, target: Path) -> None:
    """通过云端中转生成 1 张图；上游 Key 不会出现在本机。"""
    key = cloud.require("image")
    request = urllib.request.Request(
        cloud.relay_url("/v1/images/generations"),
        data=json.dumps(
            {
                "prompt": prompt,
                "size": PAID_IMAGE_SIZE,
                "response_format": "url",
            },
            ensure_ascii=False,
        ).encode("utf-8"),
        method="POST",
    )
    request.add_header("Authorization", f"Bearer {key}")
    request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=210) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"付费出图失败：{_relay_error(exc)}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise RuntimeError("付费出图连接失败，请检查网络后重试") from exc

    items = payload.get("data") if isinstance(payload, dict) else None
    item = items[0] if isinstance(items, list) and items else {}
    if not isinstance(item, dict):
        item = {}
    if item.get("b64_json"):
        target.write_bytes(base64.b64decode(str(item["b64_json"])))
        return
    image_url = str(item.get("url") or "")
    if not image_url:
        raise RuntimeError("付费出图失败：云端没有返回图片地址")
    request = urllib.request.Request(image_url)
    with urllib.request.urlopen(request, timeout=90) as response:
        target.write_bytes(response.read())


def render_paid_cards(
    draft: dict[str, Any], style: str = "", layout: str = "", palette: str = ""
) -> list[str]:
    """调用云端中转生成配图。未登录或订阅失效时会在任何网络请求前直接报错。"""
    status = paid_backend_status()
    if not status["configured"]:
        raise ValueError(status["reason"])
    style_key = style if style in STYLE_LABELS else next(iter(STYLE_LABELS))
    layout_key = layout if layout in LAYOUT_LABELS else "balanced"
    pages = _plan(draft, layout_key)[:PAID_IMAGE_COUNT]
    folder = config.ASSETS_DIR / f"draft-{int(draft['id'])}"
    folder.mkdir(parents=True, exist_ok=True)

    results: list[str] = []
    with _LOCK:
        for index, page in enumerate(pages, start=1):
            target = folder / f"paid-{index:02d}-{page['type']}.png"
            _backup(target)
            _paid_generate_one(
                _paid_prompt(draft, page, style_key, layout_key, palette), target
            )
            results.append(str(target))

    (folder / "paid-meta.json").write_text(
        json.dumps(
            {
                "provider": "echoq-cloud",
                "model": PAID_IMAGE_MODEL,
                "style": style_key,
                "layout": layout_key,
                "palette": palette,
                "count": len(results),
                "unit_price": PAID_IMAGE_PRICE,
                "size": PAID_IMAGE_SIZE,
                "pages": [page["type"] for page in pages],
                "paid": True,
                "created_at": datetime.now().isoformat(timespec="seconds"),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return results


__all__ = [
    "render_cards",
    "render_page_html",
    "list_styles",
    "list_layouts",
    "list_palettes",
    "list_presets",
    "backend_status",
    "paid_backend_status",
    "render_paid_cards",
    "STYLE_LABELS",
]
