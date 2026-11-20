# encoding: utf-8
"""抓取小红书求职/面试相关笔记，作为选题库的素材。"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from vendor.apis.xhs_pc_apis import XHS_Apis  # noqa: E402
from vendor.xhs_utils.common_util import load_env  # noqa: E402
from vendor.xhs_utils.xhs_pc import XHSPcAuth  # noqa: E402

KEYWORDS = [
    "面试", "秋招", "求职", "offer", "简历", "笔试", "校招", "应届生",
    "面试技巧", "群面", "HR面", "薪资谈判", "offer选择", "实习", "转行",
    "自我介绍", "面试问题", "找工作",
]
PER_KW = 12
OUT = Path(__file__).resolve().parent / "raw-notes.json"


def main() -> int:
    api = XHS_Apis(XHSPcAuth.from_cookie(load_env())).bootstrap()
    seen: dict[str, dict] = {}

    for kw in KEYWORDS:
        for sort in (0, 2):  # 综合 + 最多点赞
            try:
                ok, _msg, notes = api.search_some_note(kw, PER_KW, sort_type_choice=sort)
            except Exception as exc:  # noqa: BLE001
                print("search fail", kw, exc)
                continue
            if not ok:
                continue
            for n in notes or []:
                nid = n.get("id")
                if not nid or nid in seen:
                    continue
                card = n.get("note_card", {})
                seen[nid] = {
                    "id": nid,
                    "token": n.get("xsec_token", ""),
                    "kw": kw,
                    "title": (card.get("display_title") or "").strip(),
                }
            time.sleep(0.5)
        print(f"搜索 {kw}: 累计 {len(seen)}")

    print("开始拉正文…")
    rows = []
    for i, (nid, meta) in enumerate(seen.items(), 1):
        url = f"https://www.xiaohongshu.com/explore/{nid}?xsec_token={meta['token']}&xsec_source=pc_search"
        try:
            ok, _msg, res = api.get_note_info(url)
        except Exception:  # noqa: BLE001
            continue
        if not ok:
            continue
        try:
            card = res["data"]["items"][0]["note_card"]
        except Exception:  # noqa: BLE001
            continue
        desc = (card.get("desc") or "").strip()
        inter = card.get("interact_info") or {}
        rows.append({
            "id": nid,
            "kw": meta["kw"],
            "title": (card.get("title") or meta["title"] or "").strip(),
            "desc": desc,
            "liked": inter.get("liked_count"),
            "collected": inter.get("collected_count"),
        })
        if i % 20 == 0:
            print(f"  {i}/{len(seen)}")

    OUT.write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"保存 {len(rows)} 条 -> {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
