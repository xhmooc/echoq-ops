# encoding: utf-8
"""本地部署自检：确认解释器、依赖、Node 签名运行时、网络与登录配置。

用法：
    .venv\\Scripts\\python.exe check_env.py
或：
    run.cmd check
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys

OK = "[ OK ]"
BAD = "[FAIL]"
WARN = "[WARN]"
_failed = 0


def _report(level: str, title: str, detail: str = "") -> None:
    global _failed
    if level == BAD:
        _failed += 1
    print(f"{level} {title}" + (f" — {detail}" if detail else ""))


def check_python() -> None:
    version = ".".join(str(v) for v in sys.version_info[:3])
    if sys.version_info >= (3, 10):
        _report(OK, "Python 版本", f"{version} ({sys.executable})")
    else:
        _report(BAD, "Python 版本", f"{version}，需要 3.10+")


def check_packages() -> None:
    missing = []
    for module in (
        "execjs", "requests", "curl_cffi", "loguru", "dotenv", "retry",
        "openpyxl", "aiohttp", "cv2", "numpy", "qrcode", "cryptography", "PIL",
    ):
        try:
            __import__(module)
        except Exception as exc:  # noqa: BLE001
            missing.append(f"{module} ({exc.__class__.__name__})")
    if missing:
        _report(BAD, "Python 依赖", "缺少 " + ", ".join(missing))
    else:
        _report(OK, "Python 依赖", "requirements.txt 全部可导入")

    try:
        import vendor.apis.xhs_pc_apis  # noqa: F401
        import vendor.apis.xhs_creator_apis  # noqa: F401
        import vendor.apis.xhs_live  # noqa: F401
        import vendor.xhs_utils.xhs_auth  # noqa: F401
        import ops.service  # noqa: F401
        import ops.web.app  # noqa: F401
        _report(OK, "项目模块", "vendor.apis / vendor.xhs_utils / ops 导入正常")
    except Exception as exc:  # noqa: BLE001
        _report(BAD, "项目模块", f"{exc.__class__.__name__}: {exc}")


def check_node() -> None:
    node = shutil.which("node")
    if not node:
        _report(BAD, "Node.js", "未在 PATH 中找到 node，签名算法无法运行")
        return
    try:
        version = subprocess.run(
            [node, "--version"], capture_output=True, text=True, timeout=20,
        ).stdout.strip()
        _report(OK, "Node.js", f"{version} ({node})")
    except Exception as exc:  # noqa: BLE001
        _report(BAD, "Node.js", f"无法执行 node: {exc}")
        return

    try:
        out = subprocess.run(
            [node, "-e", "const C=require('crypto-js');process.stdout.write(C.MD5('x').toString())"],
            capture_output=True, text=True, timeout=30, cwd=os.path.dirname(os.path.abspath(__file__)),
        )
        if out.returncode == 0 and len(out.stdout.strip()) == 32:
            _report(OK, "Node 依赖", "crypto-js 可用（node_modules 已安装）")
        else:
            _report(BAD, "Node 依赖", (out.stderr or out.stdout).strip()[:200])
    except Exception as exc:  # noqa: BLE001
        _report(BAD, "Node 依赖", f"crypto-js 检查失败: {exc}")


def check_b1() -> None:
    try:
        from vendor.xhs_utils.xhs_pc.runtime import generate_b1

        value = generate_b1()
        _report(OK, "本地签名运行时", f"b1 生成成功，长度 {len(value)}")
    except Exception as exc:  # noqa: BLE001
        _report(BAD, "本地签名运行时", f"{exc.__class__.__name__}: {str(exc)[:200]}")


def check_network() -> None:
    try:
        from curl_cffi import requests as cr

        resp = cr.get("https://www.xiaohongshu.com/", impersonate="chrome", timeout=20)
        _report(OK, "网络连通", f"xiaohongshu.com -> HTTP {resp.status_code}")
    except Exception as exc:  # noqa: BLE001
        _report(BAD, "网络连通", f"{exc.__class__.__name__}: {str(exc)[:200]}")
        return

    try:
        from curl_cffi import requests as cr

        resp = cr.get(
            "https://as.xiaohongshu.com/api/sec/v1/ds?appId=xhs-pc-web",
            impersonate="chrome",
            timeout=20,
        )
        ok = resp.status_code == 200 and "getdss" in resp.text
        _report(OK if ok else BAD, "DS 接口", f"HTTP {resp.status_code}")
    except Exception as exc:  # noqa: BLE001
        _report(BAD, "DS 接口", f"{exc.__class__.__name__}: {str(exc)[:200]}")


def check_ops() -> None:
    try:
        from ops import config, db

        db.init_db()
        accounts = db.scalar("SELECT COUNT(*) FROM accounts", (), 0)
        drafts = db.scalar("SELECT COUNT(*) FROM drafts", (), 0)
        _report(
            OK,
            "运营台数据",
            f"{config.DB_PATH}（账号 {accounts}，草稿 {drafts}）",
        )
    except Exception as exc:  # noqa: BLE001
        _report(BAD, "运营台数据", f"{exc.__class__.__name__}: {exc}")


def check_login_config() -> bool:
    """检查 .env 与登录态；返回是否已处于登录状态。"""
    from dotenv import load_dotenv

    root = os.path.dirname(os.path.abspath(__file__))
    env_path = os.path.join(root, ".env")
    if not os.path.isfile(env_path):
        _report(WARN, ".env", "不存在；cookie 登录模式需要先复制 .env.example 为 .env")
        return False
    load_dotenv(env_path)
    cookies = (os.getenv("COOKIES") or "").strip()
    if cookies:
        _report(OK, "登录配置", f".env 中已填写 COOKIES（{len(cookies)} 字符）")
    else:
        _report(
            WARN,
            "登录配置",
            "COOKIES 为空：可填 .env 的 COOKIES，或把 vendor/spider/spider.py 的 login_type 改成 qrcode / phone",
        )
        return False

    try:
        from vendor.apis.xhs_pc_apis import XHS_Apis
        from vendor.xhs_utils.xhs_pc import XHSPcAuth

        api = XHS_Apis(XHSPcAuth.from_cookie(cookies)).bootstrap()
        success, msg, data = api.get_user_me()
        info = (data or {}).get("data") or {}
        if success and not info.get("guest"):
            _report(OK, "登录状态", f"已登录：{info.get('nickname', '未知')} (RedID: {info.get('red_id', '未知')})")
            return True
        _report(WARN, "登录状态", f"Cookie 可能已过期（{msg}），重新跑 run.cmd login")
    except Exception as exc:  # noqa: BLE001
        _report(WARN, "登录状态", f"会话校验失败：{exc.__class__.__name__}: {str(exc)[:120]}")
    return False




def main() -> int:
    print("Spider_XHS / 小红书运营台 本地部署自检")
    print("=" * 46)
    check_python()
    check_packages()
    check_node()
    check_b1()
    check_network()
    check_ops()
    logged_in = check_login_config()
    print("=" * 46)
    if _failed:
        print(f"发现 {_failed} 项失败，请按上面提示处理。")
        return 1
    if logged_in:
        print("全部就绪：run.cmd spider 可直接采集，run.cmd ops 可开运营台。")
    else:
        print("基础环境就绪；剩下的只是登录（run.cmd login / run.cmd login cookie）。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
