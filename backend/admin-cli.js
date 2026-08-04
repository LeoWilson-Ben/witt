#!/usr/bin/env node
"use strict";
const readline = require("node:readline");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { AuthService } = require("./auth-service");
const directory = process.env.WITT_AUTH_DIR || "/data/drop-vault/auth";
const usersDirectory = process.env.WITT_USERS_DIR || "/data/drop-vault/users";
const prompt = (label, secret = false) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (secret) rl._writeToOutput = () => {};
  rl.question(label, (value) => { if (secret) process.stdout.write("\n"); rl.close(); resolve(value); });
});
function moveLegacyDirectory(source, destination) {
  if (!fs.existsSync(source)) return;
  if (fs.existsSync(destination)) throw new Error(`迁移目标已存在：${destination}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  fs.renameSync(source, destination);
}

function migrateLegacy(userId) {
  const root = path.join(path.resolve(usersDirectory), userId);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  moveLegacyDirectory(process.env.WITT_LEGACY_CHAT_DIR || "/data/drop-vault/chat", path.join(root, "chat"));
  moveLegacyDirectory(process.env.WITT_LEGACY_FILES_DIR || "/data/drop-vault/files", path.join(root, "files"));
  moveLegacyDirectory(process.env.WITT_LEGACY_IMAGE_DIR || "/data/drop-vault/chat-images", path.join(root, "chat-images"));
}

(async () => {
  if (process.argv[2] !== "init") { console.error("用法：node admin-cli.js init [--server-init]"); process.exit(2); }
  const serverInit = process.argv.includes("--server-init");
  const password = serverInit
    ? crypto.randomBytes(32).toString("base64url")
    : await prompt("设置管理员密码（至少 12 位，输入不会回显）：", true);
  const label = serverInit ? "管理员" : await prompt("管理员设备名称（可留空）：");
  const service = new AuthService({ dir: path.resolve(directory), sendJson() {}, readJsonBody() {} });
  try {
    const invite = service.initialize(password, label || "管理员");
    migrateLegacy(invite.userId);
    if (serverInit) {
      const inviteFile = path.join(path.resolve(directory), "bootstrap-admin-invite.txt");
      const recoveryFile = path.join(path.resolve(directory), "recovery-password.txt");
      fs.writeFileSync(inviteFile, `${invite.code}\n`, { mode: 0o600, flag: "wx" });
      fs.writeFileSync(recoveryFile, `${password}\n`, { mode: 0o600, flag: "wx" });
      console.log(`初始化完成。管理员邀请码已写入 ${inviteFile}`);
      console.log(`恢复凭据已写入 ${recoveryFile}`);
    } else {
      console.log(`初始化完成。管理员邀请码：${invite.code}`);
    }
    console.log("原有对话、文件与图片已迁移到管理员账号。请立即在新版 Witt 中输入邀请码。");
  }
  catch (error) { console.error(`初始化失败：${error.message}`); process.exit(1); }
})();
