# encoding: utf-8
"""离线自检：不访问小红书、不调用模型，验证评分、去重、限速、队列与配图。

用法：``python -m ops selfcheck``
"""

from __future__ import annotations

import base64
import json
import os
import re
import shutil
import sys
import tempfile
import time
from pathlib import Path


def _ok(name: str, condition: bool, detail: str = "") -> tuple[str, bool, str]:
    return (name, condition, detail)


def run() -> int:
    tmp = tempfile.mkdtemp(prefix="ops-selfcheck-")
    os.environ["OPS_DATA_DIR"] = tmp
    os.environ.pop("OPS_LLM_API_KEY", None)
    results: list[tuple[str, bool, str]] = []
    try:
        from ops import __version__, config, db
        from ops.accounts import AccountManager
        from ops.illustrator import _plan, render_page_html
        from ops.content import (
            DraftService,
            compliance_issues,
            generate_copy,
            generate_from_brief,
        )
        from ops.publisher import PublishQueue, parse_when
        from ops.topics import parse_count, score_candidate, title_similarity

        db.init_db()

        # 0. 版本号：Python 与桌面壳必须一致，否则安装包文件名和更新检查会对不上
        shell_pkg = config.APP_DIR / "electron" / "package.json"
        try:
            shell_version = str(
                json.loads(shell_pkg.read_text(encoding="utf-8")).get("version") or ""
            )
        except (OSError, ValueError):
            shell_version = ""
        results.append(
            _ok(
                "版本号与桌面壳一致",
                shell_version == __version__ or config.FROZEN,
                f"{__version__} / {shell_version or '缺失'}",
            )
        )

        # 1. 互动数解析
        results.append(_ok("计数解析", parse_count("1.2万") == 12000 and parse_count("3,405") == 3405))
        results.append(_ok("计数负数兜底", parse_count("赞") == 0 and parse_count(None) == 0))

        # 2. 同题相似度
        sim = title_similarity("面试被问缺点怎么答", "面试被问到缺点应该怎么回答")
        results.append(_ok("同题相似度", 0.3 < sim <= 1.0, f"sim={sim:.2f}"))

        # 3. 评分单调性：高互动 + 高匹配应高于零互动
        high, _ = score_candidate(
            title="面试被问缺点怎么答",
            keyword="面试",
            liked=12000,
            collected=3000,
            comments=800,
            shares=200,
            published_at=int(time.time()) - 86400,
            product=True,
            existing_titles=[],
        )
        low, _ = score_candidate(
            title="周末去哪里散步",
            keyword="生活",
            liked=0,
            collected=0,
            comments=0,
            shares=0,
            published_at=0,
            product=False,
            existing_titles=[],
        )
        results.append(_ok("评分排序", high > low, f"high={high} low={low}"))

        # 4. 合规红线
        issues = compliance_issues("评论区扣1，私信我发资料，加微信聊")
        results.append(_ok("合规扫描", len(issues) >= 2, f"命中 {len(issues)} 类"))

        # 5. 离线文案硬限制
        copy = generate_copy(
            {"title": "面试被问缺点怎么答才不吃亏", "keyword": "面试", "angle": "别讲套话", "product": 0},
            tone="informative",
            use_llm=False,
        )
        results.append(
            _ok(
                "离线文案限制",
                len(copy["title"]) <= config.TITLE_MAX
                and len(copy["desc"]) <= config.DESC_MAX
                and "#面试" in copy["desc"],
                f"title={len(copy['title'])} desc={len(copy['desc'])}",
            )
        )

        # 5.1 自由创作兜底 + 手动草稿落库（创作页主路径）
        brief_copy = generate_from_brief(
            "写一篇秋招复盘，讲三个真正有用的准备动作，不要鸡汤。",
            topic="秋招面试复盘",
            tone="story",
            use_llm=False,
        )
        manual = DraftService().create_manual(
            title=brief_copy["title"],
            desc=brief_copy["desc"],
            topics=brief_copy["topics"],
            images=[],
        )
        results.append(
            _ok(
                "自由创作与手动草稿",
                brief_copy["engine"] == "offline"
                and manual["id"] > 0
                and manual["status"] == "draft"
                and len(manual["topics"]) > 0
                and "#" in manual["desc"],
                f"draft={manual['id']} topics={len(manual['topics'])}",
            )
        )

        # 6. 时间解析
        results.append(
            _ok(
                "定时时间解析",
                parse_when("2026-11-14 09:00") > 0 and parse_when(0) == 0,
            )
        )

        # 7. 队列幂等
        now = db.now()
        draft_id = db.execute(
            "INSERT INTO drafts(title, desc, media_type, visibility, images, topics, status, "
            "compliance, created_at, updated_at) VALUES('t','d','image',0,'[]','[]','draft','[]',?,?)",
            (now, now),
        )
        service = DraftService()
        queue = PublishQueue(AccountManager(), service)
        job_a = queue.enqueue(draft_id)
        job_b = queue.enqueue(draft_id)
        results.append(_ok("队列入队幂等", job_a["id"] == job_b["id"] and job_b.get("existed")))

        # 8. 限速计算
        account_id = db.execute(
            "INSERT INTO accounts(name, cookie_enc, enabled, status, created_at, updated_at) "
            "VALUES('test','x',1,'healthy',?,?)",
            (now, now),
        )
        manager = AccountManager()
        row = manager.get_row(account_id)
        ok_now, reason, _ = manager.availability(row, now)
        db.execute("UPDATE accounts SET last_publish_at=? WHERE id=?", (now, account_id))
        row = manager.get_row(account_id)
        blocked, _, _ = manager.availability(row, now + 60)
        results.append(_ok("发布间隔限速", ok_now and not blocked, reason))

        db.execute("UPDATE settings SET value='1' WHERE key='publish_daily_limit'") if db.query_one(
            "SELECT 1 FROM settings WHERE key='publish_daily_limit'"
        ) else db.set_setting("publish_daily_limit", "1")
        db.execute(
            "INSERT INTO records(job_id, draft_id, account_id, success, message, remote_note_id, "
            "result, created_at) VALUES(?,?,?,1,'ok','', '{}', ?)",
            (job_a["id"], draft_id, account_id, now),
        )
        row = manager.get_row(account_id)
        blocked, reason, _ = manager.availability(row, now + 10_000)
        results.append(_ok("日限额限速", not blocked, reason))

        # 9. 配图 HTML 模板（纯本地渲染，不调付费接口）
        try:
            draft = service.get(draft_id)
            draft.update({"keyword": "面试", "angle": "别讲套话"})
            draft.update(copy)
            pages = _plan(draft, "list")
            html_text = render_page_html(pages[1], style="notion", layout="list")
            heading = next(
                (
                    item.split(": ", 1)[-1]
                    for item in pages[1]["items"]
                    if item.startswith("Row 1 Heading: ")
                ),
                "",
            )
            ok = (
                len(pages) >= 2
                and "<html" in html_text
                and "1080px" in html_text
                and 'class="card list content"' in html_text
                and bool(heading)
                and heading in html_text
            )
            results.append(_ok("配图 HTML 组装", ok, f"{len(pages)} 页 / {len(html_text)} 字"))
        except Exception as exc:  # noqa: BLE001
            results.append(_ok("配图 HTML 组装", False, str(exc)))

        # 9.1 配图风格清单（接口给前端的可选数量，任何一项为 0 都会导致面板静默空白）
        try:
            from ops.designs import list_design_styles
            from ops.illustrator import (
                list_layouts,
                list_palettes,
                list_styles,
                paid_backend_status,
            )

            styles = list_styles()
            layouts = list_layouts()
            palettes = list_palettes()
            paid = paid_backend_status()
            counts = {
                "免费风格": len(list_design_styles()),
                "付费风格": len(styles),
                "付费版式": len(layouts),
                "付费配色": len(palettes),
            }
            baseline = {"免费风格": 8, "付费风格": 12, "付费版式": 8, "付费配色": 3}
            short = [
                f"{name} {count} < {baseline[name]}"
                for name, count in counts.items()
                if count < baseline[name]
            ]
            # 付费面板直接读 paid_backend_status，必须与独立清单完全一致；
            # 每个选项都要有 key 与中文 label，避免出现空选项。
            clean = all(
                item.get("key") and item.get("label")
                for item in [*styles, *layouts, *palettes]
            )
            consistent = paid["available"] == {
                "styles": len(styles),
                "layouts": len(layouts),
                "palettes": len(palettes),
            }
            detail = (
                "；".join(short)
                if short
                else " / ".join(f"{key} {value}" for key, value in counts.items())
                + f" / 来源 {paid['source']} / 风格 {[item['key'] for item in styles]}"
            )
            if not clean:
                detail += " / 存在缺少 key 或 label 的选项"
            if not consistent:
                detail += f" / 付费面板数量不一致 {paid['available']}"
            results.append(
                _ok("配图风格清单", not short and clean and consistent, detail)
            )
        except Exception as exc:  # noqa: BLE001
            results.append(_ok("配图风格清单", False, str(exc)))

        # 9.2 宽幅封面：公众号走 2.35:1（1080×460），8 套模板各有横版，越界检查按新画布
        try:
            from ops import designs as design_mod

            wide = design_mod.design_canvas("wechat_mp")
            portrait = design_mod.design_canvas("xiaohongshu")
            canvas_ok = (
                wide["key"] == "wide"
                and wide["width"] == 1080
                and wide["height"] == 460
                and wide["aspect"] == "2.35:1"
                and portrait["key"] == "portrait"
                and portrait["width"] == 1080
                and portrait["height"] == 1440
            )
            fake = {
                "id": 0,
                "title": "宽幅封面自检标题",
                "desc": "宽幅封面自检正文。",
                "platform": "wechat_mp",
                "media_type": "image",
            }
            cover = design_mod._design_pages(fake)[0]
            keys = [
                item["key"]
                for item in design_mod.list_design_styles()
                if item["key"] != "paper"
            ]
            html_ok = True
            mark_ok = True
            for key in keys:
                text = design_mod.render_design_html(cover, key, "selfcheck", "wide")
                html_ok = html_ok and "width:1080px;height:460px" in text
                # V2 引擎 class 为 "page v2 {style} {layout} wide"，按词匹配。
                match = re.search(r'<main class="([^"]+)"', text)
                classes = f" {match.group(1)} " if match else ""
                mark_ok = (
                    mark_ok
                    and f" {key} " in classes
                    and " wide " in classes
                    and "w-title" in text
                )
            paper_ok = (
                design_mod.design_style("paper")["key"] == "paper"
                and design_mod.count_design_pages(fake, "wechat_mp", "paper") == 1
                and design_mod.count_design_pages(fake, "xiaohongshu", "paper") == 5
            )
            # 同一坐标在宽幅越界、在竖版不越界，证明检查用的是新画布尺寸。
            # _check_blocks 返回 (errors, warnings)，这里只看拦截级 errors。
            bounds_ok = bool(
                design_mod._check_blocks(
                    [{"t": "宽幅越界", "x": 1000, "y": 200, "w": 120, "h": 40}], "wide"
                )[0]
            ) and not design_mod._check_blocks(
                [{"t": "竖版正常", "x": 900, "y": 200, "w": 120, "h": 40}], "portrait"
            )[0]
            layout = design_mod.check_design_layout(fake, "memo", "wechat_mp")
            layout_ok = (
                len(layout) == 1
                and layout[0]["canvas"] == "wide"
                and layout[0]["page"] == "01-cover"
                and layout[0]["ok"]
            )
            detail = (
                f"{len(keys)} 套旧模板 + paper / {wide['width']}×{wide['height']} / "
                f"封面页 {layout[0]['page']} / 文字块 {layout[0]['blocks']} / paper 5→1"
            )
            results.append(
                _ok(
                    "宽幅封面",
                    canvas_ok and html_ok and mark_ok and bounds_ok and layout_ok and paper_ok,
                    detail,
                )
            )
        except Exception as exc:  # noqa: BLE001
            results.append(_ok("宽幅封面", False, str(exc)))

        # 9.3 配图默认参数：不传 canvas/platform 时按草稿平台（小红书 3:4）出图
        try:
            from pathlib import Path as _Path

            from PIL import Image

            from ops import designs as design_mod

            draft = {
                "id": 0,
                "title": "默认参数配图回归",
                "desc": (
                    "开篇先说结论。\n\n✨ 第一节\n✅ 第一条\n✅ 第二条\n\n"
                    "✨ 第二节\n✅ 第三条\n✅ 第四条\n\n✨ 第三节\n✅ 第五条\n✅ 第六条\n\n"
                    "✨ 第四节\n✅ 第七条\n\n✨ 第五节\n✅ 第八条\n\n✨ 第六节\n✅ 第九条"
                ),
                "platform": "xiaohongshu",
                "media_type": "image",
            }
            folder = config.DESIGN_DIR / "draft-0"
            try:
                paths = design_mod.render_design_cards(draft, "memo", limit=1)
                with Image.open(paths[0]) as image:
                    size = image.size
                default_ok = (
                    len(paths) == 1
                    and _Path(paths[0]).name == "01-cover.png"
                    and size == (1080, 1440)
                )
            finally:
                shutil.rmtree(folder, ignore_errors=True)
            results.append(
                _ok(
                    "配图默认参数",
                    default_ok,
                    f"默认画布 {size[0]}×{size[1]}（不传 canvas/platform）",
                )
            )
        except Exception as exc:  # noqa: BLE001
            results.append(_ok("配图默认参数", False, str(exc)))

        # 9.3b 预览页数 = 实际生成张数：看到 01/07 就必须出 7 张，不能再按平台写死 4 张
        try:
            from pathlib import Path as _Path

            from ops import designs as design_mod

            many = {
                "id": 0,
                "title": "配图页数一致性",
                "desc": "\n".join(
                    ["先把结论说清楚", "📌 第一段"]
                    + [f"· 要点 {i}" for i in range(1, 16)]
                    + ["· 你打算先从哪一步开始？"]
                ),
                "platform": "xiaohongshu",
                "media_type": "image",
            }
            pages = design_mod.count_design_pages(many, "xiaohongshu")
            folder = config.DESIGN_DIR / "draft-0"
            original_shoot = design_mod._shoot
            original_check = design_mod._check_blocks
            design_mod._shoot = (
                lambda html_path, image_path, **kwargs: _Path(image_path).write_bytes(b"")
            )
            design_mod._check_blocks = lambda blocks, mode: ([], [])
            try:
                paths = design_mod.render_design_cards(many, "memo", platform="xiaohongshu")
                covers = design_mod.render_design_cards(many, "memo", platform="wechat_mp")
            finally:
                design_mod._shoot = original_shoot
                design_mod._check_blocks = original_check
                shutil.rmtree(folder, ignore_errors=True)
            results.append(
                _ok(
                    "配图页数与张数一致",
                    pages == 7 and len(paths) == pages and len(covers) == 1,
                    f"预览 {pages} 页 / 生成 {len(paths)} 张 / 公众号封面 {len(covers)} 张",
                )
            )
        except Exception as exc:  # noqa: BLE001
            results.append(_ok("配图页数与张数一致", False, str(exc)))

        # 9.3c 手绘插画：四种媒材、同种子同图、封面尺寸跟平台走
        try:
            from pathlib import Path as _Path

            from ops import artwork as art_mod

            draft = {
                "id": 0,
                "title": "手绘插画回归",
                "desc": "先给结论，再说过程。\n慢一点也没关系。",
                "platform": "wechat_mp",
            }
            first = art_mod.render_art_html(draft, "art-chalk", "seed-fixed", "wide")
            second = art_mod.render_art_html(draft, "art-chalk", "seed-fixed", "wide")
            other = art_mod.render_art_html(draft, "art-chalk", "seed-other", "wide")
            folder = config.DESIGN_DIR / "draft-0"
            original = art_mod._shoot
            art_mod._shoot = (
                lambda html_path, image_path, **kwargs: _Path(image_path).write_bytes(b"")
            )
            try:
                wide_paths = art_mod.render_artwork(
                    draft, "art-watercolor", variant=1, platform="wechat_mp"
                )
                portrait_paths = art_mod.render_artwork(
                    {**draft, "platform": "xiaohongshu"},
                    "art-engrave",
                    variant=1,
                    platform="xiaohongshu",
                )
            finally:
                art_mod._shoot = original
                shutil.rmtree(folder, ignore_errors=True)
            ok = (
                len(art_mod.list_art_styles()) == 4
                and first == second
                and first != other
                and _Path(wide_paths[0]).name == "01-cover.png"
                and len(wide_paths) == 1
                and len(portrait_paths) == 1
                and art_mod.art_canvas("wechat_mp")["height"] == 460
                and art_mod.art_canvas("xiaohongshu")["height"] == 1440
            )
            results.append(
                _ok(
                    "手绘插画媒材与确定性",
                    ok,
                    "4 种媒材 / 同种子同图 / 公众号 1080×460 / 竖版 1080×1440",
                )
            )
        except Exception as exc:  # noqa: BLE001
            results.append(_ok("手绘插画媒材与确定性", False, str(exc)))

        # 9.4 选题池：栏目/语气、评分解释、去重记录、批量导入、洗稿
        try:
            from ops.content import rewrite_copy
            from ops.topics import TopicMiner

            miner = TopicMiner()
            first = miner.add_manual(
                "配图风格自检选题",
                angle="给一个能直接用的句式",
                keyword="面试",
                category="面试",
                tone="story",
            )
            duplicate_blocked = False
            try:
                miner.add_manual("配图风格自检选题")
            except ValueError:
                duplicate_blocked = True
            dedupes = miner.list_dedupes(5)
            explain = first["score_explain"]
            explained = round(
                sum(row["points"] for row in explain if row["key"] != "total"), 1
            )
            imported = miner.import_text(
                "秋招时间线怎么排, 按月份拆解, 秋招, 求职, informative, 0\n"
                "自我介绍怎么开场, 给一个模板, 面试, 面试, warn, 0"
            )
            fixed = miner.get_topic(imported["items"][0]["id"])
            rewrite = rewrite_copy(
                first["title"],
                "第一，先说结论。第二，再讲原因。第三，给一个能直接用的例子。",
                angle="换成清单体",
                tone="informative",
                use_llm=False,
            )
            rewritten = DraftService().create_manual(
                title=rewrite["title"],
                desc=rewrite["desc"],
                topics=rewrite["topics"],
                source_note="draft:1",
            )
            results.append(
                _ok(
                    "选题池字段与解释",
                    first["category"] == "面试"
                    and first["tone"] == "story"
                    and first["source_label"] == "手动"
                    and first["heat"] == 0
                    and explained > 0
                    and abs(explained - float(first["score"])) <= 0.5
                    and all(row.get("note") or row["key"] == "total" for row in explain),
                    f"score={first['score']} 解释合计={explained}",
                )
            )
            results.append(
                _ok(
                    "选题去重记录",
                    duplicate_blocked
                    and bool(dedupes)
                    and dedupes[0]["kept_topic_id"] == first["id"]
                    and dedupes[0]["similarity"] >= 0.78,
                    f"记录 {len(dedupes)} 条",
                )
            )
            results.append(
                _ok(
                    "批量导入选题",
                    imported["inserted"] == 2
                    and fixed["category"] == "求职"
                    and fixed["tone"] == "informative",
                    f"导入 {imported['inserted']} 条",
                )
            )
            results.append(
                _ok(
                    "洗稿标注来源",
                    rewrite["engine"] == "offline"
                    and bool(rewrite["desc"])
                    and rewritten["source_note"] == "draft:1"
                    and rewritten["id"] != first["id"],
                    f"draft={rewritten['id']} engine={rewrite['engine']}",
                )
            )
        except Exception as exc:  # noqa: BLE001
            results.append(_ok("选题池字段与解释", False, str(exc)))

        # 9.3 融合链路：三环产出、失败定位
        try:
            from ops.scheduler import ScheduleEngine, StageError

            class _FakeService:
                def create_drafts(self, topic_ids, **kwargs):
                    return [
                        DraftService().create_manual(
                            title=f"链路自检草稿 {topic_ids[0]}",
                            desc="这是一段用于验证链路三环的正文，信息点一、二、三。",
                            topics=["链路"],
                        )
                    ]

            engine = ScheduleEngine(_FakeService())
            stamp = db.now()
            schedule_id = db.execute(
                "INSERT INTO schedules(name, kind, enabled, auto, trigger_type, time_of_day, "
                "weekdays, interval_minutes, config, next_run_at, last_run_at, last_status, "
                "last_message, running, failures, paused_reason, created_at, updated_at) "
                "VALUES('自检链路','chain',1,0,'time_point','09:00','[]',360,'{}',0,0,'','',0,0,'',?,?)",
                (stamp, stamp),
            )
            schedule = db.query_one("SELECT * FROM schedules WHERE id = ?", (schedule_id,))
            originals = (
                engine._run_mine,
                engine._decorate_cards,
                engine._publish_drafts,
            )
            engine._run_mine = lambda schedule, config: {
                "message": "假挖掘入池 1 条",
                "output": {"inserted": 1, "skipped": 0, "topic_ids": [first["id"]]},
            }
            engine._decorate_cards = lambda drafts, style, **kwargs: drafts
            engine._publish_drafts = lambda schedule, config, ids: {
                "message": "准备发布 1 篇（待确认）",
                "output": {
                    "draft_ids": ids,
                    "job_ids": [],
                    "results": [],
                    "pending": True,
                },
            }
            chain = engine._run_chain(
                schedule,
                {"from_pool": 1, "with_cards": True, "publish": True, "use_llm": False},
            )
            stages = chain["output"]["stages"]
            engine._run_mine = lambda *args: (_ for _ in ()).throw(RuntimeError("模拟挖不到选题"))
            failed_stage = ""
            failed_output: dict = {}
            try:
                engine._run_chain(schedule, {"from_pool": 1, "publish": True})
            except StageError as exc:
                failed_stage = exc.stage
                failed_output = exc.output
            finally:
                (
                    engine._run_mine,
                    engine._decorate_cards,
                    engine._publish_drafts,
                ) = originals
            results.append(
                _ok(
                    "融合链路三环",
                    [item["key"] for item in stages] == ["mine", "draft", "publish"]
                    and bool(stages[0]["topic_ids"])
                    and bool(stages[1]["draft_ids"])
                    and stages[2]["pending"]
                    and failed_stage == "mine"
                    and failed_output["stages"][0]["status"] == "failed",
                    f"{len(stages)} 环，失败定位={failed_stage}",
                )
            )
        except Exception as exc:  # noqa: BLE001
            results.append(_ok("融合链路三环", False, str(exc)))

        # 9.4 链路单环重跑：失败环可独立重跑，其他环产物保留
        try:
            from ops.scheduler import ScheduleEngine, StageError

            class _RetryService:
                def create_drafts(self, topic_ids, **kwargs):
                    return [
                        DraftService().create_manual(
                            title=f"重跑草稿 {topic_ids[0]}",
                            desc="重跑环节使用的正文，信息点一、二。",
                            topics=["重跑"],
                        )
                    ]

            engine = ScheduleEngine(_RetryService())
            stamp = db.now()
            schedule_id = db.execute(
                "INSERT INTO schedules(name, kind, enabled, auto, trigger_type, time_of_day, "
                "weekdays, interval_minutes, config, next_run_at, last_run_at, last_status, "
                "last_message, running, failures, paused_reason, created_at, updated_at) "
                "VALUES('自检重跑','chain',1,0,'time_point','09:00','[]',360,'{}',0,0,'','',0,0,'',?,?)",
                (stamp, stamp),
            )
            failed_output = {
                "stages": [
                    {"key": "mine", "label": "找选题", "status": "failed", "error": "模拟失败"},
                ],
                "failed_stage": "mine",
            }
            run_id = db.execute(
                "INSERT INTO schedule_runs(schedule_id, schedule_name, kind, trigger, status, "
                "started_at, finished_at, message, error, output, created_at) "
                "VALUES(?, '自检重跑', 'chain', 'schedule', 'failed', ?, ?, '挖不到选题', 'RuntimeError', ?, ?)",
                (schedule_id, stamp, stamp, json.dumps(failed_output, ensure_ascii=False), stamp),
            )
            original = engine._run_mine
            engine._run_mine = lambda schedule, config: {
                "message": "重跑挖到 1 条",
                "output": {"inserted": 1, "skipped": 0, "topic_ids": [1]},
            }
            try:
                retried = engine.rerun_stage(run_id, "mine")
            finally:
                engine._run_mine = original
            invalid_blocked = False
            try:
                engine.rerun_stage(run_id, "unknown")
            except ValueError:
                invalid_blocked = True
            retried_stage = next(
                (item for item in (retried.get("output") or {}).get("stages") or []),
                {},
            )
            results.append(
                _ok(
                    "链路单环重跑",
                    retried.get("status") == "success"
                    and retried.get("stage") == "mine"
                    and retried_stage.get("key") == "mine"
                    and retried_stage.get("status") == "success"
                    and not (retried.get("output") or {}).get("failed_stage")
                    and invalid_blocked,
                    f"run={retried.get('run_id')} status={retried.get('status')}",
                )
            )
        except Exception as exc:  # noqa: BLE001
            results.append(_ok("链路单环重跑", False, str(exc)))

        # 9.5 链路失败定位：配图失败算草稿环；重跑上游清掉旧下游
        try:
            from ops.scheduler import ScheduleEngine, StageError

            class _CardFailService:
                def create_drafts(self, topic_ids, **kwargs):
                    return [
                        DraftService().create_manual(
                            title="配图失败自检草稿",
                            desc="用于验证配图失败定位的正文，信息点一、二。",
                            topics=["链路"],
                        )
                    ]

                def generate_cards(self, draft_id, style=None):
                    raise RuntimeError("模拟配图失败")

            engine = ScheduleEngine(_CardFailService())
            engine._run_mine = lambda schedule, config: {
                "message": "挖到 1 条",
                "output": {"inserted": 1, "skipped": 0, "topic_ids": [1]},
            }
            engine._publish_drafts = lambda schedule, config, ids: {
                "message": "不该走到发布",
                "output": {},
            }
            schedule_row = {"auto": 0, "name": "配图失败自检", "id": 0}
            card_stage, card_draft_ids = "", []
            try:
                engine._run_chain(
                    schedule_row,
                    {
                        "from_pool": 1,
                        "with_cards": True,
                        "card_style": "__fail__",
                        "publish": True,
                    },
                )
            except StageError as exc:
                card_stage = exc.stage
                card_draft_ids = exc.output.get("draft_ids") or []

            stamp = db.now()
            schedule_id = db.execute(
                "INSERT INTO schedules(name, kind, enabled, auto, trigger_type, time_of_day, "
                "weekdays, interval_minutes, config, next_run_at, last_run_at, last_status, "
                "last_message, running, failures, paused_reason, created_at, updated_at) "
                "VALUES('自检重跑上游','chain',1,0,'time_point','09:00','[]',360,'{}',0,0,'','',0,0,'',?,?)",
                (stamp, stamp),
            )
            stale_output = {
                "stages": [
                    {"key": "mine", "label": "找选题", "status": "success"},
                    {"key": "draft", "label": "写草稿（含配图）", "status": "success"},
                    {"key": "publish", "label": "发布", "status": "success"},
                ],
                "topic_ids": [9],
                "draft_ids": [9],
                "job_ids": [9],
                "results": [{"status": "success"}],
                "pending": True,
                "confirmed_at": stamp,
            }
            run_id = db.execute(
                "INSERT INTO schedule_runs(schedule_id, schedule_name, kind, trigger, status, "
                "started_at, finished_at, message, error, output, created_at) "
                "VALUES(?, '自检重跑上游', 'chain', 'manual', 'success', ?, ?, '', '', ?, ?)",
                (
                    schedule_id,
                    stamp,
                    stamp,
                    json.dumps(stale_output, ensure_ascii=False),
                    stamp,
                ),
            )
            original_mine = engine._run_mine
            engine._run_mine = lambda schedule, config: {
                "message": "重跑挖到 2 条",
                "output": {"inserted": 2, "skipped": 0, "topic_ids": [2, 3]},
            }
            try:
                retried = engine.rerun_stage(run_id, "mine")
            finally:
                engine._run_mine = original_mine
            output = retried.get("output") or {}
            results.append(
                _ok(
                    "链路失败定位与下游失效",
                    card_stage == "draft"
                    and bool(card_draft_ids)
                    and [item["key"] for item in output.get("stages") or []] == ["mine"]
                    and "draft_ids" not in output
                    and "pending" not in output
                    and "job_ids" not in output
                    and "confirmed_at" not in output,
                    f"配图失败={card_stage} 重跑后环节="
                    f"{[item['key'] for item in output.get('stages') or []]}",
                )
            )
        except Exception as exc:  # noqa: BLE001
            results.append(_ok("链路失败定位与下游失效", False, str(exc)))

        # 10. 发布管线（用假会话，避免真实发布）
        config.ASSETS_DIR.mkdir(parents=True, exist_ok=True)
        placeholder = config.ASSETS_DIR / "placeholder.png"
        placeholder.write_bytes(
            base64.b64decode(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII="
            )
        )
        paths = [str(placeholder)]
        from contextlib import contextmanager

        class _Profile:
            cookie_map = {"web_session": "fake"}

        class _Auth:
            profile = _Profile()

            def host_cookies_snapshot(self):
                return {}

            def close(self):
                pass

        class _OkApi:
            def post_note(self, payload):
                return True, "发布成功", {"data": {"note_id": "0123456789abcdef01234567"}}

        class _AuthFailApi:
            def post_note(self, payload):
                return False, "无登录信息（401）", {}

        @contextmanager
        def _fake_session(account_id):
            yield _Auth()

        manager.session = _fake_session
        manager.creator_api = lambda auth: _OkApi()
        queue.accounts = manager

        def _new_account(name: str) -> int:
            stamp = db.now()
            return db.execute(
                "INSERT INTO accounts(name, cookie_enc, enabled, status, created_at, updated_at) "
                "VALUES(?, 'x', 1, 'healthy', ?, ?)",
                (name, stamp, stamp),
            )

        def _new_draft(title: str) -> int:
            stamp = db.now()
            return db.execute(
                "INSERT INTO drafts(title, desc, media_type, visibility, images, topics, status, "
                "compliance, created_at, updated_at) VALUES(?,?,'image',0,?,'[]','draft','[]',?,?)",
                (title, "正文内容", json.dumps(paths, ensure_ascii=False), stamp, stamp),
            )

        account_ok = _new_account("publish-ok")
        draft_ok = _new_draft("发布成功用例")
        job_ok = queue.enqueue(draft_ok, account_id=account_ok)
        result_ok = queue.run_job(job_ok["id"])
        record_ok = db.query_one("SELECT * FROM records WHERE job_id = ? AND success = 1", (job_ok["id"],))
        results.append(
            _ok(
                "发布成功链路",
                result_ok["status"] == "success" and record_ok is not None,
                f"job={result_ok['status']}",
            )
        )

        manager.creator_api = lambda auth: _AuthFailApi()
        account_bad = _new_account("publish-bad")
        draft_bad = _new_draft("发布失败用例")
        job_bad = queue.enqueue(draft_bad, account_id=account_bad)
        result_bad = queue.run_job(job_bad["id"])
        bad_row = manager.get_row(account_bad)
        results.append(
            _ok(
                "发布失败分类",
                result_bad["status"] == "retry" and bad_row["status"] == "expired",
                f"job={result_bad['status']} account={bad_row['status']}",
            )
        )

        # 11. 一稿多号：同一草稿分发到两个账号，汇总状态正确
        manager.creator_api = lambda auth: _OkApi()
        account_a = _new_account("multi-a")
        account_b = _new_account("multi-b")
        draft_multi = _new_draft("一稿多号用例")
        multi_jobs = queue.enqueue_targets(draft_multi, [account_a, account_b])
        repeat_jobs = queue.enqueue_targets(draft_multi, [account_a, account_b])
        duplicate_blocked = (
            len(repeat_jobs) == 2
            and db.scalar(
                "SELECT COUNT(*) FROM jobs WHERE draft_id = ?", (draft_multi,), 0
            )
            == 2
        )
        queue.cancel(multi_jobs[0]["id"])
        queued_after_cancel = db.query_one(
            "SELECT status FROM drafts WHERE id = ?", (draft_multi,)
        )["status"]
        queue.run_job(multi_jobs[1]["id"])
        multi_job_rows = db.query(
            "SELECT status FROM jobs WHERE draft_id = ? ORDER BY id", (draft_multi,)
        )
        published_after_one = db.query_one(
            "SELECT status FROM drafts WHERE id = ?", (draft_multi,)
        )["status"]
        results.append(
            _ok(
                "一稿多号队列",
                len(multi_jobs) == 2
                and duplicate_blocked
                and queued_after_cancel == "queued"
                and multi_job_rows[1]["status"] == "success"
                and published_after_one == "published",
                f"jobs={len(multi_jobs)} draft={published_after_one}",
            )
        )

        # 11.1 删除级联：选题批量删除 + 草稿清任务/记录/配图并回滚选题状态
        try:
            from ops.topics import TopicMiner

            miner = TopicMiner()
            t1 = miner.add_manual("批量删除测试一号", keyword="自检")
            t2 = miner.add_manual("城市夜跑路线推荐", keyword="自检")
            topic_deleted = miner.delete_topics([t1["id"], t2["id"]])
            topic_left = db.scalar(
                "SELECT COUNT(*) FROM topics WHERE id IN (?,?)", (t1["id"], t2["id"]), 0
            )

            topic = miner.add_manual("删除草稿时的选题状态回滚验证", keyword="自检")
            miner.update_topic(topic["id"], {"status": "used"})
            draft_service = DraftService()
            draft = draft_service.create_from_topic(topic, use_llm=False)
            asset_dir = config.ASSETS_DIR / f"draft-{draft['id']}"
            asset_dir.mkdir(parents=True, exist_ok=True)
            image = asset_dir / "01-cover.png"
            image.write_bytes(b"fake")
            draft_service.update(draft["id"], {"images": [str(image)]})
            queue.enqueue(draft["id"], account_id=account_ok)
            db.execute(
                "INSERT INTO records(job_id, draft_id, account_id, success, message, "
                "remote_note_id, result, created_at) VALUES(0,?,? ,0,'自检记录','','{}',?)",
                (draft["id"], account_ok, db.now()),
            )
            draft_deleted = draft_service.delete(draft["id"])
            jobs_left = db.scalar(
                "SELECT COUNT(*) FROM jobs WHERE draft_id = ?", (draft["id"],), 0
            )
            records_left = db.scalar(
                "SELECT COUNT(*) FROM records WHERE draft_id = ?", (draft["id"],), 0
            )
            topic_status = db.scalar(
                "SELECT status FROM topics WHERE id = ?", (topic["id"],), ""
            )
            results.append(
                _ok(
                    "批量删除与级联清理",
                    topic_deleted == 2
                    and topic_left == 0
                    and draft_deleted
                    and not image.exists()
                    and not asset_dir.exists()
                    and jobs_left == 0
                    and records_left == 0
                    and topic_status == "pool",
                    f"选题 {topic_deleted} 个 / 草稿任务 {jobs_left} 记录 {records_left} 选题状态 {topic_status}",
                )
            )
        except Exception as exc:  # noqa: BLE001
            results.append(_ok("批量删除与级联清理", False, str(exc)))

        # 11.2 发布环状态：全失败→failed，全等待重试→waiting，不误报成功
        try:
            from ops.scheduler import ScheduleEngine

            class _Queue:
                def __init__(self, job_status: str) -> None:
                    self.job_status = job_status

                def enqueue(self, draft_id, account_id=None):
                    return {"id": 1}

                def enqueue_targets(self, draft_id, account_ids):
                    return []

                def run_job(self, job_id):
                    return {"job_id": job_id, "status": self.job_status, "message": "模拟"}

            class _PublishService:
                def __init__(self, job_status: str) -> None:
                    self.queue = _Queue(job_status)

                def get_draft(self, draft_id):
                    return {
                        "id": draft_id,
                        "status": "draft",
                        "compliance": [],
                        "images": ["fake.png"],
                        "media_type": "image",
                        "visibility": 1,
                    }

                def update_draft(self, draft_id, fields):
                    return {"id": draft_id}

            engine = ScheduleEngine(_PublishService("failed"))
            failed = engine._publish_drafts({"auto": 1}, {"visibility": 1}, [1])
            engine = ScheduleEngine(_PublishService("retry"))
            waiting = engine._publish_drafts({"auto": 1}, {"visibility": 1}, [1])
            results.append(
                _ok(
                    "发布环不误报成功",
                    failed["status"] == "failed"
                    and failed["output"]["publish_status"] == "failed"
                    and waiting["status"] == "waiting"
                    and waiting["output"]["publish_status"] == "waiting",
                    f"全失败={failed['status']} 全重试={waiting['status']}",
                )
            )
        except Exception as exc:  # noqa: BLE001
            results.append(_ok("发布环不误报成功", False, str(exc)))

        # 12. 数据落盘加密可用
        from ops import security

        token = security.encrypt("web_session=test")
        results.append(_ok("Cookie 加密", security.decrypt(token) == "web_session=test"))

        # 12.1 密钥必须与数据目录分离，且启动检查能给出权限状态
        key_state = security.key_status()
        results.append(
            _ok(
                "密钥独立存放",
                key_state["exists"] and key_state["outside_data_dir"],
                f"路径={key_state['path']} 独立于数据目录={key_state['outside_data_dir']} "
                f"权限已收紧={key_state['restricted']}",
            )
        )

        # 13. 定时引导创建：三步内、默认值落库，不需要填任何自由文本
        from ops.scheduler import ScheduleEngine

        engine = ScheduleEngine()
        quick_chain = engine.quick_create({"what": "chain", "when": "morning"})
        quick_mine = engine.quick_create({"what": "mine", "when": "workdays"})
        quick_publish = engine.quick_create({"what": "publish", "when": "every6h"})
        wizard_src = (config.ROOT / "ops" / "web" / "static" / "app.js").read_text(
            encoding="utf-8"
        )
        results.append(
            _ok(
                "定时引导创建",
                "SCHEDULE_WIZARD_STEPS = 3" in wizard_src
                and quick_chain["kind"] == "chain"
                and quick_chain["name"]
                and quick_chain["auto"] is False
                and quick_chain["next_run_at"] > db.now()
                and quick_mine["kind"] == "mine"
                and quick_mine["next_run_at"] > db.now()
                and quick_publish["config"].get("visibility") == 1,
                f"chain={quick_chain['name']} / publish={quick_publish['name']}",
            )
        )
        # 14. 多平台：注册表、数据迁移、跨平台发布拦截
        try:
            from ops import platforms

            catalog = {item["key"]: item for item in platforms.list_platforms()}
            adapter_ok = (
                set(catalog) == {"xiaohongshu", "wechat_mp", "douyin"}
                and catalog["xiaohongshu"]["ready"]
                and catalog["xiaohongshu"]["content_types"][0]["title_max"] == 20
                and catalog["wechat_mp"]["ready"]
                and catalog["wechat_mp"]["content_types"][0]["title_max"] == 64
                and catalog["wechat_mp"]["features"].get("login_qr")
                and catalog["wechat_mp"]["features"].get("fetch_published")
                and catalog["douyin"]["ready"]
                and catalog["douyin"]["default_content_type"] == "video"
                and catalog["douyin"]["features"].get("login_qr")
                and catalog["douyin"]["features"].get("fetch_published")
            )
            results.append(
                _ok(
                    "平台注册表",
                    adapter_ok,
                    f"平台={list(catalog)} / 公众号标题上限={catalog.get('wechat_mp', {}).get('content_types', [{}])[0].get('title_max')}",
                )
            )

            columns = {
                table: {row["name"] for row in db.query(f"PRAGMA table_info({table})")}
                for table in ("accounts", "drafts", "jobs", "records", "schedules")
            }
            missing = [table for table, cols in columns.items() if "platform" not in cols]
            sample = db.query_one("SELECT platform, content_type FROM drafts ORDER BY id LIMIT 1")
            results.append(
                _ok(
                    "平台字段迁移",
                    not missing
                    and sample is not None
                    and sample["platform"] == "xiaohongshu"
                    and sample["content_type"] in {"image_text", "video"},
                    f"缺列={missing} 首条={dict(sample) if sample else None}",
                )
            )

            stamp = db.now()
            douyin_id = db.execute(
                "INSERT INTO accounts(platform, name, cookie_enc, created_at, updated_at) "
                "VALUES('douyin', '抖音占位号', 'x', ?, ?)",
                (stamp, stamp),
            )
            xhs_draft = db.execute(
                "INSERT INTO drafts(platform, content_type, title, desc, media_type, images, "
                "created_at, updated_at) VALUES('xiaohongshu', 'image_text', '跨平台测试', "
                "'正文', 'image', '[\"a.png\"]', ?, ?)",
                (stamp, stamp),
            )
            mp_draft = db.execute(
                "INSERT INTO drafts(platform, content_type, title, desc, media_type, images, "
                "created_at, updated_at) VALUES('wechat_mp', 'long_article', '公众号测试', "
                "'正文', 'image', '[\"a.png\"]', ?, ?)",
                (stamp, stamp),
            )
            queue = PublishQueue()
            mismatch_blocked = False
            unknown_blocked = False
            try:
                queue.enqueue(xhs_draft, douyin_id)
            except ValueError:
                mismatch_blocked = True
            try:
                platforms.normalize("unknown_platform")
            except ValueError:
                unknown_blocked = True
            results.append(
                _ok(
                    "跨平台发布拦截",
                    mismatch_blocked and unknown_blocked,
                    f"账号平台不一致={mismatch_blocked} 未知平台拦截={unknown_blocked}",
                )
            )

            # 14.1 新平台规格、失败分类、登录态存储与回收字段归一化
            from ops.accounts import AccountManager
            from ops.platforms.browser import BrowserOptions, qr_headless, qr_mode
            from ops.platforms.douyin import DouyinAdapter, normalize_item as dy_item
            from ops.platforms.errors import classify_text
            from ops.platforms.wechat_mp import (
                WechatQrSession,
                WechatMpAdapter,
                _parse_account,
                _published_items,
                normalize_article,
            )
            from ops.publisher import find_note_id

            dy = DouyinAdapter()
            mp = WechatMpAdapter()
            dy_problems = dy.validate(
                {
                    "content_type": "image_text",
                    "media_type": "image",
                    "title": "标" * 56,
                    "desc": "正" * 1000,
                    "images": ["a.png"],
                },
                "image_text",
            )
            mp_problems = mp.validate(
                {
                    "content_type": "long_article",
                    "media_type": "image",
                    "title": "标" * 65,
                    "desc": "正文",
                    "images": [],
                },
                "long_article",
            )
            action_ok = (
                mp._action({"type": 1}) == "draft"
                and mp._action({"type": 0}) == "draft"
                and mp._action({"action": "draft", "type": 0}) == "draft"
                and mp._action({"action": "mass_send"}) == "mass_send"
            )
            kinds = [
                classify_text("登录态已失效，请重新扫码"),
                classify_text("标题超过 55 字"),
                classify_text("请求过于频繁，请稍后再试"),
                classify_text("平台页面可能已改版"),
                classify_text("网络连接超时"),
            ]
            ids_ok = (
                find_note_id({"aweme_id": "7123456789012345678"}) == "7123456789012345678"
                and find_note_id({"note_id": "0123456789abcdef01234567"})
                == "0123456789abcdef01234567"
            )
            dy_norm = dy_item({"aweme_id": "7123456789012345678", "desc": "标题\n正文"})
            mp_norm = normalize_article({"aid": "10001", "title": "文章", "link": "https://mp.weixin.qq.com/s/abc"})
            metrics_ok = (
                dy_norm["views"] is None
                and dy_norm["likes"] is None
                and dy_norm["comments"] is None
                and mp_norm["comments"] is None
                and mp_norm["published_at"] == 0
            )
            dy_full = dy_item(
                {
                    "aweme_id": "7123456789012345678",
                    "statistics": {
                        "play_count": 1200,
                        "digg_count": 80,
                        "comment_count": 12,
                        "collect_count": 9,
                    },
                    "create_time": 1_700_000_000,
                }
            )
            metrics_full_ok = (
                dy_full["views"] == 1200
                and dy_full["likes"] == 80
                and dy_full["comments"] == 12
                and dy_full["collects"] == 9
                and dy_full["published_at"] == 1_700_000_000
            )

            class _Resp:
                def __init__(self, payload):
                    self._payload = payload
                    self.url = "https://mp.weixin.qq.com/cgi-bin/test"
                    self.text = json.dumps(payload, ensure_ascii=False)
                    self.status_code = 200

                def json(self):
                    return self._payload

            class _FakeMpClient:
                token = "selfcheck-token"
                session_data = {"ticket": "", "user_name": "", "svr_time": ""}

                def __init__(self):
                    self.calls = []

                def post(self, path, params=None, data=None, **kwargs):
                    self.calls.append((path, dict(params or {}), dict(data or {})))
                    if "operate_appmsg" in path:
                        return _Resp({"base_resp": {"ret": 0}, "appMsgId": "42"})
                    return _Resp({"base_resp": {"ret": 0}})

            fake = _FakeMpClient()
            draft_id = mp._create_draft(
                fake,
                {"title": "自检文章", "desc": "第一段\n第二段"},
                {"cdn_url": "https://mmbiz.qpic.cn/x.png", "file_id": "file-1"},
            )
            paths = [call[0] for call in fake.calls]
            # 公众号只允许写草稿：不能再出现 masssend 调用。
            draft_send_ok = (
                draft_id == "42"
                and "/cgi-bin/operate_appmsg" in paths[0]
                and all("masssend" not in path for path in paths)
            )
            manager = AccountManager()
            marker = f"selfcheck-{db.now()}"
            account = manager.add_session(
                "douyin",
                "自检抖音号",
                {"storage_state": {"cookies": [], "origins": []}, "nickname": "自检抖音号"},
                nickname="自检抖音号",
                user_id=marker,
            )
            blob = manager.session_blob(account["id"])
            session_ok = blob.get("platform") == "douyin" and blob.get("nickname") == "自检抖音号"
            mp_account = manager.add_session(
                "wechat_mp",
                "自检公众号",
                {"nickname": "自检公众号", "cookies": [], "token": ""},
                nickname="自检公众号",
                user_id=f"mp-{marker}",
            )
            db.execute(
                "INSERT INTO records(platform, account_id, success, message, result, created_at) "
                "VALUES('wechat_mp', ?, 1, '已保存到公众号草稿箱（没有群发）', ?, ?)",
                (
                    mp_account["id"],
                    json.dumps({"action": "draft", "draft_id": "42"}, ensure_ascii=False),
                    db.now(),
                ),
            )
            draft_quota_ok = manager.published_today(mp_account["id"]) == 0
            mp_row = manager.get_row(mp_account["id"])
            draft_ok, _, _ = manager.availability(mp_row, count_quota=False)
            # 只写草稿的公众号不再有群发额度概念：草稿记录不占用任何额度。
            quota_ok = draft_quota_ok and draft_ok

            # 已发表新接口：publish_page / publish_info 都是 JSON 字符串
            nested = {
                "publish_page": json.dumps(
                    {
                        "publish_list": [
                            {
                                "publish_info": json.dumps(
                                    {
                                        "appmsgex": [
                                            {
                                                "aid": "22001",
                                                "title": "嵌套文章",
                                                "readNum": 321,
                                                "likeNum": 12,
                                                "shareNum": 3,
                                                "sent_time": 1_700_000_000,
                                            }
                                        ]
                                    },
                                    ensure_ascii=False,
                                )
                            }
                        ]
                    },
                    ensure_ascii=False,
                )
            }
            nested_items, _ = _published_items(nested)
            nested_ok = (
                len(nested_items) == 1
                and nested_items[0]["remote_note_id"] == "22001"
                and nested_items[0]["views"] == 321
                and nested_items[0]["likes"] == 12
                and nested_items[0]["shares"] == 3
                and nested_items[0]["published_at"] == 1_700_000_000
            )

            # 登录页解析：ticket / user_name / svr_time 要能从 HTML 里拿到
            parsed = _parse_account(
                '<script>wx.data.ticket = "ticket-1"; '
                'wx.data.user_name = "gh_selfcheck"; var svr_time = 1700000000;</script>'
            )
            account_fields_ok = (
                parsed["ticket"] == "ticket-1"
                and parsed["user_name"] == "gh_selfcheck"
                and parsed["svr_time"] == "1700000000"
            )

            # 扫码窗口策略：默认真正无头（不出现任何窗口），不再用窗口坐标把戏
            saved_mode = os.environ.pop("OPS_QR_MODE", None)
            saved_legacy = os.environ.pop("OPS_QR_HEADLESS", None)
            try:
                default_mode = qr_mode()
                default_headless = qr_headless()
            finally:
                if saved_mode is not None:
                    os.environ["OPS_QR_MODE"] = saved_mode
                if saved_legacy is not None:
                    os.environ["OPS_QR_HEADLESS"] = saved_legacy
            headless_kwargs = BrowserOptions(headless=True).launch_kwargs()
            args = headless_kwargs.get("args") or []
            window_ok = (
                default_mode == "headless"
                and default_headless is True
                and headless_kwargs.get("headless") is True
                and "--window-position=-10000,-10000" not in args
                and "--start-minimized" not in args
            )

            # 无头时只提示「需要人工」，不能自己弹窗；只有 open_window 之后才 window_open
            probe = WechatQrSession.__new__(WechatQrSession)
            probe.status = "needs_action"
            probe.message = "检测到多个公众号，需要人工选择目标号"
            probe.nickname = ""
            probe.fakeid = ""
            probe._headless = True
            probe._visible = False
            probe._window_used = False
            probe._needs_action_until = 0.0
            probe._notice = probe.message
            probe.diagnostics = {}
            headless_payload = probe.payload()
            probe._visible = True
            probe._window_used = True
            probe._needs_action_until = time.time() + 120
            visible_payload = probe.payload()
            notice_ok = (
                headless_payload["requires_window"] is True
                and headless_payload["window_open"] is False
                and headless_payload["headless"] is True
                and headless_payload["mode"] == "headless"
                and headless_payload["visible_window_used"] is False
                and visible_payload["requires_window"] is False
                and visible_payload["window_open"] is True
                and visible_payload["mode"] == "visible"
                and visible_payload["visible_window_used"] is True
                and visible_payload["deadline"] > 0
            )

            results.append(
                _ok(
                    "新平台规格与分类",
                    bool(dy_problems)
                    and bool(mp_problems)
                    and action_ok
                    and kinds == ["auth", "content", "rate", "platform", "network"]
                    and ids_ok
                    and metrics_ok
                    and metrics_full_ok
                    and draft_send_ok
                    and session_ok
                    and quota_ok
                    and nested_ok
                    and account_fields_ok
                    and window_ok
                    and notice_ok,
                    f"抖音拦截={len(dy_problems)} 公众号拦截={len(mp_problems)} 分类={kinds} 只写草稿={draft_send_ok} 不占额度={quota_ok} 会话={session_ok} 嵌套回收={nested_ok} 登录字段={account_fields_ok} 无头={window_ok} 提示={notice_ok}",
                )
            )
        except Exception as exc:  # noqa: BLE001
            results.append(_ok("平台注册表", False, str(exc)))
            results.append(_ok("平台字段迁移", False, str(exc)))
            results.append(_ok("跨平台发布拦截", False, str(exc)))
            results.append(_ok("新平台规格与分类", False, str(exc)))

        # 14.2 三平台文案：同一份输入，结构、篇幅、话题写法、标题上限都要不同
        try:
            brief = "秋招面试被问到缺点，怎么回答才不吃亏"
            outputs = {
                key: generate_from_brief(
                    brief,
                    topic="面试缺点怎么答",
                    tone="informative",
                    use_llm=False,
                    platform=key,
                )
                for key in ("xiaohongshu", "wechat_mp", "douyin")
            }
            xhs = outputs["xiaohongshu"]
            mp = outputs["wechat_mp"]
            dy = outputs["douyin"]

            def body_len(item: dict) -> int:
                return len("".join(str(item.get("desc") or "").split()))

            platforms_ok = all(item["platform"] == key for key, item in outputs.items())
            xhs_ok = (
                "姐妹们" not in xhs["desc"]
                and "✨" not in xhs["desc"]
                and "内测中" not in xhs["desc"]
                and bool(xhs["topics"])
                and f"#{xhs['topics'][0]}" in xhs["desc"]
            )
            mp_ok = (
                "一、" in mp["desc"]
                and "二、" in mp["desc"]
                and "三、" in mp["desc"]
                and "姐妹们" not in mp["desc"]
                and body_len(mp) > body_len(xhs) * 1.4
                and bool(mp["topics"])
                and f"#{mp['topics'][0]}#" in mp["desc"]
            )
            dy_ok = (
                "【前3秒】" not in dy["desc"]
                and "【画面】" not in dy["desc"]
                and "【口播】" not in dy["desc"]
                and body_len(dy) < body_len(mp) * 0.5
            )
            limits_ok = (
                len(xhs["title"]) <= 20
                and len(mp["title"]) <= 64
                and len(dy["title"]) <= 55
            )
            distinct_ok = len({item["desc"] for item in outputs.values()}) == 3
            results.append(
                _ok(
                    "三平台文案差异",
                    platforms_ok and xhs_ok and mp_ok and dy_ok and limits_ok and distinct_ok,
                    "小红书={} 公众号={} 抖音={} 标题长度={}".format(
                        body_len(xhs),
                        body_len(mp),
                        body_len(dy),
                        [len(item["title"]) for item in outputs.values()],
                    ),
                )
            )
        except Exception as exc:  # noqa: BLE001
            results.append(_ok("三平台文案差异", False, str(exc)))

        # 15. 已发布内容：平台缓存优先、本地记录兜底、模拟记录排除、筛选分页
        try:
            from ops.published import PublishedService

            stamp = db.now()
            acc_id = db.execute(
                "INSERT INTO accounts(platform, name, cookie_enc, created_at, updated_at) "
                "VALUES('xiaohongshu', '回收测试号', 'x', ?, ?)",
                (stamp, stamp),
            )
            draft_id = db.execute(
                "INSERT INTO drafts(platform, content_type, title, desc, media_type, images, "
                "visibility, created_at, updated_at) VALUES('xiaohongshu', 'image_text', "
                "'回收草稿', '正文', 'image', '[\"/tmp/a.png\"]', 0, ?, ?)",
                (stamp, stamp),
            )
            for remote, message, result in (
                ("abc123", "发布成功", "{}"),
                ("def456", "模拟发布成功（未真正发送到小红书）", '{"simulated": true}'),
                ("ghi789", "发布成功", "{}"),
            ):
                db.execute(
                    "INSERT INTO records(draft_id, account_id, platform, success, message, "
                    "remote_note_id, result, created_at) VALUES(?,?, 'xiaohongshu', 1, ?, ?, ?, ?)",
                    (draft_id, acc_id, message, remote, result, stamp),
                )
            db.execute(
                "INSERT INTO published_notes(platform, account_id, remote_note_id, title, desc, "
                "cover, note_type, visibility, views, likes, comments, collects, published_at, "
                "url, raw, synced_at, created_at, updated_at) VALUES('xiaohongshu', ?, 'abc123', "
                "'平台标题', '平台正文', 'https://img', 'image', '公开', 100, 5, 2, 3, ?, "
                "'https://x/abc123', '{}', ?, ?, ?)",
                (acc_id, stamp, stamp, stamp, stamp),
            )
            # 平台没给指标时必须落 NULL，而不是伪装成 0 阅读。
            db.execute(
                "INSERT INTO published_notes(platform, account_id, remote_note_id, title, desc, "
                "cover, note_type, visibility, views, likes, comments, collects, published_at, "
                "url, raw, synced_at, created_at, updated_at) VALUES('xiaohongshu', ?, 'null999', "
                "'无指标标题', '正文', '', 'image', '', NULL, NULL, NULL, NULL, ?, "
                "'https://x/null999', '{}', ?, ?, ?)",
                (acc_id, stamp, stamp, stamp, stamp),
            )
            svc = PublishedService()
            listing = svc.list_notes(account_id=acc_id, include_local=True, limit=20)
            keys = {item["remote_note_id"]: item for item in listing["items"]}
            filtered = svc.list_notes(account_id=acc_id, since=stamp + 60)
            page = svc.list_notes(account_id=acc_id, limit=1, offset=1)
            status = svc.accounts_status()
            db.execute(
                "UPDATE accounts SET published_sync_error=? WHERE id=?",
                ("RuntimeError: https://internal.example/api failed", acc_id),
            )
            sanitized_error = next(
                item for item in svc.accounts_status() if item["account_id"] == acc_id
            )["sync_error"]
            sanitized_ok = "internal" not in sanitized_error and bool(sanitized_error)
            import ops.published as published_module

            original_limit = published_module.PUBLISHED_QUERY_LIMIT
            published_module.PUBLISHED_QUERY_LIMIT = 1
            try:
                truncated = svc.list_notes(account_id=acc_id, include_local=False)
            finally:
                published_module.PUBLISHED_QUERY_LIMIT = original_limit
            truncation_ok = (
                truncated["meta"]["truncated"] is True
                and truncated["meta"]["total_exact"] is False
                and bool(truncated["meta"]["notice"])
                and truncated["meta"]["query_limit"] == 1
            )
            svc.accounts.delete_account(acc_id)
            cascade_ok = (
                db.scalar(
                    "SELECT COUNT(*) FROM published_notes WHERE account_id = ?", (acc_id,), 0
                )
                == 0
            )
            ok = (
                listing["total"] == 3
                and keys["abc123"]["source"] == "platform"
                and keys["abc123"]["views"] == 100
                and keys["abc123"]["metrics_available"] is True
                and keys["abc123"]["local_draft_id"] == draft_id
                and keys["null999"]["views"] is None
                and keys["null999"]["metrics_available"] is False
                and keys["ghi789"]["source"] == "local_record"
                and keys["ghi789"]["views"] is None
                and "def456" not in keys
                and filtered["total"] == 0
                and page["total"] == 3
                and len(page["items"]) == 1
                and any(item["account_id"] == acc_id for item in status)
                and sanitized_ok
                and truncation_ok
                and cascade_ok
            )
            results.append(
                _ok(
                    "已发布内容回收",
                    ok,
                    f"总数={listing['total']} 平台阅读={keys.get('abc123', {}).get('views')} "
                    f"缺失指标={keys.get('null999', {}).get('views')} "
                    f"本地占位={keys.get('ghi789', {}).get('source')} "
                    f"模拟排除={'def456' not in keys} 时间筛选={filtered['total']} "
                    f"分页={len(page['items'])} 错误脱敏={sanitized_ok} "
                    f"截断提示={truncation_ok} 删号级联={cascade_ok}",
                )
            )
        except Exception as exc:  # noqa: BLE001
            results.append(_ok("已发布内容回收", False, str(exc)))

        # 16. 事务嵌套：内层 db.execute 不能提前提交外层事务
        try:
            probe = "__txn_probe__"
            nested = "__txn_nested__"
            db.execute(
                "INSERT INTO settings(key, value) VALUES(?, 'outer') "
                "ON CONFLICT(key) DO UPDATE SET value='outer'",
                (probe,),
            )
            try:
                with db.transaction() as conn:
                    conn.execute("UPDATE settings SET value='inner' WHERE key=?", (probe,))
                    db.execute(
                        "INSERT INTO settings(key, value) VALUES(?, 'nested') "
                        "ON CONFLICT(key) DO UPDATE SET value='nested'",
                        (nested,),
                    )
                    raise RuntimeError("模拟回滚")
            except RuntimeError:
                pass
            value = db.scalar("SELECT value FROM settings WHERE key=?", (probe,), "")
            rows = db.scalar("SELECT COUNT(*) FROM settings WHERE key=?", (nested,), 0)
            results.append(
                _ok(
                    "事务嵌套保护",
                    value == "outer" and rows == 0,
                    f"外层值={value} 内层残留={rows}",
                )
            )
        except Exception as exc:  # noqa: BLE001
            results.append(_ok("事务嵌套保护", False, str(exc)))

        # 17. 上传只认真实图片文件头，并统一安全响应头
        try:
            import asyncio
            from types import SimpleNamespace

            from aiohttp import web

            from ops.web.common import _image_matches_suffix, _no_cache, _sniff_image

            png_head = base64.b64decode(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII="
            )[:16]
            sniff_ok = (
                _image_matches_suffix(_sniff_image(png_head), ".png")
                and not _image_matches_suffix(_sniff_image(b"<html>not image"), ".png")
                and _sniff_image(b"<svg xmlns='http://www.w3.org/2000/svg'></svg>") == ""
            )
            results.append(
                _ok(
                    "上传内容校验",
                    sniff_ok,
                    f"png={_sniff_image(png_head)} html={_sniff_image(b'<html>not image')!r}",
                )
            )

            async def _probe_headers():
                async def _handler(_request):
                    return web.Response(text="ok")

                response = await _no_cache(
                    SimpleNamespace(path="/api/health"), _handler
                )
                return response.headers

            headers = asyncio.run(_probe_headers())
            required = {
                "X-Content-Type-Options": "nosniff",
                "X-Frame-Options": "DENY",
                "Referrer-Policy": "no-referrer",
            }
            header_ok = all(headers.get(key) == value for key, value in required.items())
            header_ok = header_ok and "frame-ancestors 'none'" in headers.get(
                "Content-Security-Policy", ""
            )
            results.append(
                _ok(
                    "安全响应头",
                    header_ok,
                    f"nosniff={headers.get('X-Content-Type-Options')} "
                    f"frame={headers.get('X-Frame-Options')} "
                    f"csp={'frame-ancestors' in headers.get('Content-Security-Policy', '')}",
                )
            )
        except Exception as exc:  # noqa: BLE001
            results.append(_ok("上传内容校验", False, str(exc)))
            results.append(_ok("安全响应头", False, str(exc)))

        # 18. 模拟发布不占真实日限额
        try:
            limit_account = _new_account("simulated-limit")
            stamp = db.now()
            db.execute(
                "INSERT INTO records(draft_id, account_id, platform, success, message, "
                "remote_note_id, result, created_at) VALUES(0,?, 'xiaohongshu', 1, "
                "'模拟发布成功（未真正发送）', 'sim001', '{\"simulated\": true}', ?)",
                (limit_account, stamp),
            )
            after_simulated = AccountManager().published_today(limit_account)
            db.execute(
                "INSERT INTO records(draft_id, account_id, platform, success, message, "
                "remote_note_id, result, created_at) VALUES(0,?, 'xiaohongshu', 1, "
                "'发布成功', 'real001', '{}', ?)",
                (limit_account, stamp),
            )
            after_real = AccountManager().published_today(limit_account)
            results.append(
                _ok(
                    "模拟发布不占限额",
                    after_simulated == 0 and after_real == 1,
                    f"模拟后={after_simulated} 真实后={after_real}",
                )
            )
        except Exception as exc:  # noqa: BLE001
            results.append(_ok("模拟发布不占限额", False, str(exc)))

        # 19. 话题写法按平台区分：小红书 #话题，公众号 #话题#
        try:
            from ops.content import format_topic, normalize_desc

            xhs_desc = normalize_desc("正文", ["求职"], platform="xiaohongshu")
            mp_desc = normalize_desc("正文", ["求职"], platform="wechat_mp")
            topic_ok = (
                "#求职" in xhs_desc
                and "#求职#" not in xhs_desc
                and "#求职#" in mp_desc
                and format_topic("求职", "none") == ""
            )
            results.append(
                _ok(
                    "平台话题写法",
                    topic_ok,
                    f"小红书={xhs_desc.splitlines()[-1]!r} 公众号={mp_desc.splitlines()[-1]!r}",
                )
            )
        except Exception as exc:  # noqa: BLE001
            results.append(_ok("平台话题写法", False, str(exc)))

        # 20. 列表接口分页与全局统计字段
        try:
            import asyncio
            from types import SimpleNamespace

            from ops.web.routers import accounts as accounts_router
            from ops.web.routers import queue as queue_router
            from ops.web.routers import schedules as schedules_router

            fake = SimpleNamespace(
                accounts=SimpleNamespace(
                    list_accounts=lambda platform="": [{"id": 1}, {"id": 2}]
                ),
                queue=SimpleNamespace(
                    list_records=lambda limit, offset: [{"id": 1}],
                    count_records_summary=lambda: {
                        "total": 5,
                        "success_total": 4,
                        "failed_total": 1,
                    },
                ),
                list_schedules=lambda limit, offset=0: [{"id": 9}],
                count_schedules=lambda: 3,
            )

            def _request(query=None):
                return SimpleNamespace(app={"service": fake}, query=query or {})

            async def _call_lists():
                accounts = await accounts_router.list_accounts(_request())
                records = await queue_router.list_records(
                    _request({"limit": "1", "offset": "2"})
                )
                schedules = await schedules_router.list_schedules(
                    _request({"limit": "10", "offset": "5"})
                )
                return (
                    json.loads(accounts.body),
                    json.loads(records.body),
                    json.loads(schedules.body),
                )

            accounts_body, records_body, schedules_body = asyncio.run(_call_lists())
            fields_ok = (
                accounts_body["total"] == 2
                and len(accounts_body["data"]) == 2
                and records_body["total"] == 5
                and records_body["success_total"] == 4
                and records_body["failed_total"] == 1
                and records_body["limit"] == 1
                and records_body["offset"] == 2
                and schedules_body["total"] == 3
                and schedules_body["limit"] == 10
                and schedules_body["offset"] == 5
            )
            results.append(
                _ok(
                    "列表分页字段",
                    fields_ok,
                    f"accounts.total={accounts_body.get('total')} "
                    f"records={records_body.get('success_total')}/{records_body.get('failed_total')}"
                    f"/{records_body.get('total')} "
                    f"schedules={schedules_body.get('total')}@{schedules_body.get('offset')}",
                )
            )
        except Exception as exc:  # noqa: BLE001
            results.append(_ok("列表分页字段", False, str(exc)))

        # 21. 模型请求硬超时：底层请求挂起也必须按时返回
        try:
            import ops.llm as llm_mod

            client = object.__new__(llm_mod.LLMClient)
            client.base_url = "http://llm.invalid/v1"
            client.model = "test-model"
            client.api_key = "test-key"
            original_post = llm_mod.requests.post

            def _hang(*args, **kwargs):
                time.sleep(2)
                raise RuntimeError("底层请求不应阻塞到这里")

            llm_mod.requests.post = _hang
            started = time.monotonic()
            timed_out = False
            try:
                client.chat([{"role": "user", "content": "hi"}], timeout=0.3)
            except llm_mod.LLMError:
                timed_out = True
            finally:
                llm_mod.requests.post = original_post
            elapsed = time.monotonic() - started
            results.append(
                _ok(
                    "模型请求硬超时",
                    timed_out and elapsed < 1.5,
                    f"超时={timed_out} 耗时={elapsed:.2f}s",
                )
            )
        except Exception as exc:  # noqa: BLE001
            results.append(_ok("模型请求硬超时", False, str(exc)))

        # 22. 模型失败时离线兜底真正接管
        try:
            import ops.content as content_mod
            import ops.llm as llm_mod

            original_client = content_mod.LLMClient

            class _FailingClient:
                configured = True

                def chat(self, *args, **kwargs):
                    raise llm_mod.LLMError("模型响应超时（测试）")

            content_mod.LLMClient = _FailingClient
            try:
                fallback = content_mod.generate_from_brief("测试离线兜底", use_llm=True)
            finally:
                content_mod.LLMClient = original_client
            results.append(
                _ok(
                    "离线兜底接管",
                    fallback["engine"] == "offline"
                    and fallback["retryable"] is True
                    and "超时" in fallback["llm_error"]
                    and bool(fallback["title"])
                    and bool(fallback["desc"]),
                    f"引擎={fallback['engine']} 提示={fallback['llm_error']}",
                )
            )
        except Exception as exc:  # noqa: BLE001
            results.append(_ok("离线兜底接管", False, str(exc)))

        # 22.1 云端账号隔离：未登录时页面状态不含票据，生成入口直接给出登录提示
        try:
            import ops.llm as llm_mod
            from ops import cloud

            state = cloud.status()
            leaked = any(
                word in json.dumps(state, ensure_ascii=False)
                for word in ("eqk_", "sk-", '"token"')
            )
            blocked = cloud.blocked_reason("llm")
            client = llm_mod.LLMClient()
            login_blocked = False
            try:
                client.chat([{"role": "user", "content": "hi"}], timeout=0.2)
            except llm_mod.LLMError:
                login_blocked = True
            results.append(
                _ok(
                    "云端账号隔离",
                    (not state["logged_in"])
                    and not leaked
                    and "登录" in blocked
                    and login_blocked,
                    f"logged_in={state['logged_in']} leaked={leaked} 提示={blocked}",
                )
            )
        except Exception as exc:  # noqa: BLE001
            results.append(_ok("云端账号隔离", False, str(exc)))

        # 23. 后台任务看门狗：线程卡死时轮询必须拿到明确失败
        try:
            from ops.service import TaskCenter

            center = TaskCenter()

            def _stuck():
                time.sleep(2)
                return []

            task = center.submit("test", "selfcheck-watchdog", _stuck, timeout_sec=1)
            time.sleep(1.3)
            state = center.get(task["id"])
            results.append(
                _ok(
                    "后台任务看门狗",
                    state["status"] == "failed" and "超时" in state["error"],
                    f"状态={state['status']} 提示={state['error']}",
                )
            )
        except Exception as exc:  # noqa: BLE001
            results.append(_ok("后台任务看门狗", False, str(exc)))

        # 24. 同步接口超时兜底：阻塞函数不会让请求无限挂起
        try:
            import asyncio

            from ops.web.common import _blocking

            async def _probe_blocking():
                try:
                    await _blocking(time.sleep, 2, timeout=0.2)
                except TimeoutError:
                    return True
                return False

            results.append(
                _ok(
                    "接口超时兜底",
                    asyncio.run(_probe_blocking()),
                    "阻塞函数 0.2 秒后触发 TimeoutError",
                )
            )
        except Exception as exc:  # noqa: BLE001
            results.append(_ok("接口超时兜底", False, str(exc)))

        # 25. 发布结果待确认：不自动重试，人工确认后才落成功/失败
        try:
            from ops.content import DraftService
            from ops.publisher import PublishQueue

            stamp = db.now()
            draft = DraftService().create_manual(
                title="待确认自检", desc="正文", topics=[], images=[]
            )
            queue = PublishQueue()
            job = queue.enqueue(draft["id"])
            db.execute(
                "UPDATE jobs SET status='pending_confirm', result_state='pending_confirm', "
                "confirm_deadline=?, last_error='结果待确认：自检' WHERE id=?",
                (stamp + 3600, job["id"]),
            )
            retry_blocked = False
            try:
                queue.retry(job["id"])
            except ValueError:
                retry_blocked = True
            confirmed = queue.confirm(job["id"], True)
            draft_row = db.query_one("SELECT status FROM drafts WHERE id=?", (draft["id"],))
            record = db.scalar(
                "SELECT COUNT(*) FROM records WHERE job_id=? AND success=1", (job["id"],), 0
            )
            results.append(
                _ok(
                    "发布待确认与人工确认",
                    retry_blocked
                    and confirmed["status"] == "success"
                    and draft_row["status"] == "published"
                    and record == 1,
                    f"禁自动重试={retry_blocked} 确认后={confirmed['status']} "
                    f"草稿={draft_row['status']} 成功记录={record}",
                )
            )
        except Exception as exc:  # noqa: BLE001
            results.append(_ok("发布待确认与人工确认", False, str(exc)))

        # 26. 作品健康、指标趋势与评论只读
        try:
            from ops.published import PublishedService

            manager = AccountManager()
            account = manager.add_session(
                "xiaohongshu",
                "健康自检号",
                {"cookies": "a=1", "origins": []},
                nickname="健康自检号",
                user_id=f"health-{db.now()}",
            )
            stamp = db.now()
            note_id = db.execute(
                "INSERT INTO published_notes(platform, account_id, remote_note_id, title, desc, "
                "cover, note_type, visibility, views, likes, comments, collects, published_at, "
                "url, raw, synced_at, created_at, updated_at) "
                "VALUES('xiaohongshu', ?, 'health-1', '零浏览作品', '正文', '', 'image', '', "
                "0, 0, 0, 0, ?, '', '{}', ?, ?, ?)",
                (account["id"], stamp - 2 * 86400, stamp, stamp, stamp),
            )
            db.execute(
                "INSERT INTO published_metrics_daily(note_id, day, views, likes, comments, "
                "collects, captured_at) VALUES(?, date('now'), 0, 0, 0, 0, ?)",
                (note_id, stamp),
            )
            svc = PublishedService(manager)
            health = svc.health_check(account_id=account["id"])
            state = db.scalar(
                "SELECT health_state FROM published_notes WHERE id=?", (note_id,), ""
            )
            metrics = svc.metrics(note_id, 7)
            douyin_note = db.execute(
                "INSERT INTO published_notes(platform, account_id, remote_note_id, title, desc, "
                "cover, note_type, visibility, views, likes, comments, collects, published_at, "
                "url, raw, synced_at, created_at, updated_at) "
                "VALUES('douyin', ?, 'dy-1', '抖音作品', '正文', '', 'video', '', 10, 1, 0, 0, "
                "?, '', '{}', ?, ?, ?)",
                (account["id"], stamp, stamp, stamp, stamp),
            )
            comments = svc.list_comments(douyin_note)
            comment_blocked = False
            try:
                svc.sync_comments(douyin_note)
            except ValueError:
                comment_blocked = True
            results.append(
                _ok(
                    "作品健康与评论只读",
                    health["checked"] >= 1
                    and state == "zero_views"
                    and len(metrics["series"]) == 7
                    and metrics["days"] == 7
                    and comments["supported"] is False
                    and "暂不支持" in comments["empty_text"]
                    and comment_blocked,
                    f"检查={health['checked']} 状态={state} 趋势点={len(metrics['series'])} "
                    f"评论支持={comments['supported']} 拦截={comment_blocked}",
                )
            )
        except Exception as exc:  # noqa: BLE001
            results.append(_ok("作品健康与评论只读", False, str(exc)))

        # 27. 通知：站内消息可读可标记；渠道可增删
        try:
            from ops.notify import NotifyCenter

            center = NotifyCenter()
            event = center.emit(
                "publish_failed",
                "自检通知",
                "这是一条自检消息",
                link_view="records",
                link_id=0,
                dedupe=False,
            )
            listing = center.list_events(limit=20)
            channel = center.add_channel(
                {
                    "channel": "webhook",
                    "name": "自检渠道",
                    "target": "https://example.invalid/hook",
                    "events": ["all"],
                }
            )
            updated = center.mark_read([event["id"]])
            center.delete_channel(channel["id"])
            results.append(
                _ok(
                    "通知中心",
                    bool(event)
                    and listing["total"] >= 1
                    and updated >= 1
                    and channel["id"] > 0,
                    f"消息={listing['total']} 已读={updated} 渠道={channel['id']}",
                )
            )
        except Exception as exc:  # noqa: BLE001
            results.append(_ok("通知中心", False, str(exc)))

        # 28. 备份与恢复：加密文件可创建、列出并恢复
        try:
            from ops.backup import BackupService

            backups = BackupService()
            created = backups.create(include_images=False, include_key=False)
            listed = backups.list_backups()
            restored = backups.restore(created["name"])
            alive = db.scalar("SELECT COUNT(*) FROM accounts", (), 0) >= 0
            results.append(
                _ok(
                    "备份与恢复",
                    created["name"].endswith(".eqbak")
                    and any(item["name"] == created["name"] for item in listed)
                    and bool(restored.get("safety_backup"))
                    and alive,
                    f"文件={created['name']} 列表={len(listed)} 恢复={restored.get('name')}",
                )
            )
        except Exception as exc:  # noqa: BLE001
            results.append(_ok("备份与恢复", False, str(exc)))

        # 29. 账号诊断、写预算、分组与批量启停
        try:
            manager = AccountManager()
            stamp = db.now()
            account_id = db.execute(
                "INSERT INTO accounts(platform, name, cookie_enc, enabled, status, "
                "created_at, updated_at) VALUES('xiaohongshu', '诊断自检号', 'x', 1, "
                "'healthy', ?, ?)",
                (stamp, stamp),
            )
            manager._ensure_profile(account_id)
            diag = manager.diagnose(account_id)
            until = manager.note_risk(account_id, "rate_limited", "自检限流")
            row = manager.get_row(account_id)
            blocked, reason, _ = manager.availability(row)
            manager.clear_cooldown(account_id, manual=True)
            after = manager.get_row(account_id)
            manager.batch("disable", [account_id])
            disabled = not manager.get_row(account_id)["enabled"]
            proxy_blocked = False
            try:
                manager.proxy_test(account_id)
            except ValueError:
                proxy_blocked = True
            results.append(
                _ok(
                    "账号诊断与批量操作",
                    bool(diag["account"]["profile_key"])
                    and diag["publish"]["daily_limit"] > 0
                    and until > stamp
                    and not blocked
                    and "风控冷却" in reason
                    and int(after["cooldown_until"]) == 0
                    and after["health_state"] == "healthy"
                    and disabled
                    and proxy_blocked,
                    f"profile={diag['account']['profile_key']} 冷却至={until} "
                    f"阻断={reason} 解冻后={after['health_state']} 停用={disabled}",
                )
            )
        except Exception as exc:  # noqa: BLE001
            results.append(_ok("账号诊断与批量操作", False, str(exc)))

        # 30. 队列受阻原因可聚合、可按原因筛选
        try:
            from ops.publisher import PublishQueue

            queue = PublishQueue()
            stamp = db.now()
            draft = DraftService().create_manual(
                title="受阻原因自检", desc="正文", topics=[], images=[]
            )
            job = queue.enqueue(draft["id"])
            db.execute(
                "UPDATE jobs SET status='pending', blocked_reason='平台限流，等待冷却', "
                "blocked_at=? WHERE id=?",
                (stamp, job["id"]),
            )
            reasons = queue.queue_reasons()
            filtered = queue.list_jobs(limit=10, status="waiting", reason="平台限流，等待冷却")
            results.append(
                _ok(
                    "队列受阻原因",
                    any(
                        group["reason"] == "平台限流，等待冷却" and group["count"] >= 1
                        for group in reasons["groups"]
                    )
                    and any(item["id"] == job["id"] for item in filtered),
                    f"分组={[item['reason'] for item in reasons['groups']]} 命中={len(filtered)}",
                )
            )
        except Exception as exc:  # noqa: BLE001
            results.append(_ok("队列受阻原因", False, str(exc)))

        # 31. 启动回收中断任务：已提交转待确认，未提交回队列
        try:
            from ops.publisher import PublishQueue

            queue = PublishQueue()
            stamp = db.now()
            submitted_draft = DraftService().create_manual(
                title="已提交自检", desc="正文", topics=[], images=[]
            )
            unsent_draft = DraftService().create_manual(
                title="未提交自检", desc="正文", topics=[], images=[]
            )
            submitted_job = queue.enqueue(submitted_draft["id"])
            unsent_job = queue.enqueue(unsent_draft["id"])
            db.execute(
                "UPDATE jobs SET status='running', submitted_at=? WHERE id=?",
                (stamp, submitted_job["id"]),
            )
            db.execute(
                "UPDATE jobs SET status='running', submitted_at=0 WHERE id=?",
                (unsent_job["id"],),
            )
            recovered = queue.recover_interrupted()
            submitted_row = db.query_one(
                "SELECT * FROM jobs WHERE id=?", (submitted_job["id"],)
            )
            unsent_row = db.query_one(
                "SELECT * FROM jobs WHERE id=?", (unsent_job["id"],)
            )
            results.append(
                _ok(
                    "中断任务回收",
                    recovered["pending_confirm"] >= 1
                    and recovered["requeued"] >= 1
                    and submitted_row["status"] == "pending_confirm"
                    and unsent_row["status"] == "pending",
                    f"待确认={recovered['pending_confirm']} "
                    f"重新排队={recovered['requeued']}",
                )
            )
        except Exception as exc:  # noqa: BLE001
            results.append(_ok("中断任务回收", False, str(exc)))

        # 32. 冷却结束后连续探测成功才恢复发布
        try:
            from ops.platforms.xiaohongshu import XiaohongshuAdapter

            manager = AccountManager()
            stamp = db.now()
            account_id = db.execute(
                "INSERT INTO accounts(platform, name, cookie_enc, enabled, status, "
                "health_state, cooldown_until, probe_success_count, created_at, updated_at) "
                "VALUES('xiaohongshu', '探测自检号', 'x', 1, 'healthy', 'risk', ?, 0, ?, ?)",
                (stamp - 1, stamp, stamp),
            )
            original = XiaohongshuAdapter.check_session

            def _fake_check(self, account):  # noqa: ANN001
                return {"ok": True, "nickname": "探测自检号"}

            XiaohongshuAdapter.check_session = _fake_check
            try:
                first = manager.check_health(account_id)
                middle = manager.get_row(account_id)
                blocked, reason, _ = manager.availability(middle)
                second = manager.check_health(account_id)
                final = manager.get_row(account_id)
            finally:
                XiaohongshuAdapter.check_session = original
            results.append(
                _ok(
                    "冷却后连续探测",
                    bool(first.get("probing"))
                    and middle["health_state"] == "probing"
                    and not blocked
                    and "探测中" in reason
                    and final["health_state"] == "healthy"
                    and int(final["probe_success_count"]) == 0,
                    f"第一次={middle['health_state']} 第二次={final['health_state']} "
                    f"阻断={reason}",
                )
            )
        except Exception as exc:  # noqa: BLE001
            results.append(_ok("冷却后连续探测", False, str(exc)))

        # 33. 抖音登录判定不依赖 Cookie，只认页面登录墙
        try:
            from ops.platforms import douyin as douyin_module

            class _EmptyLocator:
                @property
                def first(self):
                    return self

                def count(self):
                    return 0

            class _Page:
                def __init__(self, url):
                    self.url = url

                def get_by_text(self, text, exact=True):  # noqa: ANN001
                    return _EmptyLocator()

            logged_in = douyin_module.DouyinAdapter._login_wall(
                _Page("https://creator.douyin.com/creator-micro/home")
            )
            login_page = douyin_module.DouyinAdapter._login_wall(
                _Page("https://creator.douyin.com/passport/login")
            )
            results.append(
                _ok(
                    "抖音登录三分态",
                    not hasattr(douyin_module, "_has_login_cookie")
                    and not logged_in
                    and login_page,
                    f"创作者中心登录墙={logged_in} 登录页登录墙={login_page}",
                )
            )
        except Exception as exc:  # noqa: BLE001
            results.append(_ok("抖音登录三分态", False, str(exc)))

        # 34. 公众号精选留言：归一化 + probe 模式
        try:
            from ops.platforms import get_platform
            from ops.platforms.wechat_mp import WechatMpAdapter, normalize_comment
            from ops.published import PublishedService

            normalized = normalize_comment(
                {
                    "id": 2026,
                    "nick_name": "读者",
                    "content": "写得好",
                    "like_num": "1.2万",
                    "create_time": 1700000000,
                }
            )
            service = PublishedService(AccountManager())
            results.append(
                _ok(
                    "公众号精选留言",
                    normalized["remote_comment_id"] == "2026"
                    and normalized["likes"] == 12000
                    and service._comments_mode(WechatMpAdapter()) == "probe"
                    and service._comments_mode(get_platform("xiaohongshu", AccountManager()))
                    == "read",
                    f"留言={normalized['remote_comment_id']} 赞={normalized['likes']} "
                    f"模式={service._comments_mode(WechatMpAdapter())}",
                )
            )
        except Exception as exc:  # noqa: BLE001
            results.append(_ok("公众号精选留言", False, str(exc)))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    _check_docs(results)

    failed = 0
    for name, passed, detail in results:
        mark = "PASS" if passed else "FAIL"
        if not passed:
            failed += 1
        print(f"[{mark}] {name}" + (f"  ({detail})" if detail else ""))
    print(json.dumps({"total": len(results), "failed": failed}, ensure_ascii=False))
    return 1 if failed else 0


def _check_docs(results: list[tuple[str, bool, str]]) -> None:
    """文档对账：接口和环境变量不能再各说各话。

    今天的「模型连不上」就是文档/配置默认值和云端契约脱节造成的，
    这两条检查让同类问题在自检里直接暴露，而不是等用户点到报错。
    """
    root = Path(__file__).resolve().parent.parent
    shape = lambda path: re.sub(r"\{[^}]+\}", "{}", path)  # noqa: E731

    try:
        from ops.web.routers import (
            accounts,
            admin,
            cloud,
            drafts,
            published,
            queue,
            schedules,
            site,
            topics,
        )

        real: set[str] = set()
        for module in (site, published, accounts, topics, drafts, queue, schedules, cloud, admin):
            for route in module.routes:
                path = getattr(route, "path", "")
                if path.startswith("/api"):
                    real.add(shape(path))

        stale: list[str] = []
        api_doc = root / "docs" / "API.md"
        if api_doc.is_file():
            for line in api_doc.read_text(encoding="utf-8").splitlines():
                # 标注「云端」的行是 EchoQ-Cloud 的接口，不在本机路由表里。
                if "云端" in line:
                    continue
                for path in re.findall(r"`(/api/[A-Za-z0-9_/{}\-]+)`", line):
                    if shape(path.rstrip("/")) not in real:
                        stale.append(path)
        results.append(
            _ok(
                "文档接口与路由一致",
                not stale,
                "文档里有、代码里没有: " + "、".join(sorted(set(stale))[:6]) if stale else "",
            )
        )
    except Exception as exc:  # noqa: BLE001
        results.append(_ok("文档接口与路由一致", False, str(exc)))

    try:
        code_env: set[str] = set()
        for source in list((root / "ops").rglob("*.py")) + list((root / "vendor").rglob("*.py")):
            code_env.update(
                re.findall(
                    r"[\"'](OPS_[A-Z0-9_]+)[\"']",
                    source.read_text(encoding="utf-8", errors="ignore"),
                )
            )

        doc_env: set[str] = set()
        for doc in list((root / "docs").glob("*.md")) + [root / "README.md", root / ".env.example"]:
            # 上游存档描述的是旧架构，不参与对账。
            if not doc.is_file() or doc.name.startswith("UPSTREAM-"):
                continue
            for line in doc.read_text(encoding="utf-8").splitlines():
                if "废弃" in line:
                    continue
                doc_env.update(re.findall(r"\b(OPS_[A-Z0-9_]+)\b", line))
        stale_env = sorted(doc_env - code_env)
        results.append(
            _ok(
                "文档环境变量与代码一致",
                not stale_env,
                "只存在于文档: " + "、".join(stale_env[:6]) if stale_env else "",
            )
        )
    except Exception as exc:  # noqa: BLE001
        results.append(_ok("文档环境变量与代码一致", False, str(exc)))


if __name__ == "__main__":
    sys.exit(run())
