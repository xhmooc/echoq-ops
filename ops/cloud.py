# encoding: utf-8
"""EchoQ-Cloud 账号与中转 Key 客户端。

上游 DeepSeek / DashScope 的 Key 只保存在云端；本地登录后拿到的是按账号
签发的两把中转 Key（``eqk_llm_...`` 文案、``eqk_img_...`` 配图），所有
生成请求统一走云端 ``/v1/*`` 中转。

本地只在数据目录的 ``cloud_state.json`` 保存登录票据与这两把 Key，落盘前
用 ``security`` 加密；浏览器永远拿不到明文。
"""

from __future__ import annotations

import copy
import json
import os
import threading
import time
from typing import Any

import requests
from loguru import logger

from ops import config, security

STATE_PATH = config.DATA_DIR / "cloud_state.json"
TIMEOUT = (5, 20)

KINDS = {"llm": "文案 Key", "image": "配图 Key"}
STATE_LABELS = {
    "trialing": "已开通",
    "active": "生效中",
    "scheduled": "待生效",
    "past_due": "宽限期",
    "expired": "已过期",
    "none": "未订阅",
}

_LOCK = threading.RLock()


class CloudError(RuntimeError):
    """云端返回的可读错误；``status``/``code`` 供接口层决定 HTTP 状态码。"""

    def __init__(self, message: str, *, status: int = 0, code: str = "") -> None:
        super().__init__(message)
        self.status = status
        self.code = code


# ---------------------------------------------------------------- 本地状态

def _empty_state() -> dict[str, Any]:
    return {
        "base_url": config.CLOUD_BASE_URL,
        "token": "",
        "expires_at": "",
        "user": {},
        "account_state": "",
        "subscription": {},
        "keys": {},
        "updated_at": 0,
    }


def _try_decrypt(value: str) -> str:
    if not value:
        return ""
    try:
        return security.decrypt(value)
    except Exception:  # noqa: BLE001
        # 密钥换过（换了机器 / 删了 secret.key）时旧票据作废，重新登录即可。
        logger.warning("云端登录票据解密失败，已按未登录处理；请重新登录")
        return ""


def _load() -> dict[str, Any]:
    state = _empty_state()
    path = STATE_PATH
    if not path.is_file():
        return state
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        logger.warning(f"云端登录状态文件损坏，已忽略: {path}")
        return state
    if not isinstance(raw, dict):
        return state
    state.update(
        {
            "base_url": str(raw.get("base_url") or config.CLOUD_BASE_URL),
            "token": _try_decrypt(str(raw.get("token") or "")),
            "expires_at": str(raw.get("expires_at") or ""),
            "user": raw.get("user") if isinstance(raw.get("user"), dict) else {},
            "account_state": str(raw.get("account_state") or ""),
            "subscription": raw.get("subscription")
            if isinstance(raw.get("subscription"), dict)
            else {},
            "keys": {},
            "updated_at": int(raw.get("updated_at") or 0),
        }
    )
    for kind, item in (raw.get("keys") or {}).items():
        if kind not in KINDS or not isinstance(item, dict):
            continue
        state["keys"][kind] = {
            "plain": _try_decrypt(str(item.get("secret") or "")),
            "masked": str(item.get("masked") or ""),
            "prefix": str(item.get("prefix") or ""),
            "created_at": str(item.get("created_at") or ""),
            "last_used_at": str(item.get("last_used_at") or ""),
        }
    return state


def _save(state: dict[str, Any]) -> None:
    """原子写；票据与 Key 加密后再落盘。"""
    with _LOCK:
        payload = copy.deepcopy(state)
        payload["token"] = security.encrypt(payload["token"]) if payload.get("token") else ""
        for item in (payload.get("keys") or {}).values():
            plain = item.pop("plain", "")
            item["secret"] = security.encrypt(plain) if plain else ""
        config.DATA_DIR.mkdir(parents=True, exist_ok=True)
        tmp = STATE_PATH.with_suffix(".json.tmp")
        try:
            tmp.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        # Windows 上杀毒/索引偶尔会短暂占用目标文件，replace 报 WinError 5；
        # 重试几次，仍失败就退化成直接覆盖，避免整次刷新因落盘失败而报错。
        for attempt in range(4):
            try:
                os.replace(tmp, STATE_PATH)
                break
            except PermissionError:
                if attempt == 3:
                    STATE_PATH.write_text(tmp.read_text(encoding="utf-8"), encoding="utf-8")
                    tmp.unlink(missing_ok=True)
                else:
                    time.sleep(0.05 * (attempt + 1))


def _clear() -> None:
    _save(_empty_state())


# ---------------------------------------------------------------- HTTP

def _request(
    method: str,
    path: str,
    payload: dict[str, Any] | None = None,
    *,
    token: str = "",
    api_key: str = "",
) -> dict[str, Any]:
    url = f"{config.CLOUD_BASE_URL}{path}"
    headers = {"Accept": "application/json"}
    bearer = api_key or token
    if bearer:
        headers["Authorization"] = f"Bearer {bearer}"
    try:
        response = requests.request(
            method, url, json=payload, headers=headers, timeout=TIMEOUT
        )
    except requests.RequestException as exc:
        logger.warning(f"云端请求失败 {method} {path}: {exc.__class__.__name__}: {exc}")
        raise CloudError("连不上账号服务，请检查网络或稍后重试", code="network") from exc
    try:
        body = response.json()
    except ValueError:
        body = {}
    if response.status_code >= 400 or body.get("ok") is False:
        error = body.get("error")
        if isinstance(error, dict):
            # 新版 EchoQ-Cloud 统一返回 { ok:false, error:{ code, message } }。
            message = str(
                error.get("message") or f"账号服务返回 HTTP {response.status_code}"
            ).strip()
            code = str(error.get("code") or "")
        else:
            message = str(
                error or f"账号服务返回 HTTP {response.status_code}"
            ).strip()
            code = str(body.get("code") or "")
        if token and response.status_code == 401:
            # 票据被服务端作废（重装 / 换密钥）时立刻清掉本地登录态，
            # 否则界面会一直显示「已登录」，所有 AI 请求都报成模型故障。
            _clear()
            raise CloudError(
                "登录已失效，请重新登录", status=401, code="token_expired"
            )
        raise CloudError(message, status=response.status_code, code=code)
    data = body.get("data")
    return data if isinstance(data, dict) else {}


# ---------------------------------------------------------------- 状态

def _mask_phone(value: str) -> str:
    text = str(value or "")
    return f"{text[:3]}****{text[-4:]}" if len(text) >= 8 else text


def _mask_email(value: str) -> str:
    text = str(value or "")
    if "@" not in text:
        return text
    name, domain = text.split("@", 1)
    keep = name[:2] if len(name) > 2 else name[:1]
    return f"{keep}***@{domain}"


def _is_masked(value: str) -> bool:
    return any(mark in value for mark in ("•", "*"))


def _days_left(ends_at: Any) -> int | None:
    text = str(ends_at or "").replace("Z", "+00:00")
    if not text:
        return None
    try:
        from datetime import datetime, timezone

        end = datetime.fromisoformat(text)
        if end.tzinfo is None:
            end = end.replace(tzinfo=timezone.utc)
        return max(0, (end - datetime.now(timezone.utc)).days)
    except (TypeError, ValueError):
        return None


def _blocked_reason(state: dict[str, Any], kind: str = "llm") -> str:
    if not state.get("token"):
        return "请先登录 EchoQ 账号后再使用 AI 生成"
    account_state = str(state.get("account_state") or "")
    if account_state == "banned":
        return "账号已被封禁，请联系客服"
    if account_state == "deleted":
        return "账号已注销"
    key = (state.get("keys") or {}).get(kind) or {}
    if not key.get("plain"):
        return f"本机还没有{KINDS.get(kind, '中转 Key')}，请在账号面板点一次「重置」"
    subscription = state.get("subscription") or {}
    sub_state = str(subscription.get("state") or "")
    if account_state == "past_due" or sub_state in {"expired", "none", "past_due"}:
        return "订阅已到期，请续费后继续生成"
    remaining = subscription.get("remaining_units")
    if isinstance(remaining, int) and remaining <= 0:
        return "本期额度已用完，续费或等下个周期恢复"
    return ""


def status() -> dict[str, Any]:
    """给页面的公开状态：不含 token，也不含任何完整 Key。"""
    state = _load()
    user = state.get("user") or {}
    subscription = state.get("subscription") or {}
    keys = {}
    for kind, label in KINDS.items():
        item = (state.get("keys") or {}).get(kind) or {}
        keys[kind] = {
            "kind": kind,
            "kind_name": label,
            "ready": bool(item.get("plain")),
            "masked": item.get("masked") or "",
            "prefix": item.get("prefix") or "",
            "last_used_at": item.get("last_used_at") or "",
        }
    return {
        "base_url": config.CLOUD_BASE_URL,
        "logged_in": bool(state.get("token")),
        "user": {
            "display_name": str(user.get("display_name") or ""),
            "phone": _mask_phone(str(user.get("phone") or "")),
            "email": _mask_email(str(user.get("email") or "")),
        },
        "account_state": state.get("account_state") or "",
        "subscription": {
            "state": subscription.get("state") or "",
            "state_name": STATE_LABELS.get(
                str(subscription.get("state") or ""), "未订阅"
            ),
            "plan_name": subscription.get("plan_name") or subscription.get("plan_code") or "",
            "remaining_units": subscription.get("remaining_units"),
            "quota_units": subscription.get("quota_units"),
            "used_units": subscription.get("used_units"),
            "ends_at": subscription.get("ends_at") or "",
            "days_left": (
                subscription.get("days_left")
                if subscription.get("days_left") is not None
                else _days_left(subscription.get("ends_at"))
            ),
        },
        "keys": keys,
        "expires_at": state.get("expires_at") or "",
        "updated_at": state.get("updated_at") or 0,
        "generation_allowed": not _blocked_reason(state, "llm"),
        "image_allowed": not _blocked_reason(state, "image"),
    }


def logged_in() -> bool:
    return bool(_load().get("token"))


def key_for(kind: str = "llm") -> str:
    item = (_load().get("keys") or {}).get(kind) or {}
    return str(item.get("plain") or "")


def blocked_reason(kind: str = "llm") -> str:
    return _blocked_reason(_load(), kind)


def require(kind: str = "llm") -> str:
    """取中转 Key；未登录 / 无 Key / 订阅失效时抛出可直接展示的错误。"""
    state = _load()
    reason = _blocked_reason(state, kind)
    if reason:
        code = "login_required" if not state.get("token") else "subscription_required"
        raise CloudError(reason, status=401 if code == "login_required" else 402, code=code)
    return str((state["keys"].get(kind) or {}).get("plain") or "")


# ---------------------------------------------------------------- 登录

def _merge_keys(state: dict[str, Any], data: dict[str, Any]) -> list[str]:
    """合并 Key 掩码 + 当次签发的明文。

    兼容两种云端返回：
    - 新版：``keys`` 是 Key 记录数组，登录时 ``key`` 为明文，``/api/me`` 时为掩码；
    - 旧版：``keys`` 按 kind 分组的字典，配 ``new_keys`` / ``new_key``。
    """
    state.setdefault("keys", {})
    issued_kinds: list[str] = []
    listed = data.get("keys")

    if isinstance(listed, list):
        for record in listed:
            if not isinstance(record, dict):
                continue
            kind = str(record.get("kind") or "").strip().lower()
            if kind not in KINDS:
                kind = "image" if "image" in str(record.get("scopes") or "") else "llm"
            current = state["keys"].get(kind) or {}
            value = str(record.get("key") or "")
            plain = "" if _is_masked(value) else value
            prefix = str(record.get("prefix") or current.get("prefix") or "")
            state["keys"][kind] = {
                "plain": plain or current.get("plain") or "",
                "masked": str(
                    record.get("masked")
                    or (f"{prefix}••••••••••••" if prefix else current.get("masked") or "")
                ),
                "prefix": prefix,
                "created_at": str(record.get("created_at") or current.get("created_at") or ""),
                "last_used_at": str(record.get("last_used_at") or ""),
            }
            if plain:
                issued_kinds.append(kind)
        return issued_kinds

    listed = listed if isinstance(listed, dict) else {}
    issued = data.get("new_keys") if isinstance(data.get("new_keys"), dict) else {}
    if not issued and data.get("new_key"):
        issued = {"llm": str(data.get("new_key") or "")}
    for kind in KINDS:
        remote = listed.get(kind) if isinstance(listed.get(kind), dict) else {}
        current = state["keys"].get(kind) or {}
        plain = str(issued.get(kind) or current.get("plain") or "")
        if issued.get(kind):
            issued_kinds.append(kind)
        if not plain and not remote.get("masked"):
            continue
        state["keys"][kind] = {
            "plain": plain,
            "masked": str(remote.get("masked") or current.get("masked") or ""),
            "prefix": str(remote.get("prefix") or current.get("prefix") or ""),
            "created_at": str(remote.get("created_at") or current.get("created_at") or ""),
            "last_used_at": str(remote.get("last_used_at") or ""),
        }
    return issued_kinds


def _apply_login(state: dict[str, Any], data: dict[str, Any]) -> list[str]:
    token = str(data.get("token") or "")
    if token:
        state["token"] = token
    state["expires_at"] = str(data.get("expires_at") or state.get("expires_at") or "")

    user = data.get("user") if isinstance(data.get("user"), dict) else {}
    account = data.get("account") if isinstance(data.get("account"), dict) else {}
    if account:
        # 新版返回 account{user_id,email,phone,display_name,status}。
        state["user"] = {
            "id": account.get("user_id") or account.get("id") or (state.get("user") or {}).get("id"),
            "display_name": str(account.get("display_name") or ""),
            "phone": str(account.get("phone") or ""),
            "email": str(account.get("email") or ""),
        }
        status_value = str(account.get("account_state") or account.get("status") or "").strip().lower()
        state["account_state"] = (
            ""
            if status_value in ("", "active", "trial", "past_due")
            else ("banned" if status_value in ("banned", "disabled", "blocked") else status_value)
        )
    elif user:
        state["user"] = user
        state["account_state"] = str(user.get("account_state") or state.get("account_state") or "")

    subscription = data.get("subscription")
    if not isinstance(subscription, dict):
        subscription = account.get("subscription")
    if isinstance(subscription, dict) and subscription:
        merged = dict(subscription)
        plan_code = str(merged.get("plan_code") or "")
        if not merged.get("plan_name"):
            merged["plan_name"] = "专业版" if plan_code == "trial" else plan_code
        if merged.get("days_left") is None:
            merged["days_left"] = _days_left(merged.get("ends_at"))
        state["subscription"] = merged

    issued = _merge_keys(state, data)
    state["updated_at"] = int(time.time())
    return issued


def send_sms(phone: str) -> dict[str, Any]:
    data = _request("POST", "/api/auth/sms/send", {"phone": phone})
    return {
        "sent": bool(data.get("ok", True)),
        "resend_in": int(data.get("resend_in") or 60),
        # 仅本地开发环境（SMS_DEV_MODE=1）会返回，方便直接填验证码。
        "dev_code": str(data.get("dev_code") or ""),
    }


def login(
    *,
    phone: str = "",
    code: str = "",
    email: str = "",
    password: str = "",
    display_name: str = "",
) -> dict[str, Any]:
    if phone:
        data = _request(
            "POST",
            "/api/auth/sms/login",
            {"phone": phone, "code": code, "display_name": display_name},
        )
    elif email:
        data = _request(
            "POST", "/api/auth/email/login", {"email": email, "password": password}
        )
    else:
        raise CloudError("请填写手机号或邮箱", code="invalid_input")
    with _LOCK:
        state = _load()
        issued = _apply_login(state, data)
        _save(state)
    logger.info(
        "云端登录成功: user={} subscription={} issued={}".format(
            (state.get("user") or {}).get("id"),
            (state.get("subscription") or {}).get("state"),
            ",".join(issued) or "-",
        )
    )
    return {"status": status(), "is_new": bool(data.get("is_new")), "issued": issued}


def refresh() -> dict[str, Any]:
    with _LOCK:
        state = _load()
    if not state.get("token"):
        raise CloudError("请先登录账号", status=401, code="login_required")
    try:
        data = _request("GET", "/api/me", token=state["token"])
    except CloudError as exc:
        if exc.status == 401:
            _clear()
            raise CloudError("登录已过期，请重新登录", status=401, code="token_expired") from exc
        raise
    with _LOCK:
        issued = _apply_login(state, data)
        _save(state)
    return {"status": status(), "issued": issued}


def logout() -> dict[str, Any]:
    state = _load()
    token = str(state.get("token") or "")
    if token:
        try:
            _request("POST", "/api/auth/logout", {}, token=token)
        except CloudError as exc:
            # 云端不可达时也要允许本地退出，避免票据卡在过期状态。
            logger.warning(f"云端退出失败，已清理本地登录状态: {exc}")
    _clear()
    return {"status": status()}


def reset_key(kind: str) -> dict[str, Any]:
    kind = "image" if str(kind or "").strip().lower() == "image" else "llm"
    with _LOCK:
        state = _load()
    if not state.get("token"):
        raise CloudError("请先登录账号", status=401, code="login_required")
    data = _request("POST", "/api/keys/reset", {"kind": kind}, token=state["token"])
    plain = str(data.get("key") or "")
    record = data.get("record") if isinstance(data.get("record"), dict) else {}
    with _LOCK:
        state = _load()
        item = (state.get("keys") or {}).get(kind) or {}
        prefix = str(record.get("prefix") or "")
        state.setdefault("keys", {})[kind] = {
            "plain": plain or item.get("plain") or "",
            "masked": f"{prefix}••••••••••••" if prefix else item.get("masked") or "",
            "prefix": prefix or item.get("prefix") or "",
            "created_at": str(record.get("created_at") or ""),
            "last_used_at": "",
        }
        _save(state)
    logger.info(f"已重置{KINDS.get(kind)}")
    return {
        "kind": kind,
        "kind_name": KINDS.get(kind, ""),
        "masked": (state["keys"].get(kind) or {}).get("masked") or "",
        "notice": str(data.get("notice") or f"{KINDS.get(kind)}已重置"),
        "status": status(),
    }


def relay_url(path: str) -> str:
    """中转地址（``/v1/chat/completions`` 或 ``/v1/images/generations``）。"""
    return f"{config.CLOUD_BASE_URL}{path}"


# ---------------------------------------------------------------- 版本更新

def _normalize_latest(latest: Any) -> dict[str, Any] | None:
    if not isinstance(latest, dict) or not latest.get("version"):
        return None
    download = latest.get("download")
    return {
        "version": str(latest.get("version") or ""),
        "notes": str(latest.get("notes") or ""),
        "published_at": str(latest.get("published_at") or ""),
        "min_supported": str(latest.get("min_supported") or ""),
        "download": download if isinstance(download, dict) and download.get("url") else None,
    }


def update_info(current: str = "") -> dict[str, Any]:
    """查询云端最新发布版本。

    更新检查是锦上添花：连不上、返回异常或尚未发布时都返回 ``checked=False``
    或 ``latest=None``，调用方静默跳过，不能因此影响正常使用。
    """
    from ops import __version__

    version = (current or __version__).strip()
    params = {
        "product": "ops",
        "channel": config.APP_CHANNEL,
        "platform": config.APP_PLATFORM,
        "current": version,
    }
    empty = {
        "checked": False,
        "current": version,
        "channel": params["channel"],
        "platform": params["platform"],
        "update_available": False,
        "mandatory": False,
        "latest": None,
        "checked_at": 0,
    }
    try:
        response = requests.get(
            f"{config.CLOUD_BASE_URL}/api/app/version", params=params, timeout=TIMEOUT
        )
        body = response.json()
    except (requests.RequestException, ValueError) as exc:
        logger.info(f"更新检查跳过（{exc.__class__.__name__}）")
        return {**empty, "reason": "暂时连不上更新服务"}
    if not isinstance(body, dict) or body.get("ok") is False:
        return {**empty, "reason": "更新服务返回异常"}
    return {
        "checked": True,
        "current": str(body.get("current") or version),
        "channel": str(body.get("channel") or params["channel"]),
        "platform": str(body.get("platform") or params["platform"]),
        "update_available": bool(body.get("update_available")),
        "mandatory": bool(body.get("mandatory")),
        "latest": _normalize_latest(body.get("latest")),
        "checked_at": int(body.get("checked_at") or 0),
    }


def doctor(model: str = "") -> dict[str, Any]:
    """云端体检：把「连不上 / 没登录 / Key 失效 / 模型不在白名单」分开报。

    只做只读探测，不改数据；唯一副作用是票据失效时会清掉本地登录态。
    """
    from ops import __version__

    model_name = (model or config.LLM_MODEL).strip()
    items: list[dict[str, Any]] = []
    report: dict[str, Any] = {
        "base_url": config.CLOUD_BASE_URL,
        "version": __version__,
        "model": model_name,
        "logged_in": False,
        "items": items,
        "checked_at": 0,
    }

    def add(key: str, name: str, ok: bool, detail: str = "") -> None:
        items.append({"key": key, "name": name, "ok": bool(ok), "detail": detail})

    # 1. 云端可达（公开接口，不需要登录）
    try:
        response = requests.get(
            f"{config.CLOUD_BASE_URL}/api/app/version",
            params={
                "product": "ops",
                "channel": config.APP_CHANNEL,
                "platform": config.APP_PLATFORM,
                "current": __version__,
            },
            timeout=TIMEOUT,
        )
        add(
            "reach",
            "云端可达",
            response.status_code == 200,
            f"HTTP {response.status_code} · {config.CLOUD_BASE_URL}",
        )
    except requests.RequestException as exc:
        add("reach", "云端可达", False, f"{exc.__class__.__name__} · {config.CLOUD_BASE_URL}")

    # 2. 登录态（顺带校验票据，失效会被清掉）
    status_info: dict[str, Any] = {}
    try:
        status_info = refresh()
    except CloudError as exc:
        add("login", "账号登录", False, str(exc))
    except Exception as exc:  # noqa: BLE001
        add("login", "账号登录", False, exc.__class__.__name__)
    else:
        report["logged_in"] = bool(status_info.get("logged_in"))
        account = status_info.get("account") or {}
        add(
            "login",
            "账号登录",
            report["logged_in"],
            str(account.get("name") or account.get("phone") or "") or "未登录，请先登录",
        )

    if report["logged_in"]:
        # 3. Key 能通过中转，4. 模型在白名单
        key = ""
        try:
            key = key_for("llm")
        except CloudError as exc:
            add("key", "文案 Key", False, str(exc))
        if not key:
            add("key", "文案 Key", False, "本机没有可用的文案 Key，请重新登录或重置")
        else:
            try:
                response = requests.get(
                    f"{config.CLOUD_BASE_URL}/v1/models",
                    headers={"Authorization": f"Bearer {key}"},
                    timeout=TIMEOUT,
                )
                body = response.json() if response.status_code == 200 else {}
                models = [
                    str(item.get("id") or "")
                    for item in (body.get("data") or [])
                    if isinstance(item, dict)
                ]
                add("key", "文案 Key", bool(models), f"HTTP {response.status_code}")
                add(
                    "model",
                    f"模型 {model_name}",
                    model_name in models,
                    "白名单: " + "、".join(models) if models else "未取到模型清单",
                )
            except (requests.RequestException, ValueError) as exc:
                add("key", "文案 Key", False, exc.__class__.__name__)
                add("model", f"模型 {model_name}", False, "Key 不可用，无法核对白名单")

        # 5. 订阅与额度
        add(
            "plan",
            "订阅额度",
            bool(status_info.get("generation_allowed")),
            "可正常生成"
            if status_info.get("generation_allowed")
            else "订阅到期或额度用尽",
        )
    else:
        add("key", "文案 Key", False, "登录后再检查")
        add("model", f"模型 {model_name}", False, "登录后再检查")
        add("plan", "订阅额度", False, "登录后再检查")

    report["ok"] = all(item["ok"] for item in items)
    report["checked_at"] = int(time.time())
    return report


__all__ = [
    "CloudError",
    "blocked_reason",
    "doctor",
    "key_for",
    "logged_in",
    "login",
    "logout",
    "refresh",
    "relay_url",
    "require",
    "reset_key",
    "send_sms",
    "status",
    "update_info",
]
