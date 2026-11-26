# encoding: utf-8
"""文案模型客户端（EchoQ-Cloud 中转）。

不再直连模型厂商：云端持有上游 Key，本机登录后拿到 ``eqk_llm_...`` 中转
Key，请求发到 ``{OPS_CLOUD_BASE_URL}/v1/chat/completions``。未登录、订阅
到期或额度用完时直接给出可读原因，不会静默降级。

``requests`` 自带的 ``timeout`` 覆盖不到 DNS 解析，也无法限制"服务器持续
慢速返回"的总耗时。这里把请求放进守护线程并 ``join(timeout)``，到点必返回，
保证生成文案不会无限转圈。
"""

from __future__ import annotations

import json
import threading
import time
from typing import Any

import requests
from loguru import logger

from ops import cloud, config


class LLMError(RuntimeError):
    pass


def _post_with_deadline(url: str, kwargs: dict[str, Any], deadline: float):
    """在守护线程里发请求，到时未返回就抛 LLMError，不再等待。"""
    box: dict[str, Any] = {}

    def _work() -> None:
        try:
            box["response"] = requests.post(url, **kwargs)
        except BaseException as exc:  # noqa: BLE001
            box["error"] = exc

    worker = threading.Thread(target=_work, name="llm-request", daemon=True)
    worker.start()
    worker.join(max(0.1, float(deadline)))
    if worker.is_alive():
        raise LLMError(f"模型响应超时（超过 {int(deadline)} 秒）")
    error = box.get("error")
    if error is not None:
        logger.warning(f"模型请求异常: {error.__class__.__name__}: {error}")
        raise LLMError("模型连接失败，请检查网络或代理") from error
    return box["response"]


class LLMClient:
    def __init__(self) -> None:
        self.base_url = f"{config.CLOUD_BASE_URL}/v1"
        self.model = config.LLM_MODEL
        self.api_key = cloud.key_for("llm")
        self._blocked = cloud.blocked_reason("llm")

    @property
    def blocked_reason(self) -> str:
        return getattr(self, "_blocked", "")

    @property
    def configured(self) -> bool:
        return bool(self.base_url and self.model and self.api_key) and not self.blocked_reason

    def describe(self) -> dict[str, Any]:
        state = cloud.status()
        return {
            "configured": self.configured,
            "base_url": self.base_url,
            "model": self.model,
            "timeout_sec": config.LLM_TIMEOUT_SEC,
            "logged_in": state["logged_in"],
            "subscription": state["subscription"],
            "remaining_units": state["subscription"].get("remaining_units"),
            "reason": self.blocked_reason,
        }

    def chat(
        self,
        messages: list[dict[str, str]],
        *,
        max_tokens: int = 3000,
        temperature: float = 0.85,
        timeout: float | None = None,
    ) -> str:
        if self.blocked_reason:
            raise LLMError(self.blocked_reason)
        if not self.configured:
            raise LLMError("文案模型未就绪，请先登录 EchoQ 账号")
        deadline = max(1.0, float(timeout or config.LLM_TIMEOUT_SEC))
        started = time.monotonic()
        response = _post_with_deadline(
            f"{self.base_url}/chat/completions",
            {
                "headers": {
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                "data": json.dumps(
                    {
                        "model": self.model,
                        "messages": messages,
                        "max_tokens": max_tokens,
                        "temperature": temperature,
                    },
                    ensure_ascii=False,
                ).encode("utf-8"),
                # 连接超时收紧；读超时作为第二道保险，总时长由上面的线程兜底。
                "timeout": (min(5.0, deadline), deadline),
            },
            deadline,
        )
        elapsed = time.monotonic() - started
        if response.status_code in {401, 403} and not getattr(self, "_key_reset", False):
            # 服务端轮换或吊销过 Key 时本地缓存会失效：静默重置一次再重试。
            self._key_reset = True
            try:
                cloud.reset_key("llm")
                self.api_key = cloud.key_for("llm")
                logger.info("文案 Key 已失效，已自动重置并重试")
            except cloud.CloudError as exc:
                logger.warning(f"自动重置文案 Key 失败: {exc}")
                if exc.status == 401 or exc.code in {"login_required", "token_expired"}:
                    raise LLMError("登录已失效，请重新登录") from exc
            except Exception as exc:  # noqa: BLE001
                logger.warning(f"自动重置文案 Key 失败: {exc}")
            else:
                return self.chat(
                    messages,
                    max_tokens=max_tokens,
                    temperature=temperature,
                    timeout=timeout,
                )
        if response.status_code >= 400:
            logger.warning(
                f"中转接口 HTTP {response.status_code}: {response.text[:300]}"
            )
            raise LLMError(self._error_text(response))
        try:
            payload = response.json()
        except ValueError as exc:
            logger.warning(f"模型返回不是 JSON: {response.text[:300]}")
            raise LLMError("模型返回格式异常") from exc
        try:
            content = payload["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError, TypeError) as exc:
            logger.warning(f"模型返回结构异常: {str(payload)[:300]}")
            raise LLMError("模型返回格式异常") from exc
        logger.info(f"模型请求完成: {elapsed:.1f}s, {len(content)} 字")
        return content

    @staticmethod
    def _error_text(response: Any) -> str:
        """中转错误是 OpenAI 风格：优先取 error.message，给用户看人话。"""
        try:
            body = response.json()
            error = body.get("error") if isinstance(body, dict) else None
            if isinstance(error, dict) and error.get("message"):
                return str(error["message"])
            if isinstance(error, str) and error:
                return error
        except ValueError:
            pass
        return f"模型接口返回 HTTP {response.status_code}"


__all__ = ["LLMClient", "LLMError"]
