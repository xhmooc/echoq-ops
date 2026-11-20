# encoding: utf-8
"""简化代理池：条目 CRUD + 出口测试。

只做「能连上、出口是谁、延迟多少」，不做 ASN、指纹与出口组熔断。
测试失败必须明确报错，绝不静默回退直连。
"""

from __future__ import annotations

import time
from typing import Any

import requests
from loguru import logger

from ops import db

PROBE_URL = "https://ipinfo.io/json"
FALLBACK_URL = "https://api.ipify.org?format=json"
TIMEOUT = 12


def proxy_dict(url: str | None) -> dict[str, str] | None:
    value = (url or "").strip()
    if not value:
        return None
    if "://" not in value:
        value = "http://" + value
    return {"http": value, "https": value}


def _clean_url(value: Any) -> str:
    url = str(value or "").strip()
    if not url:
        raise ValueError("代理地址不能为空")
    if "://" not in url:
        url = "http://" + url
    if not url.lower().startswith(("http://", "https://", "socks5://", "socks5h://")):
        raise ValueError("代理地址只支持 http / https / socks5")
    return url


def probe(url: str) -> dict[str, Any]:
    """通过指定代理访问出口查询服务；失败时抛 ValueError（人话）。"""
    clean = _clean_url(url)
    proxies = proxy_dict(clean)
    started = time.time()
    try:
        response = requests.get(PROBE_URL, proxies=proxies, timeout=TIMEOUT)
        payload = response.json() if response.ok else {}
        ip = str(payload.get("ip") or "")
        country = str(payload.get("country") or "")
        timezone = str(payload.get("timezone") or "")
        if not ip:
            fallback = requests.get(FALLBACK_URL, proxies=proxies, timeout=TIMEOUT)
            if not fallback.ok:
                raise ValueError("代理已连接，但出口查询返回异常")
            ip = str((fallback.json() or {}).get("ip") or "")
    except requests.RequestException as exc:
        logger.warning(f"代理测试失败: {clean} {exc.__class__.__name__}")
        raise ValueError("代理连接失败，请检查地址、账号密码与网络") from exc
    except ValueError:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.warning(f"代理测试异常: {clean} {exc.__class__.__name__}")
        raise ValueError("代理测试失败，请稍后重试") from exc
    if not ip:
        raise ValueError("代理已连接，但没拿到出口 IP")
    return {
        "url": clean,
        "exit_ip": ip,
        "country": country or "未知",
        "timezone": timezone or "",
        "latency_ms": int((time.time() - started) * 1000),
    }


class ProxyPool:
    """代理条目管理与出口测试。"""

    def list_proxies(self) -> list[dict[str, Any]]:
        return [self._serialize(row) for row in db.query("SELECT * FROM proxies ORDER BY id")]

    def _serialize(self, row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "name": row["name"],
            "url": row["url"],
            "enabled": bool(row["enabled"]),
            "country": row["country"],
            "timezone": row["timezone"],
            "exit_ip": row["exit_ip"],
            "last_check_at": row["last_check_at"],
            "last_status": row["last_status"],
            "last_latency_ms": row["last_latency_ms"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    def add_proxy(self, payload: dict[str, Any]) -> dict[str, Any]:
        url = _clean_url(payload.get("url"))
        now = db.now()
        proxy_id = db.execute(
            "INSERT INTO proxies(name, url, enabled, created_at, updated_at) "
            "VALUES(?,?,1,?,?)",
            (str(payload.get("name") or url)[:60], url, now, now),
        )
        return self._serialize(db.query_one("SELECT * FROM proxies WHERE id=?", (proxy_id,)))

    def update_proxy(self, proxy_id: int, payload: dict[str, Any]) -> dict[str, Any]:
        row = db.query_one("SELECT * FROM proxies WHERE id=?", (proxy_id,))
        if row is None:
            raise KeyError(f"代理不存在: {proxy_id}")
        updates: dict[str, Any] = {}
        if "name" in payload:
            updates["name"] = str(payload.get("name") or "")[:60]
        if "url" in payload:
            updates["url"] = _clean_url(payload.get("url"))
        if "enabled" in payload:
            updates["enabled"] = 1 if payload.get("enabled") else 0
        if not updates:
            return self._serialize(row)
        updates["updated_at"] = db.now()
        assignments = ", ".join(f"{key} = ?" for key in updates)
        db.execute(
            f"UPDATE proxies SET {assignments} WHERE id = ?",
            (*updates.values(), proxy_id),
        )
        return self._serialize(db.query_one("SELECT * FROM proxies WHERE id=?", (proxy_id,)))

    def delete_proxy(self, proxy_id: int) -> None:
        row = db.query_one("SELECT url FROM proxies WHERE id=?", (proxy_id,))
        if row is None:
            raise KeyError(f"代理不存在: {proxy_id}")
        # 账号仍绑定这条代理时，解绑成直连，避免留下一个无法解释的出口。
        db.execute(
            "UPDATE accounts SET proxy='', proxy_group='', updated_at=? WHERE proxy=?",
            (db.now(), row["url"]),
        )
        db.execute("DELETE FROM proxies WHERE id=?", (proxy_id,))

    def test_proxy(self, proxy_id: int | None = None, url: str = "") -> dict[str, Any]:
        if proxy_id:
            row = db.query_one("SELECT * FROM proxies WHERE id=?", (int(proxy_id),))
            if row is None:
                raise KeyError(f"代理不存在: {proxy_id}")
            target = row["url"]
        else:
            target = url
        result = probe(target)
        now = db.now()
        status = f"出口 {result['exit_ip']} · {result['latency_ms']}ms"
        if proxy_id:
            db.execute(
                "UPDATE proxies SET exit_ip=?, country=?, timezone=?, last_check_at=?, "
                "last_status=?, last_latency_ms=?, updated_at=? WHERE id=?",
                (
                    result["exit_ip"],
                    result["country"],
                    result["timezone"],
                    now,
                    status,
                    result["latency_ms"],
                    now,
                    int(proxy_id),
                ),
            )
        return {**result, "ok": True, "message": f"代理可用，出口 {result['exit_ip']}"}


__all__ = ["ProxyPool", "probe", "proxy_dict"]
