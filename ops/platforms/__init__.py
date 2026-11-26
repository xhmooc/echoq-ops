# encoding: utf-8
"""平台注册表。

业务代码只通过 :func:`get_platform` 取适配器，不直接 import 具体平台。
新增平台：在本目录实现子类 → 在 ``BUILTIN`` 登记 → 在 ``docs/PLATFORMS.md`` 清单
勾完剩余项即可。
"""

from __future__ import annotations

from typing import Any

from ops.platforms.base import ContentSpec, PlatformAdapter, PublishOutcome, VisibilityOption
from ops.platforms.douyin import DouyinAdapter, PLATFORM_KEY as DOUYIN
from ops.platforms.wechat_mp import WechatMpAdapter, PLATFORM_KEY as WECHAT_MP
from ops.platforms.xiaohongshu import XiaohongshuAdapter, PLATFORM_KEY as XIAOHONGSHU

DEFAULT_PLATFORM = XIAOHONGSHU

_ORDER = (XIAOHONGSHU, WECHAT_MP, DOUYIN)
_BUILTIN: dict[str, type[PlatformAdapter]] = {
    XIAOHONGSHU: XiaohongshuAdapter,
    WECHAT_MP: WechatMpAdapter,
    DOUYIN: DouyinAdapter,
}


def normalize(key: Any) -> str:
    """空值归到默认平台；未知平台直接报错，避免脏数据混进库。"""
    value = str(key or "").strip()
    if not value:
        return DEFAULT_PLATFORM
    if value not in _BUILTIN:
        raise ValueError(f"未知平台：{value}（可选：{'、'.join(_BUILTIN)}）")
    return value


def platform_label(key: Any) -> str:
    value = str(key or DEFAULT_PLATFORM)
    adapter = _BUILTIN.get(value)
    return adapter.name if adapter else value


def is_ready(key: Any) -> bool:
    adapter = _BUILTIN.get(str(key or DEFAULT_PLATFORM))
    return bool(adapter and adapter.status == "ready")


def get_platform(key: Any = "", accounts: Any = None) -> PlatformAdapter:
    """取适配器实例。需要读写账号会话的平台会注入账号管理器。"""
    value = normalize(key)
    if accounts is None and value == XIAOHONGSHU:
        from ops.accounts import AccountManager

        accounts = AccountManager()
    adapter_cls = _BUILTIN[value]
    if adapter_cls is XiaohongshuAdapter:
        return XiaohongshuAdapter(accounts)
    return adapter_cls(accounts)


def list_platforms() -> list[dict[str, Any]]:
    return [get_platform(key).describe() for key in _ORDER]


def platform_keys() -> list[str]:
    return list(_ORDER)


__all__ = [
    "DEFAULT_PLATFORM",
    "ContentSpec",
    "PlatformAdapter",
    "PublishOutcome",
    "VisibilityOption",
    "get_platform",
    "list_platforms",
    "normalize",
    "platform_keys",
    "platform_label",
    "is_ready",
]
