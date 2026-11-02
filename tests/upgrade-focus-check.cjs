// All requests and user state are simulated; this test never contacts a server.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const web = path.resolve(process.env.WEB_ROOT || path.join(__dirname, '../web'));
const conversationId = '00000000-0000-4000-8000-000000000001';

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
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
      await page.evaluate(id => {
        window.DropVault.nativeReady({ nativeLaunch: true, workspaceFeatures: true, workspaceOperations: true, versionName: 'test', cacheScope: 'focus-test' });
        window.DropVault.onAuthStatus(JSON.stringify({ initialized: true, authenticated: true, principal: { admin: false, label: '测试用户' } }));
      });
      await page.waitForTimeout(100); // let the empty simulated cache hydrate first
      await page.evaluate(id => {
        window.DropVault.onConversationCreated(JSON.stringify({ conversation: {
          id, title: '焦点测试', model: 'gpt-6.1-sol', messages: [], workDir: '',
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        } }));
        window.DropVault.onConversations(JSON.stringify({ conversations: [{ id, title: '焦点测试', busy: false }] }));
        window.__writes = [];
        window.WittUI.updateMetadata = (id, changes) => { window.__writes.push({ id, changes }); return true; };
      }, conversationId);
      await page.locator('#bootScreen').waitFor({ state: 'hidden' });
      // Use a visible, stable launcher to exercise the exported menu API independently
      // of the responsive drawer. All subsequent input uses real clicks/keys.
      await page.evaluate(id => {
        const trigger = document.createElement('button');
        trigger.id = 'focusTestTrigger'; trigger.textContent = '测试会话操作';
        trigger.style.cssText = 'position:fixed;top:2px;left:2px;z-index:100';
        trigger.onclick = () => window.WittUpgrades.openConversationMenu(id);
        document.body.append(trigger);
      }, conversationId);
      const trigger = page.locator('#focusTestTrigger');
      const rename = page.locator('#conversationRenameSheet');
      const input = page.locator('#conversationRenameInput');
      for (const exit of ['Escape', 'cancel', 'close', 'save']) {
        await trigger.click();
        assert.equal(await page.locator('#conversationActions').evaluate(n => n.hidden), false, JSON.stringify(await page.evaluate(() => window.WittUI.conversations())));
        await page.locator('#conversationRenameButton').click();
        assert.equal(await input.evaluate(node => node === document.activeElement), true);
        await input.fill('新的名称');
        if (exit === 'Escape') await page.keyboard.press('Escape');
        else if (exit === 'cancel') await rename.getByRole('button', { name: '取消', exact: true }).click();
        else if (exit === 'close') await rename.getByRole('button', { name: '关闭', exact: true }).click();
        else await rename.getByRole('button', { name: '保存', exact: true }).click();
        assert.equal(await rename.evaluate(node => node.hidden), true);
        assert.equal(await trigger.evaluate(node => node === document.activeElement), true, `focus returns after ${exit} at ${viewport.width}`);
      }
      assert.deepEqual(await page.evaluate(() => window.__writes), [{ id: conversationId, changes: { title: '新的名称' } }]);
      // Reopening must capture the new external trigger, not a previous launcher.
      await page.evaluate(id => {
        const other = document.querySelector('#focusTestTrigger').cloneNode(true);
        other.id = 'otherFocusTrigger'; other.style.left = '200px';
        other.onclick = () => window.WittUpgrades.openConversationMenu(id);
        document.body.append(other);
      }, conversationId);
      await page.locator('#otherFocusTrigger').click();
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#otherFocusTrigger').evaluate(node => node === document.activeElement), true);
      await trigger.click();
      await page.locator('#conversationRenameButton').click();
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Tab');
      assert.equal(await input.evaluate(node => node === document.activeElement), true);
      // Preserve the existing keyboard viewport adaptation and focus trap.
      await page.evaluate(() => {
        Object.defineProperty(window.visualViewport, 'height', { configurable: true, get: () => 250 });
        window.visualViewport.dispatchEvent(new Event('resize'));
      });
      await page.waitForTimeout(100);
      const bounds = await rename.locator('button[type=submit]').boundingBox();
      assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 251, 'save stays above keyboard');
      if (process.env.SCREENSHOT_DIR) {
        fs.mkdirSync(process.env.SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.SCREENSHOT_DIR, `rename-${viewport.width}.png`) });
      }
      await page.keyboard.press('Escape');
      assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
      assert.deepEqual(errors, []);
      console.log(`PASS ${viewport.width}x${viewport.height}: rename exits, save, reopen, Tab, keyboard viewport`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
