"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");

const { loadConfig } = require("./core/config");
const {
  safeFileName,
  parseName,
  createBrowserOriginChecker,
} = require("./core/http-utils");
const { ConversationSseHub } = require("./chat/sse-hub");
const {
  MediaArtifacts,
  servePublicArtifactPreview,
} = require("./chat/media-artifacts");
const { createFilesService } = require("./routes/files-routes");

// 1. core/config.js
{
  const defaults = loadConfig({});
  assert.equal(defaults.port, 3003);
  assert.equal(defaults.host, "127.0.0.1");
  assert.equal(defaults.dataDir, "/data/drop-vault/files");

  const custom = loadConfig({
    DROP_VAULT_PORT: "3099",
    DROP_VAULT_DATA_DIR: "/tmp/custom-files",
    WITT_ALLOWED_ORIGINS: "https://a.example.com, https://b.example.com ",
    WITT_MIGRATION_TARGET_URL: "https://target.example.com",
  });
  assert.equal(custom.port, 3099);
  assert.equal(custom.dataDir, "/tmp/custom-files");
  assert.equal(custom.remoteAssistDir, "/tmp/remote-assist");
  assert.ok(custom.allowedBrowserOrigins.has("https://a.example.com"));
  assert.ok(custom.allowedBrowserOrigins.has("https://b.example.com"));
  assert.equal(custom.serverMigrationTargetUrl, "https://target.example.com");
}

// 2. core/http-utils.js
{
  assert.equal(safeFileName("../evil:name?.txt"), "evil_name_.txt");
  assert.equal(parseName(encodeURIComponent("测试 报告.pdf")), "测试 报告.pdf");
  const checker = createBrowserOriginChecker(["https://cdn.example.com"]);
  assert.equal(checker({ headers: { origin: "https://cdn.example.com", host: "origin.example.com" } }), true);
  assert.equal(checker({
    headers: { origin: "https://origin.example.com", host: "origin.example.com", "x-forwarded-proto": "https" },
  }), true);
  assert.equal(checker({
    headers: { origin: "https://attacker.example.com", host: "origin.example.com", "x-forwarded-proto": "https" },
  }), false);
}

// 3. chat/sse-hub.js
{
  const convId = "11111111-1111-4111-8111-111111111111";
  const conversation = { id: convId, archived: false, messages: [] };
  const fakeService = {
    readConversation: (id) => (id === convId ? conversation : null),
    publicConversation: (c) => ({ id: c.id }),
    publicConversationDelta: (c) => ({ id: c.id, delta: true }),
    sendJson: () => {},
  };
  const hub = new ConversationSseHub(fakeService);
  const req = new EventEmitter();
  const chunks = [];
  const res = new EventEmitter();
  res.destroyed = false;
  res.writableEnded = false;
  res.writableLength = 0;
  res.writeHead = () => {};
  res.write = (chunk) => { chunks.push(chunk); return true; };
  res.end = () => { res.writableEnded = true; };

  hub.subscribeConversation(req, res, convId, null);
  assert.equal(hub.subscribers.get(convId).size, 1);
  assert.ok(chunks.some((c) => c.includes("event: snapshot")));

  hub.broadcastConversationEvent(convId, "delta", { ok: true });
  assert.ok(chunks.some((c) => c.includes("event: delta") && c.includes('"ok":true')));

  req.emit("close");
  assert.equal(hub.subscribers.has(convId), false);
}

// 4. chat/media-artifacts.js
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "witt-media-test-"));
  try {
    const htmlFile = path.join(root, "demo.html");
    fs.writeFileSync(htmlFile, "<!doctype html><html><body><h1>Hi</h1></body></html>", "utf8");
    const msgId = "22222222-2222-4222-8222-222222222222";
    const artId = "33333333-3333-4333-8333-333333333333";
    const convId = "44444444-4444-4444-8444-444444444444";
    const artifact = { id: artId, name: "demo.html", size: fs.statSync(htmlFile).size, sourcePath: htmlFile };

    const service = {
      dataDir: root,
      imageDir: root,
      previewDir: root,
      deliveryRoots: [fs.realpathSync(root)],
      store: { findConversationIdByMessageId: (id) => (id === msgId ? convId : null) },
      readConversation: (id) => (id === convId ? {
        id: convId,
        messages: [{ id: msgId, artifacts: [artifact] }],
      } : null),
      sendJson: () => {},
    };
    const media = new MediaArtifacts(service);
    service.deliveryArtifact = (p) => media.deliveryArtifact(p);
    service.previewArtifactForToken = (res, entry) => media.previewArtifactForToken(res, entry);
    service.sendArtifactPreview = (res, art) => media.sendArtifactPreview(res, art);

    const parsed = media.parsePreviewMarkers("正文\n[[preview:/tmp/a.html]]\n尾行");
    assert.equal(parsed.text, "正文\n尾行");
    assert.deepEqual(parsed.paths, ["/tmp/a.html"]);

    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 1]);
    assert.deepEqual(media.imageType(pngHeader), { extension: ".png", mimeType: "image/png" });

    const token = media.issueArtifactPreviewToken(msgId, artifact);
    assert.ok(token.length >= 32);

    let headStatus = 0;
    let body = Buffer.alloc(0);
    const res = {
      writeHead: (s) => { headStatus = s; },
      end: (buf) => { body = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf || "")); },
    };
    assert.equal(servePublicArtifactPreview(res, token), true);
    assert.equal(headStatus, 200);
    assert.ok(body.toString("utf8").includes("witt-artifact-ready"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// 5. routes/files-routes.js
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "witt-files-test-"));
  try {
    let lastJson = null;
    const files = createFilesService({
      dataDir: root,
      sendJson: (_res, status, body) => { lastJson = { status, body }; },
      parseName,
    });
    const req = new PassThrough();
    req.headers = {
      "x-file-name": encodeURIComponent("hello world.txt"),
      "x-file-type": "text/plain",
      "content-length": "5",
    };
    await new Promise((resolve) => {
      const doneWrap = (_res, status, body) => {
        lastJson = { status, body };
        resolve();
      };
      const svc = createFilesService({ dataDir: root, sendJson: doneWrap, parseName });
      svc.upload(req, {}, root);
      req.end("hello");
    });
    assert.equal(lastJson.status, 201);
    assert.equal(lastJson.body.file.originalName, "hello world.txt");
    assert.equal(lastJson.body.file.size, 5);

    files.listFiles({}, new URL("http://127.0.0.1/files?limit=10"), root);
    assert.equal(lastJson.status, 200);
    assert.equal(lastJson.body.stats.count, 1);
    assert.equal(lastJson.body.stats.totalBytes, 5);
    console.log("PASS test-phase1-modules");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
