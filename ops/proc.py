# encoding: utf-8
"""子进程启动助手：Windows 下不弹控制台黑框。

桌面版以无控制台的窗口进程运行，此时再启动 ``node`` / ``ffmpeg`` / ``icacls``
这类控制台程序，Windows 默认会为每个子进程新建一个控制台窗口。扫码登录、
配图、密钥收紧都会频繁调用它们，结果就是界面上不停闪黑框。统一通过这里
启动，显式带上 ``CREATE_NO_WINDOW``。
"""

from __future__ import annotations

import os
import subprocess

CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)


def hidden_kwargs() -> dict:
    """给 ``subprocess.run/Popen`` 用的隐藏窗口参数（非 Windows 返回空）。"""
    return {"creationflags": CREATE_NO_WINDOW} if os.name == "nt" else {}


def run(cmd, **kwargs) -> subprocess.CompletedProcess:
    if os.name == "nt":
        kwargs["creationflags"] = int(kwargs.get("creationflags") or 0) | CREATE_NO_WINDOW
    return subprocess.run(cmd, **kwargs)
