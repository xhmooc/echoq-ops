# encoding: utf-8
"""抖音创作者中心适配器。

登录、发布、作品回收都走真实浏览器（Playwright + 本机 Edge/Chrome），原因是
抖音创作者中心没有公开的发布 API，且上传链路的签名参数会随前端版本变化。
页面选择器参考并收敛自 ``dreammis/social-auto-upload``（见 docs/DOUYIN_WECHAT.md）：

- 扫码登录：creator.douyin.com 首页二维码，登录完成后保存完整 storage_state；
- 发布：内容上传页写入视频/图片文件，填写文案，点击「发布」；
- 回收：优先在页面上下文请求创作者作品列表接口，失败时退回页面 DOM 提取。

平台规则按创作者中心当前限制校验：视频 ≤ 4GB / ≤ 15 分钟，文案 ≤ 1000 字，
图文 2-35 张；任何一条不满足都会在发布前拦下并给出中文原因。
"""

from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Any, TYPE_CHECKING

from loguru import logger

from ops import config
from ops.platforms import errors
from ops.platforms.base import (
    ContentSpec,
    PlatformAdapter,
    PublishOutcome,
    VisibilityOption,
)
from ops.platforms.browser import (
    BrowserUnavailable,
    BrowserWorker,
    browser_diagnostics,
    browser_session,
    cookies_of,
    extract_qr_png,
    first_visible,
    goto,
    qr_headless,
    storage_state,
    text_of,
    wait_for_qr,
)
from ops.platforms.errors import PlatformFailure
from ops.topics import parse_count

if TYPE_CHECKING:  # pragma: no cover
    from ops.accounts import AccountManager

PLATFORM_KEY = "douyin"
CREATOR_HOME = "https://creator.douyin.com/"
CREATOR_UPLOAD = "https://creator.douyin.com/creator-micro/content/upload"
CREATOR_MANAGE = "https://creator.douyin.com/creator-micro/content/manage"
VIDEO_MAX_BYTES = 4 * 1024 * 1024 * 1024
IMAGE_MAX_BYTES = 20 * 1024 * 1024
VIDEO_SUFFIXES = {".mp4", ".mov", ".webm", ".avi", ".mkv", ".flv", ".wmv", ".m4v"}
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}

VIDEO_SPEC = ContentSpec(
    key="video",
    label="抖音视频",
    media_type="video",
    title_max=55,
    desc_max=1000,
    min_images=1,
    max_images=1,
    requires_media=True,
    topics="hashtag",
    notes="1 个视频（≤4GB、≤15 分钟），文案（含标题）≤1000 字，标题建议 ≤55 字。",
)
IMAGE_SPEC = ContentSpec(
    key="image_text",
    label="抖音图文",
    media_type="image",
    title_max=55,
    desc_max=1000,
    min_images=2,
    max_images=35,
    requires_media=True,
    topics="hashtag",
    notes="2-35 张图片，文案（含标题）≤1000 字。",
)

VISIBILITY_LABELS = {0: "公开", 1: "仅自己可见", 2: "好友可见"}

_QR_IMG_SELECTORS = [
    'div#animate_qrcode_container img[src^="data:image"]',
    'div[class*="animate_qrcode_container"] img[src^="data:image"]',
    'div[class*="scan_qrcode_login_content"] img[src^="data:image"]',
    'img[aria-label="二维码"]',
]
_QR_CONTAINER_SELECTORS = [
    "div#animate_qrcode_container",
    'div[class*="animate_qrcode_container"]',
    'div[class*="scan_qrcode_login_content"]',
    'div[class*="qrcode"]',
]
_LOGIN_TEXTS = ("扫码登录", "手机号登录", "二维码失效")

# 创作者中心作品列表的候选接口；不同版本路径不同，按顺序探测。
_LIST_APIS = (
    "https://creator.douyin.com/web/api/media/aweme/post/?status=0&count={count}&cursor={cursor}&aid=2906",
    "https://creator.douyin.com/web/api/media/aweme/list/?status=0&count={count}&cursor={cursor}&aid=2906",
    "https://creator.douyin.com/web/api/creator/item/list/?status=0&count={count}&cursor={cursor}&aid=2906",
)

_USER_INFO_JS = """
async () => {
  const urls = [
    'https://creator.douyin.com/web/api/media/user/info/?aid=2906',
    'https://creator.douyin.com/web/api/media/user/info/'
  ];
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        credentials: 'include',
        headers: {accept: 'application/json'}
      });
      if (!response.ok) continue;
      const data = await response.json();
      if (data) return data;
    } catch (err) { /* 继续尝试下一个地址 */ }
  }
  return null;
}
"""


def _pick(payload: Any, *keys: str, default: Any = None) -> Any:
    if not isinstance(payload, dict):
        return default
    for key in keys:
        value = payload.get(key)
        if value not in (None, ""):
            return value
    return default


def _first_url(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        urls = value.get("url_list") or value.get("urlList") or []
        if isinstance(urls, list) and urls:
            return str(urls[0] or "")
        return str(value.get("url") or value.get("uri") or "")
    if isinstance(value, list) and value:
        return _first_url(value[0])
    return ""


def _count_or_none(value: Any) -> int | None:
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    try:
        return parse_count(value)
    except (TypeError, ValueError):
        return None


def _timestamp(value: Any) -> int:
    if value in (None, "", 0):
        return 0
    if isinstance(value, (int, float)):
        number = int(value)
        return number // 1000 if number > 10_000_000_000 else number
    text = str(value).strip()
    if text.isdigit():
        return _timestamp(int(text))
    return 0


def _find_aweme_id(payload: Any, depth: int = 0) -> str:
    if depth > 6 or payload is None:
        return ""
    if isinstance(payload, dict):
        for key in ("aweme_id", "awemeId", "item_id", "itemId"):
            value = str(payload.get(key) or "")
            if value.isdigit():
                return value
        for value in payload.values():
            found = _find_aweme_id(value, depth + 1)
            if found:
                return found
    elif isinstance(payload, list):
        for item in payload:
            found = _find_aweme_id(item, depth + 1)
            if found:
                return found
    return ""


def _caption(payload: dict[str, Any]) -> str:
    title = str(payload.get("title") or "").strip()
    desc = str(payload.get("desc") or "").strip()
    return f"{title}\n{desc}".strip() if title and desc else (title or desc)


def _video_duration(path: Path) -> float:
    """尽量读出视频时长；读不到时返回 0，交给平台侧兜底。"""
    try:
        import cv2  # 已随 requirements 安装，延迟导入避免拖慢启动

        capture = cv2.VideoCapture(str(path))
        try:
            if not capture.isOpened():
                return 0.0
            fps = float(capture.get(cv2.CAP_PROP_FPS) or 0)
            frames = float(capture.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
            return frames / fps if fps > 0 and frames > 0 else 0.0
        finally:
            capture.release()
    except Exception:  # noqa: BLE001
        return 0.0


def normalize_item(item: dict[str, Any]) -> dict[str, Any]:
    """把创作者中心的作品对象归一化成 published_notes 需要的字段。"""
    aweme_id = str(
        _pick(item, "aweme_id", "awemeId", "item_id", "itemId", "id") or ""
    )
    stats = _pick(item, "statistics", "stats", "metrics", default={}) or {}
    play = _pick(
        item, "play_count", "playCount", "view_count", "viewCount", default=None
    )
    if play is None:
        play = _pick(stats, "play_count", "playCount", default=None)
    likes = _pick(item, "digg_count", "like_count", "likeCount", default=None)
    if likes is None:
        likes = _pick(stats, "digg_count", "diggCount", default=None)
    comments = _pick(item, "comment_count", "commentCount", default=None)
    if comments is None:
        comments = _pick(stats, "comment_count", "commentCount", default=None)
    collects = _pick(item, "collect_count", "collectCount", default=None)
    if collects is None:
        collects = _pick(stats, "collect_count", "collectCount", default=None)

    images = _pick(item, "images", "image_list", "imageList", default=[]) or []
    video = _pick(item, "video", default={}) or {}
    cover = _pick(item, "cover", "cover_url", "coverUrl", default=None)
    if cover is None and isinstance(video, dict):
        cover = video.get("cover") or video.get("origin_cover") or video.get("dynamic_cover")
    if cover is None and isinstance(images, list) and images:
        cover = images[0]
    note_type = "image" if isinstance(images, list) and images else "video"

    desc = str(_pick(item, "desc", "caption", "title", default="") or "").strip()
    title = str(_pick(item, "title", default="") or "").strip()
    if not title:
        title = desc.splitlines()[0][:55] if desc else ""
    private = _pick(item, "is_private", "private_status", default=None)
    visibility = "仅自己可见" if private in (1, True, "1") else ""
    if not visibility:
        permission = _pick(item, "visibility", "permission", default="")
        visibility = str(permission or "")
    return {
        "remote_note_id": aweme_id,
        "title": title,
        "desc": desc,
        "cover": _first_url(cover),
        "note_type": note_type,
        "visibility": visibility,
        "views": _count_or_none(play),
        "likes": _count_or_none(likes),
        "comments": _count_or_none(comments),
        "collects": _count_or_none(collects),
        "published_at": _timestamp(
            _pick(item, "create_time", "createTime", "publish_time", "published_at")
        ),
        "url": f"https://www.douyin.com/{'note' if note_type == 'image' else 'video'}/{aweme_id}"
        if aweme_id
        else "",
        "raw": item,
    }


def _prune_evidence(keep: int = 200) -> None:
    """证据文件只保留最近一批，避免截图无限堆积。"""
    try:
        files = sorted(
            (path for path in config.EVIDENCE_DIR.glob("*") if path.is_file()),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
        for path in files[keep:]:
            path.unlink(missing_ok=True)
    except OSError:
        pass


def _capture_evidence(page, account: Any, payload: dict[str, Any]) -> dict[str, Any]:
    """发布失败时保存截图与 DOM，供诊断抽屉回看现场。"""
    evidence: dict[str, Any] = {}
    try:
        config.ensure_dirs()
        stamp = int(time.time() * 1000)
        job_id = str(payload.get("_job_id") or "manual")
        prefix = f"acct{int(account['id'])}-job{job_id}-{stamp}"
        try:
            path = config.EVIDENCE_DIR / f"{prefix}.png"
            page.screenshot(path=str(path), full_page=False, timeout=15_000)
            evidence["screenshot"] = path.name
        except Exception:  # noqa: BLE001
            logger.warning(f"抖音账号 {account['id']} 发布失败截图保存失败")
        try:
            html = page.content() or ""
            if html:
                path = config.EVIDENCE_DIR / f"{prefix}.html"
                path.write_text(html[:2_000_000], encoding="utf-8")
                evidence["dom"] = path.name
        except Exception:  # noqa: BLE001
            logger.warning(f"抖音账号 {account['id']} 发布失败 DOM 保存失败")
        if evidence:
            evidence["captured_at"] = int(time.time())
    except Exception:  # noqa: BLE001
        logger.exception(f"抖音账号 {account['id']} 保存发布失败现场异常")
        return {}
    _prune_evidence()
    return evidence


class DouyinQrSession:
    """抖音扫码会话：常驻浏览器线程 + 二维码原图。"""

    TTL = 300
    platform = PLATFORM_KEY

    def __init__(self, proxy: str = "", headless: bool | None = None) -> None:
        self.proxy = proxy
        self.created_at = time.time()
        self.status = "starting"
        self.message = "正在打开抖音创作者中心"
        self.nickname = ""
        self.user_id = ""
        self.platform_id = ""
        self.account_state: dict[str, Any] = {}
        self.qr_png = b""
        self._headless = qr_headless() if headless is None else bool(headless)
        self._visible = not self._headless
        self._window_used = self._visible
        self._needs_action_until = time.time() + 120 if self._visible else 0.0
        self._notice = ""
        self._closed = False
        self._lock = threading.Lock()
        self.diagnostics: dict[str, Any] = {}
        try:
            self._worker = BrowserWorker(headless=self._headless, proxy=proxy)
            self.qr_png = self._worker.call(self._open, timeout=120)
            self.diagnostics = browser_diagnostics()
            self.status = "waiting"
            self.message = "请用抖音 App 扫码登录"
        except Exception:
            try:
                if getattr(self, "_worker", None) is not None:
                    self._worker.close()
            except Exception:  # noqa: BLE001
                pass
            raise

    # ------------------------------------------------------------ 浏览器线程

    def _open(self, context) -> bytes:
        page = context.new_page()
        goto(page, CREATOR_HOME, timeout=60_000)
        tab = first_visible(page, ["text=扫码登录", 'div:has-text("扫码登录")'])
        if tab is not None:
            try:
                tab.click(timeout=5_000)
            except Exception:  # noqa: BLE001
                pass
        if not wait_for_qr(page, _QR_IMG_SELECTORS, timeout=30):
            raise PlatformFailure(
                errors.PLATFORM,
                "抖音登录页没有出现二维码，平台可能要求安全验证或页面已改版",
                detail=page.url,
            )
        return extract_qr_png(
            page, img_selectors=_QR_IMG_SELECTORS, container_selectors=_QR_CONTAINER_SELECTORS
        )

    def _is_logged_in(self, page) -> bool:
        try:
            for text in _LOGIN_TEXTS:
                locator = page.get_by_text(text, exact=True).first
                if locator.count() and locator.is_visible():
                    return False
            cookies = cookies_of_page(page)
            names = {str(item.get("name") or "") for item in cookies}
            if names & {"sessionid", "sessionid_ss", "sid_guard", "uid_tt"}:
                return True
            return "creator.douyin.com/creator-micro" in page.url
        except Exception:  # noqa: BLE001
            return False

    def _poll_browser(self, context) -> dict[str, Any]:
        page = context.pages[0] if context.pages else context.new_page()
        if self._is_logged_in(page):
            if "creator-micro" not in page.url:
                try:
                    goto(page, "https://creator.douyin.com/creator-micro/home", timeout=45_000)
                    time.sleep(1.2)
                except Exception:  # noqa: BLE001
                    pass
            self.account_state = storage_state(context)
            nickname, user_id, platform_id = _read_user_info(page)
            self.nickname = nickname
            self.user_id = user_id
            self.platform_id = platform_id
            self.status = "confirmed"
            self.message = f"登录成功：{nickname or '抖音账号'}"
            return self.payload()
        expired = first_visible(page, ["text=二维码失效", 'text=二维码已失效'])
        if expired is not None:
            self.status = "expired"
            self.message = "二维码已失效，请重新生成"
            return self.payload()
        for marker in ("安全验证", "短信验证", "身份验证", "请完成验证"):
            if first_visible(page, [f"text={marker}"]) is None:
                continue
            if not self._visible:
                # 无头下绝不自动弹窗：只给出提示，等用户点「打开验证窗口」。
                self.status = "needs_action"
                self.message = (
                    f"抖音要求完成{marker}，需要人工操作。"
                    "点击「打开验证窗口」后会弹出一个浏览器窗口，完成验证后自动关闭"
                )
                self._notice = self.message
                self._needs_action_until = 0.0
                return self.payload()
            remaining = int(max(0, self._needs_action_until - time.time()))
            if remaining <= 0:
                self.status = "error"
                self.message = f"验证窗口等待超时，请重新扫码"
                return self.payload()
            self.status = "needs_action"
            self.message = f"请在验证窗口中完成{marker}（剩余 {remaining} 秒）"
            self._notice = self.message
            return self.payload()
        scanned = first_visible(page, ["text=扫描成功", 'text=请在手机上确认'])
        self.status = "scanned" if scanned is not None else "waiting"
        self.message = "已扫码，请在手机上确认" if scanned is not None else "请用抖音 App 扫码登录"
        return self.payload()

    # ------------------------------------------------------------ 对外

    def open_window(self) -> dict[str, Any]:
        """用户明确点击「打开验证窗口」后，才启动可见浏览器完成安全验证。"""
        with self._lock:
            if self._closed:
                raise ValueError("扫码会话已结束，请重新发起扫码")
            if self._visible:
                return self.payload()
            if self.status != "needs_action":
                raise ValueError("当前步骤不需要人工验证窗口")
            try:
                state = self._worker.call(storage_state, timeout=30)
            except Exception:  # noqa: BLE001
                state = {}
            self._worker.close()
            self._worker = BrowserWorker(
                storage_state=state, headless=False, proxy=self.proxy
            )
            self._visible = True
            self._window_used = True
            self._worker.call(self._open_visible, timeout=120)
            self.diagnostics = browser_diagnostics()
            self._needs_action_until = time.time() + 120
            self.status = "needs_action"
            self.message = "验证窗口已打开，请在 120 秒内完成抖音安全验证；完成后窗口会自动关闭"
            self._notice = self.message
            return self.payload()

    def _open_visible(self, context) -> str:
        page = context.pages[0] if context.pages else context.new_page()
        goto(page, CREATOR_HOME, timeout=60_000)
        time.sleep(1.5)
        return page.url

    def poll(self) -> dict[str, Any]:
        with self._lock:
            if self.status in {"confirmed", "expired", "error"}:
                self._close_browser()
                return self.payload()
            if time.time() - self.created_at > self.TTL:
                self.status = "expired"
                self.message = "二维码已过期，请重新生成"
                self._close_browser()
                return self.payload()
            try:
                payload = self._worker.call(self._poll_browser, timeout=45)
            except Exception as exc:  # noqa: BLE001
                self.status = "error"
                self.message = f"登录状态检查失败：{exc.__class__.__name__}"
                self._close_browser()
                return self.payload()
            if payload.get("status") in {"confirmed", "expired", "error"}:
                self._close_browser()
            return payload

    def _close_browser(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._worker.close()
        except Exception:  # noqa: BLE001
            pass

    def payload(self) -> dict[str, Any]:
        needs_window = self.status == "needs_action" and not self._visible
        window_open = self.status == "needs_action" and self._visible
        return {
            "platform": PLATFORM_KEY,
            "status": self.status,
            "message": self.message,
            "nickname": self.nickname,
            "red_id": self.platform_id,
            "requires_window": needs_window,
            "window_open": window_open,
            "notice": self._notice,
            "deadline": int(self._needs_action_until) if window_open else 0,
            # 自证字段：当前会话是否无头、有没有创建过可见窗口、浏览器进程命令行。
            "mode": "visible" if self._visible else "headless",
            "headless": self._headless,
            "visible_window_used": self._window_used,
            "browser": self.diagnostics,
        }

    def account_payload(self) -> dict[str, Any]:
        state = self.account_state or {}
        return {
            "storage_state": state,
            "cookies": state.get("cookies") or [],
            "nickname": self.nickname,
            "platform_id": self.platform_id,
            "user_id": self.user_id or self.platform_id,
            "login_at": int(time.time()),
        }

    def close(self) -> None:
        self._close_browser()


def cookies_of_page(page) -> list[dict[str, Any]]:
    try:
        return list(page.context.cookies() or [])
    except Exception:  # noqa: BLE001
        return []


def _read_user_info(page) -> tuple[str, str, str]:
    try:
        payload = page.evaluate(_USER_INFO_JS)
    except Exception:  # noqa: BLE001
        return "", "", ""
    data = payload.get("data") if isinstance(payload, dict) else {}
    user = (data or {}).get("user") if isinstance(data, dict) else {}
    user = user if isinstance(user, dict) else (data if isinstance(data, dict) else {})
    nickname = str(
        user.get("nickname") or user.get("name") or payload.get("nickname") or ""
    ).strip()
    platform_id = str(
        user.get("unique_id") or user.get("uniqueId") or user.get("short_id") or ""
    ).strip()
    user_id = str(user.get("sec_uid") or user.get("secUid") or user.get("uid") or "").strip()
    return nickname, user_id, platform_id


class DouyinAdapter(PlatformAdapter):
    key = PLATFORM_KEY
    name = "抖音"
    short = "抖音"
    status = "ready"
    color = "#161823"
    login_hint = "用抖音 App 扫描创作者中心二维码登录"
    docs = "抖音创作者中心 · 作品发布"
    topic_style = "hashtag"
    default_content_type = "video"
    content_types = (VIDEO_SPEC, IMAGE_SPEC)
    visibility_options = (
        VisibilityOption(0, "公开", "所有人可见"),
        VisibilityOption(1, "仅自己可见", "先发给自己检查"),
        VisibilityOption(2, "好友可见", "仅互关好友可见"),
    )
    default_daily_limit = 3
    default_min_interval_sec = 1800
    features = {
        "login_cookie": False,
        "login_qr": True,
        "publish": True,
        "fetch_published": True,
        "schedule": True,
    }
    data_sources = (
        "播放量、点赞、评论、收藏：创作者中心作品列表接口，失败时回退页面可见数据。",
        "平台未返回的指标留空，不写 0。",
    )

    def __init__(self, accounts: "AccountManager | None" = None) -> None:
        self.accounts = accounts

    # ------------------------------------------------------------ 规格

    def validate(self, payload: dict[str, Any], content_type: str = "") -> list[str]:
        problems = super().validate(payload, content_type)
        title = str(payload.get("title") or "").strip()
        desc = str(payload.get("desc") or "").strip()
        caption = _caption(payload)
        if len(caption) > 1000:
            problems.append(f"抖音文案（标题+正文）最多 1000 字，当前 {len(caption)} 字")
        if len(title) > 55:
            problems.append(f"抖音标题最多 55 字，当前 {len(title)} 字")
        media_type = str(payload.get("media_type") or "")
        files = [str(path) for path in payload.get("images") or []]
        is_video = media_type == "video" or content_type == "video"
        if is_video:
            video = str(payload.get("video") or (files[0] if files else ""))
            if not video:
                problems.append("抖音视频发布需要 1 个视频文件")
            else:
                path = Path(video)
                if path.suffix.lower() not in VIDEO_SUFFIXES:
                    problems.append(f"抖音不支持该视频格式：{path.suffix or '未知'}")
                elif path.is_file() and path.stat().st_size > VIDEO_MAX_BYTES:
                    problems.append("抖音视频不能超过 4GB")
                elif path.is_file():
                    duration = _video_duration(path)
                    if duration and duration > 15 * 60 + 5:
                        problems.append("抖音视频不能超过 15 分钟")
        else:
            for item in files[:35]:
                path = Path(item)
                if path.suffix.lower() not in IMAGE_SUFFIXES:
                    problems.append(f"抖音不支持该图片格式：{path.suffix or '未知'}")
                    break
                if path.is_file() and path.stat().st_size > IMAGE_MAX_BYTES:
                    problems.append("抖音单张图片不能超过 20MB")
                    break
        visibility = payload.get("type")
        try:
            if visibility is not None and int(visibility) not in VISIBILITY_LABELS:
                problems.append("抖音可见范围只支持公开、仅自己可见、好友可见")
        except (TypeError, ValueError):
            problems.append("抖音可见范围参数不合法")
        return problems

    # ------------------------------------------------------------ 登录

    def start_qr(self, proxy: str = "") -> DouyinQrSession:
        return DouyinQrSession(proxy)

    def _state_from_account(self, account: Any) -> dict[str, Any]:
        if self.accounts is None:
            raise PlatformFailure(errors.AUTH, "账号管理器未初始化，无法读取抖音登录态")
        blob = self.accounts.session_blob(account)
        state = blob.get("storage_state") or {}
        if not state and blob.get("cookies"):
            state = {"cookies": blob["cookies"], "origins": []}
        if not state:
            raise PlatformFailure(errors.AUTH, "抖音登录态不存在，请重新扫码登录")
        return state

    def _persist(self, account: Any, context, **extra: Any) -> None:
        if self.accounts is None:
            return
        blob = {}
        try:
            blob = self.accounts.session_blob(account)
        except Exception:  # noqa: BLE001
            blob = {}
        state = storage_state(context)
        blob.update(
            {
                "storage_state": state,
                "cookies": state.get("cookies") or cookies_of(context),
                "updated_at": int(time.time()),
            }
        )
        blob.update({key: value for key, value in extra.items() if value})
        try:
            self.accounts.save_session(int(account["id"]), blob)
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"回写抖音账号 {account['id']} 登录态失败: {exc}")

    @staticmethod
    def _login_wall(page) -> bool:
        """页面明确停在登录 / 扫码页时才算登录失效。

        Cookie 是否存在不能作为登录依据：Cookie 还在但会话已失效时，页面会
        跳登录墙，此时把 Cookie 当健康信号会制造「假健康」。
        """
        url = str(getattr(page, "url", "") or "").lower()
        if "login" in url or "passport" in url:
            return True
        for text in _LOGIN_TEXTS:
            locator = page.get_by_text(text, exact=True).first
            try:
                if locator.count() and locator.is_visible():
                    return True
            except Exception:  # noqa: BLE001
                continue
        return False

    @staticmethod
    def _assert_logged_in(page) -> None:
        if DouyinAdapter._login_wall(page):
            raise PlatformFailure(errors.AUTH, "抖音登录态已失效，请重新扫码登录")

    def check_session(self, account: Any) -> dict[str, Any]:
        """登录态判定只认服务端自证：创作者中心 + 账号信息。

        三种结果：
        - 明确登录墙 → expired；
        - 页面打不开 / 跳转异常 / 账号信息接口没返回 → transient，保留原状态；
        - 进入 creator-micro 且读到昵称或 uid → healthy。
        """
        try:
            state = self._state_from_account(account)
            with browser_session(storage_state=state, headless=True) as context:
                page = context.new_page()
                try:
                    goto(page, CREATOR_HOME, timeout=60_000)
                except Exception as exc:  # noqa: BLE001
                    logger.warning(f"抖音账号 {account['id']} 打开创作者中心失败: {exc}")
                    return {
                        "ok": False,
                        "transient": True,
                        "message": "抖音创作者中心打开失败，请稍后重试",
                    }
                time.sleep(1.0)
                if self._login_wall(page):
                    return {"ok": False, "message": "抖音登录态已失效，请重新扫码登录"}
                if "creator-micro" not in page.url:
                    try:
                        goto(
                            page,
                            "https://creator.douyin.com/creator-micro/home",
                            timeout=45_000,
                        )
                        time.sleep(1.2)
                    except Exception:  # noqa: BLE001
                        pass
                if "creator-micro" not in page.url:
                    if self._login_wall(page):
                        return {"ok": False, "message": "抖音登录态已失效，请重新扫码登录"}
                    return {
                        "ok": False,
                        "transient": True,
                        "message": "抖音创作者中心跳转异常，暂时无法确认登录态，请稍后重试",
                    }
                nickname, user_id, platform_id = _read_user_info(page)
                if not nickname and not user_id:
                    # 页面已是创作者中心，但服务端没有返回账号信息；不能凭 Cookie 判健康。
                    return {
                        "ok": False,
                        "transient": True,
                        "message": "抖音未返回账号信息，暂时无法确认登录态，请稍后重试",
                    }
                self._persist(account, context, nickname=nickname, user_id=user_id, platform_id=platform_id)
                return {
                    "ok": True,
                    "message": "登录态正常",
                    "nickname": nickname or account["nickname"],
                    "red_id": platform_id or account["red_id"],
                    "user_id": user_id or account["user_id"],
                }
        except BrowserUnavailable as exc:
            return {"ok": False, "transient": True, "message": str(exc)}
        except PlatformFailure as exc:
            if exc.kind == errors.AUTH:
                return {"ok": False, "message": exc.message}
            return {"ok": False, "transient": True, "message": exc.message}
        except Exception:  # noqa: BLE001
            logger.exception(f"抖音账号 {account['id']} 登录态检查异常")
            return {"ok": False, "transient": True, "message": "抖音登录态检查失败，请稍后重试"}

    # ------------------------------------------------------------ 发布

    def publish(self, account: Any, payload: dict[str, Any]) -> PublishOutcome:
        problems = self.validate(payload, str(payload.get("content_type") or ""))
        if problems:
            return PublishOutcome(False, "；".join(problems), {"stage": "validate"}, errors.CONTENT)
        try:
            state = self._state_from_account(account)
        except PlatformFailure as exc:
            return PublishOutcome(False, exc.message, exc.as_result(), exc.kind)
        content_type = str(payload.get("content_type") or "")
        media_type = str(payload.get("media_type") or "")
        is_image = content_type == "image_text" or media_type == "image"
        evidence: dict[str, Any] = {}
        try:
            with browser_session(storage_state=state, headless=True) as context:
                page = context.new_page()
                responses: list[Any] = []

                def _capture(response):
                    try:
                        if any(token in response.url for token in ("/aweme/create", "/aweme/publish", "/media/aweme")):
                            responses.append(response.json())
                    except Exception:  # noqa: BLE001
                        return

                page.on("response", _capture)
                try:
                    goto(page, CREATOR_UPLOAD, timeout=60_000)
                    time.sleep(1.5)
                    self._assert_logged_in(page)
                    if "creator-micro" not in page.url:
                        raise PlatformFailure(
                            errors.AUTH, "抖音登录态已失效，请重新扫码登录"
                        )
                    if is_image:
                        self._prepare_image_text(page, payload)
                    else:
                        self._prepare_video(page, payload)
                    self._select_visibility(page, payload)
                    aweme_id = self._submit(page, responses)
                except Exception:
                    evidence = _capture_evidence(page, account, payload)
                    raise
                self._persist(account, context)
                message = "抖音发布成功"
                if aweme_id:
                    message += f"（作品 ID {aweme_id}）"
                return PublishOutcome(
                    True,
                    message,
                    {"aweme_id": aweme_id, "stage": "published", "content_type": "image_text" if is_image else "video"},
                )
        except BrowserUnavailable as exc:
            return PublishOutcome(False, str(exc), {"stage": "browser"}, errors.PLATFORM)
        except PlatformFailure as exc:
            if exc.detail:
                logger.warning(f"抖音发布失败[{exc.kind}]: {exc.message} / {exc.detail}")
            result = exc.as_result()
            if evidence:
                result["evidence"] = evidence
            return PublishOutcome(False, exc.message, result, exc.kind)
        except Exception as exc:  # noqa: BLE001
            logger.exception(f"抖音账号 {account['id']} 发布异常")
            result: dict[str, Any] = {"stage": "unknown", "detail": str(exc)[:300]}
            if evidence:
                result["evidence"] = evidence
            return PublishOutcome(
                False,
                "抖音发布失败，请稍后重试（详见日志）",
                result,
                errors.NETWORK,
            )

    # ------------------------------------------------------------ 发布页动作

    @staticmethod
    def _file_input(page, kind: str):
        # ``input.upload-btn-input`` 是创作者中心当前版本「上传视频/图片」按钮背后
        # 隐藏的 file input；accept 过滤选择器作为改版后的回退。
        selectors = (
            [
                "input.upload-btn-input[accept*=image]",
                "input.upload-btn-input",
                "input[type=file][accept*=image]",
                "input[type=file][accept*=png]",
                "input[type=file]",
            ]
            if kind == "image"
            else [
                "input.upload-btn-input[accept*=video]",
                "input.upload-btn-input",
                "input[type=file][accept*=video]",
                "input[type=file]",
            ]
        )
        for selector in selectors:
            locator = page.locator(selector).first
            try:
                if locator.count():
                    return locator
            except Exception:  # noqa: BLE001
                continue
        raise PlatformFailure(
            errors.PLATFORM,
            "抖音发布页没有找到上传入口，平台页面可能已改版",
            detail="input[type=file] 不存在",
        )

    def _prepare_video(self, page, payload: dict[str, Any]) -> None:
        video = str(payload.get("video") or (payload.get("images") or [""])[0] or "")
        if not video or not Path(video).is_file():
            raise PlatformFailure(errors.CONTENT, "抖音视频文件不存在", detail=video)
        self._file_input(page, "video").set_input_files(video)
        # 抖音在上传完成后才渲染标题/正文，先等上传再填文案。
        self._wait_upload(page)
        self._fill_caption(page, payload)

    def _prepare_image_text(self, page, payload: dict[str, Any]) -> None:
        tab = None
        try:
            locator = page.get_by_text("发布图文", exact=True)
            if locator.count():
                tab = locator.first
        except Exception:  # noqa: BLE001
            tab = None
        if tab is None:
            tab = first_visible(
                page, ['div:has-text("发布图文")', 'span:has-text("图文")']
            )
        if tab is not None:
            try:
                tab.click(timeout=5_000)
                time.sleep(1.0)
            except Exception:  # noqa: BLE001
                pass
        images = [str(path) for path in payload.get("images") or [] if path]
        missing = [path for path in images if not Path(path).is_file()]
        if missing:
            raise PlatformFailure(errors.CONTENT, "抖音图片文件不存在", detail=str(missing[:2]))
        self._file_input(page, "image").set_input_files(images)
        self._wait_upload(page)
        self._fill_caption(page, payload)

    @staticmethod
    def _fill_caption(page, payload: dict[str, Any]) -> None:
        """标题写入 ``填写作品标题`` 输入框，正文写入 ``div.zone-container`` 编辑器。

        选择器来自 dreammis/social-auto-upload 的抖音上传实现；保留一个
        通用 contenteditable 回退，改版时仍能尝试发布。
        """
        title = str(payload.get("title") or "").strip()
        desc = str(payload.get("desc") or "").strip()
        filled = False

        title_box = None
        for selector in (
            'input[placeholder*="填写作品标题"]',
            'input[placeholder*="作品标题"]',
        ):
            locator = page.locator(selector).first
            try:
                if locator.count() and locator.is_visible():
                    title_box = locator
                    break
            except Exception:  # noqa: BLE001
                continue
        if title_box is not None and title:
            try:
                title_box.click(timeout=5_000)
                title_box.fill(title[:55])
                filled = True
            except Exception:  # noqa: BLE001
                filled = False

        editor = None
        for selector in (
            'div.zone-container[contenteditable="true"]',
            "div.zone-container[contenteditable]",
            'div[contenteditable="true"]',
            "textarea",
        ):
            locator = page.locator(selector).first
            try:
                if locator.count() and locator.is_visible():
                    editor = locator
                    break
            except Exception:  # noqa: BLE001
                continue
        # 标题框和正文框分开时，正文只写 desc；只有一个编辑器时写标题+正文。
        body = desc if filled else _caption(payload)
        if editor is not None and body:
            try:
                editor.click(timeout=5_000)
                editor.fill(body)
                filled = True
            except Exception:  # noqa: BLE001
                filled = filled or False
        if not filled:
            raise PlatformFailure(
                errors.PLATFORM,
                "抖音发布页没有找到文案输入框，平台页面可能已改版",
                detail="填写作品标题 / zone-container 均不存在",
            )

    @staticmethod
    def _wait_upload(page, timeout: float = 900) -> None:
        """等素材上传完成：以文案编辑器出现 + 「上传中/处理中」消失为准。"""
        deadline = time.time() + timeout
        while time.time() < deadline:
            text = ""
            try:
                text = page.inner_text("body", timeout=5_000)
            except Exception:  # noqa: BLE001
                pass
            if any(word in text for word in ("上传失败", "格式不支持", "文件过大")):
                raise PlatformFailure(errors.CONTENT, "抖音素材上传失败：文件格式或大小不符合平台要求")
            uploading = "上传中" in text or "处理中" in text
            if not uploading:
                try:
                    ready = page.locator(
                        'div.zone-container[contenteditable], input[placeholder*="填写作品标题"]'
                    ).count()
                except Exception:  # noqa: BLE001
                    ready = 0
                if ready:
                    return
            time.sleep(3)
        raise PlatformFailure(
            errors.PLATFORM,
            "抖音素材上传超时，请检查网络或稍后重试",
            detail=f"{int(timeout)} 秒内未出现文案编辑器",
        )

    @staticmethod
    def _select_visibility(page, payload: dict[str, Any]) -> None:
        try:
            value = int(payload.get("type") or 0)
        except (TypeError, ValueError):
            value = 0
        label = VISIBILITY_LABELS.get(value, "")
        if value == 0 or not label:
            return
        trigger = first_visible(page, ["text=谁可以看", 'div:has-text("谁可以看")', "text=公开"])
        if trigger is None:
            return
        try:
            trigger.click(timeout=5_000)
            time.sleep(0.8)
            option = first_visible(page, [f"text={label}", f'div:has-text("{label}")'])
            if option is not None:
                option.click(timeout=5_000)
                time.sleep(0.8)
        except Exception:  # noqa: BLE001
            logger.warning("抖音可见范围设置失败，将使用平台默认值")

    @staticmethod
    def _submit(page, responses: list[Any]) -> str:
        button = None
        # 优先按角色 + 精确文案定位，避免命中「定时发布」之类的同名前缀按钮。
        try:
            locator = page.get_by_role("button", name="发布", exact=True)
            if locator.count() and locator.first.is_visible():
                button = locator.first
        except Exception:  # noqa: BLE001
            button = None
        if button is None:
            for selector in (
                'button:has-text("发布")',
                'div[role="button"]:has-text("发布")',
                'button:has-text("立即发布")',
            ):
                locator = page.locator(selector).first
                try:
                    if locator.count() and locator.is_visible():
                        text = str(locator.inner_text(timeout=2_000) or "").strip()
                        if "定时" in text:
                            continue
                        button = locator
                        break
                except Exception:  # noqa: BLE001
                    continue
        if button is None:
            raise PlatformFailure(
                errors.PLATFORM,
                "抖音发布页没有找到「发布」按钮，平台页面可能已改版",
                detail="发布按钮不存在",
            )
        try:
            button.click(timeout=10_000)
        except Exception as exc:  # noqa: BLE001
            raise PlatformFailure(errors.NETWORK, "点击抖音发布按钮失败，请重试", detail=str(exc)) from exc

        deadline = time.time() + 120
        while time.time() < deadline:
            if "content/manage" in page.url:
                return _find_aweme_id(responses)
            text = ""
            try:
                text = page.inner_text("body", timeout=3_000)
            except Exception:  # noqa: BLE001
                pass
            if any(word in text for word in ("发布成功", "作品已发布", "已发布")):
                return _find_aweme_id(responses)
            if any(word in text for word in ("发布失败", "请勿重复", "内容违规", "审核")):
                reason = text_of(page, ['[class*="toast"]', '[class*="error"]', '[class*="tip"]'], text[:80])
                kind = errors.CONTENT if any(word in reason for word in ("违规", "敏感", "审核")) else errors.PLATFORM
                raise PlatformFailure(kind, f"抖音发布失败：{reason or '平台未返回原因'}")
            time.sleep(2)
        # 超时但接口已返回作品 ID 时按成功处理，避免重复发布。
        aweme_id = _find_aweme_id(responses)
        if aweme_id:
            return aweme_id
        raise PlatformFailure(errors.NETWORK, "抖音发布结果未确认，请到创作者中心检查后再重试")

    # ------------------------------------------------------------ 内容回收

    def note_url(self, remote_note_id: str) -> str:
        value = str(remote_note_id or "").strip()
        return f"https://www.douyin.com/video/{value}" if value else ""

    def fetch_published(
        self, account: Any, *, cursor: Any = 0, limit: int = 30
    ) -> dict[str, Any]:
        try:
            state = self._state_from_account(account)
        except PlatformFailure as exc:
            return {"ok": False, "message": exc.message, "items": [], "next_cursor": None, "kind": exc.kind}
        try:
            with browser_session(storage_state=state, headless=True) as context:
                page = context.new_page()
                goto(page, CREATOR_MANAGE, timeout=60_000)
                time.sleep(2.0)
                if "creator-micro" not in page.url:
                    self._assert_logged_in(page)
                payload, source = self._fetch_via_api(page, cursor, limit)
                if payload is None:
                    items = self._fetch_via_dom(page, limit)
                    next_cursor = None if len(items) < limit else int(cursor or 0) + len(items)
                    self._persist(account, context)
                    return {
                        "ok": True,
                        "message": "成功" if items else "平台未返回作品列表",
                        "items": items,
                        "next_cursor": next_cursor,
                        "source": "dom",
                    }
                items = self._extract_items(payload, limit)
                next_cursor = _next_cursor(payload)
                self._persist(account, context)
                return {
                    "ok": True,
                    "message": "成功",
                    "items": items,
                    "next_cursor": next_cursor,
                    "source": source,
                }
        except BrowserUnavailable as exc:
            return {"ok": False, "message": str(exc), "items": [], "next_cursor": None}
        except PlatformFailure as exc:
            return {
                "ok": False,
                "message": exc.message,
                "items": [],
                "next_cursor": None,
                "kind": exc.kind,
            }
        except Exception:  # noqa: BLE001
            logger.exception(f"抖音账号 {account['id']} 拉取作品列表异常")
            return {
                "ok": False,
                "message": "拉取抖音作品列表失败，请稍后重试",
                "items": [],
                "next_cursor": None,
            }

    @staticmethod
    def _fetch_via_api(page, cursor: Any, limit: int) -> tuple[Any, str]:
        page_count = max(1, min(50, int(limit or 30)))
        for template in _LIST_APIS:
            url = template.format(count=page_count, cursor=int(cursor or 0))
            try:
                payload = page.evaluate(
                    """async (url) => {
                        try {
                            const r = await fetch(url, {credentials: 'include', headers: {accept: 'application/json'}});
                            if (!r.ok) return {__status: r.status};
                            return await r.json();
                        } catch (err) { return {__error: String(err)}; }
                    }""",
                    url,
                )
            except Exception:  # noqa: BLE001
                continue
            if isinstance(payload, dict) and not payload.get("__error") and not payload.get("__status"):
                if _extract_list(payload):
                    return payload, "api"
        return None, ""

    @staticmethod
    def _extract_items(payload: Any, limit: int) -> list[dict[str, Any]]:
        raw_items = _extract_list(payload)
        items = []
        for item in raw_items[: max(1, limit)]:
            if not isinstance(item, dict):
                continue
            normalized = normalize_item(item)
            if normalized["remote_note_id"]:
                items.append(normalized)
        return items

    @staticmethod
    def _fetch_via_dom(page, limit: int) -> list[dict[str, Any]]:
        try:
            rows = page.evaluate(
                """(limit) => {
                    const nodes = Array.from(document.querySelectorAll(
                      'div[class*="work-card"], div[class*="content-card"], div[class*="video-card"], li[class*="item"]'
                    ));
                    return nodes.slice(0, limit).map((node) => {
                        const img = node.querySelector('img');
                        const link = node.querySelector('a[href*="/video/"], a[href*="/note/"]');
                        const text = (node.innerText || '').trim();
                        return {
                            id: link ? (link.href.match(/(?:video|note)\\/(\\d+)/) || [])[1] : '',
                            title: text.split('\\n')[0] || '',
                            desc: text,
                            cover: img ? img.src : '',
                            url: link ? link.href : '',
                            dom: true
                        };
                    });
                }""",
                max(1, limit),
            )
        except Exception:  # noqa: BLE001
            return []
        items = []
        for row in rows or []:
            if not isinstance(row, dict):
                continue
            remote_id = str(row.get("id") or "")
            if not remote_id:
                continue
            items.append(
                {
                    "remote_note_id": remote_id,
                    "title": str(row.get("title") or "")[:300],
                    "desc": str(row.get("desc") or "")[:5000],
                    "cover": str(row.get("cover") or ""),
                    "note_type": "video",
                    "visibility": "",
                    "views": None,
                    "likes": None,
                    "comments": None,
                    "collects": None,
                    "published_at": 0,
                    "url": str(row.get("url") or ""),
                    "raw": row,
                }
            )
        return items


def _extract_list(payload: Any) -> list[Any]:
    if isinstance(payload, list):
        return payload
    if not isinstance(payload, dict):
        return []
    for key in ("aweme_list", "awemeList", "item_list", "itemList", "items"):
        value = payload.get(key)
        if isinstance(value, list):
            return value
    data = payload.get("data")
    if isinstance(data, dict):
        for key in ("aweme_list", "awemeList", "item_list", "itemList", "items", "list"):
            value = data.get(key)
            if isinstance(value, list):
                return value
    if isinstance(data, list):
        return data
    return []


def _next_cursor(payload: Any) -> Any:
    if not isinstance(payload, dict):
        return None
    for key in ("max_cursor", "maxCursor", "next_cursor", "nextCursor", "cursor"):
        value = payload.get(key)
        if value not in (None, "", 0, "0"):
            return value
    data = payload.get("data")
    if isinstance(data, dict):
        for key in ("max_cursor", "maxCursor", "next_cursor", "nextCursor", "cursor"):
            value = data.get(key)
            if value not in (None, "", 0, "0"):
                return value
    return None


__all__ = ["DouyinAdapter", "DouyinQrSession", "normalize_item", "PLATFORM_KEY"]
