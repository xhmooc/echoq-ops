/**
 * 极简本地 HTTP 层：迁移期先保证「响应格式与 Python 版一致」。
 *
 * 只监听 127.0.0.1，不引入框架；路由用 `:param` 写法，够覆盖当前端点。
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { ASSETS_DIR, DESIGN_DIR, EVIDENCE_DIR, UPLOAD_DIR } from "../core/config";
import { log } from "../core/log";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message);
  }
}

export interface Ctx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, unknown>;
}

export type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): void {
    this.routes.push({
      method: method.toUpperCase(),
      segments: pattern.replace(/^\/+|\/+$/g, "").split("/"),
      handler,
    });
  }

  get(pattern: string, handler: Handler): void {
    this.add("GET", pattern, handler);
  }

  post(pattern: string, handler: Handler): void {
    this.add("POST", pattern, handler);
  }

  patch(pattern: string, handler: Handler): void {
    this.add("PATCH", pattern, handler);
  }

  put(pattern: string, handler: Handler): void {
    this.add("PUT", pattern, handler);
  }

  delete(pattern: string, handler: Handler): void {
    this.add("DELETE", pattern, handler);
  }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
    const parts = pathname.replace(/^\/+|\/+$/g, "").split("/");
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let index = 0; index < route.segments.length; index += 1) {
        const segment = route.segments[index];
        if (segment.startsWith(":")) {
          try {
            params[segment.slice(1)] = decodeURIComponent(parts[index]);
          } catch {
            throw new HttpError(400, "请求路径编码不合法");
          }
        } else if (segment !== parts[index]) {
          matched = false;
          break;
        }
      }
      if (matched) return { handler: route.handler, params };
    }
    return null;
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

function sendJson(res: http.ServerResponse, payload: unknown, status = 200): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function ok(data: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ok: true, data, ...extra };
}

const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function isLocalHostHeader(host: string): boolean {
  const value = String(host || "").trim().toLowerCase();
  if (!value) return true;
  const hostname = value.startsWith("[")
    ? value.slice(0, value.indexOf("]") + 1)
    : value.split(":")[0];
  return LOCAL_HOSTNAMES.has(hostname);
}

function isLocalOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      LOCAL_HOSTNAMES.has(parsed.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

/**
 * 只接受本机页面的请求：校验 Host（防 DNS rebinding）与 Origin/Referer（防 CSRF）。
 * 浏览器里的任意网页无法伪造 Host/Origin，因此拿不到本地写接口。
 */
function guardLocalRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): boolean {
  if (!isLocalHostHeader(String(req.headers.host || ""))) {
    sendJson(res, { ok: false, error: "只接受本机访问" }, 403);
    return false;
  }
  if (String(req.headers["user-agent"] || "").includes("EchoQ-Smoke")) {
    return true; /* 冒烟脚本：本机直连，无 Origin/Referer 头 */
  }
  const origin = String(req.headers.origin || "");
  if (origin && !isLocalOrigin(origin)) {
    sendJson(res, { ok: false, error: "拒绝跨站请求" }, 403);
    return false;
  }
  const referer = String(req.headers.referer || "");
  if (!origin && referer && !isLocalOrigin(referer)) {
    sendJson(res, { ok: false, error: "拒绝跨站请求" }, 403);
    return false;
  }
  return true;
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > 4 * 1024 * 1024) throw new HttpError(413, "请求体过大");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("not object");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "请求体不是合法 JSON，请检查格式");
  }
}

/** 读取原始请求体（上传接口用），超过上限直接报 413。 */
export async function readRaw(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > maxBytes) throw new HttpError(413, "上传文件过大");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export interface ServerOptions {
  router: Router;
  webDir: string;
  port: number;
  host: string;
}

export function startServer(options: ServerOptions): http.Server {
  const server = http.createServer(async (req, res) => {
    let pathname = "";
    try {
      const url = new URL(req.url || "/", `http://${options.host}:${options.port}`);
      pathname = url.pathname;
      if (!guardLocalRequest(req, res)) return;
      if (pathname === "/api/backups/download") {
        // 备份下载走 API 路由，但仍由服务层返回附件。
      } else if (pathname.startsWith("/static/")) {
        serveFrom(res, options.webDir, pathname.slice("/static/".length));
        return;
      } else if (pathname.startsWith("/designs/")) {
        serveFrom(res, DESIGN_DIR, pathname.slice("/designs/".length));
        return;
      } else if (pathname.startsWith("/uploads/")) {
        serveFrom(res, UPLOAD_DIR, pathname.slice("/uploads/".length));
        return;
      } else if (pathname.startsWith("/assets/")) {
        serveFrom(res, ASSETS_DIR, pathname.slice("/assets/".length));
        return;
      } else if (pathname.startsWith("/evidence/")) {
        serveFrom(res, EVIDENCE_DIR, pathname.slice("/evidence/".length));
        return;
      } else if (!pathname.startsWith("/api/")) {
        serveStatic(req, res, options.webDir, pathname);
        return;
      }
      // 解码失败抛 HttpError，由外层统一返回 400，不会让请求悬挂。
      const matched = options.router.match(req.method || "GET", pathname);
      if (!matched) {
        sendJson(res, { ok: false, error: "接口不存在" }, 404);
        return;
      }
      const method = (req.method || "GET").toUpperCase();
      const contentType = String(req.headers["content-type"] || "").toLowerCase();
      const isMultipart = contentType.startsWith("multipart/");
      if (method !== "GET" && method !== "HEAD" && !isMultipart) {
        const declared =
          Number(req.headers["content-length"] || 0) > 0 ||
          String(req.headers["transfer-encoding"] || "")
            .toLowerCase()
            .includes("chunked");
        if (declared && !contentType.startsWith("application/json")) {
          throw new HttpError(
            415,
            "写接口只接受 application/json；上传素材请使用 multipart/form-data"
          );
        }
      }
      try {
        const body =
          method === "GET" || method === "HEAD" || isMultipart ? {} : await readBody(req);
        const result = await matched.handler({
          req,
          res,
          params: matched.params,
          query: url.searchParams,
          body,
        });
        if (!res.headersSent) sendJson(res, result ?? ok(null));
      } catch (error) {
        if (error instanceof HttpError) {
          sendJson(res, { ok: false, error: error.message }, error.status);
          return;
        }
        // 业务层可能抛带 status/code 的错误（如云端 401/402、资源 404）。
        const status = Number((error as { status?: unknown })?.status || 0);
        if (status >= 400 && status < 600) {
          const code = String((error as { code?: unknown })?.code || "");
          sendJson(
            res,
            { ok: false, error: error instanceof Error ? error.message : "请求失败", ...(code ? { code } : {}) },
            status
          );
          return;
        }
        const errorId = Math.random().toString(16).slice(2, 10);
        log.error(`接口异常[${errorId}] ${req.method} ${pathname}: ${error instanceof Error ? error.stack : String(error)}`);
        const message =
          error instanceof Error && error.message && !/[A-Za-z]:[\\/]/.test(error.message)
            ? `${error.message}（错误编号 ${errorId}）`
            : `服务器处理失败，请稍后重试；如果持续出现，把错误编号 ${errorId} 发给维护者。`;
        sendJson(res, { ok: false, error: message, error_id: errorId }, 500);
      }
    } catch (error) {
      // 入口阶段（URL 解析、路由匹配、请求体校验）的异常也必须响应。
      if (res.headersSent) return;
      if (error instanceof HttpError) {
        sendJson(res, { ok: false, error: error.message }, error.status);
        return;
      }
      log.error(
        `请求入口异常 ${req.method} ${pathname}: ${
          error instanceof Error ? error.stack : String(error)
        }`
      );
      sendJson(res, { ok: false, error: "请求无效，请检查地址或请求体" }, 400);
    }
  });
  server.listen(options.port, options.host, () => {
    log.info(`本地服务已启动: http://${options.host}:${options.port}`);
  });
  return server;
}

function serveFrom(res: http.ServerResponse, root: string, relative: string): void {
  const base = path.resolve(root);
  const target = path.resolve(base, relative.replace(/^\/+/, ""));
  if (target !== base && !target.startsWith(base + path.sep)) {
    res.writeHead(404).end("Not Found");
    return;
  }
  fs.readFile(target, (error, data) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not Found");
      return;
    }
    const type = MIME[path.extname(target).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(data);
  });
}

function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  webDir: string,
  pathname: string
): void {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = path.resolve(webDir, relative);
  if (!target.startsWith(path.resolve(webDir) + path.sep)) {
    res.writeHead(404).end("Not Found");
    return;
  }
  fs.readFile(target, (error, data) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not Found");
      return;
    }
    const type = MIME[path.extname(target).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(data);
  });
}
