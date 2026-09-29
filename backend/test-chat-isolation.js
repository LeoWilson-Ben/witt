"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ChatService } = require("./chat-service");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "witt-chat-isolation-"));
const profile = {
  default: {
    id: "default",
    label: "test",
    codexHome: path.join(root, "codex-home"),
    workDir: root,
  },
};

function service(name) {
  return new ChatService({
    chatDir: path.join(root, name, "chat"),
    imageDir: path.join(root, name, "images"),
    dataDir: path.join(root, name, "files"),
    codexBin: "/bin/false",
    codexWorkDir: root,
    sendJson(res, status, payload) {
      res.status = status;
      res.payload = payload;
    },
    readJsonBody(req, _limit, callback) {
      callback(null, req.body || {});
    },
    allowedModels: null,
    codexProfiles: profile,
  });
}

try {
  const first = service("first");
  const second = service("second");

  assert.equal(first.clientFor(profile.default), first.clientFor(profile.default),
    "one user should reuse its own app-server client");
  assert.notEqual(first.clientFor(profile.default), second.clientFor(profile.default),
    "different users must not share an app-server notification stream");

  const conversation = first.createConversation();
  const ownerUser = {
    id: crypto.randomUUID(), role: "user", text: "owner", attachments: [],
    createdAt: new Date().toISOString(), status: "running", senderDeviceId: "device-a",
  };
  const ownerAssistant = {
    id: crypto.randomUUID(), role: "assistant", text: "", attachments: [],
    createdAt: new Date().toISOString(), status: "running", replyTo: ownerUser.id,
    stream: [], activity: [],
  };
  conversation.messages.push(ownerUser, ownerAssistant);
  first.writeConversation(conversation);
  first.active = {
    conversationId: conversation.id,
    messageId: ownerAssistant.id,
    userId: ownerUser.id,
    ownerDeviceId: "device-a",
    turnId: null,
    turnStarted: false,
    pendingSteers: [],
    pendingApprovals: new Map(),
    client: first.clientFor(profile.default),
  };

  const otherResponse = {};
  first.createMessage({ body: { text: "from device b" } }, otherResponse,
    conversation.id, "device-b");
  assert.equal(otherResponse.status, 202);
  const otherUser = conversation.messages.at(-2);
  const otherAssistant = conversation.messages.at(-1);
  assert.equal(otherUser.status, "queued");
  assert.equal(otherUser.steeredInto, undefined);
  assert.equal(otherAssistant.replyTo, otherUser.id);
  assert.equal(otherAssistant.status, "queued");

  const ownerResponse = {};
  const beforeOwnerSteer = conversation.messages.length;
  first.createMessage({ body: { text: "owner follow-up" } }, ownerResponse,
    conversation.id, "device-a");
  assert.equal(ownerResponse.payload.steered, true);
  assert.equal(conversation.messages.length, beforeOwnerSteer + 1);
  assert.equal(conversation.messages.at(-1).steeredInto, ownerAssistant.id);
  assert.equal(first.publicMessage(conversation.messages.at(-1)).senderDeviceId, undefined,
    "device identifiers must not be exposed to clients");

  console.log("chat isolation tests passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
