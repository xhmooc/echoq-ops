# encoding: utf-8
"""按业务域拆分的路由表；``create_app`` 按固定顺序汇总注册。"""

from ops.web.routers import (
    site,
    published,
    accounts,
    topics,
    drafts,
    queue,
    schedules,
    cloud,
    admin,
)

ROUTERS = (
    site.routes,
    published.routes,
    accounts.routes,
    topics.routes,
    drafts.routes,
    queue.routes,
    schedules.routes,
    cloud.routes,
    admin.routes,
)

__all__ = ["ROUTERS"]
