# encoding: utf-8
"""选题挖掘与选题池。

三个来源：
- 关键词：搜索同题笔记，按互动量找结构参考；
- 竞品账号：拉取指定博主已发布笔记，找可复用角度；
- 热榜 / 题库：热榜词与历史题库导入。

评分是可解释的加权和：互动 45%、新鲜度 15%、赛道匹配 20%、新颖度 20%。
同题相似度超过阈值的直接跳过，不重复入池。
"""

from __future__ import annotations

import json
import math
import re
import time
from pathlib import Path
from typing import Any, Iterable

from loguru import logger

from ops import db

COUNT_UNITS = {
    "万": 10_000,
    "w": 10_000,
    "W": 10_000,
    "亿": 100_000_000,
    "k": 1_000,
    "K": 1_000,
    "千": 1_000,
}

WEIGHTS = {"engagement": 0.45, "fresh": 0.15, "fit": 0.2, "novelty": 0.2}
SIMILARITY_THRESHOLD = 0.78

SOURCE_LABELS = {
    "keyword": "关键词",
    "competitor": "竞品",
    "channel": "频道",
    "trending": "热榜",
    "library": "题库",
    "manual": "手动",
}

DIMENSION_META = [
    ("engagement", "互动热度", 45),
    ("fresh", "新鲜度", 15),
    ("fit", "赛道匹配", 20),
    ("novelty", "新颖度", 20),
]

_PUNCT_RE = re.compile(r"[\s\W_]+", re.UNICODE)


def explain_score(detail: dict[str, Any], score: float) -> list[dict[str, Any]]:
    """把 score_detail 翻译成人能看懂的分数构成，points 之和≈总分。"""
    weighted = int(detail.get("weighted_interactions") or 0)
    hits = int(detail.get("focus_hits") or 0)
    similarity = float(detail.get("max_similarity") or 0)
    age_days = detail.get("age_days")
    fresh_value = float(detail.get("fresh") or 0)
    if age_days is None and 0 < fresh_value < 1:
        # 旧数据没有 age_days，用新鲜度反推出大致天数。
        age_days = round(-14.0 * math.log(fresh_value), 1)
    notes = {
        "engagement": (
            f"点赞+收藏×2+评论×3+转发×2 = {weighted:,}" if weighted else "没有互动数据，按 0 计"
        ),
        "fresh": (
            f"发布约 {float(age_days):.0f} 天前" if age_days is not None else "未拿到发布时间，按中间值 50%"
        ),
        "fit": f"命中 {hits} 个关注词" + ("，且带产品" if detail.get("product") else ""),
        "novelty": f"与池内最高相似度 {similarity:.0%}，越不像同题分越高",
    }
    rows = []
    for key, label, weight in DIMENSION_META:
        value = float(detail.get(key) or 0)
        rows.append(
            {
                "key": key,
                "label": label,
                "value": round(value, 4),
                "weight": weight,
                "points": round(100 * weight / 100 * value, 1),
                "note": notes[key],
            }
        )
    rows.append({"key": "total", "label": "合计", "weight": 100, "points": round(score, 1)})
    return rows


def parse_count(value: Any) -> int:
    """把 "1.2万"、"3,405"、"赞" 等统一成整数。"""
    if value is None:
        return 0
    if isinstance(value, (int, float)):
        return int(value)
    text = str(value).strip().replace(",", "").replace("+", "")
    if not text:
        return 0
    match = re.match(r"^(\d+(?:\.\d+)?)\s*([万wW亿kK千]?)$", text)
    if not match:
        digits = re.sub(r"[^\d.]", "", text)
        if not digits:
            return 0
        try:
            return int(float(digits))
        except ValueError:
            return 0
    number = float(match.group(1))
    unit = match.group(2)
    return int(number * COUNT_UNITS.get(unit, 1))


def normalize_text(text: str) -> str:
    return _PUNCT_RE.sub("", (text or "").lower())


def title_similarity(left: str, right: str) -> float:
    """字符二元组相似度：Jaccard 与较短标题包含率的较大值。

    包含率能识别「长标题复述短标题同题」的情况，单纯 Jaccard 会偏低。
    """
    a = normalize_text(left)
    b = normalize_text(right)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    if len(a) < 2 or len(b) < 2:
        return 1.0 if a == b else 0.0
    grams_a = {a[index : index + 2] for index in range(len(a) - 1)}
    grams_b = {b[index : index + 2] for index in range(len(b) - 1)}
    union = grams_a | grams_b
    if not union:
        return 0.0
    intersection = len(grams_a & grams_b)
    jaccard = intersection / len(union)
    containment = intersection / min(len(grams_a), len(grams_b))
    return max(jaccard, containment)


def first_sentence(text: str, limit: int = 62) -> str:
    cleaned = re.sub(r"\s+", " ", (text or "").strip())
    if not cleaned:
        return ""
    parts = re.split(r"[。！？!?\n]", cleaned)
    head = next((part.strip() for part in parts if part.strip()), "")
    if len(head) > limit:
        head = head[:limit].rstrip() + "…"
    return head


def _focus_keywords() -> list[str]:
    raw = db.get_setting("focus_keywords", "")
    return [item.strip() for item in raw.split(",") if item.strip()]


def score_candidate(
    *,
    title: str,
    keyword: str,
    liked: int,
    collected: int,
    comments: int,
    shares: int,
    published_at: int,
    product: bool,
    existing_titles: Iterable[str],
    now: int | None = None,
) -> tuple[float, dict[str, Any]]:
    moment = now or db.now()
    weighted = liked + collected * 2 + comments * 3 + shares * 2
    engagement = min(1.0, math.log10(1 + max(0, weighted)) / 5.0) if weighted else 0.0

    age_days: float | None = None
    if published_at:
        age_days = max(0.0, (moment - published_at) / 86400)
        fresh = math.exp(-age_days / 14.0)
    else:
        fresh = 0.5

    focus = _focus_keywords()
    haystack = f"{title} {keyword}"
    hits = sum(1 for word in focus if word and word in haystack)
    fit = min(1.0, 0.35 + 0.2 * hits + (0.15 if product else 0.0))

    similarities = [title_similarity(title, other) for other in existing_titles]
    max_sim = max(similarities) if similarities else 0.0
    novelty = max(0.0, 1.0 - max_sim)

    score = 100.0 * (
        WEIGHTS["engagement"] * engagement
        + WEIGHTS["fresh"] * fresh
        + WEIGHTS["fit"] * fit
        + WEIGHTS["novelty"] * novelty
    )
    detail = {
        "engagement": round(engagement, 4),
        "fresh": round(fresh, 4),
        "fit": round(fit, 4),
        "novelty": round(novelty, 4),
        "weighted_interactions": weighted,
        "focus_hits": hits,
        "max_similarity": round(max_sim, 4),
        "age_days": round(age_days, 1) if age_days is not None else None,
        "product": bool(product),
    }
    return round(score, 1), detail


def _card_of(item: dict) -> dict:
    card = item.get("note_card")
    return card if isinstance(card, dict) else item


def _interact(card: dict) -> dict:
    value = card.get("interact_info") or card.get("interact") or {}
    return value if isinstance(value, dict) else {}


def _note_id(item: dict) -> str:
    return str(item.get("id") or item.get("note_id") or _card_of(item).get("note_id") or "")


def _note_title(item: dict) -> str:
    card = _card_of(item)
    return str(
        card.get("display_title")
        or card.get("title")
        or item.get("display_title")
        or item.get("title")
        or ""
    ).strip()


def _note_time(card: dict) -> int:
    value = card.get("time") or card.get("create_time") or 0
    try:
        number = int(value)
    except (TypeError, ValueError):
        return 0
    if number > 10_000_000_000:
        number //= 1000
    return number


class TopicMiner:
    """把平台数据转成可评分的选题候选。"""

    def __init__(self) -> None:
        self.last_errors: list[str] = []

    # ------------------------------------------------------------ 候选

    def candidate_from_note(
        self,
        item: dict,
        *,
        source: str,
        keyword: str = "",
        angle: str = "",
        product: bool = False,
    ) -> dict[str, Any] | None:
        title = _note_title(item)
        note_id = _note_id(item)
        if not title or not note_id:
            return None
        card = _card_of(item)
        interact = _interact(card)
        return {
            "source": source,
            "source_ref": note_id,
            "keyword": keyword,
            "title": title,
            "angle": angle,
            "tone": "",
            "product": 1 if product else 0,
            "liked": parse_count(interact.get("liked_count")),
            "collected": parse_count(interact.get("collected_count")),
            "comments": parse_count(interact.get("comment_count")),
            "shares": parse_count(interact.get("share_count")),
            "published_at": _note_time(card),
            "xsec_token": str(item.get("xsec_token") or ""),
            "raw": {"note_id": note_id, "title": title},
        }

    def _enrich(self, api, candidates: list[dict], detail_limit: int) -> None:
        """对互动最高的若干条补正文与真实时间（可选，失败不影响入池）。"""
        if detail_limit <= 0:
            return
        ranked = sorted(
            candidates,
            key=lambda item: item["liked"] + item["collected"] * 2 + item["comments"] * 3,
            reverse=True,
        )[:detail_limit]
        for candidate in ranked:
            token = candidate.get("xsec_token") or ""
            url = (
                f"https://www.xiaohongshu.com/explore/{candidate['source_ref']}"
                f"?xsec_token={token}&xsec_source=pc_search"
            )
            try:
                success, message, payload = api.get_note_info(url)
                if not success:
                    continue
                card = payload["data"]["items"][0]["note_card"]
            except Exception as exc:  # noqa: BLE001
                self.last_errors.append(f"详情 {candidate['source_ref']}: {exc}")
                continue
            desc = str(card.get("desc") or "").strip()
            if desc and not candidate.get("angle"):
                candidate["angle"] = first_sentence(desc)
            interact = card.get("interact_info") or {}
            for key, target in (
                ("liked_count", "liked"),
                ("collected_count", "collected"),
                ("comment_count", "comments"),
                ("share_count", "shares"),
            ):
                value = parse_count(interact.get(key))
                if value:
                    candidate[target] = max(candidate[target], value)
            candidate["published_at"] = _note_time(card) or candidate["published_at"]
            candidate["raw"]["desc"] = desc[:300]
            time.sleep(0.3)

    # ------------------------------------------------------------ 采集

    def mine_keywords(
        self,
        api,
        keywords: list[str],
        *,
        per_kw: int = 20,
        sort_type_choice: int = 0,
        detail_limit: int = 5,
        product: bool = False,
    ) -> dict[str, Any]:
        candidates: list[dict] = []
        seen: set[str] = set()
        for keyword in [item.strip() for item in keywords if item.strip()]:
            try:
                success, message, notes = api.search_some_note(
                    keyword, max(1, per_kw), sort_type_choice=sort_type_choice
                )
            except Exception as exc:  # noqa: BLE001
                self.last_errors.append(f"搜索 {keyword}: {exc}")
                continue
            if not success:
                self.last_errors.append(f"搜索 {keyword}: {message}")
                continue
            for item in notes or []:
                if item.get("model_type") not in (None, "note"):
                    continue
                candidate = self.candidate_from_note(
                    item, source="keyword", keyword=keyword, product=product
                )
                if not candidate or candidate["source_ref"] in seen:
                    continue
                seen.add(candidate["source_ref"])
                candidates.append(candidate)
            time.sleep(0.6)
        self._enrich(api, candidates, detail_limit)
        return self.ingest(candidates)

    def mine_competitor(
        self,
        api,
        user_urls: list[str],
        *,
        limit_per_user: int = 30,
        detail_limit: int = 5,
    ) -> dict[str, Any]:
        candidates: list[dict] = []
        seen: set[str] = set()
        for user_url in [item.strip() for item in user_urls if item.strip()]:
            try:
                success, message, notes = api.get_user_all_notes(user_url)
            except Exception as exc:  # noqa: BLE001
                self.last_errors.append(f"竞品 {user_url}: {exc}")
                continue
            if not success:
                self.last_errors.append(f"竞品 {user_url}: {message}")
                continue
            for item in (notes or [])[: max(1, limit_per_user)]:
                candidate = self.candidate_from_note(
                    item,
                    source="competitor",
                    keyword="",
                    angle="竞品高互动笔记",
                )
                if not candidate or candidate["source_ref"] in seen:
                    continue
                seen.add(candidate["source_ref"])
                candidates.append(candidate)
            time.sleep(0.6)
        self._enrich(api, candidates, detail_limit)
        return self.ingest(candidates)

    def mine_channel(
        self,
        api,
        categories: list[str],
        *,
        limit: int = 20,
        detail_limit: int = 5,
    ) -> dict[str, Any]:
        """频道推荐：按频道拉主页推荐流，找当下正在起量的题。"""
        candidates: list[dict] = []
        seen: set[str] = set()
        for category in [item.strip() for item in categories if item.strip()]:
            try:
                success, message, notes = api.get_homefeed_recommend_by_num(
                    category, max(1, limit)
                )
            except Exception as exc:  # noqa: BLE001
                self.last_errors.append(f"频道 {category}: {exc}")
                continue
            if not success:
                self.last_errors.append(f"频道 {category}: {message}")
                continue
            for item in (notes or [])[:limit]:
                candidate = self.candidate_from_note(
                    item,
                    source="channel",
                    keyword=category,
                    angle="频道推荐里正在起量的题",
                )
                if not candidate or candidate["source_ref"] in seen:
                    continue
                seen.add(candidate["source_ref"])
                candidates.append(candidate)
            time.sleep(0.6)
        self._enrich(api, candidates, detail_limit)
        return self.ingest(candidates)

    def mine_trending(self, api, limit: int = 30) -> dict[str, Any]:
        try:
            payload = api.get_trending_queries()
        except Exception as exc:  # noqa: BLE001
            return {"inserted": 0, "skipped": 0, "error": f"{exc.__class__.__name__}: {exc}"}
        words: list[str] = []
        self._walk_words(payload, words)
        seen: set[str] = set()
        candidates = []
        for word in words:
            word = word.strip()
            if len(word) < 2 or word in seen:
                continue
            seen.add(word)
            if len(candidates) >= limit:
                break
            candidates.append(
                {
                    "source": "trending",
                    "source_ref": word,
                    "keyword": word,
                    "title": f"{word}，普通人怎么接住这个话题",
                    "angle": f"热榜词「{word}」的内容结构参考",
                    "tone": "informative",
                    "product": 0,
                    "liked": 0,
                    "collected": 0,
                    "comments": 0,
                    "shares": 0,
                    "published_at": 0,
                    "raw": {"word": word},
                }
            )
        return self.ingest(candidates)

    @staticmethod
    def _walk_words(node: Any, out: list[str], depth: int = 0) -> None:
        if depth > 6:
            return
        if isinstance(node, dict):
            for key in ("query", "title", "word", "text", "name", "keyword"):
                value = node.get(key)
                if isinstance(value, str) and 1 < len(value) < 40:
                    out.append(value)
            for value in node.values():
                TopicMiner._walk_words(value, out, depth + 1)
        elif isinstance(node, list):
            for item in node:
                TopicMiner._walk_words(item, out, depth + 1)

    def import_library(self, path: str | Path) -> dict[str, Any]:
        source_path = Path(path)
        items = json.loads(source_path.read_text(encoding="utf-8"))
        candidates = []
        for index, item in enumerate(items):
            title = str(item.get("title") or item.get("topic") or "").strip()
            if not title:
                continue
            candidates.append(
                {
                    "source": "library",
                    "source_ref": f"{source_path.name}#{item.get('id', index)}",
                    "keyword": str(item.get("col") or item.get("topic") or ""),
                    "title": title,
                    "angle": str(item.get("angle") or ""),
                    "tone": str(item.get("tone") or ""),
                    "product": 1 if item.get("product") else 0,
                    "liked": 0,
                    "collected": 0,
                    "comments": 0,
                    "shares": 0,
                    "published_at": 0,
                    "raw": item,
                }
            )
        return self.ingest(candidates)

    # ------------------------------------------------------------ 入池

    def ingest(self, candidates: list[dict]) -> dict[str, Any]:
        rows = db.query("SELECT id, title FROM topics ORDER BY id")
        existing = [{"id": int(row["id"]), "title": row["title"]} for row in rows]
        existing_titles = [item["title"] for item in existing]
        inserted: list[dict[str, Any]] = []
        dedupes: list[dict[str, Any]] = []
        skipped = 0
        stamp = db.now()
        for candidate in candidates:
            title = str(candidate.get("title") or "").strip()
            if not title:
                skipped += 1
                continue
            kept, similarity = None, 0.0
            for item in existing:
                value = title_similarity(title, item["title"])
                if value > similarity:
                    kept, similarity = item, value
            if similarity >= SIMILARITY_THRESHOLD and kept is not None:
                skipped += 1
                dedupes.append(
                    {
                        "title": title,
                        "source": str(candidate.get("source") or "manual"),
                        "kept_topic_id": kept["id"],
                        "kept_title": kept["title"],
                        "similarity": round(similarity, 4),
                    }
                )
                continue
            score, detail = score_candidate(
                title=title,
                keyword=str(candidate.get("keyword") or ""),
                liked=int(candidate.get("liked") or 0),
                collected=int(candidate.get("collected") or 0),
                comments=int(candidate.get("comments") or 0),
                shares=int(candidate.get("shares") or 0),
                published_at=int(candidate.get("published_at") or 0),
                product=bool(candidate.get("product")),
                existing_titles=existing_titles,
                now=stamp,
            )
            topic_id = db.execute(
                "INSERT INTO topics(source, source_ref, keyword, category, title, angle, tone, "
                "product, score, score_detail, status, raw, created_at, updated_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?, 'pool', ?, ?, ?)",
                (
                    str(candidate.get("source") or "manual"),
                    str(candidate.get("source_ref") or ""),
                    str(candidate.get("keyword") or ""),
                    str(candidate.get("category") or ""),
                    title,
                    str(candidate.get("angle") or ""),
                    str(candidate.get("tone") or ""),
                    1 if candidate.get("product") else 0,
                    score,
                    json.dumps(detail, ensure_ascii=False),
                    json.dumps(candidate.get("raw") or {}, ensure_ascii=False),
                    stamp,
                    stamp,
                ),
            )
            existing.append({"id": topic_id, "title": title})
            existing_titles.append(title)
            row = db.query_one("SELECT * FROM topics WHERE id = ?", (topic_id,))
            inserted.append(self.serialize(row))
        if dedupes:
            db.execute_many(
                "INSERT INTO topic_dedupes(title, source, kept_topic_id, kept_title, "
                "similarity, created_at) VALUES(?,?,?,?,?,?)",
                [
                    (
                        item["title"],
                        item["source"],
                        item["kept_topic_id"],
                        item["kept_title"],
                        item["similarity"],
                        stamp,
                    )
                    for item in dedupes
                ],
            )
        return {
            "inserted": len(inserted),
            "skipped": skipped,
            "errors": self.last_errors[-10:],
            "items": inserted,
            "dedupes": dedupes[:20],
        }

    def add_manual(
        self,
        title: str,
        *,
        angle: str = "",
        keyword: str = "",
        category: str = "",
        tone: str = "",
        product: bool = False,
    ) -> dict[str, Any]:
        result = self.ingest(
            [
                {
                    "source": "manual",
                    "source_ref": "",
                    "keyword": keyword,
                    "category": category,
                    "title": title,
                    "angle": angle,
                    "tone": tone,
                    "product": product,
                    "liked": 0,
                    "collected": 0,
                    "comments": 0,
                    "shares": 0,
                    "published_at": 0,
                    "raw": {},
                }
            ]
        )
        if result["inserted"]:
            return result["items"][0]
        raise ValueError("选题重复或标题为空，未入池")

    def import_text(self, text: str) -> dict[str, Any]:
        """批量导入：支持 JSON 数组，或每行「标题,角度,关键词,栏目,语气,产品」。"""
        raw_text = (text or "").strip()
        if not raw_text:
            raise ValueError("导入内容为空")
        rows: list[dict[str, Any]] = []
        if raw_text.startswith("["):
            try:
                payload = json.loads(raw_text)
            except ValueError as exc:
                raise ValueError("JSON 解析失败，请检查格式") from exc
            if isinstance(payload, dict):
                payload = payload.get("items") or []
            for item in payload or []:
                if isinstance(item, dict) and str(item.get("title") or "").strip():
                    rows.append(item)
        else:
            for line in raw_text.splitlines():
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                parts = [part.strip() for part in re.split(r"[,，\t]", line)]
                if not parts or not parts[0]:
                    continue
                if parts[0].lower() in {"title", "标题"}:
                    continue
                rows.append(
                    {
                        "title": parts[0],
                        "angle": parts[1] if len(parts) > 1 else "",
                        "keyword": parts[2] if len(parts) > 2 else "",
                        "category": parts[3] if len(parts) > 3 else "",
                        "tone": parts[4] if len(parts) > 4 else "",
                        "product": parts[5] in {"1", "true", "是", "yes"}
                        if len(parts) > 5
                        else False,
                    }
                )
        if not rows:
            raise ValueError("没有解析到可导入的选题")
        return self.ingest(
            [
                {
                    "source": str(item.get("source") or "manual"),
                    "title": str(item.get("title") or ""),
                    "angle": str(item.get("angle") or ""),
                    "keyword": str(item.get("keyword") or ""),
                    "category": str(item.get("category") or ""),
                    "tone": str(item.get("tone") or ""),
                    "product": bool(item.get("product")),
                    "raw": {"imported": True},
                }
                for item in rows
            ]
        )

    def list_dedupes(self, limit: int = 50) -> list[dict[str, Any]]:
        rows = db.query(
            "SELECT * FROM topic_dedupes ORDER BY id DESC LIMIT ?", (max(1, limit),)
        )
        return [
            {
                "id": row["id"],
                "title": row["title"],
                "source": row["source"],
                "source_label": SOURCE_LABELS.get(row["source"], row["source"]),
                "kept_topic_id": row["kept_topic_id"],
                "kept_title": row["kept_title"],
                "similarity": round(float(row["similarity"] or 0), 3),
                "created_at": row["created_at"],
            }
            for row in rows
        ]

    # ------------------------------------------------------------ 查询

    def serialize(self, row) -> dict[str, Any]:
        detail = db.json_field(row["score_detail"], {})
        return {
            "id": row["id"],
            "source": row["source"],
            "source_label": SOURCE_LABELS.get(row["source"], row["source"]),
            "source_ref": row["source_ref"],
            "keyword": row["keyword"],
            "category": row["category"],
            "title": row["title"],
            "angle": row["angle"],
            "tone": row["tone"],
            "product": bool(row["product"]),
            "score": row["score"],
            "score_detail": detail,
            "score_explain": explain_score(detail, float(row["score"] or 0)),
            "heat": int(detail.get("weighted_interactions") or 0),
            "status": row["status"],
            "raw": db.json_field(row["raw"], {}),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def _topic_filters(
        self,
        status: str,
        query: str,
        source: str,
        category: str,
        min_score: float,
    ) -> tuple[str, list[Any]]:
        sql = " WHERE 1 = 1"
        args: list[Any] = []
        if status:
            sql += " AND status = ?"
            args.append(status)
        if query:
            sql += " AND (title LIKE ? OR keyword LIKE ? OR category LIKE ?)"
            args.extend([f"%{query}%", f"%{query}%", f"%{query}%"])
        if source:
            sql += " AND source = ?"
            args.append(source)
        if category:
            sql += " AND category = ?"
            args.append(category)
        if min_score:
            sql += " AND score >= ?"
            args.append(float(min_score))
        return sql, args

    def count_topics(
        self,
        status: str = "",
        query: str = "",
        source: str = "",
        category: str = "",
        min_score: float = 0,
    ) -> int:
        where, args = self._topic_filters(status, query, source, category, min_score)
        return int(db.scalar(f"SELECT COUNT(*) FROM topics{where}", tuple(args), 0))

    def list_topics(
        self,
        status: str = "",
        query: str = "",
        limit: int = 200,
        source: str = "",
        category: str = "",
        min_score: float = 0,
        sort: str = "score",
        offset: int = 0,
    ) -> list[dict[str, Any]]:
        order = {
            "score": "score DESC, id DESC",
            "score_asc": "score ASC, id DESC",
            "newest": "id DESC",
            "heat": "CAST(COALESCE(json_extract(score_detail, '$.weighted_interactions'), 0) "
            "AS INTEGER) DESC, score DESC",
        }.get(sort, "score DESC, id DESC")
        where, args = self._topic_filters(status, query, source, category, min_score)
        sql = f"SELECT * FROM topics{where} ORDER BY {order} LIMIT ? OFFSET ?"
        args.append(max(1, limit))
        args.append(max(0, int(offset)))
        return [self.serialize(row) for row in db.query(sql, tuple(args))]

    def get_topic(self, topic_id: int) -> dict[str, Any]:
        row = db.query_one("SELECT * FROM topics WHERE id = ?", (topic_id,))
        if row is None:
            raise KeyError(f"选题不存在: {topic_id}")
        return self.serialize(row)

    def update_topic(self, topic_id: int, fields: dict[str, Any]) -> dict[str, Any]:
        allowed = {"title", "angle", "tone", "category", "keyword", "product", "status"}
        updates = {key: value for key, value in fields.items() if key in allowed}
        if not updates:
            return self.get_topic(topic_id)
        if "product" in updates:
            updates["product"] = 1 if updates["product"] else 0
        if "status" in updates and updates["status"] not in {
            "pool",
            "used",
            "dropped",
        }:
            raise ValueError("status 只能是 pool / used / dropped")
        updates["updated_at"] = db.now()
        assignments = ", ".join(f"{key} = ?" for key in updates)
        db.execute(
            f"UPDATE topics SET {assignments} WHERE id = ?",
            (*updates.values(), topic_id),
        )
        return self.get_topic(topic_id)

    def delete_topic(self, topic_id: int) -> None:
        self.delete_topics([topic_id])

    def delete_topics(self, topic_ids: list[int]) -> int:
        """批量删除选题；去重记录里指向被删选题的条目一并清掉。"""
        ids = sorted({int(item) for item in topic_ids if item})
        if not ids:
            raise ValueError("没有选中要删除的选题")
        marks = ",".join("?" for _ in ids)
        with db.transaction() as conn:
            conn.execute(f"DELETE FROM topic_dedupes WHERE kept_topic_id IN ({marks})", ids)
            cursor = conn.execute(f"DELETE FROM topics WHERE id IN ({marks})", ids)
            deleted = cursor.rowcount
        logger.info(f"已删除选题 {deleted} 条: {ids[:20]}")
        return int(deleted)


__all__ = [
    "TopicMiner",
    "parse_count",
    "title_similarity",
    "score_candidate",
    "explain_score",
    "first_sentence",
    "WEIGHTS",
    "SIMILARITY_THRESHOLD",
    "SOURCE_LABELS",
]
