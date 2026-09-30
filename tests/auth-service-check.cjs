"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AuthService } = require("../backend/auth-service");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "witt-auth-test-"));
const service = new AuthService({ dir: directory, sendJson() {}, readJsonBody() {} });
const invite = service.initialize("correct horse battery staple", "owner");
if (!service.bootstrapEligible(true)) throw new Error("bootstrap should be available before first admin device");
if (service.bootstrapEligible(false)) throw new Error("bootstrap accepted a non-legacy client");
const activation = service.activate({
  inviteCode: invite.code,
  deviceId: "11111111-1111-4111-8111-111111111111",
  deviceName: "test device",
});
if (!service.authenticate(`Bearer ${activation.token}`)?.admin) throw new Error("device was not activated");
if (service.bootstrapEligible(true)) throw new Error("bootstrap remained available after activation");
const browserInvite = service.createInvite({ label: "browser", maxDevices: 1 });
let browserResponse = null;
const browserService = new AuthService({
  dir: directory,
  sendJson(_res, status, body, headers) { browserResponse = { status, body, headers }; },
  readJsonBody(_req, _limit, callback) {
    callback(null, {
      inviteCode: browserInvite.code,
      deviceId: "22222222-2222-4222-8222-222222222222",
      deviceName: "test browser",
    });
  },
});
browserService.handle(
  { method: "POST", headers: { "x-witt-client": "browser" } },
  {}, { pathname: "/auth/activate" }, null);
if (browserResponse?.status !== 201 || browserResponse.body.token) {
  throw new Error("browser activation exposed a token");
}
const cookie = browserResponse.headers?.["Set-Cookie"] || "";
if (!cookie.includes("HttpOnly") || !cookie.includes("Secure") || !cookie.includes("SameSite=Strict")) {
  throw new Error("browser activation did not set a secure session cookie");
}
const browserToken = decodeURIComponent(cookie.match(/^witt_session=([^;]+)/)?.[1] || "");
if (!browserService.authenticateToken(browserToken)) throw new Error("browser session cookie was not valid");
const store = service.read();
store.devices[0].disabled = true;
service.write(store);
if (service.authenticate(`Bearer ${activation.token}`)) throw new Error("disabled device remained authorized");
console.log("auth service checks passed");
