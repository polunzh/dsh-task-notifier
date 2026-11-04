#!/usr/bin/env node
/**
 * dsh-task-notifier · 本地预览服务器
 *
 *   node preview/server.mjs            # http://127.0.0.1:57998/
 *   PORT=58010 node preview/server.mjs # 自定义端口
 *
 * 只做静态文件：预览页把 /task-notifier/api/* 全部用页内 mock fetch 拦下来了，
 * 所以这里没有任何 API、没有数据库、没有网络依赖，也不 import @deepseek-ai/*。
 * 只监听 127.0.0.1。
 *
 * 路由：
 *   /                                     preview/index.html
 *   /vendor/react.production.min.js       React 18 UMD（本地 vendored）
 *   /vendor/react-dom.production.min.js   ReactDOM 18 UMD（本地 vendored）
 *   /lib/client.js                        插件真实浏览器 bundle（只读）
 *   /icon.svg                             插件图标
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(here, "..");
const port = Number(process.env.PORT ?? 57998);
const host = "127.0.0.1";

const contentTypeByExt = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".txt": "text/plain; charset=utf-8",
};

const routes = new Map([
  ["/", join(here, "index.html")],
  ["/index.html", join(here, "index.html")],
  ["/vendor/react.production.min.js", join(here, "vendor", "react.production.min.js")],
  ["/vendor/react-dom.production.min.js", join(here, "vendor", "react-dom.production.min.js")],
  ["/lib/client.js", join(root, "lib", "client.js")],
  ["/icon.svg", join(root, "icon.svg")],
  // 浏览器会主动请求 favicon；给插件图标，避免无谓的 404 噪音。
  ["/favicon.ico", join(root, "icon.svg")],
]);

function resolveTarget(pathname) {
  if (routes.has(pathname)) return routes.get(pathname);
  // 只允许 preview/ 目录下的静态文件，防止路径穿越。
  const relative = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  const candidate = resolve(here, relative);
  if (candidate !== here && !candidate.startsWith(here + sep)) return null;
  return candidate;
}

const server = createServer((request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { "Content-Type": "text/plain; charset=utf-8", Allow: "GET, HEAD" });
    response.end("method not allowed");
    return;
  }

  let pathname;
  try {
    pathname = new URL(request.url, `http://${host}`).pathname;
  } catch {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("bad request");
    return;
  }

  const target = resolveTarget(pathname);
  if (!target || !existsSync(target) || !statSync(target).isFile()) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(`not found: ${pathname}`);
    return;
  }

  const headers = {
    "Content-Type": contentTypeByExt[extname(target).toLowerCase()] ?? "application/octet-stream",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (request.method === "HEAD") {
    response.writeHead(200, headers);
    response.end();
    return;
  }
  response.writeHead(200, headers);
  createReadStream(target).pipe(response);
});

server.listen(port, host, () => {
  const actual = server.address();
  const url = `http://${host}:${actual.port}/`;
  console.log(`[server] dsh-task-notifier 预览已启动：${url}`);
  console.log(`[server] 静态根目录：${here}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
