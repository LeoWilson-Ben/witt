"use strict";

const fs = require("node:fs");
const path = require("node:path");

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function readJsonBody(req, limit, callback) {
  const chunks = [];
  let size = 0;
  let finished = false;
  const fail = (message) => {
    if (finished) return;
    finished = true;
    callback(new Error(message));
  };
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > limit) {
      fail("请求内容过大");
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (finished) return;
    finished = true;
    try {
      callback(null, JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch {
      callback(new Error("请求格式不正确"));
    }
  });
  req.on("error", () => fail("请求连接异常"));
}

function safeFileName(name) {
  const raw = String(name || "file").replace(/\\/g, "/");
  const base = path.basename(raw).normalize("NFC");
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^\.+|[. ]+$/g, "");
  const fallback = cleaned || "file";
  const extension = path.extname(fallback);
  let stem = extension ? fallback.slice(0, -extension.length) : fallback;
  const budget = Math.max(1, 180 - Buffer.byteLength(extension, "utf8"));
  while (Buffer.byteLength(stem, "utf8") > budget) stem = Array.from(stem).slice(0, -1).join("");
  return (stem || "file") + extension;
}

function parseName(value) {
  try {
    return safeFileName(decodeURIComponent(String(value || "file")));
  } catch {
    return safeFileName(value);
  }
}

function previewContentType(file) {
  const types = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".wasm": "application/wasm",
    ".webp": "image/webp",
  };
  return types[path.extname(file).toLowerCase()] || "application/octet-stream";
}

function sendFile(res, file, contentType, downloadName = null, req = null) {
  fs.stat(file, (error, stats) => {
    if (error || !stats.isFile()) {
      sendJson(res, 404, { error: "文件不存在" });
      return;
    }
    const etag = `"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
    const lastModified = stats.mtime.toUTCString();
    const headers = {
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "Content-Type": contentType,
      ETag: etag,
      "Last-Modified": lastModified,
      "X-Content-Type-Options": "nosniff",
    };
    if (downloadName) {
      headers["Content-Disposition"] = `attachment; filename="${downloadName}"`;
    }
    let start = 0;
    let end = stats.size - 1;
    let partial = false;
    const requestedRange = req?.headers?.range;
    const ifRange = req?.headers?.["if-range"];
    let rangeAllowed = Boolean(requestedRange);
    if (rangeAllowed && ifRange) {
      const ifRangeDate = Date.parse(ifRange);
      rangeAllowed = ifRange === etag ||
        (Number.isFinite(ifRangeDate) && stats.mtimeMs <= ifRangeDate + 999);
    }
    if (rangeAllowed) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(requestedRange);
      if (!match || (!match[1] && !match[2])) {
        res.writeHead(416, { ...headers, "Content-Range": `bytes */${stats.size}` });
        res.end();
        return;
      }
      if (!match[1]) {
        const suffixLength = Number(match[2]);
        if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
          res.writeHead(416, { ...headers, "Content-Range": `bytes */${stats.size}` });
          res.end();
          return;
        }
        start = Math.max(0, stats.size - suffixLength);
      } else {
        start = Number(match[1]);
        if (match[2]) end = Number(match[2]);
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
          start < 0 || start >= stats.size || end < start) {
        res.writeHead(416, { ...headers, "Content-Range": `bytes */${stats.size}` });
        res.end();
        return;
      }
      end = Math.min(end, stats.size - 1);
      partial = true;
      headers["Content-Range"] = `bytes ${start}-${end}/${stats.size}`;
    }
    headers["Content-Length"] = partial ? end - start + 1 : stats.size;
    res.writeHead(partial ? 206 : 200, headers);
    const input = fs.createReadStream(file, partial ? { start, end } : undefined);
    input.on("error", () => res.destroy());
    input.pipe(res);
  });
}

function browserCookieRequest(req) {
  return !String(req.headers.authorization || "").startsWith("Bearer ") &&
    String(req.headers.cookie || "").split(";")
      .some((item) => item.trim().startsWith("witt_session="));
}

function createBrowserOriginChecker(allowedOrigins = new Set()) {
  const allowed = allowedOrigins instanceof Set ? allowedOrigins : new Set(allowedOrigins || []);
  return function browserOriginAllowed(req) {
    const origin = String(req.headers.origin || "").trim();
    if (origin && allowed.has(origin)) return true;
    const protocol = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
    return origin === `${protocol}://${req.headers.host}`;
  };
}

module.exports = {
  sendJson,
  readJsonBody,
  safeFileName,
  parseName,
  sendFile,
  previewContentType,
  browserCookieRequest,
  createBrowserOriginChecker,
};
