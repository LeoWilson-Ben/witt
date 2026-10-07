"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { ClaudeAccountService, authorizationUrl } = require("./claude-account-service");
const owner = "00000000-0000-4000-8000-000000000001";
const official = "https://claude.com/cai/oauth/authorize?state=test-state&code_challenge=test-challenge";
const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "witt-claude-test-"));
  const spawned = []; let loggedIn = false;
  const service = new ClaudeAccountService({ root,
    spawn(bin, args, options) {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
      child.kill = () => { child.killed = true; child.emit("close", 1); };
      spawned.push({ child, args, options });
      if (args[1] === "status") process.nextTick(() => {
        child.stdout.write(JSON.stringify({ loggedIn, email: loggedIn ? "owner@example.test" : "", subscriptionType: "max", secret: "must-not-leak" }));
        child.emit("close", loggedIn ? 0 : 1);
      });
      else process.nextTick(() => { child.stdout.write(official.slice(0, -3)); child.stdout.write(official.slice(-3) + "\n"); });
      return child;
    },
    isAuthorized: (ticket) => ticket.owner === owner,
    sendJson(res, status, body) { res.status = status; res.body = body; res.done?.(); },
    readJsonBody(req, limit, callback) { callback(null, req.body || {}); },
  });
  t.after(() => { for (const id of service.logins.keys()) service.cancel(id); fs.rmSync(root, { recursive: true, force: true }); });
  return { service, spawned, setLoggedIn(value) { loggedIn = value; } };
}

test('only official authorization URLs with PKCE are accepted', () => {
  assert.equal(authorizationUrl(official), official);
  assert.equal(authorizationUrl(official.replace('claude.com', 'claude.com.attacker.test')), '');
  assert.equal(authorizationUrl('https://claude.com/settings?state=x&code_challenge=y'), '');
});

test('account card requires admin and isolates configuration, with no credential leakage', async (t) => {
  const { service, spawned } = fixture(t);
  await assert.rejects(service.card({ userId: owner, admin: false }));
  const card = await service.card({ userId: owner, deviceId: 'device', admin: true });
  assert.equal(card.authenticated, false);
  assert.match(card.loginUrl, /^\/vault-api\/claude\/login#[A-Za-z0-9_-]{43}$/);
  assert.equal(spawned[0].options.env.CLAUDE_CONFIG_DIR, path.join(service.root, owner));
  assert.equal(spawned[0].options.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(JSON.stringify(card).includes('must-not-leak'), false);
  assert.equal(fs.statSync(path.join(service.root, owner)).mode & 0o777, 0o700);
  assert.throws(() => service.env('../../elsewhere'));
});

test('official flow accepts a code through stdin and confirms login using CLI status', async (t) => {
  const { service, spawned, setLoggedIn } = fixture(t);
  assert.equal((await service.start(owner)).status, 'starting'); await tick();
  assert.equal((await service.status(owner)).verificationUrl, official);
  let input = ''; spawned[0].child.stdin.on('data', (chunk) => { input += chunk; });
  assert.throws(() => service.complete(owner, 'bad\ncommand'));
  assert.equal(service.complete(owner, 'dummy-code-for-test').status, 'verifying');
  assert.equal(input, 'dummy-code-for-test\n');
  assert.throws(() => service.complete(owner, 'duplicate-code'));
  setLoggedIn(true); spawned[0].child.emit('close', 0);
  const status = await service.status(owner);
  assert.equal(status.status, 'authenticated');
  assert.equal(status.email, 'owner@example.test');
  assert.equal(status.verificationUrl, undefined);
});

test('repeated start reuses an active flow; cancel terminates only that login', async (t) => {
  const { service, spawned } = fixture(t);
  await service.start(owner); await tick(); await service.start(owner);
  assert.equal(spawned.length, 1);
  service.cancel(owner); assert.equal(spawned[0].child.killed, true);
  assert.equal(service.logins.size, 0);
});

test('expired or revoked portal tickets cannot start a login', async (t) => {
  const { service, spawned } = fixture(t);
  const card = await service.card({ userId: owner, deviceId: 'device', admin: true });
  const token = card.loginUrl.split('#')[1];
  const req = { method: 'POST', headers: { authorization: `Bearer ${token}` } };
  const url = new URL('http://localhost/claude/login/start');
  service.tickets.get(token).expiresAt = Date.now() - 1;
  const res = {}; service.handle(req, res, url); assert.equal(res.status, 401);
  service.tickets.get(token).expiresAt = Date.now() + 60000;
  service.isAuthorized = () => false;
  service.handle(req, res, url); assert.equal(res.status, 401);
  assert.equal(spawned.length, 1);
});

test('portal has no third party resources and protects against framing and referrer leaks', (t) => {
  const { service } = fixture(t); let headers, body;
  const res = { writeHead(status, value) { assert.equal(status, 200); headers = value; }, end(value) { body = value; } };
  service.handle({method:'GET'}, res, new URL('http://localhost/claude/login'));
  assert.equal(headers['Referrer-Policy'], 'no-referrer');
  assert.match(headers['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.match(headers['Content-Security-Policy'], /script-src 'sha256-/);
  assert.ok(body.includes('history.replaceState'));
  assert.ok(body.includes('type="password"'));
});
