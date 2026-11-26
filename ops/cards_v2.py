# encoding: utf-8
"""新版设计卡：实拍纸感共用图。

- 小红书与抖音图文共用一套 3:4 图（封面 + 3 张内页 + 收尾）。
- 公众号单独 2.35:1 横幅 + 1:1 方图。
- 内容模型由一次 LLM 抽取，缓存进 drafts.content_json；失败时有确定性兜底。
- 封面优先使用草稿里的实拍图；没有图就退回纯文字纸感封面，不画假照片。
- 动效单独生成，不混进发布图列表。
"""

from __future__ import annotations

import base64
import hashlib
import html
import json
import math
import re
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Any

from loguru import logger

from ops import config, db, proc
from ops.illustrator import _shoot
from ops.llm import LLMClient
from ops.platforms import normalize

RENDERER = "paper-v1"
WIDTH = 1080
HEIGHT = 1440
LOCK = threading.Lock()

PAPER = {
    "paper": "#F7F4EC",
    "ink": "#211E19",
    "muted": "#7C7568",
    "accent": "#C0492B",
    "tape": "#EBD9A8",
    "grain": "#E3DDD0",
}
WECHAT = {
    "paper": "#FAF6EE",
    "ink": "#1F1B16",
    "muted": "#7A7266",
    "accent": "#8B2E2E",
    "tape": "#EFE3CE",
    "grain": "#E6DECF",
}

EMOJI_RE = re.compile(
    "[\U0001F000-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF\uFE0F\u200D\u20E3]"
)


def _esc(value: Any) -> str:
    return html.escape(str(value or ""))


def _clean(value: Any, limit: int = 0) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip().strip("\"'“”‘’")
    text = re.sub(
        r"(?<=[\u4e00-\u9fff])\s+(?=[\dA-Za-z])|(?<=[\dA-Za-z])\s+(?=[\u4e00-\u9fff])",
        "",
        text,
    )
    if limit and len(text) > limit:
        text = text[:limit].rstrip("，,。！？!?；;：:")
    return text


def _strip_emoji(text: str) -> str:
    return EMOJI_RE.sub("", str(text or "")).strip()


def _lines_html(lines: list[str]) -> str:
    return "".join(f"<span>{_esc(line)}</span>" for line in lines)


def _even_split(text: str, count: int) -> list[str]:
    count = max(1, min(count, len(text)))
    size = math.ceil(len(text) / count)
    return [text[index:index + size].strip() for index in range(0, len(text), size)]


_SENTENCE_STARTS = "我你他她它这那但而就才还又也却所以"


def _semantic_split(text: str, per_line: int, max_lines: int = 2) -> list[str] | None:
    """优先在第一个标点后断行；剩下的再按语义起点拆，避免把词拆开。"""
    text = text.strip()
    match = re.match(r"^(.{2,%d}[，,；;：:])" % per_line, text)
    if not match:
        return None
    head = match.group(1).strip()
    tail = text[len(match.group(1)):].strip()
    if not tail or len(tail) > per_line * (max_lines - 1):
        return None
    lines = [head]
    remaining = tail
    slots = max_lines - 1
    while remaining and len(lines) < max_lines:
        if len(remaining) <= per_line or slots <= 1:
            lines.append(remaining)
            remaining = ""
            break
        cut = 0
        for index in range(3, min(per_line + 1, len(remaining))):
            if remaining[index] in _SENTENCE_STARTS:
                cut = index
                break
        if not cut:
            cut = min(max(math.ceil(len(remaining) / slots), 2), per_line)
        lines.append(remaining[:cut].strip())
        remaining = remaining[cut:].strip()
        slots -= 1
    if remaining:
        lines[-1] += remaining
    return lines if len(lines) >= 2 else None


def _normalize_lines(raw: Any, title: str, limit: int, max_lines: int, per_line: int) -> tuple[str, list[str]]:
    title = _strip_emoji(_clean(title))
    if len(title) > limit:
        title = title[:limit]
    split = _semantic_split(title, per_line, max_lines)
    if split:
        return title, split
    lines: list[str] = []
    if isinstance(raw, list):
        lines = [_strip_emoji(_clean(item)) for item in raw]
    elif isinstance(raw, str):
        lines = [_strip_emoji(_clean(item)) for item in re.split(r"[|｜\n]+", raw)]
    lines = [line for line in lines if line]
    rebuild = (
        len(lines) < 2
        or any(len(line) > per_line + 2 for line in lines)
        or any(line[:1] in "，。！？、；：）》」』" for line in lines)
    )
    if not rebuild and "".join(lines).replace(" ", "") != title.replace(" ", ""):
        rebuild = True
    if rebuild:
        lines = _even_split(title, max_lines if len(title) > per_line else 1)
    if len(lines) > max_lines:
        lines = lines[: max_lines - 1] + ["".join(lines[max_lines - 1:])]
    return title, [line for line in lines if line]


def _parse_json(text: str) -> dict[str, Any]:
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("模型没有返回 JSON")
    return json.loads(text[start:end + 1])


# ---------------------------------------------------------------------------
# 内容模型
# ---------------------------------------------------------------------------

EXTRACT_SYSTEM = """你是资深内容编辑，擅长把口语素材整理成结构化内容。
只输出一个 JSON 对象，不要解释，不要 Markdown，不要代码块。
禁止虚构素材里没有的数字、案例、结论。"""

EXTRACT_RULES = """请输出这个结构：
{
  "content_type": "method",
  "facts": ["20 分钟", "3 个项目", "各 1 句话"],
  "points": [
    {"k": "手机反扣", "v": "以前一坐下就刷消息", "why": "消息一响，注意力被切碎", "fix": "进咖啡店就把手机扣在桌上"}
  ],
  "takeaway": "面试前少看一点，反而能讲得更清楚",
  "cover_title": "面试前20分钟",
  "kicker": "20 分钟 · 上桌前",
  "photo_label": "先喝完这杯",
  "photo_stamp": "20 分钟",
  "cta": "你面试前会做什么？"
}

规则：
- points 固定 3 条，必须来自素材，顺序按原文。
- points 四层各司其职，不能互相复述：k 是这一步叫什么，v 是原来的做法/卡点，
  why 是为什么这样不行，fix 是现在具体怎么做。
- k 不超过 12 字，v 不超过 30 字，why 不超过 26 字，fix 不超过 28 字。
- facts 只放必须在三个平台保持一致的事实（数字、结果、专有名词），最多 5 条。
- content_type 从 warning / method / story / guide / product 里选一个。
- cover_title 是封面标题，8-14 字，保留原意，不要 emoji。
- kicker 是封面纸带上的小标签，不超过 12 字。
- photo_label 是照片上的手写标注，不超过 8 字；photo_stamp 是照片上的印章，不超过 6 字。
- cta 是尾页问句，不超过 18 字。"""


def _fallback_points(desc: str) -> list[dict[str, str]]:
    lines = []
    for raw in str(desc or "").splitlines():
        line = _strip_emoji(_clean(raw))
        if not line or line.startswith("#"):
            continue
        if re.fullmatch(r"(#[^\s#]+\s*)+", line):
            continue
        lines.append(re.sub(r"^[\-\*•\d]+[.、)]?\s*", "", line))
    if not lines:
        lines = ["把这件事拆成三步", "先做最小的一步", "做完再调整"]
    points: list[dict[str, str]] = []
    for index, line in enumerate(lines[:3]):
        parts = re.split(r"[：:｜|]", line, maxsplit=1)
        if len(parts) == 2 and parts[0].strip():
            key, value = parts[0].strip(), parts[1].strip()
        else:
            key, value = line[:10], line
        points.append({
            "k": _clean(key, 12) or f"第 {index + 1} 步",
            "v": _clean(value, 30),
            "why": "",
            "fix": "",
        })
    while len(points) < 3:
        points.append({"k": f"第 {len(points) + 1} 步", "v": "", "why": "", "fix": ""})
    return points


def _fallback_model(draft: dict[str, Any]) -> dict[str, Any]:
    title = str(draft.get("title") or "一条值得看的内容")
    desc = str(draft.get("desc") or "")
    lines = []
    for raw in desc.splitlines():
        line = _clean(raw)
        if not line or re.fullmatch(r"(#[^\s#]+\s*)+", line):
            continue
        lines.append(line)
    takeaway = _clean(lines[-1] if lines else title, 30)
    takeaway = re.sub(r"#[^\s#]+", "", takeaway).strip() or _clean(title, 30)
    facts = []
    for match in re.findall(r"\d+\s*(?:分钟|小时|天|个|次|步|条|句|家|杯|岁|元|%)", desc):
        value = match.strip()
        if value and value not in facts:
            facts.append(value)
    return {
        "content_type": "method",
        "facts": facts[:4],
        "points": _fallback_points(desc),
        "takeaway": takeaway,
        "cover_title": _clean(title, 14),
        "kicker": "先停一下 · 再上场",
        "photo_label": "先看这里",
        "photo_stamp": "重点",
        "cta": takeaway if "？" in takeaway or "?" in takeaway else "你遇到这种情况会怎么做？",
    }


def _normalize_model(raw: dict[str, Any], fallback: dict[str, Any]) -> dict[str, Any]:
    content_type = str(raw.get("content_type") or fallback["content_type"])
    if content_type not in {"warning", "method", "story", "guide", "product"}:
        content_type = "method"
    raw_points = raw.get("points") if isinstance(raw.get("points"), list) else []
    points = []
    for index in range(3):
        item = raw_points[index] if index < len(raw_points) and isinstance(raw_points[index], dict) else {}
        base = fallback["points"][index]
        points.append({
            "k": _clean(item.get("k") or base["k"], 12),
            "v": _clean(item.get("v") or base["v"], 30),
            "why": _clean(item.get("why") or base["why"], 26),
            "fix": _clean(item.get("fix") or base["fix"], 28),
        })
    facts = raw.get("facts") if isinstance(raw.get("facts"), list) else fallback["facts"]
    facts = [_clean(item, 18) for item in facts if _clean(item, 18)][:5]
    return {
        "content_type": content_type,
        "facts": facts,
        "points": points,
        "takeaway": _clean(raw.get("takeaway") or fallback["takeaway"], 30),
        "cover_title": _clean(raw.get("cover_title") or fallback["cover_title"], 18),
        "kicker": _clean(raw.get("kicker") or fallback["kicker"], 14),
        "photo_label": _clean(raw.get("photo_label") or fallback["photo_label"], 8),
        "photo_stamp": _clean(raw.get("photo_stamp") or fallback["photo_stamp"], 6),
        "cta": _clean(raw.get("cta") or fallback["cta"], 18),
    }


def _build_model(draft: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    title = str(draft.get("title") or "")
    desc = str(draft.get("desc") or "")
    platform = normalize(str(draft.get("platform") or ""))
    content = draft.get("content_json") if isinstance(draft.get("content_json"), dict) else {}
    # 内容模型与平台无关：切平台时沿用同一份，只有正文变了才重新抽取。
    source_hash = hashlib.sha1(f"{title}\n{desc}".encode("utf-8")).hexdigest()
    cached = content.get("model")
    if isinstance(cached, dict) and content.get("model_hash") == source_hash:
        return cached, content

    fallback = _fallback_model(draft)
    raw: dict[str, Any] = {}
    try:
        client = LLMClient()
        if not client.configured:
            raise RuntimeError(client.blocked_reason or "文案模型未就绪")
        prompt = (
            f"标题：{title}\n\n正文：\n{desc}\n\n平台：{platform}\n\n"
            + EXTRACT_RULES
        )
        messages = [
            {"role": "system", "content": EXTRACT_SYSTEM},
            {"role": "user", "content": prompt},
        ]
        try:
            text = client.chat(messages, max_tokens=2200, temperature=0.3)
            raw = _parse_json(text)
        except Exception as first_exc:  # noqa: BLE001 - 模型偶尔漏逗号，重试一次
            repair = (
                f"\n\n上一次输出不是合法 JSON（{first_exc}）。"
                "请重新输出一个合法 JSON：所有键值用英文双引号，字段之间必须有逗号，"
                "不要代码块，不要解释。"
            )
            text = client.chat(
                [
                    {"role": "system", "content": EXTRACT_SYSTEM},
                    {"role": "user", "content": prompt + repair},
                ],
                max_tokens=2200,
                temperature=0.1,
            )
            raw = _parse_json(text)
        logger.info("paper 内容模型抽取完成: draft={}", draft.get("id"))
    except Exception as exc:  # noqa: BLE001 - 兜底优先保证可出图
        logger.warning(f"paper 内容模型抽取失败，使用兜底: {exc}")

    model = _normalize_model(raw, fallback)
    model["brand"] = str(db.get_setting("card_brand", "应声面试"))
    model["column"] = str(db.get_setting("card_column", "面试避坑"))
    model["issue"] = str(db.get_setting("card_issue", "07"))
    content["model"] = model
    content["model_hash"] = source_hash
    content["design_version"] = RENDERER
    return model, content


def _build_variant(draft: dict[str, Any], model: dict[str, Any], platform: str) -> dict[str, Any]:
    if platform == "wechat_mp":
        limit, max_lines, per_line = 24, 3, 8
    else:
        limit, max_lines, per_line = 14, 2, 8
    title, lines = _normalize_lines(model.get("cover_title"), str(draft.get("title") or ""),
                                    limit, max_lines, per_line)
    tags = draft.get("topics") if isinstance(draft.get("topics"), list) else []
    tags = [str(tag).lstrip("#") for tag in tags if str(tag).strip()][:6]
    return {
        "title": title,
        "title_lines": lines,
        "subtitle": model.get("takeaway") or "",
        "points": model.get("points") or [],
        "cta": model.get("cta") or "你遇到这种情况会怎么做？",
        "tags": tags,
    }


def _pick_photo(draft: dict[str, Any], content: dict[str, Any]) -> Path | None:
    stored = content.get("photo")
    if stored:
        path = Path(str(stored))
        if path.exists():
            return path
    draft_id = int(draft.get("id") or 0)
    generated = config.DESIGN_DIR / f"draft-{draft_id}"
    for raw in draft.get("images") or []:
        path = Path(str(raw))
        if not path.exists() or path.suffix.lower() not in {".jpg", ".jpeg", ".png", ".webp"}:
            continue
        if str(path).startswith(str(generated)):
            continue
        if "/paper/" in str(path).replace("\\", "/") or "/v2/" in str(path).replace("\\", "/"):
            continue
        content["photo"] = str(path)
        return path
    return None


# ---------------------------------------------------------------------------
# HTML / CSS
# ---------------------------------------------------------------------------

BASE_CSS = """
*{box-sizing:border-box;margin:0;padding:0}
body{overflow:hidden;-webkit-font-smoothing:antialiased}
.page{position:relative;width:100%;height:100%;overflow:hidden}
h1,h2,p{margin:0}
.line-break{line-break:strict;word-break:normal}
"""

PAPER_CSS = """
.paper{background:var(--paper);color:var(--ink);font-family:"Microsoft YaHei","PingFang SC",sans-serif}
.paperbg{position:absolute;inset:0;background:var(--paper);
background-image:radial-gradient(var(--grain) 1.2px,transparent 1.2px);background-size:28px 28px}
.paper .photo{position:absolute;inset:0;overflow:hidden;background:#2A2119}
.paper .photo img{width:100%;height:100%;object-fit:cover;object-position:50% 46%;transform:scale(1.02);
transform-origin:50% 46%}
.paper .shade{position:absolute;inset:0;
background:linear-gradient(180deg,rgba(18,14,10,.34) 0%,rgba(18,14,10,0) 28%,
rgba(18,14,10,0) 56%,rgba(18,14,10,.20) 70%,rgba(18,14,10,.10) 100%)}
.paper .brand{position:absolute;left:84px;top:72px;font-size:23px;letter-spacing:.2em;color:#F7F4EC;
text-shadow:0 2px 12px rgba(0,0,0,.45);z-index:3}
.paper .issue{position:absolute;right:84px;top:72px;font-size:23px;letter-spacing:.16em;color:#F7F4EC;
text-shadow:0 2px 12px rgba(0,0,0,.45);z-index:3}
.paper .band{position:absolute;left:0;right:0;bottom:0;height:600px;background:var(--paper);
padding:54px 84px 44px;box-shadow:0 -24px 60px rgba(0,0,0,.24);z-index:2}
.paper .band:before{content:"";position:absolute;left:0;right:0;top:0;height:4px;
background:var(--accent);opacity:.9}
.paper .kicker{font-size:22px;letter-spacing:.22em;color:var(--accent)}
.paper .title{margin-top:16px;font-size:92px;line-height:1.16;font-weight:800;letter-spacing:-.018em}
.paper .title span{display:block;white-space:nowrap}
.paper .squiggle{margin-top:8px}
.paper .sub{margin-top:14px;font-size:34px;line-height:1.6;color:var(--muted)}
.paper .facts{position:absolute;left:84px;bottom:36px;font-size:23px;letter-spacing:.14em;color:var(--muted)}
.paper .label{position:absolute;right:84px;top:724px;background:var(--paper);color:var(--ink);
padding:11px 18px;font-size:25px;letter-spacing:.06em;transform:rotate(3deg);
box-shadow:0 10px 24px rgba(0,0,0,.24);z-index:4}
.paper .stamp{position:absolute;right:84px;top:640px;border:3px solid rgba(247,244,236,.86);
color:#F7F4EC;padding:11px 18px;font-size:25px;letter-spacing:.1em;transform:rotate(-6deg);
border-radius:6px;background:rgba(30,24,18,.12);z-index:4}
.paper .cover-point{display:flex;align-items:baseline;gap:16px;margin-top:22px}
.paper .cover-point .c-no{flex:none;font-size:23px;letter-spacing:.1em;color:var(--accent)}
.paper .cover-point .c-k{flex:none;font-size:36px;font-weight:700;line-height:1.3}
.paper .cover-point .c-detail{font-size:27px;line-height:1.4;color:var(--muted)}
.paper .eyebrow{position:absolute;left:84px;top:94px;font-size:25px;letter-spacing:.2em;color:var(--accent)}
.paper.content,.paper.ending{display:flex;flex-direction:column;justify-content:space-between;
padding:94px 84px 64px}
.paper .paperbg{z-index:0}
.paper.content .c-head,.paper.content .vbox,.paper.content .c-mid,.paper.content .c-end,
.paper.ending .end-head,.paper.ending .recap,.paper.ending .end-bottom,.paper.ending .foot{
position:relative;z-index:1}
.paper.content .eyebrow,.paper.ending .eyebrow{position:static}
.paper.content .k{margin-top:30px;font-size:104px;line-height:1.16;font-weight:800;letter-spacing:-.012em}
.paper.content .vbox{position:relative;background:rgba(192,73,43,.045);
border-left:6px solid rgba(192,73,43,.28);padding:34px 40px 38px}
.paper .vbox .vlabel{font-size:23px;letter-spacing:.2em;color:var(--accent);margin-bottom:16px}
.paper .vbox .v{position:static;font-size:48px;line-height:1.62;color:var(--ink)}
.paper .vbox .qmark{position:absolute;right:22px;top:6px;font-family:Georgia,serif;font-size:120px;
line-height:1;color:var(--accent);opacity:.12}
.paper.content .why{border-top:1px solid rgba(33,30,25,.14);padding-top:26px;font-size:38px;
line-height:1.58;color:var(--muted)}
.paper .why b{display:block;font-size:21px;letter-spacing:.2em;color:var(--accent);margin-bottom:10px;
font-weight:400}
.paper .arrow-note{margin-top:18px;margin-left:8px}
.paper .fix{border-left:6px solid var(--accent);padding:22px 0 22px 28px;font-size:42px;line-height:1.55}
.paper .fix b{display:block;font-size:23px;letter-spacing:.18em;color:var(--accent);margin-bottom:12px;
font-weight:400}
.paper.ending .q{margin-top:34px;font-size:84px;line-height:1.38;font-weight:700}
.paper .recap-label{font-size:21px;letter-spacing:.2em;color:var(--accent);margin-bottom:6px}
.paper .recap-row{display:flex;gap:18px;padding:20px 0;border-top:1px solid rgba(33,30,25,.14)}
.paper .recap-no{flex:none;width:38px;padding-top:6px;font-size:22px;letter-spacing:.08em;color:var(--accent)}
.paper .recap-k{font-size:34px;font-weight:700;line-height:1.3}
.paper .recap-fix{margin-top:6px;font-size:25px;line-height:1.5;color:var(--muted)}
.paper .endnote{font-size:30px;line-height:1.66;color:var(--muted)}
.paper .tags{font-size:27px;line-height:1.95;color:var(--muted)}
.paper .foot{position:absolute;left:84px;right:84px;bottom:68px;display:flex;justify-content:space-between;
font-size:23px;color:var(--muted);letter-spacing:.12em}
.paper.content .foot,.paper.ending .foot{position:static}
.paper.content .foot{margin-top:30px}
.paper.motion .photo img{transform:scale(var(--zoom,1.02))}
.paper.motion .squiggle path{stroke-dasharray:1;stroke-dashoffset:var(--line,0)}
.paper.motion .label{opacity:var(--label,1);
transform:rotate(3deg) translateY(calc((1 - var(--label,1)) * 10px))}
.paper.motion .stamp{opacity:var(--stamp,1);
transform:rotate(-6deg) scale(calc(.9 + .1 * var(--stamp,1)))}
"""

WECHAT_CSS = """
.wx{background:var(--paper);color:var(--ink);font-family:"Songti SC","SimSun",Georgia,serif;
background-image:radial-gradient(var(--grain) 1px,transparent 1px);background-size:34px 34px}
.wx .brand{position:absolute;left:74px;top:52px;font-size:23px;letter-spacing:.22em;
color:var(--muted);font-family:"Microsoft YaHei",sans-serif}
.wx .title{position:absolute;left:74px;top:126px;width:700px;font-size:74px;line-height:1.28;font-weight:700;
letter-spacing:-.01em}
.wx .title span{display:block;white-space:nowrap}
.wx .no{position:absolute;right:88px;top:92px;font-size:196px;line-height:1;font-weight:700;color:var(--accent);
opacity:.92}
.wx .no-label{position:absolute;right:90px;top:72px;font-size:17px;letter-spacing:.3em;color:var(--muted);
font-family:"Microsoft YaHei",sans-serif}
.wx .rule{position:absolute;right:88px;top:318px;width:286px;height:2px;background:var(--ink);opacity:.34}
.wx .note{position:absolute;right:88px;top:344px;width:286px;font-size:23px;line-height:1.7;color:var(--muted);
font-family:"Microsoft YaHei",sans-serif}
.wx-sq{background:var(--paper);color:var(--ink);font-family:"Songti SC","SimSun",Georgia,serif;
background-image:radial-gradient(var(--grain) 1px,transparent 1px);background-size:34px 34px}
.wx-sq .brand{position:absolute;left:0;right:0;top:92px;text-align:center;font-size:24px;letter-spacing:.22em;
color:var(--muted);font-family:"Microsoft YaHei",sans-serif}
.wx-sq .title{position:absolute;left:60px;right:60px;top:278px;text-align:center;font-size:96px;
line-height:1.3;font-weight:700;letter-spacing:-.015em}
.wx-sq .title span{display:block;white-space:nowrap}
.wx-sq .rule{position:absolute;left:50%;transform:translateX(-50%);top:742px;width:120px;height:2px;
background:var(--accent);opacity:.6}
.wx-sq .sub{position:absolute;left:150px;right:150px;top:790px;text-align:center;font-size:38px;line-height:1.7;
color:var(--muted)}
.wx-sq .tags{position:absolute;left:0;right:0;bottom:150px;text-align:center;font-size:26px;letter-spacing:.1em;
color:var(--muted);font-family:"Microsoft YaHei",sans-serif}
"""

MOTION_SCRIPT = """
<script>
const root = document.documentElement;
const clamp = (v) => Math.max(0, Math.min(1, v));
const ease = (v) => 1 - Math.pow(1 - v, 3);
window.__seek = (t) => {
  const line = ease(clamp((t - 0.20) / 1.10));
  const label = clamp((t - 1.30) / 0.50);
  const stamp = clamp((t - 1.50) / 0.50);
  const out = t > 5.0 ? clamp((5.8 - t) / 0.8) : 1;
  const zoom = 1.02 + 0.025 * Math.sin(Math.PI * clamp(t / 6));
  root.style.setProperty('--zoom', zoom.toFixed(4));
  root.style.setProperty('--line', (1 - line).toFixed(3));
  root.style.setProperty('--marks', out.toFixed(3));
  root.style.setProperty('--label', (label * out).toFixed(3));
  root.style.setProperty('--stamp', (stamp * out).toFixed(3));
};
window.__seek(2.4);
window.__ready = true;
</script>
"""


def _page_html(width: int, height: int, extra_css: str, body: str, class_name: str,
               variables: dict[str, str]) -> str:
    inline = ";".join(f"--{key}:{value}" for key, value in variables.items())
    return f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>html,body{{width:{width}px;height:{height}px}}{BASE_CSS}{extra_css}</style>
</head><body style="{inline}"><main class="page {class_name}">{body}</main></body></html>"""


def _data_uri(path: Path | None) -> str:
    if not path or not path.exists():
        return ""
    suffix = path.suffix.lower()
    mime = "image/png" if suffix == ".png" else "image/webp" if suffix == ".webp" else "image/jpeg"
    return f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode("ascii")


def _cover_point(model: dict[str, Any]) -> str:
    """封面直接给第一条内容，不放「导读」式总结句。"""
    points = model.get("points") if isinstance(model.get("points"), list) else []
    if not points:
        return ""
    first = points[0] if isinstance(points[0], dict) else {}
    key = _clean(first.get("k"), 12)
    if not key:
        return ""
    detail = _clean(first.get("fix") or first.get("v") or "", 24)
    detail_html = f'<span class="c-detail">{_esc(detail)}</span>' if detail else ""
    return (
        f'<div class="cover-point"><span class="c-no">01</span>'
        f'<b class="c-k">{_esc(key)}</b>{detail_html}</div>'
    )


def _cover_body(model: dict[str, Any], variant: dict[str, Any], photo_uri: str) -> str:
    facts = "　·　".join(str(item) for item in (model.get("facts") or []))
    point = _cover_point(model)
    if not photo_uri:
        return f"""
<div class="paperbg"></div>
<div class="brand" style="color:var(--muted);text-shadow:none">第 {_esc(model.get('issue'))} 期</div>
<h1 class="title line-break" style="position:absolute;left:84px;right:84px;top:300px;font-size:112px">
{_lines_html(variant['title_lines'])}</h1>
<svg class="squiggle" style="position:absolute;left:88px;top:610px" width="430" height="30"
viewBox="0 0 430 30" fill="none"><path d="M6 20C96 7 178 26 296 12c40-5 82 4 128-2"
stroke="#C0492B" stroke-width="7" stroke-linecap="round" opacity=".9"/></svg>
<div style="position:absolute;left:84px;right:84px;top:710px">{point}</div>
<div class="facts">{_esc(facts)}</div>
<div class="stamp" style="color:var(--accent);border-color:var(--accent);background:transparent">
{_esc(model.get('photo_stamp') or '重点')}</div>
<div class="foot"><span>{_esc(model.get('brand'))}</span><span>01 / 05</span></div>
"""
    return f"""
<div class="photo"><img src="{photo_uri}" alt=""></div>
<div class="shade"></div>
<div class="brand">{_esc(model.get('brand'))} / {_esc(model.get('column'))}</div>
<div class="issue">第 {_esc(model.get('issue'))} 期</div>
<div class="band">
  <div class="kicker">{_esc(model.get('kicker'))}</div>
  <h1 class="title line-break">{_lines_html(variant['title_lines'])}</h1>
  <svg class="squiggle" width="430" height="30" viewBox="0 0 430 30" fill="none">
  <path d="M6 20C96 7 178 26 296 12c40-5 82 4 128-2" stroke="#C0492B" stroke-width="7"
  stroke-linecap="round" opacity=".9"/></svg>
  {point}
  <div class="facts">{_esc(facts)}</div>
</div>
<div class="label">{_esc(model.get('photo_label'))}</div>
<div class="stamp">{_esc(model.get('photo_stamp'))}</div>
"""


def _cover_html(model: dict[str, Any], variant: dict[str, Any], photo: Path | None,
                motion: bool = False) -> str:
    body = _cover_body(model, variant, _data_uri(photo))
    if motion:
        body += MOTION_SCRIPT
    return _page_html(WIDTH, HEIGHT, PAPER_CSS, body, "paper motion" if motion else "paper", PAPER)


def _content_meta(model: dict[str, Any]) -> dict[str, Any]:
    content_type = str(model.get("content_type") or "")
    if content_type in ("warning", "comparison", "mistake"):
        return {"quote": "掉分现场", "why": "面试官听到的是", "fix": "改成这样说",
                "units": ["第一句", "第二句", "第三句", "第四句", "第五句"]}
    if content_type == "story":
        return {"quote": "当时的场景", "why": "问题在哪", "fix": "后来怎么做",
                "units": ["第一幕", "第二幕", "第三幕", "第四幕", "第五幕"]}
    if content_type in ("product", "guide", "tutorial"):
        return {"quote": "使用场景", "why": "为什么有用", "fix": "怎么用",
                "units": ["第一件", "第二件", "第三件", "第四件", "第五件"]}
    return {"quote": "原来的做法", "why": "为什么会这样", "fix": "改成这样做",
            "units": ["第一步", "第二步", "第三步", "第四步", "第五步"]}


def _content_body(model: dict[str, Any], point: dict[str, str], index: int, total: int) -> str:
    meta = _content_meta(model)
    units = meta["units"]
    label = units[index - 1] if index <= len(units) else f"第 {index} 步"
    why = f'<div class="why"><b>{meta["why"]}</b>{_esc(point.get("why"))}</div>' if point.get("why") else ""
    arrow = (
        '<svg class="arrow-note" width="64" height="150" viewBox="0 0 64 150" fill="none">'
        '<path d="M34 4c-16 38 18 58 2 100" stroke="#C0492B" stroke-width="5" stroke-linecap="round"/>'
        '<path d="M18 92l18 26 16-26" stroke="#C0492B" stroke-width="5" stroke-linecap="round" '
        'stroke-linejoin="round"/></svg>'
    ) if point.get("why") and point.get("fix") else ""
    fix = (
        f'<div class="fix"><b>{meta["fix"]}</b>{_esc(point.get("fix"))}</div>'
        if point.get("fix") else ""
    )
    return f"""
<div class="paperbg"></div>
<div class="c-head"><div class="eyebrow">{index:02d} / {label}</div>
<h1 class="k line-break">{_esc(point.get('k'))}</h1></div>
<div class="vbox"><div class="vlabel">{meta['quote']}</div>
<p class="v line-break">{_esc(point.get('v'))}</p><span class="qmark">“</span></div>
<div class="c-mid">{why}{arrow}</div>
<div class="c-end">{fix}
<div class="foot"><span>{_esc(model.get('brand'))}</span><span>{index + 1:02d} / {total:02d}</span></div></div>
"""


def _ending_body(model: dict[str, Any], variant: dict[str, Any], total: int) -> str:
    tags = "　".join(f"#{tag}" for tag in variant.get("tags") or [])
    rows = []
    for index, point in enumerate((variant.get("points") or [])[:3], start=1):
        key = _clean(point.get("k"), 12)
        if not key:
            continue
        detail = _clean(point.get("fix") or point.get("v") or "", 26)
        rows.append(
            f'<div class="recap-row"><span class="recap-no">{index:02d}</span>'
            f'<div><div class="recap-k">{_esc(key)}</div>'
            f'<div class="recap-fix">{_esc(detail)}</div></div></div>'
        )
    recap = (
        '<div class="recap"><div class="recap-label">最后再过一遍</div>'
        + "".join(rows) + "</div>"
        if rows else ""
    )
    return f"""
<div class="paperbg"></div>
<div class="end-head"><div class="eyebrow">收尾</div>
<h1 class="q line-break">{_esc(variant.get('cta'))}</h1></div>
{recap}
<div class="end-bottom"><p class="endnote line-break">{_esc(model.get('takeaway'))}</p>
<p class="tags">{_esc(tags)}</p></div>
<div class="foot"><span>{_esc(model.get('brand'))}</span><span>{total:02d} / {total:02d}</span></div>
"""


def _wechat_wide(model: dict[str, Any], variant: dict[str, Any]) -> str:
    return f"""
<div class="brand">{_esc(model.get('brand'))} / {_esc(model.get('column'))}</div>
<h1 class="title line-break">{_lines_html(variant['title_lines'])}</h1>
<div class="no-label">ISSUE</div>
<div class="no">{_esc(model.get('issue'))}</div>
<div class="rule"></div>
<div class="note">{_esc(variant.get('subtitle'))}</div>
"""


def _wechat_square(model: dict[str, Any], variant: dict[str, Any]) -> str:
    tags = "　".join(f"#{tag}" for tag in variant.get("tags") or [])
    return f"""
<div class="brand">{_esc(model.get('brand'))} / {_esc(model.get('column'))} · 第 {_esc(model.get('issue'))} 期</div>
<h1 class="title line-break">{_lines_html(variant['title_lines'])}</h1>
<div class="rule"></div>
<p class="sub line-break">{_esc(variant.get('subtitle'))}</p>
<p class="tags">{_esc(tags)}</p>
"""


def _shoot_page(html_text: str, target: Path, width: int, height: int) -> None:
    html_path = target.with_suffix(".html")
    html_path.write_text(html_text, encoding="utf-8")
    _shoot(html_path, target, width=width, height=height, timeout=config.RENDER_TIMEOUT_SEC)


def render_paper_cards(draft: dict[str, Any], platform: str = "") -> tuple[list[str], dict[str, Any]]:
    """一次出全套：3:4 五张（小红书/抖音共用）+ 公众号横幅与 1:1 方图。

    返回当前平台该用的图；三套路径都写进 content_json["renders"]，
    切平台时直接取用，不用重新生成。
    """
    platform = normalize(platform or draft.get("platform") or "")
    model, content = _build_model(draft)
    photo = _pick_photo(draft, content)
    folder = config.DESIGN_DIR / f"draft-{int(draft['id'])}" / "paper"
    folder.mkdir(parents=True, exist_ok=True)
    portrait: list[str] = []
    wechat: dict[str, str] = {}
    xhs_variant = _build_variant(draft, model, "xiaohongshu")
    wechat_variant = _build_variant(draft, model, "wechat_mp")
    variant = wechat_variant if platform == "wechat_mp" else xhs_variant

    with LOCK:
        points = xhs_variant["points"][:3]
        total = 1 + len(points) + 1
        pages = [("01-cover", _cover_html(model, xhs_variant, photo), WIDTH, HEIGHT)]
        for index, point in enumerate(points, start=1):
            body = _content_body(model, point, index, total)
            pages.append((
                f"{index + 1:02d}-content-{index}",
                _page_html(WIDTH, HEIGHT, PAPER_CSS, body, "paper content", PAPER),
                WIDTH,
                HEIGHT,
            ))
        pages.append((
            f"{total:02d}-ending",
            _page_html(WIDTH, HEIGHT, PAPER_CSS, _ending_body(model, xhs_variant, total), "paper ending", PAPER),
            WIDTH,
            HEIGHT,
        ))
        for slug, html_text, width, height in pages:
            target = folder / f"{slug}.png"
            _shoot_page(html_text, target, width, height)
            portrait.append(str(target))

        wx_pages = [
            ("wx-01-cover", _page_html(1080, 460, WECHAT_CSS, _wechat_wide(model, wechat_variant), "wx", WECHAT), 1080, 460),
            ("wx-02-square", _page_html(1080, 1080, WECHAT_CSS, _wechat_square(model, wechat_variant), "wx-sq", WECHAT), 1080, 1080),
        ]
        for slug, html_text, width, height in wx_pages:
            target = folder / f"{slug}.png"
            _shoot_page(html_text, target, width, height)
        wechat = {
            "cover": str(folder / "wx-01-cover.png"),
            "square": str(folder / "wx-02-square.png"),
        }

    images = [wechat["cover"]] if platform == "wechat_mp" else portrait
    content["renders"] = {
        "xiaohongshu": portrait,
        "douyin": list(portrait),
        "wechat_mp": wechat,
    }
    content["wechat_square"] = wechat["square"]

    meta = {
        "renderer": RENDERER,
        "model": model,
        "variant": variant,
        "photo": str(photo) if photo else "",
        "renders": content["renders"],
        "updated_at": int(time.time()),
    }
    (folder / "meta.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    content["design_version"] = RENDERER
    content["photo"] = str(photo) if photo else ""
    content["last_render"] = meta["updated_at"]
    return images, content


# ---------------------------------------------------------------------------
# 动效
# ---------------------------------------------------------------------------

def _capture_motion(html_path: Path, folder: Path, fps: int = 12, duration: float = 6.0) -> Path:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError("动效需要 Playwright，当前环境未安装") from exc
    frames = folder / "frames"
    if frames.exists():
        shutil.rmtree(frames)
    frames.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        try:
            # 优先 Playwright 自带 Chromium，不依赖本机 Edge。
            browser = playwright.chromium.launch(headless=True)
        except Exception:  # noqa: BLE001
            browser = playwright.chromium.launch(channel="msedge", headless=True)
        page = browser.new_page(viewport={"width": WIDTH, "height": HEIGHT}, device_scale_factor=1)
        page.goto(html_path.as_uri(), wait_until="load")
        page.wait_for_function("window.__ready === true")
        page.wait_for_timeout(200)
        total = int(round(fps * duration))
        for index in range(total):
            page.evaluate("(t) => window.__seek(t)", index / fps)
            page.evaluate("() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
            page.screenshot(path=str(frames / f"{index:03d}.png"))
        browser.close()
    return frames


def _encode_motion(frames: Path, folder: Path, fps: int = 12) -> dict[str, str]:
    gif = folder / "cover.gif"
    mp4 = folder / "cover.mp4"
    proc.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(fps),
         "-i", str(frames / "%03d.png"),
         "-vf", "scale=540:720:flags=lanczos,split[s0][s1];"
                "[s0]palettegen=max_colors=160:stats_mode=diff[p];"
                "[s1][p]paletteuse=dither=bayer:bayer_scale=2",
         "-loop", "0", str(gif)],
        check=True,
    )
    proc.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(fps),
         "-i", str(frames / "%03d.png"),
         "-vf", "fps=24", "-c:v", "libx264", "-pix_fmt", "yuv420p",
         "-profile:v", "high", "-level", "4.0", "-movflags", "+faststart", str(mp4)],
        check=True,
    )
    return {"gif": str(gif), "mp4": str(mp4)}


def render_paper_motion(draft: dict[str, Any]) -> dict[str, str]:
    platform = normalize(str(draft.get("platform") or ""))
    if platform == "wechat_mp":
        raise ValueError("公众号暂不支持动图，请用小红书或抖音图文草稿")
    model, content = _build_model(draft)
    variant = _build_variant(draft, model, platform)
    photo = _pick_photo(draft, content)
    if not photo:
        raise ValueError("先生成带实拍封面的配图，再生成动图")
    folder = config.DESIGN_DIR / f"draft-{int(draft['id'])}" / "paper"
    motion_dir = folder / "motion"
    motion_dir.mkdir(parents=True, exist_ok=True)
    html_path = motion_dir / "cover-motion.html"
    html_path.write_text(_cover_html(model, variant, photo, motion=True), encoding="utf-8")
    frames = _capture_motion(html_path, motion_dir)
    # 动图与静图放在同一层，前端 mediaUrl 才能直接映射到 /designs/...。
    motion = _encode_motion(frames, folder)
    content["motion"] = motion
    (folder / "meta.json").write_text(
        json.dumps(
            {
                "renderer": RENDERER,
                "model": model,
                "variant": variant,
                "photo": str(photo),
                "motion": motion,
                "updated_at": int(time.time()),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return motion
