"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function createFilesService({
  dataDir,
  maxBytes = 500 * 1024 * 1024,
  sendJson,
  parseName,
}) {
  const recordCache = new Map();

  function metadataPath(id, directory = dataDir) {
    return path.join(directory, `${id}.json`);
  }

  function invalidateRecordCache(directory = dataDir) {
    recordCache.delete(directory);
  }

  function readRecords(directory = dataDir) {
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(directory).mtimeMs;
    } catch {
      recordCache.delete(directory);
      return [];
    }
    const cached = recordCache.get(directory);
    if (cached && cached.mtimeMs === mtimeMs) return cached.records;
    const records = fs.readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
    recordCache.set(directory, { mtimeMs, records });
    return records;
  }

  function listFiles(res, url, directory = dataDir) {
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 100));
    const records = readRecords(directory);
    const totalBytes = records.reduce((sum, record) => sum + Number(record.size || 0), 0);
    sendJson(res, 200, {
      files: records.slice(0, limit),
      stats: { count: records.length, totalBytes },
    });
  }

  function upload(req, res, directory = dataDir) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const length = Number(req.headers["content-length"] || 0);
    if (length > maxBytes) {
      sendJson(res, 413, { error: "文件超过 500 MB 限制" });
      req.resume();
      return;
    }

    const originalName = parseName(req.headers["x-file-name"]);
    const mimeType = String(req.headers["x-file-type"] || "application/octet-stream").slice(0, 160);
    const id = `${Date.now()}-${crypto.randomUUID()}`;
    const extension = path.extname(originalName).slice(0, 18);
    const storedName = `${id}${extension}`;
    const destination = path.join(directory, storedName);
    const temporary = `${destination}.part`;
    const output = fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 });
    const digest = crypto.createHash("sha256");
    let size = 0;
    let finished = false;

    const fail = (status, message) => {
      if (finished) return;
      finished = true;
      output.destroy();
      fs.rm(temporary, { force: true }, () => sendJson(res, status, { error: message }));
    };

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        fail(413, "文件超过 500 MB 限制");
        req.destroy();
        return;
      }
      digest.update(chunk);
    });
    req.on("aborted", () => fail(499, "上传已中断"));
    req.on("error", () => fail(400, "上传连接异常"));
    output.on("error", () => fail(500, "服务器无法保存文件"));

    output.on("finish", () => {
      if (finished) return;
      finished = true;
      try {
        fs.renameSync(temporary, destination);
        const record = {
          id,
          originalName,
          storedName,
          size,
          mimeType,
          sha256: digest.digest("hex"),
          uploadedAt: new Date().toISOString(),
        };
        fs.writeFileSync(metadataPath(id, directory), `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
        invalidateRecordCache(directory);
        sendJson(res, 201, { file: record });
      } catch {
        fs.rmSync(temporary, { force: true });
        fs.rmSync(destination, { force: true });
        sendJson(res, 500, { error: "服务器无法完成保存" });
      }
    });

    req.pipe(output);
  }

  return {
    metadataPath,
    invalidateRecordCache,
    readRecords,
    listFiles,
    upload,
  };
}

module.exports = { createFilesService };
