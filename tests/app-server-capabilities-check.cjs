"use strict";

const assert = require("node:assert/strict");
const { AppServerClient } = require("../backend/app-server-client");

(async () => {
  const client = new AppServerClient({
    codexBin: "/home/ubuntu/.local/bin/codex",
    cwd: "/home/ubuntu/Documents/Codex/2026-07-20-skill/upload-app",
    home: "/home/ubuntu",
    codexHome: "/home/ubuntu/.codex",
  });
  try {
    await client.start();
    const models = await client.request("model/list", { limit: 100, includeHidden: false });
    assert.ok(Array.isArray(models.data) && models.data.length > 0, "model/list returned no models");
    const skills = await client.request("skills/list", {
      cwds: ["/home/ubuntu/Documents/Codex/2026-07-20-skill/upload-app"],
      forceReload: false,
    });
    assert.ok(Array.isArray(skills.data), "skills/list response shape changed");
    const mcp = await client.request("mcpServerStatus/list", {
      limit: 100, detail: "toolsAndAuthOnly",
    });
    assert.ok(Array.isArray(mcp.data), "mcpServerStatus/list response shape changed");
    const collaboration = await client.request("collaborationMode/list", {});
    assert.ok(Array.isArray(collaboration.data || collaboration.collaborationModes),
      "collaborationMode/list response shape changed");
    const features = await client.request("experimentalFeature/list", { limit: 100 });
    assert.ok(Array.isArray(features.data), "experimentalFeature/list response shape changed");
    process.stdout.write(`app-server capabilities passed: ${models.data.length} models\n`);
  } finally {
    client.close();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
