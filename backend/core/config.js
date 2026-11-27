"use strict";

const fs = require("node:fs");
const path = require("node:path");

function loadCodexProfiles(codexWorkDir, extraHomes = null) {
  const profiles = {
    default: {
      id: "default",
      label: "Witt 默认账号",
      codexHome: "/var/lib/witt/.codex",
      workDir: codexWorkDir,
    },
    antigravity: {
      id: "antigravity",
      label: "Gemini 1",
      provider: "antigravity",
      workDir: codexWorkDir,
    },
    antigravity2: {
      id: "antigravity2",
      label: "Gemini 2",
      provider: "antigravity2",
      workDir: codexWorkDir,
    },
  };
  const candidates = extraHomes || {
    xuanyu: "/home/ubuntu/.codex-xuanyu",
    account4: "/home/ubuntu/.codex-account-4",
    account5: "/home/ubuntu/.codex-account-5",
  };
  for (const [id, home] of Object.entries(candidates)) {
    if (fs.existsSync(path.join(home, "auth.json"))) {
      profiles[id] = { id, label: `Codex ${id}`, codexHome: home, workDir: codexWorkDir };
    }
  }
  return profiles;
}

function loadConfig(env = process.env) {
  const host = env.DROP_VAULT_HOST || "127.0.0.1";
  const port = Number(env.DROP_VAULT_PORT || 3003);
  const dataDir = env.DROP_VAULT_DATA_DIR || "/data/drop-vault/files";
  const taskDir = env.DROP_VAULT_TASK_DIR || "/data/drop-vault/tasks";
  const chatDir = env.DROP_VAULT_CHAT_DIR || "/data/drop-vault/chat";
  const imageDir = env.DROP_VAULT_IMAGE_DIR || "/data/drop-vault/chat-images";
  const usersDir = env.DROP_VAULT_USERS_DIR || "/data/drop-vault/users";
  const authDir = env.DROP_VAULT_AUTH_DIR || "/data/drop-vault/auth";
  const remoteAssistDir = env.DROP_VAULT_REMOTE_ASSIST_DIR || path.join(path.dirname(dataDir), "remote-assist");
  const tokenFile = env.DROP_VAULT_TOKEN_FILE || "/home/ubuntu/.config/drop-vault/api-token";
  const codexBin = env.DROP_VAULT_CODEX_BIN || "/home/ubuntu/.local/bin/codex";
  const codexWorkDir = env.DROP_VAULT_CODEX_WORKDIR || "/home/ubuntu/Documents/Codex/2026-07-26-xlsb";
  const codexProfiles = loadCodexProfiles(codexWorkDir);
  const allowedBrowserOrigins = new Set(
    String(env.WITT_ALLOWED_ORIGINS || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  const serverMigrationTargetUrl = String(env.WITT_MIGRATION_TARGET_URL || "").trim();

  return {
    host,
    port,
    dataDir,
    taskDir,
    chatDir,
    imageDir,
    usersDir,
    authDir,
    remoteAssistDir,
    tokenFile,
    codexBin,
    codexWorkDir,
    codexProfiles,
    allowedBrowserOrigins,
    serverMigrationTargetUrl,
    licreBuildDir: env.WITT_LICRE_BUILD_DIR || "/data/builds",
    licreConsoleDir: env.WITT_LICRE_CONSOLE_DIR || "/data/xuanyu-build-console",
    xuanyuPreviewDir: env.WITT_XUANYU_PREVIEW_DIR || "/data/xuanyu-build-console/repo/build/web",
    maxBytes: 500 * 1024 * 1024,
    maxPromptBytes: 32 * 1024,
    maxTaskOutputBytes: 2 * 1024 * 1024,
  };
}

module.exports = {
  loadConfig,
  loadCodexProfiles,
};
