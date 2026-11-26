# encoding: utf-8
"""程序化手绘插画：用代码画「媒材」，而不是换一套配色。

灵感来自 anidoodle 的做法：一种风格等于一种做标记的方式。笔尖锥度、压感、
抖动、渗色、颗粒、纸张、套印偏移决定画面像不像手画的；主体只用最简单的
几何，真正的工作量在「这一笔怎么落下去」。

四种媒材：

- ``art-chalk``      粉笔黑板：笔画被板面颗粒打断，两侧留粉，底上有旧课痕迹。
- ``art-blueprint``  蓝图制图：青色底、白色制图线、尺寸标注与套印偏移。
- ``art-engrave``    单线雕刻：一条不断线走完，线宽跟着明暗走。
- ``art-watercolor`` 铅笔水彩：淡彩差一点填不满铅笔线，颜料积在形状底边。

输出仍然是 HTML（内联 SVG）→ 本机 Edge/Chrome 截图，和 designs 共用一条
管线。所有随机都来自字符串种子的 Mersenne Twister，不读时钟，同一份文案
同一个版本号永远得到同一张图。
"""

from __future__ import annotations

import hashlib
import html
import json
import math
import random
import re
import threading
from pathlib import Path
from typing import Any

from loguru import logger

from ops import config
from ops.illustrator import _shoot

WIDE_WIDTH = 1080
WIDE_HEIGHT = 460
PORTRAIT_WIDTH = 1080
PORTRAIT_HEIGHT = 1440
INLINE_WIDTH = 1080
INLINE_HEIGHT = 680

RENDERER = "art-local-v1"
DEFAULT_STYLE = "art-chalk"
LOCK = threading.Lock()

ART_STYLES: list[dict[str, Any]] = [
    {
        "key": "art-chalk",
        "name": "黑板粉笔",
        "tagline": "Chalk & Board",
        "desc": "粉笔侧锋蹭出颗粒，笔画会被板面吃掉一点，底上留着上一节课的痕",
        "fit": "教程、科普、干货拆解",
        "colors": ["#22352C", "#F4F1E4", "#F2D06B"],
        "group": "art",
        "kind": "art",
    },
    {
        "key": "art-blueprint",
        "name": "蓝图制图",
        "tagline": "Cyanotype Draft",
        "desc": "青色底白色制图线，尺寸标注、中心线与套印偏移都保留",
        "fit": "方法论、系统、产品结构",
        "colors": ["#1B4F8A", "#F2F6F2", "#8FC3E8"],
        "group": "art",
        "kind": "art",
    },
    {
        "key": "art-engrave",
        "name": "单线雕刻",
        "tagline": "One-Line Engraving",
        "desc": "一笔画到底，线宽跟着明暗走，纸上只留墨和排线",
        "fit": "观点、深度长文、人物",
        "colors": ["#F3EDE0", "#2C2620", "#8A6A45"],
        "group": "art",
        "kind": "art",
    },
    {
        "key": "art-watercolor",
        "name": "铅笔水彩",
        "tagline": "Pencil & Wash",
        "desc": "淡彩不填满铅笔线，颜料积在形状底边，石墨再压一层",
        "fit": "生活方式、情绪、日常",
        "colors": ["#FBF7EE", "#4A4A46", "#E9A23B"],
        "group": "art",
        "kind": "art",
    },
]

ART_KEYS = {item["key"] for item in ART_STYLES}

PALETTES = {
    "art-chalk": {
        "paper": "#22352C",
        "ink": "#F4F1E4",
        "soft": "rgba(244,241,228,.62)",
        "accent": "#F2D06B",
        "second": "#E98D8D",
        "third": "#9FD6C0",
    },
    "art-blueprint": {
        "paper": "#1B4F8A",
        "ink": "#F2F6F2",
        "soft": "rgba(242,246,242,.66)",
        "accent": "#BFE0F2",
        "second": "#8FC3E8",
        "third": "#D8ECF7",
    },
    "art-engrave": {
        "paper": "#F3EDE0",
        "ink": "#2C2620",
        "soft": "rgba(44,38,32,.62)",
        "accent": "#8A6A45",
        "second": "#4B3B2C",
        "third": "#A78A67",
    },
    "art-watercolor": {
        "paper": "#FBF7EE",
        "ink": "#4A4A46",
        "soft": "rgba(74,74,70,.58)",
        "accent": "#E9A23B",
        "second": "#7FA8C9",
        "third": "#C0705F",
    },
}

# 淡彩 / 粉笔填色的四档色相，按 motif 语义分配，不随风格换色。
WASH_COLORS = {
    "art-chalk": ["rgba(244,241,228,.30)", "rgba(242,208,107,.28)", "rgba(233,141,141,.26)", "rgba(159,214,192,.24)"],
    "art-watercolor": ["rgba(233,162,59,.30)", "rgba(127,168,201,.28)", "rgba(192,112,95,.26)", "rgba(140,168,120,.26)"],
}


def list_art_styles() -> list[dict[str, Any]]:
    return [dict(item) for item in ART_STYLES]


def is_art_style(key: str) -> bool:
    return key in ART_KEYS


def art_style(key: str) -> dict[str, Any]:
    for item in ART_STYLES:
        if item["key"] == key:
            return dict(item)
    return dict(ART_STYLES[0])


def art_canvas(platform: str = "", scope: str = "cover") -> dict[str, Any]:
    """封面跟平台走：公众号宽幅、其余竖版；正文插图固定 1080×680。"""
    if scope == "inline":
        return {
            "key": "inline",
            "width": INLINE_WIDTH,
            "height": INLINE_HEIGHT,
            "aspect": "27:17",
            "label": "正文插画",
        }
    if str(platform or "").strip() == "wechat_mp":
        return {
            "key": "wide",
            "width": WIDE_WIDTH,
            "height": WIDE_HEIGHT,
            "aspect": "2.35:1",
            "label": "公众号宽幅封面",
        }
    return {
        "key": "portrait",
        "width": PORTRAIT_WIDTH,
        "height": PORTRAIT_HEIGHT,
        "aspect": "3:4",
        "label": "竖版插画封面",
    }


def count_art_pages() -> int:
    """插画风格固定只出一张：封面就是那一张，正文图另行插入。"""
    return 1


# ---------------------------------------------------------------------------
# 种子与基础几何
# ---------------------------------------------------------------------------


def _rng(seed: str) -> random.Random:
    digest = hashlib.sha256(seed.encode("utf-8")).digest()
    return random.Random(int.from_bytes(digest[:8], "big"))


def _fmt(value: float) -> str:
    text = f"{value:.1f}"
    return text[:-2] if text.endswith(".0") else text


def _d(points: list[tuple[float, float]], close: bool = False) -> str:
    if not points:
        return ""
    body = " L".join(f"{_fmt(x)} {_fmt(y)}" for x, y in points)
    return "M" + body + (" Z" if close else "")


def _dist(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _smooth(points: list[tuple[float, float]], per: int = 7) -> list[tuple[float, float]]:
    if len(points) < 3:
        return [tuple(p) for p in points]
    padded = [points[0]] + list(points) + [points[-1]]
    out: list[tuple[float, float]] = []
    for index in range(1, len(padded) - 2):
        p0, p1, p2, p3 = padded[index - 1], padded[index], padded[index + 1], padded[index + 2]
        for step in range(per):
            t = step / per
            t2, t3 = t * t, t * t * t
            x = 0.5 * (
                2 * p1[0]
                + (-p0[0] + p2[0]) * t
                + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2
                + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3
            )
            y = 0.5 * (
                2 * p1[1]
                + (-p0[1] + p2[1]) * t
                + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2
                + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3
            )
            out.append((x, y))
    out.append(tuple(points[-1]))
    return out


def _quad(a, b, c, steps: int = 8) -> list[tuple[float, float]]:
    out = []
    for index in range(steps + 1):
        t = index / steps
        u = 1 - t
        out.append(
            (
                u * u * a[0] + 2 * u * t * b[0] + t * t * c[0],
                u * u * a[1] + 2 * u * t * b[1] + t * t * c[1],
            )
        )
    return out


def _circle(
    cx: float,
    cy: float,
    rx: float,
    ry: float | None = None,
    rng: random.Random | None = None,
    wobble: float = 0.0,
    steps: int = 44,
) -> list[tuple[float, float]]:
    ry = rx if ry is None else ry
    out = []
    for index in range(steps + 1):
        angle = 2 * math.pi * index / steps
        jitter = rng.uniform(-wobble, wobble) if rng else 0.0
        out.append(
            ((rx + jitter) * math.cos(angle) + cx, (ry + jitter) * math.sin(angle) + cy)
        )
    return out


def _arc(
    cx: float,
    cy: float,
    rx: float,
    ry: float,
    start: float,
    end: float,
    steps: int = 18,
) -> list[tuple[float, float]]:
    out = []
    for index in range(steps + 1):
        angle = math.radians(start + (end - start) * index / steps)
        out.append((cx + rx * math.cos(angle), cy + ry * math.sin(angle)))
    return out


def _round_rect(x0: float, y0: float, x1: float, y1: float, r: float) -> list[tuple[float, float]]:
    r = min(r, (x1 - x0) / 2, (y1 - y0) / 2)
    corners = [(x1 - r, y0 + r, -90), (x1 - r, y1 - r, 0), (x0 + r, y1 - r, 90), (x0 + r, y0 + r, 180)]
    out: list[tuple[float, float]] = []
    for cx, cy, start in corners:
        for step in range(5):
            angle = math.radians(start + 90 * step / 4)
            out.append((cx + r * math.cos(angle), cy + r * math.sin(angle)))
    return out


def _leaf(
    base: tuple[float, float],
    tip: tuple[float, float],
    width: float,
    rng: random.Random | None = None,
) -> list[tuple[float, float]]:
    dx, dy = tip[0] - base[0], tip[1] - base[1]
    length = math.hypot(dx, dy) or 1
    nx, ny = -dy / length, dx / length
    mx, my = (base[0] + tip[0]) / 2, (base[1] + tip[1]) / 2
    c1 = (mx + nx * width, my + ny * width)
    c2 = (mx - nx * width, my - ny * width)
    first = _quad(base, c1, tip, 12)
    second = _quad(tip, c2, base, 12)
    points = first + second[1:]
    if rng:
        points = [(x + rng.uniform(-1.4, 1.4), y + rng.uniform(-1.4, 1.4)) for x, y in points]
    return points


def _wobble(points: list[tuple[float, float]], rng: random.Random, amount: float) -> list[tuple[float, float]]:
    return [
        (x + rng.uniform(-amount, amount), y + rng.uniform(-amount, amount))
        for x, y in points
    ]


def _ribbon(
    points: list[tuple[float, float]],
    w0: float,
    w1: float,
    rng: random.Random | None = None,
    wobble: float = 0.14,
) -> str:
    """把折线变成有锥度的带子：起笔细、收笔细，中间压感最重。"""
    count = len(points)
    if count < 2:
        return ""
    left: list[tuple[float, float]] = []
    right: list[tuple[float, float]] = []
    for index, (x, y) in enumerate(points):
        if index == 0:
            tx, ty = points[1][0] - x, points[1][1] - y
        elif index == count - 1:
            tx, ty = x - points[-2][0], y - points[-2][1]
        else:
            tx, ty = points[index + 1][0] - points[index - 1][0], points[index + 1][1] - points[index - 1][1]
        norm = math.hypot(tx, ty) or 1
        nx, ny = -ty / norm, tx / norm
        t = index / (count - 1)
        width = w0 + (w1 - w0) * t
        # 真实的压感不是线性的：两端轻、中段重。
        width *= 0.72 + 0.42 * math.sin(math.pi * min(1.0, max(0.0, t)))
        if rng:
            width *= 1 + rng.uniform(-wobble, wobble)
        width /= 2
        left.append((x + nx * width, y + ny * width))
        right.append((x - nx * width, y - ny * width))
    return _d(left + right[::-1], True)


def _bbox(points: list[tuple[float, float]]) -> tuple[float, float, float, float]:
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return min(xs), min(ys), max(xs), max(ys)


# ---------------------------------------------------------------------------
# 图形脚本：主体只描述「形状」，媒材决定怎么落笔
# ---------------------------------------------------------------------------


def _figure() -> dict[str, list[Any]]:
    return {"outline": [], "detail": [], "wash": [], "accent": [], "label": []}


def _motif_bulb(rng: random.Random) -> dict[str, list[Any]]:
    fig = _figure()
    glass = _circle(480, 352, 168, rng=rng, wobble=2.2)
    fig["outline"].append((glass, True))
    fig["detail"].append(([(432, 508), (438, 604)], False))
    fig["detail"].append(([(528, 508), (522, 604)], False))
    for y in (604, 640, 676):
        fig["outline"].append(([(436, y), (524, y)], False))
    fig["detail"].append(([(444, 604), (444, 676)], False))
    fig["detail"].append(([(516, 604), (516, 676)], False))
    fig["detail"].append(([(458, 506), (472, 466), (488, 504), (502, 462), (506, 506)], False))
    for angle in range(-156, -20, 16):
        rad = math.radians(angle)
        fig["accent"].append(([(480 + 198 * math.cos(rad), 352 + 198 * math.sin(rad)),
                               (480 + 246 * math.cos(rad), 352 + 246 * math.sin(rad))], False))
    for cx, cy, size in ((742, 236, 22), (268, 292, 16), (688, 620, 13)):
        fig["accent"].append(([(cx - size, cy), (cx + size, cy)], False))
        fig["accent"].append(([(cx, cy - size), (cx, cy + size)], False))
    fig["wash"].append((glass, 0))
    fig["wash"].append(([(436, 604), (524, 604), (524, 676), (436, 676)], 2))
    fig["label"].append((690, 470, "IDEA"))
    return fig


def _motif_book(rng: random.Random) -> dict[str, list[Any]]:
    fig = _figure()
    left = [(500, 596), (192, 522), (192, 704), (500, 742)]
    right = [(500, 596), (808, 522), (808, 704), (500, 742)]
    fig["outline"].append((left, True))
    fig["outline"].append((right, True))
    fig["outline"].append(([(500, 596), (500, 742)], False))
    fig["detail"].append(([(192, 704), (192, 726), (500, 764), (808, 726), (808, 704)], False))
    for side in (left, right):
        for row in (1, 2, 3):
            offset = row * 38
            start_x = side[0][0] + (60 if side is left else -60)
            end_x = side[0][0] + (250 if side is left else -250)
            fig["detail"].append(([(start_x, 600 + offset), (end_x, 636 + offset)], False))
    fig["accent"].append((([(560, 588), (560, 700), (540, 670), (520, 700), (520, 588)], False)))
    fig["wash"].append((left, 1))
    fig["wash"].append((right, 0))
    fig["label"].append((700, 470, "NOTES"))
    return fig


def _motif_plant(rng: random.Random) -> dict[str, list[Any]]:
    fig = _figure()
    pot = [(402, 688), (598, 688), (574, 838), (426, 838)]
    fig["outline"].append((pot, True))
    fig["outline"].append((([(384, 688), (616, 688), (610, 708), (390, 708)], True)))
    stem = _smooth([(500, 690), (492, 610), (506, 546), (498, 468)], 6)
    fig["outline"].append((stem, False))
    leaves = [
        ((498, 646), (322, 596), 66),
        ((502, 606), (672, 520), 72),
        ((499, 548), (338, 468), 58),
        ((497, 502), (644, 416), 62),
        ((498, 470), (502, 352), 48),
    ]
    for base, tip, width in leaves:
        leaf = _leaf(base, tip, width, rng)
        fig["outline"].append((leaf, True))
        fig["detail"].append(([base, tip], False))
        fig["wash"].append((leaf, 1 if width > 60 else 0))
    fig["detail"].append(([(426, 706), (574, 706)], False))
    for x in (300, 330, 700, 730):
        fig["accent"].append(([(x, 640), (x + 6, 604)], False))
    fig["wash"].append((pot, 3))
    fig["label"].append((712, 366, "GROW"))
    return fig


def _motif_chat(rng: random.Random) -> dict[str, list[Any]]:
    fig = _figure()
    bubble1 = _round_rect(188, 296, 690, 520, 46)
    bubble2 = _round_rect(466, 566, 862, 768, 40)
    fig["outline"].append((bubble1, True))
    fig["outline"].append((bubble2, True))
    fig["detail"].append(([(300, 516), (262, 606), (392, 522)], False))
    fig["detail"].append(([(772, 764), (814, 842), (688, 768)], False))
    for cx in (586, 630, 674):
        fig["detail"].append((_circle(cx, 410, 13, rng=rng, wobble=0.8), True))
    fig["detail"].append(([(520, 654), (762, 654)], False))
    fig["detail"].append(([(520, 700), (686, 700)], False))
    fig["accent"].append(([(902, 598), (962, 586)], False))
    fig["accent"].append(([(906, 652), (966, 652)], False))
    fig["wash"].append((bubble1, 1))
    fig["wash"].append((bubble2, 0))
    fig["label"].append((700, 470, "SAY IT"))
    return fig


def _motif_laptop(rng: random.Random) -> dict[str, list[Any]]:
    fig = _figure()
    outer = _round_rect(268, 246, 732, 562, 28)
    inner = _round_rect(300, 278, 700, 530, 12)
    base = [(202, 640), (798, 640), (878, 722), (122, 722)]
    fig["outline"].append((outer, True))
    fig["detail"].append((inner, True))
    fig["outline"].append((base, True))
    for y, x2 in ((330, 562), (370, 646), (410, 522), (452, 604)):
        fig["detail"].append(([(336, y), (x2, y)], False))
    fig["detail"].append((_round_rect(336, 484, 362, 508, 3), True))
    for x in range(250, 800, 62):
        fig["detail"].append(([(x, 664), (x + 30, 664)], False))
    fig["accent"].append(([(826, 290), (884, 250)], False))
    fig["accent"].append(([(840, 334), (898, 306)], False))
    fig["wash"].append((inner, 2))
    fig["wash"].append((base, 1))
    fig["label"].append((738, 490, "BUILD"))
    return fig


def _motif_clock(rng: random.Random) -> dict[str, list[Any]]:
    fig = _figure()
    face = _circle(500, 470, 226, rng=rng, wobble=2.0)
    fig["outline"].append((face, True))
    fig["detail"].append((_circle(500, 470, 204), True))
    for index in range(12):
        angle = math.radians(index * 30 - 90)
        fig["detail"].append(
            ([(500 + 188 * math.cos(angle), 470 + 188 * math.sin(angle)),
              (500 + 212 * math.cos(angle), 470 + 212 * math.sin(angle))], False)
        )
    fig["outline"].append(([(500, 470), (500, 344)], False))
    fig["outline"].append(([(500, 470), (636, 516)], False))
    fig["detail"].append((_circle(500, 470, 14), True))
    fig["accent"].append((_arc(500, 470, 272, 272, -58, -24), False))
    fig["accent"].append((_arc(500, 470, 300, 300, -34, -8), False))
    fig["wash"].append((face, 0))
    fig["wash"].append((_circle(500, 470, 96), 2))
    fig["label"].append((700, 470, "TIME"))
    return fig


def _motif_path(rng: random.Random) -> dict[str, list[Any]]:
    fig = _figure()
    sun = _circle(764, 236, 82, rng=rng, wobble=1.4)
    fig["outline"].append((sun, True))
    for angle in range(0, 360, 45):
        rad = math.radians(angle)
        fig["accent"].append(
            ([(764 + 106 * math.cos(rad), 236 + 106 * math.sin(rad)),
              (764 + 138 * math.cos(rad), 236 + 138 * math.sin(rad))], False)
        )
    back = [(120, 622), (332, 348), (470, 528), (600, 318), (884, 622)]
    front = [(228, 654), (400, 476), (572, 654)]
    fig["outline"].append((back, True))
    fig["outline"].append((front, True))
    trail = _smooth([(498, 650), (566, 700), (518, 762), (582, 820), (540, 866)], 7)
    fig["detail"].append((trail, False))
    fig["detail"].append((_smooth([(552, 654), (620, 706), (572, 766), (636, 824), (594, 870)], 7), False))
    fig["accent"].append(([(600, 318), (600, 222)], False))
    fig["outline"].append((([(600, 224), (694, 256), (600, 288)], True)))
    fig["wash"].append((back, 1))
    fig["wash"].append((front, 2))
    fig["wash"].append((sun, 0))
    fig["label"].append((716, 470, "GO"))
    return fig


def _motif_cup(rng: random.Random) -> dict[str, list[Any]]:
    fig = _figure()
    body = _smooth([(332, 486), (668, 486), (644, 744), (500, 772), (356, 744)], 8)
    rim = _circle(500, 486, 168, 28, rng=rng, wobble=1.2, steps=40)
    saucer = _circle(500, 800, 264, 34, rng=rng, wobble=1.0, steps=48)
    fig["outline"].append((body, True))
    fig["outline"].append((rim, True))
    fig["outline"].append((saucer, True))
    fig["detail"].append((_arc(664, 612, 96, 96, -78, 78), False))
    fig["detail"].append((_smooth([(430, 432), (412, 366), (444, 304)], 6), False))
    fig["detail"].append((_smooth([(546, 432), (562, 362), (530, 298)], 6), False))
    fig["wash"].append((body, 0))
    fig["wash"].append((rim, 2))
    fig["label"].append((744, 470, "PAUSE"))
    return fig


def _motif_target(rng: random.Random) -> dict[str, list[Any]]:
    fig = _figure()
    outer = _circle(500, 470, 208, rng=rng, wobble=1.6)
    middle = _circle(500, 470, 140)
    inner = _circle(500, 470, 76)
    fig["outline"].append((outer, True))
    fig["detail"].append((middle, True))
    fig["detail"].append((inner, True))
    fig["outline"].append(([(786, 176), (552, 436)], False))
    fig["detail"].append(([(790, 172), (552, 430)], False))
    fig["detail"].append(([(552, 436), (612, 408)], False))
    fig["detail"].append(([(552, 436), (578, 496)], False))
    for step in range(3):
        x = 706 - step * 34
        y = 258 + step * 34
        fig["accent"].append(([(x, y), (x - 34, y - 4)], False))
        fig["accent"].append(([(x, y), (x + 4, y + 34)], False))
    fig["wash"].append((outer, 0))
    fig["wash"].append((inner, 2))
    fig["label"].append((700, 470, "AIM"))
    return fig


def _motif_note(rng: random.Random) -> dict[str, list[Any]]:
    fig = _figure()
    paper = [(252, 238), (560, 238), (652, 330), (652, 782), (252, 782)]
    fig["outline"].append((paper, True))
    fig["detail"].append(([(560, 238), (560, 330), (652, 330)], False))
    for row, width in enumerate((300, 250, 320, 200)):
        y = 400 + row * 92
        fig["detail"].append((_smooth([(300, y), (430, y - 6), (556, y + 4)], 4), False))
        if width > 260:
            fig["detail"].append(([(300, y + 26), (520, y + 20)], False))
    nx, ny = 0.706, -0.708
    body = [
        (520 + nx * 26, 872 + ny * 26),
        (816 + nx * 26, 574 + ny * 26),
        (816 - nx * 26, 574 - ny * 26),
        (520 - nx * 26, 872 - ny * 26),
    ]
    fig["outline"].append((body, True))
    fig["detail"].append(([(816 + nx * 26, 574 + ny * 26), (884, 504), (816 - nx * 26, 574 - ny * 26)], True))
    fig["detail"].append(([(544 + nx * 8, 850 + ny * 8), (806 + nx * 8, 584 + ny * 8)], False))
    fig["wash"].append((paper, 0))
    fig["wash"].append((body, 2))
    fig["label"].append((700, 470, "DRAFT"))
    return fig


MOTIFS = {
    "bulb": _motif_bulb,
    "book": _motif_book,
    "plant": _motif_plant,
    "chat": _motif_chat,
    "laptop": _motif_laptop,
    "clock": _motif_clock,
    "path": _motif_path,
    "cup": _motif_cup,
    "target": _motif_target,
    "note": _motif_note,
}

# 关键词只是「选主体」，不参与画法；命中越多越优先，平手时由种子决定。
_MOTIF_RULES: list[tuple[str, str]] = [
    ("bulb", "想法|创意|灵感|思路|方法|思维|认知|原理|为什么|如何|idea|复盘"),
    ("book", "书|读|学习|知识|课程|笔记|考试|技能|教程|入门|书单"),
    ("plant", "成长|坚持|习惯|种植|植物|生活|变化|治愈|自然|慢慢|长期"),
    ("chat", "聊|沟通|表达|评论|互动|用户|社群|对话|面试|关系|提问"),
    ("laptop", "工作|效率|工具|程序|代码|AI|系统|产品|运营|自动化|项目|流程"),
    ("clock", "时间|早上|晚上|计划|拖延|节奏|管理|截止|效率|分配"),
    ("path", "旅行|路上|远方|选择|方向|目标|出发|转折|经历|人生|城市"),
    ("cup", "咖啡|休息|放松|下午|日常|周末|舒服|慢下来|一杯"),
    ("target", "目标|增长|数据|结果|赚钱|变现|关键|指标|转化|衡量"),
    ("note", "写|稿|修改|记录|手账|清单|拆解|步骤|模板|提纲"),
]


def _pick_motif(title: str, desc: str, rng: random.Random) -> str:
    head = (title or "").strip()
    body = (desc or "")[:800]
    scores: dict[str, float] = {}
    for key, pattern in _MOTIF_RULES:
        score = 0.0
        for word in pattern.split("|"):
            score += head.count(word) * 2.0 + body.count(word) * 1.0
        scores[key] = score
    best = max(scores.values()) if scores else 0
    if best <= 0:
        return rng.choice(list(MOTIFS))
    winners = [key for key, score in scores.items() if score == best]
    return winners[0] if len(winners) == 1 else rng.choice(winners)


# ---------------------------------------------------------------------------
# 媒材：同一份形状，四种落笔方式
# ---------------------------------------------------------------------------


def _split_runs(
    points: list[tuple[float, float]],
    rng: random.Random,
    gap_chance: float = 0.05,
    min_len: int = 5,
) -> list[list[tuple[float, float]]]:
    """粉笔会被板面颗粒打断：随机丢掉几小段，不重画整笔。"""
    runs: list[list[tuple[float, float]]] = []
    current: list[tuple[float, float]] = []
    total = len(points)
    for index, point in enumerate(points):
        current.append(point)
        if (
            min_len < index < total - min_len
            and len(current) > min_len
            and rng.random() < gap_chance
        ):
            runs.append(current)
            current = []
    if len(current) > 1:
        runs.append(current)
    return runs or [points]


def _dust(
    points: list[tuple[float, float]],
    rng: random.Random,
    color: str,
    width: float,
    opacity: float = 0.35,
) -> str:
    """粉笔两侧飞出来的粉：沿笔画撒小点，不做模糊。"""
    out: list[str] = []
    for point in points[::3]:
        for _ in range(2):
            angle = rng.uniform(0, math.tau)
            radius = rng.uniform(width * 0.9, width * 2.6)
            cx = point[0] + math.cos(angle) * radius
            cy = point[1] + math.sin(angle) * radius
            size = rng.uniform(0.7, 2.1)
            out.append(
                f'<circle cx="{_fmt(cx)}" cy="{_fmt(cy)}" r="{_fmt(size)}" '
                f'fill="{color}" opacity="{rng.uniform(0.10, opacity):.2f}"/>'
            )
    return "".join(out)


def _chalk_stroke(
    points: list[tuple[float, float]],
    rng: random.Random,
    color: str,
    width: float,
    *,
    closed: bool = False,
    opacity: float = 0.92,
) -> str:
    pts = _smooth(points, 4) if len(points) > 2 else list(points)
    if closed and pts[0] != pts[-1]:
        pts = pts + [pts[0]]
    chunks: list[list[tuple[float, float]]] = []
    for run in _split_runs(pts, rng):
        # 每一段再随机分成 1-2 笔，接缝处重叠一点，像真的蹭了两下。
        if len(run) > 14 and rng.random() < 0.5:
            cut = rng.randint(6, len(run) - 6)
            chunks.append(run[:cut])
            chunks.append(run[cut - 1:])
        else:
            chunks.append(run)
    out: list[str] = []
    for chunk in chunks:
        ribbon = _ribbon(chunk, width * 0.55, width * 0.9, rng)
        out.append(f'<path d="{ribbon}" fill="{color}" opacity="{opacity:.2f}"/>')
        out.append(_dust(chunk, rng, color, width * 0.5))
    return "".join(out)


def _scribble_fill(
    shape: list[tuple[float, float]],
    color: str,
    rng: random.Random,
    *,
    gap: float,
    width: float,
    opacity: float,
    cid: str,
) -> str:
    left, top, right, bottom = _bbox(shape)
    lines: list[str] = []
    y = top - gap
    while y < bottom + gap:
        points = []
        x = left - 16
        while x < right + 16:
            points.append((x, y + rng.uniform(-2.2, 2.2) + (x - left) * 0.035))
            x += 26
        lines.append(f'<path d="{_d(points)}"/>')
        y += gap
    return (
        f'<defs><clipPath id="{cid}"><path d="{_d(shape, True)}"/></clipPath></defs>'
        f'<g clip-path="url(#{cid})" fill="none" stroke="{color}" stroke-width="{_fmt(width)}" '
        f'stroke-linecap="round" opacity="{opacity:.2f}">{"".join(lines)}</g>'
    )


def _ink_stroke(
    points: list[tuple[float, float]],
    base: float,
    rng: random.Random,
    color: str,
    *,
    phase: float = 0.0,
) -> str:
    """单线雕刻：一条线拆成很多小节，每节线宽不同，拼起来仍是同一条线。"""
    count = len(points)
    if count < 2:
        return ""
    out: list[str] = []
    index = 0
    while index < count - 1:
        end = min(count, index + 16)
        chunk = points[index:end]
        t = index / max(1, count - 1)
        width = base * (0.30 + 1.15 * (0.5 + 0.5 * math.sin(t * math.pi * 3.4 + phase)))
        out.append(
            f'<path d="{_d(chunk)}" fill="none" stroke="{color}" '
            f'stroke-width="{width:.1f}" stroke-linecap="round"/>'
        )
        index = end - 1
    return "".join(out)


def _chain(order_shapes: list[list[tuple[float, float]]]) -> list[list[tuple[float, float]]]:
    """把多个形状按最近端点串成一条路，中间用很细的连线接上。"""
    remaining = list(order_shapes)
    ordered: list[list[tuple[float, float]]] = []
    cursor: tuple[float, float] | None = None
    while remaining:
        if cursor is None:
            index = max(range(len(remaining)), key=lambda i: _dist(remaining[i][0], remaining[i][-1]))
            points = remaining.pop(index)
        else:
            best = None
            for i, pts in enumerate(remaining):
                for reverse in (False, True):
                    start = pts[-1] if reverse else pts[0]
                    distance = _dist(cursor, start)
                    if best is None or distance < best[0]:
                        best = (distance, i, reverse)
            _, index, reverse = best  # type: ignore[misc]
            points = remaining.pop(index)
            if reverse:
                points = list(reversed(points))
        ordered.append(points)
        cursor = points[-1]
    return ordered


def _pencil_line(
    points: list[tuple[float, float]],
    rng: random.Random,
    color: str,
    width: float,
    *,
    closed: bool = False,
) -> str:
    pts = list(points)
    if closed and pts[0] != pts[-1]:
        pts = pts + [pts[0]]
    out: list[str] = []
    for pass_index in range(2):
        shifted = _wobble(pts, rng, 1.5 if pass_index else 0.9)
        out.append(
            f'<path d="{_d(shifted)}" fill="none" stroke="{color}" '
            f'stroke-width="{width * (1.0 if pass_index == 0 else 0.72):.1f}" '
            f'stroke-linecap="round" stroke-linejoin="round" '
            f'opacity="{0.88 if pass_index == 0 else 0.42}"/>'
        )
    return "".join(out)


def _wash(
    shape: list[tuple[float, float]],
    color: str,
    rng: random.Random,
    cid: str,
    *,
    opacity: float = 0.8,
    unit: float = 1.0,
) -> str:
    """水彩：形状比铅笔线大一圈，底边颜料积得更深，再点两块没化开的斑。"""
    cx = sum(p[0] for p in shape) / len(shape)
    cy = sum(p[1] for p in shape) / len(shape)
    scale = 1.03
    blob = [
        (cx + (x - cx) * scale + rng.uniform(-2.0, 2.0),
         cy + (y - cy) * scale + rng.uniform(-2.0, 2.0))
        for x, y in shape
    ]
    out = [
        f'<path d="{_d(blob, True)}" fill="{color}" opacity="{opacity:.2f}"/>'
    ]
    _, top, _, bottom = _bbox(shape)
    pool = [(x, y) for x, y in blob if y > cy + (bottom - top) * 0.16]
    if len(pool) > 3:
        out.append(
            f'<path d="{_ribbon(pool, 2.6 * unit, 2.2 * unit, rng)}" fill="{color}" '
            f'opacity="{min(1.0, opacity * 1.15):.2f}"/>'
        )
    left, _, right, _ = _bbox(shape)
    blotches = []
    for _ in range(2):
        bx = rng.uniform(left + (right - left) * 0.2, right - (right - left) * 0.2)
        by = rng.uniform(top + (bottom - top) * 0.2, bottom - (bottom - top) * 0.2)
        blotches.append(
            f'<circle cx="{_fmt(bx)}" cy="{_fmt(by)}" r="{rng.uniform(12, 30):.0f}"/>'
        )
    out.append(
        f'<defs><clipPath id="{cid}"><path d="{_d(blob, True)}"/></clipPath></defs>'
        f'<g clip-path="url(#{cid})" fill="{color}" opacity="{opacity * 0.35:.2f}">'
        f'{"".join(blotches)}</g>'
    )
    return "".join(out)


def _graphite_hatch(
    shape: list[tuple[float, float]],
    rng: random.Random,
    color: str,
    cid: str,
    *,
    gap: float = 11,
    opacity: float = 0.22,
    unit: float = 1.0,
) -> str:
    left, top, right, bottom = _bbox(shape)
    lines = []
    y = top + (bottom - top) * 0.28
    while y < bottom:
        start = (left + rng.uniform(0, 18), y)
        end = (start[0] + (right - left) * rng.uniform(0.5, 0.9), y - (right - left) * 0.34)
        lines.append(f'<path d="{_d([start, end])}"/>')
        y += gap
    return (
        f'<defs><clipPath id="{cid}"><path d="{_d(shape, True)}"/></clipPath></defs>'
        f'<g clip-path="url(#{cid})" fill="none" stroke="{color}" stroke-width="{1.3 * unit:.2f}" '
        f'stroke-linecap="round" opacity="{opacity:.2f}">{"".join(lines)}</g>'
    )


# ---------------------------------------------------------------------------
# 四种媒材的整页渲染
# ---------------------------------------------------------------------------


def _pattern_dots(cid: str, color: str, rng: random.Random, count: int, size: float, opacity: float, span: int = 260) -> str:
    dots = []
    for _ in range(count):
        cx = rng.uniform(0, span)
        cy = rng.uniform(0, span)
        radius = rng.uniform(size * 0.4, size)
        dots.append(f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{radius:.2f}"/>')
    return (
        f'<pattern id="{cid}" width="{span}" height="{span}" patternUnits="userSpaceOnUse">'
        f'<g fill="{color}" opacity="{opacity}">{"".join(dots)}</g></pattern>'
    )


def _pattern_grid(cid: str, color: str, gap: int, width: float, opacity: float) -> str:
    return (
        f'<pattern id="{cid}" width="{gap}" height="{gap}" patternUnits="userSpaceOnUse">'
        f'<path d="M{gap} 0H0V{gap}" fill="none" stroke="{color}" '
        f'stroke-width="{width}" opacity="{opacity}"/></pattern>'
    )


def _pattern_fibers(cid: str, color: str, rng: random.Random, count: int = 40) -> str:
    spans = []
    for _ in range(count):
        x = rng.uniform(0, 280)
        y = rng.uniform(0, 280)
        spans.append(
            f'<path d="M{x:.0f} {y:.0f}l{rng.uniform(6, 26):.0f} {rng.uniform(-3, 3):.1f}"/>'
        )
    return (
        f'<pattern id="{cid}" width="280" height="280" patternUnits="userSpaceOnUse">'
        f'<g fill="none" stroke="{color}" stroke-width="0.6" opacity="0.05">{"".join(spans)}</g></pattern>'
    )


def _frame_svg(style: str, width: int, height: int, rng: random.Random) -> str:
    """画面外框与制图信息：这些细节比主体更决定「像不像真的媒材」。"""
    if style == "art-blueprint":
        parts = [
            f'<rect x="18" y="18" width="{width - 36}" height="{height - 36}" fill="none" '
            f'stroke="rgba(242,246,242,.55)" stroke-width="1.4"/>',
            f'<rect x="26" y="26" width="{width - 52}" height="{height - 52}" fill="none" '
            f'stroke="rgba(242,246,242,.28)" stroke-width="1"/>',
        ]
        for x, y in ((18, 18), (width - 18, 18), (18, height - 18), (width - 18, height - 18)):
            parts.append(
                f'<path d="M{_fmt(x - 9)} {_fmt(y)}H{_fmt(x + 9)}M{_fmt(x)} {_fmt(y - 9)}V{_fmt(y + 9)}" '
                f'stroke="rgba(242,246,242,.55)" stroke-width="1"/>'
            )
        box_w, box_h = 176, 84
        bx, by = width - 34 - box_w, height - 34 - box_h
        parts.append(
            f'<g opacity=".72"><rect x="{bx}" y="{by}" width="{box_w}" height="{box_h}" fill="none" '
            f'stroke="rgba(242,246,242,.5)" stroke-width="1"/>'
            f'<path d="M{bx} {by + 26}H{bx + box_w}M{bx} {by + 52}H{bx + box_w}M{bx + 96} {by + 26}V{by + box_h}" '
            f'stroke="rgba(242,246,242,.34)" stroke-width="1"/>'
            f'<text x="{bx + 10}" y="{by + 18}" font-size="13" fill="rgba(242,246,242,.8)" '
            f'font-family="Consolas,monospace" letter-spacing="1.4">ECHOQ / ART</text>'
            f'<text x="{bx + 10}" y="{by + 45}" font-size="12" fill="rgba(242,246,242,.62)" '
            f'font-family="Consolas,monospace">FIG. 01</text>'
            f'<text x="{bx + 106}" y="{by + 45}" font-size="12" fill="rgba(242,246,242,.62)" '
            f'font-family="Consolas,monospace">SCALE 1:1</text>'
            f'<text x="{bx + 10}" y="{by + 72}" font-size="12" fill="rgba(242,246,242,.62)" '
            f'font-family="Consolas,monospace">CYANOTYPE / {width}x{height}</text></g>'
        )
        return "".join(parts)
    if style == "art-chalk":
        # 上一节课没擦干净的痕：淡淡的圆和几道杠，不抢主体。
        ghost = []
        for _ in range(4):
            cx = rng.uniform(120, width - 120)
            cy = rng.uniform(80, height - 80)
            radius = rng.uniform(60, 170)
            ghost.append(
                f'<circle cx="{cx:.0f}" cy="{cy:.0f}" r="{radius:.0f}" fill="none" '
                f'stroke="rgba(244,241,228,.045)" stroke-width="{rng.uniform(6, 16):.0f}"/>'
            )
        for _ in range(3):
            x = rng.uniform(60, width - 200)
            y = rng.uniform(60, height - 60)
            ghost.append(
                f'<path d="M{x:.0f} {y:.0f}l{rng.uniform(60, 180):.0f} {rng.uniform(-16, 16):.0f}" '
                f'stroke="rgba(244,241,228,.04)" stroke-width="{rng.uniform(8, 18):.0f}" '
                f'stroke-linecap="round"/>'
            )
        return "".join(ghost)
    if style == "art-engrave":
        return (
            f'<rect x="26" y="26" width="{width - 52}" height="{height - 52}" fill="none" '
            f'stroke="rgba(44,38,32,.22)" stroke-width="1"/>'
        )
    return ""


def _medium_chalk(fig: dict[str, list[Any]], rng: random.Random, unit: float) -> str:
    palette = PALETTES["art-chalk"]
    out: list[str] = []
    # 粉笔填色是侧锋蹭出来的，不是平涂：用被形状裁掉的横向划线模拟。
    for index, (shape, tone) in enumerate(fig["wash"]):
        color = WASH_COLORS["art-chalk"][tone % 4]
        out.append(
            _scribble_fill(
                shape, color, rng, gap=18 * unit, width=13 * unit, opacity=0.5, cid=f"cw{index}"
            )
        )
    for shape, closed in fig["outline"]:
        out.append(
            _chalk_stroke(shape, rng, palette["ink"], 15 * unit, closed=closed)
        )
    for shape, closed in fig["detail"]:
        out.append(
            _chalk_stroke(shape, rng, palette["ink"], 7 * unit, closed=closed, opacity=0.8)
        )
    for shape, _closed in fig["accent"]:
        out.append(_chalk_stroke(shape, rng, palette["accent"], 6.5 * unit, opacity=0.9))
    return "".join(out)


def _medium_blueprint(fig: dict[str, list[Any]], rng: random.Random, unit: float) -> str:
    palette = PALETTES["art-blueprint"]
    out: list[str] = []

    def ghost(shape: list[tuple[float, float]], closed: bool, width: float, dash: str = "") -> str:
        # 套印偏移：同一条线印两遍，第二遍偏 1.2px、浅一半。
        dash_attr = f' stroke-dasharray="{dash}"' if dash else ""
        return (
            f'<path d="{_d(shape, closed)}" fill="none" stroke="{palette["ink"]}" '
            f'stroke-width="{width:.2f}" stroke-linecap="round" stroke-linejoin="round"{dash_attr}/>'
            f'<path d="{_d(shape, closed)}" fill="none" stroke="{palette["ink"]}" '
            f'stroke-width="{width * 0.8:.2f}" stroke-linecap="round" '
            f'transform="translate(1.2 1.4)" opacity=".32"{dash_attr}/>'
        )

    for index, (shape, tone) in enumerate(fig["wash"]):
        cid = f"bw{index}"
        left, top, right, bottom = _bbox(shape)
        lines = []
        y = top - 20
        while y < bottom + 20:
            lines.append(f'<path d="M{left - 20:.0f} {y:.0f}L{right + 20:.0f} {y - (right - left):.0f}"/>')
            y += 20 * unit
        out.append(
            f'<defs><clipPath id="{cid}"><path d="{_d(shape, True)}"/></clipPath></defs>'
            f'<g clip-path="url(#{cid})" fill="none" stroke="{palette["ink"]}" '
            f'stroke-width="{1.15 * unit:.2f}" opacity="{0.34 if tone % 2 else 0.24}">{"".join(lines)}</g>'
        )
    for shape, closed in fig["outline"]:
        out.append(ghost(shape, closed, 2.8 * unit))
    for shape, closed in fig["detail"]:
        out.append(ghost(shape, closed, 1.5 * unit, "6 5"))
    for shape, _closed in fig["accent"]:
        out.append(ghost(shape, False, 1.4 * unit))
    # 尺寸线与中心线：蓝图的语言。
    for shape, _closed in fig["outline"][:2]:
        left, top, right, bottom = _bbox(shape)
        out.append(
            f'<path d="M{left:.0f} {top - 16:.0f}H{right:.0f}M{left:.0f} {top - 24:.0f}V{top - 8:.0f}'
            f'M{right:.0f} {top - 24:.0f}V{top - 8:.0f}" stroke="{palette["second"]}" '
            f'stroke-width="1" opacity=".55"/>'
            f'<text x="{(left + right) / 2 - 18:.0f}" y="{top - 22:.0f}" font-size="13" '
            f'fill="{palette["second"]}" font-family="Consolas,monospace" opacity=".8">'
            f'{int(right - left)} mm</text>'
        )
    for x, y, text in fig["label"]:
        out.append(
            f'<path d="M{x:.0f} {y:.0f}h56" stroke="{palette["second"]}" stroke-width="1" opacity=".6"/>'
            f'<text x="{x + 62:.0f}" y="{y + 5:.0f}" font-size="15" fill="{palette["ink"]}" '
            f'font-family="Consolas,monospace" letter-spacing="2.4" opacity=".7">{text}</text>'
            f'<circle cx="{x:.0f}" cy="{y:.0f}" r="3" fill="{palette["ink"]}" opacity=".8"/>'
        )
    return "".join(out)


def _medium_engrave(fig: dict[str, list[Any]], rng: random.Random, unit: float) -> str:
    palette = PALETTES["art-engrave"]
    out: list[str] = []
    for index, (shape, tone) in enumerate(fig["wash"]):
        cid = f"ew{index}"
        left, top, right, bottom = _bbox(shape)
        lines = []
        y = top - 14
        while y < bottom + 14:
            lines.append(f'<path d="M{left - 14:.0f} {y:.0f}L{right + 14:.0f} {y + (right - left) * 0.28:.0f}"/>')
            y += (16 if tone % 2 else 22) * unit
        if tone % 3 == 0:
            x = left - 14
            while x < right + 14:
                lines.append(f'<path d="M{x:.0f} {top - 14:.0f}L{x + (bottom - top) * 0.2:.0f} {bottom + 14:.0f}"/>')
                x += 20 * unit
        out.append(
            f'<defs><clipPath id="{cid}"><path d="{_d(shape, True)}"/></clipPath></defs>'
            f'<g clip-path="url(#{cid})" fill="none" stroke="{palette["ink"]}" '
            f'stroke-width="{1.25 * unit:.2f}" stroke-linecap="round" opacity=".55">{"".join(lines)}</g>'
        )
    outlines = []
    for shape, closed in fig["outline"]:
        pts = _smooth(shape, 5)
        if closed and pts[0] != pts[-1]:
            pts = pts + [pts[0]]
        outlines.append(pts)
    chained = _chain(outlines)
    cursor = None
    for points in chained:
        if cursor is not None and _dist(cursor, points[0]) <= 90:
            # 只用短连线接笔；跨太远的行程会像画错了，宁可断开。
            out.append(
                f'<path d="{_d([cursor, points[0]])}" fill="none" stroke="{palette["ink"]}" '
                f'stroke-width="{0.9 * unit:.1f}" opacity=".35"/>'
            )
        out.append(_ink_stroke(points, 5.2 * unit, rng, palette["ink"], phase=rng.random() * 6.2))
        cursor = points[-1]
    for shape, closed in fig["detail"]:
        pts = _smooth(shape, 4) if len(shape) > 2 else list(shape)
        if closed and pts[0] != pts[-1]:
            pts = pts + [pts[0]]
        out.append(_ink_stroke(pts, 2.6 * unit, rng, palette["ink"], phase=rng.random() * 6.2))
    for shape, _closed in fig["accent"]:
        out.append(_ink_stroke(shape, 2.4 * unit, rng, palette["accent"], phase=rng.random() * 6.2))
    # 收笔处点几粒墨，像笔尖停了一下。
    for _ in range(6):
        x = rng.uniform(60, 940)
        y = rng.uniform(60, 900)
        out.append(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="{rng.uniform(1, 2.6):.1f}" fill="{palette["ink"]}" opacity=".55"/>')
    return "".join(out)


def _medium_watercolor(fig: dict[str, list[Any]], rng: random.Random, unit: float) -> str:
    palette = PALETTES["art-watercolor"]
    out: list[str] = []
    for index, (shape, tone) in enumerate(fig["wash"]):
        cid = f"ww{index}"
        color = WASH_COLORS["art-watercolor"][tone % 4]
        out.append(_wash(shape, color, rng, cid, opacity=0.82, unit=unit))
        out.append(_graphite_hatch(shape, rng, palette["ink"], cid + "h", gap=20 * unit, opacity=0.30, unit=unit))
    for shape, closed in fig["outline"]:
        out.append(_pencil_line(shape, rng, palette["ink"], 2.6 * unit, closed=closed))
    for shape, closed in fig["detail"]:
        out.append(_pencil_line(shape, rng, palette["ink"], 1.6 * unit, closed=closed))
    for shape, _closed in fig["accent"]:
        out.append(_pencil_line(shape, rng, palette["ink"], 1.5 * unit))
    return "".join(out)


MEDIUMS = {
    "art-chalk": _medium_chalk,
    "art-blueprint": _medium_blueprint,
    "art-engrave": _medium_engrave,
    "art-watercolor": _medium_watercolor,
}

ART_BOXES = {
    "wide": (572, 34, 1042, 426),
    "portrait": (80, 430, 1000, 1250),
    "inline": (206, 24, 874, 570),
}


def _art_layer(
    fig: dict[str, list[Any]],
    style: str,
    box: tuple[float, float, float, float],
    rng: random.Random,
) -> str:
    """按主体的真实包围盒缩放：不让发型统一的空边把画面顶得很小。"""
    x0, y0, x1, y1 = box
    points: list[tuple[float, float]] = []
    for key in ("outline", "detail", "wash", "accent"):
        for shape, *_rest in fig[key]:
            points.extend(shape)
    for label in fig["label"]:
        points.append((label[0], label[1]))
    if not points:
        points = [(0, 0), (1000, 1000)]
    left, top, right, bottom = _bbox(points)
    width = max(1.0, right - left)
    height = max(1.0, bottom - top)
    scale = min((x1 - x0) * 0.96 / width, (y1 - y0) * 0.96 / height)
    tx = x0 + ((x1 - x0) - width * scale) / 2 - left * scale
    ty = y0 + ((y1 - y0) - height * scale) / 2 - top * scale
    unit = 1.0 / scale
    body = MEDIUMS[style](fig, rng, unit)
    return f'<g transform="translate({tx:.1f} {ty:.1f}) scale({scale:.4f})">{body}</g>'


def _background(style: str, width: int, height: int, rng: random.Random) -> str:
    palette = PALETTES[style]
    out = [f'<rect width="{width}" height="{height}" fill="{palette["paper"]}"/>']
    if style == "art-chalk":
        cid = "grain-chalk"
        out.append(
            f'<defs>{_pattern_dots(cid, "#FFFFFF", rng, 220, 1.5, 0.05, 300)}</defs>'
            f'<rect width="{width}" height="{height}" fill="url(#{cid})"/>'
            f'<defs>{_pattern_dots("grain-chalk-2", "#0B1712", rng, 180, 2.2, 0.10, 320)}</defs>'
            f'<rect width="{width}" height="{height}" fill="url(#grain-chalk-2)"/>'
        )
    elif style == "art-blueprint":
        out.append(
            f'<defs>{_pattern_grid("grid-bp", "#F2F6F2", 40, 0.8, 0.10)}</defs>'
            f'<rect width="{width}" height="{height}" fill="url(#grid-bp)"/>'
            f'<defs>{_pattern_dots("grain-bp", "#FFFFFF", rng, 150, 1.2, 0.05, 280)}</defs>'
            f'<rect width="{width}" height="{height}" fill="url(#grain-bp)"/>'
        )
    elif style == "art-engrave":
        out.append(
            f'<defs>{_pattern_fibers("fiber-ink", "#2C2620", rng, 46)}</defs>'
            f'<rect width="{width}" height="{height}" fill="url(#fiber-ink)"/>'
        )
    else:
        out.append(
            f'<defs>{_pattern_dots("grain-wc", "#8C7A5E", rng, 240, 1.4, 0.07, 300)}</defs>'
            f'<rect width="{width}" height="{height}" fill="url(#grain-wc)"/>'
        )
    return "".join(out)


_EMOJI_RE = re.compile("[\U0001F000-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF\uFE0F\u200D\u20E3]")


def _clean(text: str, limit: int = 0) -> str:
    value = _EMOJI_RE.sub("", str(text or ""))
    value = " ".join(value.replace("\u200b", "").split())
    if limit and len(value) > limit:
        value = value[:limit].rstrip("，,。.;；") + "…"
    return value


def _text_units(text: str) -> float:
    return sum(0.55 if ord(char) < 128 else 1.0 for char in text)


def _fit_size(text: str, base: int, width: float, max_lines: int, minimum: int = 30) -> int:
    size = base
    while size > minimum:
        lines = math.ceil(_text_units(text) * size / max(1.0, width))
        if lines <= max_lines:
            break
        size -= 3
    return size


def _subtitle(draft: dict[str, Any], limit: int = 30) -> str:
    for key in ("angle", "angle_text"):
        value = _clean(draft.get(key) or "", limit)
        if value:
            return value
    desc = str(draft.get("desc") or "")
    for line in desc.splitlines():
        line = _clean(line, limit)
        if len(line) >= 6:
            return line
    return ""


def _text_html(
    draft: dict[str, Any],
    style: str,
    scope: str,
    width: int,
    height: int,
    rng: random.Random,
) -> str:
    title = _clean(draft.get("title") or "未命名")
    subtitle = _subtitle(draft, 18 if scope == "wide" else 30) if scope != "inline" else ""
    palette = PALETTES[style]
    if scope == "inline":
        size = _fit_size(title, 34, width - 220, 1, minimum=22)
        return (
            f'<div class="copy inline"><p class="cap" style="font-size:{size}px">{html.escape(title)}</p></div>'
        )

    if scope == "wide":
        box_w = 452
        size = _fit_size(title, 64, box_w, 3)
        kicker = {
            "art-chalk": "CHALK / 黑板报",
            "art-blueprint": "DRAWING / FIG.01",
            "art-engrave": "ONE LINE / 一笔",
            "art-watercolor": "SKETCH / 手绘",
        }[style]
        underline_w = min(box_w, 210 + len(title) * 6)
        underline = _ribbon(
            _wobble([(10, 14), (underline_w * 0.45, 8), (underline_w, 16)], rng, 1.6),
            7,
            5,
            rng,
        )
        return (
            f'<div class="copy wide">'
            f'<span class="kicker">{html.escape(kicker)}</span>'
            f'<h1 style="font-size:{size}px">{html.escape(title)}</h1>'
            f'<svg class="underline" width="{underline_w + 12:.0f}" height="26" viewBox="0 0 {underline_w + 12:.0f} 26">'
            f'<path d="{underline}" fill="{palette["accent"]}" opacity=".85"/></svg>'
            + (f'<p class="sub" style="color:{palette["soft"]}">{html.escape(subtitle)}</p>' if subtitle else "")
            + "</div>"
        )

    size = _fit_size(title, 88, width - 170, 3)
    kicker = {
        "art-chalk": "CHALK TALK",
        "art-blueprint": "CYANOTYPE — 01",
        "art-engrave": "ONE LINE / 一笔画",
        "art-watercolor": "PENCIL & WASH",
    }[style]
    underline_w = min(width - 220, 260 + len(title) * 8)
    underline = _ribbon(
        _wobble([(10, 16), (underline_w * 0.5, 9), (underline_w, 18)], rng, 1.8),
        8,
        5,
        rng,
    )
    return (
        f'<div class="copy portrait">'
        f'<span class="kicker">{html.escape(kicker)}</span>'
        f'<h1 style="font-size:{size}px">{html.escape(title)}</h1>'
        f'<svg class="underline" width="{underline_w + 12:.0f}" height="28" viewBox="0 0 {underline_w + 12:.0f} 28">'
        f'<path d="{underline}" fill="{palette["accent"]}" opacity=".85"/></svg>'
        + "</div>"
        + (
            f'<p class="foot-sub" style="color:{palette["soft"]}">{html.escape(subtitle)}</p>'
            if subtitle
            else ""
        )
    )


def _style_css(style: str, scope: str, width: int, height: int) -> str:
    palette = PALETTES[style]
    fonts = {
        "art-chalk": '"Kaiti SC","KaiTi","STKaiti","Microsoft YaHei",serif',
        "art-blueprint": '"Consolas","Courier New","Microsoft YaHei",monospace',
        "art-engrave": '"Songti SC","STSong","SimSun",Georgia,serif',
        "art-watercolor": '"Kaiti SC","KaiTi","STKaiti","Microsoft YaHei",serif',
    }
    base = f"""
*{{box-sizing:border-box;margin:0;padding:0}}
html,body{{width:{width}px;height:{height}px;overflow:hidden}}
body{{background:{palette["paper"]};color:{palette["ink"]};font-family:{fonts[style]};
position:relative;-webkit-font-smoothing:antialiased}}
.sheet{{position:relative;width:100%;height:100%;overflow:hidden}}
.scene{{position:absolute;inset:0;width:100%;height:100%}}
.copy{{position:absolute;z-index:3}}
.copy .kicker{{display:block;font-size:17px;letter-spacing:.26em;opacity:.5;margin-bottom:18px}}
.copy h1{{font-weight:700;line-height:1.32;letter-spacing:.01em}}
.copy .underline{{display:block;margin:18px 0 0 -4px}}
.copy .sub{{font-size:26px;line-height:1.66;margin-top:20px}}
.foot-sub{{position:absolute;left:88px;right:88px;bottom:58px;font-size:26px;line-height:1.6;
z-index:3;margin:0}}
.copy.wide{{left:64px;top:50%;transform:translateY(-50%);width:452px}}
.copy.portrait{{left:88px;top:104px;width:{width - 176}px}}
.copy.inline{{left:0;right:0;bottom:26px;text-align:center}}
.copy .cap{{letter-spacing:.06em;opacity:.55}}
"""
    if style == "art-chalk":
        base += f"""
.copy h1{{text-shadow:0 0 10px rgba(255,255,255,.16)}}
.copy .kicker{{color:{palette["accent"]};opacity:.7}}
.copy .sub{{color:{palette["soft"]}}}
"""
    elif style == "art-blueprint":
        base += f"""
.copy h1{{letter-spacing:.02em;text-transform:none;line-height:1.36}}
.copy .kicker{{color:{palette["second"]};opacity:.85}}
.copy .sub{{font-size:24px;letter-spacing:.02em}}
"""
    elif style == "art-engrave":
        base += f"""
.copy h1{{font-weight:600;letter-spacing:.015em}}
.copy .kicker{{color:{palette["accent"]}}}
"""
    else:
        base += f"""
.copy h1{{font-weight:600}}
.copy .kicker{{color:{palette["accent"]};opacity:.9}}
body::before,body::after{{content:"";position:absolute;width:150px;height:44px;
background:rgba(226,214,188,.55);box-shadow:0 2px 6px rgba(120,105,80,.12);z-index:4}}
body::before{{left:56px;top:-8px;transform:rotate(-6deg)}}
body::after{{left:{width - 210}px;top:-10px;transform:rotate(5deg)}}
"""
    if scope == "inline":
        base += ".copy .cap{opacity:.5;letter-spacing:.08em}"
    return base


def render_art_html(
    draft: dict[str, Any],
    style: str,
    seed: str,
    canvas: str = "portrait",
) -> str:
    style = style if style in ART_KEYS else DEFAULT_STYLE
    scope = "inline" if canvas == "inline" else canvas
    width, height = {
        "wide": (WIDE_WIDTH, WIDE_HEIGHT),
        "portrait": (PORTRAIT_WIDTH, PORTRAIT_HEIGHT),
        "inline": (INLINE_WIDTH, INLINE_HEIGHT),
    }[canvas]
    rng = _rng(seed)
    title = _clean(draft.get("title") or "")
    desc = str(draft.get("desc") or "")
    motif_key = _pick_motif(title, desc, rng)
    fig = MOTIFS[motif_key](rng)
    # 第二笔：给画面留一个小陪衬，贴着主体的角落放，不去撑大包围盒。
    deco = rng.choice(["spark", "dot", "arrow", "star"])
    subject_points: list[tuple[float, float]] = []
    for key in ("outline", "detail", "wash", "accent"):
        for shape, *_rest in fig[key]:
            subject_points.extend(shape)
    sx0, sy0, sx1, sy1 = _bbox(subject_points) if subject_points else (0, 0, 1000, 1000)
    dx = min(990.0, sx1 + (46 if canvas != "wide" else 56))
    dy = max(40.0, sy0 + (24 if canvas == "wide" else 52))
    if deco == "spark":
        for angle in range(0, 360, 90):
            rad = math.radians(angle)
            fig["accent"].append(([(dx + 30 * math.cos(rad), dy + 30 * math.sin(rad)),
                                   (dx + 76 * math.cos(rad), dy + 76 * math.sin(rad))], False))
    elif deco == "dot":
        for _ in range(3):
            fig["accent"].append((_circle(dx + rng.uniform(-20, 20), dy + rng.uniform(-20, 20), rng.uniform(3, 7)), True))
    elif deco == "star":
        points = []
        for index in range(10):
            angle = math.radians(index * 36 - 90)
            radius = 46 if index % 2 == 0 else 18
            points.append((dx + radius * math.cos(angle), dy + radius * math.sin(angle)))
        fig["accent"].append((points, True))
    else:
        fig["accent"].append(([(dx - 50, dy + 30), (dx + 40, dy - 16)], False))
        fig["accent"].append(([(dx + 40, dy - 16), (dx + 16, dy - 22)], False))
        fig["accent"].append(([(dx + 40, dy - 16), (dx + 34, dy + 10)], False))

    background = _background(style, width, height, rng)
    frame = _frame_svg(style, width, height, rng)
    art = _art_layer(fig, style, ART_BOXES[canvas], rng)
    copy = _text_html(draft, style, scope, width, height, rng)
    css = _style_css(style, scope, width, height)
    return f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>{html.escape(_clean(title) or "插画")} · {style}</title>
<style>{css}</style></head>
<body class="{style} {scope}">
<main class="sheet">
<svg class="scene" width="{width}" height="{height}" viewBox="0 0 {width} {height}" xmlns="http://www.w3.org/2000/svg">
{background}{frame}{art}
</svg>
{copy}
</main>
</body></html>
"""


# ---------------------------------------------------------------------------
# 落盘与截图
# ---------------------------------------------------------------------------


def _signature(html_text: str, style: str) -> str:
    return hashlib.sha256(f"{RENDERER}\n{style}\n{html_text}".encode("utf-8")).hexdigest()


def render_artwork(
    draft: dict[str, Any],
    style: str = DEFAULT_STYLE,
    variant: int | None = None,
    platform: str = "",
    scope: str = "cover",
) -> list[str]:
    """生成一张插画封面（或正文插画），返回 PNG 绝对路径。"""
    style = style if style in ART_KEYS else DEFAULT_STYLE
    canvas = art_canvas(platform or draft.get("platform") or "", scope)
    folder = config.DESIGN_DIR / f"draft-{int(draft['id'])}" / style
    folder.mkdir(parents=True, exist_ok=True)
    meta_path = folder / "meta.json"
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        meta = {}
    run = int(variant) if variant is not None else int(meta.get("run") or 0) + 1
    run = max(1, run)
    slug = "01-cover" if scope != "inline" else "inline-01"
    seed = f"{RENDERER}:{draft['id']}-{style}-{run}:{canvas['key']}:{scope}"
    html_text = render_art_html(draft, style, seed, canvas["key"])
    signature = _signature(html_text, style)
    html_path = folder / f"{slug}.html"
    image_path = folder / f"{slug}.png"
    html_path.write_text(html_text, encoding="utf-8")

    with LOCK:
        if image_path.exists() and meta.get(slug) == signature:
            logger.info("复用已有插画: {}", image_path.name)
        else:
            _shoot(html_path, image_path, width=canvas["width"], height=canvas["height"])
            meta[slug] = signature

    meta_path.write_text(
        json.dumps(
            {
                "run": run,
                "seed": seed,
                "style": style,
                "style_name": art_style(style)["name"],
                "canvas": canvas,
                "scope": scope,
                "signatures": {key: value for key, value in meta.items() if key.startswith(("01-", "inline-"))},
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return [str(image_path)]
