# encoding: utf-8
"""平台适配器接口。

账号、草稿、队列任务、发布记录、计划任务都带 ``platform`` 字段，业务骨架
（入队、限速、重试、定时、记录）在各平台之间共用；平台之间的差异全部收敛到
本模块的 :class:`PlatformAdapter`：

- 内容类型与素材规格（标题/正文字数、图片数量、是否必须视频）；
- 可见范围选项、话题写法；
- 默认日限额与最小发布间隔；
- 登录方式、登录态检查；
- 发布、已发布内容回收。

新增平台只需要在 ``ops/platforms/`` 下实现一个子类并在 ``__init__.py`` 登记，
不需要改表结构，也不需要改发布队列/调度器/页面骨架。详见 ``docs/PLATFORMS.md``。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class ContentSpec:
    """一种内容类型的硬规格。发布前校验与页面提示都用这一份。"""

    key: str
    label: str
    media_type: str  # 对应 drafts.media_type: image / video
    title_max: int
    desc_max: int
    min_images: int = 0
    max_images: int = 0
    requires_media: bool = False
    topics: str = "hashtag"  # hashtag / topic / none
    notes: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "label": self.label,
            "media_type": self.media_type,
            "title_max": self.title_max,
            "desc_max": self.desc_max,
            "min_images": self.min_images,
            "max_images": self.max_images,
            "requires_media": self.requires_media,
            "topics": self.topics,
            "notes": self.notes,
        }


@dataclass(frozen=True)
class VisibilityOption:
    value: int
    label: str
    note: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {"value": self.value, "label": self.label, "note": self.note}


@dataclass
class PublishOutcome:
    """一次发布的归一化结果。

    ``kind`` 是失败分类（见 ``ops.platforms.errors``）：队列据此决定是否退避
    重试；留空时由平台适配器的 ``classify_failure()`` 兜底。
    """

    success: bool
    message: str
    result: Any = field(default_factory=dict)
    kind: str = ""

    @property
    def status(self) -> str:
        return "success" if self.success else "failed"


class PlatformAdapter:
    """平台适配器基类：只放接口约定与通用校验，具体平台覆盖实现。"""

    key: str = ""
    name: str = ""
    short: str = ""
    status: str = "planned"  # ready / planned
    color: str = ""
    login_hint: str = ""
    docs: str = ""
    topic_style: str = "hashtag"
    default_content_type: str = ""
    content_types: tuple[ContentSpec, ...] = ()
    visibility_options: tuple[VisibilityOption, ...] = ()
    default_daily_limit: int = 3
    default_min_interval_sec: int = 2700
    # 已经预留但尚未实现的能力；页面据此显示「接入位」。
    features: dict[str, bool] = {
        "login_cookie": False,
        "login_qr": False,
        "publish": False,
        "fetch_published": False,
        "fetch_comments": False,
        "schedule": True,
    }
    # 评论能力：read=可读取；probe=需先探测权限（如公众号精选留言）；none=不支持。
    comments_mode: str = "none"
    # 已发布内容的数据来源说明（里程碑 2 的页面直接展示）。
    data_sources: tuple[str, ...] = ()

    # ------------------------------------------------------------ 规格

    def spec(self, content_type: str = "") -> ContentSpec:
        target = content_type or self.default_content_type
        for item in self.content_types:
            if item.key == target:
                return item
        if not self.content_types:
            raise NotImplementedError(f"{self.name} 还没有声明内容类型")
        return self.content_types[0]

    def spec_for_media(self, media_type: str = "") -> ContentSpec:
        media = media_type or "image"
        for item in self.content_types:
            if item.media_type == media:
                return item
        return self.spec()

    def supports(self, content_type: str) -> bool:
        return any(item.key == content_type for item in self.content_types)

    @property
    def ready(self) -> bool:
        return self.status == "ready"

    def validate(self, payload: dict[str, Any], content_type: str = "") -> list[str]:
        """通用发布前校验；平台可以在调用后追加自己的规则。"""
        spec = (
            self.spec(content_type)
            if content_type
            else self.spec_for_media(str(payload.get("media_type") or ""))
        )
        problems: list[str] = []
        title = str(payload.get("title") or "").strip()
        desc = str(payload.get("desc") or "").strip()
        images = list(payload.get("images") or [])
        if not title:
            problems.append("标题不能为空")
        elif len(title) > spec.title_max:
            problems.append(f"标题最多 {spec.title_max} 字，当前 {len(title)} 字")
        if not desc:
            problems.append("正文不能为空")
        elif len(desc) > spec.desc_max:
            problems.append(f"正文最多 {spec.desc_max} 字，当前 {len(desc)} 字")
        if spec.requires_media and not images:
            problems.append(f"{spec.label}需要至少 {max(1, spec.min_images)} 个素材")
        if images and len(images) < spec.min_images:
            problems.append(f"{spec.label}至少需要 {spec.min_images} 个素材")
        if spec.max_images and len(images) > spec.max_images:
            problems.append(f"{spec.label}最多 {spec.max_images} 个素材，当前 {len(images)} 个")
        return problems

    # ------------------------------------------------------------ 描述

    def describe(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "name": self.name,
            "short": self.short or self.name,
            "status": self.status,
            "status_text": "已接入" if self.ready else "接入位已预留",
            "ready": self.ready,
            "color": self.color,
            "login_hint": self.login_hint,
            "docs": self.docs,
            "topic_style": self.topic_style,
            "default_content_type": self.default_content_type,
            "content_types": [item.as_dict() for item in self.content_types],
            "visibility_options": [item.as_dict() for item in self.visibility_options],
            "limits": {
                "daily_limit": self.default_daily_limit,
                "min_interval_sec": self.default_min_interval_sec,
            },
            "features": dict(self.features),
            "data_sources": list(self.data_sources),
        }

    # ------------------------------------------------------------ 接入点

    def start_qr(self, proxy: str = "") -> Any:
        """发起一次扫码登录，返回带 ``poll()/payload()/close()`` 的会话对象。"""
        raise NotImplementedError(f"{self.name} 的扫码登录尚未实现")

    def save_qr_account(
        self, session: Any, accounts: Any, name: str = ""
    ) -> dict[str, Any]:
        """扫码确认后把登录态写入账号表；默认按 ``account_payload()`` 落库。"""
        payload = session.account_payload()
        account_name = (
            name
            or str(payload.get("nickname") or "")
            or f"{self.short or self.name}账号"
        )
        return accounts.add_session(
            self.key,
            account_name,
            payload,
            nickname=str(payload.get("nickname") or ""),
            red_id=str(payload.get("platform_id") or ""),
            user_id=str(payload.get("user_id") or ""),
        )

    def classify_failure(self, message: Any, result: Any = None) -> str:
        from ops.platforms.errors import classify_text

        return classify_text(message)

    def check_session(self, account: Any) -> dict[str, Any]:
        raise NotImplementedError(
            f"{self.name} 的登录态检查尚未实现；请在适配器里实现 check_session()"
        )

    def publish(self, account: Any, payload: dict[str, Any]) -> PublishOutcome:
        raise NotImplementedError(
            f"{self.name} 的发布尚未实现；请在适配器里实现 publish()"
        )

    def fetch_published(
        self, account: Any, *, cursor: Any = 0, limit: int = 30
    ) -> dict[str, Any]:
        raise NotImplementedError(
            f"{self.name} 的内容回收尚未实现；请在适配器里实现 fetch_published()"
        )

    def fetch_comments(
        self, account: Any, note: Any, *, pages: int = 3
    ) -> dict[str, Any]:
        """只读评论同步；平台未接入时由上层给出明确提示。"""
        raise NotImplementedError(f"{self.name} 暂不支持评论同步")

    def note_url(self, remote_note_id: str) -> str:
        """由远端 ID 拼原帖链接；平台未知时返回空串。"""
        return ""


__all__ = [
    "ContentSpec",
    "VisibilityOption",
    "PublishOutcome",
    "PlatformAdapter",
]
