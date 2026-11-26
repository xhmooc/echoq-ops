# encoding: utf-8
"""命令行入口：``python -m ops <命令>``。"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def _out(data) -> None:
    print(json.dumps(data, ensure_ascii=False, indent=2, default=str))


def _service():
    from ops.service import OpsService

    return OpsService()


def _print_rows(title: str, rows: list[dict], columns: list[tuple[str, str]]) -> None:
    print(f"\n{title}（{len(rows)}）")
    if not rows:
        print("  （空）")
        return
    widths = {key: max(len(label), *(len(str(row.get(key, ""))) for row in rows)) for key, label in columns}
    header = "  ".join(label.ljust(widths[key]) for key, label in columns)
    print("  " + header)
    print("  " + "-" * len(header))
    for row in rows:
        print("  " + "  ".join(str(row.get(key, "")).ljust(widths[key]) for key, _ in columns))


def _parse_ids(value: str) -> list[int]:
    return [int(item) for item in value.replace("，", ",").split(",") if item.strip()]


# ---------------------------------------------------------------- 命令实现

def cmd_init(args) -> int:
    from ops import config, db

    db.init_db()
    _out({"ok": True, "db": str(config.DB_PATH), "data_dir": str(config.DATA_DIR)})
    return 0


def cmd_serve(args) -> int:
    import socket

    from ops import config
    from ops.web.app import main

    host = args.host or config.DEFAULT_HOST
    port = args.port or config.DEFAULT_PORT
    # 已经有一个实例（Electron 或另一个开发进程）在跑时不要起第二个后端，
    # 否则两个进程会同时写同一个 SQLite。
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.4)
        if sock.connect_ex((host, port)) == 0:
            print(f"已有实例在运行：http://{host}:{port}")
            return 0

    config.configure_logging()
    main(host, port)
    return 0


def cmd_account(args) -> int:
    service = _service()
    manager = service.accounts
    if args.action == "list":
        _print_rows(
            "账号",
            manager.list_accounts(),
            [
                ("id", "ID"),
                ("nickname", "昵称"),
                ("red_id", "小红书号"),
                ("status", "状态"),
                ("published_today", "今日"),
                ("daily_limit", "限额"),
                ("last_publish_at", "上次发布"),
            ],
        )
        return 0
    if args.action == "add-cookie":
        cookie = args.cookie or ""
        if args.cookie_file:
            cookie = Path(args.cookie_file).read_text(encoding="utf-8").strip()
        if not cookie:
            print("请从标准输入粘贴完整 Cookie，然后回车两次结束：")
            chunks = []
            for line in sys.stdin:
                chunks.append(line)
                if len(chunks) > 1 and not line.strip():
                    break
            cookie = "".join(chunks).strip()
        account = manager.add_cookie(args.name or "", cookie, args.proxy or "")
        _out({"ok": True, "account": account})
        return 0
    if args.action == "add-qr":
        from ops.accounts import _proxies
        from vendor.xhs_utils.xhs_pc import XHSPcAuth

        auth = XHSPcAuth.from_qrcode_login(
            show_in_terminal=True, proxies=_proxies(args.proxy or "")
        )
        account = manager.add_pc_auth(auth, args.name or "", args.proxy or "")
        _out({"ok": True, "account": account})
        return 0
    if args.action == "import-env":
        _out({"ok": True, "account": service.import_env_account()})
        return 0
    if args.action == "check":
        rows = manager.list_accounts()
        if args.id:
            rows = [row for row in rows if row["id"] == args.id]
        for row in rows:
            result = manager.check_health(row["id"])
            print(f"  账号 {row['id']} {row['nickname'] or row['name']}: {result['message']}")
        return 0
    if args.action == "update":
        fields = {}
        if args.name:
            fields["name"] = args.name
        if args.enable:
            fields["enabled"] = 1
        if args.disable:
            fields["enabled"] = 0
        if args.daily_limit is not None:
            fields["daily_limit"] = args.daily_limit
        if args.min_interval is not None:
            fields["min_interval_sec"] = args.min_interval
        if args.proxy is not None:
            fields["proxy"] = args.proxy
        _out(manager.update_account(args.id, fields))
        return 0
    if args.action == "rm":
        manager.delete_account(args.id)
        print("已删除")
        return 0
    raise SystemExit("未知 account 子命令")


def cmd_topic(args) -> int:
    service = _service()
    if args.action == "list":
        rows = service.topics.list_topics(args.status or "", args.q or "")
        _print_rows(
            "选题",
            rows,
            [("id", "ID"), ("score", "评分"), ("source", "来源"), ("title", "标题"), ("status", "状态")],
        )
        return 0
    if args.action == "mine":
        mode = args.mode
        keywords = [item.strip() for item in (args.keywords or "").split(",") if item.strip()]
        user_urls = [item.strip() for item in (args.user_urls or "").splitlines() if item.strip()]
        result = service.mine(
            mode,
            keywords=keywords,
            user_urls=user_urls,
            per_kw=args.per_kw,
            limit=args.limit,
            detail_limit=args.detail,
            product=args.product,
            account_id=args.account,
        )
        _out({key: result[key] for key in ("inserted", "skipped", "errors")})
        return 0
    if args.action == "import":
        path = args.path or str(Path("xhs-promo/topics/library.json"))
        _out(service.import_library(path))
        return 0
    if args.action == "add":
        _out(
            service.topics.add_manual(
                args.title,
                angle=args.angle or "",
                keyword=args.keyword or "",
                product=args.product,
            )
        )
        return 0
    if args.action == "update":
        fields = {}
        if args.status:
            fields["status"] = args.status
        if args.title:
            fields["title"] = args.title
        if args.angle:
            fields["angle"] = args.angle
        _out(service.topics.update_topic(args.id, fields))
        return 0
    if args.action == "rm":
        service.topics.delete_topic(args.id)
        print("已删除")
        return 0
    raise SystemExit("未知 topic 子命令")


def cmd_draft(args) -> int:
    service = _service()
    if args.action == "list":
        rows = service.list_drafts(args.status or "")
        _print_rows(
            "草稿",
            rows,
            [("id", "ID"), ("status", "状态"), ("title", "标题"), ("images", "配图")],
        )
        return 0
    if args.action == "create":
        drafts = service.create_drafts(
            _parse_ids(args.topic_ids),
            account_id=args.account,
            tone=args.tone or "",
            product=args.product if args.product is not None else None,
            variants=args.variants,
            use_llm=not args.no_llm,
            with_cards=args.cards,
        )
        _out(drafts)
        return 0
    if args.action == "cards":
        _out(service.generate_cards(args.id))
        return 0
    if args.action == "show":
        _out(service.get_draft(args.id))
        return 0
    if args.action == "update":
        fields = {}
        for key in ("title", "desc", "topics", "visibility", "status"):
            value = getattr(args, key)
            if value is not None:
                fields[key] = value
        _out(service.update_draft(args.id, fields))
        return 0
    raise SystemExit("未知 draft 子命令")


def cmd_publish(args) -> int:
    service = _service()
    if args.action == "enqueue":
        _out(service.enqueue(_parse_ids(args.draft_ids), account_id=args.account, scheduled_at=args.at or 0))
        return 0
    if args.action == "run":
        _out(service.queue.run_due(args.limit))
        return 0
    if args.action == "jobs":
        _print_rows(
            "发布队列",
            service.queue.list_jobs(args.limit),
            [
                ("id", "ID"),
                ("draft_id", "草稿"),
                ("account_name", "账号"),
                ("status", "状态"),
                ("attempts", "尝试"),
                ("last_error", "最近错误"),
            ],
        )
        return 0
    if args.action == "records":
        _print_rows(
            "发布记录",
            service.queue.list_records(args.limit),
            [
                ("created_at", "时间"),
                ("draft_title", "草稿"),
                ("account_name", "账号"),
                ("success", "成功"),
                ("remote_note_id", "远端 ID"),
            ],
        )
        return 0
    if args.action == "retry":
        _out(service.queue.retry(args.id))
        return 0
    if args.action == "cancel":
        _out(service.queue.cancel(args.id))
        return 0
    if args.action == "worker":
        from ops.worker import Worker

        worker = Worker(service.accounts, service.queue)
        print("发布 worker 已启动，Ctrl+C 退出")
        try:
            worker.run()
        except KeyboardInterrupt:
            worker.stop()
        return 0
    raise SystemExit("未知 publish 子命令")


def cmd_settings(args) -> int:
    service = _service()
    if args.action == "show":
        _out(service.settings_public())
        return 0
    if args.action == "set":
        fields = {}
        for pair in args.pairs:
            if "=" not in pair:
                raise SystemExit(f"参数格式应为 key=value: {pair}")
            key, value = pair.split("=", 1)
            fields[key.strip()] = value
        _out(service.update_settings(fields))
        return 0
    raise SystemExit("未知 settings 子命令")


def cmd_selfcheck(args) -> int:
    from ops.selfcheck import run

    return run()


# ---------------------------------------------------------------- 参数

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m ops", description="小红书运营台")
    sub = parser.add_subparsers(dest="command", required=True)

    p_serve = sub.add_parser("serve", help="启动运营台网页")
    p_serve.add_argument("--host", default=None)
    p_serve.add_argument("--port", type=int, default=None)
    p_serve.set_defaults(func=cmd_serve)

    p_init = sub.add_parser("init", help="初始化数据库与数据目录")
    p_init.set_defaults(func=cmd_init)

    p_self = sub.add_parser("selfcheck", help="离线自检（不联网）")
    p_self.set_defaults(func=cmd_selfcheck)

    # account
    p_acc = sub.add_parser("account", help="账号矩阵")
    acc = p_acc.add_subparsers(dest="action", required=True)
    acc.add_parser("list")
    p = acc.add_parser("add-cookie")
    p.add_argument("--name", default="")
    p.add_argument("--cookie", default="")
    p.add_argument("--cookie-file", default="")
    p.add_argument("--proxy", default="")
    p = acc.add_parser("add-qr")
    p.add_argument("--name", default="")
    p.add_argument("--proxy", default="")
    acc.add_parser("import-env")
    p = acc.add_parser("check")
    p.add_argument("--id", type=int)
    p = acc.add_parser("update")
    p.add_argument("--id", type=int, required=True)
    p.add_argument("--name")
    p.add_argument("--proxy")
    p.add_argument("--daily-limit", type=int)
    p.add_argument("--min-interval", type=int)
    p.add_argument("--enable", action="store_true")
    p.add_argument("--disable", action="store_true")
    p = acc.add_parser("rm")
    p.add_argument("--id", type=int, required=True)
    p_acc.set_defaults(func=cmd_account)

    # topic
    p_topic = sub.add_parser("topic", help="选题挖掘")
    topic = p_topic.add_subparsers(dest="action", required=True)
    p = topic.add_parser("list")
    p.add_argument("--status", default="pool")
    p.add_argument("--q", default="")
    p = topic.add_parser("mine")
    p.add_argument("--mode", choices=["keyword", "competitor", "trending"], default="keyword")
    p.add_argument("--keywords", default="")
    p.add_argument("--user-urls", default="")
    p.add_argument("--per-kw", type=int, default=20)
    p.add_argument("--limit", type=int, default=30)
    p.add_argument("--detail", type=int, default=5)
    p.add_argument("--product", action="store_true")
    p.add_argument("--account", type=int)
    p = topic.add_parser("import")
    p.add_argument("--path", default="")
    p = topic.add_parser("add")
    p.add_argument("--title", required=True)
    p.add_argument("--angle", default="")
    p.add_argument("--keyword", default="")
    p.add_argument("--product", action="store_true")
    p = topic.add_parser("update")
    p.add_argument("--id", type=int, required=True)
    p.add_argument("--status")
    p.add_argument("--title")
    p.add_argument("--angle")
    p = topic.add_parser("rm")
    p.add_argument("--id", type=int, required=True)
    p_topic.set_defaults(func=cmd_topic)

    # draft
    p_draft = sub.add_parser("draft", help="草稿与文案")
    draft = p_draft.add_subparsers(dest="action", required=True)
    p = draft.add_parser("list")
    p.add_argument("--status", default="")
    p = draft.add_parser("create")
    p.add_argument("--topic-ids", required=True)
    p.add_argument("--account", type=int)
    p.add_argument("--tone", default="")
    p.add_argument("--variants", type=int, default=1)
    p.add_argument("--product", dest="product", action="store_true")
    p.add_argument("--no-product", dest="product", action="store_false")
    p.set_defaults(product=None)
    p.add_argument("--no-llm", action="store_true")
    p.add_argument("--cards", action="store_true")
    p = draft.add_parser("cards")
    p.add_argument("--id", type=int, required=True)
    p = draft.add_parser("show")
    p.add_argument("--id", type=int, required=True)
    p = draft.add_parser("update")
    p.add_argument("--id", type=int, required=True)
    p.add_argument("--title")
    p.add_argument("--desc")
    p.add_argument("--topics")
    p.add_argument("--visibility", type=int)
    p.add_argument("--status")
    p_draft.set_defaults(func=cmd_draft)

    # publish
    p_pub = sub.add_parser("publish", help="发布队列")
    pub = p_pub.add_subparsers(dest="action", required=True)
    p = pub.add_parser("enqueue")
    p.add_argument("--draft-ids", required=True)
    p.add_argument("--account", type=int)
    p.add_argument("--at", default="")
    p = pub.add_parser("run")
    p.add_argument("--limit", type=int, default=3)
    p = pub.add_parser("worker")
    p = pub.add_parser("jobs")
    p.add_argument("--limit", type=int, default=50)
    p = pub.add_parser("records")
    p.add_argument("--limit", type=int, default=50)
    p = pub.add_parser("retry")
    p.add_argument("--id", type=int, required=True)
    p = pub.add_parser("cancel")
    p.add_argument("--id", type=int, required=True)
    p_pub.set_defaults(func=cmd_publish)

    # settings
    p_set = sub.add_parser("settings", help="参数设置")
    setting = p_set.add_subparsers(dest="action", required=True)
    setting.add_parser("show")
    p = setting.add_parser("set")
    p.add_argument("pairs", nargs="+", help="key=value，可多个")
    p_set.set_defaults(func=cmd_settings)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return int(args.func(args) or 0)


if __name__ == "__main__":
    sys.exit(main())
