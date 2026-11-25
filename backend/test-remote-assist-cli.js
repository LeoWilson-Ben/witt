"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const { WebSocket } = require("ws");

const { DeviceGateway } = require("./remote-device/device-gateway");
const { WorkspaceStore, WorkspaceAuditStore, ApprovalGate, WorkspaceDispatcher } = require("./remote-workspace");
const { RemoteWorkspaceService } = require("./remote-workspace-service");
const { createRemoteAssist } = require("./remote-assist");

function createFakeChat() {
  const conversations = new Map();
  return {
    defaultModel: "gpt-6.1-sol",
    createRemoteWorkspaceConversation({ title, model, reasoning, codexProfile, harnessSessionId }) {
      const conv = {
        id: crypto.randomUUID(),
        title: title || "远程协助",
        model: model || "gpt-6.1-sol",
        reasoning: reasoning || "medium",
        codexProfile: codexProfile || "default",
        harnessSessionId,
        messages: [],
      };
      conversations.set(conv.id, conv);
      return conv;
    },
    readConversation(id) { return conversations.get(id) || null; },
    publicConversation(c) { return c; },
  };
}

function httpJson(url, method = "GET", body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method,
      headers: {
        ...(body !== null ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on("error", reject);
    if (body !== null) req.write(JSON.stringify(body));
    req.end();
  });
}

test("Remote Assist CLI: full flow, reconnect grace period, exec_start/poll/kill, revoke and MCP filtering", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "witt-assist-cli-test-"));
  const runtimeDir = path.join(dir, "runtime");
  const gateway = new DeviceGateway({ configFile: path.join(dir, "devices.json") });
  const workspaceStore = new WorkspaceStore(dir);
  const approvals = new ApprovalGate();
  const audit = new WorkspaceAuditStore(dir);
  const fakeChat = createFakeChat();
  const operator = { userId: crypto.randomUUID(), admin: true, label: "TestAdmin" };

  let remoteWorkspaceService = null;
  const assist = createRemoteAssist({
    gateway,
    workspaceStore,
    auditDirectory: dir,
    reconnectGraceMs: 250,
    readJsonBody(req, limit, cb) {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try { cb(null, JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
        catch (err) { cb(err); }
      });
    },
    sendJson(res, status, payload) {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    },
    chatFor: () => fakeChat,
    prepareWorkspace: (ws) => remoteWorkspaceService?.runtimeFor(ws),
  });

  const dispatcher = new WorkspaceDispatcher({
    workspaceStore,
    transport: assist.transport,
    approvals,
    audit,
    assistCommandsFor: (id) => assist.sessions.commandsAllowed(id),
    fullAccessFor: (id) => assist.sessions.fullAccessAllowed(id),
  });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (remoteWorkspaceService.handleInternalMcp(req, res, url,
      (r, _l, cb) => {
        const chunks = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () => cb(null, JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")));
      },
      (r, status, payload) => {
        r.writeHead(status, { "Content-Type": "application/json" });
        r.end(JSON.stringify(payload));
      })) return;
    if (assist.routes.handleCustomer(req, res, url)) return;
    if (assist.routes.handleOperator(req, res, url, operator)) return;
    res.writeHead(404);
    res.end();
  });
  gateway.attach(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  remoteWorkspaceService = new RemoteWorkspaceService({
    workspaceStore,
    dispatcher,
    approvals,
    audit,
    runtimeDir,
    apiBase: baseUrl,
    capabilitiesFor: (id) => gateway.registry.definition(id)?.capabilities || null,
  });

  let ws = null;
  let ws2 = null;
  try {
    // 1. 创建 full 模式协助码（无强制时长限制）
    const created = await httpJson(`${baseUrl}/remote-assist/sessions`, "POST", {
      customer_label: "Test-PC",
      access_mode: "full",
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.expires_at, null);
    assert.equal(created.body.pairing_expires_at, null);
    assert.match(created.body.pairing_code, /^[A-F0-9]{5}-[A-F0-9]{5}$/);
    assert.equal(created.body.access_mode, "full");
    assert.ok(created.body.allowed_capabilities.includes("workspace.exec_start"));
    assert.ok(created.body.allowed_capabilities.includes("workspace.exec_poll"));
    assert.ok(created.body.allowed_capabilities.includes("workspace.exec_kill"));

    // 2. Preview & Authorize
    const preview = await httpJson(`${baseUrl}/assist/preview`, "POST", { code: created.body.pairing_code });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.service_name, "Witt Remote Assist");
    const authorized = await httpJson(`${baseUrl}/assist/authorize`, "POST", {
      pair_ticket: preview.body.pair_ticket,
      workspace_root: "C:\\temp",
      allowed_capabilities: preview.body.allowed_capabilities,
      access_mode: "full",
      consent_version: 2,
    });
    assert.equal(authorized.status, 200);
    const { assist_session_id, device_id, device_token } = authorized.body;

    // 3. 建立 mock WSS 设备连接
    const connectMockDevice = () => new Promise((resolve, reject) => {
      const sock = new WebSocket(`ws://127.0.0.1:${port}/device/ws`, {
        headers: { Authorization: `Bearer ${device_token}`, "X-Witt-Device-Id": device_id },
      });
      sock.on("open", () => {
        sock.send(JSON.stringify({
          v: 1, type: "register", device_id, hostname: "TEST-PC", agent_version: "0.4.0",
          capabilities: preview.body.allowed_capabilities, roots: ["project"],
        }));
      });
      sock.on("message", (data) => {
        const msg = JSON.parse(data.toString("utf8"));
        if (msg.type === "registered") resolve(sock);
        else if (msg.type === "command") {
          const op = msg.args.operation;
          let stdout = "{}";
          if (op === "workspace.list") stdout = JSON.stringify({ entries: [{ name: "README.md", type: "file" }] });
          else if (op === "workspace.exec_start") stdout = JSON.stringify({ process_id: "p-123", running: true });
          else if (op === "workspace.exec_poll") stdout = JSON.stringify({ process_id: "p-123", running: false, exit_code: 0, output: "hi", next_offset: 2, total_bytes: 2 });
          else if (op === "workspace.exec_kill") stdout = JSON.stringify({ process_id: "p-123", killed: true });
          sock.send(JSON.stringify({ v: 1, type: "result", id: msg.id, device_id, exit_code: 0, stdout }));
        }
      });
      sock.on("error", reject);
    });

    ws = await connectMockDevice();

    // 4. 绑定对话与准备 MCP runtime
    const bound = await httpJson(`${baseUrl}/remote-assist/sessions/${assist_session_id}/workspace`, "POST", {
      model: "gpt-6.1-sol",
    });
    assert.equal(bound.status, 200);
    const runtime = remoteWorkspaceService.runtimeFor(bound.body.workspace);
    assert.ok(fs.existsSync(runtime.mcpConfigPath));
    assert.ok(runtime.codexConfigOverrides.some((line) => line.includes("witt_remote_workspace")));

    // 5. 测试 MCP 内部接口执行 list / exec_start / exec_poll / exec_kill
    const mcpCall = (operation, args) => httpJson(`${baseUrl}/internal/remote-workspaces/mcp`, "POST", { operation, args }, {
      Authorization: `Bearer ${runtime.secret}`,
    });
    const listRes = await mcpCall("workspace.list", { path: "." });
    assert.equal(listRes.status, 200);
    assert.equal(JSON.parse(listRes.body.result.stdout).entries[0].name, "README.md");

    const startRes = await mcpCall("workspace.exec_start", { program: "python", argv: ["-m", "uvicorn"] });
    assert.equal(startRes.status, 200);
    assert.equal(JSON.parse(startRes.body.result.stdout).process_id, "p-123");

    const pollRes = await mcpCall("workspace.exec_poll", { process_id: "p-123", offset: 0, wait_ms: 100 });
    assert.equal(pollRes.status, 200);
    assert.equal(JSON.parse(pollRes.body.result.stdout).output, "hi");

    const killRes = await mcpCall("workspace.exec_kill", { process_id: "p-123" });
    assert.equal(killRes.status, 200);
    assert.equal(JSON.parse(killRes.body.result.stdout).killed, true);

    // 6. 测试闪断重连宽限期：断开后在 100ms (<250ms) 内重连，会话保持 active
    ws.close();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(assist.sessions.sessions.get(assist_session_id).state, "active");
    ws2 = await connectMockDevice();
    await new Promise((r) => setTimeout(r, 220));
    assert.equal(assist.sessions.sessions.get(assist_session_id).state, "active");

    const afterReconnect = await mcpCall("workspace.list", { path: "." });
    assert.equal(afterReconnect.status, 200);

    // 7. 测试 stdio MCP 脚本 tools/list 过滤能力
    const mcpOutput = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(__dirname, "mcp", "remote-workspace.js")], {
        env: {
          ...process.env,
          WITT_REMOTE_WORKSPACE_MCP_ENABLED: "1",
          WITT_REMOTE_WORKSPACE_MCP_API: baseUrl,
          WITT_REMOTE_WORKSPACE_CREDENTIAL_FILE: runtime.credentialFile,
          WITT_REMOTE_WORKSPACE_CAPABILITIES: JSON.stringify(["workspace.list", "workspace.exec_start"]),
        },
      });
      let out = "";
      child.stdout.on("data", (d) => {
        out += d.toString("utf8");
        if (out.includes("\n")) {
          child.kill();
          resolve(JSON.parse(out.trim().split("\n")[0]));
        }
      });
      child.on("error", reject);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
    });
    const names = mcpOutput.result.tools.map((t) => t.name);
    assert.deepEqual(names, ["workspace_list", "workspace_exec_start"]);

    // 8. 测试主动撤销后拒绝新指令与 MCP 调用
    const revoked = await httpJson(`${baseUrl}/remote-assist/sessions/${assist_session_id}/revoke`, "POST", {});
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.state, "revoked");
    const afterRevoke = await mcpCall("workspace.list", { path: "." });
    assert.equal(afterRevoke.status, 401);
  } finally {
    try { ws?.close(); } catch {}
    try { ws2?.close(); } catch {}
    remoteWorkspaceService.close();
    assist.close();
    try { workspaceStore.close?.(); } catch {}
    try { audit.close?.(); } catch {}
    gateway.close();
    server.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

test("Real chloe.exe E2E smoke: interactive stdin pairing code, list, exec_start, exec_poll, exec_kill, and revoke", async () => {
  const cliBin = path.resolve(__dirname, "..", "web", "cli", "chloe.exe");
  assert.ok(fs.existsSync(cliBin), "chloe.exe must be built first");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "witt-cli-e2e-"));
  const workDir = path.join(dir, "customer-work");
  fs.mkdirSync(workDir, { recursive: true });
  fs.writeFileSync(path.join(workDir, "hello.txt"), "witt-cli-smoke\n", "utf8");

  const runtimeDir = path.join(dir, "runtime");
  const gateway = new DeviceGateway({ configFile: path.join(dir, "devices.json") });
  const workspaceStore = new WorkspaceStore(dir);
  const approvals = new ApprovalGate();
  const audit = new WorkspaceAuditStore(dir);
  const fakeChat = createFakeChat();
  const operator = { userId: crypto.randomUUID(), admin: true, label: "SmokeOp" };

  let remoteWorkspaceService = null;
  const assist = createRemoteAssist({
    gateway,
    workspaceStore,
    auditDirectory: dir,
    reconnectGraceMs: 2000,
    readJsonBody(req, limit, cb) {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try { cb(null, JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
        catch (err) { cb(err); }
      });
    },
    sendJson(res, status, payload) {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    },
    chatFor: () => fakeChat,
    prepareWorkspace: (ws) => remoteWorkspaceService?.runtimeFor(ws),
  });
  const dispatcher = new WorkspaceDispatcher({
    workspaceStore,
    transport: assist.transport,
    approvals,
    audit,
    assistCommandsFor: (id) => assist.sessions.commandsAllowed(id),
    fullAccessFor: (id) => assist.sessions.fullAccessAllowed(id),
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (remoteWorkspaceService.handleInternalMcp(req, res, url,
      (r, _l, cb) => {
        const chunks = [];
        r.on("data", (c) => chunks.push(c));
        r.on("end", () => cb(null, JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")));
      },
      (r, status, payload) => {
        r.writeHead(status, { "Content-Type": "application/json" });
        r.end(JSON.stringify(payload));
      })) return;
    if (assist.routes.handleCustomer(req, res, url)) return;
    if (assist.routes.handleOperator(req, res, url, operator)) return;
    res.writeHead(404);
    res.end();
  });
  gateway.attach(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  remoteWorkspaceService = new RemoteWorkspaceService({
    workspaceStore,
    dispatcher,
    approvals,
    audit,
    runtimeDir,
    apiBase: baseUrl,
    capabilitiesFor: (id) => gateway.registry.definition(id)?.capabilities || null,
  });

  let cliProc = null;
  try {
    const created = await httpJson(`${baseUrl}/remote-assist/sessions`, "POST", {
      customer_label: "Real-CLI-PC",
      access_mode: "full",
    });
    assert.equal(created.status, 200);
    const sessionId = created.body.assist_session_id;
    const code = created.body.pairing_code;

    let cliLogs = "";
    // 模拟用户直接运行 `chloe`（不带 assist 子命令和协助码，从 stdin 交互输入协助码）
    cliProc = spawn(cliBin, ["--server", baseUrl, "--root", workDir, "-y"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    cliProc.stdout.on("data", (d) => { cliLogs += d.toString("utf8"); });
    cliProc.stderr.on("data", (d) => { cliLogs += d.toString("utf8"); });
    cliProc.stdin.write(`${code}\n`);

    // 等待真实 witt-cli.exe 完成配对与 WSS 上线
    let online = false;
    for (let i = 0; i < 40; i++) {
      const list = await httpJson(`${baseUrl}/remote-assist/sessions`, "GET");
      const current = list.body.sessions?.find((s) => s.assist_session_id === sessionId);
      if (current?.state === "active" && current?.connected) {
        online = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    assert.ok(online, `witt-cli.exe did not connect in time. Logs:\n${cliLogs}`);

    const bound = await httpJson(`${baseUrl}/remote-assist/sessions/${sessionId}/workspace`, "POST", { model: "gpt-6.1-sol" });
    assert.equal(bound.status, 200);
    const runtime = remoteWorkspaceService.runtimeFor(bound.body.workspace);
    const mcpCall = (operation, args) => httpJson(`${baseUrl}/internal/remote-workspaces/mcp`, "POST", { operation, args }, {
      Authorization: `Bearer ${runtime.secret}`,
    });

    // 通过真实 witt-cli.exe 列出并读取文件
    const listRes = await mcpCall("workspace.list", { path: "." });
    assert.equal(listRes.status, 200);
    assert.ok(JSON.parse(listRes.body.result.stdout).some((e) => e.name === "hello.txt"));

    // 通过真实 witt-cli.exe 后台启动长进程 -> 轮询增量输出 -> 杀死进程
    const started = await mcpCall("workspace.exec_start", {
      program: "cmd",
      argv: ["/c", "echo cli-bg-started && ping -n 20 127.0.0.1 >nul"],
    });
    assert.equal(started.status, 200);
    const procId = JSON.parse(started.body.result.stdout).process_id;
    assert.ok(procId);

    let pollOutput = "";
    let offset = 0;
    let lastSnap = null;
    for (let i = 0; i < 15; i++) {
      const pollRes = await mcpCall("workspace.exec_poll", { process_id: procId, offset, wait_ms: 500 });
      assert.equal(pollRes.status, 200);
      const snap = JSON.parse(pollRes.body.result.stdout);
      lastSnap = snap;
      pollOutput += snap.output || "";
      offset = snap.next_offset;
      if (pollOutput.includes("cli-bg-started")) break;
    }
    assert.ok(pollOutput.includes("cli-bg-started"), `missing background output, got: ${pollOutput}, lastSnap=${JSON.stringify(lastSnap)}, cliLogs=${cliLogs}`);

    const killRes = await mcpCall("workspace.exec_kill", { process_id: procId });
    assert.equal(killRes.status, 200);
    assert.equal(JSON.parse(killRes.body.result.stdout).killed, true);

    const pollAfterKill = await mcpCall("workspace.exec_poll", { process_id: procId, offset, wait_ms: 0 });
    assert.equal(JSON.parse(pollAfterKill.body.result.stdout).running, false);

    // 撤销后验证 CLI 自动退出且拒绝后续调用
    const revRes = await httpJson(`${baseUrl}/remote-assist/sessions/${sessionId}/revoke`, "POST", {});
    assert.equal(revRes.status, 200);
    const exitCode = await new Promise((resolve) => {
      if (cliProc.exitCode !== null) return resolve(cliProc.exitCode);
      const timer = setTimeout(() => resolve("timeout"), 5000);
      cliProc.once("exit", (code) => { clearTimeout(timer); resolve(code); });
    });
    assert.equal(exitCode, 0, `expected witt-cli.exe exit 0 on revoke, got ${exitCode}. Logs:\n${cliLogs}`);
  } finally {
    try { if (cliProc && cliProc.exitCode === null) cliProc.kill(); } catch {}
    remoteWorkspaceService.close();
    assist.close();
    try { workspaceStore.close?.(); } catch {}
    try { audit.close?.(); } catch {}
    gateway.close();
    server.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
