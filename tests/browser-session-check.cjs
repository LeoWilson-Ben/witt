"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { AuthService } = require("../backend/auth-service");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "witt-browser-session-"));
const authDir = path.join(root, "auth");
const tokenFile = path.join(root, "legacy-token");
fs.writeFileSync(tokenFile, "test-legacy-token\n", { mode: 0o600 });
const auth = new AuthService({ dir: authDir, sendJson() {}, readJsonBody() {} });
const invite = auth.initialize("correct horse battery staple", "owner");
const port = 32000 + Math.floor(Math.random() * 1000);
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [path.join(__dirname, "../backend/server.js")], {
  stdio: "ignore",
  env: {
    ...process.env,
    DROP_VAULT_PORT: String(port),
    DROP_VAULT_AUTH_DIR: authDir,
    DROP_VAULT_DATA_DIR: path.join(root, "files"),
    DROP_VAULT_TASK_DIR: path.join(root, "tasks"),
    DROP_VAULT_CHAT_DIR: path.join(root, "chat"),
    DROP_VAULT_IMAGE_DIR: path.join(root, "images"),
    DROP_VAULT_USERS_DIR: path.join(root, "users"),
    DROP_VAULT_TOKEN_FILE: tokenFile,
  },
});

async function waitForServer() {
  for (let index = 0; index < 50; index += 1) {
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("test server did not start");
}

(async () => {
  try {
    await waitForServer();
    const activation = await fetch(`${origin}/auth/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Witt-Client": "browser" },
      body: JSON.stringify({
        inviteCode: invite.code,
        deviceId: "33333333-3333-4333-8333-333333333333",
        deviceName: "Browser test",
      }),
    });
    const activationBody = await activation.json();
    const setCookie = activation.headers.get("set-cookie") || "";
    if (activation.status !== 201 || activationBody.token || !setCookie.includes("HttpOnly")) {
      throw new Error("browser activation response is not secure");
    }
    const cookie = setCookie.split(";", 1)[0];
    const status = await fetch(`${origin}/auth/status`, { headers: { Cookie: cookie } });
    const statusBody = await status.json();
    if (!statusBody.authenticated || !statusBody.principal?.admin) {
      throw new Error("browser cookie did not authenticate");
    }
    const rejected = await fetch(`${origin}/admin/invites`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ label: "rejected" }),
    });
    if (rejected.status !== 403) throw new Error("cross-origin protection was not enforced");
    const accepted = await fetch(`${origin}/admin/invites`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ label: "accepted" }),
    });
    if (accepted.status !== 201) throw new Error("same-origin browser request was rejected");
    console.log("browser session checks passed");
  } finally {
    child.kill("SIGTERM");
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
