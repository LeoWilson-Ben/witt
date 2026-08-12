"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { ChatService } = require("../backend/chat-service");

test("streams a snapshot and debounced conversation deltas over SSE", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "witt-sse-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = new ChatService({
    chatDir: path.join(root, "chat"),
    dataDir: path.join(root, "files"),
    imageDir: path.join(root, "images"),
    codexBin: "/bin/false",
    codexWorkDir: root,
    sendJson(res, status, body) {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    },
    readJsonBody() {},
  });
  const id = "00000000-0000-4000-8000-000000000091";
  const now = new Date().toISOString();
  const conversation = {
    id, title: "SSE test", createdAt: now, updatedAt: now, archived: false,
    model: "gpt-5.6-sol", reasoning: "medium", accessMode: "read-only",
    messages: [],
  };
  service.writeConversation(conversation);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (!service.handle(req, res, url)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/chat/conversations/${id}/events`,
    { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/event-stream/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = "";
  const readUntil = async (pattern) => {
    const deadline = Date.now() + 3_000;
    while (!pattern.test(received) && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
    }
    assert.match(received, pattern);
  };
  await readUntil(/event: snapshot/);
  conversation.messages.push({
    id: "00000000-0000-4000-8000-000000000092",
    role: "assistant", text: "streamed", status: "running", stream: [],
    createdAt: new Date().toISOString(),
  });
  conversation.updatedAt = new Date().toISOString();
  service.writeConversation(conversation);
  await readUntil(/event: delta[\s\S]*streamed/);
  controller.abort();
});
