"use strict";
const assert = require("node:assert/strict");
const { workspaceOverview, probeServerCluster } = require("./workspace-overview");
(async () => {
  const first = await workspaceOverview({ workDir: "/data/xuanyu-build-console", dataDir: "/nonexistent-test-user" });
  assert.equal(first.connections[0].status, "unconfigured");
  assert.equal(first.servers.length, 2);
  assert.equal(first.services.length, 3);
  assert.equal(first.serverCluster, undefined);
  assert.equal(first, await workspaceOverview({ workDir: "/data/xuanyu-build-console", dataDir: "/nonexistent-test-user" }));
  const other = await workspaceOverview({ workDir: "/tmp", dataDir: "/different-test-user" });
  assert.equal(other.connections.length, 0);
  assert.equal(other.services.length, 2);
  assert.ok(!JSON.stringify(first).includes(".p8"));

  const cluster = await probeServerCluster({
    unitProbe: async (unit) => (unit === "xray.service" ? "inactive" : "active"),
    tcpProbe: async (host, port) => {
      if (host === "34.80.144.220") return { ok: true, latencyMs: port === 443 ? 35 : 40 };
      return { ok: false, latencyMs: null };
    },
    localMetrics: () => ({ cpuCount: 2, load1m: 0.25, memTotalGb: 8, memUsedGb: 2.4, memPercent: 30, uptimeSec: 7200 }),
  });
  assert.equal(cluster.length, 3);
  assert.equal(cluster[0].status, "degraded");
  assert.equal(cluster[0].metrics.memPercent, 30);
  assert.equal(cluster[1].status, "online");
  assert.equal(cluster[1].latencyMs, 35);
  assert.equal(cluster[2].status, "offline");
  assert.equal(cluster[2].latencyMs, null);
  console.log("workspace overview tests passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
