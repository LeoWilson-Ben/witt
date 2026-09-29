"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { ChatService } = require("./chat-service");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "witt-chat-improvements-"));
const service = new ChatService({
  chatDir: path.join(root, "chat"), dataDir: path.join(root, "files"),
  imageDir: path.join(root, "images"), codexBin: "/bin/false", codexWorkDir: root,
  sendJson(res, status, payload) { res.status = status; res.payload = payload; },
  readJsonBody(req, _limit, callback) { callback(null, req.body || {}); },
  allowedModels: null,
});
service.runNext = () => {};
function request(method, suffix, body = {}) {
  const res = {};
  assert.equal(service.handle({ method, body }, res, new URL(`http://localhost/chat/${suffix}`),
    { deviceId: "private-device-a" }), true);
  return res;
}

try {
  const conversation = service.createConversation();
  for (let i = 0; i < 125; i += 1) conversation.messages.push({
    id: crypto.randomUUID(), role: i % 2 ? "assistant" : "user", text: `message ${i}`,
    status: "completed", attachments: [], createdAt: new Date().toISOString(),
  });
  conversation.messages[5].text = "独一无二的历史搜索内容";
  conversation.messages[5].attachments = [{ id: crypto.randomUUID(), name: "test.txt" }];
  service.writeConversation(conversation);
  const latest = request("GET", `conversations/${conversation.id}?limit=40`).payload.conversation;
  assert.equal(latest.messages.length, 40);
  assert.equal(latest.messageOffset, 85);
  assert.equal(latest.totalMessages, 125);
  assert.equal(latest.hasMore, true);
  assert.equal(request("GET", `conversations/${conversation.id}`).payload.conversation.messages.length, 125,
    "legacy clients keep their full history without an explicit page limit");
  const previous = request("GET", `conversations/${conversation.id}/messages?before=85&limit=40`).payload.conversation;
  assert.equal(previous.messageOffset, 45);
  assert.equal(previous.messages.at(-1).id, conversation.messages[84].id);
  assert.equal(request("GET", `conversations/${conversation.id}/messages?before=-1`).status, 400);
  assert.equal(request("GET", `conversations/${conversation.id}?limit=bad`).status, 400);
  const delta = service.publicConversationDelta(conversation);
  assert.equal(delta.replaceFrom, 123);
  assert.equal(delta.totalMessages, 125);

  const req = new EventEmitter();
  const res = new EventEmitter();
  let eventText = "";
  res.writeHead = () => {};
  res.write = (chunk) => { eventText += chunk; return true; };
  res.end = () => {};
  service.subscribeConversation(req, res, conversation.id, 40);
  const snapshot = JSON.parse(eventText.match(/data: (.+)/)[1]).conversation;
  assert.equal(snapshot.messageOffset, 85);
  assert.equal(snapshot.messages.length, 40);
  req.emit("close");

  const search = request("GET", "conversations?q=独一无二&attachments=1").payload;
  assert.equal(search.conversations[0].id, conversation.id);
  assert.match(search.conversations[0].searchSnippet, /独一无二/);
  assert.equal(search.conversations[0].messages, undefined);
  assert.match(search.currentDeviceLabel, /^设备 [A-F0-9]{6}$/);
  assert.equal(request("PATCH", `conversations/${conversation.id}`, { pinned: true, project: "玄遇" }).status, 200);
  assert.equal(request("GET", "conversations?project=玄遇").payload.conversations[0].pinned, true);
  assert.equal(request("GET", "conversations?project=不存在").payload.conversations.length, 0);
  assert.equal(request("PATCH", `conversations/${conversation.id}`, { project: "x".repeat(81) }).status, 400);

  const clientRequestId = crypto.randomUUID();
  const first = request("POST", `conversations/${conversation.id}/messages`, { text: "new message", clientRequestId });
  assert.equal(first.status, 202);
  const count = conversation.messages.length;
  const retry = request("POST", `conversations/${conversation.id}/messages`, { text: "new message", clientRequestId });
  assert.equal(retry.status, 200);
  assert.equal(retry.payload.duplicate, true);
  assert.equal(retry.payload.messageId, first.payload.messageId);
  assert.equal(conversation.messages.length, count);
  service.quotaExhausted = true;
  assert.equal(request("POST", `conversations/${conversation.id}/messages`, { text: "new message", clientRequestId }).status, 200);
  service.quotaExhausted = false;
  assert.equal(request("POST", `conversations/${conversation.id}/messages`, { text: "different", clientRequestId }).status, 409);
  assert.equal(request("PATCH", `conversations/${conversation.id}`, { pinned: false }).status, 200);
  const publicMessage = service.publicMessage(conversation.messages.at(-2));
  assert.equal(publicMessage.senderDeviceId, undefined);
  assert.equal(publicMessage.clientRequestId, undefined);
  assert.equal(publicMessage.requestFingerprint, undefined);
  assert.equal(publicMessage.senderDeviceLabel, search.currentDeviceLabel);
  const other = {};
  service.createMessage({ body: { text: "new message", clientRequestId } }, other, conversation.id, "private-device-b");
  assert.equal(other.status, 202);
  assert.equal(conversation.messages.length, count + 2);
  assert.notEqual(service.publicMessage(conversation.messages.at(-2)).senderDeviceLabel, publicMessage.senderDeviceLabel);
  console.log("chat improvement tests passed (pagination, SSE, search, metadata, idempotency, privacy)");
} finally {
  for (const checkpoint of service.jsonCheckpoints.values()) clearTimeout(checkpoint.timer);
  for (const timer of service.eventBroadcasts.values()) clearTimeout(timer);
  service.store.close();
  fs.rmSync(root, { recursive: true, force: true });
}
