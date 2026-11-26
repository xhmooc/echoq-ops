# encoding: utf-8
"""微信公众号适配器。

公众号后台没有公开的「扫码登录」API，登录必须由管理员在
``mp.weixin.qq.com`` 扫码；登录后网页后台用 Cookie + token 调用非公开接口。
本适配器把这两段拆开：

- 登录：Playwright 打开公众平台首页，截取二维码，扫码后保存 Cookie + token；
- 发布：只保存草稿（``draft``）。公众号后台没有可稳定自动化的「群发」接口，
  群发/发表需要管理员在后台人工确认，适配器不再假装能群发；
- 回收：读取「已发表」列表，保留平台返回的阅读、点赞、在看；缺失字段留空。

网页接口未公开，平台改版时统一返回「平台页面变更」分类并停止重试，避免把
失败伪装成成功。参考实现见 docs/DOUYIN_WECHAT.md。
"""

from __future__ import annotations

import base64
import json
import re
import threading
import time
from pathlib import Path
from typing import Any, TYPE_CHECKING
from urllib.parse import parse_qs, urlparse

import requests
from loguru import logger

from ops import config, richtext
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
    cookie_header,
    cookies_of,
    extract_qr_png,
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

PLATFORM_KEY = "wechat_mp"
MP_HOME = "https://mp.weixin.qq.com/"
MP_ORIGIN = "https://mp.weixin.qq.com"
COVER_MAX_BYTES = 10 * 1024 * 1024
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png"}
ACTION_LABELS = {"draft": "保存草稿"}

LONG_ARTICLE_SPEC = ContentSpec(
    key="long_article",
    label="公众号长文",
    media_type="image",
    title_max=64,
    desc_max=20000,
    min_images=1,
    max_images=1,
    requires_media=True,
    topics="topic",
    notes="标题 ≤64 字，正文 ≤2 万字，必须 1 张封面图（jpg/png，≤10MB）；只保存到草稿箱，发表/群发请在后台人工完成。",
)

IMAGE_MESSAGE_SPEC = ContentSpec(
    key="image_message",
    label="公众号贴图",
    media_type="image",
    title_max=64,
    desc_max=1000,
    min_images=1,
    max_images=9,
    requires_media=True,
    topics="topic",
    notes="图片消息（贴图）：1-9 张 jpg/png 原图（单张 ≤10MB），标题 ≤64 字，短文案 ≤1000 字；图片按原比例竖排。只保存到草稿箱。",
)

_QR_IMG_SELECTORS = [
    "img.login__type__container__scan__qrcode",
    ".login__type__container__scan__qrcode img",
    "#js_qrcode img",
    'img[src*="qrcode"]',
]
_QR_CONTAINER_SELECTORS = [
    ".login__type__container__scan__qrcode",
    "#js_qrcode",
    'div[class*="scan__qrcode"]',
    "canvas",
]
_LOGIN_TEXTS = ("扫码登录", "请使用微信扫描二维码登录", "二维码已失效", "二维码已过期")

_TINY_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII="
)


def _pick(payload: Any, *keys: str, default: Any = "") -> Any:
    if not isinstance(payload, dict):
        return default
    for key in keys:
        value = payload.get(key)
        if value not in (None, ""):
            return value
    return default


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
    return int(text) if text.isdigit() else 0


def _token_from_url(url: str) -> str:
    try:
        values = parse_qs(urlparse(url or "").query).get("token") or []
    except ValueError:
        return ""
    return str(values[0] if values else "").strip()


def _regex_first(text: str, patterns: list[str]) -> str:
    for pattern in patterns:
        match = re.search(pattern, text or "")
        if match:
            return str(match.group(1) or "").strip()
    return ""


def _parse_account(html: str, page_url: str = "") -> dict[str, str]:
    nickname = _regex_first(
        html,
        [
            r'"nick_name"\s*:\s*"([^"]+)"',
            r"'nick_name'\s*:\s*'([^']+)'",
            r'nick_name\s*[:=]\s*["\']([^"\']+)',
            r'"nickname"\s*:\s*"([^"]+)"',
        ],
    )
    fakeid = _regex_first(
        html,
        [
            r'"fakeid"\s*:\s*"([^"]+)"',
            r"'fakeid'\s*:\s*'([^']+)'",
            r'fakeid\s*[:=]\s*["\']([^"\']+)',
        ],
    )
    token = _token_from_url(page_url) or _regex_first(
        html,
        [
            r'["\']token["\']\s*:\s*["\']?(\d{4,})',
            r"wx\.(?:cgiData|data)\.token\s*=\s*[\"']?(\d{4,})",
            r"token\s*=\s*[\"'](\d{4,})",
            r"token=(\d{4,})",
            r'token\s*[:=]\s*["\']?(\d{4,})',
        ],
    )
    ticket = _regex_first(
        html,
        [
            r'wx\.data\.ticket\s*=\s*["\']([^"\']+)',
            r'wx\.cgiData\.ticket\s*=\s*["\']([^"\']+)',
            r'"ticket"\s*:\s*"([^"]+)"',
            r"ticket\s*[:=]\s*[\"']([^\"']+)",
        ],
    )
    user_name = _regex_first(
        html,
        [
            r'wx\.data\.user_name\s*=\s*["\']([^"\']+)',
            r'wx\.cgiData\.user_name\s*=\s*["\']([^"\']+)',
            r'"user_name"\s*:\s*"([^"]+)"',
        ],
    )
    svr_time = _regex_first(
        html,
        [
            r'wx\.cgiData\.time\s*=\s*["\']?(\d{10,13})',
            r'"svr_time"\s*:\s*"?(\d{10,13})',
            r"svr_time\s*[:=]\s*[\"']?(\d{10,13})",
            r"\btime\s*[:=]\s*[\"']?(\d{10,13})",
        ],
    )
    return {
        "nickname": nickname,
        "fakeid": fakeid,
        "token": token,
        "ticket": ticket,
        "user_name": user_name,
        "svr_time": svr_time,
    }


def _as_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _find_field(payload: Any, keys: tuple[str, ...], depth: int = 0) -> str:
    """在多层响应里找字段，兼容 material 上传把结果塞进 data/content 的情况。"""
    if depth > 4 or payload is None:
        return ""
    if isinstance(payload, dict):
        for key in keys:
            value = payload.get(key)
            if isinstance(value, (str, int)) and str(value).strip():
                return str(value).strip()
        for key in ("data", "result", "file", "image", "img"):
            found = _find_field(payload.get(key), keys, depth + 1)
            if found:
                return found
        content = payload.get("content")
        if isinstance(content, str) and content.strip().startswith("{"):
            try:
                found = _find_field(json.loads(content), keys, depth + 1)
                if found:
                    return found
            except ValueError:
                pass
    return ""


def _safe_json(response: requests.Response) -> Any:
    try:
        return response.json()
    except ValueError:
        return None


def normalize_article(item: dict[str, Any]) -> dict[str, Any]:
    """把公众号后台文章对象归一化成 published_notes 字段。"""
    remote_id = str(
        _pick(item, "aid", "appmsgid", "app_msg_id", "msg_id", "id", "fileid")
        or ""
    )
    link = str(_pick(item, "link", "url", "content_url") or "")
    if not remote_id and link:
        match = re.search(r"/s/([A-Za-z0-9_-]+)", link)
        remote_id = match.group(1) if match else link
    title = str(_pick(item, "title", "name") or "").strip()
    digest = str(_pick(item, "digest", "desc", "summary") or "").strip()
    cover = str(_pick(item, "cover", "cover_url", "cover_url_1", "cdn_url") or "")
    reads = _pick(item, "read_num", "readNum", "read_count", default=None)
    likes = _pick(item, "like_num", "likeNum", "like_count", default=None)
    collects = _pick(item, "old_like_num", "oldLikeNum", "wow_num", default=None)
    comments = _pick(
        item, "comment_count", "commentCount", "comment_num", "commentNum", default=None
    )
    shares = _pick(item, "share_num", "shareNum", default=None)
    return {
        "remote_note_id": remote_id,
        "title": title,
        "desc": digest,
        "cover": cover,
        "note_type": "article",
        "visibility": "公开",
        "views": _count_or_none(reads),
        "likes": _count_or_none(likes),
        "comments": _count_or_none(comments),
        "collects": _count_or_none(collects),
        "shares": _count_or_none(shares),
        "published_at": _timestamp(
            _pick(item, "create_time", "createTime", "update_time", "send_time", "sent_time")
        ),
        "url": link,
        "raw": item,
    }


def normalize_comment(
    item: Any, *, parent: str = "", is_reply: bool = False, index: int = 0
) -> dict[str, Any]:
    """把公众号「精选留言」归一化成 note_comments 字段。"""
    if not isinstance(item, dict):
        return {}
    remote_id = str(
        _pick(item, "id", "comment_id", "content_id", "elected_comment_id") or ""
    ).strip()
    if not remote_id and parent:
        # 回复对象经常没有独立 id；用父留言 + 序号生成稳定标识。
        remote_id = f"{parent}-r{index}"
    return {
        "remote_comment_id": remote_id,
        "author": str(_pick(item, "nick_name", "nickname", "user_name") or "")[:100],
        "author_id": str(_pick(item, "openid", "user_id", "fakeid") or "")[:100],
        "content": str(_pick(item, "content", "text", "comment") or "")[:2000],
        "likes": _count_or_none(
            _pick(item, "like_num", "like_count", "likeNum", default=None)
        ),
        "is_reply": bool(is_reply),
        "parent_comment_id": parent,
        "commented_at": _timestamp(
            _pick(item, "create_time", "createTime", "comment_time")
        ),
    }


def _as_dict(value: Any) -> dict[str, Any]:
    """后台很多字段是「JSON 字符串」，统一拆成 dict，拆不动就退回空 dict。"""
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip().startswith("{"):
        try:
            parsed = json.loads(value)
        except ValueError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


def _published_items(payload: Any) -> tuple[list[dict[str, Any]], Any]:
    """兼容「已发表」接口的 publish_page -> publish_list -> appmsgex 结构。

    ``/cgi-bin/appmsgpublish`` 把结果放在 ``publish_page``（JSON 字符串），
    ``/cgi-bin/freepublish`` 则把每篇放在 ``publish_info``（同样是字符串），
    两种都要拆开后再按文章逐个归一化。
    """
    if not isinstance(payload, dict):
        return [], None
    root = payload
    page = _as_dict(payload.get("publish_page") or payload.get("publishPage"))
    if page:
        publish_list = page.get("publish_list") or page.get("list") or []
        if isinstance(publish_list, list) and publish_list:
            articles: list[dict[str, Any]] = []
            for entry in publish_list:
                if not isinstance(entry, dict):
                    continue
                info = _as_dict(
                    entry.get("publish_info") or entry.get("publishInfo")
                ) or entry
                sent = _as_dict(info.get("sent_info") or entry.get("sent_info"))
                fallback = {**entry, **sent, **info}
                groups = (
                    info.get("appmsgex")
                    or info.get("appmsg_info")
                    or info.get("appmsg_list")
                    or entry.get("appmsgex")
                    or entry.get("appmsg_info")
                )
                candidates = groups if isinstance(groups, list) and groups else [info]
                for candidate in candidates:
                    merged = {**fallback, **_as_dict(candidate)}
                    article = normalize_article(merged)
                    if article["remote_note_id"]:
                        articles.append(article)
            return articles, page
    items = (
        payload.get("app_msg_list")
        or payload.get("appmsg_list")
        or payload.get("publish_list")
        or payload.get("list")
        or []
    )
    articles = [
        normalize_article(item) for item in items if isinstance(item, dict)
    ]
    return [article for article in articles if article["remote_note_id"]], root


class WeChatClient:
    """带后台 Cookie + token 的 HTTP 客户端。"""

    def __init__(self, session: dict[str, Any], proxy: str = "") -> None:
        self.session_data = dict(session or {})
        self.token = str(self.session_data.get("token") or "")
        self.cookie = str(self.session_data.get("cookie_header") or "")
        self.http = requests.Session()
        self.http.headers.update(
            {
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
                ),
                "Referer": MP_HOME,
                "Accept": "*/*",
                "Accept-Language": "zh-CN,zh;q=0.9",
                "X-Requested-With": "XMLHttpRequest",
            }
        )
        self._load_cookies()
        if proxy:
            value = proxy if "://" in proxy else f"http://{proxy}"
            self.http.proxies = {"http": value, "https": value}

    def _load_cookies(self) -> None:
        for item in self.session_data.get("cookies") or []:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or "")
            if not name:
                continue
            domain = str(item.get("domain") or ".weixin.qq.com")
            self.http.cookies.set(
                name,
                str(item.get("value") or ""),
                domain=domain if domain.startswith(".") else f".{domain.lstrip('.')}",
                path=str(item.get("path") or "/"),
            )

    def close(self) -> None:
        try:
            self.http.close()
        except Exception:  # noqa: BLE001
            pass

    def cookies(self) -> list[dict[str, Any]]:
        return [
            {
                "name": item.name,
                "value": item.value,
                "domain": item.domain or ".weixin.qq.com",
                "path": item.path or "/",
                "expires": item.expires or -1,
                "httpOnly": False,
                "secure": bool(item.secure),
                "sameSite": "Lax",
            }
            for item in self.http.cookies
        ]

    def get(self, path: str, params: dict[str, Any] | None = None, **kwargs: Any):
        url = path if path.startswith("http") else MP_ORIGIN + path
        return self.http.get(url, params=params, timeout=35, **kwargs)

    def post(self, path: str, data: dict[str, Any] | None = None, **kwargs: Any):
        url = path if path.startswith("http") else MP_ORIGIN + path
        return self.http.post(url, data=data, timeout=35, **kwargs)


class WechatQrSession:
    """公众号扫码会话。"""

    TTL = 300
    platform = PLATFORM_KEY

    def __init__(self, proxy: str = "", headless: bool | None = None) -> None:
        self.proxy = proxy
        self.created_at = time.time()
        self.status = "starting"
        self.message = "正在打开微信公众平台"
        self.nickname = ""
        self.fakeid = ""
        self.token = ""
        self.account_state: dict[str, Any] = {}
        self.qr_png = b""
        self._headless = qr_headless() if headless is None else bool(headless)
        self._visible = not self._headless
        # 是否创建过可见窗口：默认无头时为 False，只有用户点「打开验证窗口」才变 True。
        self._window_used = self._visible
        # 配置成 visible 时一开始就给人工操作留出时限；无头下等待用户点按钮。
        self._needs_action_until = time.time() + 120 if self._visible else 0.0
        self._notice = ""
        self._closed = False
        self._lock = threading.Lock()
        self._already_logged_in = False
        # 登录后页面先落到 home、token 稍后才补上；这段时间不能急着判失败。
        self._home_since = 0.0
        self.diagnostics: dict[str, Any] = {}
        try:
            self._worker = BrowserWorker(headless=self._headless, proxy=proxy)
            self.qr_png = self._worker.call(self._open, timeout=120)
            self.diagnostics = browser_diagnostics()
            if self._already_logged_in:
                self.status = "confirmed"
                self.message = f"已登录：{self.nickname or '公众号'}"
            else:
                self.status = "waiting"
                self.message = "请用微信扫描二维码登录公众平台"
        except Exception:
            try:
                if getattr(self, "_worker", None) is not None:
                    self._worker.close()
            except Exception:  # noqa: BLE001
                pass
            raise

    def _open(self, context) -> bytes:
        page = context.new_page()
        goto(page, MP_HOME, timeout=60_000)
        time.sleep(1.2)
        # 只有确实拿到后台 token 才算已登录；没有 token 时继续走扫码流程。
        if _token_from_url(page.url):
            self._confirm(context, page)
            self._already_logged_in = True
            return _TINY_PNG
        if not wait_for_qr(page, _QR_IMG_SELECTORS, timeout=30):
            raise PlatformFailure(
                errors.PLATFORM,
                "公众号登录页没有出现二维码，平台可能要求安全验证或页面已改版",
                detail=page.url,
            )
        return extract_qr_png(
            page, img_selectors=_QR_IMG_SELECTORS, container_selectors=_QR_CONTAINER_SELECTORS
        )

    def _confirm(self, context, page) -> None:
        try:
            html = page.content()
        except Exception:  # noqa: BLE001
            html = ""
        info = _parse_account(html, page.url)
        self.nickname = info["nickname"]
        self.fakeid = info["fakeid"]
        self.token = info["token"]
        cookies = cookies_of(context)
        self.account_state = {
            "storage_state": storage_state(context),
            "cookies": cookies,
            "cookie_header": cookie_header(cookies, "weixin.qq.com"),
            "token": self.token,
            "fakeid": self.fakeid,
            "ticket": info.get("ticket") or "",
            "user_name": info.get("user_name") or "",
            "svr_time": info.get("svr_time") or "",
            "nickname": self.nickname,
            "platform_id": self.fakeid,
            "user_id": self.fakeid,
            "login_at": int(time.time()),
            "expires_at": int(time.time()) + 4 * 3600,
        }
        if self.token:
            self.status = "confirmed"
            self.message = f"登录成功：{self.nickname or '公众号'}"
        else:
            self.status = "error"
            self.message = "登录成功但没有拿到后台 token，请重试"

    def _poll_browser(self, context) -> dict[str, Any]:
        pages = list(context.pages)
        page = pages[0] if pages else context.new_page()
        if self.status == "confirmed":
            return self.payload()
        # 登录成功后后台可能在新标签页打开；先在所有页面里找带 token 的地址。
        for candidate in pages:
            try:
                token = _token_from_url(candidate.url)
            except Exception:  # noqa: BLE001
                token = ""
            if token:
                self._home_since = 0.0
                self._confirm(context, candidate)
                return self.payload()
        # URL 里还没有 token 时，从后台首页的 HTML / JS 变量里再找一次。
        if "/cgi-bin/home" in page.url:
            try:
                html = page.content()
            except Exception:  # noqa: BLE001
                html = ""
            if _parse_account(html, page.url)["token"]:
                self._home_since = 0.0
                self._confirm(context, page)
                return self.payload()
        # 多公众号：扫码后需要人工选择目标号，这时才短暂显示窗口。
        selection = text_of(
            page,
            [
                "text=选择公众号",
                "text=请选择公众号",
                "text=请选择要登录的公众号",
                "text=选择账号",
                "text=请选择账号",
            ],
            "",
        )
        if selection:
            if not self._visible:
                # 无头下绝不自动弹窗：只把「需要人工」告诉界面，等用户点按钮。
                self.status = "needs_action"
                self.message = (
                    "检测到多个公众号，需要人工选择目标号。"
                    "点击「打开验证窗口」后会弹出一个浏览器窗口，选完会自动关闭"
                )
                self._notice = self.message
                self._needs_action_until = 0.0
                return self.payload()
            remaining = int(max(0, self._needs_action_until - time.time()))
            if remaining <= 0:
                self.status = "error"
                self.message = "验证窗口等待超时，请重新扫码"
                return self.payload()
            self.status = "needs_action"
            self.message = f"请在验证窗口中选择公众号（剩余 {remaining} 秒）"
            self._notice = self.message
            return self.payload()
        # 有些版本的登录页不会自动跳到 home，但 Cookie 已经下发；主动进一次后台。
        cookie_names = {str(item.get("name") or "") for item in cookies_of(context)}
        if cookie_names & {"slave_sid", "bizuin", "data_ticket"}:
            if self._home_since <= 0:
                self._home_since = time.time()
            waited = time.time() - self._home_since
            if "/cgi-bin/home" not in page.url:
                # 先让页面自己完成扫码后的跳转，过早 goto 会打断登录轮询。
                if waited < 6:
                    self.status = "scanned"
                    self.message = "已登录，正在跳转公众平台后台…"
                    return self.payload()
                try:
                    goto(
                        page,
                        "https://mp.weixin.qq.com/cgi-bin/home?t=home/index&lang=zh_CN",
                        timeout=45_000,
                    )
                    time.sleep(1.0)
                except Exception:  # noqa: BLE001
                    pass
            # 再给平台最多 30 秒把 token 补进 URL / 页面，期间不判失败。
            if waited < 30:
                self.status = "scanned"
                self.message = "已登录，正在等待公众平台后台 token…"
                return self.payload()
            self.status = "error"
            self.message = (
                "登录成功但 30 秒内没有拿到后台 token，请重试；"
                f"如果反复出现，可能是平台限制了无头登录（当前地址：{page.url}）"
            )
            logger.warning(
                f"公众号登录后未拿到 token: url={page.url} cookies={sorted(cookie_names)}"
            )
            return self.payload()
        expired = text_of(page, ["text=二维码已失效", "text=二维码已过期"], "")
        if expired:
            self.status = "expired"
            self.message = "二维码已失效，请重新生成"
            return self.payload()
        scanned = text_of(page, ["text=扫描成功", "text=请在手机上确认"], "")
        self.status = "scanned" if scanned else "waiting"
        self.message = "已扫码，请在手机上确认" if scanned else "请用微信扫描二维码登录"
        return self.payload()

    def open_window(self) -> dict[str, Any]:
        """用户明确点击「打开验证窗口」后，才用同一份登录态启动可见浏览器。

        无头进程本身无法「变成」可见窗口，所以这里保存 ``storage_state``、
        关掉无头浏览器、再用同一份登录态起一个可见浏览器。窗口关闭后仍会回到
        无头流程，登录态照常落库。
        """
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
            self.message = "验证窗口已打开，请在 120 秒内选择目标公众号；选完窗口会自动关闭"
            self._notice = self.message
            return self.payload()

    def _open_visible(self, context) -> str:
        page = context.pages[0] if context.pages else context.new_page()
        goto(
            page,
            "https://mp.weixin.qq.com/cgi-bin/home?t=home/index&lang=zh_CN",
            timeout=60_000,
        )
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
            "red_id": self.fakeid,
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
        return dict(self.account_state)

    def close(self) -> None:
        self._close_browser()


class WechatMpAdapter(PlatformAdapter):
    key = PLATFORM_KEY
    name = "微信公众号"
    short = "公众号"
    status = "ready"
    color = "#07c160"
    login_hint = "公众号管理员用微信扫码登录公众平台"
    docs = "微信公众平台 · 图文消息 / 图片消息（只写草稿）"
    topic_style = "topic"
    default_content_type = "long_article"
    content_types = (LONG_ARTICLE_SPEC, IMAGE_MESSAGE_SPEC)
    visibility_options = (
        VisibilityOption(1, "保存草稿", "只进草稿箱，不推送；发表请在公众号后台人工确认"),
    )
    default_daily_limit = 1
    default_min_interval_sec = 0
    features = {
        "login_cookie": False,
        "login_qr": True,
        "publish": True,
        "fetch_published": True,
        "schedule": True,
    }
    # 公众号后台只开放精选留言；先探测权限，读不到时给出明确原因。
    comments_mode = "probe"
    data_sources = (
        "阅读数、点赞、在看：公众号后台「已发表」列表，平台未返回时留空。",
        "评论数：列表接口通常不返回，留空而不是写 0。",
        "原文链接：平台返回的文章链接。",
    )

    def __init__(self, accounts: "AccountManager | None" = None) -> None:
        self.accounts = accounts

    # ------------------------------------------------------------ 规格

    def validate(self, payload: dict[str, Any], content_type: str = "") -> list[str]:
        spec = self.spec(content_type)
        # 长文允许跨平台留下的多余图片进正文，不算封面错误；贴图则严格按 1-9 张校验。
        problems = [
            item
            for item in super().validate(payload, content_type)
            if not (spec.key == "long_article" and "个素材，当前" in item)
        ]
        images = [str(path) for path in payload.get("images") or []]
        if spec.key == "image_message":
            for index, raw in enumerate(images, start=1):
                path = Path(raw)
                if path.suffix.lower() not in IMAGE_SUFFIXES:
                    problems.append(f"公众号贴图第 {index} 张不支持该格式：{path.suffix or '未知'}")
                elif path.is_file() and path.stat().st_size > COVER_MAX_BYTES:
                    problems.append(f"公众号贴图第 {index} 张不能超过 10MB")
        elif not images:
            problems.append("公众号发布需要 1 张封面图")
        else:
            path = Path(images[0])
            if path.suffix.lower() not in IMAGE_SUFFIXES:
                problems.append(f"公众号封面不支持该格式：{path.suffix or '未知'}")
            elif path.is_file() and path.stat().st_size > COVER_MAX_BYTES:
                problems.append("公众号封面不能超过 10MB")
        requested = str(payload.get("action") or payload.get("wechat_action") or "").strip()
        if requested and requested != "draft":
            problems.append("公众号只支持保存草稿；群发/发表请在公众号后台人工完成")
        return problems

    @staticmethod
    def _action(payload: dict[str, Any]) -> str:
        """公众号固定只写草稿；历史 payload 里的 mass_send 会被 validate 拦下。"""
        action = str(payload.get("action") or payload.get("wechat_action") or "").strip()
        return "draft" if action in {"", "draft"} else action

    # ------------------------------------------------------------ 登录

    def start_qr(self, proxy: str = "") -> WechatQrSession:
        return WechatQrSession(proxy)

    def _session_from_account(self, account: Any) -> dict[str, Any]:
        if self.accounts is None:
            raise PlatformFailure(errors.AUTH, "账号管理器未初始化，无法读取公众号登录态")
        blob = self.accounts.session_blob(account)
        if not blob.get("cookies") and not blob.get("cookie_header"):
            raise PlatformFailure(errors.AUTH, "公众号登录态不存在，请重新扫码登录")
        return blob

    def _persist(self, account: Any, client: WeChatClient, extra: dict[str, Any] | None = None) -> None:
        if self.accounts is None:
            return
        blob = {}
        try:
            blob = self.accounts.session_blob(account)
        except Exception:  # noqa: BLE001
            blob = {}
        blob.update(
            {
                "cookies": client.cookies(),
                "cookie_header": cookie_header(client.cookies(), "weixin.qq.com"),
                "token": client.token,
                "updated_at": int(time.time()),
            }
        )
        blob.update({key: value for key, value in (extra or {}).items() if value})
        try:
            self.accounts.save_session(int(account["id"]), blob)
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"回写公众号账号 {account['id']} 登录态失败: {exc}")

    def check_session(self, account: Any) -> dict[str, Any]:
        client = None
        try:
            session = self._session_from_account(account)
            client = WeChatClient(session, proxy=str(account["proxy"] or ""))
            response = client.get(
                "/cgi-bin/home",
                params={"t": "home/index", "lang": "zh_CN", "token": client.token},
                allow_redirects=True,
            )
            if "login" in response.url or "请登录" in response.text[:500]:
                return {"ok": False, "message": "公众号登录态已失效，请重新扫码登录"}
            info = _parse_account(response.text, response.url)
            if info["token"]:
                client.token = info["token"]
            if not info["nickname"] and not info["fakeid"]:
                return {"ok": False, "message": "公众号登录态已失效，请重新扫码登录"}
            self._persist(
                account,
                client,
                {
                    "nickname": info["nickname"],
                    "fakeid": info["fakeid"],
                    "platform_id": info["fakeid"],
                    "user_id": info["fakeid"],
                    "ticket": info["ticket"],
                    "user_name": info["user_name"],
                    "svr_time": info["svr_time"],
                },
            )
            return {
                "ok": True,
                "message": "登录态正常",
                "nickname": info["nickname"] or account["nickname"],
                "red_id": info["fakeid"] or account["red_id"],
                "user_id": info["fakeid"] or account["user_id"],
            }
        except PlatformFailure as exc:
            if exc.kind == errors.AUTH:
                return {"ok": False, "message": exc.message}
            return {"ok": False, "transient": True, "message": exc.message}
        except requests.RequestException as exc:
            logger.warning(f"公众号账号 {account['id']} 登录态检查网络失败: {exc}")
            return {
                "ok": False,
                "transient": True,
                "message": "网络异常，暂时无法检查公众号登录态",
            }
        except Exception:  # noqa: BLE001
            logger.exception(f"公众号账号 {account['id']} 登录态检查异常")
            return {
                "ok": False,
                "transient": True,
                "message": "公众号登录态检查失败，请稍后重试",
            }
        finally:
            if client is not None:
                client.close()

    # ------------------------------------------------------------ 发布

    def publish(self, account: Any, payload: dict[str, Any]) -> PublishOutcome:
        problems = self.validate(payload, str(payload.get("content_type") or ""))
        if problems:
            return PublishOutcome(False, "；".join(problems), {"stage": "validate"}, errors.CONTENT)
        action = self._action(payload)
        spec = self.spec(str(payload.get("content_type") or ""))
        images = [str(item) for item in payload.get("images") or [] if str(item)]
        client = None
        draft_id = ""
        try:
            session = self._session_from_account(account)
            client = WeChatClient(session, proxy=str(account["proxy"] or ""))
            self._ensure_token(client)
            # 贴图把 1-9 张图按原比例排在正文顶部，再用第 1 张做草稿封面。
            draft_payload = self._pic_payload(payload, images) if spec.key == "image_message" else payload
            cover = self._upload_cover(client, images[0])
            draft_id = self._find_recent_draft(client, str(payload.get("title") or ""))
            if draft_id:
                logger.info(f"公众号账号 {account['id']} 复用最近草稿 {draft_id}，避免重复创建")
            else:
                draft_id = self._create_draft(client, draft_payload, cover)
            self._persist(account, client)
            label = "图片消息（贴图）草稿" if spec.key == "image_message" else "草稿"
            return PublishOutcome(
                True,
                f"已保存到公众号{label}，请在公众号后台确认后手动发表",
                {"action": "draft", "draft_id": draft_id, "stage": "draft", "content_type": spec.key},
            )
        except PlatformFailure as exc:
            result = exc.as_result()
            if client is not None:
                result["action"] = action
            message = exc.message
            if draft_id:
                result.update({"draft_id": draft_id, "stage": "draft"})
                message = f"草稿已保存（ID {draft_id}），但后续步骤失败：{exc.message}"
            if exc.detail:
                logger.warning(f"公众号发布失败[{exc.kind}]: {exc.message} / {exc.detail}")
            return PublishOutcome(False, message, result, exc.kind)
        except requests.RequestException as exc:
            logger.warning(f"公众号账号 {account['id']} 发布网络异常: {exc}")
            result = {"stage": "network", "action": action}
            message = "公众号请求网络异常，请稍后重试"
            if draft_id:
                result.update({"draft_id": draft_id, "stage": "draft"})
                message = f"草稿已保存（ID {draft_id}），回写登录态时网络异常，可稍后重试"
            return PublishOutcome(False, message, result, errors.NETWORK)
        except Exception:  # noqa: BLE001
            logger.exception(f"公众号账号 {account['id']} 发布异常")
            return PublishOutcome(
                False,
                "公众号发布失败，请稍后重试（详见日志）",
                {"stage": "unknown", "action": action},
                errors.PLATFORM,
            )
        finally:
            if client is not None:
                client.close()

    # ------------------------------------------------------------ 后台动作

    @staticmethod
    def _ensure_token(client: WeChatClient) -> None:
        if client.token:
            return
        response = client.get("/cgi-bin/home", params={"t": "home/index", "lang": "zh_CN"})
        info = _parse_account(response.text, response.url)
        if info["token"]:
            client.token = info["token"]
        if info.get("ticket"):
            client.session_data["ticket"] = info["ticket"]
        if info.get("user_name"):
            client.session_data["user_name"] = info["user_name"]
        if info.get("svr_time"):
            client.session_data["svr_time"] = info["svr_time"]
        if not client.token:
            raise PlatformFailure(errors.AUTH, "公众号后台 token 已失效，请重新登录")

    @staticmethod
    def _response_json(response: requests.Response, stage: str) -> dict[str, Any]:
        if "login" in response.url or "请登录" in response.text[:800]:
            raise PlatformFailure(errors.AUTH, "公众号登录态已失效，请重新扫码登录")
        payload = _safe_json(response)
        if payload is None:
            text = response.text[:800]
            if any(word in text for word in ("请输入验证码", "安全验证", "频繁")):
                raise PlatformFailure(errors.RATE, "公众号要求安全验证或操作过于频繁，请稍后再试")
            raise PlatformFailure(
                errors.PLATFORM,
                "公众号后台返回了非 JSON 内容，接口可能已改版",
                detail=f"{stage} HTTP {response.status_code}",
            )
        base = payload.get("base_resp") if isinstance(payload, dict) else None
        ret = int((base or {}).get("ret") or 0) if isinstance(base, dict) else 0
        if ret != 0:
            errmsg = str((base or {}).get("err_msg") or payload.get("errmsg") or "").strip()
            text = f"{ret} {errmsg}"
            if ret in {200013, 45009} or any(word in errmsg for word in ("频繁", "频率", "次数")):
                raise PlatformFailure(errors.RATE, f"公众号操作受限：{errmsg or '请稍后再试'}")
            if ret in {-6, 200003, 40001} or any(word in errmsg for word in ("登录", "invalid session")):
                raise PlatformFailure(errors.AUTH, "公众号登录态已失效，请重新扫码登录")
            if any(word in errmsg for word in ("违规", "敏感", "内容")):
                raise PlatformFailure(errors.CONTENT, f"公众号拒绝了内容：{errmsg}")
            raise PlatformFailure(
                errors.PLATFORM,
                f"公众号接口返回错误：{errmsg or ret}",
                detail=text,
            )
        return payload if isinstance(payload, dict) else {}

    @staticmethod
    def _upload_cover(client: WeChatClient, path: str) -> dict[str, Any]:
        file_path = Path(path)
        if not file_path.is_file():
            raise PlatformFailure(errors.CONTENT, "公众号封面文件不存在", detail=path)
        mime = "image/png" if file_path.suffix.lower() == ".png" else "image/jpeg"
        base_params = {"token": client.token, "lang": "zh_CN"}
        context = client.session_data
        candidates: list[tuple[str, dict[str, str]]] = []
        if context.get("ticket") and context.get("user_name") and context.get("svr_time"):
            params = dict(base_params)
            params.update(
                {
                    "action": "upload_material",
                    "f": "json",
                    "ticket_id": str(context.get("user_name")),
                    "ticket": str(context.get("ticket")),
                    "svr_time": str(context.get("svr_time")),
                    "writetype": "doublewrite",
                    "groupid": "1",
                }
            )
            candidates.append(("/cgi-bin/filetransfer", params))
        legacy = dict(base_params)
        legacy.update(
            {
                "action": "upload_material",
                "f": "json",
                "scene": "8",
                "writetype": "doublewrite",
                "groupid": "1",
            }
        )
        candidates.append(("/cgi-bin/filetransfer", legacy))
        candidates.append(
            ("/cgi-bin/uploadmaterial", {"cgi": "uploadmaterial", "type": "2", **base_params})
        )
        last_error: Exception | None = None
        for endpoint, params in candidates:
            try:
                with file_path.open("rb") as handle:
                    response = client.post(
                        endpoint,
                        params=params,
                        files={"file": (file_path.name, handle, mime)},
                    )
                payload = WechatMpAdapter._response_json(response, "upload_cover")
                cdn_url = _find_field(
                    payload, ("cdn_url", "cdnurl", "cdnUrl", "url", "img_url", "file_url")
                )
                file_id = _find_field(
                    payload,
                    (
                        "media_id",
                        "fileid",
                        "file_id",
                        "nested_media_id",
                        "nested_fileid",
                        # 现行上传接口把素材 ID 放在 content 字段（纯数字）。
                        "content",
                    ),
                )
                if file_id and not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", file_id):
                    file_id = ""
                if not cdn_url:
                    # 旧版接口把图片地址包在 content 的 <img src="..."> 里。
                    content = str(payload.get("content") or "")
                    match = re.search(r'src=["\']([^"\']+)', content)
                    if match:
                        cdn_url = match.group(1)
                if not file_id:
                    raise PlatformFailure(
                        errors.PLATFORM,
                        "公众号封面上传成功但没有返回素材 ID，接口可能已改版",
                        detail=json.dumps(payload, ensure_ascii=False)[:500],
                    )
                return {"cdn_url": cdn_url, "file_id": file_id}
            except PlatformFailure as exc:
                last_error = exc
                if exc.kind == errors.AUTH:
                    raise
                continue
        if isinstance(last_error, PlatformFailure):
            raise last_error
        raise PlatformFailure(errors.PLATFORM, "公众号封面上传失败，接口可能已改版")

    @staticmethod
    def _find_recent_draft(client: WeChatClient, title: str) -> str:
        """按标题查找 10 分钟内创建的草稿，重试时复用，避免重复草稿。"""
        if not title:
            return ""
        for endpoint in ("/cgi-bin/appmsg", "/cgi-bin/newappmsg"):
            try:
                response = client.get(
                    endpoint,
                    params={
                        "action": "list_ex",
                        "begin": "0",
                        "count": "10",
                        "type": "77",
                        "token": client.token,
                        "lang": "zh_CN",
                        "f": "json",
                        "ajax": "1",
                    },
                )
                payload = _safe_json(response)
                if not isinstance(payload, dict):
                    continue
                items = payload.get("app_msg_list") or payload.get("appmsg_list") or []
                for item in items:
                    if not isinstance(item, dict):
                        continue
                    if str(item.get("title") or "").strip() != title:
                        continue
                    created = _timestamp(item.get("create_time"))
                    if created and time.time() - created > 600:
                        continue
                    draft_id = str(_pick(item, "appmsgid", "aid", "app_msg_id") or "")
                    if draft_id:
                        return draft_id
            except Exception:  # noqa: BLE001
                continue
        return ""

    @staticmethod
    def _pic_payload(payload: dict[str, Any], images: list[str]) -> dict[str, Any]:
        """贴图草稿：图片按原比例竖排在正文顶部，短文案放在图片之后。"""
        text_html = str(payload.get("body_html") or "").strip()
        if not text_html:
            text_html = richtext.plain_to_html(str(payload.get("desc") or ""))
        pics = "".join(
            f'<p style="text-align:center;margin:0 0 12px;"><img src="{path}" style="max-width:100%;" /></p>'
            for path in images
        )
        return {**payload, "body_html": f"{pics}{text_html}", "images": images[:1]}

    @staticmethod
    def _create_draft(client: WeChatClient, payload: dict[str, Any], cover: dict[str, Any]) -> str:
        title = str(payload.get("title") or "").strip()
        desc = str(payload.get("desc") or "").strip()
        digest = re.sub(r"\s+", " ", desc).strip()[:120]
        content_html = _article_html(client, payload)
        context = client.session_data
        appmsg_id = str(context.get("appmsgid") or "0")
        req = {
            "idx_infos": [{"save_old": 0, "cps_info": {"cps_import": 0}}],
            "appmsg_id": int(appmsg_id) if appmsg_id.isdigit() else 0,
            "is_use_flag": _as_int(context.get("is_use_flag"), 0),
            "template_version": str(context.get("template_version") or ""),
        }
        data = {
            "token": client.token,
            "lang": "zh_CN",
            "t": "ajax-response",
            "sub": "create",
            "type": "77",
            "AppMsgId": appmsg_id,
            "count": "1",
            "articlenum": "1",
            "data_seq": str(context.get("data_seq") or "0"),
            "isnew": "0",
            "ajax": "1",
            "isneedsave": "0",
            "autosave_log": "",
            "pre_timesend_set": "0",
            "operate_from": "Chrome",
            "title0": title,
            "author0": "",
            "digest0": digest,
            "content0": content_html,
            "sourceurl0": "",
            "fileid0": str(cover.get("file_id") or ""),
            "cdnurl0": str(cover.get("cdn_url") or ""),
            "show_cover_pic0": "1",
            "need_open_comment0": "1",
            "only_fans_can_comment0": "0",
            "copyright_type0": "0",
            "req": json.dumps(req, ensure_ascii=False),
        }
        response = client.post(
            "/cgi-bin/operate_appmsg",
            params={
                "t": "ajax-response",
                "sub": "create",
                "type": "77",
                "token": client.token,
                "lang": "zh_CN",
            },
            data=data,
        )
        result = WechatMpAdapter._response_json(response, "create_draft")
        draft_id = _find_field(
            result,
            ("msgid", "appmsgid", "appMsgId", "app_msg_id", "msg_id", "nested_msgid"),
        )
        if not draft_id:
            raise PlatformFailure(
                errors.PLATFORM,
                "公众号草稿已提交，但接口没有返回草稿 ID；请到草稿箱确认",
                detail=json.dumps(result, ensure_ascii=False)[:500],
            )
        return draft_id

    # ------------------------------------------------------------ 内容回收

    def fetch_published(
        self, account: Any, *, cursor: Any = 0, limit: int = 30
    ) -> dict[str, Any]:
        client = None
        try:
            session = self._session_from_account(account)
            client = WeChatClient(session, proxy=str(account["proxy"] or ""))
            self._ensure_token(client)
            fakeid = str(session.get("fakeid") or "")
            if not fakeid:
                # 新版后台首页不一定带 fakeid；只有旧版 appmsg 列表需要它，
                # 不能因为拿不到 fakeid 就放弃 appmsgpublish 列表。
                try:
                    fakeid = self._discover_fakeid(client)
                except (PlatformFailure, requests.RequestException):
                    fakeid = ""
            begin = max(0, int(cursor or 0))
            count = max(1, min(50, int(limit or 30)))
            candidates = [
                (
                    "/cgi-bin/appmsgpublish",
                    {
                        "sub": "list",
                        "begin": str(begin),
                        "count": str(count),
                        "token": client.token,
                        "lang": "zh_CN",
                        "f": "json",
                        "ajax": "1",
                    },
                ),
                (
                    "/cgi-bin/appmsg",
                    {
                        "action": "list_ex",
                        "begin": str(begin),
                        "count": str(count),
                        "fakeid": fakeid,
                        "type": "9",
                        "query": "",
                        "token": client.token,
                        "lang": "zh_CN",
                        "f": "json",
                        "ajax": "1",
                    },
                ),
                (
                    "/cgi-bin/appmsg",
                    {
                        "action": "list_ex",
                        "begin": str(begin),
                        "count": str(count),
                        "type": "9",
                        "token": client.token,
                        "lang": "zh_CN",
                        "f": "json",
                        "ajax": "1",
                    },
                ),
                (
                    "/cgi-bin/freepublish",
                    {
                        "t": "freepublish/list",
                        "begin": str(begin),
                        "count": str(count),
                        "token": client.token,
                        "lang": "zh_CN",
                        "f": "json",
                        "ajax": "1",
                    },
                ),
            ]
            last_message = ""
            for endpoint, params in candidates:
                response = client.get(endpoint, params=params)
                if "login" in response.url:
                    raise PlatformFailure(errors.AUTH, "公众号登录态已失效，请重新扫码登录")
                payload = _safe_json(response)
                if not isinstance(payload, dict):
                    last_message = "公众号后台返回非 JSON，接口可能已改版"
                    continue
                base = payload.get("base_resp") or {}
                ret = int(base.get("ret") or 0) if isinstance(base, dict) else 0
                if ret != 0:
                    errmsg = str(base.get("err_msg") or "")
                    if any(word in errmsg for word in ("登录", "invalid session")) or ret in {-6, 200003}:
                        raise PlatformFailure(errors.AUTH, "公众号登录态已失效，请重新扫码登录")
                    if any(word in errmsg for word in ("频繁", "频率", "次数")) or ret in {200013, 45009}:
                        raise PlatformFailure(errors.RATE, f"公众号操作受限：{errmsg or '请稍后再试'}")
                    last_message = errmsg or f"ret={ret}"
                    continue
                normalized, _container = _published_items(payload)
                next_cursor = begin + count if len(normalized) >= count else None
                self._persist(
                    account,
                    client,
                    {"fakeid": fakeid, "platform_id": fakeid, "user_id": fakeid},
                )
                return {
                    "ok": True,
                    "message": "成功",
                    "items": normalized[:count],
                    "next_cursor": next_cursor,
                }
            raise PlatformFailure(
                errors.PLATFORM,
                "没有找到公众号已发表列表接口，平台可能已改版",
                detail=last_message,
            )
        except PlatformFailure as exc:
            return {
                "ok": False,
                "message": exc.message,
                "items": [],
                "next_cursor": None,
                "kind": exc.kind,
            }
        except requests.RequestException as exc:
            logger.warning(f"公众号账号 {account['id']} 拉取文章列表网络异常: {exc}")
            return {
                "ok": False,
                "message": "网络异常，暂时无法拉取公众号文章",
                "items": [],
                "next_cursor": None,
                "kind": errors.NETWORK,
            }
        except Exception:  # noqa: BLE001
            logger.exception(f"公众号账号 {account['id']} 拉取文章列表异常")
            return {
                "ok": False,
                "message": "拉取公众号文章列表失败，请稍后重试",
                "items": [],
                "next_cursor": None,
            }
        finally:
            if client is not None:
                client.close()

    def fetch_comments(
        self, account: Any, note: Any, *, pages: int = 3
    ) -> dict[str, Any]:
        """读取公众号「精选留言」，严格只读。

        公众号后台不提供全量评论：接口有权限时返回精选留言，没有权限时返回
        明确的探测结论，不能伪装成「平台没有评论」。
        """
        client = None
        try:
            session = self._session_from_account(account)
            client = WeChatClient(session, proxy=str(account["proxy"] or ""))
            self._ensure_token(client)
            appmsgid = str(note["remote_note_id"] or "").strip()
            if not appmsgid.isdigit():
                return {
                    "ok": False,
                    "items": [],
                    "message": "该文章缺少 appmsgid，无法定位精选留言",
                }
            count = 20
            begin = 0
            items: list[dict[str, Any]] = []
            for _ in range(max(1, min(10, int(pages or 3)))):
                response = client.get(
                    "/mp/appmsgcomment",
                    params={
                        "action": "list_comment",
                        "appmsgid": appmsgid,
                        "idx": "1",
                        "begin": str(begin),
                        "count": str(count),
                        "token": client.token,
                        "lang": "zh_CN",
                        "f": "json",
                        "ajax": "1",
                    },
                )
                if "login" in response.url:
                    raise PlatformFailure(errors.AUTH, "公众号登录态已失效，请重新扫码登录")
                payload = _safe_json(response)
                if not isinstance(payload, dict):
                    return {
                        "ok": False,
                        "items": [],
                        "message": "公众号留言接口没有返回 JSON，可能没有留言权限或平台已改版",
                    }
                base = payload.get("base_resp") or {}
                try:
                    ret = int(base.get("ret") or 0) if isinstance(base, dict) else 0
                except (TypeError, ValueError):
                    ret = 0
                if ret != 0:
                    errmsg = str(base.get("err_msg") or "") if isinstance(base, dict) else ""
                    if ret in {-6, 200003} or any(
                        word in errmsg for word in ("登录", "invalid session")
                    ):
                        raise PlatformFailure(
                            errors.AUTH, "公众号登录态已失效，请重新扫码登录"
                        )
                    return {
                        "ok": False,
                        "items": [],
                        "message": (
                            f"公众号留言接口不可用：{errmsg}"
                            if errmsg
                            else f"公众号留言接口返回 ret={ret}，可能没有留言权限"
                        ),
                    }
                comments = _pick(
                    payload,
                    "elected_comment",
                    "elected_comment_list",
                    "comment",
                    default=[],
                )
                if isinstance(comments, dict):
                    comments = (
                        comments.get("elected_comment")
                        or comments.get("list")
                        or []
                    )
                if not isinstance(comments, list):
                    comments = []
                for item in comments:
                    normalized = normalize_comment(item)
                    remote_id = normalized.get("remote_comment_id") or ""
                    if remote_id:
                        items.append(normalized)
                    replies = []
                    if isinstance(item, dict):
                        replies = item.get("reply") or item.get("reply_list") or []
                    if isinstance(replies, dict):
                        replies = [replies]
                    if isinstance(replies, list):
                        for reply_index, reply in enumerate(replies):
                            reply_item = normalize_comment(
                                reply,
                                parent=remote_id,
                                is_reply=True,
                                index=reply_index,
                            )
                            if reply_item.get("remote_comment_id"):
                                items.append(reply_item)
                try:
                    total = int(_pick(payload, "count", "total", default=0) or 0)
                except (TypeError, ValueError):
                    total = 0
                begin += count
                if len(comments) < count or (total and begin >= total):
                    break
            self._persist(account, client)
            return {"ok": True, "items": items, "message": "成功"}
        except PlatformFailure as exc:
            return {"ok": False, "items": [], "message": exc.message, "kind": exc.kind}
        except requests.RequestException as exc:
            logger.warning(f"公众号账号 {account['id']} 读取留言网络异常: {exc}")
            return {
                "ok": False,
                "items": [],
                "message": "网络异常，暂时无法读取公众号精选留言",
                "kind": errors.NETWORK,
            }
        except Exception:  # noqa: BLE001
            logger.exception(f"公众号账号 {account['id']} 读取留言异常")
            return {
                "ok": False,
                "items": [],
                "message": "读取公众号精选留言失败，请稍后重试",
            }
        finally:
            if client is not None:
                client.close()

    @staticmethod
    def _discover_fakeid(client: WeChatClient) -> str:
        response = client.get(
            "/cgi-bin/home", params={"t": "home/index", "lang": "zh_CN", "token": client.token}
        )
        info = _parse_account(response.text, response.url)
        if info["fakeid"]:
            return info["fakeid"]
        raise PlatformFailure(errors.PLATFORM, "无法识别公众号 fakeid，平台可能已改版")

    def note_url(self, remote_note_id: str) -> str:
        value = str(remote_note_id or "").strip()
        if value.startswith("http"):
            return value
        if value.startswith("s/"):
            return f"https://mp.weixin.qq.com/{value}"
        return ""


def _local_asset_path(src: str) -> Path | None:
    """把预览里的图片地址还原成本地文件；外链和 data URI 不动。"""
    value = str(src or "").strip()
    if not value or value.startswith(("http://", "https://", "//", "data:")):
        return None
    clean = value.split("?")[0].split("#")[0]
    direct = Path(clean)
    if direct.is_file():
        return direct
    name = Path(clean).name
    if clean.startswith("/uploads/"):
        candidate = config.UPLOAD_DIR / name
    elif clean.startswith("/assets/draft-"):
        parts = clean.strip("/").split("/")
        if len(parts) < 3:
            return None
        candidate = config.ASSETS_DIR / parts[1] / "/".join(parts[2:])
    elif clean.startswith("/designs/"):
        parts = clean.strip("/").split("/")
        if len(parts) < 4:
            return None
        candidate = config.DESIGN_DIR.joinpath(*parts[1:])
    else:
        return None
    return candidate if candidate.is_file() else None


def _upload_inline_images(client: WeChatClient, html: str) -> str:
    """正文里引用本地文件的图片逐张上传到微信素材库，换回 CDN 地址。"""
    cache: dict[str, str] = {}

    def _replace(match: re.Match[str]) -> str:
        src = match.group(1)
        if src in cache:
            return f'src="{cache[src]}"'
        path = _local_asset_path(src)
        if path is None:
            return match.group(0)
        try:
            uploaded = WechatMpAdapter._upload_cover(client, str(path))
        except PlatformFailure as exc:
            logger.warning(f"公众号正文图片上传失败，保留原地址: {src} / {exc.message}")
            return match.group(0)
        url = str(uploaded.get("cdn_url") or "")
        if not url:
            return match.group(0)
        cache[src] = url
        return f'src="{url}"'

    return re.sub(r'src="([^"]+)"', _replace, html)


def _article_html(client: WeChatClient, payload: dict[str, Any]) -> str:
    """优先用编辑好的富文本正文，图片换成微信 CDN；没有富文本时按纯文本兜底。"""
    html = str(payload.get("body_html") or "").strip()
    theme = str(payload.get("wx_theme") or "").strip()
    if not html:
        html = richtext.plain_to_html(str(payload.get("desc") or ""))
    elif theme:
        # 内容与排版分开：正文只存原稿，发布这一刻才套主题。
        # 公众号不允许外链，先转尾注再套主题。
        html = richtext.apply_theme(richtext.external_links_to_footnotes(html), theme)
    else:
        html = richtext.sanitize_html(html)
    if not html:
        html = "<p><br/></p>"
    return richtext.wrap_article(_upload_inline_images(client, html))


__all__ = [
    "WechatMpAdapter",
    "WechatQrSession",
    "normalize_article",
    "PLATFORM_KEY",
]
