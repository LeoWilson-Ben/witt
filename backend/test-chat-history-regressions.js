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

test("cold 1005-message history pages reconstruct exactly, remain read-only, and default GET returns only the latest interaction", (t) => {
  const { service, request } = fixture(t);
  const value = service.createConversation();
  value.messages = Array.from({ length: 1005 }, (_, index) => ({
    id: crypto.randomUUID(), role: index % 2 ? "assistant" : "user", status: "completed",
    text: `message ${index}`, stream: [{ id: `log-${index}`, kind: "command", details: "long log ".repeat(100) }],
  }));
  service.store.save(value, { immediate: true });
  service.store.cache.clear(); service.store.cacheSizes.clear(); service.store.cacheAccess.clear();
  const baseline = service.store.db.prepare("SELECT total_changes() AS n").get().n;
  let page = request("GET", `conversations/${value.id}?view=page&limit=40`).payload.conversation;
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
  assert.equal(full.messages.length, 1);
  assert.equal(full.messageOffset, 1004);
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

test("latest interaction includes steering and cold/warm 24-hour windows reconstruct history including empty days", (t) => {
  const { service, request } = fixture(t);
  const value = service.createConversation();
  const msg = (role, createdAt, extra = {}) => ({ id: crypto.randomUUID(), role, createdAt, text: 'fixture', status: 'completed', ...extra });
  value.messages = [
    msg('user', '2026-10-23T12:00:00Z'), msg('assistant', '2026-10-23T12:00:01Z'),
    msg('user', '2026-10-26T12:00:00Z'), msg('assistant', '2026-10-26T12:00:01Z'),
    // More than the former 100-message cap in one day.
    ...Array.from({length: 150}, (_, i) => msg(i % 2 ? 'assistant' : 'user', '2026-10-27T18:00:00Z')),
    msg('user', '2026-10-28T12:00:00Z'), msg('assistant', '2026-10-28T12:00:01Z'),
  ];
  value.messages.push(msg('user', '2026-10-28T12:00:02Z', { steeredInto: value.messages.at(-1).id }));
  service.store.save(value, { immediate: true });
  for (const cold of [false, true]) {
    if (cold) { service.store.cache.clear(); service.store.cacheSizes.clear(); service.store.cacheAccess.clear(); }
    const baseline = service.store.db.prepare('SELECT total_changes() AS n').get().n;
    let page = request('GET', `conversations/${value.id}?limit=40`).payload.conversation;
    assert.equal(page.messages.length, 3);
    assert.equal(page.messageOffset, 154);
    assert.equal(page.historyBefore, '2026-10-28T12:00:00Z');
    const collected = [...page.messages]; const sizes = [];
    while (page.hasMore) {
      page = request('GET', `conversations/${value.id}/messages?window=24h&before=${page.messageOffset}&until=${encodeURIComponent(page.historyBefore)}`).payload.conversation;
      assert.equal(Date.parse(page.rangeEnd) - Date.parse(page.rangeStart), 86400000);
      collected.unshift(...page.messages); sizes.push(page.messages.length);
    }
    assert.deepEqual(sizes, [150, 2, 0, 0, 2]);
    assert.deepEqual(collected.map(m => m.id), value.messages.map(m => m.id));
    assert.equal(service.store.db.prepare('SELECT total_changes() AS n').get().n, baseline);
    if (cold) assert.equal(service.store.cache.size, 0);
  }
});

test("SSE routes and mutation serialization stay at latest turn; invalid day cursors are rejected", (t) => {
  const { service, request } = fixture(t);
  const value = service.createConversation();
  value.messages = Array.from({length: 6}, (_, i) => ({ id: crypto.randomUUID(), role: i % 2 ? 'assistant' : 'user', text: `${i}`, createdAt: '2026-10-28T12:00:00Z' }));
  service.store.save(value, { immediate: true });
  assert.equal(service.publicConversation(value).messages.length, 2);
  assert.equal(value.messages.length, 6, 'serialization never removes stored history');
  const req = new EventEmitter(); req.method = 'GET'; const res = new EventEmitter();
  let output = ''; res.writeHead = () => {}; res.write = s => { output += s; return true; }; res.end = () => {};
  service.handle(req, res, new URL(`http://localhost/chat/conversations/${value.id}/events?limit=40`), {deviceId:'test'});
  const page = JSON.parse(output.match(/data: (.+)/)[1]).conversation;
  assert.equal(page.messages.length, 2); assert.equal(page.messageOffset, 4); req.emit('close');
  for (const suffix of ['window=24h', 'window=24h&before=4&until=wrong', 'window=24h&before=-1']) {
    assert.equal(request('GET', `conversations/${value.id}/messages?${suffix}`).status, 400);
  }
  const empty = service.createConversation();
  assert.equal(request('GET', `conversations/${empty.id}`).payload.conversation.messages.length, 0);
});
