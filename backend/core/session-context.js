"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { refreshChatAccess } = require("../chat-access-policy");
const { ChatService, NON_ADMIN_MODELS } = require("../chat-service");

function createSessionContext({
  token,
  authService,
  chatService,
  userChatServices,
  usersDir,
  dataDir,
  codexBin,
  codexWorkDir,
  codexProfiles,
  remoteWorkspaceService,
  providerRuntimeFor,
  sendJson,
  readJsonBody,
}) {
  function authorized(req) {
    const header = req.headers.authorization || "";
    const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
    const expected = Buffer.from(token);
    const actual = Buffer.from(supplied);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }

  function userDirectory(userId) {
    if (!/^[a-f0-9-]{36}$/.test(String(userId || ""))) throw new Error("无效用户");
    const directory = path.join(usersDir, userId);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    return directory;
  }

  function principalFor(req) {
    const principal = authService.authenticate(req.headers.authorization);
    if (principal) return principal;
    const cookies = String(req.headers.cookie || "").split(";");
    const session = cookies.find((item) => item.trim().startsWith("witt_session="));
    if (session) {
      const value = session.trim().slice("witt_session=".length);
      try {
        const browserPrincipal = authService.authenticateToken(decodeURIComponent(value));
        if (browserPrincipal) return browserPrincipal;
      } catch {}
    }
    // The legacy client is accepted only until the owner initializes access.
    if (!authService.initialized() && authorized(req)) {
      return { userId: "legacy", deviceId: "legacy", admin: true, legacy: true, label: "旧版管理员" };
    }
    return null;
  }

  function chatFor(principal) {
    if (principal.legacy) return chatService;
    if (userChatServices.has(principal.userId)) {
      return refreshChatAccess(userChatServices.get(principal.userId), {
        serverAdministrator: Boolean(principal.admin || principal.fullServerAccess),
        allowedModels: principal.admin || principal.unrestrictedModels ? null : NON_ADMIN_MODELS,
        defaultModel: principal.admin || principal.unrestrictedModels ? "gpt-6.1-sol" : "gpt-5.5",
        quotaExhausted: !principal.admin && !principal.unrestrictedModels,
        allowedCodexProfiles: principal.admin
          ? Object.keys(codexProfiles) : (principal.codexProfiles || ["default"]),
      });
    }
    const directory = userDirectory(principal.userId);
    const service = new ChatService({
      serverAdministrator: Boolean(principal.admin || principal.fullServerAccess),
      chatDir: path.join(directory, "chat"),
      imageDir: path.join(directory, "chat-images"),
      dataDir: path.join(directory, "files"),
      codexBin,
      codexWorkDir,
      sendJson,
      readJsonBody,
      allowedModels: principal.admin || principal.unrestrictedModels ? null : NON_ADMIN_MODELS,
      defaultModel: principal.admin || principal.unrestrictedModels ? "gpt-6.1-sol" : "gpt-5.5",
      quotaExhausted: !principal.admin && !principal.unrestrictedModels,
      codexProfiles,
      remoteWorkspaceService,
      providerRuntime: providerRuntimeFor(principal.userId),
      allowedCodexProfiles: principal.admin
        ? Object.keys(codexProfiles)
        : (principal.codexProfiles || ["default"]),
    });
    userChatServices.set(principal.userId, service);
    return service;
  }

  function filesFor(principal) {
    return principal.legacy ? dataDir : path.join(userDirectory(principal.userId), "files");
  }

  function restoreScheduledUsers() {
    const store = authService.read();
    const seen = new Set();
    for (const device of store.devices) {
      if (device.disabled || seen.has(device.userId)) continue;
      seen.add(device.userId);
      const stateFile = path.join(usersDir, device.userId, "chat", "workspace-state.json");
      try {
        if (!fs.existsSync(stateFile)) continue;
        const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
        if (!state.schedules?.some((item) => item.enabled)) continue;
        const policy = store.userPolicies?.[device.userId] || store.defaultUserPolicy;
        chatFor({
          userId: device.userId,
          deviceId: device.id,
          admin: Boolean(device.admin),
          codexProfiles: policy?.codexProfiles || null,
          unrestrictedModels: Boolean(policy?.unrestrictedModels),
        });
      } catch { /* A corrupt user's workspace must not stop the server. */ }
    }
  }

  return {
    authorized,
    principalFor,
    chatFor,
    filesFor,
    restoreScheduledUsers,
  };
}

module.exports = { createSessionContext };
