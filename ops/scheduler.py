# encoding: utf-8
"""定时调度引擎。

三类任务：定时发布、定时找选题、定时生成草稿。触发方式支持固定时间点
（可配星期几）与固定间隔。每次执行都写一条运行记录（开始/结束时间、结果、
错误、产出对象 id），重启后未执行的任务会被补跑或顺延。

线程安全：
- 进程内每个任务一把锁，手动「立即执行」与后台 tick 不会同时跑；
- 数据库用条件更新（running 0 → 1）领取，多线程/多进程只有一次能领取成功；
- 服务启动时把残留的 running 记录标记为中断，任务不会永久卡住。

全自动开关按任务独立控制：默认关闭（生成后待确认），开启后才无人值守发布。
全自动下命中合规红线、账号风控或连续失败会暂停任务并留下原因。
"""

from __future__ import annotations

import json
import threading
import time
from datetime import datetime, time as dtime, timedelta, timezone
from typing import Any

from loguru import logger

from ops import db
from ops.platforms import DEFAULT_PLATFORM, get_platform, normalize, platform_label

# 中国无夏令时，固定 UTC+8 比依赖 tzdata 更稳。
TZ = timezone(timedelta(hours=8))

KINDS = {
    "publish": "定时发布",
    "mine": "定时找选题",
    "draft": "定时生成草稿",
    "chain": "找选题→写草稿→发布",
}
TRIGGERS = {"time_point": "固定时间点", "interval": "固定间隔"}
WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]

# 引导式新建：三选一「做什么」，配一组大众语言的「什么时候」。
WHATS = {
    "publish": "发一篇已写好的",
    "chain": "找选题→写草稿→发布",
    "mine": "只帮我找选题",
}
WHEN_PRESETS: dict[str, dict[str, Any]] = {
    "morning": {"trigger_type": "time_point", "time_of_day": "09:00", "weekdays": []},
    "noon": {"trigger_type": "time_point", "time_of_day": "12:00", "weekdays": []},
    "evening": {"trigger_type": "time_point", "time_of_day": "20:00", "weekdays": []},
    "workdays": {"trigger_type": "time_point", "time_of_day": "20:00", "weekdays": [0, 1, 2, 3, 4]},
    "every6h": {"trigger_type": "interval", "interval_minutes": 360},
}

# 全自动发布命中这些字样时暂停任务，等人工确认账号与文案。
RISK_HINTS = ("合规", "风控", "频繁", "限流", "登录", "失效", "过期", "账号")
MAX_FAILURES = 3

# 融合链路的三环：找选题 → 写草稿（含配图）→ 发布。
STAGE_LABELS = {"mine": "找选题", "draft": "写草稿（含配图）", "publish": "发布"}
STAGE_ORDER = ("mine", "draft", "publish")


class StageError(RuntimeError):
    """链路执行到某一环失败，带上是哪一环以及已完成环节的产出。"""

    def __init__(
        self,
        stage: str,
        message: str,
        output: dict[str, Any] | None = None,
        pause: str = "",
    ) -> None:
        super().__init__(message)
        self.stage = stage
        self.output = output or {}
        self.pause = pause


def normalize_hhmm(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return "09:00"
    parts = text.replace("：", ":").split(":")
    if len(parts) != 2 or not all(part.strip().isdigit() for part in parts):
        raise ValueError(f"时间点格式应为 HH:MM：{value}")
    hour, minute = int(parts[0]), int(parts[1])
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        raise ValueError(f"时间点超出范围：{value}")
    return f"{hour:02d}:{minute:02d}"


def normalize_weekdays(value: Any) -> list[int]:
    if value in (None, ""):
        return []
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return []
        try:
            value = json.loads(text)
        except ValueError:
            value = [item for item in text.replace("，", ",").split(",") if item.strip()]
    if not isinstance(value, (list, tuple, set)):
        raise ValueError("星期几必须是数组")
    days: list[int] = []
    for item in value:
        try:
            day = int(item)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"星期几必须是 0-6 的整数：{item}") from exc
        if day < 0 or day > 6:
            raise ValueError(f"星期几必须是 0-6 的整数：{item}")
        if day not in days:
            days.append(day)
    return sorted(days)


def compute_next(schedule: dict[str, Any], base: int | None = None) -> int:
    """按触发配置算下一次执行时间（epoch 秒，Asia/Shanghai）。"""
    now = int(time.time())
    base = now if base is None else max(int(base), 0)
    trigger = str(schedule.get("trigger_type") or "time_point")
    if trigger == "interval":
        minutes = max(5, int(schedule.get("interval_minutes") or 360))
        next_at = base + minutes * 60
        while next_at <= now:
            next_at += minutes * 60
        return next_at

    hour, minute = (int(part) for part in normalize_hhmm(schedule.get("time_of_day")).split(":"))
    weekdays = normalize_weekdays(schedule.get("weekdays"))
    moment = datetime.fromtimestamp(now, TZ)
    for offset in range(0, 15):
        day = (moment + timedelta(days=offset)).date()
        if weekdays and day.weekday() not in weekdays:
            continue
        target = datetime.combine(day, dtime(hour, minute), TZ)
        if int(target.timestamp()) <= now + 5:
            continue
        return int(target.timestamp())
    return int(now + 3600)


def trigger_label(schedule: dict[str, Any]) -> str:
    trigger = str(schedule.get("trigger_type") or "time_point")
    if trigger == "interval":
        minutes = max(5, int(schedule.get("interval_minutes") or 360))
        if minutes % 60 == 0:
            return f"每 {minutes // 60} 小时"
        return f"每 {minutes} 分钟"
    time_of_day = str(schedule.get("time_of_day") or "09:00")
    weekdays = normalize_weekdays(schedule.get("weekdays"))
    if not weekdays or len(weekdays) == 7:
        return f"每天 {time_of_day}"
    if weekdays == [0, 1, 2, 3, 4]:
        return f"工作日 {time_of_day}"
    names = "、".join(WEEKDAYS[day] for day in weekdays)
    return f"{names} {time_of_day}"


def _short(text: Any, limit: int = 300) -> str:
    value = str(text or "").strip()
    return value if len(value) <= limit else value[:limit] + "…"


def _focus_keywords() -> list[str]:
    raw = db.get_setting("focus_keywords", "")
    items = [item.strip() for item in str(raw).replace("，", ",").split(",") if item.strip()]
    return items[:5] or ["生活方式"]


def _schedule_platform(schedule: Any) -> str:
    """从调度行里取平台；旧行/测试替身没有这个字段时回落到小红书。"""
    try:
        value = schedule["platform"]
    except (KeyError, IndexError, TypeError):
        value = ""
    return normalize(value or DEFAULT_PLATFORM)


def _design_style_keys() -> set[str]:
    from ops.designs import DESIGN_STYLES

    return {item["key"] for item in DESIGN_STYLES}


def _default_design_style() -> str:
    style = db.get_setting("card_style", "memo")
    return style if style in _design_style_keys() else "memo"


class ScheduleEngine:
    def __init__(self, service: Any = None) -> None:
        self.service = service
        self._locks: dict[int, threading.Lock] = {}
        self._guard = threading.Lock()
        self.last_tick_at = 0
        self.last_result: dict[str, Any] = {}

    # ------------------------------------------------------------ 读写

    def _lock(self, schedule_id: int) -> threading.Lock:
        with self._guard:
            lock = self._locks.get(schedule_id)
            if lock is None:
                lock = threading.Lock()
                self._locks[schedule_id] = lock
            return lock

    def _get(self, schedule_id: int):
        row = db.query_one("SELECT * FROM schedules WHERE id = ?", (schedule_id,))
        if row is None:
            raise KeyError(f"定时任务不存在: {schedule_id}")
        return row

    def serialize(self, row) -> dict[str, Any]:
        item = dict(row)
        return {
            "id": item["id"],
            "name": item["name"],
            "platform": item["platform"] or DEFAULT_PLATFORM,
            "platform_name": platform_label(item["platform"]),
            "kind": item["kind"],
            "kind_label": KINDS.get(item["kind"], item["kind"]),
            "enabled": bool(item["enabled"]),
            "auto": bool(item["auto"]),
            "trigger_type": item["trigger_type"],
            "trigger_label": trigger_label(item),
            "time_of_day": item["time_of_day"],
            "weekdays": normalize_weekdays(item["weekdays"]),
            "interval_minutes": item["interval_minutes"],
            "config": db.json_field(item["config"], {}),
            "next_run_at": item["next_run_at"],
            "last_run_at": item["last_run_at"],
            "last_status": item["last_status"],
            "last_message": item["last_message"],
            "running": bool(item["running"]),
            "failures": item["failures"],
            "paused_reason": item["paused_reason"],
            "created_at": item["created_at"],
            "updated_at": item["updated_at"],
        }

    def list(self, limit: int = 200, offset: int = 0) -> list[dict[str, Any]]:
        rows = db.query(
            "SELECT * FROM schedules ORDER BY id DESC LIMIT ? OFFSET ?",
            (max(1, int(limit)), max(0, int(offset))),
        )
        return [self.serialize(row) for row in rows]

    def count(self) -> int:
        return int(db.scalar("SELECT COUNT(*) FROM schedules", (), 0))

    def _clean_fields(self, payload: dict[str, Any]) -> dict[str, Any]:
        fields: dict[str, Any] = {}
        if "name" in payload:
            name = str(payload.get("name") or "").strip()
            if not name:
                raise ValueError("任务名称不能为空")
            fields["name"] = name[:60]
        if "kind" in payload:
            kind = str(payload.get("kind") or "").strip()
            if kind not in KINDS:
                raise ValueError("任务类型只支持 publish / mine / draft")
            fields["kind"] = kind
        if "platform" in payload:
            fields["platform"] = normalize(payload.get("platform"))
        if "trigger_type" in payload:
            trigger = str(payload.get("trigger_type") or "").strip()
            if trigger not in TRIGGERS:
                raise ValueError("触发方式只支持 time_point / interval")
            fields["trigger_type"] = trigger
        if "time_of_day" in payload:
            fields["time_of_day"] = normalize_hhmm(payload.get("time_of_day"))
        if "weekdays" in payload:
            fields["weekdays"] = json.dumps(normalize_weekdays(payload.get("weekdays")))
        if "interval_minutes" in payload:
            try:
                minutes = int(payload.get("interval_minutes") or 0)
            except (TypeError, ValueError) as exc:
                raise ValueError("间隔必须是整数分钟") from exc
            if minutes and minutes < 5:
                raise ValueError("间隔至少 5 分钟")
            fields["interval_minutes"] = max(5, minutes or 360)
        if "auto" in payload:
            fields["auto"] = 1 if payload.get("auto") else 0
        if "enabled" in payload:
            fields["enabled"] = 1 if payload.get("enabled") else 0
        if "config" in payload:
            config = payload.get("config") or {}
            if not isinstance(config, dict):
                raise ValueError("config 必须是 JSON 对象")
            fields["config"] = json.dumps(config, ensure_ascii=False)
        return fields

    def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        fields = self._clean_fields(payload)
        if not fields.get("name"):
            raise ValueError("任务名称不能为空")
        if not fields.get("kind"):
            raise ValueError("请选择任务类型")
        trigger = fields.get("trigger_type", "time_point")
        if trigger == "interval" and not fields.get("interval_minutes"):
            fields["interval_minutes"] = 360
        enabled = fields.get("enabled", 1)
        now = db.now()
        fields.setdefault("time_of_day", "09:00")
        fields.setdefault("weekdays", "[]")
        fields.setdefault("interval_minutes", 360)
        fields.setdefault("auto", 0)
        fields.setdefault("config", "{}")
        fields.setdefault("platform", DEFAULT_PLATFORM)
        schedule_id = db.execute(
            "INSERT INTO schedules(name, platform, kind, enabled, auto, trigger_type, time_of_day, "
            "weekdays, interval_minutes, config, next_run_at, last_run_at, last_status, "
            "last_message, running, failures, paused_reason, created_at, updated_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,0,'','',0,0,'',?,?)",
            (
                fields["name"],
                fields["platform"],
                fields["kind"],
                enabled,
                fields["auto"],
                trigger,
                fields["time_of_day"],
                fields["weekdays"],
                fields["interval_minutes"],
                fields["config"],
                compute_next(fields, now) if enabled else 0,
                now,
                now,
            ),
        )
        logger.info(f"定时任务已创建 #{schedule_id} {fields['name']}")
        return self.serialize(self._get(schedule_id))

    def update(self, schedule_id: int, payload: dict[str, Any]) -> dict[str, Any]:
        row = self._get(schedule_id)
        fields = self._clean_fields(payload)
        if not fields:
            return self.serialize(row)
        merged = dict(row)
        merged.update(fields)
        now = db.now()
        reenable = fields.get("enabled") == 1 and not row["enabled"]
        trigger_changed = bool({"trigger_type", "time_of_day", "weekdays", "interval_minutes"} & set(fields))
        if reenable:
            fields["paused_reason"] = ""
            fields["failures"] = 0
            fields["next_run_at"] = compute_next(merged, now)
        elif trigger_changed and merged["enabled"]:
            fields["next_run_at"] = compute_next(merged, now)
        fields["updated_at"] = now
        assignments = ", ".join(f"{key} = ?" for key in fields)
        db.execute(
            f"UPDATE schedules SET {assignments} WHERE id = ?",
            (*fields.values(), schedule_id),
        )
        return self.serialize(self._get(schedule_id))

    def delete(self, schedule_id: int) -> None:
        self._get(schedule_id)
        with db.transaction() as conn:
            conn.execute("DELETE FROM schedule_runs WHERE schedule_id = ?", (schedule_id,))
            conn.execute("DELETE FROM schedules WHERE id = ?", (schedule_id,))
        logger.info(f"定时任务 {schedule_id} 已删除（含运行记录）")

    def quick_create(self, payload: dict[str, Any]) -> dict[str, Any]:
        """引导式新建：只问「做什么 + 什么时候」，其余全部用安全默认值。"""
        what = str(payload.get("what") or "chain").strip()
        if what not in WHATS:
            raise ValueError("请选择要做什么：" + " / ".join(WHATS.values()))
        when = payload.get("when") or "morning"
        if isinstance(when, str):
            if when not in WHEN_PRESETS:
                raise ValueError("请选择什么时候执行")
            trigger = dict(WHEN_PRESETS[when])
        elif isinstance(when, dict):
            trigger = dict(when)
            if str(trigger.get("trigger_type") or "time_point") not in TRIGGERS:
                raise ValueError("触发方式不正确")
        else:
            raise ValueError("什么时候的配置不正确")

        tone = str(payload.get("tone") or db.get_setting("draft_style", "story"))
        style = str(payload.get("card_style") or "")
        if style not in _design_style_keys():
            style = _default_design_style()
        platform = normalize(payload.get("platform"))
        adapter = get_platform(platform)
        if what in {"publish", "chain"} and not adapter.ready:
            raise ValueError(
                f"{adapter.name}的发布接入位已预留，暂时只能创建「找选题」任务；"
                "接好登录与发布后即可直接使用。"
            )
        account_id = (
            db.scalar(
                "SELECT id FROM accounts WHERE enabled=1 AND platform=? ORDER BY id LIMIT 1",
                (platform,),
                0,
            )
            or None
        )

        if what == "publish":
            config: dict[str, Any] = {
                "limit": 1,
                "visibility": 1,
                "account_ids": [account_id] if account_id else [],
            }
        elif what == "mine":
            config = {
                "mode": "keyword",
                "keywords": _focus_keywords(),
                "per_kw": 20,
                "limit": 30,
                "detail_limit": 5,
                "min_score": 0,
                "product": False,
                "account_id": account_id,
            }
        else:
            config = {
                "keywords": _focus_keywords(),
                "per_kw": 20,
                "limit": 30,
                "detail_limit": 5,
                "min_score": 0,
                "product": False,
                "account_id": account_id,
                "account_ids": [account_id] if account_id else [],
                "from_pool": 1,
                "tone": tone,
                "with_cards": True,
                "card_style": style,
                "use_llm": True,
                "publish": True,
                "visibility": 1,
            }

        short = {"publish": "发一篇", "chain": "找选题→写草稿→发布", "mine": "找选题"}[what]
        name = str(payload.get("name") or "").strip()
        if not name:
            merged = dict(trigger)
            merged.setdefault("weekdays", [])
            merged.setdefault("interval_minutes", 360)
            name = f"{trigger_label(merged)} · {short}"[:60]
        return self.create(
            {
                "name": name,
                "platform": platform,
                "kind": what,
                "trigger_type": trigger.get("trigger_type") or "time_point",
                "time_of_day": trigger.get("time_of_day") or "09:00",
                "weekdays": trigger.get("weekdays") or [],
                "interval_minutes": trigger.get("interval_minutes") or 360,
                "auto": False,
                "enabled": True,
                "config": config,
            }
        )

    # ------------------------------------------------------------ 运行记录

    def serialize_run(self, row) -> dict[str, Any]:
        return {
            "id": row["id"],
            "schedule_id": row["schedule_id"],
            "schedule_name": row["schedule_name"],
            "kind": row["kind"],
            "kind_label": KINDS.get(row["kind"], row["kind"]),
            "trigger": row["trigger"],
            "status": row["status"],
            "started_at": row["started_at"],
            "finished_at": row["finished_at"],
            "message": row["message"],
            "error": row["error"],
            "output": db.json_field(row["output"], {}),
            "created_at": row["created_at"],
        }

    def list_runs(
        self, schedule_id: int | None = None, limit: int = 50, offset: int = 0
    ) -> list[dict[str, Any]]:
        limit = max(1, limit)
        offset = max(0, int(offset))
        if schedule_id:
            rows = db.query(
                "SELECT * FROM schedule_runs WHERE schedule_id = ? "
                "ORDER BY id DESC LIMIT ? OFFSET ?",
                (int(schedule_id), limit, offset),
            )
        else:
            rows = db.query(
                "SELECT * FROM schedule_runs ORDER BY id DESC LIMIT ? OFFSET ?",
                (limit, offset),
            )
        return [self.serialize_run(row) for row in rows]

    def count_runs(self, schedule_id: int | None = None) -> int:
        if schedule_id:
            return int(
                db.scalar(
                    "SELECT COUNT(*) FROM schedule_runs WHERE schedule_id = ?",
                    (int(schedule_id),),
                    0,
                )
            )
        return int(db.scalar("SELECT COUNT(*) FROM schedule_runs", (), 0))

    # ------------------------------------------------------------ 恢复

    def recover(self) -> dict[str, Any]:
        """启动时清理残留状态：中断的执行标记失败，任务重新可领取。"""
        now = db.now()
        stale = db.query("SELECT id FROM schedule_runs WHERE status = 'running'")
        for row in stale:
            db.execute(
                "UPDATE schedule_runs SET status='interrupted', finished_at=?, "
                "message='服务重启，执行未完成，已标记中断', error='服务重启' WHERE id=?",
                (now, row["id"]),
            )
        db.execute("UPDATE schedules SET running = 0 WHERE running = 1")
        overdue = db.scalar(
            "SELECT COUNT(*) FROM schedules WHERE enabled = 1 AND next_run_at <= ?", (now,), 0
        )
        if stale or overdue:
            logger.info(f"定时调度恢复：中断 {len(stale)} 条，待补跑 {int(overdue)} 个任务")
        return {"interrupted": len(stale), "overdue": int(overdue)}

    # ------------------------------------------------------------ 执行

    def tick(self, limit: int = 2) -> dict[str, Any]:
        """后台轮询：领取到期任务逐个执行。"""
        self.last_tick_at = int(time.time())
        now = db.now()
        rows = db.query(
            "SELECT id FROM schedules WHERE enabled = 1 AND running = 0 "
            "AND next_run_at > 0 AND next_run_at <= ? ORDER BY next_run_at LIMIT ?",
            (now, max(1, limit)),
        )
        results = [self.run(int(row["id"]), trigger="schedule") for row in rows]
        self.last_result = {"ran": len(results), "results": results}
        return self.last_result

    def run(self, schedule_id: int, trigger: str = "manual") -> dict[str, Any]:
        if self.service is None:
            raise RuntimeError("调度器未绑定业务门面，无法执行任务")
        lock = self._lock(schedule_id)
        if not lock.acquire(blocking=False):
            return {"schedule_id": schedule_id, "status": "skipped", "message": "任务正在执行中"}
        row = None
        claimed = False
        try:
            row = self._get(schedule_id)
            now = db.now()
            with db.transaction() as conn:
                cursor = conn.execute(
                    "UPDATE schedules SET running = 1, updated_at = ? WHERE id = ? AND running = 0",
                    (now, schedule_id),
                )
                claimed = cursor.rowcount == 1
            if not claimed:
                return {
                    "schedule_id": schedule_id,
                    "status": "skipped",
                    "message": "任务正在执行中",
                }
            due = int(row["next_run_at"] or 0)
            late = trigger == "schedule" and due and now - due > 600
            run_id = db.execute(
                "INSERT INTO schedule_runs(schedule_id, schedule_name, kind, trigger, status, "
                "started_at, finished_at, message, error, output, created_at) "
                "VALUES(?,?,?,?, 'running', ?, 0, '', '', '{}', ?)",
                (schedule_id, row["name"], row["kind"], trigger, now, now),
            )
            status, message, output, error, pause = "success", "", {}, "", ""
            try:
                payload = self._execute(row)
                message = str(payload.get("message") or "执行完成")
                output = payload.get("output") or {}
                pause = str(payload.get("pause") or "")
                # 链路发布环没成功时由执行结果决定整条运行记录的状态：
                # 全失败 → failed，全部等待重试/待确认 → waiting，部分成功 → partial。
                status = str(payload.get("status") or "success")
                if status == "pending":
                    status = "waiting"
                if late:
                    message = f"补跑（原定 {datetime.fromtimestamp(due, TZ):%m-%d %H:%M}）：{message}"
            except StageError as exc:
                logger.exception(f"定时任务 {schedule_id} 在「{STAGE_LABELS.get(exc.stage, exc.stage)}」环节失败")
                status = "failed"
                error = f"{exc.__class__.__name__}: {exc}"
                message = _short(str(exc), 200)
                output = dict(exc.output)
                output["failed_stage"] = exc.stage
                pause = exc.pause
            except Exception as exc:  # noqa: BLE001
                logger.exception(f"定时任务 {schedule_id} 执行失败")
                status = "failed"
                error = f"{exc.__class__.__name__}: {exc}"
                message = _short(error, 200)
            self._finish(row, run_id, status, message, output, error, pause, trigger)
            return {
                "schedule_id": schedule_id,
                "run_id": run_id,
                "status": status,
                "message": message,
                "error": error,
                "output": output,
            }
        finally:
            # 只有真正领取成功的执行者才能清 running，避免把别的进程正在跑
            # 的任务标记成空闲。
            if row is not None and claimed:
                db.execute(
                    "UPDATE schedules SET running = 0, updated_at = ? WHERE id = ?",
                    (db.now(), schedule_id),
                )
            lock.release()

    def _finish(
        self,
        row,
        run_id: int,
        status: str,
        message: str,
        output: dict[str, Any],
        error: str,
        pause: str,
        trigger: str,
    ) -> None:
        now = db.now()
        db.execute(
            "UPDATE schedule_runs SET status=?, finished_at=?, message=?, error=?, output=? "
            "WHERE id=?",
            (
                status,
                now,
                _short(message, 500),
                _short(error, 1000),
                json.dumps(output, ensure_ascii=False, default=str)[:8000],
                run_id,
            ),
        )
        failures = 0 if status in {"success", "waiting", "partial"} else int(row["failures"]) + 1
        paused = pause
        if not paused and failures >= MAX_FAILURES:
            stage = str(output.get("failed_stage") or "")
            tail = f"（最后一环：{STAGE_LABELS[stage]}）" if stage in STAGE_LABELS else ""
            paused = f"连续失败 {failures} 次{tail}，已自动暂停"
        next_run = int(row["next_run_at"] or 0)
        if trigger == "schedule" or not next_run or next_run <= now:
            base = next_run if trigger == "schedule" else now
            next_run = compute_next(dict(row), base)
        if paused:
            db.execute(
                "UPDATE schedules SET running=0, last_run_at=?, last_status=?, last_message=?, "
                "failures=?, enabled=0, paused_reason=?, next_run_at=?, updated_at=? WHERE id=?",
                (
                    now,
                    status,
                    _short(message, 300),
                    failures,
                    _short(paused, 300),
                    next_run,
                    now,
                    row["id"],
                ),
            )
            logger.warning(f"定时任务 {row['id']} 已暂停：{paused}")
            return
        db.execute(
            "UPDATE schedules SET running=0, last_run_at=?, last_status=?, last_message=?, "
            "failures=?, next_run_at=?, updated_at=? WHERE id=?",
            (now, status, _short(message, 300), failures, next_run, now, row["id"]),
        )

    # ------------------------------------------------------------ 各类型执行

    def _execute(self, schedule) -> dict[str, Any]:
        kind = schedule["kind"]
        config = db.json_field(schedule["config"], {})
        if kind == "publish":
            return self._run_publish(schedule, config)
        if kind == "mine":
            return self._run_mine(schedule, config)
        if kind == "draft":
            return self._run_draft(schedule, config)
        if kind == "chain":
            return self._run_chain(schedule, config)
        raise RuntimeError(f"未知任务类型: {kind}")

    def _decorate_cards(
        self, drafts: list[dict[str, Any]], style: str, *, strict: bool = False
    ) -> list[dict[str, Any]]:
        from ops.designs import render_design_cards

        keys = _design_style_keys()
        updated = []
        failures: list[dict[str, Any]] = []
        for draft in drafts:
            try:
                if style in keys or not style:
                    paths = render_design_cards(draft, style or _default_design_style())
                    updated.append(self.service.update_draft(draft["id"], {"images": paths}))
                else:
                    updated.append(self.service.generate_cards(draft["id"], style))
            except Exception as exc:  # noqa: BLE001
                logger.warning(f"草稿 {draft['id']} 自动配图失败: {exc}")
                failures.append({"draft_id": draft["id"], "error": _short(str(exc), 160)})
                updated.append(draft)
        # 链路里配图是草稿环的一部分：失败要算在草稿环，不能等到发布环
        # 以「缺配图」报错，否则用户只会重跑发布、永远修不好。
        if strict and failures:
            raise StageError(
                "draft",
                f"{len(failures)} 篇草稿配图失败：{failures[0]['error']}",
                {
                    "draft_ids": [item["id"] for item in updated],
                    "failures": failures,
                },
            )
        return updated

    def _run_publish(self, schedule, config: dict[str, Any]) -> dict[str, Any]:
        draft_ids = [int(item) for item in config.get("draft_ids") or [] if item]
        platform = _schedule_platform(schedule)
        if not draft_ids:
            limit = max(1, min(20, int(config.get("limit") or 3)))
            rows = db.query(
                "SELECT id FROM drafts WHERE status = 'draft' AND platform = ? "
                "ORDER BY id DESC LIMIT ?",
                (platform, limit),
            )
            draft_ids = [int(row["id"]) for row in rows]
        return self._publish_drafts(schedule, config, draft_ids)

    def _publish_drafts(
        self, schedule, config: dict[str, Any], draft_ids: list[int]
    ) -> dict[str, Any]:
        service = self.service
        if not draft_ids:
            raise RuntimeError("没有可发布的草稿，请先在内容库准备")
        platform = _schedule_platform(schedule)

        ready: list[dict[str, Any]] = []
        blocked: list[str] = []
        for draft_id in draft_ids:
            try:
                draft = service.get_draft(draft_id)
            except KeyError:
                blocked.append(f"#{draft_id} 已删除")
                continue
            if (draft.get("platform") or DEFAULT_PLATFORM) != platform:
                blocked.append(f"#{draft_id} 属于{platform_label(draft.get('platform'))}")
            elif draft["status"] == "published":
                blocked.append(f"#{draft_id} 已发布")
            elif draft["compliance"]:
                blocked.append(f"#{draft_id} 有合规风险")
            elif (draft.get("media_type") or "image") in {"image", "video"} and not draft.get("images"):
                blocked.append(f"#{draft_id} 缺配图")
            else:
                ready.append(draft)
        if not ready:
            text = "所选草稿都不满足发布条件：" + "、".join(blocked[:3])
            if int(schedule["auto"]) and any("合规" in item for item in blocked):
                raise StageError("publish", text, {"blocked": blocked}, f"合规拦截：{_short(text, 120)}")
            raise RuntimeError(text)

        visibility = int(config.get("visibility", 1))
        for draft in ready:
            if int(draft.get("visibility") or 0) != visibility:
                service.update_draft(draft["id"], {"visibility": visibility})
        account_ids = [int(item) for item in config.get("account_ids") or [] if item]

        if not int(schedule["auto"]):
            return {
                "message": f"已准备 {len(ready)} 篇待确认（未发布，可见范围 "
                f"{'公开' if visibility == 0 else '仅自己可见'}）",
                "status": "pending",
                "output": {
                    "draft_ids": [draft["id"] for draft in ready],
                    "pending": True,
                    "publish_status": "pending",
                    "blocked": blocked,
                },
            }

        jobs: list[dict[str, Any]] = []
        errors: list[str] = list(blocked)
        for draft in ready:
            try:
                if account_ids:
                    jobs.extend(service.queue.enqueue_targets(draft["id"], account_ids))
                else:
                    jobs.append(service.queue.enqueue(draft["id"]))
            except Exception as exc:  # noqa: BLE001
                errors.append(f"#{draft['id']} {exc}")
        if not jobs:
            raise RuntimeError("全部草稿入队失败：" + "；".join(errors[:3]))

        published: list[dict[str, Any]] = []
        pause = ""
        for job in jobs:
            result = service.queue.run_job(int(job["id"]))
            published.append(result)
            text = f"{result.get('message') or ''}"
            if result.get("status") == "failed" and any(hint in text for hint in RISK_HINTS):
                pause = f"发布命中风控/合规：{_short(text, 120)}"
                break
            if result.get("status") == "retry" and any(hint in text for hint in ("风控", "频繁", "限流")):
                pause = f"账号触发风控：{_short(text, 120)}"
                break
        success = sum(1 for item in published if item.get("status") == "success")
        failed = sum(1 for item in published if item.get("status") == "failed")
        waiting = len(published) - success - failed
        if success and not failed and not waiting:
            publish_status = "success"
        elif success:
            publish_status = "partial"
        elif failed and not waiting:
            publish_status = "failed"
        else:
            publish_status = "waiting"

        if publish_status == "success":
            message = f"入队 {len(jobs)} 篇，全部发布成功"
        elif publish_status == "failed":
            first = next(
                (str(item.get("message") or "") for item in published if item.get("status") == "failed"),
                "",
            )
            message = f"入队 {len(jobs)} 篇，全部失败" + (f"：{_short(first, 120)}" if first else "")
        elif publish_status == "waiting":
            message = f"入队 {len(jobs)} 篇，暂时都没有发出去，等待重试或分配账号"
        else:
            message = f"入队 {len(jobs)} 篇，成功 {success}，失败 {failed}，待重试 {waiting}"
        if pause:
            message += "；已暂停任务"
        return {
            "message": message,
            "status": publish_status,
            "output": {
                "draft_ids": [draft["id"] for draft in ready],
                "job_ids": [job["id"] for job in jobs],
                "results": published,
                "blocked": errors,
                "publish_status": publish_status,
                "success": success,
                "failed": failed,
                "waiting": waiting,
            },
            "pause": pause,
        }

    def _run_mine(self, schedule, config: dict[str, Any]) -> dict[str, Any]:
        mode = str(config.get("mode") or "keyword")
        if mode not in {"keyword", "competitor", "channel", "trending"}:
            raise ValueError("挖掘方式只支持 keyword / competitor / channel / trending")
        keywords = config.get("keywords") or []
        if isinstance(keywords, str):
            keywords = [item for item in keywords.replace("，", ",").split(",") if item.strip()]
        user_urls = config.get("user_urls") or []
        if isinstance(user_urls, str):
            user_urls = [item.strip() for item in user_urls.splitlines() if item.strip()]
        if mode == "keyword" and not keywords:
            raise ValueError("关键词挖掘需要至少一个关键词")
        if mode == "competitor" and not user_urls:
            raise ValueError("竞品挖掘需要至少一个主页链接")
        account_id = config.get("account_id")
        simulated = bool(config.get("simulate"))
        if simulated:
            # 演练模式：不调用小红书接口，用一组可控的模拟选题走完后续环节。
            keyword = (keywords[0] if isinstance(keywords, list) and keywords else "模拟选题")
            titles = config.get("sim_titles") or [
                f"{keyword}｜真实体验和省钱心得",
                f"{keyword}｜踩坑复盘与避雷清单",
            ]
            data = self.service.topics.ingest(
                [
                    {
                        "source": "simulated",
                        "source_ref": f"e2e-{int(time.time())}-{index}",
                        "keyword": keyword,
                        "category": "模拟",
                        "title": str(title),
                        "angle": "端到端演练",
                        "tone": "",
                        "product": False,
                        "liked": 1200 - index * 300,
                        "collected": 480 - index * 80,
                        "comments": 96 - index * 10,
                        "shares": 32,
                        "published_at": int(time.time()) - 86400,
                        "raw": {"simulated": True},
                    }
                    for index, title in enumerate(titles)
                ]
            )
            data["simulated"] = True
        else:
            data = self.service.mine(
                mode,
                keywords=[str(item).strip() for item in keywords],
                user_urls=[str(item).strip() for item in user_urls],
                per_kw=int(config.get("per_kw") or 20),
                limit=int(config.get("limit") or 30),
                detail_limit=int(config.get("detail_limit") or 5),
                product=bool(config.get("product")),
                account_id=int(account_id) if account_id else None,
            )
        min_score = float(config.get("min_score") or 0)
        dropped = 0
        kept: list[int] = []
        if min_score > 0:
            for item in data.get("items") or []:
                if float(item.get("score") or 0) < min_score:
                    self.service.topics.update_topic(item["id"], {"status": "dropped"})
                    dropped += 1
                else:
                    kept.append(item["id"])
        else:
            kept = [item["id"] for item in data.get("items") or []]
        parts = [f"新增 {data.get('inserted', 0)} 条", f"去重跳过 {data.get('skipped', 0)} 条"]
        if simulated:
            parts.insert(0, "模拟挖掘")
        if min_score > 0:
            parts.append(f"低于 {min_score:g} 分丢弃 {dropped} 条")
        return {
            "message": "，".join(parts),
            "output": {
                "inserted": data.get("inserted", 0),
                "skipped": data.get("skipped", 0),
                "dropped": dropped,
                "topic_ids": kept,
                "errors": (data.get("errors") or [])[:10],
                "simulated": simulated,
            },
        }

    def _run_draft(self, schedule, config: dict[str, Any]) -> dict[str, Any]:
        topic_ids = [int(item) for item in config.get("topic_ids") or [] if item]
        if not topic_ids:
            count = max(1, min(10, int(config.get("from_pool") or 5)))
            rows = db.query(
                "SELECT id FROM topics WHERE status = 'pool' ORDER BY score DESC, id DESC LIMIT ?",
                (count,),
            )
            topic_ids = [int(row["id"]) for row in rows]
        if not topic_ids:
            raise RuntimeError("选题池为空，先用「定时找选题」或手动添加")
        account_id = config.get("account_id")
        drafts = self.service.create_drafts(
            topic_ids,
            account_id=int(account_id) if account_id else None,
            tone=str(config.get("tone") or ""),
            variants=int(config.get("variants") or 1),
            use_llm=bool(config.get("use_llm", True)),
            with_cards=False,
            platform=_schedule_platform(schedule),
        )
        if config.get("with_cards"):
            # 定时生成草稿时配图是交付物的一部分：失败就标失败，不能只留 warning。
            drafts = self._decorate_cards(
                drafts, str(config.get("card_style") or ""), strict=True
            )
        return {
            "message": f"从 {len(topic_ids)} 个选题生成 {len(drafts)} 篇草稿",
            "output": {
                "topic_ids": topic_ids,
                "draft_ids": [draft["id"] for draft in drafts],
                "with_cards": bool(config.get("with_cards")),
            },
        }

    def _run_chain(self, schedule, config: dict[str, Any]) -> dict[str, Any]:
        """找选题 → 生成草稿（含配图）→ 到点发布，三环串成一条链路。"""
        stages: list[dict[str, Any]] = []
        topic_ids: list[int] = []
        drafts: list[dict[str, Any]] = []
        stage = "mine"
        try:
            mine_result = self._run_mine(schedule, config)
            mine_output = mine_result["output"]
            count = max(1, min(5, int(config.get("from_pool") or 1)))
            topic_ids = [int(item) for item in mine_output.get("topic_ids") or []][:count]
            if not topic_ids:
                rows = db.query(
                    "SELECT id FROM topics WHERE status = 'pool' ORDER BY score DESC, id DESC LIMIT ?",
                    (count,),
                )
                topic_ids = [int(row["id"]) for row in rows]
            if not topic_ids:
                raise RuntimeError("这次没有挖到选题，选题池也是空的")
            stages.append(
                {
                    "key": "mine",
                    "label": STAGE_LABELS["mine"],
                    "status": "success",
                    "summary": mine_result["message"],
                    "topic_ids": topic_ids,
                    "inserted": mine_output.get("inserted", 0),
                    "skipped": mine_output.get("skipped", 0),
                    "dropped": mine_output.get("dropped", 0),
                    "simulated": mine_output.get("simulated", False),
                }
            )

            stage = "draft"
            with_cards = bool(config.get("with_cards", True))
            drafts = self.service.create_drafts(
                topic_ids,
                account_id=int(config.get("account_id") or 0) or None,
                tone=str(config.get("tone") or ""),
                variants=1,
                use_llm=bool(config.get("use_llm", True)),
                with_cards=False,
                platform=_schedule_platform(schedule),
            )
            if with_cards:
                drafts = self._decorate_cards(
                    drafts, str(config.get("card_style") or ""), strict=True
                )
            image_count = sum(len(draft.get("images") or []) for draft in drafts)
            draft_ids = [draft["id"] for draft in drafts]
            stages.append(
                {
                    "key": "draft",
                    "label": STAGE_LABELS["draft"],
                    "status": "success",
                    "summary": (
                        f"从 {len(topic_ids)} 个选题生成 {len(drafts)} 篇草稿"
                        + (f"，配图 {image_count} 张" if image_count else "，未配图")
                    ),
                    "draft_ids": draft_ids,
                    "with_cards": with_cards,
                    "image_count": image_count,
                }
            )

            stage = "publish"
            if not bool(config.get("publish", True)):
                stages.append(
                    {
                        "key": "publish",
                        "label": STAGE_LABELS["publish"],
                        "status": "skipped",
                        "summary": "任务设置为只产草稿，没有发布",
                        "draft_ids": draft_ids,
                    }
                )
                return {
                    "message": f"{mine_result['message']}；生成 {len(drafts)} 篇草稿（未发布）",
                    "output": {
                        "stages": stages,
                        "topic_ids": topic_ids,
                        "draft_ids": draft_ids,
                        "pending": False,
                    },
                }

            publish_result = self._publish_drafts(schedule, config, draft_ids)
            publish_output = publish_result.get("output") or {}
            publish_status = str(
                publish_output.get("publish_status") or publish_result.get("status") or "success"
            )
            stages.append(
                {
                    "key": "publish",
                    "label": STAGE_LABELS["publish"],
                    "status": publish_status,
                    "summary": publish_result.get("message") or "发布完成",
                    "draft_ids": publish_output.get("draft_ids") or draft_ids,
                    "job_ids": publish_output.get("job_ids") or [],
                    "results": publish_output.get("results") or [],
                    "pending": bool(publish_output.get("pending")),
                    "blocked": publish_output.get("blocked") or [],
                }
            )
            return {
                "message": (
                    f"{mine_result['message']}；生成 {len(drafts)} 篇草稿；"
                    f"{publish_result.get('message') or '发布完成'}"
                ),
                "status": "waiting" if publish_status in {"pending", "waiting"} else publish_status,
                "output": {
                    "stages": stages,
                    "topic_ids": topic_ids,
                    "draft_ids": draft_ids,
                    "job_ids": publish_output.get("job_ids") or [],
                    "results": publish_output.get("results") or [],
                    "pending": bool(publish_output.get("pending")),
                    "publish_status": publish_status,
                    "blocked": publish_output.get("blocked") or [],
                },
                "pause": publish_result.get("pause") or "",
            }
        except Exception as exc:  # noqa: BLE001
            stages.append(
                {
                    "key": stage,
                    "label": STAGE_LABELS.get(stage, stage),
                    "status": "failed",
                    "error": _short(str(exc), 300),
                }
            )
            pause = exc.pause if isinstance(exc, StageError) else ""
            if stage == "publish" and any(hint in str(exc) for hint in RISK_HINTS):
                pause = f"发布环节被拦下：{_short(str(exc), 120)}"
            # 保留失败环节已经产出的中间产物（例如配图失败时已建好的草稿），
            # 这样「看草稿」和「只重跑这一环」仍然有据可依。
            error_output = dict(exc.output) if isinstance(exc, StageError) else {}
            error_output.update(
                {
                    "stages": stages,
                    "topic_ids": topic_ids,
                    "draft_ids": error_output.get("draft_ids")
                    or [draft["id"] for draft in drafts],
                }
            )
            raise StageError(stage, str(exc), error_output, pause) from exc

    def rerun_stage(self, run_id: int, stage: str = "") -> dict[str, Any]:
        """只重跑失败的那一环，其余环节的产物保持不变。"""
        row = db.query_one("SELECT * FROM schedule_runs WHERE id = ?", (run_id,))
        if row is None:
            raise KeyError(f"运行记录不存在: {run_id}")
        base_output = db.json_field(row["output"], {})
        target = (stage or str(base_output.get("failed_stage") or "")).strip()
        if target not in STAGE_LABELS:
            raise ValueError("只能重跑「找选题 / 写草稿 / 发布」其中一环")
        schedule = self._get(int(row["schedule_id"]))
        config = db.json_field(schedule["config"], {})
        lock = self._lock(int(row["schedule_id"]))
        if not lock.acquire(blocking=False):
            return {"schedule_id": row["schedule_id"], "status": "skipped", "message": "任务正在执行中"}
        claimed = False
        try:
            now = db.now()
            with db.transaction() as conn:
                cursor = conn.execute(
                    "UPDATE schedules SET running = 1, updated_at = ? WHERE id = ? AND running = 0",
                    (now, row["schedule_id"]),
                )
                if cursor.rowcount != 1:
                    return {
                        "schedule_id": row["schedule_id"],
                        "status": "skipped",
                        "message": "任务正在执行中",
                    }
            claimed = True
            new_run_id = db.execute(
                "INSERT INTO schedule_runs(schedule_id, schedule_name, kind, trigger, status, "
                "started_at, finished_at, message, error, output, created_at) "
                "VALUES(?,?,?,?, 'running', ?, 0, '', '', '{}', ?)",
                (
                    row["schedule_id"],
                    row["schedule_name"],
                    row["kind"],
                    f"retry:{target}",
                    now,
                    now,
                ),
            )
            stages = [dict(item) for item in base_output.get("stages") or []]
            output = dict(base_output)
            status, message, error, pause = "success", "", "", ""
            try:
                if target == "mine":
                    result = self._run_mine(schedule, config)
                    result_output = result.get("output") or {}
                    entry = {
                        "key": "mine",
                        "label": STAGE_LABELS["mine"],
                        "status": "success",
                        "summary": result["message"],
                        "topic_ids": result_output.get("topic_ids") or [],
                        "inserted": result_output.get("inserted", 0),
                        "skipped": result_output.get("skipped", 0),
                        "dropped": result_output.get("dropped", 0),
                    }
                    output["topic_ids"] = entry["topic_ids"]
                elif target == "draft":
                    topic_ids = [int(item) for item in base_output.get("topic_ids") or [] if item]
                    if not topic_ids:
                        raise RuntimeError("上一次执行没有留下选题，无法只重跑草稿环节")
                    with_cards = bool(config.get("with_cards", True))
                    drafts = self.service.create_drafts(
                        topic_ids,
                        account_id=int(config.get("account_id") or 0) or None,
                        tone=str(config.get("tone") or ""),
                        variants=1,
                        use_llm=bool(config.get("use_llm", True)),
                        with_cards=False,
                        platform=_schedule_platform(schedule),
                    )
                    if with_cards:
                        drafts = self._decorate_cards(drafts, str(config.get("card_style") or ""))
                    image_count = sum(len(draft.get("images") or []) for draft in drafts)
                    entry = {
                        "key": "draft",
                        "label": STAGE_LABELS["draft"],
                        "status": "success",
                        "summary": (
                            f"重跑生成 {len(drafts)} 篇草稿"
                            + (f"，配图 {image_count} 张" if image_count else "")
                        ),
                        "draft_ids": [draft["id"] for draft in drafts],
                        "with_cards": with_cards,
                        "image_count": image_count,
                    }
                    output["draft_ids"] = entry["draft_ids"]
                else:
                    draft_ids = [int(item) for item in base_output.get("draft_ids") or [] if item]
                    result = self._publish_drafts(schedule, config, draft_ids)
                    result_output = result.get("output") or {}
                    publish_status = str(
                        result_output.get("publish_status")
                        or result.get("status")
                        or "success"
                    )
                    entry = {
                        "key": "publish",
                        "label": STAGE_LABELS["publish"],
                        "status": publish_status,
                        "summary": result.get("message") or "发布完成",
                        "draft_ids": result_output.get("draft_ids") or draft_ids,
                        "job_ids": result_output.get("job_ids") or [],
                        "results": result_output.get("results") or [],
                        "pending": bool(result_output.get("pending")),
                        "blocked": result_output.get("blocked") or [],
                    }
                    output["job_ids"] = entry["job_ids"]
                    output["results"] = entry["results"]
                    output["pending"] = entry["pending"]
                    output["publish_status"] = publish_status
                    status = (
                        "waiting"
                        if publish_status in {"pending", "waiting"}
                        else publish_status
                    )
                    pause = result.get("pause") or ""
                # 重跑上游环节后，下游产物已经和新结果对不上：丢掉旧的下游
                # 节点与待确认状态，避免页面出现「新选题 + 旧草稿」的假链路。
                if target == "mine":
                    stages = [item for item in stages if item.get("key") == "mine"]
                    for key in (
                        "draft_ids",
                        "job_ids",
                        "results",
                        "pending",
                        "blocked",
                        "confirmed_at",
                    ):
                        output.pop(key, None)
                elif target == "draft":
                    stages = [
                        item
                        for item in stages
                        if item.get("key") in {"mine", "draft"}
                    ]
                    for key in (
                        "job_ids",
                        "results",
                        "pending",
                        "blocked",
                        "confirmed_at",
                    ):
                        output.pop(key, None)
                merged = {item.get("key"): item for item in stages}
                merged[target] = entry
                output["stages"] = [merged[key] for key in STAGE_ORDER if key in merged]
                output["failed_stage"] = "" if status in {"success", "waiting", "partial"} else target
                message = f"只重跑「{STAGE_LABELS[target]}」：{entry.get('summary') or '完成'}"
            except Exception as exc:  # noqa: BLE001
                logger.exception(f"定时任务 {row['schedule_id']} 重跑「{target}」失败")
                status = "failed"
                error = f"{exc.__class__.__name__}: {exc}"
                message = f"重跑「{STAGE_LABELS[target]}」失败：{_short(str(exc), 160)}"
                merged = {item.get("key"): item for item in stages}
                merged[target] = {
                    "key": target,
                    "label": STAGE_LABELS[target],
                    "status": "failed",
                    "error": _short(str(exc), 300),
                }
                output["stages"] = [merged[key] for key in STAGE_ORDER if key in merged]
                output["failed_stage"] = target
                if target == "publish" and any(hint in str(exc) for hint in RISK_HINTS):
                    pause = f"发布环节被拦下：{_short(str(exc), 120)}"
            self._finish(schedule, new_run_id, status, message, output, error, pause, "manual")
            return {
                "schedule_id": row["schedule_id"],
                "run_id": new_run_id,
                "stage": target,
                "status": status,
                "message": message,
                "error": error,
                "output": output,
            }
        finally:
            if claimed:
                db.execute(
                    "UPDATE schedules SET running = 0, updated_at = ? WHERE id = ?",
                    (db.now(), row["schedule_id"]),
                )
            lock.release()

    # ------------------------------------------------------------ 人工确认

    def confirm_run(self, run_id: int) -> dict[str, Any]:
        """全自动关闭时，人工确认一条运行记录里的待发布草稿。"""
        row = db.query_one("SELECT * FROM schedule_runs WHERE id = ?", (run_id,))
        if row is None:
            raise KeyError(f"运行记录不存在: {run_id}")
        output = db.json_field(row["output"], {})
        draft_ids = [int(item) for item in output.get("draft_ids") or [] if item]
        if not draft_ids:
            raise ValueError("这条运行记录没有待确认的草稿")
        if output.get("confirmed_at"):
            raise ValueError("这条记录已经确认过，请勿重复发布")
        schedule = db.query_one("SELECT * FROM schedules WHERE id = ?", (row["schedule_id"],))
        config = db.json_field(schedule["config"], {}) if schedule else {}
        account_ids = [int(item) for item in config.get("account_ids") or [] if item]
        jobs: list[dict[str, Any]] = []
        errors: list[str] = []
        for draft_id in draft_ids:
            try:
                if account_ids:
                    jobs.extend(self.service.queue.enqueue_targets(draft_id, account_ids))
                else:
                    jobs.append(self.service.queue.enqueue(draft_id))
            except Exception as exc:  # noqa: BLE001
                errors.append(f"#{draft_id} {exc}")
        results = [self.service.queue.run_job(int(job["id"])) for job in jobs]
        success = sum(1 for item in results if item.get("status") == "success")
        failed = sum(1 for item in results if item.get("status") == "failed")
        waiting = len(results) - success - failed
        if not jobs:
            run_status = "failed"
        elif success == len(results):
            run_status = "success"
        elif success:
            run_status = "partial"
        elif failed == len(results):
            run_status = "failed"
        else:
            run_status = "waiting"
        output["confirmed_at"] = db.now()
        output["job_ids"] = [job["id"] for job in jobs]
        output["results"] = results
        output["errors"] = (output.get("errors") or []) + errors
        output["publish_status"] = run_status
        db.execute(
            "UPDATE schedule_runs SET output=?, message=?, status=? WHERE id=?",
            (
                json.dumps(output, ensure_ascii=False, default=str)[:8000],
                _short(f"已确认发布：成功 {success}，失败 {failed}，待重试 {waiting}", 300),
                run_status,
                run_id,
            ),
        )
        return {
            "run_id": run_id,
            "status": run_status,
            "enqueued": len(jobs),
            "success": success,
            "failed": failed,
            "waiting": waiting,
            "errors": errors,
            "results": results,
        }


__all__ = [
    "ScheduleEngine",
    "StageError",
    "STAGE_LABELS",
    "STAGE_ORDER",
    "compute_next",
    "trigger_label",
    "normalize_hhmm",
    "normalize_weekdays",
    "KINDS",
    "TRIGGERS",
    "WEEKDAYS",
]

