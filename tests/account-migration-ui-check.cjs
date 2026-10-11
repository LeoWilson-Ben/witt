"use strict";
const fs = require("node:fs"), http = require("node:http"), assert = require("node:assert/strict");
const { chromium } = require("playwright");
const path = require("node:path");
const webRoot = path.resolve(__dirname, "../web");
const server = http.createServer((req, res) => {
  const name = new URL(req.url, "http://local").pathname.replace(/^\/vault\//, "");
  if (name.includes("..")) { res.writeHead(400); return res.end(); }
  const file = path.join(webRoot, name);
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.setHeader("Content-Type", name.endsWith(".js") ? "application/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".json") ? "application/json" : "text/html");
  res.end(fs.readFileSync(file));
});
(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch({ headless: true });
  try {
    for (const scenario of ["legacy", "osaka", "open", "administrator"]) {
      const page = await browser.newPage({ viewport: { width: 393, height: 852 } });
      const errors = []; page.on("pageerror", (e) => errors.push(e.message));
      await page.addInitScript(() => { window.nativeCalls = []; window.WittNative = { postMessage(s) { window.nativeCalls.push(JSON.parse(s)); } }; });
      await page.goto(`http://127.0.0.1:${server.address().port}/vault/index.html`);
      await page.waitForFunction(() => window.WittUI);
      await page.evaluate((scenario) => {
        DropVault.nativeReady({ version: scenario === "legacy" ? "2.2.20" : "2.2.27", openAccess: scenario === "open" });
        DropVault.onAuthStatus(JSON.stringify({ authenticated: scenario !== "osaka", migrationSupported: false, principal: { admin: scenario === "administrator", deviceId: "fixture-admin" } }));
      }, scenario);
      const retired = await page.evaluate(() => ({
        source: [...document.querySelectorAll("button")].some((b) => b.textContent === "迁移到 Witt 大阪 ›"),
        receive: [...document.querySelectorAll("button")].some((b) => b.textContent === "从旧 Witt 迁移"),
        recovery: Boolean(document.querySelector(".migration-recovery")),
        dialog: Boolean(document.querySelector(".witt-migration-dialog")),
      }));
      assert.deepEqual(retired, { source: false, receive: false, recovery: false, dialog: false });
      assert.deepEqual(errors, [], `${scenario} UI errors`);
      await page.close();
    }
    console.log("legacy, Osaka, open edition, administrator migration retirement UI checks passed");
  } finally { await browser.close(); server.close(); }
})().catch((e) => { console.error(e.message); server.close(); process.exitCode = 1; });
