"use strict";
const assert = require("node:assert/strict");
const { workspaceOverview } = require("./workspace-overview");
(async () => {
  const first = await workspaceOverview({ workDir: "/data/xuanyu-build-console", dataDir: "/nonexistent-test-user" });
  assert.equal(first.connections[0].status, "unconfigured");
  assert.equal(first.servers.length, 2);
  assert.equal(first.services.length, 3);
  assert.equal(first, await workspaceOverview({ workDir: "/data/xuanyu-build-console", dataDir: "/nonexistent-test-user" }));
  const other = await workspaceOverview({ workDir: "/tmp", dataDir: "/different-test-user" });
  assert.equal(other.connections.length, 0);
  assert.equal(other.services.length, 2);
  assert.ok(!JSON.stringify(first).includes(".p8"));
  console.log("workspace overview tests passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
