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
      assert.equal(await page.locator('#welcome').isVisible(), false);
      await page.evaluate(() => {
        window.DropVault.nativeReady({ nativeLaunch: true, workspaceFeatures: true, version: '3.2.5' });
      });
      await page.evaluate(id => window.DropVault.onConversations(JSON.stringify({ conversations: [{ id, title: '恢复测试' }] })), conversationId);
      await page.waitForTimeout(2400);
      assert.equal(await page.locator('#welcome').isVisible(), false, '正文加载期间不显示新对话首页');
      assert.equal(await page.locator('#bootScreen').evaluate(el => el.classList.contains('leaving')), false);
      await page.evaluate(id => window.DropVault.onConversation(JSON.stringify({ conversation: {
        id, title: '恢复测试', model: 'gpt-6.1-sol', messages: [{ id: 'msg1', role: 'user', text: '已有聊天记录' }],
      } })), conversationId);
      await page.locator('#bootScreen').waitFor({ state: 'detached' });
      assert.equal(await page.locator('#welcome').isVisible(), false);
      assert.ok((await page.locator('#messageList').textContent()).includes('已有聊天记录'));
      await page.evaluate(() => window.DropVault.onConversations(JSON.stringify({ conversations: [] })));
      assert.equal(await page.locator('#welcome').isVisible(), true, '空列表显示新对话首页');
      assert.deepEqual(errors, []);
      await page.close();
    }
    console.log('PASS: delayed history restore and empty history at desktop/mobile/landscape widths');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
