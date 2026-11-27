// All requests and user state are simulated; this test never contacts a server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const web = path.resolve(process.env.WEB_ROOT || path.join(__dirname, '../web'));
const conversationId = '00000000-0000-4000-8000-000000000001';

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome', args: ['--no-sandbox'] });
  try {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
      const page = await browser.newPage({ viewport });
      page.setDefaultTimeout(5000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => {
        window.DropVaultAndroid = new Proxy({
          getCacheScope: () => 'focus-test', hasBundledLumoraMedia: () => false,
        }, { get: (target, key) => target[key] || (() => {}) });
      });
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.hostname !== 'witt.test') return route.abort();
        const name = decodeURIComponent(url.pathname).replace(/^\/vault\//, '') || 'index.html';
        const file = path.resolve(web, name);
        if (!file.startsWith(web + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          return route.fulfill({ status: 404, body: '' });
        }
        const types = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html' };
        return route.fulfill({ path: file, contentType: types[path.extname(file)] });
      });
      await page.goto('https://witt.test/vault/index.html');
      await page.evaluate(() => {
        window.DropVault.nativeReady({ nativeLaunch: true, workspaceFeatures: true, version: '3.2.5' });
        window.DropVault.onConversations(JSON.stringify({ conversations: [] }));
      });
      const input = page.locator('#messageInput');
      await input.fill('帮我检查');
      await page.locator('#composerGhostMirror .ghost-suffix').waitFor({ state: 'visible' });
      assert.ok((await page.locator('#composerGhostMirror .ghost-suffix').textContent()).includes('代码'));
      await input.press('Tab');
      assert.equal(await input.inputValue(), '帮我检查一下这段代码有没有隐藏的 Bug 或性能问题');
      await input.fill('帮我检查');
      await input.press('Escape');
      assert.equal(await page.locator('#composerGhostMirror').textContent(), '');
      await input.fill('/sea');
      await page.locator('#composerGhostMirror .ghost-suffix').waitFor({ state: 'visible' });
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log('PASS: autocomplete preview, Tab acceptance, Escape dismissal, slash preview on desktop and mobile');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
