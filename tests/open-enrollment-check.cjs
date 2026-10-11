"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { AuthService } = require("../backend/auth-service");
const { createOpenEnrollmentServer } = require("../backend/open-enrollment-server");

test("open edition creates isolated, unrestricted non-admin sessions using existing auth APIs", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "witt-open-test-"));
  const sendJson = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body));
  };
  const auth = new AuthService({ dir, sendJson, readJsonBody(req, _limit, cb) {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => { try { cb(null, JSON.parse(raw)); } catch (error) { cb(error); } });
  } });
  const adminInvite = auth.initialize("test owner password long enough");
  const admin = auth.activate({ inviteCode: adminInvite.code, deviceId: crypto.randomUUID() });
  let failPolicy = false;
  const upstream = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    const principal = auth.authenticate(req.headers.authorization);
    if (failPolicy && url.pathname.endsWith("/policy")) {
      sendJson(res, 503, { error: "test policy failure" }); return;
    }
    if (auth.handle(req, res, url, principal)) return;
    sendJson(res, principal ? 403 : 401, { error: "denied" });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  let enabled = true;
  const apiBase = `http://127.0.0.1:${upstream.address().port}/`;
  const server = createOpenEnrollmentServer({ apiBase, adminToken: () => admin.token, enabled: () => enabled });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => upstream.close(r))]);
    auth.store.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const enroll = (body) => fetch(`${base}/auth/open-enroll`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const id = crypto.randomUUID();
  const first = await enroll({ deviceId: id, deviceName: "first", admin: true, userId: admin.device.userId });
  assert.equal(first.status, 201);
  const a = await first.json();
  const principal = auth.authenticateToken(a.token);
  assert.equal(principal.admin, false);
  assert.equal(principal.unrestrictedModels, true);
  assert.deepEqual(principal.codexProfiles, ["default", "xuanyu", "account4", "account5"]);
  assert.notEqual(principal.userId, admin.device.userId);
  assert.equal(a.inviteCode, undefined);
  assert.equal(a.principal.tokenHash, undefined);

  const second = await enroll({ deviceId: crypto.randomUUID() });
  assert.equal(second.status, 201);
  const b = await second.json();
  assert.notEqual(a.principal.userId, b.principal.userId);
  assert.notEqual(a.token, b.token);
  const forbidden = await fetch(`${apiBase}admin/invites`, { headers: { Authorization: `Bearer ${a.token}` } });
  assert.equal(forbidden.status, 403);
  assert.equal((await enroll({ deviceId: id })).status, 409);
  assert.ok(auth.authenticateToken(a.token), "a duplicate request must not rotate an existing credential");
  assert.equal((await enroll({ deviceId: "invalid" })).status, 400);
  assert.equal((await fetch(`${base}/auth/open-enroll`, { method: "POST", body: "null" })).status, 400);
  assert.equal((await fetch(`${base}/admin/invites`)).status, 404);
  enabled = false;
  assert.equal((await enroll({ deviceId: crypto.randomUUID() })).status, 503);
  enabled = true;
  const deniedDevice = crypto.randomUUID();
  failPolicy = true;
  const failed = await enroll({ deviceId: deniedDevice });
  assert.equal(failed.status, 503);
  assert.equal(auth.read().devices.find((d) => d.id === deniedDevice).disabled, true);
  assert.equal((await failed.json()).token, undefined);
  failPolicy = false;

  const duplicate = crypto.randomUUID();
  const concurrent = await Promise.all([enroll({ deviceId: duplicate }), enroll({ deviceId: duplicate })]);
  assert.deepEqual(concurrent.map((r) => r.status).sort(), [201, 409]);
  assert.equal(auth.read().devices.filter((d) => d.id === duplicate).length, 1);

  const limited = createOpenEnrollmentServer({ apiBase, adminToken: () => admin.token, enabled: () => true, maxRegistrationsPerHour: 1 });
  await new Promise((r) => limited.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${limited.address().port}/auth/open-enroll`;
  await fetch(url, { method: "POST", body: JSON.stringify({ deviceId: crypto.randomUUID() }) });
  assert.equal((await fetch(url, { method: "POST", body: JSON.stringify({ deviceId: crypto.randomUUID() }) })).status, 429);
  await new Promise((r) => limited.close(r));
});
