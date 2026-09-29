"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { EventEmitter } = require("node:events");
const { ChatService } = require("./chat-service");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "witt-history-regression-"));
  const service = new ChatService({
    chatDir: path.join(directory, "chat"), dataDir: path.join(directory, "files"),
    imageDir: path.join(directory, "images"), codexBin: "/bin/false", codexWorkDir: directory,
    sendJson(res, status, payload) { res.status = status; res.payload = payload; },
    readJsonBody(req, _limit, callback) { callback(null, req.body || {}); }, allowedModels: null,
  });
  service.runNext = () => {};
  t.after(() => {
    for (const entry of service.jsonCheckpoints.values()) clearTimeout(entry.timer);
    for (const timer of service.eventBroadcasts.values()) clearTimeout(timer);
    service.store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const request = (method, suffix, body = {}, deviceId = "device-a") => {
    const res = {};
    service.handle({ method, body }, res, new URL(`http://localhost/chat/${suffix}`), { deviceId });
    return res;
  };
  return { service, request };
}

test("cold 1005-message history pages reconstruct exactly, remain read-only, and legacy GET remains full", (t) => {
  const { service, request } = fixture(t);
  const value = service.createConversation();
  value.messages = Array.from({ length: 1005 }, (_, index) => ({
    id: crypto.randomUUID(), role: index % 2 ? "assistant" : "user", status: "completed",
    text: `message ${index}`, stream: [{ id: `log-${index}`, kind: "command", details: "long log ".repeat(100) }],
  }));
  service.store.save(value, { immediate: true });
  service.store.cache.clear(); service.store.cacheSizes.clear(); service.store.cacheAccess.clear();
  const baseline = service.store.db.prepare("SELECT total_changes() AS n").get().n;
  let page = request("GET", `conversations/${value.id}?limit=40`).payload.conversation;
  const collected = [...page.messages];
  assert.equal(page.messageOffset, 965);
  assert.equal(page.messages[0].stream[0].details, undefined);
  assert.equal(page.messages[0].stream[0].hasDetails, true);
  while (page.hasMore) {
    page = request("GET", `conversations/${value.id}/messages?before=${page.messageOffset}&limit=40`).payload.conversation;
    collected.unshift(...page.messages);
  }
  assert.deepEqual(collected.map((item) => item.id), value.messages.map((item) => item.id));
  assert.equal(service.store.cache.size, 0, "pagination must not hydrate whole histories");
  assert.equal(service.store.db.prepare("SELECT total_changes() AS n").get().n, baseline);
  const full = request("GET", `conversations/${value.id}`).payload.conversation;
  assert.equal(full.messages.length, 1005);
  assert.equal(full.messageOffset, 0);
});

test("SSE initial pages and absolute delta offsets agree through additions and branch truncation", (t) => {
  const { service } = fixture(t);
  const value = service.createConversation();
  value.messages = Array.from({ length: 100 }, (_, index) => ({
    id: crypto.randomUUID(), role: index % 2 ? "assistant" : "user", status: "completed", text: `${index}`,
  }));
  service.store.save(value, { immediate: true });
  const req = new EventEmitter(); const res = new EventEmitter();
  let text = "";
  res.writeHead = () => {}; res.write = (chunk) => { text += chunk; return true; }; res.end = () => {};
  service.subscribeConversation(req, res, value.id, 40);
  const snapshot = JSON.parse(text.match(/data: (.+)/)[1]).conversation;
  req.emit("close");
  assert.equal(snapshot.messageOffset, 60);
  assert.equal(snapshot.totalMessages, 100);
  value.messages.push({ id: crypto.randomUUID(), role: "user", status: "running", text: "new" },
    { id: crypto.randomUUID(), role: "assistant", status: "running", text: "answer" });
  const delta = service.publicConversationDelta(value);
  assert.equal(delta.replaceFrom, 101);
  assert.equal(delta.totalMessages, 102);
  assert.equal(delta.messages[0].text, "answer");
  // There is a one-message gap (new user) between the snapshot and delta. The
  // frontend must detect it and fetch a fresh paged snapshot, not insert holes.
  assert.ok(delta.replaceFrom > snapshot.totalMessages);
  value.messages = value.messages.slice(0, 20);
  const rollback = service.publicConversationDelta(value);
  assert.equal(rollback.totalMessages, 20);
  assert.ok(rollback.replaceFrom < snapshot.messageOffset);
});

test("idempotency survives cache eviction and new device reusing the same key is independent", (t) => {
  const { service, request } = fixture(t);
  const value = service.createConversation();
  const clientRequestId = crypto.randomUUID();
  const body = { text: "durable request", clientRequestId };
  const first = request("POST", `conversations/${value.id}/messages`, body);
  assert.equal(first.status, 202);
  service.store.cache.clear(); service.store.cacheSizes.clear(); service.store.cacheAccess.clear();
  const retry = request("POST", `conversations/${value.id}/messages`, body);
  assert.equal(retry.status, 200);
  assert.equal(retry.payload.messageId, first.payload.messageId);
  assert.equal(service.readConversation(value.id).messages.length, 2);
  const collision = request("POST", `conversations/${value.id}/messages`, { ...body, text: "changed" });
  assert.equal(collision.status, 409);
  const other = request("POST", `conversations/${value.id}/messages`, body, "device-b");
  assert.equal(other.status, 202);
  assert.equal(service.readConversation(value.id).messages.length, 4);
});
