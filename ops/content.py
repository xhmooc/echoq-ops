# encoding: utf-8
"""文案生产、合规校验与草稿管理。

有模型时走模型；没有模型/调用失败时用离线模板兜底，保证选题能直接变成
可发布的草稿。两种路径都会经过同一套硬限制与合规扫描。
"""

from __future__ import annotations

import json
import re
import shutil
import time
from pathlib import Path
from typing import Any

from loguru import logger

from ops import config, db, richtext
from ops.llm import LLMClient, LLMError
from ops.platforms import DEFAULT_PLATFORM, get_platform, normalize, platform_label

# 复刻自 wr/prompts.json（xhs-workbench/backend/core/copy_engine.py）的小红书语感，
# 保留「具体钩子 + 三条做法 + 问句 + 4-6 个标签」的原结构，只去掉 emoji 分节和标题表情。
# 输出格式虽然接近 Markdown，但发布前必须剥壳：小红书正文不支持加粗。
WRITENOW_SYSTEM_TEMPLATE = """你是一个小红书资深内容编辑。请生成小红书图文笔记文案。

风格：{style}
{tag_line}

输出格式（用 Markdown）：
1. **标题**（14-20 字，最多 20 字；直接给具体钩子，不要 emoji）
2. **正文**（250-350 字，短句换行，不要加粗）
{tag_item}
要求：
- 开头第一句就把具体场景、结论或冲突甩出来，像刚经历完在跟朋友复盘
- 中段用 3 个短段落或 3 条编号，每条先给一句小标题，再给具体做法
- 要点用「1. 2. 3.」或短横线，不要用 ✅ / 💡 / 1️⃣ 这类 emoji 当编号
- 每段 1-2 句，单句不超过 30 字，多用换行，像在手机上快速浏览
- 全文 emoji 0-2 个，只做语气，不要用来分节或当标题
- 写具体的人、时间、地点、动作，不要写成教程或报告
{cta_rule}
- 话题标签单独放在最后一行
- 真实分享感，不要过多修饰词。"""

# 平台写作策略：prompt、篇幅、话题数量、离线模板都按这里分叉。
PLATFORM_WRITING = {
    DEFAULT_PLATFORM: {
        "body_min": 250,
        "body_max": 450,
        "topics_max": 6,
    },
    "wechat_mp": {
        "body_min": 900,
        "body_max": 1500,
        "topics_max": 3,
    },
    "douyin": {
        "body_min": 80,
        "body_max": 160,
        "topics_max": 4,
    },
}

STYLES = {
    "casual": "日常随意，像和朋友聊天",
    "recommend": "直接种草推荐，突出好物亮点和使用体验",
    "professional": "专业测评，用数据和体验说话",
    "cute": "可爱软萌，多用拟声词和可爱 emoji",
    "emotional": "情感共鸣，走心，像朋友深夜聊天",
    "informative": "干货科普，提供实用知识和技巧",
    "story": "经验分享，讲自己的真实经历和踩过的坑",
    "warn": "避坑指南，提醒别人别踩同样的坑",
    "enthusiastic": "激情感召，语气热烈，有感染力",
}

# 页面展示用；与 prompt 里的风格描述保持同一套措辞。
STYLE_GUIDES = STYLES
TONE_HINTS = {key: value.split("，")[0] for key, value in STYLES.items()}
TONE_WORDS = set(STYLES) | {value.split("，")[0] for value in STYLES.values()}


def build_system_prompt(
    tone: str, tags: bool = True, product: bool = False, platform: str = DEFAULT_PLATFORM
) -> str:
    platform = normalize(platform)
    style = STYLES.get(tone) or STYLES["casual"]
    if platform == "wechat_mp":
        tag_line = (
            "需要 2-3 个话题标签，格式为「#话题#」，放在最后一行"
            if tags
            else "不需要话题标签"
        )
        product_line = (
            f"- 可以在结尾自然提一句自己在用「{db.get_setting('product_name', '应声面试 Pro')}」，"
            "只陈述事实，不写硬广"
            if product
            else ""
        )
        return f"""你是一位微信公众号主笔，负责把素材写成可以直接发布的成篇长文。

风格：{style}
{tag_line}

输出格式（用 Markdown，微信后台支持富文本，转换后会保留标题、引用、列表和配图）：
- 第一行只写标题（16-32 字，最多 64 字；突出信息量、结论或方法，不要用「姐妹们」「谁懂啊」这类情绪钩子，不要 emoji 开头）
- 空一行后写正文（900-1500 字）

正文结构必须完整：
- 导语：100-150 字，交代背景、问题和本文会讲什么
- 三个小标题：用 `## 一、…`、`## 二、…`、`## 三、…`，每个小标题下 2-4 段，每段 2-4 句
- 需要强调一句结论时用 `> ` 引用，但全文最多 1 处
- 需要分条时用 `- ` 列表，主体仍然用段落推进
- 结尾：收束全文，给读者一个可执行的下一步，可以有一句克制的互动邀请

要求：
- 书面、克制、信息密度高，全文最多 2 个 emoji
- 不要用「✅」「✨」罗列要点，不要整段加粗
- 不要编造数据、案例或权威来源；信息不足时用「我的经验是」限定
- 不要写图片占位符或「点击查看」之类的话，配图由编辑在预览里插入
- 话题标签最多 3 个，单独放在最后一行
{product_line}"""

    if platform == "douyin":
        tag_line = (
            "需要 2-4 个话题标签，格式为「#话题」，放在最后一行"
            if tags
            else "不需要话题标签"
        )
        product_line = (
            f"可以在正文里自然提一句「{db.get_setting('product_name', '应声面试 Pro')}」，"
            "只陈述事实，不要硬广"
            if product
            else ""
        )
        return f"""你是抖音图文编辑，负责写图片笔记的配文，不是视频脚本。

风格：{style}
{tag_line}

输出格式：
1. **标题**（5-12 字，最多 55 字；直接给钩子，不要 emoji 开头）
2. **正文**（80-150 字，图片笔记配文）

正文结构：
- 第一句用具体场景、痛点或结果做钩子
- 中间 2-3 句写具体做法，短句、口语
- 最后一句给结论或一个问句

要求：
- 不要写【前3秒】【画面】【口播】【结尾】等镜头标记，这不是视频脚本
- 每句不超过 25 字，删掉一切铺垫和客套
- 不要编造数据或案例
{product_line}"""

    return WRITENOW_SYSTEM_TEMPLATE.format(
        style=style,
        tag_line="需要4-6个话题标签" if tags else "不需要话题标签",
        tag_item="3. **#话题标签**（4-6个）\n" if tags else "",
        cta_rule=(
            "- 最后一行用一个问句邀请读者分享经历；可以自然提一句产品，"
            "但不要写「内测中、不收费」这类促销信息"
            if product
            else "- 最后一行必须是一个问句，邀请读者分享自己的经历，不要写促销、内测信息"
        ),
    )


def build_writenow_prompt(
    desc: str,
    *,
    topic: str = "",
    tone: str = "casual",
    tags: bool = True,
    product: bool = False,
    platform: str = DEFAULT_PLATFORM,
) -> str:
    """复刻前端拼装：``[分享主题: X，语气风格: tone] 文案描述``。

    记录里验证过英文 tone key 会被 DeepSeek 抄进正文；后处理会删掉，
    同时这里保留英文 key 以维持与原实现一致。
    """
    platform = normalize(platform)
    parts = []
    if topic:
        parts.append(f"分享主题: {topic}")
    parts.append(f"发布平台: {platform_label(platform)}")
    parts.append(f"语气风格: {tone}")
    if tags:
        parts.append("是否带话题标签: yes")
    prompt = f"[{'，'.join(parts)}] {desc}"
    if platform == "wechat_mp":
        prompt += "\n请写成有导语、三个小标题和结尾的完整长文，不要写成分点清单。"
    elif platform == "douyin":
        prompt += "\n请写成抖音图文笔记配文，不要写【前3秒】【画面】【口播】等镜头标记。"
    if product:
        product_name = db.get_setting("product_name", "应声面试 Pro")
        pitch = db.get_setting("product_pitch", "")
        prompt += (
            f"\n补充：正文里可以顺带提一句自己在用「{product_name}」，{pitch}。"
            "只陈述事实，不要写成硬广。"
        )
    return prompt


def _style_line(tone: str) -> str:
    return STYLES.get(tone) or STYLES["casual"]

# (正则, 说明)。命中任意一条即视为不可直接发布。
RISK_PATTERNS: list[tuple[str, str]] = [
    (r"扣\s*个?\s*1", "诱导互动：扣1"),
    (r"评论区.{0,6}(留言|回复|扣|打)", "诱导互动：评论区索取"),
    (r"(私信|私我|si我|s我).{0,8}(发|要|领|给)", "诱导互动：私信索取"),
    (r"关注后.{0,8}(发|领|给|私)", "诱导互动：关注换资源"),
    (r"(点赞|收藏).{0,8}(关注|转发).{0,8}(换|领|送)", "诱导互动：三连换资源"),
    (r"(加|扫码).{0,6}(微信|vx|VX|v信|QQ)", "站外引流"),
    (r"二维码", "站外引流"),
    (r"(免费领|领取资料|资料包|后台回复)", "诱导领取"),
]

_EMOJI_RE = re.compile(
    "[\U0001F300-\U0001FAFF\u2600-\u27BF\u2B00-\u2BFF]"
)


def compliance_issues(text: str) -> list[dict[str, str]]:
    issues: list[dict[str, str]] = []
    for pattern, label in RISK_PATTERNS:
        match = re.search(pattern, text or "")
        if match:
            issues.append({"label": label, "match": match.group(0)})
    return issues


_BREAK_SENTENCE = "。！？!?；;\n"
_BREAK_CLAUSE = "，,、：:— "


def _shrink_text(text: str, limit: int) -> str:
    """超长时优先在句子边界收尾，其次在分句边界，最后才退到空格/硬切。"""
    if len(text) <= limit:
        return text.strip()
    window = text[: max(1, limit)]
    for seps in (_BREAK_SENTENCE, _BREAK_CLAUSE):
        index = max(window.rfind(char) for char in seps)
        if index >= max(4, limit // 2):
            return window[: index + 1].rstrip("，,、：:— \n")
    index = window.rfind(" ")
    if index >= max(4, limit // 2):
        return window[:index].rstrip()
    return window.strip()


def normalize_title(title: str, fallback: str = "", limit: int | None = None) -> str:
    value = re.sub(r"\s+", " ", (title or "").strip())
    value = value.strip("《》\"' ")
    if not value:
        value = fallback.strip()
    max_length = int(limit or config.TITLE_MAX)
    return _shrink_text(value, max_length).strip("，,、：:— ")


def normalize_topics(raw: Any, keyword: str = "", max_topics: int = 6) -> list[str]:
    items: list[str] = []
    limit = max(1, int(max_topics))

    def add_text(value: Any) -> None:
        text = str(value or "").strip().lstrip("#")
        for part in re.split(r"[,，;；\s#]+", text):
            part = part.strip().lstrip("#")
            if 1 < len(part) <= 16 and part not in items and len(items) < limit:
                items.append(part)

    if isinstance(raw, str):
        add_text(raw)
    elif isinstance(raw, (list, tuple, set)):
        for item in raw:
            add_text(item)
    if not items and keyword:
        add_text(keyword)
    return items[:limit]


def strip_tag_lines(desc: str) -> str:
    """去掉只由话题标签组成的行，避免改标签时不断累加。"""
    lines = (desc or "").splitlines()
    kept = [
        line
        for line in lines
        if not re.fullmatch(r"\s*(#[^\s#]+#?\s*)+\s*", line)
    ]
    return "\n".join(kept).strip()


def format_topic(topic: str, style: str = "hashtag") -> str:
    """按平台的话题写法格式化：hashtag=#话题，topic=#话题#，none=不加。"""
    text = str(topic or "").strip().strip("#").strip()
    if not text:
        return ""
    if style == "none":
        return ""
    if style == "topic":
        return f"#{text}#"
    return f"#{text}"


def append_topics(desc: str, topics: list[str], platform: str = "") -> str:
    body = (desc or "").strip()
    if not topics:
        return body
    adapter = get_platform(platform) if platform else None
    style = (adapter.topic_style if adapter else "hashtag") or "hashtag"
    tags = [tag for tag in (format_topic(topic, style) for topic in topics) if tag]
    if not tags:
        return body
    # 按话题名判重，避免正文里已有 #话题 时又追加一遍 #话题#。
    missing = [
        tag
        for topic, tag in zip(topics, tags)
        if f"#{str(topic or '').strip().strip('#').strip()}" not in body
    ]
    if missing:
        body = body + "\n\n" + " ".join(missing)
    return body


def append_hashtags(desc: str, topics: list[str]) -> str:
    """小红书等 # 话题平台的兼容入口。"""
    return append_topics(desc, topics, DEFAULT_PLATFORM)


def normalize_desc(
    desc: str,
    topics: list[str],
    limit: int | None = None,
    platform: str = "",
) -> str:
    body = re.sub(r"\n{3,}", "\n\n", (desc or "").strip())
    max_length = int(limit or config.DESC_MAX)
    adapter = get_platform(platform) if platform else None
    style = (adapter.topic_style if adapter else "hashtag") or "hashtag"
    tag_text = " ".join(
        tag for tag in (format_topic(topic, style) for topic in topics) if tag
    )
    reserve = len(tag_text) + 2 if tag_text else 0
    body = _truncate_body(body, max(1, max_length - reserve))
    return append_topics(body, topics, platform)


def _strip_markdown_shell(text: str) -> str:
    """去掉模型自带的「1. **标题** / **正文** / **#话题标签**」外壳。"""
    text = (text or "").strip()
    text = re.sub(r"^\s*#{1,6}\s+", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s*\d+[.、]\s*", "", text, flags=re.MULTILINE)
    text = re.sub(r"\*\*", "", text)
    lines = []
    for line in text.splitlines():
        if re.fullmatch(r"\s*#+\s*", line):
            continue
        if re.fullmatch(r"\s*(标题|正文|话题标签)\s*[:：]?\s*", line):
            continue
        line = re.sub(r"^\s*(标题|正文)\s*[:：]\s*", "", line)
        lines.append(line.strip())
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def _split_writenow(
    text: str, title_limit: int | None = None
) -> tuple[str, str, list[str]]:
    """拆出标题、正文、话题；不依赖固定 JSON，兼容真正的 Markdown 输出。"""
    cleaned = _strip_markdown_shell(text)
    tag_parts: list[str] = []
    body_lines: list[str] = []
    for line in cleaned.splitlines():
        stripped = line.strip()
        if not stripped:
            body_lines.append("")
            continue
        hashes = re.findall(r"#([^\s#，,。.!！?？]+)", stripped)
        if hashes and len(re.sub(r"#\S+", "", stripped).strip(" #")) <= 2:
            tag_parts.extend(hashes)
            continue
        body_lines.append(stripped)
    body = re.sub(r"\n{3,}", "\n\n", "\n".join(body_lines)).strip()
    body = re.sub(r"(?:\s*#\S+){2,}\s*$", "", body).strip()
    lines = [line for line in body.splitlines() if line.strip()]
    title = lines[0] if lines else ""
    body = "\n".join(lines[1:]).strip() if len(lines) > 1 else ""
    return normalize_title(title, limit=title_limit), body, tag_parts


def _body_length(text: str) -> int:
    return len(re.sub(r"\s", "", text or ""))


def _split_writenow_rich(
    text: str, title_limit: int | None = None
) -> tuple[str, str, list[str]]:
    """公众号专用：保留 Markdown 结构，只把第一行当标题、末尾标签行摘出来。"""
    tag_parts: list[str] = []
    body_lines: list[str] = []
    for line in str(text or "").replace("\r\n", "\n").split("\n"):
        stripped = line.strip()
        if not stripped:
            body_lines.append("")
            continue
        # 标题行（# / ## / ###）不按话题处理。
        if re.match(r"^#{1,6}\s", stripped):
            body_lines.append(line.rstrip())
            continue
        hashes = re.findall(r"#([^\s#，,。.!！?？]+)", stripped)
        if hashes and len(re.sub(r"#\S+", "", stripped).strip(" #")) <= 2:
            tag_parts.extend(hashes)
            continue
        body_lines.append(line.rstrip())

    first = next((item for item in body_lines if item.strip()), "")
    if first:
        index = body_lines.index(first)
        title = re.sub(r"^#{1,6}\s*", "", first.strip()).strip()
        body = "\n".join(body_lines[index + 1 :])
    else:
        title, body = "", ""
    body = re.sub(r"\n{3,}", "\n\n", body).strip()
    return normalize_title(title, limit=title_limit), body, tag_parts


def _rich_length(markdown: str) -> int:
    """按去掉 Markdown 标记后的可见字数计，避免标题标记撑大篇幅。"""
    return _body_length(richtext.markdown_to_text(markdown))


def _clean_rich_body(markdown: str, limit: int) -> str:
    """清掉模型可能泄漏的外壳，但保留 Markdown 结构（标题/引用/列表/分割线）。"""
    lines: list[str] = []
    for line in str(markdown or "").splitlines():
        stripped = line.strip()
        if re.fullmatch(r"(标题|正文|话题标签)\s*[:：]?", stripped):
            continue
        line = re.sub(r"^\s*(标题|正文)\s*[:：]\s*", "", line)
        lines.append(line.rstrip())
    text = re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()
    # 只清英文语气 key 的泄漏，中文替换会误伤正文。
    for word in sorted(TONE_WORDS, key=len, reverse=True):
        if re.fullmatch(r"[A-Za-z_]+", word):
            text = re.sub(rf"(?<![A-Za-z]){re.escape(word)}(?![A-Za-z])", "", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if _rich_length(text) <= limit:
        return text
    # 超长时按段落截断，保留完整结构。
    kept: list[str] = []
    for block in re.split(r"(\n{2,})", text):
        if _rich_length("".join(kept) + block) > limit:
            break
        kept.append(block)
    result = "".join(kept).strip()
    return result or text


def _finalize_copy(
    platform: str,
    title: str,
    body: str,
    topics: list[str],
    *,
    spec: Any,
    profile: dict[str, int],
    title_fallback: str = "",
) -> dict[str, Any]:
    """按平台收敛标题/正文：公众号产出 Markdown + HTML，其余平台只留纯文本。"""
    platform = normalize(platform)
    final_title = normalize_title(title, title_fallback, spec.title_max)
    body_md = body_html = ""
    if platform == "wechat_mp":
        body_md = _clean_rich_body(body, profile["body_max"])
        body_html = richtext.markdown_to_html(body_md)
        if topics:
            # 话题标签跟着正文一起进 HTML，否则发布出去的正文里看不到。
            tags = " ".join(format_topic(topic, "topic") for topic in topics if topic)
            if tags:
                body_html += f"\n<p>{tags}</p>"
        desc = normalize_desc(richtext.html_to_text(body_html), topics, spec.desc_max, platform)
    else:
        desc = normalize_desc(
            _clean_generated_body(body, profile["body_max"]), topics, spec.desc_max, platform
        )
    return {
        "title": final_title,
        "desc": desc,
        "topics": topics,
        "body_md": body_md,
        "body_html": body_html,
    }


def _truncate_body(text: str, limit: int) -> str:
    """按句子边界压缩；单句过长时再退到分句边界，避免硬切半个词。"""
    result = ""
    for chunk in re.split(r"(?<=[。！？!?；;\n])", text):
        if _body_length(result + chunk) > limit:
            break
        result += chunk
    if result.strip():
        return result.strip()
    return _shrink_text(text.strip(), limit)


def _clean_generated_body(body: str, limit: int = 450) -> str:
    """删语气词泄漏、删 Markdown 残留，并按记录里 250-350 字的篇幅收紧。"""
    text = body or ""
    for word in sorted(TONE_WORDS, key=len, reverse=True):
        if re.fullmatch(r"[A-Za-z_]+", word):
            text = re.sub(rf"(?<![A-Za-z]){re.escape(word)}(?![A-Za-z])", "", text)
        else:
            text = text.replace(word, "")
    text = re.sub(r"\*+", "", text)
    text = re.sub(r"(?im)^\s*(标题|正文|话题标签)\s*[:：].*$", "", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return _truncate_body(text, limit) if _body_length(text) > limit else text


def _sentences(desc: str) -> list[str]:
    text = re.sub(r"\s+", " ", (desc or "")).strip()
    return [part.strip() for part in re.split(r"[。！？!?\n]+", text) if part.strip()]


def _offline_xhs(seed: str, sentences: list[str], product: bool) -> tuple[str, str, list[str]]:
    """小红书图文兜底：具体钩子 + 三条做法 + 问句，不堆 emoji 和称呼。"""
    first = sentences[0] if sentences else seed
    points = (sentences[1:4] if len(sentences) > 1 else [first])[:3]
    while len(points) < 3:
        points.append(["先做最小的一步", "做完记一句结果"][len(points) - 1])
    title = normalize_title(seed, seed, 20)
    lines = [
        first,
        "",
        "我自己的做法是：",
    ]
    for index, point in enumerate(points, start=1):
        lines.append(f"{index}. {point}")
    lines += ["", "先把最小的那一步做掉，比整晚焦虑有用。"]
    if product:
        product_name = db.get_setting("product_name", "应声面试 Pro")
        pitch = db.get_setting("product_pitch", "")
        lines += ["", f"顺便说一句，我自己在用「{product_name}」，{pitch}".strip()]
    lines += ["", "你卡在哪一步？"]
    return title, "\n".join(lines), normalize_topics([], seed, 6)


def _offline_wechat(
    seed: str, sentences: list[str], product: bool, angle: str = ""
) -> tuple[str, str, list[str]]:
    """公众号离线模板：导语 + 三个小标题 + 段落推进 + 收束，明显长于小红书。"""
    first = sentences[0] if sentences else seed

    def point(index: int, fallback: str) -> str:
        return sentences[index] if index < len(sentences) else fallback

    intro = (
        f"最近不少读者问我关于「{seed}」的问题。{first}。"
        "这篇把自己踩过的坑、实际采用的做法和容易忽略的细节一次讲清楚，尽量少讲空话。"
    )
    sections = [
        (
            "一、先把问题看清楚",
            [
                f"{point(1, '先把目标写下来')}。在动手之前，我会把目标、限制条件和最坏结果各写一行，判断会清楚很多。",
                "很多卡住并不是能力不够，而是问题定义太模糊。把「我想要什么」换成「下一步能验证什么」，行动就会具体。",
            ],
        ),
        (
            "二、我实际采用的步骤",
            [
                f"{point(2, '先把最小的一步做完')}。我的做法是拆成可以检查的小节点，每完成一个就记录一次结果。",
                "不要一次把所有事情铺开。先跑通一个最小闭环，再根据反馈调整，比一开始追求完美更可靠。",
            ],
        ),
        (
            "三、容易被忽略的细节",
            [
                f"{point(3, '把过程记录下来')}。这些细节短期看不出差别，但决定了后面能不能稳定复现。",
                "如果中途出问题，先回到最近一次有效结果，而不是推倒重来。保留过程，才有机会复盘。",
            ],
        ),
    ]
    lines = [intro, ""]
    for heading, paragraphs in sections:
        lines += [f"## {heading}", ""]
        for paragraph in paragraphs:
            lines += [paragraph, ""]
    closing = (
        f"回到「{seed}」，最重要的不是一次做对，而是先开始、再迭代。"
        f"{angle or '如果你也在处理类似的问题，可以从今天最小的一步开始。'}"
    )
    if product:
        product_name = db.get_setting("product_name", "应声面试 Pro")
        pitch = db.get_setting("product_pitch", "")
        closing += f" 我自己在用「{product_name}」，{pitch}".strip()
    lines.append(closing)
    title = normalize_title(f"{seed}：我的做法与三个关键步骤", seed, 64)
    return title, "\n".join(lines), normalize_topics([], seed, 3)


def _offline_douyin(
    seed: str, sentences: list[str], product: bool
) -> tuple[str, str, list[str]]:
    """抖音图文离线模板：短配文，不带镜头标记。"""
    first = sentences[0] if sentences else seed
    second = sentences[1] if len(sentences) > 1 else "把目标拆成今天能做完的一步"
    title = normalize_title(f"{seed}，先别急着找方法", seed, 55)
    lines = [
        first,
        f"先做最小的一步：{second}",
        "再把目标拆成今天能做完的动作",
        "做完记一句结果，下次直接用",
    ]
    if product:
        product_name = db.get_setting("product_name", "应声面试 Pro")
        lines.append(f"我自己在用「{product_name}」，省了不少时间。")
    lines.append("你卡在哪一步？")
    return title, "\n".join(lines), normalize_topics([], seed, 4)


def _offline_writenow(
    desc: str,
    topic: str,
    tone: str,
    product: bool,
    platform: str = DEFAULT_PLATFORM,
    angle: str = "",
) -> tuple[str, str, list[str]]:
    """模型不可用时的兜底：三个平台各自一套结构，不再共用同一模板。"""
    platform = normalize(platform)
    sentences = _sentences(desc)
    seed = topic.strip() or (sentences[0] if sentences else "今天想聊一件事")
    if platform == "wechat_mp":
        return _offline_wechat(seed, sentences, product, angle)
    if platform == "douyin":
        return _offline_douyin(seed, sentences, product)
    return _offline_xhs(seed, sentences, product)


def _call_writenow(
    client: LLMClient,
    desc: str,
    *,
    topic: str,
    tone: str,
    tags: bool,
    product: bool,
    extra: str = "",
    timeout: float | None = None,
    platform: str = DEFAULT_PLATFORM,
) -> str:
    user = build_writenow_prompt(
        desc, topic=topic, tone=tone, tags=tags, product=product, platform=platform
    )
    if extra:
        user += f"\n{extra}"
    # 与旧版保持一致：deepseek-flash 推理模型固定 3000 token，temperature 用默认值 1.0。
    return client.chat(
        [
            {
                "role": "system",
                "content": build_system_prompt(tone, tags, product, platform),
            },
            {"role": "user", "content": user},
        ],
        max_tokens=3000,
        temperature=1.0,
        timeout=timeout,
    )


def _llm_failure_text(exc: BaseException) -> str:
    text = str(exc or "")
    lowered = text.lower()
    # 登录 / 订阅 / 额度问题本身就是给用户看的原话，不要再包一层「模型不可用」。
    if any(word in text for word in ("登录", "订阅", "额度", "续费")):
        return text
    if "超时" in text or "timeout" in lowered:
        return "模型响应超时，已用离线模板生成，可稍后重试"
    if "连接" in text or "connect" in lowered or "network" in lowered:
        return "模型连接失败，已用离线模板生成，请检查网络或代理后重试"
    return "模型暂时不可用，已用离线模板生成，可稍后重试"


def _platform_writing(platform: str):
    key = normalize(platform)
    profile = PLATFORM_WRITING.get(key, PLATFORM_WRITING[DEFAULT_PLATFORM])
    adapter = get_platform(key)
    return key, profile, adapter, adapter.spec()


def _compress_instruction(platform: str, profile: dict[str, int], current: int) -> str:
    target = f"{profile['body_min']}-{profile['body_max']} 字"
    if platform == "wechat_mp":
        return (
            f"上一版正文 {current} 字，超过公众号目标篇幅。请压缩到 {target}，"
            "保留导语、三个小标题和结尾的完整结构，保留 Markdown 结构"
            "（第一行标题、## 小标题、段落、必要的引用或列表），删掉重复论证和空泛铺垫，"
            "不要改标题，不要输出解释。"
        )
    if platform == "douyin":
        return (
            f"上一版正文 {current} 字，太长了。请压缩到 {target}，"
            "保留图文配文结构：钩子、具体做法、结论，短句口语，"
            "不要写【画面】【口播】等镜头标记，不要输出解释。"
        )
    return (
        f"上一版正文 {current} 字，太长了。请重写到 {target}，"
        "保留短句换行和话题标签，不要 Markdown 加粗，不要输出解释。"
    )


def _generate_writenow(
    desc: str,
    *,
    topic: str = "",
    tone: str = "",
    tags: bool = True,
    product: bool = False,
    use_llm: bool = True,
    platform: str = DEFAULT_PLATFORM,
) -> dict[str, Any]:
    """按平台生成：prompt、篇幅、话题数量、离线模板都走各自的策略。"""
    desc = (desc or "").strip()
    if not desc:
        raise ValueError("文案描述不能为空")
    platform, profile, _adapter, spec = _platform_writing(platform)
    tone = tone or db.get_setting("draft_style", "casual")
    engine = "offline"
    raw = ""
    title = body = ""
    found_tags: list[str] = []
    llm_error = ""
    deadline = time.monotonic() + config.LLM_TOTAL_BUDGET_SEC

    client = LLMClient()
    blocked = getattr(client, "blocked_reason", "") if use_llm else ""
    if blocked:
        raise LLMError(blocked)
    if use_llm and client.configured:
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 8:
                raise LLMError("模型响应超时（生成预算已用完）")
            raw = _call_writenow(
                client,
                desc,
                topic=topic,
                tone=tone,
                tags=tags,
                product=product,
                timeout=min(config.LLM_TIMEOUT_SEC, remaining),
                platform=platform,
            )
            title, body, found_tags = (
                _split_writenow_rich(raw, spec.title_max)
                if platform == "wechat_mp"
                else _split_writenow(raw, spec.title_max)
            )
            measure = _rich_length(body) if platform == "wechat_mp" else _body_length(body)
            if body and measure > profile["body_max"]:
                remaining = deadline - time.monotonic()
                if remaining > 12:
                    compressed = _call_writenow(
                        client,
                        desc,
                        topic=topic,
                        tone=tone,
                        tags=tags,
                        product=product,
                        extra=_compress_instruction(platform, profile, measure),
                        timeout=min(config.LLM_TIMEOUT_SEC, remaining),
                        platform=platform,
                    )
                    new_title, new_body, new_tags = (
                        _split_writenow_rich(compressed, spec.title_max)
                        if platform == "wechat_mp"
                        else _split_writenow(compressed, spec.title_max)
                    )
                    if new_body:
                        title = new_title or title
                        body = new_body
                        found_tags = new_tags or found_tags
                        raw = compressed
            engine = "llm" if body else "offline"
            if not body:
                llm_error = "模型没有返回有效正文，已用离线模板生成，可稍后重试"
        except (LLMError, ValueError, Exception) as exc:  # noqa: BLE001
            llm_error = _llm_failure_text(exc)
            logger.warning(f"模型文案生成失败，改用离线模板: {exc}")

    if not body:
        title, body, found_tags = _offline_writenow(
            desc, topic, tone, product, platform=platform
        )
        engine = "offline"
        raw = body

    if not tags:
        body = re.sub(r"#[^\s#，,。.!！?？]+", "", body).strip()
        topics: list[str] = []
    else:
        topics = normalize_topics(found_tags, topic, profile["topics_max"])
    final = _finalize_copy(
        platform,
        title,
        body,
        topics,
        spec=spec,
        profile=profile,
        title_fallback=topic or desc[:20],
    )
    return {
        "title": final["title"],
        "desc": final["desc"],
        "topics": final["topics"],
        "body_md": final["body_md"],
        "body_html": final["body_html"],
        "engine": engine,
        "raw": raw,
        "platform": platform,
        "platform_name": platform_label(platform),
        "title_max": spec.title_max,
        "body_target": [profile["body_min"], profile["body_max"]],
        "compliance": compliance_issues(f"{final['title']}\n{final['desc']}"),
        # 模型失败时前端可据此提示「已用离线模板」并保留重试入口。
        "llm_error": llm_error,
        "retryable": bool(llm_error),
    }


def generate_copy(
    topic: dict[str, Any],
    *,
    tone: str = "",
    product: bool | None = None,
    use_llm: bool = True,
    platform: str = DEFAULT_PLATFORM,
) -> dict[str, Any]:
    tone = tone or str(topic.get("tone") or db.get_setting("draft_style", "casual"))
    product = bool(topic.get("product")) if product is None else bool(product)
    title = str(topic.get("title") or "")
    angle = str(topic.get("angle") or "")
    desc = f"{title}。{angle}".strip("。") if angle else title
    return _generate_writenow(
        desc,
        topic=title,
        tone=tone,
        tags=True,
        product=product,
        use_llm=use_llm,
        platform=platform,
    )


def generate_from_brief(
    brief: str,
    *,
    topic: str = "",
    tone: str = "",
    tags: bool = True,
    product: bool = False,
    use_llm: bool = True,
    platform: str = DEFAULT_PLATFORM,
) -> dict[str, Any]:
    """按创作页的文案描述生成，走记录里验证过的 WriteNow 链路。"""
    return _generate_writenow(
        brief,
        topic=topic,
        tone=tone,
        tags=tags,
        product=product,
        use_llm=use_llm,
        platform=platform,
    )


_REWRITE_OPENERS = {
    "story": "这篇是我踩过坑之后，重新整理的一版",
    "informative": "先把结论放前面，省得你翻半天",
    "warn": "先把容易踩的坑列出来，再讲怎么做",
    "emotional": "写给和我一样卡在这一步的人",
    "professional": "按可复用的步骤重新拆一遍",
    "casual": "换个说法，把这件事再讲一遍",
}
_POINT_MARKS = ["✅", "💡", "1️⃣", "2️⃣", "3️⃣"]


def _rewrite_sentences(body: str) -> list[str]:
    lines = [
        line.strip()
        for line in str(body or "").splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]
    sentences: list[str] = []
    for line in lines:
        cleaned = re.sub(r"^[✅💡✨🔍1-9️⃣\-】\s]+", "", line).strip()
        for part in re.split(r"[。！？!?；;]", cleaned):
            part = part.strip()
            if len(part) >= 6:
                sentences.append(part)
    if not sentences:
        fallback = re.sub(r"\s+", "", body)[:60]
        if fallback:
            sentences.append(fallback)
    return sentences


def _offline_rewrite_xhs(
    title: str, body: str, angle: str, tone: str
) -> tuple[str, str, list[str]]:
    """模型不可用时的洗稿兜底：拆要点、换开头、换结构，信息点不丢。"""
    sentences = _rewrite_sentences(body)
    points = sentences[2:6] or sentences[:3] or ["先把最小的一步做完"]
    core = re.sub(r"[\s✨]+", "", title)[:14] or "这件事"
    new_title = normalize_title(f"{core}：{angle[:10]}" if angle else f"{core}（重写版）", title, 20)
    opener = _REWRITE_OPENERS.get(tone) or _REWRITE_OPENERS["casual"]
    out = [
        f"{opener}。",
        "",
        f"先说核心：{sentences[0] if sentences else core}。",
        "",
        "重新梳理成三点：",
    ]
    for index, point in enumerate(points[:3], start=1):
        out.append(f"{index}. {point}")
    out += ["", f"换个角度看：{angle or '同一个信息点，换一种讲法'}。", "", "你更认同哪一种做法？"]
    return new_title, "\n".join(out), normalize_topics([], title, 6)


def _offline_rewrite_wechat(
    title: str, body: str, angle: str, tone: str
) -> tuple[str, str, list[str]]:
    """公众号洗稿兜底：导语 + 三个小标题 + 段落推进 + 收束，不堆 emoji。"""
    sentences = _rewrite_sentences(body)
    seed = re.sub(r"[\s#]+", "", title)[:20] or "这件事"
    first = sentences[0] if sentences else seed

    def point(index: int, fallback: str) -> str:
        return sentences[index] if index < len(sentences) else fallback

    intro = (
        f"这篇想聊的还是「{seed}」。{first}。"
        f"{angle or '换个角度重新梳理后，我发现真正有用的部分集中在几个关键动作上'}，"
        "下面按顺序讲清楚，尽量不重复空话。"
    )
    sections = [
        (
            "一、问题到底卡在哪里",
            [
                f"{point(1, '先确认自己卡在哪一步')}。多数时候不是不够努力，而是没有把问题拆到可以验证的粒度。",
                "我会先写下一句话结论，再问自己：这句话有没有具体依据？如果没有，就先补事实，而不是继续找方法。",
            ],
        ),
        (
            "二、可以照着做的顺序",
            [
                f"{point(2, '先把最小的一步做完')}。顺序上先跑通一个最小闭环，再考虑优化，比一开始追求完整更稳。",
                "每完成一步就记录结果，出现偏差时回到最近一次有效状态，而不是推翻重来。",
            ],
        ),
        (
            "三、容易被忽略的细节",
            [
                f"{point(3, '把过程留下来')}。这些细节短期看不出差别，但决定了能不能稳定复现。",
                "表达上我尽量用事实和过程替代形容词，读者才能判断这套做法是否适用于自己。",
            ],
        ),
    ]
    lines = [intro, ""]
    for heading, paragraphs in sections:
        lines += [f"## {heading}", ""]
        for paragraph in paragraphs:
            lines += [paragraph, ""]
    closing = (
        f"回到「{seed}」，相对可靠的路径是先把问题说清楚，再按顺序推进，最后复盘。"
        "如果你也在处理类似的事，可以从今天最小的一步开始。"
    )
    lines.append(closing)
    new_title = normalize_title(
        f"{seed}：重写后的完整思路与三个关键步骤", seed, 64
    )
    return new_title, "\n".join(lines), normalize_topics([], seed, 3)


def _offline_rewrite_douyin(
    title: str, body: str, angle: str, tone: str
) -> tuple[str, str, list[str]]:
    """抖音图文洗稿兜底：短配文，不带镜头标记。"""
    sentences = _rewrite_sentences(body)
    core = re.sub(r"[\s#]+", "", title)[:16] or "这件事"
    hook = sentences[0] if sentences else core
    lines = [hook[:30]]
    if angle:
        lines.append(angle[:30])
    for point in sentences[1:4]:
        lines.append(point[:30])
    lines.append("你卡在哪一步？")
    new_title = normalize_title(f"{core}，换个角度再看一次", core, 55)
    return new_title, "\n".join(lines), normalize_topics([], core, 4)


def _offline_rewrite(
    title: str, body: str, angle: str, tone: str, platform: str = DEFAULT_PLATFORM
) -> tuple[str, str, list[str]]:
    key = normalize(platform)
    if key == "wechat_mp":
        return _offline_rewrite_wechat(title, body, angle, tone)
    if key == "douyin":
        return _offline_rewrite_douyin(title, body, angle, tone)
    return _offline_rewrite_xhs(title, body, angle, tone)


def _rewrite_instruction(platform: str, profile: dict[str, int], angle: str) -> str:
    target = f"{profile['body_min']}-{profile['body_max']} 字"
    if platform == "wechat_mp":
        return (
            f"请按「{angle}」改写成一篇公众号长文：{target}，"
            "有导语、三个小标题和结尾收束，用完整段落推进，书面克制，"
            "最多 2 个 emoji，不要分点清单。"
        )
    if platform == "douyin":
        return (
            f"请按「{angle}」改写成抖音图文配文：{target}，"
            "第一句用具体场景或痛点做钩子，中间写具体做法，最后给结论或问句；"
            "短句、口语，不要写【画面】【口播】等镜头标记。"
        )
    return (
        f"请按「{angle}」改写：保留短句换行和话题标签，"
        "开头用具体场景或结论，结尾用一个问句，不要强制称呼。"
    )


def rewrite_copy(
    source_title: str,
    source_desc: str,
    *,
    angle: str = "",
    tone: str = "",
    tags: bool = True,
    use_llm: bool = True,
    platform: str = DEFAULT_PLATFORM,
) -> dict[str, Any]:
    """洗稿：保留信息点，换角度/结构/语气，按平台产出对应形态。"""
    platform, profile, _adapter, spec = _platform_writing(platform)
    title = normalize_title(source_title, "一篇需要改写的笔记", spec.title_max)
    body = strip_tag_lines(source_desc)
    if not _body_length(body):
        raise ValueError("待洗稿的正文为空")
    tone = tone or db.get_setting("draft_style", "story")
    angle = angle.strip() or "换个角度重写，保留全部信息点"
    engine = "offline"
    raw = ""
    new_title = new_body = ""
    found_tags: list[str] = []
    llm_error = ""
    client = LLMClient()
    blocked = getattr(client, "blocked_reason", "") if use_llm else ""
    if blocked:
        raise LLMError(blocked)
    if use_llm and client.configured:
        try:
            user = (
                f"[分享主题: {title}，发布平台: {platform_label(platform)}，语气风格: {tone}] "
                "下面是一篇已经发过的文案。\n"
                f"{_rewrite_instruction(platform, profile, angle)}\n"
                "要求：保留全部事实和信息点，不要新增没根据的内容；"
                "换开头、换段落结构、换表达方式，不要照抄原句；"
                "不要出现「原文 / 洗稿 / 改写」这些词。\n\n"
                f"原标题：{title}\n原正文：\n{body}"
            )
            raw = client.chat(
                [
                    {
                        "role": "system",
                        "content": build_system_prompt(tone, tags, False, platform),
                    },
                    {"role": "user", "content": user},
                ],
                max_tokens=3000,
                temperature=1.0,
                timeout=config.LLM_TIMEOUT_SEC,
            )
            new_title, new_body, found_tags = (
                _split_writenow_rich(raw, spec.title_max)
                if platform == "wechat_mp"
                else _split_writenow(raw, spec.title_max)
            )
            engine = "llm" if new_body else "offline"
            if not new_body:
                llm_error = "模型没有返回有效正文，已用离线改写，可稍后重试"
        except (LLMError, ValueError, Exception) as exc:  # noqa: BLE001
            llm_error = _llm_failure_text(exc)
            logger.warning(f"洗稿模型调用失败，改用离线改写: {exc}")
    if not new_body:
        new_title, new_body, found_tags = _offline_rewrite(
            title, body, angle, tone, platform
        )
        engine = "offline"
        raw = new_body
    new_title = normalize_title(new_title, title, spec.title_max)
    topics = normalize_topics(found_tags, title, profile["topics_max"]) if tags else []
    final = _finalize_copy(
        platform,
        new_title,
        new_body,
        topics,
        spec=spec,
        profile=profile,
        title_fallback=title,
    )
    return {
        "title": final["title"],
        "desc": final["desc"],
        "topics": final["topics"],
        "body_md": final["body_md"],
        "body_html": final["body_html"],
        "engine": engine,
        "raw": raw,
        "angle": angle,
        "source_title": title,
        "platform": platform,
        "platform_name": platform_label(platform),
        "title_max": spec.title_max,
        "body_target": [profile["body_min"], profile["body_max"]],
        "compliance": compliance_issues(f"{final['title']}\n{final['desc']}"),
        "llm_error": llm_error,
        "retryable": bool(llm_error),
    }


CONVERT_TARGETS = ("wechat_mp", DEFAULT_PLATFORM)


def _convert_instruction(target: str, profile: dict[str, int], source_name: str) -> str:
    target_len = f"{profile['body_min']}-{profile['body_max']} 字"
    if target == "wechat_mp":
        return (
            f"把下面这篇{source_name}改写为公众号长文：{target_len}。"
            "第一行只写标题；空一行后写正文，用 `## 一、` `## 二、` `## 三、` 分三节，"
            "段落之间空一行，需要强调结论时用 `> ` 引用一次，结尾给读者一个可执行的下一步。"
            "去掉 emoji 分节、「姐妹们」这类口语称呼和话题标签，保留全部事实与信息点，"
            "不要新增没有依据的内容，不要输出解释。"
        )
    return (
        f"把下面这篇{source_name}压缩成小红书笔记：{target_len}。"
        "用 emoji 分节、短句换行，开头一句口语钩子，要点用 ✅ / 💡 打头，"
        "结尾用一个问句邀请评论，最后一行放 3-6 个话题标签。"
        "不要 Markdown 加粗、不要 `##` 标题、不要书面小标题，保留全部信息点。"
    )


def convert_copy(
    source_title: str,
    source_desc: str,
    *,
    body_md: str = "",
    body_html: str = "",
    source_platform: str = "",
    target_platform: str = DEFAULT_PLATFORM,
    tone: str = "",
    use_llm: bool = True,
) -> dict[str, Any]:
    """小红书 ↔ 公众号互转：长文压成短笔记，短笔记扩成长文。"""
    target, profile, _adapter, spec = _platform_writing(target_platform)
    source_key = (
        normalize(source_platform)
        if source_platform
        else ("wechat_mp" if (body_md or body_html) else DEFAULT_PLATFORM)
    )
    if source_key == target:
        raise ValueError("源内容和目标平台相同，不需要转换")
    title = normalize_title(source_title, "一篇需要转换的文案", spec.title_max)
    if body_md.strip():
        source_text = body_md.strip()
    elif body_html.strip():
        source_text = richtext.html_to_text(body_html)
    else:
        source_text = strip_tag_lines(source_desc)
    if not _body_length(source_text):
        raise ValueError("待转换的正文为空")
    tone = tone or db.get_setting("draft_style", "casual")
    engine = "offline"
    raw = ""
    new_title = new_body = ""
    found_tags: list[str] = []
    llm_error = ""
    client = LLMClient()
    blocked = getattr(client, "blocked_reason", "") if use_llm else ""
    if blocked:
        raise LLMError(blocked)
    if use_llm and client.configured:
        try:
            user = (
                f"[分享主题: {title}，源平台: {platform_label(source_key)}，"
                f"目标平台: {platform_label(target)}，语气风格: {tone}]\n"
                f"{_convert_instruction(target, profile, platform_label(source_key))}\n\n"
                f"原标题：{title}\n原正文：\n{source_text}"
            )
            raw = client.chat(
                [
                    {
                        "role": "system",
                        "content": build_system_prompt(tone, True, False, target),
                    },
                    {"role": "user", "content": user},
                ],
                max_tokens=3000,
                temperature=1.0,
                timeout=config.LLM_TIMEOUT_SEC,
            )
            new_title, new_body, found_tags = (
                _split_writenow_rich(raw, spec.title_max)
                if target == "wechat_mp"
                else _split_writenow(raw, spec.title_max)
            )
            engine = "llm" if new_body else "offline"
            if not new_body:
                llm_error = "模型没有返回有效正文，已用离线模板转换，可稍后重试"
        except (LLMError, ValueError, Exception) as exc:  # noqa: BLE001
            llm_error = _llm_failure_text(exc)
            logger.warning(f"文案互转模型调用失败，改用离线模板: {exc}")

    if not new_body:
        plain = richtext.markdown_to_text(source_text) if body_md.strip() else source_text
        sentences = _sentences(plain)
        seed = title.strip() or (sentences[0] if sentences else "今天想聊一件事")
        if target == "wechat_mp":
            new_title, new_body, found_tags = _offline_wechat(seed, sentences, False)
        else:
            new_title, new_body, found_tags = _offline_xhs(seed, sentences, False)
        engine = "offline"
        raw = new_body

    topics = normalize_topics(found_tags, title, profile["topics_max"])
    final = _finalize_copy(
        target,
        new_title,
        new_body,
        topics,
        spec=spec,
        profile=profile,
        title_fallback=title,
    )
    return {
        "title": final["title"],
        "desc": final["desc"],
        "topics": final["topics"],
        "body_md": final["body_md"],
        "body_html": final["body_html"],
        "engine": engine,
        "raw": raw,
        "source_title": title,
        "source_platform": source_key,
        "platform": target,
        "platform_name": platform_label(target),
        "title_max": spec.title_max,
        "body_target": [profile["body_min"], profile["body_max"]],
        "compliance": compliance_issues(f"{final['title']}\n{final['desc']}"),
        "llm_error": llm_error,
        "retryable": bool(llm_error),
    }


class DraftService:
    """草稿 CRUD；所有写操作都会重算硬限制与合规标记。"""

    @staticmethod
    def _rich_body(
        platform: str, desc: str, body_md: str, body_html: str
    ) -> tuple[str, str]:
        """公众号保留富文本；其它平台清空，避免把 HTML 带到不支持的编辑器。"""
        if normalize(platform) != "wechat_mp":
            return "", ""
        html = str(body_html or "").strip()
        markdown = str(body_md or "").strip()
        if html:
            return markdown, richtext.sanitize_html(html)
        if markdown:
            return markdown, richtext.markdown_to_html(markdown)
        if str(desc or "").strip():
            return "", richtext.plain_to_html(desc)
        return "", ""

    @staticmethod
    def _append_topics_html(
        platform: str, body_html: str, topics: list[str]
    ) -> str:
        """公众号正文末尾补一行话题标签，已存在就不重复追加。"""
        if normalize(platform) != "wechat_mp" or not body_html or not topics:
            return body_html
        plain = richtext.html_to_text(body_html)
        missing = [str(topic) for topic in topics if f"#{topic}" not in plain]
        if not missing:
            return body_html
        tags = " ".join(f"#{topic}#" for topic in missing)
        return f"{body_html}\n<p>{tags}</p>"

    def serialize(self, row) -> dict[str, Any]:
        platform = row["platform"] or DEFAULT_PLATFORM
        adapter = get_platform(platform)
        content_type = row["content_type"] or adapter.default_content_type
        return {
            "id": row["id"],
            "topic_id": row["topic_id"],
            "account_id": row["account_id"],
            "platform": platform,
            "platform_name": platform_label(platform),
            "platform_ready": adapter.ready,
            "content_type": content_type,
            "content_type_label": adapter.spec(content_type).label,
            "spec": adapter.spec(content_type).as_dict(),
            "title": row["title"],
            "desc": row["desc"],
            "body_md": row["body_md"] or "",
            "body_html": row["body_html"] or "",
            "wx_theme": row["wx_theme"] or "",
            "media_type": row["media_type"],
            "visibility": row["visibility"],
            "images": db.json_field(row["images"], []),
            "topics": db.json_field(row["topics"], []),
            "content_json": db.json_field(row["content_json"] if "content_json" in row.keys() else "{}", {}),
            "status": row["status"],
            "compliance": db.json_field(row["compliance"], []),
            "source_note": row["source_note"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def get(self, draft_id: int) -> dict[str, Any]:
        row = db.query_one("SELECT * FROM drafts WHERE id = ?", (draft_id,))
        if row is None:
            raise KeyError(f"草稿不存在: {draft_id}")
        return self.serialize(row)

    def list(
        self, status: str = "", limit: int = 200, offset: int = 0, platform: str = ""
    ) -> list[dict[str, Any]]:
        sql = "SELECT * FROM drafts WHERE 1 = 1"
        args: list[Any] = []
        if status:
            sql += " AND status = ?"
            args.append(status)
        if platform:
            sql += " AND platform = ?"
            args.append(platform)
        sql += " ORDER BY id DESC LIMIT ? OFFSET ?"
        args.append(max(1, limit))
        args.append(max(0, int(offset)))
        items = []
        for row in db.query(sql, tuple(args)):
            item = self.serialize(row)
            job = db.query_one(
                "SELECT * FROM jobs WHERE draft_id = ? ORDER BY id DESC LIMIT 1", (row["id"],)
            )
            item["job_status"] = job["status"] if job else ""
            items.append(item)
        return items

    def count(self, status: str = "", platform: str = "") -> int:
        sql = "SELECT COUNT(*) FROM drafts WHERE 1 = 1"
        args: list[Any] = []
        if status:
            sql += " AND status = ?"
            args.append(status)
        if platform:
            sql += " AND platform = ?"
            args.append(platform)
        return int(db.scalar(sql, tuple(args), 0))

    def create_from_topic(
        self,
        topic: dict[str, Any],
        *,
        tone: str = "",
        product: bool | None = None,
        account_id: int | None = None,
        platform: str = DEFAULT_PLATFORM,
        content_type: str = "",
        use_llm: bool = True,
    ) -> dict[str, Any]:
        platform = (platform or DEFAULT_PLATFORM).strip() or DEFAULT_PLATFORM
        adapter = get_platform(platform)
        spec = adapter.spec(content_type)
        copy = generate_copy(
            topic, tone=tone, product=product, use_llm=use_llm, platform=platform
        )
        stamp = db.now()
        draft_id = db.execute(
            "INSERT INTO drafts(topic_id, account_id, platform, content_type, title, desc, "
            "body_md, body_html, media_type, visibility, images, topics, status, compliance, "
            "created_at, updated_at) "
            "VALUES(?,?,?,?,?,?,?,?, ?, 0, '[]', ?, 'draft', ?, ?, ?)",
            (
                topic.get("id"),
                account_id,
                platform,
                spec.key,
                copy["title"],
                copy["desc"],
                copy.get("body_md", ""),
                copy.get("body_html", ""),
                spec.media_type,
                json.dumps(copy["topics"], ensure_ascii=False),
                json.dumps(copy["compliance"], ensure_ascii=False),
                stamp,
                stamp,
            ),
        )
        item = self.get(draft_id)
        item["engine"] = copy["engine"]
        item["llm_error"] = copy.get("llm_error", "")
        item["retryable"] = copy.get("retryable", False)
        return item

    def create_manual(
        self,
        *,
        title: str,
        desc: str,
        topics: Any = None,
        images: list[str] | None = None,
        visibility: int = 0,
        media_type: str = "image",
        account_id: int | None = None,
        topic_id: int | None = None,
        source_note: str = "",
        platform: str = DEFAULT_PLATFORM,
        content_type: str = "",
        body_md: str = "",
        body_html: str = "",
        wx_theme: str = "",
    ) -> dict[str, Any]:
        """保存创作页里的内容，不经过选题。"""
        platform = (platform or DEFAULT_PLATFORM).strip() or DEFAULT_PLATFORM
        adapter = get_platform(platform)
        spec = adapter.spec(content_type) if content_type else adapter.spec_for_media(media_type)
        normalized_topics = normalize_topics(topics)
        normalized_title = normalize_title(title, limit=spec.title_max)
        if not normalized_title:
            raise ValueError("标题不能为空")
        body_md, body_html = self._rich_body(platform, desc, body_md, body_html)
        body_html = self._append_topics_html(platform, body_html, normalized_topics)
        body = strip_tag_lines(
            normalize_desc(desc, normalized_topics, spec.desc_max, platform)
        )
        if not body:
            raise ValueError("正文不能为空")
        media = [str(item) for item in (images or [])]
        stamp = db.now()
        draft_id = db.execute(
            "INSERT INTO drafts(topic_id, account_id, platform, content_type, title, desc, "
            "body_md, body_html, wx_theme, media_type, visibility, images, topics, status, compliance, "
            "source_note, created_at, updated_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?,?,?)",
            (
                topic_id,
                account_id,
                platform,
                spec.key,
                normalized_title,
                normalize_desc(body, normalized_topics, spec.desc_max, platform),
                body_md,
                body_html,
                str(wx_theme or ""),
                spec.media_type if spec.media_type in {"image", "video"} else "image",
                int(visibility or 0),
                json.dumps(media, ensure_ascii=False),
                json.dumps(normalized_topics, ensure_ascii=False),
                json.dumps(
                    compliance_issues(f"{normalized_title}\n{body}"), ensure_ascii=False
                ),
                str(source_note or ""),
                stamp,
                stamp,
            ),
        )
        item = self.get(draft_id)
        item["spec_warnings"] = adapter.validate(
            {"title": normalized_title, "desc": body, "images": media, "media_type": item["media_type"]}
        )
        return item

    def update(self, draft_id: int, fields: dict[str, Any]) -> dict[str, Any]:
        current = self.get(draft_id)
        spec = get_platform(current["platform"]).spec(current["content_type"])
        allowed = {
            "title",
            "desc",
            "body_md",
            "body_html",
            "wx_theme",
            "media_type",
            "visibility",
            "images",
            "topics",
            "account_id",
            "status",
            "content_json",
        }
        updates = {key: value for key, value in fields.items() if key in allowed}
        if not updates:
            return current
        if "body_md" in updates or "body_html" in updates:
            body_md, body_html = self._rich_body(
                current["platform"],
                str(updates.get("desc", current["desc"])),
                str(updates.get("body_md", "")),
                str(updates.get("body_html", "")),
            )
            if body_html:
                updates["body_md"] = body_md
                updates["body_html"] = self._append_topics_html(
                    current["platform"],
                    body_html,
                    updates.get("topics") or current["topics"],
                )
                if "desc" not in updates:
                    updates["desc"] = richtext.html_to_text(body_html)
            else:
                updates.pop("body_md", None)
                updates.pop("body_html", None)
        if "title" in updates:
            updates["title"] = normalize_title(
                str(updates["title"]), current["title"], spec.title_max
            )
        topics_changed = "topics" in updates
        desc_changed = "desc" in updates
        if topics_changed:
            topics = normalize_topics(updates["topics"])
            updates["topics"] = json.dumps(topics, ensure_ascii=False)
        else:
            topics = normalize_topics(current["topics"])
        if desc_changed:
            body = str(updates["desc"])
            if topics_changed:
                body = strip_tag_lines(body)
            updates["desc"] = normalize_desc(body, topics, spec.desc_max, current["platform"])
        elif topics_changed:
            updates["desc"] = normalize_desc(
                strip_tag_lines(str(current["desc"])),
                topics,
                spec.desc_max,
                current["platform"],
            )
        if "images" in updates:
            images = [str(item) for item in (updates["images"] or [])]
            updates["images"] = json.dumps(images, ensure_ascii=False)
        if "content_json" in updates:
            value = updates["content_json"]
            updates["content_json"] = (
                value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
            )
        if "visibility" in updates:
            updates["visibility"] = int(updates["visibility"])
        if "account_id" in updates and updates["account_id"] in ("", None):
            updates["account_id"] = None
        title = str(updates.get("title", current["title"]))
        desc = str(updates.get("desc", current["desc"]))
        updates["compliance"] = json.dumps(
            compliance_issues(f"{title}\n{desc}"), ensure_ascii=False
        )
        updates["updated_at"] = db.now()
        assignments = ", ".join(f"{key} = ?" for key in updates)
        db.execute(
            f"UPDATE drafts SET {assignments} WHERE id = ?",
            (*updates.values(), draft_id),
        )
        return self.get(draft_id)

    def switch_platform(
        self,
        draft_id: int,
        target_platform: str = "",
        content_type: str = "",
    ) -> dict[str, Any]:
        """同一篇草稿切平台：不新建副本，图片一张不丢。

        公众号只把第 1 张当封面，其余图片保留在 images 里，页面可一键插入正文。
        """
        current = self.get(draft_id)
        target = normalize(target_platform or current["platform"])
        if not target:
            raise ValueError("目标平台不可用")
        same_platform = target == current["platform"]
        next_type = (content_type or "").strip()
        if same_platform and (not next_type or next_type == current["content_type"]):
            return current
        if current.get("status") == "published":
            raise ValueError("已发布的草稿不能切换平台，可以另存为新草稿")
        adapter = get_platform(target)
        try:
            if next_type:
                spec = adapter.spec(next_type)
            elif same_platform:
                spec = adapter.spec(current["content_type"])
            else:
                spec = adapter.spec_for_media(current.get("media_type") or "image")
        except (KeyError, ValueError):
            spec = adapter.spec()
        topics = normalize_topics(current.get("topics"))
        title = normalize_title(str(current.get("title") or ""), limit=spec.title_max)
        if not title:
            raise ValueError("标题为空，先补一个标题再切换平台")
        desc = normalize_desc(
            strip_tag_lines(str(current.get("desc") or "")),
            topics,
            spec.desc_max,
            target,
        )
        visibility = int(current.get("visibility") or 0)
        if target == "wechat_mp":
            visibility = 1 if visibility == 1 else 0
        # 换平台沿用同一份内容模型与已出的全套图，避免再抽一次、再生成一次。
        previous = current.get("content_json") if isinstance(current.get("content_json"), dict) else {}
        preserved = {
            key: previous[key]
            for key in ("photo", "model", "model_hash", "renders", "wechat_square", "motion", "design_version")
            if previous.get(key)
        }
        renders = previous.get("renders") if isinstance(previous.get("renders"), dict) else {}
        # 只有当前图全部是自动生成的纸感图时才换套图；手动上传的图保持原样。
        paper_dir = str(config.DESIGN_DIR / f"draft-{draft_id}" / "paper")
        current_images = current.get("images") if isinstance(current.get("images"), list) else []
        auto_generated = not current_images or all(
            str(item).startswith(paper_dir) for item in current_images
        )
        next_images: list[str] | None = None
        if auto_generated and target == "wechat_mp":
            cover = renders.get("wechat_mp", {}).get("cover") if isinstance(renders.get("wechat_mp"), dict) else ""
            if cover and Path(str(cover)).exists():
                next_images = [str(cover)]
        elif auto_generated:
            shared = renders.get("xiaohongshu") or renders.get("douyin")
            if isinstance(shared, list) and shared and all(Path(str(item)).exists() for item in shared):
                next_images = [str(item) for item in shared]
        assignments = [
            "platform = ?", "content_type = ?", "media_type = ?", "title = ?",
            "desc = ?", "visibility = ?", "account_id = NULL", "content_json = ?",
            "compliance = ?", "updated_at = ?",
        ]
        values: list[Any] = [
            target,
            spec.key,
            spec.media_type if spec.media_type in {"image", "video"} else "image",
            title,
            desc,
            visibility,
            json.dumps(preserved, ensure_ascii=False),
            json.dumps(
                compliance_issues(f"{title}\n{desc}"), ensure_ascii=False
            ),
            db.now(),
        ]
        if next_images is not None:
            assignments.insert(7, "images = ?")
            values.insert(6, json.dumps(next_images, ensure_ascii=False))
        db.execute(
            f"UPDATE drafts SET {', '.join(assignments)} WHERE id = ?",
            (*values, draft_id),
        )
        logger.info(f"草稿 {draft_id} 已切换平台: {current['platform']} -> {target}")
        return self.get(draft_id)

    def delete(self, draft_id: int) -> bool:
        """删草稿：队列任务、发布记录、配图文件一起清，选题状态按需回滚。"""
        row = db.query_one("SELECT * FROM drafts WHERE id = ?", (draft_id,))
        if row is None:
            return False
        topic_id = row["topic_id"]
        images = db.json_field(row["images"], [])
        with db.transaction() as conn:
            conn.execute("DELETE FROM records WHERE draft_id = ?", (draft_id,))
            conn.execute("DELETE FROM jobs WHERE draft_id = ?", (draft_id,))
            conn.execute("DELETE FROM drafts WHERE id = ?", (draft_id,))
            if topic_id:
                others = conn.execute(
                    "SELECT COUNT(*) FROM drafts WHERE topic_id = ?", (topic_id,)
                ).fetchone()[0]
                if not others:
                    conn.execute(
                        "UPDATE topics SET status='pool', updated_at=? "
                        "WHERE id=? AND status='used'",
                        (db.now(), topic_id),
                    )
        self._remove_files(draft_id, images)
        logger.info(f"草稿 {draft_id} 已删除（含队列、记录与配图）")
        return True

    def delete_many(self, draft_ids: list[int]) -> int:
        ids = sorted({int(item) for item in draft_ids if item})
        if not ids:
            raise ValueError("没有选中要删除的草稿")
        return sum(1 for draft_id in ids if self.delete(draft_id))

    def _remove_files(self, draft_id: int, images: list[Any]) -> None:
        targets: set[Path] = {
            config.ASSETS_DIR / f"draft-{draft_id}",
            config.DESIGN_DIR / f"draft-{draft_id}",
        }
        allowed_roots = (config.UPLOAD_DIR, config.ASSETS_DIR, config.DESIGN_DIR)
        for item in images:
            try:
                path = Path(str(item)).resolve()
            except OSError:
                continue
            if any(root in path.parents for root in allowed_roots):
                targets.add(path)
        for target in targets:
            try:
                if target.is_dir():
                    shutil.rmtree(target)
                elif target.is_file():
                    target.unlink(missing_ok=True)
            except OSError as exc:
                logger.warning(f"删除草稿 {draft_id} 的配图失败 {target}: {exc}")

    def mark_published(self, draft_id: int) -> None:
        db.execute(
            "UPDATE drafts SET status='published', updated_at=? WHERE id=?",
            (db.now(), draft_id),
        )

    def mark_failed(self, draft_id: int) -> None:
        db.execute(
            "UPDATE drafts SET status='failed', updated_at=? WHERE id=?",
            (db.now(), draft_id),
        )

    def payload(self, draft: dict[str, Any]) -> dict[str, Any]:
        media_type = draft.get("media_type") or "image"
        images = list(draft.get("images") or [])
        payload = {
            "title": draft["title"],
            "desc": draft["desc"],
            "body_md": draft.get("body_md") or "",
            "body_html": draft.get("body_html") or "",
            "wx_theme": draft.get("wx_theme") or "",
            "media_type": media_type,
            "images": images,
            "type": int(draft.get("visibility") or 0),
            "topics": list(draft.get("topics") or []),
            "platform": draft.get("platform") or DEFAULT_PLATFORM,
            "content_type": draft.get("content_type") or "image_text",
        }
        if media_type == "video" and images:
            payload["video"] = images[0]
        return payload


__all__ = [
    "DraftService",
    "generate_copy",
    "generate_from_brief",
    "convert_copy",
    "build_system_prompt",
    "build_writenow_prompt",
    "compliance_issues",
    "normalize_title",
    "normalize_desc",
    "normalize_topics",
    "strip_tag_lines",
    "WRITENOW_SYSTEM_TEMPLATE",
    "STYLES",
    "STYLE_GUIDES",
]
