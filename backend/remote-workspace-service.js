"use strict";

// 远程协助会话运行期胶水层：负责短期单会话 MCP 凭据生成、多 Harness MCP 配置生成与内部 MCP 调用转发。

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

class RemoteWorkspaceServiceError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isLoopbackAddress(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

class RemoteWorkspaceService {
  constructor(options = {}) {
    if (!options.workspaceStore || !options.dispatcher || !options.approvals || !options.audit) {
      throw new RemoteWorkspaceServiceError("INVALID_DEPENDENCIES");
    }
    this.workspaceStore = options.workspaceStore;
    this.dispatcher = options.dispatcher;
    this.capabilitiesFor = options.capabilitiesFor || (() => null);
    this.approvals = options.approvals;
    this.audit = options.audit;
    this.runtimeDir = options.runtimeDir;
    this.spacesDir = options.spacesDir || (this.runtimeDir ? path.join(path.dirname(this.runtimeDir), "spaces") : null);
    this.mcpProgram = options.mcpProgram || path.join(__dirname, "mcp", "remote-workspace.js");
    this.apiBase = options.apiBase || "http://127.0.0.1:3003";
    this.approvalTtlMs = options.approvalTtlMs || 5 * 60_000;
    this.notifyApproval = options.notifyApproval || (() => { throw new RemoteWorkspaceServiceError("APPROVAL_UI_UNAVAILABLE"); });
    this.sessions = new Map();
    this.closed = false;
    this.waiters = new Map();
    if (this.runtimeDir) fs.mkdirSync(this.runtimeDir, { recursive: true, mode: 0o700 });
    if (this.spacesDir) fs.mkdirSync(this.spacesDir, { recursive: true, mode: 0o700 });
    this.cleanupStaleSpaces();
  }

  spaceDirectories() {
    return [...new Set([this.spacesDir, this.runtimeDir].filter(Boolean))];
  }

  cleanupStaleSpaces() {
    for (const rootDir of this.spaceDirectories()) {
      let entries = [];
      try { entries = fs.readdirSync(rootDir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        let active = false;
        try {
          const binding = this.workspaceStore.get(entry.name);
          active = Boolean(binding && binding.state === "active");
        } catch {
          active = false;
        }
        if (!active) {
          try { fs.rmSync(path.join(rootDir, entry.name), { recursive: true, force: true }); } catch {}
        }
      }
    }
  }

  spaceExists(workspaceId) {
    if (!workspaceId) return false;
    return this.spaceDirectories().some((dir) => fs.existsSync(path.join(dir, workspaceId)));
  }

  fullAccessFor(binding) {
    return !!binding && this.dispatcher.fullAccessFor?.(binding.device_id) === true;
  }

  bindingForConversation(conversationId) {
    if (!conversationId) return null;
    return this.workspaceStore.getByConversation(conversationId);
  }

  runtimeFor(binding) {
    if (!binding || binding.state !== "active") throw new RemoteWorkspaceServiceError("WORKSPACE_NOT_ACTIVE");
    const existing = this.sessions.get(binding.workspace_id);
    if (existing) return existing;

    const baseDir = this.spacesDir || this.runtimeDir;
    const spaceDir = path.join(baseDir, binding.workspace_id);
    const workDir = path.join(spaceDir, "work");
    const mcpDir = path.join(spaceDir, ".witt-mcp");
    fs.mkdirSync(spaceDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(mcpDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(spaceDir, ".witt-space.json"), JSON.stringify({
      workspace_id: binding.workspace_id,
      conversation_id: binding.conversation_id,
      display_path: binding.display_path,
      created_at: new Date().toISOString(),
    }, null, 2) + "\n", { mode: 0o600 });

    const capabilities = binding.device_id.startsWith("assist-") ? (this.capabilitiesFor(binding.device_id) || []) : null;
    const capabilityEnv = capabilities ? { WITT_REMOTE_WORKSPACE_CAPABILITIES: JSON.stringify(capabilities) } : {};

    const secret = crypto.randomBytes(32).toString("base64url");
    const credentialFile = path.join(mcpDir, "mcp-session-token");
    fs.writeFileSync(credentialFile, `${secret}\n`, { mode: 0o600 });

    const mcpServerDef = {
      command: process.execPath,
      args: [this.mcpProgram],
      env: {
        WITT_REMOTE_WORKSPACE_MCP_ENABLED: "1",
        WITT_REMOTE_WORKSPACE_MCP_API: this.apiBase,
        WITT_REMOTE_WORKSPACE_CREDENTIAL_FILE: credentialFile,
        ...capabilityEnv,
      },
    };
    const mcpConfigJson = JSON.stringify({ mcpServers: { witt_remote_workspace: mcpServerDef } }, null, 2) + "\n";
    const mcpConfigPath = path.join(mcpDir, "mcp_config.json");
    fs.writeFileSync(mcpConfigPath, mcpConfigJson, { mode: 0o600 });
    const geminiConfigDir = path.join(mcpDir, ".gemini", "config");
    fs.mkdirSync(geminiConfigDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(geminiConfigDir, "mcp_config.json"), mcpConfigJson, { mode: 0o600 });

    const codexConfigOverrides = [
      `mcp_servers.witt_remote_workspace.command=${JSON.stringify(process.execPath)}`,
      `mcp_servers.witt_remote_workspace.args=${JSON.stringify([this.mcpProgram])}`,
      "mcp_servers.witt_remote_workspace.enabled=true",
      'mcp_servers.witt_remote_workspace.env.WITT_REMOTE_WORKSPACE_MCP_ENABLED="1"',
      `mcp_servers.witt_remote_workspace.env.WITT_REMOTE_WORKSPACE_MCP_API=${JSON.stringify(this.apiBase)}`,
      `mcp_servers.witt_remote_workspace.env.WITT_REMOTE_WORKSPACE_CREDENTIAL_FILE=${JSON.stringify(credentialFile)}`,
      ...(capabilities ? [`mcp_servers.witt_remote_workspace.env.WITT_REMOTE_WORKSPACE_CAPABILITIES=${JSON.stringify(JSON.stringify(capabilities))}`] : []),
    ];

    const value = Object.freeze({
      workspaceId: binding.workspace_id,
      assistSession: binding.device_id.startsWith("assist-"),
      capabilities,
      spaceDir,
      mcpDir,
      cwd: workDir,
      secret,
      credentialFile,
      mcpConfigPath,
      apiBase: this.apiBase,
      codexConfigOverrides,
    });
    this.sessions.set(binding.workspace_id, value);
    return value;
  }

  destroySpace(workspaceId) {
    if (!workspaceId) return { workspaceId, cleaned: false };
    this.sessions.delete(workspaceId);
    for (const [approvalId, waiter] of [...this.waiters.entries()]) {
      if (waiter.binding?.workspace_id !== workspaceId) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(approvalId);
      try { this.approvals.reject(approvalId, workspaceId); } catch {}
      waiter.reject(new RemoteWorkspaceServiceError("WORKSPACE_NOT_ACTIVE"));
    }
    for (const rootDir of this.spaceDirectories()) {
      try {
        fs.rmSync(path.join(rootDir, workspaceId), { recursive: true, force: true });
      } catch {}
    }
    return { workspaceId, cleaned: true };
  }

  invalidate(workspaceId) {
    return this.destroySpace(workspaceId);
  }

  authenticate(secret) {
    for (const [workspaceId, session] of this.sessions) {
      if (safeEqual(secret, session.secret)) {
        const binding = this.workspaceStore.get(workspaceId);
        if (binding?.state === "active") return binding;
      }
    }
    return null;
  }

  handleInternalMcp(req, res, url, readJsonBody, sendJson) {
    if (url.pathname !== "/internal/remote-workspaces/mcp" || req.method !== "POST") return false;
    if (!isLoopbackAddress(req.socket?.remoteAddress)) {
      sendJson(res, 403, { error: "LOOPBACK_REQUIRED" });
      return true;
    }
    const authHeader = String(req.headers.authorization || "");
    const secret = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    if (!secret) {
      sendJson(res, 401, { error: "WORKSPACE_SESSION_INVALID" });
      return true;
    }
    readJsonBody(req, 1024 * 1024, async (error, body) => {
      if (error || !body || typeof body !== "object") {
        sendJson(res, 400, { error: error?.message || "INVALID_ARGUMENTS" });
        return;
      }
      try {
        const result = await this.executeMcp(secret, body.operation, body.args || {});
        sendJson(res, 200, { result });
      } catch (err) {
        const code = err?.code || "WORKSPACE_ERROR";
        const status = code === "WORKSPACE_SESSION_INVALID" ? 401 : code === "WORKSPACE_NOT_ACTIVE" ? 403 : 400;
        sendJson(res, status, { error: code });
      }
    });
    return true;
  }

  async executeMcp(secret, operation, args, options) {
    const binding = this.authenticate(secret);
    if (!binding) throw new RemoteWorkspaceServiceError("WORKSPACE_SESSION_INVALID");
    return this.executeBinding(binding.workspace_id, operation, args, options);
  }

  async executeBinding(workspaceId, operation, args, { signal } = {}) {
    const binding = this.workspaceStore.get(workspaceId);
    if (!binding || binding.state !== "active") throw new RemoteWorkspaceServiceError("WORKSPACE_NOT_ACTIVE");
    const first = await this.dispatcher.execute({ workspace_id: binding.workspace_id, operation, args, signal });
    if (first.status !== "approval_required") return first.result;
    await this.waitForApproval(binding, first.approval);
    const completed = await this.dispatcher.execute({
      workspace_id: binding.workspace_id, operation, args, approval_id: first.approval.id, signal,
    });
    return completed.result;
  }

  waitForApproval(binding, approval) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(approval.id);
        try { this.approvals.reject(approval.id, binding.workspace_id); } catch {}
        reject(new RemoteWorkspaceServiceError("APPROVAL_EXPIRED"));
      }, Math.max(1, approval.expires_at - Date.now()));
      timer.unref?.();
      this.waiters.set(approval.id, { binding, resolve, reject, timer });
      try {
        this.notifyApproval(binding, approval);
      } catch (error) {
        clearTimeout(timer);
        this.waiters.delete(approval.id);
        try { this.approvals.reject(approval.id, binding.workspace_id); } catch {}
        reject(error);
      }
    });
  }

  resolveApproval(workspaceId, approvalId, accepted) {
    const waiter = this.waiters.get(approvalId);
    if (!waiter || waiter.binding.workspace_id !== workspaceId) throw new RemoteWorkspaceServiceError("APPROVAL_NOT_FOUND");
    clearTimeout(waiter.timer);
    this.waiters.delete(approvalId);
    if (accepted) {
      this.approvals.accept(approvalId, workspaceId);
      waiter.resolve();
    } else {
      this.approvals.reject(approvalId, workspaceId);
      waiter.reject(new RemoteWorkspaceServiceError("APPROVAL_REJECTED"));
    }
  }

  close() {
    this.closed = true;
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new RemoteWorkspaceServiceError("SERVER_SHUTDOWN"));
    }
    this.waiters.clear();
    for (const workspaceId of [...this.sessions.keys()]) this.invalidate(workspaceId);
  }
}

module.exports = { RemoteWorkspaceService, RemoteWorkspaceServiceError };
