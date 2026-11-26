# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller 单文件打包配置：EchoQ-Ops.exe（托盘常驻）。"""

from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules

ROOT = Path(SPECPATH).resolve().parent

datas = [(str(ROOT / "ops" / "web" / "static"), "ops/web/static")]
binaries = []
hiddenimports = [
    "pystray._win32",
    "PIL.Image",
    "PIL.ImageDraw",
    *collect_submodules("ops"),
]
# 上游包统一放在 vendor/；JS/JSON/图片属于运行时资源，PyInstaller 只收 .py，必须手动带上。
for local in ("apis", "xhs_utils", "author"):
    datas.append((str(ROOT / "vendor" / local), f"vendor/{local}"))
    hiddenimports += collect_submodules(f"vendor.{local}")
# 签名脚本 require('crypto-js')；打包后 node 从脚本目录逐级向上找 node_modules，
# 少了它扫码登录会直接报 Cannot find module 'crypto-js'。
datas.append((str(ROOT / "node_modules" / "crypto-js"), "node_modules/crypto-js"))
# 选题素材库的默认导入路径只需要 topics 目录。
datas.append((str(ROOT / "xhs-promo" / "topics"), "xhs-promo/topics"))

# Playwright 自带 Node 驱动；curl_cffi 带原生 DLL，必须整包收进来。
for package in ("playwright", "curl_cffi"):
    package_datas, package_binaries, package_hidden = collect_all(package)
    datas += package_datas
    binaries += package_binaries
    hiddenimports += package_hidden

a = Analysis(
    [str(ROOT / "desktop.py")],
    pathex=[str(ROOT)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=[
        "tkinter",
        "matplotlib",
        "pandas",
        "scipy",
        "PyQt5",
        "PyQt6",
        "PySide2",
        "PySide6",
        "IPython",
        "pytest",
        "notebook",
        "pydoc_data",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name="EchoQ-Ops",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    icon=str(ROOT / "build" / "icon.ico"),
)
