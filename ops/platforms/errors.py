# encoding: utf-8
"""平台失败分类。

队列只认五类结果：

- ``auth``：登录态失效，需要重新扫码；
- ``content``：内容本身不合规/超规格，重试没有意义；
- ``rate``：平台限流/风控，退避后重试；
- ``network``：网络抖动/超时，退避后重试；
- ``platform``：平台接口或页面结构变了，必须人工更新适配器，不能自动重试。

这里只做「文本 -> 分类」的兜底；平台适配器能给出更准确的分类时，应直接在
``PublishOutcome.kind`` 里返回。
"""

from __future__ import annotations

from typing import Any

AUTH = "auth"
CONTENT = "content"
RATE = "rate"
NETWORK = "network"
PLATFORM = "platform"

KIND_LABELS = {
    AUTH: "登录失效",
    CONTENT: "内容不合规",
    RATE: "平台限流",
    NETWORK: "网络异常",
    PLATFORM: "平台页面变更",
}

# 分类顺序有讲究：先判内容（避免把「标题超长」误判成网络），再判登录，
# 最后才是限流/平台变更。
_AUTH_HINTS = (
    "登录失效",
    "登录态",
    "未登录",
    "请登录",
    "重新登录",
    "session expired",
    "401",
    "unauthorized",
    "login required",
    "auth_required",
    "auth_expired",
    "ticket",
)
_CONTENT_HINTS = (
    "标题",
    "正文",
    "超过",
    "超出",
    "不支持",
    "格式",
    "违规",
    "敏感",
    "图片数量",
    "视频大小",
    "封面",
    "参数错误",
    "内容为空",
)
_RATE_HINTS = (
    "限流",
    "频繁",
    "风控",
    "稍后",
    "今日已达",
    "群发次数",
    "429",
    "rate limit",
)
_PLATFORM_HINTS = (
    "页面结构",
    "接口变更",
    "改版",
    "找不到发布按钮",
    "找不到上传",
    "upstream_changed",
    "platform changed",
    "元素不存在",
)


def classify_text(text: Any) -> str:
    value = str(text or "").lower()
    for hint in _CONTENT_HINTS:
        if hint in value:
            return CONTENT
    for hint in _AUTH_HINTS:
        if hint in value:
            return AUTH
    for hint in _RATE_HINTS:
        if hint in value:
            return RATE
    for hint in _PLATFORM_HINTS:
        if hint in value:
            return PLATFORM
    return NETWORK


class PlatformFailure(RuntimeError):
    """带分类的平台异常；适配器内部用它把失败原因传到队列。"""

    def __init__(self, kind: str, message: str, *, detail: str = "") -> None:
        super().__init__(message)
        self.kind = kind if kind in KIND_LABELS else NETWORK
        self.message = message
        self.detail = detail

    def as_result(self) -> dict[str, Any]:
        payload: dict[str, Any] = {"kind": self.kind, "error": self.message}
        if self.detail:
            payload["detail"] = self.detail[:800]
        return payload


__all__ = [
    "AUTH",
    "CONTENT",
    "RATE",
    "NETWORK",
    "PLATFORM",
    "KIND_LABELS",
    "classify_text",
    "PlatformFailure",
]
