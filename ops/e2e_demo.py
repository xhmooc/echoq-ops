# encoding: utf-8
"""模拟端到端演练：找选题 → 写草稿（含配图）→ 发布。

默认开启 ``OPS_DRY_RUN=1``：挖掘用可控的模拟选题，文案走真实模型，
配图走真实本地渲染，发布只写「模拟发布」记录，不会调用小红书接口。
默认使用独立数据目录 ``datas/ops-e2e``，不会写入正式数据目录
（``%LOCALAPPDATA%\\EchoQ-Ops\\data``）；确需写入正式库时显式设置
``OPS_E2E_ALLOW_LIVE=1``。
所有产物落在数据目录的 ``e2e/`` 下，同时写进 schedule_runs 便于页面回看。

用法::

    .venv\\Scripts\\python.exe -X utf8 -m ops.e2e_demo
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
os.environ.setdefault("OPS_DATA_DIR", str(_ROOT / "datas" / "ops-e2e"))
os.environ.setdefault("OPS_DRY_RUN", "1")

from loguru import logger  # noqa: E402

from ops import config, db  # noqa: E402
from ops.service import OpsService  # noqa: E402

TITLE = "秋招复盘：用 AI 改简历后我拿到的三个面试"
KEYWORD = "秋招简历"


def _collect(service: OpsService, schedule_id: int, run: dict) -> dict:
    output = run.get("output") or {}
    stages = output.get("stages") or []
    topic_ids = list(output.get("topic_ids") or [])
    draft_ids = list(output.get("draft_ids") or [])
    topics = [service.topics.get_topic(int(item)) for item in topic_ids if item]
    drafts = []
    for draft_id in draft_ids:
        draft = service.get_draft(int(draft_id))
        files = []
        for path in draft.get("images") or []:
            file = Path(str(path))
            files.append(
                {
                    "path": str(file),
                    "exists": file.is_file(),
                    "bytes": file.stat().st_size if file.is_file() else 0,
                }
            )
        drafts.append(
            {
                "id": draft["id"],
                "title": draft.get("title"),
                "status": draft.get("status"),
                "desc": (draft.get("desc") or "")[:160],
                "topics": draft.get("topics") or [],
                "images": files,
            }
        )
    jobs = []
    for job_id in output.get("job_ids") or []:
        row = db.query_one("SELECT * FROM jobs WHERE id = ?", (int(job_id),))
        if row:
            jobs.append(
                {
                    "id": row["id"],
                    "draft_id": row["draft_id"],
                    "account_id": row["account_id"],
                    "status": row["status"],
                    "last_error": row["last_error"],
                }
            )
    records = [
        {
            "id": row["id"],
            "draft_id": row["draft_id"],
            "success": bool(row["success"]),
            "message": row["message"],
            "remote_note_id": row["remote_note_id"],
        }
        for row in db.query(
            "SELECT * FROM records WHERE draft_id IN ({}) ORDER BY id".format(
                ",".join("?" for _ in draft_ids) or "NULL"
            ),
            tuple(draft_ids),
        )
    ] if draft_ids else []
    run_row = db.query_one("SELECT * FROM schedule_runs WHERE id = ?", (run["run_id"],))
    return {
        "run": {
            "id": run["run_id"],
            "status": run.get("status"),
            "message": run.get("message"),
            "error": run.get("error"),
            "started_at": run_row["started_at"] if run_row else 0,
            "finished_at": run_row["finished_at"] if run_row else 0,
        },
        "stages": stages,
        "topics": topics,
        "drafts": drafts,
        "jobs": jobs,
        "records": records,
        "output": output,
    }


def _markdown(report: dict) -> str:
    lines = [
        "# 模拟端到端演练记录",
        "",
        f"- 时间：{time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(report['started_at']))}",
        f"- 运行记录：#{report['run']['id']}（{report['run']['status']}）",
        f"- 结论：{report['run']['message']}",
        "",
        "## 哪一环是模拟的",
        "",
        "| 环节 | 方式 |",
        "| --- | --- |",
        "| 找选题 | 模拟数据（source=simulated，标题可控） |",
        f"| 写草稿 | 真实模型 `{report['llm_model']}` |",
        "| 配图 | 真实本地渲染（Edge/Chrome 截图） |",
        "| 发布 | 模拟发布器（`OPS_DRY_RUN=1`），未调用小红书接口 |",
        "",
        "## 三环产物",
        "",
        "### 1. 找选题",
    ]
    for topic in report["topics"]:
        lines.append(
            f"- 选题 #{topic['id']}：{topic['title']}（状态 {topic['status']}，评分 {topic.get('score')}）"
        )
    lines.append("")
    lines.append("### 2. 写草稿（含配图）")
    for draft in report["drafts"]:
        lines.append(f"- 草稿 #{draft['id']}：{draft['title']}（状态 {draft['status']}）")
        for image in draft["images"]:
            lines.append(
                f"  - 配图：`{image['path']}`（{image['bytes']} 字节，存在={image['exists']}）"
            )
    lines.append("")
    lines.append("### 3. 发布")
    for record in report["records"]:
        lines.append(
            f"- 记录 #{record['id']}：成功={record['success']}，{record['message']}，"
            f"远程 id={record['remote_note_id']}（模拟 id）"
        )
    lines.extend(
        [
            "",
            "## 与真实发布还差哪一步",
            "",
            "只差最后一跳：去掉 `OPS_DRY_RUN`，由发布器带着账号 Cookie 调用 Creator 接口"
            "上传配图并提交笔记，拿到真实 note_id。挖题换成真实接口后，其余环节不变。",
            "",
        ]
    )
    return "\n".join(lines)


def main() -> int:
    config.configure_logging()
    if config.DATA_DIR.resolve() == config.DEFAULT_DATA_DIR and os.getenv("OPS_E2E_ALLOW_LIVE") != "1":
        raise SystemExit(
            "演练默认不能写入正式数据目录；"
            "请使用默认的 datas/ops-e2e，或显式设置 OPS_E2E_ALLOW_LIVE=1。"
        )
    if not config.DRY_RUN:
        raise SystemExit("请以 OPS_DRY_RUN=1 运行，避免真的发到小红书")
    started_at = int(time.time())
    service = OpsService()
    schedule = service.schedules.create(
        {
            "name": "模拟端到端演练（不真发）",
            "kind": "chain",
            "trigger_type": "time_point",
            "time_of_day": "23:59",
            "enabled": True,
            "auto": True,
            "config": {
                "mode": "keyword",
                "keywords": [KEYWORD],
                "simulate": True,
                "sim_titles": [TITLE],
                "from_pool": 1,
                "with_cards": True,
                "card_style": "memo",
                "tone": "story",
                "use_llm": True,
                "publish": True,
                "visibility": 1,
            },
        }
    )
    logger.info(f"演练任务 #{schedule['id']} 已创建，开始执行")
    run = service.schedules.run(int(schedule["id"]), trigger="manual")
    service.schedules.update(int(schedule["id"]), {"enabled": False})
    report = _collect(service, int(schedule["id"]), run)
    report.update(
        {
            "started_at": started_at,
            "dry_run": config.DRY_RUN,
            "llm_model": db.get_setting("llm_model", os.getenv("OPS_LLM_MODEL", "")),
            "schedule_id": schedule["id"],
        }
    )
    out_dir = config.DATA_DIR / "e2e"
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(started_at))
    json_path = out_dir / f"e2e-{stamp}.json"
    md_path = out_dir / f"e2e-{stamp}.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    md_path.write_text(_markdown(report), encoding="utf-8")

    print(json.dumps({
        "ok": run.get("status") in {"success", "waiting", "partial"},
        "run_id": run.get("run_id"),
        "status": run.get("status"),
        "message": run.get("message"),
        "topic_ids": [item["id"] for item in report["topics"]],
        "draft_ids": [item["id"] for item in report["drafts"]],
        "images": [image["path"] for item in report["drafts"] for image in item["images"]],
        "records": report["records"],
        "report": str(md_path),
        "json": str(json_path),
    }, ensure_ascii=False, indent=2))
    return 0 if run.get("status") in {"success", "waiting", "partial"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
