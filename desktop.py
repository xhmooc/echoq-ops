# encoding: utf-8
"""开发用启动器：托盘常驻 + 打开浏览器（不是对外交付形态）。

对外只交付 Electron 桌面版（electron/）；这里仅用于本地调试：
``python desktop.py`` 打开浏览器 + 托盘，``--headless`` 只跑服务。
"""

from __future__ import annotations

import argparse
import asyncio
import os
import socket
import threading
import time
import traceback
import webbrowser

APP_NAME = "应声运营"


def _log(text: str) -> None:
    try:
        from ops import config

        config.ensure_dirs()
        with (config.LOG_DIR / "launcher.log").open("a", encoding="utf-8") as handle:
            handle.write(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {text}\n")
    except Exception:
        pass


def _alert(text: str) -> None:
    """无控制台时用系统弹窗告知启动失败。"""
    _log(text)
    try:
        import ctypes

        ctypes.windll.user32.MessageBoxW(None, text, APP_NAME, 0x10)
    except Exception:
        pass


def _port_in_use(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.4)
        return sock.connect_ex((host, port)) == 0


def _serve(host: str, port: int, ready: threading.Event, holder: dict) -> None:
    """在后台线程里跑 aiohttp，主线程留给托盘图标。"""
    try:
        from aiohttp import web

        from ops import config, db
        from ops.service import OpsService
        from ops.web.app import create_app
        from ops.worker import start_background

        config.configure_logging()
        config.ensure_dirs()
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        holder["loop"] = loop

        service = OpsService()
        app = create_app(service)
        if db.get_int_setting("worker_auto_start", 1) == 1:
            start_background(service.accounts, service.queue, service)

        runner = web.AppRunner(app)
        loop.run_until_complete(runner.setup())
        site = web.TCPSite(runner, host, port)
        loop.run_until_complete(site.start())
        holder["runner"] = runner
        _log(f"服务已启动: http://{host}:{port} 数据目录 {config.DATA_DIR}")
        ready.set()

        loop.run_forever()
        loop.run_until_complete(runner.cleanup())
        loop.close()
        _log("服务已退出")
    except Exception:
        _alert("运营台启动失败：\n" + traceback.format_exc(limit=3))
        ready.set()


def _icon_image():
    """用 Pillow 现画托盘图标，避免额外资源文件。"""
    from PIL import Image, ImageDraw

    image = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((3, 3, 61, 61), radius=15, fill=(255, 36, 66, 255))
    draw.rounded_rectangle((17, 15, 26, 49), radius=4, fill=(255, 255, 255, 255))
    draw.rounded_rectangle((31, 15, 40, 49), radius=4, fill=(255, 255, 255, 150))
    return image


def _quit(icon, holder: dict) -> None:
    loop = holder.get("loop")
    if loop:
        loop.call_soon_threadsafe(loop.stop)
    icon.stop()


def _run_tray(holder: dict, url: str) -> None:
    try:
        import pystray
    except Exception:
        _log("pystray 不可用，改为无托盘常驻（结束进程即可退出）")
        threading.Event().wait()
        return

    from ops import config

    menu = pystray.Menu(
        pystray.MenuItem("打开发布台", lambda: webbrowser.open(url), default=True),
        pystray.MenuItem("打开数据目录", lambda: os.startfile(config.DATA_DIR)),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("退出", lambda icon, item: _quit(icon, holder)),
    )
    pystray.Icon("echoq-ops", _icon_image(), APP_NAME, menu).run()


def _check_browser() -> int:
    """打包自检：确认 Playwright 能启动 Chromium（退出码 0 通过）。"""
    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as playwright:
            try:
                browser = playwright.chromium.launch(headless=True)
            except Exception:  # noqa: BLE001
                # 自带 Chromium 没装时退回系统 Edge，和配图渲染保持一致。
                browser = playwright.chromium.launch(channel="msedge", headless=True)
            page = browser.new_page()
            page.set_content("<h1>ok</h1>")
            text = page.inner_text("h1")
            browser.close()
        _log(f"浏览器自检通过: {text}")
        return 0
    except Exception:
        _log("浏览器自检失败：\n" + traceback.format_exc(limit=5))
        return 1


def main(argv: list[str] | None = None) -> int:
    from ops import config

    parser = argparse.ArgumentParser(description=f"{APP_NAME} 开发启动器")
    parser.add_argument("--host", default=config.DEFAULT_HOST)
    parser.add_argument("--port", type=int, default=config.DEFAULT_PORT)
    parser.add_argument("--no-browser", action="store_true", help="只启动服务，不打开浏览器")
    parser.add_argument("--headless", action="store_true", help="只跑服务，供 Electron 外壳调用")
    parser.add_argument("--check-browser", action="store_true", help="只做浏览器自检后退出")
    args = parser.parse_args(argv)

    if args.check_browser:
        return _check_browser()

    url = f"http://{args.host}:{args.port}"
    # 已在运行：直接唤起浏览器，不再起第二个托盘。
    if _port_in_use(args.host, args.port):
        if not args.no_browser and not args.headless:
            webbrowser.open(url)
        return 0

    ready = threading.Event()
    holder: dict = {}
    threading.Thread(
        target=_serve, args=(args.host, args.port, ready, holder), daemon=True
    ).start()
    if not ready.wait(60) or "runner" not in holder:
        _alert(f"运营台没能在 60 秒内启动，请查看日志：{config.LOG_DIR / 'launcher.log'}")
        return 1

    if args.headless:
        # 交给 Electron 外壳管理窗口与托盘，这边只保持服务常驻。
        threading.Event().wait()
        return 0
    if not args.no_browser:
        webbrowser.open(url)
    _run_tray(holder, url)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
