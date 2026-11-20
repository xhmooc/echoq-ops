# encoding: utf-8
"""校验题库并生成可读版 library.md。"""

from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
LIB = HERE / "library.json"
MD = HERE / "library.md"


def main() -> int:
    items = json.loads(LIB.read_text(encoding="utf-8"))
    ids = [i["id"] for i in items]
    assert len(ids) == len(set(ids)), "id 重复"
    assert sorted(ids) == list(range(1, len(items) + 1)), "id 不连续"

    cols = Counter(i["col"] for i in items)
    tones = Counter(i["tone"] for i in items)
    prod = sum(1 for i in items if i["product"])

    lines = [
        "# 选题库（100 条）",
        "",
        f"- 总条数：{len(items)}",
        f"- 带产品：{prod} 条（{prod / len(items):.0%}）",
        f"- 栏目：{' / '.join(f'{k} {v}' for k, v in cols.items())}",
        f"- 语气：{' / '.join(f'{k} {v}' for k, v in tones.items())}",
        "",
    ]
    cur = None
    for item in items:
        if item["col"] != cur:
            cur = item["col"]
            lines += ["", f"## {cur}", "", "| # | 选题 | 角度 | 语气 | 产品 |", "|---|---|---|---|---|"]
        lines.append(
            f"| {item['id']} | {item['title']} | {item['angle']} | {item['tone']} | "
            f"{'✅' if item['product'] else '—'} |"
        )
    MD.write_text("\n".join(lines) + "\n", encoding="utf-8")

    print(f"题库 {len(items)} 条，产品占比 {prod / len(items):.0%}")
    print("栏目:", dict(cols))
    print("语气:", dict(tones))
    print("已生成", MD)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
