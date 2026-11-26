"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ID_PATTERN = /^[a-f0-9-]{36}$/;
const IMAGE_ID_PATTERN = /^[a-f0-9-]{36}$/;
const MAX_ARTIFACT_BYTES = 500 * 1024 * 1024;
const MAX_INLINE_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_INLINE_PREVIEW_BYTES = 5 * 1024 * 1024;
const ARTIFACT_PREVIEW_TTL_MS = 15 * 60 * 1000;
const TEXT_ARTIFACT_PATTERN = /\.(txt|md|markdown|csv|tsv|json|jsonl|js|mjs|cjs|ts|tsx|jsx|py|java|kt|dart|css|scss|html?|xml|svg|yaml|yml|log|sh|bash|sql|c|h|cpp|hpp|rs|go|rb|php|swift|toml|ini|conf|vue|svelte)$/i;

const artifactPreviewTokens = new Map();

function servePublicArtifactPreview(res, token) {
  const entry = artifactPreviewTokens.get(String(token || ""));
  if (!entry || entry.expiresAt <= Date.now()) {
    if (entry) artifactPreviewTokens.delete(String(token));
    return false;
  }
  return entry.service.previewArtifactForToken(res, entry);
}

function servePublicArtifactSource(res, token) {
  const entry = artifactPreviewTokens.get(String(token || ""));
  if (!entry || entry.expiresAt <= Date.now()) {
    if (entry) artifactPreviewTokens.delete(String(token));
    return false;
  }
  return entry.service.sourceArtifactForToken(res, entry);
}

class MediaArtifacts {
  constructor(service) {
    this.service = service;
  }

  issueArtifactPreviewToken(messageId, artifact) {
    if (!artifact?.id || !artifact?.sourcePath || !TEXT_ARTIFACT_PATTERN.test(artifact.name || "") ||
        Number(artifact.size || 0) > MAX_INLINE_PREVIEW_BYTES) return "";
    const now = Date.now();
    for (const [token, entry] of artifactPreviewTokens) {
      if (entry.expiresAt <= now) artifactPreviewTokens.delete(token);
      else if (entry.service === this.service && entry.messageId === messageId &&
          entry.artifactId === artifact.id) return token;
    }
    const token = crypto.randomBytes(24).toString("base64url");
    artifactPreviewTokens.set(token, {
      service: this.service,
      messageId,
      artifactId: artifact.id,
      expiresAt: now + ARTIFACT_PREVIEW_TTL_MS,
    });
    return token;
  }

  parsePreviewMarkers(value) {
    const paths = [];
    const visible = [];
    for (const line of String(value || "").split("\n")) {
      const match = line.trim().match(/^\[\[preview:(\/.+)\]\]$/);
      if (match) {
        paths.push(match[1].trim());
      } else if (!/^\s*\[\[preview:/.test(line)) {
        visible.push(line);
      }
    }
    return { text: visible.join("\n").trim(), paths };
  }

  publishPreviewSnapshot(assistant, requestedPath) {
    const active = [...this.service.activeTurns.values()].find((turn) => turn.messageId === assistant.id);
    const verified = this.service.deliveryArtifact(requestedPath);
    if (!verified || !TEXT_ARTIFACT_PATTERN.test(verified.name || "") ||
        verified.size > MAX_INLINE_PREVIEW_BYTES) return false;
    let source;
    try {
      source = fs.readFileSync(verified.sourcePath, "utf8");
    } catch {
      return false;
    }
    if (!/<html(?:\s|>)/i.test(source) || !/<\/html>\s*$/i.test(source) ||
        !/<body(?:\s|>)/i.test(source) || !/<\/body>/i.test(source)) return false;
    const artifactKey = crypto.createHash("sha256")
      .update(verified.sourcePath).digest("hex").slice(0, 24);
    const contentHash = crypto.createHash("sha256").update(source).digest("hex");
    let versions = Array.isArray(assistant.previewVersions)
      ? assistant.previewVersions.slice() : [];
    if (!versions.length && active?.conversationId) {
      const conversation = this.service.readConversation(active.conversationId);
      const previous = conversation?.messages?.slice().reverse().find((message) =>
        message.id !== assistant.id && message.livePreview?.artifactKey === artifactKey);
      if (previous) versions = (previous.previewVersions || []).slice(-20);
    }
    const latest = versions.at(-1);
    if (latest?.contentHash === contentHash || assistant.livePreview?.contentHash === contentHash) {
      return false;
    }
    const revision = Math.max(0, Number(latest?.revision || 0)) + 1;
    const id = crypto.randomUUID();
    const sourcePath = path.join(this.service.previewDir, `${id}.html`);
    const temporary = `${sourcePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, source, { mode: 0o600 });
      fs.renameSync(temporary, sourcePath);
    } catch {
      try { fs.rmSync(temporary, { force: true }); } catch {}
      return false;
    }
    const snapshot = {
      id,
      name: verified.name,
      size: Buffer.byteLength(source),
      mimeType: "text/html",
      sourcePath,
      sourceFile: verified.sourcePath,
      artifactKey,
      contentHash,
      revision,
      live: true,
      createdAt: new Date().toISOString(),
    };
    versions.push(snapshot);
    while (versions.length > 20) {
      versions.shift();
    }
    assistant.previewVersions = versions;
    assistant.livePreview = snapshot;
    if (active?.messageId === assistant.id) {
      active.previewSourcePath = verified.sourcePath;
    }
    return true;
  }

  imageType(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
    if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return { extension: ".png", mimeType: "image/png" };
    }
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return { extension: ".jpg", mimeType: "image/jpeg" };
    }
    const signature = buffer.subarray(0, 6).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") {
      return { extension: ".gif", mimeType: "image/gif" };
    }
    if (buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
        buffer.subarray(8, 12).toString("ascii") === "WEBP") {
      return { extension: ".webp", mimeType: "image/webp" };
    }
    return null;
  }

  safeImageSource(requestedPath) {
    try {
      const sourcePath = fs.realpathSync(String(requestedPath || ""));
      const lower = sourcePath.toLowerCase();
      const generatedImage = /^\/home\/ubuntu\/\.codex(?:-xuanyu)?\/generated_images\/[a-f0-9-]{36}\/[a-z0-9-]+\.(?:png|jpg|jpeg|webp|gif)$/i.test(sourcePath);
      if ((/(^|\/)(\.ssh|\.gnupg|\.aws|\.codex)(\/|$)/.test(lower) && !generatedImage) ||
          /(^|\/)(\.env($|\.)|[^/]*(token|credential|secret|private[_-]?key)[^/]*)$/.test(lower)) {
        return null;
      }
      const stats = fs.statSync(sourcePath);
      if (!stats.isFile() || stats.size < 12 || stats.size > MAX_INLINE_IMAGE_BYTES) return null;
      const handle = fs.openSync(sourcePath, "r");
      const header = Buffer.alloc(16);
      fs.readSync(handle, header, 0, header.length, 0);
      fs.closeSync(handle);
      const type = this.imageType(header);
      return type ? { sourcePath, stats, type } : null;
    } catch {
      return null;
    }
  }

  storeImageBuffer(buffer, name, source = "execution", artifactId = null) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 12 || buffer.length > MAX_INLINE_IMAGE_BYTES) {
      return null;
    }
    const type = this.imageType(buffer);
    if (!type) return null;
    const id = crypto.randomUUID();
    const fileName = `${id}${type.extension}`;
    const destination = path.join(this.service.imageDir, fileName);
    fs.writeFileSync(destination, buffer, { mode: 0o600, flag: "wx" });
    const image = {
      id,
      name: String(name || `Witt 图片${type.extension}`).slice(0, 180),
      size: buffer.length,
      mimeType: type.mimeType,
      source,
      artifactId,
      createdAt: new Date().toISOString(),
      fileName,
      sourcePath: destination,
    };
    fs.writeFileSync(
      path.join(this.service.imageDir, `${id}.json`),
      `${JSON.stringify({
        id: image.id,
        name: image.name,
        size: image.size,
        mimeType: image.mimeType,
        fileName: image.fileName,
      })}\n`,
      { mode: 0o600, flag: "wx" },
    );
    return image;
  }

  storeImagePath(requestedPath, source = "execution", artifactId = null) {
    const verified = this.safeImageSource(requestedPath);
    if (!verified) return null;
    const buffer = fs.readFileSync(verified.sourcePath);
    return this.storeImageBuffer(
      buffer, path.basename(verified.sourcePath), source, artifactId);
  }

  storeImageData(value, name = "Witt 生成图片", source = "execution") {
    const raw = String(value || "");
    const dataUrl = raw.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([a-zA-Z0-9+/=\s]+)$/);
    const encoded = dataUrl ? dataUrl[2] : raw;
    if (!encoded || encoded.length > Math.ceil(MAX_INLINE_IMAGE_BYTES * 4 / 3) + 16) return null;
    try {
      return this.storeImageBuffer(Buffer.from(encoded.replace(/\s+/g, ""), "base64"), name, source);
    } catch {
      return null;
    }
  }

  attachImage(message, image) {
    if (!image) return null;
    message.images = Array.isArray(message.images) ? message.images : [];
    const duplicate = message.images.find((candidate) =>
      (image.artifactId && candidate.artifactId === image.artifactId) ||
      (candidate.size === image.size && candidate.name === image.name &&
        candidate.source === image.source));
    if (duplicate) return duplicate;
    message.images.push(image);
    return image;
  }

  captureToolImages(message, item) {
    const contents = item.type === "dynamicToolCall"
      ? item.contentItems
      : item.result?.content;
    if (!Array.isArray(contents)) return [];
    const images = [];
    for (const [index, content] of contents.entries()) {
      if (!content || typeof content !== "object") continue;
      let image = null;
      if (content.type === "image" && content.data) {
        image = this.storeImageData(content.data, `工具图片 ${index + 1}`);
      } else if ((content.type === "inputImage" || content.type === "input_image") &&
          (content.imageUrl || content.image_url)) {
        image = this.storeImageData(
          content.imageUrl || content.image_url, `工具图片 ${index + 1}`);
      }
      if (image) images.push(this.attachImage(message, image));
    }
    return images.filter(Boolean);
  }

  captureGeneratedImage(message, item) {
    const savedPath = item.savedPath || item.saved_path;
    const stored = savedPath
      ? this.storeImagePath(savedPath, "execution")
      : this.storeImageData(item.result, "Witt 生成图片", "execution");
    return this.attachImage(message, stored);
  }

  generatedImageFiles(threadId, codexHome = "/var/lib/witt/.codex") {
    if (!ID_PATTERN.test(String(threadId || ""))) return new Set();
    const directory = path.join(codexHome, "generated_images", threadId);
    try {
      return new Set(fs.readdirSync(directory)
        .map((name) => path.join(directory, name))
        .filter((file) => fs.statSync(file).isFile() && this.safeImageSource(file)));
    } catch {
      return new Set();
    }
  }

  captureNewGeneratedImages(message, threadId, before = new Set(),
      codexHome = "/var/lib/witt/.codex") {
    const images = [];
    for (const sourcePath of this.generatedImageFiles(threadId, codexHome)) {
      if (before.has(sourcePath)) continue;
      const existingIds = new Set((message.images || []).map((image) => image.id));
      const image = this.attachImage(message,
        this.storeImagePath(sourcePath, "execution"));
      if (image && !existingIds.has(image.id)) images.push(image);
    }
    return images;
  }

  handlePublicImage(req, res, url) {
    const match = url.pathname.match(/^\/chat-images\/([a-f0-9-]{36})$/);
    if (!match) return false;
    if (req.method !== "GET") {
      this.service.sendJson(res, 405, { error: "不支持此请求方法" });
      return true;
    }
    try {
      const metadataPath = path.join(this.service.imageDir, `${match[1]}.json`);
      const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
      if (metadata.id !== match[1] || !IMAGE_ID_PATTERN.test(metadata.id) ||
          !/^[a-f0-9-]{36}\.(?:png|jpg|webp|gif)$/.test(metadata.fileName)) {
        throw new Error("invalid image metadata");
      }
      const imagePath = path.join(this.service.imageDir, metadata.fileName);
      const resolved = fs.realpathSync(imagePath);
      if (!resolved.startsWith(`${path.resolve(this.service.imageDir)}${path.sep}`)) {
        throw new Error("invalid image path");
      }
      const stats = fs.statSync(resolved);
      if (!stats.isFile() || stats.size !== metadata.size || stats.size > MAX_INLINE_IMAGE_BYTES) {
        throw new Error("invalid image file");
      }
      const verified = this.safeImageSource(resolved);
      if (!verified || verified.type.mimeType !== metadata.mimeType) {
        throw new Error("invalid image type");
      }
      res.writeHead(200, {
        "Cache-Control": "private, max-age=3600",
        "Content-Length": stats.size,
        "Content-Type": metadata.mimeType,
        "Content-Security-Policy": "default-src 'none'",
        "X-Content-Type-Options": "nosniff",
      });
      fs.createReadStream(resolved).pipe(res);
    } catch {
      this.service.sendJson(res, 404, { error: "图片不存在" });
    }
    return true;
  }

  extractDeliveries(response) {
    const lines = String(response || "").split("\n");
    const artifacts = [];
    const seenPaths = new Set();
    const visible = [];
    for (const line of lines) {
      const match = line.trim().match(/^\[\[deliver:(\/.+)\]\]$/);
      if (!match) {
        visible.push(line);
        continue;
      }
      const artifact = this.deliveryArtifact(match[1].trim());
      if (artifact && !seenPaths.has(artifact.sourcePath)) {
        seenPaths.add(artifact.sourcePath);
        // Preserve delivered bytes when a later task overwrites a file with the same name.
        const directory = path.join(this.service.dataDir, ".witt-file-versions", artifact.id);
        const snapshot = path.join(directory, artifact.name);
        try {
          fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
          fs.copyFileSync(artifact.sourcePath, snapshot, fs.constants.COPYFILE_FICLONE);
          fs.chmodSync(snapshot, 0o400);
          artifact.sourcePath = snapshot;
          artifact.versioned = true;
        } catch {
          artifact.versioned = false;
        }
        artifacts.push(artifact);
      }
    }
    return { text: visible.join("\n").trim(), artifacts };
  }

  deliveryArtifact(requestedPath) {
    try {
      const sourcePath = fs.realpathSync(requestedPath);
      if (!this.service.deliveryRoots.some((root) =>
        sourcePath === root || sourcePath.startsWith(`${root}${path.sep}`))) return null;
      const lower = sourcePath.toLowerCase();
      if (/(^|\/)(\.ssh|\.gnupg|\.aws|\.codex)(\/|$)/.test(lower) ||
          /(^|\/)(\.env($|\.)|[^/]*(token|credential|secret|private[_-]?key)[^/]*)$/.test(lower) ||
          /\.(pem|key|p12|pfx)$/i.test(lower)) return null;
      const stat = fs.statSync(sourcePath);
      if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) return null;
      return {
        id: crypto.randomUUID(),
        name: path.basename(sourcePath),
        size: stat.size,
        mimeType: this.mimeType(sourcePath),
        sourcePath,
      };
    } catch {
      return null;
    }
  }

  mimeType(filePath) {
    const extension = path.extname(filePath).toLowerCase();
    return ({
      ".apk": "application/vnd.android.package-archive",
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".xlsb": "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
      ".zip": "application/zip",
      ".pdf": "application/pdf",
      ".csv": "text/csv",
      ".txt": "text/plain",
      ".json": "application/json",
      ".html": "text/html",
      ".htm": "text/html",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif",
    })[extension] || (TEXT_ARTIFACT_PATTERN.test(filePath) ? "text/plain" : "application/octet-stream");
  }

  downloadArtifact(res, conversationId, messageId, artifactId) {
    const conversation = this.service.readConversation(conversationId);
    const message = conversation?.messages.find((item) => item.id === messageId);
    const artifact = message?.artifacts?.find((item) => item.id === artifactId);
    if (!artifact?.sourcePath) {
      this.service.sendJson(res, 404, { error: "交付文件不存在" });
      return;
    }
    const verified = this.deliveryArtifact(artifact.sourcePath);
    if (!verified) {
      this.service.sendJson(res, 410, { error: "交付文件已移动或不可下载" });
      return;
    }
    const encoded = encodeURIComponent(artifact.name).replace(/['()]/g, escape);
    res.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": artifact.mimeType || verified.mimeType,
      "Content-Length": verified.size,
      "Content-Disposition": `attachment; filename*=UTF-8''${encoded}`,
      "X-Content-Type-Options": "nosniff",
    });
    const stream = fs.createReadStream(verified.sourcePath);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  }

  previewArtifact(res, conversationId, messageId, artifactId) {
    if (this.previewArtifactByIds(res, conversationId, messageId, artifactId)) return;
    this.service.sendJson(res, 404, { error: "该交付文件不支持预览" });
  }

  previewArtifactByIds(res, conversationId, messageId, artifactId) {
    const conversation = this.service.readConversation(conversationId);
    const message = conversation?.messages.find((item) => item.id === messageId);
    const artifact = message?.artifacts?.find((item) => item.id === artifactId);
    if (!artifact) return false;
    this.sendArtifactPreview(res, artifact);
    return true;
  }

  previewArtifactForToken(res, entry) {
    const ownerId = this.service.store.findConversationIdByMessageId(entry.messageId);
    const owner = ownerId ? this.service.readConversation(ownerId) : null;
    for (const conversation of owner ? [owner] : []) {
      const message = conversation.messages.find((item) => item.id === entry.messageId);
      const candidates = [
        ...(message?.artifacts || []),
        ...(message?.previewVersions || []),
        ...(message?.livePreview ? [message.livePreview] : []),
      ];
      const artifact = candidates.find((item) => item.id === entry.artifactId);
      if (!artifact) continue;
      this.sendArtifactPreview(res, artifact);
      return true;
    }
    artifactPreviewTokens.delete([...artifactPreviewTokens.entries()]
      .find(([, candidate]) => candidate === entry)?.[0]);
    return false;
  }

  artifactForToken(entry) {
    const ownerId = this.service.store.findConversationIdByMessageId(entry.messageId);
    const owner = ownerId ? this.service.readConversation(ownerId) : null;
    for (const conversation of owner ? [owner] : []) {
      const message = conversation.messages.find((item) => item.id === entry.messageId);
      const candidates = [
        ...(message?.artifacts || []),
        ...(message?.previewVersions || []),
        ...(message?.livePreview ? [message.livePreview] : []),
      ];
      const artifact = candidates.find((item) => item.id === entry.artifactId);
      if (artifact) return artifact;
    }
    return null;
  }

  sourceArtifactForToken(res, entry) {
    const artifact = this.artifactForToken(entry);
    if (!artifact) return false;
    const verified = this.deliveryArtifact(artifact.sourcePath);
    if (!verified || !TEXT_ARTIFACT_PATTERN.test(artifact.name || "") ||
        verified.size > MAX_INLINE_PREVIEW_BYTES) return false;
    let source;
    try { source = fs.readFileSync(verified.sourcePath, "utf8"); } catch { return false; }
    res.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Length": Buffer.byteLength(source),
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'self'",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(source);
    return true;
  }

  sendArtifactPreview(res, artifact) {
    const extension = path.extname(String(artifact?.name || "")).toLowerCase();
    if (!artifact?.sourcePath || !TEXT_ARTIFACT_PATTERN.test(artifact.name || "")) {
      this.service.sendJson(res, 404, { error: "该交付文件不支持预览" });
      return;
    }
    const verified = this.deliveryArtifact(artifact.sourcePath);
    if (!verified) {
      this.service.sendJson(res, 410, { error: "交付文件已移动或不可预览" });
      return;
    }
    if (verified.size > MAX_INLINE_PREVIEW_BYTES) {
      this.service.sendJson(res, 413, { error: "交互预览文件不能超过 5 MB" });
      return;
    }
    let source;
    try {
      source = fs.readFileSync(verified.sourcePath, "utf8");
    } catch {
      this.service.sendJson(res, 410, { error: "交付文件已移动或不可预览" });
      return;
    }
    if (![".html", ".htm"].includes(extension)) {
      const escapeText = (value) => String(value).replace(/&/g, "&amp;")
        .replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      source = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeText(artifact.name)}</title><style>:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;padding:28px 24px;color:#302e2a;background:#faf9f6}pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;tab-size:2;font:14px/1.85 ui-monospace,SFMono-Regular,Consolas,monospace}@media(max-width:480px){body{padding:20px 16px}pre{font-size:13px}}@media(prefers-color-scheme:dark){body{color:#e5e2dc;background:#232220}}</style></head><body><pre>${escapeText(source)}</pre></body></html>`;
    }
    const bridge = `<script>(()=>{const post=(value)=>parent.postMessage(value,"*");const send=()=>{const d=document.documentElement,b=document.body;post({type:"witt-artifact-ready",height:Math.max(d.scrollHeight,d.offsetHeight,b?b.scrollHeight:0,b?b.offsetHeight:0)})};addEventListener("error",e=>post({type:"witt-artifact-error",message:e.message||"页面运行错误",line:e.lineno||0}));addEventListener("unhandledrejection",e=>post({type:"witt-artifact-error",message:String(e.reason?.message||e.reason||"页面运行错误")}));addEventListener("load",send);addEventListener("resize",send);if(typeof ResizeObserver!=="undefined")new ResizeObserver(send).observe(document.documentElement);setTimeout(send,0);setTimeout(send,250)})()<\/script>`;
    source = /<\/body\s*>/i.test(source)
      ? source.replace(/<\/body\s*>/i, `${bridge}</body>`)
      : `${source}${bridge}`;
    const payload = Buffer.from(source, "utf8");
    const encoded = encodeURIComponent(artifact.name).replace(/['()]/g, escape);
    res.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": payload.length,
      "Content-Disposition": `inline; filename*=UTF-8''${encoded}`,
      "Content-Security-Policy": "sandbox allow-scripts; default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data: blob:; connect-src 'none'; child-src 'none'; object-src 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(payload);
  }
}

module.exports = {
  MediaArtifacts,
  servePublicArtifactPreview,
  servePublicArtifactSource,
  TEXT_ARTIFACT_PATTERN,
  MAX_ARTIFACT_BYTES,
  MAX_INLINE_IMAGE_BYTES,
  MAX_INLINE_PREVIEW_BYTES,
  ARTIFACT_PREVIEW_TTL_MS,
};
