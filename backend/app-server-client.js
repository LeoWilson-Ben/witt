"use strict";

const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const readline = require("node:readline");

class AppServerClient extends EventEmitter {
  constructor(options) {
    super();
    this.codexBin = options.codexBin;
    this.cwd = options.cwd;
    this.home = options.home || "/home/ubuntu";
    this.codexHome = options.codexHome || "";
    this.configOverrides = Array.isArray(options.configOverrides)
      ? options.configOverrides.map(String) : [];
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = "";
    this.closed = false;
    this.startPromise = null;
    this.setMaxListeners(0);
  }

  async start() {
    if (this.child && !this.closed) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInternal();
    try { await this.startPromise; }
    finally { this.startPromise = null; }
  }

  async startInternal() {
    this.closed = false;
    const args = [
      ...this.configOverrides.flatMap((value) => ["-c", value]),
      "app-server", "--listen", "stdio://",
    ];
    this.child = spawn(this.codexBin, args, {
      cwd: this.cwd,
      env: {
        ...process.env,
        HOME: this.home,
        ...(this.codexHome ? { CODEX_HOME: this.codexHome } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-8000);
    });
    this.child.on("error", (error) => this.failAll(error));
    this.child.on("close", (code, signal) => {
      const detail = signal ? `signal ${signal}` : `code ${code}`;
      this.failAll(new Error(`Codex app-server stopped (${detail}): ${this.stderr.trim().slice(-1200)}`));
      this.emit("closed", { code, signal, stderr: this.stderr });
    });
    const lines = readline.createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.onLine(line));
    await this.request("initialize", {
      clientInfo: { name: "witt", title: "Witt", version: "2.2.9" },
      capabilities: {
        experimentalApi: true,
        mcpServerOpenaiFormElicitation: true,
      },
    });
    this.notify("initialized", {});
  }

  onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (Object.hasOwn(message, "id") && !message.method) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      if (message.error) {
        const error = new Error(message.error.message || "Codex app-server request failed");
        error.code = message.error.code;
        error.data = message.error.data;
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method && Object.hasOwn(message, "id")) {
      this.emit("request", message);
      return;
    }
    if (message.method) this.emit("notification", message.method, message.params || {});
  }

  write(message) {
    if (!this.child || this.closed || !this.child.stdin.writable) {
      throw new Error("Codex app-server is not available");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params, timeoutMs = 30_000) {
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      timeout.unref();
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      try {
        this.write({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params) {
    this.write({ method, params });
  }

  respond(id, result) {
    this.write({ id, result });
  }

  failAll(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  close() {
    if (!this.child || this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    const child = this.child;
    setTimeout(() => {
      if (!child.killed) child.kill("SIGTERM");
    }, 1200).unref();
  }
}

const sharedClients = new Map();

function sharedAppServer(options) {
  const key = `${options.codexHome || "default"}:${JSON.stringify(options.configOverrides || [])}`;
  const current = sharedClients.get(key);
  if (current && !current.closed) return current;
  const client = new AppServerClient(options);
  sharedClients.set(key, client);
  client.once("closed", () => {
    if (sharedClients.get(key) === client) sharedClients.delete(key);
  });
  return client;
}

module.exports = { AppServerClient, sharedAppServer };
