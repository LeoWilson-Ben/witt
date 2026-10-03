"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ChatService, NON_ADMIN_MODELS } = require("./chat-service");
const { refreshChatAccess } = require("./chat-access-policy");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "witt-policy-"));
const service = new ChatService({
  chatDir: path.join(root, "chat"), dataDir: path.join(root, "files"),
  imageDir: path.join(root, "images"), codexWorkDir: root, codexBin: "/bin/false",
  sendJson() {}, readJsonBody() {}, allowedModels: NON_ADMIN_MODELS,
  quotaExhausted: true, allowedCodexProfiles: ["default"],
  codexProfiles: {
    default: { id: "default", workDir: os.homedir() },
    xuanyu: { id: "xuanyu", workDir: os.homedir() },
  },
});
try {
  const oldConversation = service.createConversation();
  const active = { conversationId: oldConversation.id, marker: "preserve" };
  service.active = active;
  const options = { allowedModels: null, defaultModel: "gpt-6.1-sol",
    quotaExhausted: false, allowedCodexProfiles: ["xuanyu", "default"] };
  service.usageCache.set("old", { stale: true });
  service.capabilityCache.set("old", { stale: true });
  refreshChatAccess(service, options);
  assert.equal(service.defaultCodexProfile, "xuanyu");
  assert.equal(service.quotaExhausted, false);
  assert.equal(service.allowedModels, null);
  assert.equal(service.usageCache.size, 0);
  assert.equal(service.capabilityCache.size, 0);
  assert.equal(service.active, active, "grant must not interrupt running turns");
  assert.equal(oldConversation.codexProfile, "default", "existing threads keep their account");
  const proConversation = service.createConversation();
  assert.equal(proConversation.codexProfile, "xuanyu");
  assert.equal(service.profileAllowed(proConversation), true);
  service.usageCache.set("fresh", { valid: true });
  refreshChatAccess(service, options);
  assert.equal(service.usageCache.size, 1, "same policy should retain fresh cache");
  refreshChatAccess(service, { allowedModels: NON_ADMIN_MODELS, defaultModel: "gpt-5.5",
    quotaExhausted: true, allowedCodexProfiles: ["default"] });
  assert.equal(service.profileAllowed(proConversation), false, "revocation must take effect too");
  assert.equal(service.quotaExhausted, true);
  assert.throws(() => service.createConversation("denied", undefined, undefined,
    undefined, undefined, "xuanyu"), /不能使用/);
  assert.equal(service.active, active);
  console.log("Chat access grant, revocation, cache refresh and thread preservation passed");
} finally {
  service.store.close();
  fs.rmSync(root, { recursive: true, force: true });
}
