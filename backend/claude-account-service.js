"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const TTL = 15 * 60_000;

function authorizationUrl(text) {
  for (const candidate of text.match(/https:\/\/[^\s\x1b<>"']+/g) || []) {
    try {
      const url = new URL(candidate);
      if (["claude.com", "claude.ai", "console.anthropic.com", "platform.claude.com"].includes(url.hostname) &&
          ["/cai/oauth/authorize", "/oauth/authorize"].includes(url.pathname) &&
          url.searchParams.get("state") && url.searchParams.get("code_challenge")) return url.href;
    } catch {}
  }
  return "";
}

class ClaudeAccountService {
  constructor(options = {}) {
    this.bin = options.bin || "/home/ubuntu/.claude-cli/node_modules/.bin/claude";
    this.root = options.root || "/home/ubuntu/.claude-witt";
    this.spawn = options.spawn || spawn;
    this.sendJson = options.sendJson;
    this.readJsonBody = options.readJsonBody;
    this.isAuthorized = options.isAuthorized || (() => false);
    this.tickets = new Map();
    this.logins = new Map();
    this.cached = new Map();
  }
  owner(principal) {
    if (!principal?.admin || !/^(?:legacy|[a-f0-9-]{36})$/.test(principal.userId || "")) {
      throw new Error("仅管理员可连接自己的 Claude 账号");
    }
    return principal.userId;
  }
  env(owner) {
    if (!/^(?:legacy|[a-f0-9-]{36})$/.test(owner)) throw new Error("账号无效");
    const dir = path.join(this.root, owner);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    const env = { HOME: "/home/ubuntu", PATH: process.env.PATH, LANG: "C.UTF-8",
      CLAUDE_CONFIG_DIR: dir, BROWSER: "/bin/false", DISABLE_AUTOUPDATER: "1" };
    for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"]) {
      if (process.env[name]) env[name] = process.env[name];
    }
    return env;
  }
  async account(owner, fresh = false) {
    const cached = this.cached.get(owner);
    if (!fresh && cached && Date.now() - cached.at < 10_000) return cached.value;
    const value = await new Promise((resolve) => {
      let output = "", done = false;
      const child = this.spawn(this.bin, ["auth", "status", "--json"], {
        cwd: "/home/ubuntu", env: this.env(owner), stdio: ["ignore", "pipe", "pipe"],
      });
      const finish = () => {
        if (done) return;
        done = true; clearTimeout(timer);
        let data = {};
        try { data = JSON.parse(output); } catch {}
        resolve({ authenticated: data.loggedIn === true,
          email: typeof data.email === "string" ? data.email.slice(0, 254) : "",
          planType: typeof data.subscriptionType === "string" ? data.subscriptionType.slice(0, 80) : "" });
      };
      const timer = setTimeout(() => { child.kill(); finish(); }, 10_000);
      child.stdout.on("data", (data) => {
        if (output.length < 65536) output += data.toString();
      });
      child.stderr.resume(); // Never log CLI output or credentials.
      child.on("error", finish);
      child.on("close", finish);
    });
    this.cached.set(owner, { at: Date.now(), value });
    return value;
  }
  async card(principal) {
    const owner = this.owner(principal);
    for (const [key, value] of this.tickets) {
      if (value.expiresAt <= Date.now()) this.tickets.delete(key);
    }
    let entry = [...this.tickets.entries()].find(([, value]) =>
      value.owner === owner && value.deviceId === principal.deviceId && value.expiresAt > Date.now() + 60_000);
    if (!entry) {
      const token = crypto.randomBytes(32).toString("base64url");
      const value = { owner, deviceId: principal.deviceId, expiresAt: Date.now() + TTL };
      this.tickets.set(token, value);
      entry = [token, value];
    }
    const account = await this.account(owner);
    return { id: "claude", label: "Claude", provider: "claude", authenticated: account.authenticated,
      account, loginPending: Boolean(this.logins.get(owner) && !this.logins.get(owner).finished),
      loginUrl: `/vault-api/claude/login#${entry[0]}` };
  }
  async start(owner) {
    const previous = this.logins.get(owner);
    if (previous && !previous.finished) return this.status(owner);
    const child = this.spawn(this.bin, ["auth", "login"], {
      cwd: "/home/ubuntu", env: this.env(owner), stdio: ["pipe", "pipe", "pipe"],
    });
    const login = { child, verificationUrl: "", state: "starting", finished: false,
      expiresAt: Date.now() + TTL, buffer: "", codeSubmitted: false };
    this.logins.set(owner, login);
    const finish = (state) => {
      if (login.finished) return;
      login.finished = true; login.state = state; login.buffer = "";
      login.verificationUrl = ""; clearTimeout(login.timer); this.cached.delete(owner);
    };
    login.timer = setTimeout(() => { finish("expired"); child.kill(); }, TTL);
    login.timer.unref?.();
    const onData = (data) => {
      if (login.finished) return;
      login.buffer = (login.buffer + data.toString()).slice(-32768);
      const end = login.buffer.lastIndexOf("\n");
      if (end < 0) return;
      const completeLines = login.buffer.slice(0, end + 1);
      login.buffer = login.buffer.slice(end + 1);
      const url = authorizationUrl(completeLines);
      if (url) { login.verificationUrl = url; login.state = "pending"; }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.stdin.on("error", () => finish("failed"));
    child.on("error", () => finish("failed"));
    child.on("close", (code) => finish(code === 0 ? "completed" : "failed"));
    // URL generation is asynchronous; the browser polls for it.
    return { status: "starting", authenticated: false };
  }
  async status(owner) {
    const login = this.logins.get(owner);
    if (login && !login.finished) return { status: login.state,
      authenticated: false, verificationUrl: login.verificationUrl, expiresAt: login.expiresAt };
    const account = await this.account(owner, Boolean(login));
    if (login && ["failed", "expired"].includes(login.state)) {
      return { status: login.state, ...account };
    }
    if (account.authenticated) return { status: "authenticated", ...account };
    return { status: login?.state === "completed" ? "failed" : (login?.state || "signedOut"), ...account };
  }
  complete(owner, code) {
    const login = this.logins.get(owner);
    if (!login || login.finished || !login.verificationUrl || login.codeSubmitted) {
      throw new Error("登录流程已结束，请重新发起登录");
    }
    if (typeof code !== "string" || !/^[A-Za-z0-9_#.-]{8,4096}$/.test(code.trim())) {
      throw new Error("请粘贴官方页面显示的完整授权码");
    }
    login.codeSubmitted = true;
    login.state = "verifying";
    login.child.stdin.write(code.trim() + "\n");
    return { status: "verifying" };
  }
  cancel(owner) {
    const login = this.logins.get(owner);
    if (login) {
      clearTimeout(login.timer); login.finished = true;
      login.buffer = ""; login.verificationUrl = ""; login.child.kill();
      this.logins.delete(owner);
    }
    return { status: "cancelled" };
  }
  handle(req, res, url) {
    if (url.pathname === "/claude/login" && req.method === "GET") {
      const html = fs.readFileSync(path.join(__dirname, "claude-login.html"), "utf8");
      const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] || "";
      const hash = crypto.createHash("sha256").update(script).digest("base64");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
        "Content-Security-Policy": `default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` });
      res.end(html); return true;
    }
    const match = url.pathname.match(/^\/claude\/login\/(status|start|complete|cancel)$/);
    if (!match) return false;
    const token = String(req.headers.authorization || "").replace(/^Bearer /, "");
    const ticket = this.tickets.get(token);
    if (!ticket || ticket.expiresAt <= Date.now() || !this.isAuthorized(ticket)) {
      this.sendJson(res, 401, { error: "登录入口已失效，请返回账号列表重新打开" }); return true;
    }
    const action = match[1];
    if (req.method !== (action === "status" ? "GET" : "POST")) {
      this.sendJson(res, 405, { error: "请求方式不支持" }); return true;
    }
    const finish = async (body = {}) => {
      try {
        const result = action === "complete" ? this.complete(ticket.owner, body.code)
          : action === "cancel" ? this.cancel(ticket.owner)
          : await this[action](ticket.owner);
        this.sendJson(res, 200, result);
      } catch {
        this.sendJson(res, 400, { error: "无法完成此操作，请确认授权码或重新发起登录" });
      }
    };
    if (action === "complete") this.readJsonBody(req, 8192, (error, body) => {
      if (error) this.sendJson(res, 400, { error: "授权码格式无效" });
      else void finish(body);
    });
    else void finish();
    return true;
  }
}
module.exports = { ClaudeAccountService, authorizationUrl };
