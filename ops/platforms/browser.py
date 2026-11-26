# encoding: utf-8
"""浏览器自动化底座。

抖音创作者中心、微信公众平台都没有公开的「扫码登录 + 发布」API，稳定路线是
用真实浏览器完成登录与页面操作。本模块只负责生命周期与通用动作，不包含任何
平台业务：

- :func:`browser_session`：一次性的同步浏览器会话（发布、内容回收用），在调用
  线程内启停；
- :class:`BrowserWorker`：带独立线程的常驻浏览器（扫码登录用），因为扫码轮询
  会跨多个 HTTP 请求线程，而 Playwright 的同步对象不能跨线程使用；
- :func:`extract_qr_png`：从页面里取出二维码原图，取不到时截取二维码区域；
- :func:`storage_state` / :func:`cookie_header`：把登录态序列化进账号表。

Playwright 是可选依赖：没有安装时抛出 :class:`BrowserUnavailable`，由平台
适配器转成「需要安装浏览器依赖」的中文提示，而不是伪装成发布失败。
"""

from __future__ import annotations

import base64
import json
import os
import queue
import re
import threading
import time
from concurrent.futures import Future
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Callable, Iterator

from loguru import logger

from ops.platforms.errors import NETWORK, PLATFORM, PlatformFailure

# 关闭 webdriver 特征；不是万能的，但能避免一部分「检测到自动化」拦截。
_STEALTH_JS = """
Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
window.chrome = window.chrome || {runtime: {}};
"""


class BrowserUnavailable(RuntimeError):
    """Playwright 未安装或浏览器启动失败。"""


@dataclass(frozen=True)
class BrowserOptions:
    headless: bool = True
    channel: str = ""
    executable: str = ""
    proxy: str = ""
    timeout_ms: int = 45_000

    @classmethod
    def from_env(cls, *, headless: bool | None = None) -> "BrowserOptions":
        raw_headless = os.getenv("OPS_BROWSER_HEADLESS", "1").strip().lower()
        default_headless = raw_headless not in {"0", "false", "no", "off"}
        channel = os.getenv("OPS_BROWSER_CHANNEL", "").strip()
        if not channel and os.name == "nt":
            # Windows 上优先用系统 Edge，避免额外下载 ~150MB 的 Chromium。
            edge = os.path.join(
                os.getenv("ProgramFiles(x86)", "C:\\Program Files (x86)"),
                "Microsoft",
                "Edge",
                "Application",
                "msedge.exe",
            )
            if os.path.isfile(edge):
                channel = "msedge"
        return cls(
            headless=default_headless if headless is None else bool(headless),
            channel=channel,
            executable=os.getenv("OPS_BROWSER_EXECUTABLE", "").strip(),
            proxy=os.getenv("OPS_BROWSER_PROXY", "").strip(),
            timeout_ms=max(5_000, int(os.getenv("OPS_BROWSER_TIMEOUT_MS", "45000") or 45000)),
        )

    def launch_kwargs(self) -> dict[str, Any]:
        """启动参数。

        扫码默认 ``headless=True``，由 Chromium 自己保证不创建任何窗口，
        不再用「窗口坐标挪到屏幕外」这种仍会出现在任务栏的做法。
        """
        kwargs: dict[str, Any] = {
            "headless": self.headless,
            "args": [
                "--no-sandbox",
                "--disable-blink-features=AutomationControlled",
                "--disable-dev-shm-usage",
                "--lang=zh-CN",
            ],
        }
        if self.executable:
            kwargs["executable_path"] = self.executable
        elif self.channel:
            kwargs["channel"] = self.channel
        return kwargs

    def context_kwargs(self, storage_state: Any = None) -> dict[str, Any]:
        kwargs: dict[str, Any] = {
            "locale": "zh-CN",
            "timezone_id": "Asia/Shanghai",
            "viewport": {"width": 1440, "height": 960},
        }
        if storage_state:
            kwargs["storage_state"] = storage_state
        if self.proxy:
            server = self.proxy if "://" in self.proxy else f"http://{self.proxy}"
            kwargs["proxy"] = {"server": server}
        return kwargs


def qr_mode() -> str:
    """扫码浏览器固定 ``headless``。

    不再提供「启动即有窗口」的开关：唯一允许出现窗口的路径是用户点击
    「打开验证窗口」后由 :meth:`open_window` 显式启动可见浏览器。
    保留本函数是为了让调用方/自检仍能读到当前模式，恒为 ``headless``。
    """
    return "headless"


def qr_headless() -> bool:
    """扫码固定完全无头：不创建窗口，任务栏也不会出现图标。"""
    return True


def _require_playwright():
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:  # pragma: no cover - 依赖缺失时才会触发
        raise BrowserUnavailable(
            "缺少浏览器自动化依赖 Playwright。请执行："
            ".\\.venv\\Scripts\\python.exe -m pip install playwright "
            "（Windows 会复用系统 Edge，无需再下载 Chromium）"
        ) from exc
    return sync_playwright


def _launch(playwright, options: BrowserOptions):
    try:
        return playwright.chromium.launch(**options.launch_kwargs())
    except Exception as first:  # noqa: BLE001
        # 指定的 channel 不可用时，退回 Playwright 自带 Chromium。
        if options.channel and not options.executable:
            logger.warning(f"浏览器 channel={options.channel} 启动失败，尝试内置 Chromium: {first}")
            fallback = BrowserOptions(
                headless=options.headless,
                channel="",
                executable="",
                proxy=options.proxy,
                timeout_ms=options.timeout_ms,
            )
            try:
                return playwright.chromium.launch(**fallback.launch_kwargs())
            except Exception as second:  # noqa: BLE001
                raise BrowserUnavailable(
                    "无法启动浏览器。请确认本机已安装 Edge/Chrome，"
                    "或执行 playwright install chromium；"
                    f"错误：{second.__class__.__name__}"
                ) from second
        raise BrowserUnavailable(
            f"无法启动浏览器（{first.__class__.__name__}）。"
            "请确认本机浏览器可正常打开，或设置 OPS_BROWSER_EXECUTABLE 指向浏览器路径。"
        ) from first


def _new_context(browser, options: BrowserOptions, storage_state: Any = None):
    context = browser.new_context(**options.context_kwargs(storage_state))
    try:
        context.add_init_script(_STEALTH_JS)
    except Exception:  # noqa: BLE001
        pass
    context.set_default_timeout(options.timeout_ms)
    context.set_default_navigation_timeout(options.timeout_ms)
    return context


def _process_rows() -> list[dict[str, Any]]:
    """读取当前进程的整棵进程树（Windows 用 CIM，其它系统读 /proc）。

    只为扫码会话留证据用：进程命令行能直接证明 Chromium 是以 ``--headless``
    启动的，而不是「有窗口但被挪走」。
    """
    if os.name == "nt":
        try:
            from ops import proc

            output = proc.run(
                [
                    "powershell",
                    "-NoProfile",
                    "-Command",
                    "Get-CimInstance Win32_Process | "
                    "Select-Object ProcessId,ParentProcessId,Name,CommandLine | "
                    "ConvertTo-Json -Compress",
                ],
                capture_output=True,
                text=True,
                timeout=25,
                check=False,
            ).stdout
            rows = json.loads(output or "[]")
            if isinstance(rows, dict):
                rows = [rows]
            return [row for row in rows if isinstance(row, dict)]
        except Exception:  # noqa: BLE001
            return []
    rows: list[dict[str, Any]] = []
    try:
        for name in os.listdir("/proc"):
            if not name.isdigit():
                continue
            try:
                with open(f"/proc/{name}/stat", "r", encoding="utf-8", errors="ignore") as handle:
                    fields = handle.read().split()
                with open(f"/proc/{name}/cmdline", "rb") as handle:
                    cmdline = handle.read().replace(b"\x00", b" ").decode("utf-8", "ignore")
            except OSError:
                continue
            rows.append(
                {
                    "ProcessId": int(name),
                    "ParentProcessId": int(fields[3]) if len(fields) > 3 else 0,
                    "Name": (fields[1] if len(fields) > 1 else "").strip("()"),
                    "CommandLine": cmdline.strip(),
                }
            )
    except OSError:
        return []
    return rows


def _visible_window_count(pids: set[int]) -> int:
    """统计这些进程名下的可见顶层窗口数量（有标题的才算任务栏窗口）。"""
    if os.name != "nt" or not pids:
        return 0
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32  # type: ignore[attr-defined]
        total = 0

        @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        def _callback(hwnd, _lparam):
            nonlocal total
            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            if pid.value in pids and user32.IsWindowVisible(hwnd):
                if user32.GetWindowTextLengthW(hwnd) > 0:
                    total += 1
            return True

        user32.EnumWindows(_callback, 0)
        return total
    except Exception:  # noqa: BLE001
        return 0


def browser_diagnostics() -> dict[str, Any]:
    """记录本次扫码会话的浏览器进程证据。

    返回里的 ``headless_flag`` 来自真实进程命令行，``visible_windows`` 来自
    Windows 顶层窗口枚举；两者组合即可核对「有没有弹出窗口」。
    """
    rows = _process_rows()
    children: dict[int, list[dict[str, Any]]] = {}
    for row in rows:
        try:
            parent = int(row.get("ParentProcessId") or 0)
        except (TypeError, ValueError):
            continue
        children.setdefault(parent, []).append(row)

    root = os.getpid()
    stack = [root]
    seen: set[int] = set()
    descendants: list[dict[str, Any]] = []
    while stack:
        current = stack.pop()
        for child in children.get(current, []):
            pid = int(child.get("ProcessId") or 0)
            if not pid or pid in seen:
                continue
            seen.add(pid)
            descendants.append(child)
            stack.append(pid)

    browsers: list[dict[str, Any]] = []
    for row in descendants:
        name = str(row.get("Name") or "")
        if not re.search(r"msedge|chrome|chromium", name, re.IGNORECASE):
            continue
        command = str(row.get("CommandLine") or "")
        browsers.append(
            {
                "pid": int(row.get("ProcessId") or 0),
                "name": name,
                "role": "helper" if "--type=" in command else "browser",
                "headless_flag": "--headless" in command,
                # 命令行很长，headless 标志常在第 600 字之后；单独摘出来便于核对。
                "headless_args": [
                    part for part in command.split() if part.startswith("--headless")
                ],
                "command_line": command[:600],
            }
        )
    pids = {item["pid"] for item in browsers if item["pid"]}
    mains = [item for item in browsers if item["role"] == "browser"]
    return {
        # 只看浏览器主进程，helper 进程本来就不会带 --headless。
        "headless_flag": (all(item["headless_flag"] for item in mains) if mains else None),
        "visible_windows": _visible_window_count(pids),
        "browser_processes": browsers,
        "process_count": len(browsers),
    }


@contextmanager
def browser_session(
    *,
    storage_state: Any = None,
    headless: bool | None = None,
    proxy: str = "",
    options: BrowserOptions | None = None,
) -> Iterator[Any]:
    """在当前线程启动一次浏览器，退出时自动关闭。

    发布/回收都是低频操作，每次新起浏览器比长期持有更不容易被平台判定为
    异常会话；登录态通过 ``storage_state`` 注入。
    """
    sync_playwright = _require_playwright()
    opts = options or BrowserOptions.from_env(headless=headless)
    if proxy:
        opts = BrowserOptions(
            headless=opts.headless,
            channel=opts.channel,
            executable=opts.executable,
            proxy=proxy,
            timeout_ms=opts.timeout_ms,
        )
    with sync_playwright() as playwright:
        browser = _launch(playwright, opts)
        context = _new_context(browser, opts, storage_state)
        try:
            yield context
        finally:
            try:
                context.close()
            except Exception:  # noqa: BLE001
                pass
            try:
                browser.close()
            except Exception:  # noqa: BLE001
                pass


class BrowserWorker:
    """常驻浏览器线程，供扫码登录这种跨请求的多步流程使用。"""

    def __init__(
        self,
        *,
        storage_state: Any = None,
        headless: bool | None = None,
        proxy: str = "",
    ) -> None:
        self.options = BrowserOptions.from_env(headless=headless)
        if proxy:
            self.options = BrowserOptions(
                headless=self.options.headless,
                channel=self.options.channel,
                executable=self.options.executable,
                proxy=proxy,
                timeout_ms=self.options.timeout_ms,
            )
        self._storage_state = storage_state
        self._queue: queue.Queue = queue.Queue()
        self._ready = threading.Event()
        self._closed = threading.Event()
        self._error: Exception | None = None
        self._thread = threading.Thread(target=self._loop, name="ops-browser", daemon=True)
        self._thread.start()
        if not self._ready.wait(timeout=60):
            raise BrowserUnavailable("浏览器启动超时，请检查本机浏览器是否可用")
        if self._error is not None:
            raise BrowserUnavailable(str(self._error))

    # ------------------------------------------------------------ 线程内部

    def _loop(self) -> None:  # pragma: no cover - 需要真实浏览器
        sync_playwright = None
        playwright = browser = context = None
        try:
            sync_playwright = _require_playwright()
            playwright = sync_playwright().start()
            browser = _launch(playwright, self.options)
            context = _new_context(browser, self.options, self._storage_state)
            self._ready.set()
            while True:
                item = self._queue.get()
                if item is None:
                    break
                fn, args, kwargs, future = item
                try:
                    result = fn(context, *args, **kwargs)
                except Exception as exc:  # noqa: BLE001
                    future.set_exception(exc)
                else:
                    future.set_result(result)
        except Exception as exc:  # noqa: BLE001
            self._error = exc
            self._ready.set()
        finally:
            try:
                if context is not None:
                    context.close()
            except Exception:  # noqa: BLE001
                pass
            try:
                if browser is not None:
                    browser.close()
            except Exception:  # noqa: BLE001
                pass
            try:
                if playwright is not None:
                    playwright.stop()
            except Exception:  # noqa: BLE001
                pass
            self._closed.set()

    # ------------------------------------------------------------ 对外

    def call(self, fn: Callable[..., Any], *args: Any, timeout: float = 90, **kwargs: Any) -> Any:
        if self._closed.is_set():
            raise BrowserUnavailable("浏览器会话已关闭")
        future: Future = Future()
        self._queue.put((fn, args, kwargs, future))
        try:
            return future.result(timeout=max(1.0, float(timeout)))
        except TimeoutError as exc:
            raise PlatformFailure(NETWORK, "浏览器操作超时，请稍后重试") from exc

    def close(self) -> None:
        if self._closed.is_set():
            return
        self._queue.put(None)
        self._thread.join(timeout=8)
        self._closed.set()

    @property
    def closed(self) -> bool:
        return self._closed.is_set()


# ---------------------------------------------------------------- 通用页面动作


def goto(page, url: str, *, wait_until: str = "domcontentloaded", timeout: float = 45_000):
    try:
        page.goto(url, wait_until=wait_until, timeout=timeout)
    except Exception as exc:  # noqa: BLE001
        raise PlatformFailure(NETWORK, "打开平台页面失败，请检查网络后重试", detail=str(exc)) from exc


def first_visible(page, selectors: list[str]):
    for selector in selectors:
        locator = page.locator(selector).first
        try:
            if locator.count() and locator.is_visible():
                return locator
        except Exception:  # noqa: BLE001
            continue
    return None


def text_of(page, selectors: list[str], default: str = "") -> str:
    locator = first_visible(page, selectors)
    if locator is None:
        return default
    try:
        return str(locator.inner_text(timeout=3_000) or "").strip()
    except Exception:  # noqa: BLE001
        return default


def _decode_data_url(src: str) -> bytes:
    if not src.startswith("data:image/"):
        return b""
    try:
        head, payload = src.split(",", 1)
        if ";base64" not in head:
            return b""
        return base64.b64decode(payload)
    except (ValueError, TypeError):
        return b""


def has_qr(page, img_selectors: list[str] | None = None) -> bool:
    for selector in img_selectors or []:
        try:
            locator = page.locator(selector).first
            if locator.count() and locator.is_visible():
                return True
        except Exception:  # noqa: BLE001
            continue
    try:
        found = page.evaluate(
            """() => Array.from(document.querySelectorAll('img')).some((img) => {
                if (!img.src || !img.src.startsWith('data:image/')) return false;
                const w = img.naturalWidth || img.width;
                const h = img.naturalHeight || img.height;
                return w >= 120 && w <= 400 && h > 0 && Math.abs(w / h - 1) < 0.15;
            })"""
        )
        return bool(found)
    except Exception:  # noqa: BLE001
        return False


def wait_for_qr(page, img_selectors: list[str] | None = None, timeout: float = 30) -> bool:
    return wait_until(lambda: has_qr(page, img_selectors), timeout=timeout, interval=0.6)


def _enhance_qr(data: bytes) -> bytes:
    """给过小的二维码补白边并整数放大。

    公众号登录页的二维码原图只有约 122px，没有静默区，直接显示既小又难扫；
    这里按最近邻整数放大到 300px 以上并补白边，不改动码点内容。
    """
    try:
        import io

        from PIL import Image

        image = Image.open(io.BytesIO(data))
        longest = max(image.size)
        if longest >= 280:
            return data
        # 向上取整到 300px 以上：公众号原图 122px 时放 3 倍，手机和
        # cv2 这类解码器都能稳定识别。
        scale = max(2, -(-300 // max(1, longest)))
        image = image.resize(
            (image.width * scale, image.height * scale), Image.NEAREST
        ).convert("RGB")
        pad = max(12, image.width // 10)
        canvas = Image.new("RGB", (image.width + pad * 2, image.height + pad * 2), "white")
        canvas.paste(image, (pad, pad))
        buffer = io.BytesIO()
        canvas.save(buffer, format="PNG")
        return buffer.getvalue()
    except Exception:  # noqa: BLE001
        return data


def extract_qr_png(
    page,
    *,
    img_selectors: list[str],
    container_selectors: list[str] | None = None,
) -> bytes:
    """优先取二维码原图（data URL），取不到时截取二维码容器。

    很多平台把二维码的 class 名做成随机哈希（抖音就是这样），只靠选择器会
    失效。最后一步按「正方形 + 尺寸在 120-400px 的 data:image」兜底识别。
    """
    for selector in img_selectors:
        locator = page.locator(selector).first
        try:
            if not locator.count():
                continue
            src = locator.get_attribute("src", timeout=3_000) or ""
            data = _decode_data_url(src)
            if data:
                return _enhance_qr(data)
            if src.startswith("http"):
                response = page.request.get(src)
                if response.ok:
                    body = response.body()
                    if body:
                        return _enhance_qr(body)
        except Exception:  # noqa: BLE001
            continue
    # 通用兜底：登录页上最大的正方形 data:image 基本就是二维码。
    try:
        candidates = page.evaluate(
            """() => Array.from(document.querySelectorAll('img'))
                .filter((img) => {
                    if (!img.src || !img.src.startsWith('data:image/')) return false;
                    const w = img.naturalWidth || img.width;
                    const h = img.naturalHeight || img.height;
                    return w >= 120 && w <= 400 && h > 0 && Math.abs(w / h - 1) < 0.15;
                })
                .map((img) => img.src)"""
        )
        for src in candidates or []:
            data = _decode_data_url(str(src))
            if data:
                return _enhance_qr(data)
    except Exception:  # noqa: BLE001
        pass
    # 无头模式下元素截图同样有效；再补一层「按包围盒裁剪」的兜底。
    for selector in container_selectors or []:
        locator = page.locator(selector).first
        try:
            if locator.count() and locator.is_visible():
                try:
                    data = locator.screenshot(type="png")
                except Exception:  # noqa: BLE001
                    box = locator.bounding_box()
                    data = page.screenshot(clip=box, type="png") if box else b""
                if data:
                    return _enhance_qr(data)
        except Exception:  # noqa: BLE001
            continue
    # 最后：定位页面上最大的正方形图片，按包围盒裁剪后截图。
    try:
        rect = page.evaluate(
            """() => {
                const imgs = Array.from(document.querySelectorAll('img')).filter((img) => {
                    const w = img.naturalWidth || img.width;
                    const h = img.naturalHeight || img.height;
                    return w >= 120 && h >= 120 && Math.abs(w / h - 1) < 0.15;
                });
                if (!imgs.length) return null;
                imgs.sort((a, b) => (b.naturalWidth || 0) - (a.naturalWidth || 0));
                const r = imgs[0].getBoundingClientRect();
                if (r.width < 80 || r.height < 80) return null;
                return {x: r.x, y: r.y, width: r.width, height: r.height};
            }"""
        )
        if isinstance(rect, dict):
            data = page.screenshot(clip=rect, type="png")
            if data:
                return _enhance_qr(data)
    except Exception:  # noqa: BLE001
        pass
    raise PlatformFailure(
        PLATFORM,
        "没有在页面上找到登录二维码，平台页面可能已改版",
        detail="二维码元素不存在",
    )


def storage_state(context) -> dict[str, Any]:
    try:
        state = context.storage_state()
        return state if isinstance(state, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


def cookies_of(context) -> list[dict[str, Any]]:
    try:
        return list(context.cookies() or [])
    except Exception:  # noqa: BLE001
        return []


def cookie_header(cookies: list[dict[str, Any]], domain: str = "") -> str:
    parts: list[str] = []
    for item in cookies:
        name = str(item.get("name") or "")
        if not name:
            continue
        if domain and domain not in str(item.get("domain") or ""):
            continue
        parts.append(f"{name}={item.get('value') or ''}")
    return "; ".join(parts)


def cookie_value(cookies: list[dict[str, Any]], name: str) -> str:
    for item in cookies:
        if str(item.get("name") or "") == name:
            return str(item.get("value") or "")
    return ""


def wait_until(predicate: Callable[[], bool], timeout: float = 30, interval: float = 0.8) -> bool:
    deadline = time.monotonic() + max(1.0, float(timeout))
    while time.monotonic() < deadline:
        try:
            if predicate():
                return True
        except Exception:  # noqa: BLE001
            pass
        time.sleep(interval)
    return False


def dumps_state(state: dict[str, Any]) -> str:
    return json.dumps(state, ensure_ascii=False, default=str)


__all__ = [
    "BrowserUnavailable",
    "BrowserOptions",
    "BrowserWorker",
    "browser_diagnostics",
    "browser_session",
    "cookie_header",
    "cookie_value",
    "cookies_of",
    "dumps_state",
    "extract_qr_png",
    "first_visible",
    "goto",
    "has_qr",
    "qr_headless",
    "qr_mode",
    "storage_state",
    "text_of",
    "wait_for_qr",
    "wait_until",
]
