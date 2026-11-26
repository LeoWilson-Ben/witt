"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

function createLicreRouter({
  licreBuildDir,
  licreConsoleDir,
  xuanyuPreviewDir,
  sendJson,
  sendFile,
  previewContentType,
}) {
  function sendXuanyuPreview(res, pathname) {
    let requested;
    try {
      requested = decodeURIComponent(pathname.slice("/xuanyu-preview".length));
    } catch {
      sendJson(res, 400, { error: "预览路径无效" });
      return;
    }
    const relative = requested.replace(/^\/+/, "") || "index.html";
    const file = path.resolve(xuanyuPreviewDir, relative);
    const root = `${xuanyuPreviewDir}${path.sep}`;
    if (!file.startsWith(root)) {
      sendJson(res, 404, { error: "预览资源不存在" });
      return;
    }
    fs.stat(file, (error, stats) => {
      if (!error && stats.isFile()) {
        sendFile(res, file, previewContentType(file));
        return;
      }
      if (!path.extname(relative)) {
        sendFile(res, path.join(xuanyuPreviewDir, "index.html"), "text/html; charset=utf-8");
        return;
      }
      sendJson(res, 404, { error: "预览资源不存在" });
    });
  }

  function proxyLicreApi(req, res, pathname, search) {
    const upstreamPath = pathname.slice("/licre".length) + search;
    const headers = {};
    for (const name of ["content-type", "content-length", "x-licre-admin"]) {
      if (req.headers[name] !== undefined) headers[name] = req.headers[name];
    }
    const upstream = http.request({
      host: "127.0.0.1",
      port: 3001,
      method: req.method,
      path: upstreamPath,
      headers,
    }, (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode || 502, {
        "Cache-Control": "no-store",
        "Content-Type": upstreamResponse.headers["content-type"] || "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
      });
      upstreamResponse.pipe(res);
    });
    upstream.on("error", () => {
      if (!res.headersSent) sendJson(res, 502, { error: "LiCre 服务暂时不可用" });
      else res.destroy();
    });
    req.pipe(upstream);
  }

  function handleLicre(req, res, url) {
    if (!url.pathname.startsWith("/licre/")) return false;
    if (url.pathname.startsWith("/licre/api/") || url.pathname === "/licre/health") {
      proxyLicreApi(req, res, url.pathname, url.search);
      return true;
    }
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "不支持此请求方法" });
      return true;
    }
    if (url.pathname === "/licre/licre-update.json") {
      sendFile(res, path.join(licreConsoleDir, "licre-update.json"), "application/json; charset=utf-8", null, req);
      return true;
    }
    if (url.pathname === "/licre/LiCre.apk") {
      sendFile(res, path.join(licreBuildDir, "LiCre.apk"), "application/vnd.android.package-archive", "LiCre.apk", req);
      return true;
    }
    if (url.pathname === "/licre/Xuanyu-app-release.apk") {
      sendFile(res, path.join(licreBuildDir, "Xuanyu-app-release.apk"), "application/vnd.android.package-archive", "Xuanyu-app-release.apk", req);
      return true;
    }
    const release = url.pathname.match(/^\/licre\/releases\/([0-9a-f]{40})\/app-release\.apk$/);
    if (release) {
      sendFile(
        res,
        path.join(licreBuildDir, "releases", release[1], "app-release.apk"),
        "application/vnd.android.package-archive",
        "app-release.apk",
        req,
      );
      return true;
    }
    sendJson(res, 404, { error: "LiCre 资源不存在" });
    return true;
  }

  return {
    sendXuanyuPreview,
    proxyLicreApi,
    handleLicre,
  };
}

module.exports = { createLicreRouter };
