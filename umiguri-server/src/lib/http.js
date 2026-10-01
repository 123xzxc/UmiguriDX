// 极简 HTTP 工具: 路由表 / JSON 收发 / CORS / 错误包装。
// 不引框架, 避免给部署加依赖; 路由规模不大时足够清晰。

import { config } from "../config.js";

export class HttpError extends Error {
  constructor(status, message, code = undefined) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (m, c) => new HttpError(400, m, c);
export const unauthorized = (m = "未认证", c = "unauthorized") => new HttpError(401, m, c);
export const forbidden = (m = "无权限", c = "forbidden") => new HttpError(403, m, c);
export const notFound = (m = "资源不存在", c = "not_found") => new HttpError(404, m, c);
export const conflict = (m, c) => new HttpError(409, m, c);

// 读取并解析 JSON 请求体。限制大小, 防止超大 body 打爆内存。
export async function readJson(req, limitBytes = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw badRequest("请求体过大", "payload_too_large");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw badRequest("请求体必须是 JSON 对象", "bad_json");
    }
    return parsed;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw badRequest("JSON 解析失败", "bad_json");
  }
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store"
  });
  res.end(payload);
}

export function sendOk(res, body = {}) {
  sendJson(res, 200, { ok: true, ...body });
}

function applyCors(res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type, authorization");
  res.setHeader("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
}

// 创建路由。path 支持 ":name" 占位符, 如 /rooms/:code/join
export function createRouter() {
  const routes = [];

  function add(method, path, handler, opts = {}) {
    const keys = [];
    const pattern = path
      .split("/")
      .map((seg) => {
        if (seg.startsWith(":")) {
          keys.push(seg.slice(1));
          return "([^/]+)";
        }
        return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("/");
    routes.push({
      method,
      regex: new RegExp(`^${pattern}$`),
      keys,
      handler,
      auth: opts.auth === true
    });
  }

  return {
    get: (p, h, o) => add("GET", p, h, o),
    post: (p, h, o) => add("POST", p, h, o),
    patch: (p, h, o) => add("PATCH", p, h, o),
    delete: (p, h, o) => add("DELETE", p, h, o),

    // 返回一个 node http handler
    handler(authResolver) {
      return async (req, res) => {
        applyCors(res);
        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        const url = new URL(req.url, "http://localhost");
        const pathname = url.pathname.replace(/\/+$/, "") || "/";

        let matchedPath = false;
        for (const route of routes) {
          const m = route.regex.exec(pathname);
          if (!m) continue;
          matchedPath = true;
          if (route.method !== req.method) continue;

          const params = {};
          route.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });

          try {
            let auth = null;
            if (route.auth) {
              auth = authResolver(req);
              if (!auth) throw unauthorized();
            }
            const body = req.method === "GET" || req.method === "DELETE"
              ? Object.fromEntries(url.searchParams)
              : await readJson(req);
            const result = await route.handler({ params, body, query: url.searchParams, auth, req });
            if (result === undefined) sendOk(res);
            else sendOk(res, result);
          } catch (err) {
            if (err instanceof HttpError) {
              sendJson(res, err.status, { ok: false, error: err.message, code: err.code });
            } else {
              if (config.logLevel !== "silent") {
                console.error("[umg-server] 未处理异常:", err);
              }
              sendJson(res, 500, { ok: false, error: "服务器内部错误", code: "internal" });
            }
          }
          return;
        }

        sendJson(res, matchedPath ? 405 : 404, {
          ok: false,
          error: matchedPath ? "方法不允许" : "路径不存在",
          code: matchedPath ? "method_not_allowed" : "not_found"
        });
      };
    }
  };
}
