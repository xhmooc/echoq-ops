# encoding: utf-8
"""运营台 Web 服务（aiohttp）入口。

这里只负责组装：中间件、业务门面、路由表与静态目录。接口实现按业务域
放在 ``ops/web/routers/``，共享助手在 ``ops/web/common.py``。
"""

from __future__ import annotations

from aiohttp import web
from loguru import logger

from ops import config, db
from ops.service import OpsService
from ops.web.common import VIDEO_MAX_BYTES, _errors, _no_cache
from ops.web.routers import ROUTERS


def create_app(service: OpsService | None = None) -> web.Application:
    app = web.Application(
        middlewares=[_errors, _no_cache],
        client_max_size=VIDEO_MAX_BYTES + 8 * 1024 * 1024,
    )
    app["service"] = service or OpsService()
    for routes in ROUTERS:
        app.add_routes(routes)
    app.router.add_static("/static/", config.STATIC_DIR, show_index=False)
    app.router.add_static("/designs/", config.DESIGN_DIR, show_index=False)
    app.router.add_static("/uploads/", config.UPLOAD_DIR, show_index=False)
    return app


def main(host: str | None = None, port: int | None = None) -> None:
    from ops.worker import start_background

    config.configure_logging()
    config.ensure_dirs()
    service = OpsService()
    app = create_app(service)
    if db.get_int_setting("worker_auto_start", 1) == 1:
        start_background(service.accounts, service.queue, service)

    host = host or config.DEFAULT_HOST
    port = port or config.DEFAULT_PORT
    logger.info(f"运营台已启动: http://{host}:{port}  (数据目录 {config.DATA_DIR})")
    web.run_app(app, host=host, port=port, print=None)


if __name__ == "__main__":
    main()
