# encoding: utf-8
"""登录小红书并把 Cookie 写回 .env，之后 spider 直接可用。

用法：
    run.cmd login          扫码登录（生成 qrcode_login.png 并自动打开）
    run.cmd login cookie   手动粘贴浏览器里的完整 Cookie
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# 脚本现在位于 vendor/upstream/，仓库根仍是上两级；.env 与二维码写在根目录。
ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

ENV_PATH = ROOT / ".env"
QR_PATH = ROOT / "qrcode_login.png"


def save_cookie(cookie: str) -> None:
    cookie = cookie.strip().strip("'\"")
    lines: list[str] = []
    if ENV_PATH.exists():
        lines = ENV_PATH.read_text(encoding="utf-8").splitlines()
    out: list[str] = []
    replaced = False
    for line in lines:
        if line.strip().upper().startswith("COOKIES"):
            out.append(f"COOKIES='{cookie}'")
            replaced = True
        else:
            out.append(line)
    if not replaced:
        out.append(f"COOKIES='{cookie}'")
    ENV_PATH.write_text("\n".join(out).strip() + "\n", encoding="utf-8")
    print(f"[OK] Cookie 已写入 {ENV_PATH}")


def verify(cookie: str) -> bool:
    from vendor.apis.xhs_pc_apis import XHS_Apis
    from vendor.xhs_utils.xhs_pc import XHSPcAuth

    try:
        auth = XHSPcAuth.from_cookie(cookie)
        api = XHS_Apis(auth).bootstrap()
        success, msg, data = api.get_user_me()
    except Exception as exc:  # noqa: BLE001
        print(f"[FAIL] 会话校验异常: {exc.__class__.__name__}: {exc}")
        return False

    if not success:
        print(f"[FAIL] 会话校验失败: {msg}")
        return False

    info = (data or {}).get("data") or {}
    if info.get("guest"):
        print("[FAIL] 当前仍是访客态，Cookie 无效或已过期")
        return False

    print(f"[OK] 已登录: {info.get('nickname', '未知')}（RedID: {info.get('red_id', '未知')}）")
    return True


def qrcode_login(open_image: bool = True, timeout: int = 180) -> str | None:
    import qrcode as qrlib

    from vendor.apis.xhs_pc_login_apis import XHSLoginApi
    from vendor.xhs_utils.xhs_pc import XHSPcAuth

    def _show(url: str) -> None:
        qr = qrlib.QRCode(box_size=10, border=4)
        qr.add_data(url)
        qr.make(fit=True)
        img = qr.make_image(fill_color="black", back_color="white")
        img.save(QR_PATH)
        print(f"\n二维码已保存：{QR_PATH}")
        if open_image:
            try:
                os.startfile(str(QR_PATH))  # noqa: S606 - Windows 打开图片
            except Exception:  # noqa: BLE001
                pass
        print("请用小红书 App 扫码（3 分钟内有效）...\n")

    # 补丁 1：扫描后「待确认」中间态不要当致命错误
    _orig_check = XHSLoginApi.check_qrcode_status

    def _tolerant_check(self, qr_id, code, cookies):
        snapshot = dict(cookies)
        try:
            return _orig_check(self, qr_id, code, cookies)
        except RuntimeError as exc:
            cookies.clear()
            cookies.update(snapshot)
            print(f"  [等待确认] 服务端中间态：{exc}")
            return False, "请确认登录", cookies

    XHSLoginApi.check_qrcode_status = _tolerant_check

    # 补丁 2：最终登录那一步不再硬要求 code_status == 2，
    # 只要 login_info 里带了 session 就当作登录成功（2026-11 服务端字段变化）。
    import json as _json

    from vendor.apis import xhs_pc_login_apis as L

    def _tolerant_final(self, qr_id, code, cookies):
        api = "/api/sns/web/v1/login/qrcode/status"
        key = L.ssk_generate_private_key()
        params = {
            "qr_id": qr_id,
            "code": code,
            "client_public_key_base64": L.ssk_public_key_base64(key),
        }
        splice_api = L.splice_str(api, params)
        headers, _ = self._signed_request_params(
            cookies, splice_api, method="GET", tier="0301", mns_profile="qrcode_poll",
        )
        headers["x-login-mode"] = ""
        headers = L.build_pc_login_headers(
            headers, self._cookies_for_url(self.base_url, cookies), kind="get-login-mode",
        )
        resp = self.http.get(
            self.base_url + splice_api, headers=headers,
            proxies=self.proxies, timeout=L.REQUEST_TIMEOUT,
        )
        self._merge_response_cookies(
            cookies, resp,
            append_shared=("web_session", "id_token", "x-rednote-datactry", "x-rednote-holderctry"),
        )
        res = resp.json()
        data = res.get("data") or {}
        info = data.get("login_info") or {}
        session = str(info.get("session") or "")
        print(f"  [final] success={res.get('success')} code_status={data.get('code_status')} 有 session={bool(session)}")
        if not session:
            print("  [final] 原始返回:", _json.dumps(res, ensure_ascii=False)[:500])
            raise RuntimeError(res.get("msg") or "二维码最终登录状态无效")

        cookies.pop("web_session", None)
        cookies["web_session"] = session
        self.profile.update_cookies(cookies)

        encrypted = str(info.get("ssk") or "")
        if encrypted:
            try:
                b64 = L.decrypt_ssk_base64(key, encrypted, server_public_key=L.SERVER_PUBLIC_KEY_9_43_1)
                self.local_storage["webSsk"] = _json.dumps({"xhs-pc-web": b64})
                print("  [final] webSsk 已解密")
            except Exception as exc:  # noqa: BLE001
                print(f"  [final] ssk 解密失败（不影响登录）: {exc}")
        return cookies

    XHSLoginApi._login_by_qrcode_status = _tolerant_final

    XHSLoginApi.show_qrcode_image = staticmethod(_show)
    auth = XHSPcAuth.from_qrcode_login(show_in_terminal=False)
    return auth.cookies


def main() -> int:
    mode = (sys.argv[1] if len(sys.argv) > 1 else "qrcode").strip().lower()
    print("=" * 46)
    if mode == "cookie":
        cookie = input("粘贴浏览器里的完整 Cookie（含 a1 与 web_session）：\n").strip()
        if not cookie:
            print("[FAIL] Cookie 为空")
            return 1
    elif mode in {"qrcode", "qr", "scan"}:
        try:
            cookie = qrcode_login()
        except Exception as exc:  # noqa: BLE001
            print(f"[FAIL] 扫码登录失败: {exc.__class__.__name__}: {exc}")
            return 1
        if not cookie:
            print("[FAIL] 登录未完成（超时或未确认）")
            return 1
    else:
        print(f"未知模式: {mode}（可用：qrcode / cookie）")
        return 2

    if not verify(cookie):
        return 1
    save_cookie(cookie)
    print("=" * 46)
    print("现在可以直接跑：run.cmd spider")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
