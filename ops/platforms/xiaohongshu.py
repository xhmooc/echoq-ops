# encoding: utf-8
"""小红书适配器：第一个完整实现。

登录态、发布、已发布内容回收都复用仓库里已有的 PC / Creator 接口；平台差异
（标题 20 字、正文 1000 字、图文 1-18 张、公开/仅自己可见、话题用 #）在这里
声明清楚，队列与页面只读这些声明。
"""

from __future__ import annotations

import urllib.parse
from typing import Any, TYPE_CHECKING

from loguru import logger

from vendor.apis.xhs_pc_apis import XHS_Apis

from ops.platforms.base import (
    ContentSpec,
    PlatformAdapter,
    PublishOutcome,
    VisibilityOption,
)
from ops.topics import parse_count

if TYPE_CHECKING:  # 只用于类型标注，避免与 accounts 循环导入
    from ops.accounts import AccountManager

PLATFORM_KEY = "xiaohongshu"

IMAGE_SPEC = ContentSpec(
    key="image_text",
    label="图文笔记",
    media_type="image",
    title_max=20,
    desc_max=1000,
    min_images=1,
    max_images=18,
    requires_media=True,
    topics="hashtag",
    notes="1-18 张竖图，标题 20 字以内，正文 1000 字以内；话题用 # 形式。",
)
VIDEO_SPEC = ContentSpec(
    key="video",
    label="视频笔记",
    media_type="video",
    title_max=20,
    desc_max=1000,
    min_images=1,
    max_images=1,
    requires_media=True,
    topics="hashtag",
    notes="1 个视频文件，标题 20 字以内，正文 1000 字以内。",
)


def _pick(payload: Any, *keys: str, default: Any = "") -> Any:
    if not isinstance(payload, dict):
        return default
    for key in keys:
        value = payload.get(key)
        if value not in (None, ""):
            return value
    return default


def _cover_url(item: dict[str, Any]) -> str:
    cover = _pick(item, "cover", "cover_url", "coverUrl", "image", "first_image")
    if isinstance(cover, dict):
        cover = _pick(cover, "url", "url_default", "urlDefault", "origin_url")
    if not cover:
        images = (
            item.get("images_list")
            or item.get("images")
            or item.get("image_list")
            or []
        )
        if isinstance(images, list) and images:
            first = images[0]
            if isinstance(first, dict):
                cover = _pick(first, "url", "url_default", "origin_url")
            else:
                cover = first
    return str(cover or "")


VISIBILITY_TEXT = {
    0: "公开",
    1: "仅自己可见",
    2: "好友可见",
    3: "仅关注者可见",
}


def _friendly_error(message: Any) -> str:
    """平台错误只给中文分类，原文留在日志里。"""
    text = str(message or "").lower()
    if any(word in text for word in ("401", "登录", "login", "guest", "cookie", "会话")):
        return "登录态已失效，请重新登录该账号"
    if any(word in text for word in ("timeout", "超时", "timed out")):
        return "平台响应超时，请稍后重试"
    if any(word in text for word in ("403", "风控", "频繁", "rate")):
        return "平台限制了本次请求，请稍后重试"
    return "拉取作品列表失败，请稍后重试"


def _count_or_none(value: Any) -> int | None:
    """平台没给这个指标时保留 None，不要伪装成 0 阅读。"""
    if value is None:
        return None
    if isinstance(value, str) and not value.strip():
        return None
    return parse_count(value)


def _timestamp(value: Any) -> int:
    if value in (None, "", 0):
        return 0
    if isinstance(value, (int, float)):
        number = int(value)
        return number // 1000 if number > 10_000_000_000 else number
    text = str(value).strip()
    if text.isdigit():
        return _timestamp(int(text))
    try:
        from ops.publisher import parse_when

        return parse_when(text)
    except (ValueError, TypeError):
        return 0


def normalize_note(item: dict[str, Any]) -> dict[str, Any]:
    """把创作平台的笔记对象归一化成页面/缓存能直接用的结构。

    不同接口字段名不完全一致（PC / Creator / 新旧版本），这里按优先级取，
    取不到的字段留空，页面显示「平台未返回」。
    """
    stats = item.get("interact_info") or item.get("interactInfo") or {}
    note_id = str(_pick(item, "note_id", "noteId", "id") or "")
    title = str(_pick(item, "title", "display_title", "displayTitle") or "").strip()
    desc = str(_pick(item, "desc", "description", "content") or "").strip()
    note_type = str(_pick(item, "type", "note_type", "noteType") or "normal")
    views = _pick(
        item, "view_count", "views", "read_count", "readCount", "viewCount", default=None
    )
    likes = _pick(item, "liked_count", "likes", "like_count", "likeCount", default=None)
    if likes is None:
        likes = _pick(stats, "liked_count", "likedCount", default=None)
    collects = _pick(
        item, "collected_count", "collects", "collectedCount", default=None
    )
    if collects is None:
        collects = _pick(stats, "collected_count", "collectedCount", default=None)
    comments = _pick(
        item, "comments_count", "comment_count", "comments", "commentCount", default=None
    )
    if comments is None:
        comments = _pick(stats, "comment_count", "commentCount", default=None)
    visibility = _pick(item, "visibility", "permission", "permission_text", "status_text")
    if visibility in (None, ""):
        try:
            visibility = VISIBILITY_TEXT.get(int(item.get("permission_code")))
        except (TypeError, ValueError):
            visibility = ""
    if isinstance(visibility, int):
        visibility = VISIBILITY_TEXT.get(visibility, "")
    published_at = _timestamp(
        _pick(
            item,
            "visible_time",
            "post_time",
            "publish_time",
            "create_time",
            "time",
            "published_at",
        )
    )
    url = str(_pick(item, "note_url", "url", "link") or "")
    if not url and note_id:
        token = str(_pick(item, "xsec_token") or "")
        source = str(_pick(item, "xsec_source") or "")
        suffix = ""
        if token:
            suffix = f"?xsec_token={token}" + (f"&xsec_source={source}" if source else "")
        url = f"https://www.xiaohongshu.com/explore/{note_id}{suffix}"
    return {
        "remote_note_id": note_id,
        "title": title,
        "desc": desc,
        "cover": _cover_url(item),
        "note_type": "video" if note_type in {"video", "视频"} else "image",
        "visibility": str(visibility or ""),
        "views": _count_or_none(views),
        "likes": _count_or_none(likes),
        "collects": _count_or_none(collects),
        "comments": _count_or_none(comments),
        "published_at": published_at,
        "url": url,
        "raw": item,
    }


def normalize_comment(item: dict[str, Any], parent_comment_id: str = "") -> dict[str, Any]:
    """把评论对象归一化成只读缓存字段；缺失字段留空，不猜。"""
    user = item.get("user_info") or item.get("user") or {}
    if not isinstance(user, dict):
        user = {}
    comment_id = str(_pick(item, "id", "comment_id", "commentId") or "")
    likes = _pick(item, "like_count", "likes", "likeCount", default=None)
    return {
        "remote_comment_id": comment_id,
        "author": str(
            _pick(user, "nickname", "nick_name", "name") or _pick(item, "nickname") or ""
        ),
        "author_id": str(_pick(user, "user_id", "userId") or ""),
        "content": str(_pick(item, "content", "text") or ""),
        "likes": _count_or_none(likes),
        "commented_at": _timestamp(
            _pick(item, "create_time", "created_at", "time", "comment_time")
        ),
        "is_reply": bool(parent_comment_id),
        "parent_comment_id": parent_comment_id,
    }


class XiaohongshuAdapter(PlatformAdapter):
    key = PLATFORM_KEY
    name = "小红书"
    short = "小红书"
    status = "ready"
    color = "#ff2442"
    login_hint = "粘贴浏览器里的完整 Cookie，或用小红书 App 扫码"
    docs = "小红书创作服务平台"
    topic_style = "hashtag"
    default_content_type = "image_text"
    content_types = (IMAGE_SPEC, VIDEO_SPEC)
    visibility_options = (
        VisibilityOption(0, "公开", "所有用户可见"),
        VisibilityOption(1, "仅自己可见", "用于演练，不打扰读者"),
    )
    default_daily_limit = 3
    default_min_interval_sec = 2700
    features = {
        "login_cookie": True,
        "login_qr": True,
        "publish": True,
        "fetch_published": True,
        "fetch_comments": True,
        "schedule": True,
    }
    comments_mode = "read"
    data_sources = (
        "阅读（小眼睛）、点赞、评论、收藏：发布后从创作平台作品列表同步。",
        "可见范围：平台作品列表返回的权限字段；本地发布记录作为兜底。",
        "原帖链接：由远端笔记 ID 拼接，可直接跳转。",
    )

    def __init__(self, accounts: "AccountManager") -> None:
        self.accounts = accounts

    # ------------------------------------------------------------ 登录态

    def check_session(self, account: Any) -> dict[str, Any]:
        account_id = int(account["id"])
        try:
            with self.accounts.session(account_id, lane="sync", wait=30) as auth:
                api = XHS_Apis(auth).bootstrap()
                success, message, payload = api.get_user_me()
                data = (payload or {}).get("data") if isinstance(payload, dict) else None
                info = data if isinstance(data, dict) else {}
                if not success or info.get("guest"):
                    return {
                        "ok": False,
                        "message": str(message or "登录态已失效"),
                    }
                return {
                    "ok": True,
                    "message": "登录态正常",
                    "nickname": str(info.get("nickname") or account["nickname"]),
                    "red_id": str(info.get("red_id") or account["red_id"]),
                    "user_id": str(info.get("user_id") or account["user_id"]),
                }
        except TimeoutError:
            return {"ok": False, "message": "账号正被其他任务占用，请稍后再试"}
        except Exception:  # noqa: BLE001
            logger.exception(f"账号 {account_id} 登录态检查异常")
            return {"ok": False, "message": "登录态检查失败，请稍后重试"}

    # ------------------------------------------------------------ 发布

    def publish(self, account: Any, payload: dict[str, Any]) -> PublishOutcome:
        account_id = int(account["id"])
        try:
            with self.accounts.session(account_id) as auth:
                api = self.accounts.creator_api(auth)
                success, message, result = api.post_note(payload)
                if not success and payload.get("topics"):
                    logger.info(f"账号 {account_id} 带话题发布失败，去掉话题重试一次")
                    retry_payload = {key: value for key, value in payload.items() if key != "topics"}
                    success, message, result = api.post_note(retry_payload)
        except Exception:  # noqa: BLE001
            logger.exception(f"账号 {account_id} 发布异常")
            return PublishOutcome(False, "发布请求异常，请稍后重试（详见日志）", {})
        return PublishOutcome(bool(success), str(message or ("发布成功" if success else "发布失败")), result)

    # ------------------------------------------------------------ 内容回收

    def note_url(self, remote_note_id: str) -> str:
        value = str(remote_note_id or "").strip()
        return f"https://www.xiaohongshu.com/explore/{value}" if value else ""

    def fetch_published(
        self, account: Any, *, cursor: Any = 0, limit: int = 30
    ) -> dict[str, Any]:
        """拉取一页已发布作品。

        返回 ``items``、``next_cursor``（None 表示到底）与原样 ``raw``，由上层
        负责落库；单页失败不抛异常，交给调用方显示提示。
        """
        try:
            page = int(cursor or 0)
        except (TypeError, ValueError):
            page = 0
        account_id = int(account["id"])
        try:
            with self.accounts.session(account_id, lane="sync", wait=0) as auth:
                api = self.accounts.creator_api(auth)
                success, message, payload = api.get_posted_notes_page(page=page)
        except TimeoutError:
            return {
                "ok": False,
                "message": "账号正被发布任务占用，稍后自动重试",
                "items": [],
                "next_cursor": None,
            }
        except Exception:  # noqa: BLE001
            # 原始异常只进日志：里面可能带内部 URL / 库名，不写回接口和账号状态。
            logger.exception(f"账号 {account_id} 拉取已发布内容失败")
            return {
                "ok": False,
                "message": "拉取作品列表失败，请稍后重试",
                "items": [],
                "next_cursor": None,
            }
        if not success:
            return {
                "ok": False,
                "message": _friendly_error(message),
                "items": [],
                "next_cursor": None,
            }
        data = (payload or {}).get("data") if isinstance(payload, dict) else None
        data = data if isinstance(data, dict) else {}
        notes = data.get("notes") or []
        items = [normalize_note(item) for item in notes if isinstance(item, dict)]
        next_page = data.get("page", -1)
        try:
            next_page = int(next_page)
        except (TypeError, ValueError):
            next_page = -1
        return {
            "ok": True,
            "message": str(message or "成功"),
            "items": items[: max(1, limit)],
            "next_cursor": None if next_page == -1 else next_page,
        }

    # ------------------------------------------------------------ 评论（只读）

    def fetch_comments(
        self, account: Any, note: Any, *, pages: int = 3
    ) -> dict[str, Any]:
        """按页读取一级评论与其二级回复；不回复、不点赞、不删除。"""
        account_id = int(account["id"])
        remote_id = str(note["remote_note_id"] or "")
        url = str(note["url"] or "") or self.note_url(remote_id)
        parsed = urllib.parse.urlparse(url)
        note_id = parsed.path.rstrip("/").split("/")[-1] or remote_id
        token = urllib.parse.parse_qs(parsed.query).get("xsec_token", [""])[0]
        items: list[dict[str, Any]] = []
        try:
            with self.accounts.session(account_id, lane="sync", wait=10) as auth:
                api = XHS_Apis(auth).bootstrap()
                cursor = ""
                for _ in range(max(1, min(10, int(pages or 3)))):
                    success, message, payload = api.get_note_out_comment(
                        note_id, cursor, token
                    )
                    if not success:
                        logger.info(f"账号 {account_id} 读取评论失败: {message}")
                        return {
                            "ok": False,
                            "message": "评论读取失败，请稍后重试",
                            "items": items,
                        }
                    data = (payload or {}).get("data") or {}
                    comments = data.get("comments") or []
                    for raw in comments:
                        if not isinstance(raw, dict):
                            continue
                        parent = normalize_comment(raw)
                        if parent["remote_comment_id"]:
                            items.append(parent)
                            for sub in raw.get("sub_comments") or []:
                                if isinstance(sub, dict):
                                    items.append(
                                        normalize_comment(
                                            sub,
                                            parent_comment_id=parent["remote_comment_id"],
                                        )
                                    )
                    if not comments or not data.get("has_more"):
                        break
                    next_cursor = str(data.get("cursor") or "")
                    if not next_cursor or next_cursor == cursor:
                        break
                    cursor = next_cursor
        except TimeoutError:
            return {
                "ok": False,
                "message": "账号正被其他任务占用，请稍后再试",
                "items": [],
            }
        except Exception:  # noqa: BLE001
            logger.exception(f"账号 {account_id} 读取评论异常")
            return {
                "ok": False,
                "message": "评论读取失败，请稍后重试",
                "items": [],
            }
        return {"ok": True, "message": "成功", "items": items}


__all__ = ["XiaohongshuAdapter", "normalize_note", "PLATFORM_KEY"]
