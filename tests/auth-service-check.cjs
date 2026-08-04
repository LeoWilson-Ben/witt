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
const store = service.read();
store.devices[0].disabled = true;
service.write(store);
if (service.authenticate(`Bearer ${activation.token}`)) throw new Error("disabled device remained authorized");
console.log("auth service checks passed");
