"""自研帧捕获渲染器：用 Playwright 驱动 HyperFrames 合成，逐帧截图后交 ffmpeg 编码。
用法:
  python render_frames.py --fps 30 --out-dir .frames-30
  python render_frames.py --fps 60 --out-dir .frames-60 --start 0 --end 5 --limit 20
"""
import argparse
import subprocess
import sys
import time
from pathlib import Path

FILM = Path(r"d:\Projects\EchoQ-Ops\promo-video\film")
URL = (FILM / "index.html").as_uri()

ap = argparse.ArgumentParser()
ap.add_argument("--fps", type=int, default=30)
ap.add_argument("--out-dir", type=str, required=True)
ap.add_argument("--start", type=float, default=0.0)
ap.add_argument("--end", type=float, default=38.0)
ap.add_argument("--limit", type=int, default=0, help="最多渲染多少帧（0=不限），用于冒烟")
args = ap.parse_args()

from playwright.sync_api import sync_playwright  # noqa: E402

out_dir = FILM / args.out_dir
out_dir.mkdir(parents=True, exist_ok=True)

fps = args.fps
i0 = int(round(args.start * fps))
i1 = int(round(args.end * fps))
frames = list(range(i0, i1))
if args.limit:
    frames = frames[: args.limit]
total = len(frames)
print(f"render {total} frames @ {fps}fps -> {out_dir}", flush=True)

t_start = time.time()
with sync_playwright() as p:
    browser = p.chromium.launch(args=["--force-device-scale-factor=1", "--disable-lcd-text"])
    page = browser.new_page(viewport={"width": 1920, "height": 1080}, device_scale_factor=1)
    page.goto(URL, wait_until="domcontentloaded", timeout=30000)
    page.evaluate("document.fonts.ready")
    page.wait_for_timeout(800)
    # 等待 5 个原型 iframe 全部加载完成（合成内计数器），超时则尽力继续
    deadline = time.time() + 30
    while time.time() < deadline:
        loaded = page.evaluate("window.__iframesLoaded || 0")
        if loaded >= 5:
            break
        page.wait_for_timeout(250)
    page.wait_for_timeout(3500)  # 原型 hash 切视图 / 三端预览 / CSS 动画冻结全部就位
    ok = page.evaluate("!!(window.__timelines && window.__timelines['main'])")
    if not ok:
        browser.close()
        sys.exit("timeline main 不存在")
    # 原型帧清单 + 各面板的镜头时段（cue 只派发给可见面板，省跨进程开销）
    WINDOWS = {
        "view=topics": (4.6, 10.2),
        "view=studio": (10.2, 15.8),
        "view=library": (15.8, 21.4),
        "view=studio&mode=switch": (21.4, 27.0),
        "view=queue": (27.0, 32.8),
    }
    IFRAME_SEL = {
        "view=topics": "#shotTopics",
        "view=studio": "#shotStudio",
        "view=library": "#shotLibrary",
        "view=studio&mode=switch": "#shotPreview",
        "view=queue": "#shotQueue",
    }
    proto_frames = []
    for fr in page.frames:
        hash_part = fr.url.split("#", 1)[-1]
        if "prototype" in fr.url and hash_part in WINDOWS:
            proto_frames.append((fr, hash_part))
    if len(proto_frames) < 5:
        browser.close()
        sys.exit(f"原型帧绑定失败：仅 {len(proto_frames)}/5")

    for n, i in enumerate(frames):
        t = i / fps
        js = ("(() => { try { window.__timelines['main'].seek(" + f"{t:.6f}" +
              "); return 'ok'; } catch(e) { return 'ERR: ' + e.message; } })()")
        r = page.evaluate(js)
        if r != "ok":
            sys.exit(f"seek 失败 @t={t}: {r}")
        # 同步驱动原型内部编排（真实交互：打字/翻牌/状态流转）
        active = None
        for fr, key in proto_frames:
            lo, hi = WINDOWS[key]
            if lo - 1.5 <= t <= hi + 1.5:
                active = (fr, key)
            if t < lo - 1.5 or t > hi + 1.5:
                continue
            try:
                fr.evaluate("(function(t){ if (window.__protoCue) window.__protoCue(t); })(%f)" % t)
            except Exception:
                pass
        # 特写镜头：按原型实测区域，把当前模块推近放大
        if active:
            try:
                roi = active[0].evaluate(
                    "(function(t){ return window.__protoRoi ? window.__protoRoi(t) : null; })(%f)" % t)
            except Exception:
                roi = None
            if roi and roi.get("w"):
                sel = IFRAME_SEL[active[1]]
                sc = 930.0 / roi["w"]
                page.evaluate(
                    "document.querySelector('%s').style.transform = 'scale(%f) translate(%fpx, %fpx)'"
                    % (sel, sc, -roi["x"], -roi["y"]))
        page.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
        page.screenshot(path=str(out_dir / f"f{i:06d}.png"), timeout=20000)
        if n % 100 == 0 or n == total - 1:
            el = time.time() - t_start
            rate = (n + 1) / el if el > 0 else 0
            print(f"  {n+1}/{total}  t={t:.2f}s  {rate:.1f} f/s  elapsed {el:.0f}s", flush=True)

    browser.close()

print(f"capture done in {time.time()-t_start:.0f}s", flush=True)
