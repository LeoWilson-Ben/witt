"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ChatService } = require("../backend/chat-service");

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function serviceFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "witt-images-test-"));
  const chatDir = path.join(root, "chat");
  const imageDir = path.join(root, "images");
  const dataDir = path.join(root, "files");
  fs.mkdirSync(dataDir);
  const service = new ChatService({
    chatDir,
    imageDir,
    dataDir,
    codexBin: "/bin/false",
    codexWorkDir: root,
    sendJson(res, status, body) {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    },
    readJsonBody() {},
  });
  service.runNext = () => {};
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { service, root, imageDir };
}

test("stores generated and tool images without exposing server paths", (t) => {
  const { service, root } = serviceFixture(t);
  const message = { id: "message", images: [] };
  const generated = service.attachImage(
    message,
    service.storeImageData(tinyPng.toString("base64"), "生成图片"),
  );
  assert.equal(generated.mimeType, "image/png");
  assert.equal(generated.size, tinyPng.length);

  const generatedPath = path.join(root, "generated.png");
  fs.writeFileSync(generatedPath, tinyPng);
  const generatedFromEvent = service.captureGeneratedImage(message, {
    type: "image_generation_end",
    saved_path: generatedPath,
  });
  assert.equal(generatedFromEvent.mimeType, "image/png");

  const threadId = "00000000-0000-4000-8000-000000000123";
  const generatedDir = path.join("/home/ubuntu/.codex/generated_images", threadId);
  fs.mkdirSync(generatedDir, { recursive: true });
  const generatedFile = path.join(generatedDir, "fresh.png");
  fs.writeFileSync(generatedFile, tinyPng);
  t.after(() => fs.rmSync(generatedDir, { recursive: true, force: true }));
  const freshImages = service.captureNewGeneratedImages(message, threadId, new Set());
  assert.equal(freshImages.length, 1);

  const toolImages = service.captureToolImages(message, {
    type: "mcpToolCall",
    result: {
      content: [{
        type: "image",
        data: tinyPng.toString("base64"),
        mimeType: "image/png",
      }],
    },
  });
  assert.equal(toolImages.length, 1);

  const publicMessage = service.publicConversation({
    id: "00000000-0000-4000-8000-000000000001",
    title: "test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    archived: false,
    messages: [message],
  }).messages[0];
  assert.equal(publicMessage.images.length, 4);
  assert.equal(Object.hasOwn(publicMessage.images[0], "sourcePath"), false);
  assert.equal(Object.hasOwn(publicMessage.images[0], "fileName"), false);
});

test("serves only captured image ids with the verified image type", async (t) => {
  const { service, root } = serviceFixture(t);
  const image = service.storeImageBuffer(tinyPng, "预览图.png");
  const textPath = path.join(root, "not-image.png");
  fs.writeFileSync(textPath, "not an image");
  assert.equal(service.storeImagePath(textPath), null);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (!service.handlePublicImage(req, res, url)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/chat-images/${image.id}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), tinyPng);

  const missing = await fetch(
    `http://127.0.0.1:${port}/chat-images/00000000-0000-4000-8000-000000000000`);
  assert.equal(missing.status, 404);
});
