import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
const html = readFileSync(new URL('../backend/claude-login.html', import.meta.url), 'utf8');
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [360, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    let state = 'signedOut', submitted = false;
    await page.route('https://witt.test/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/vault-api/claude/login') return route.fulfill({contentType:'text/html',body:html});
      assert.equal(route.request().headers().authorization, `Bearer ${'A'.repeat(43)}`);
      assert.equal(url.search, '');
      if (url.pathname.endsWith('/start')) state = 'pending';
      if (url.pathname.endsWith('/complete')) {
        const body = route.request().postDataJSON(); assert.equal(body.code, 'dummy-authorization-code');
        submitted = true; state = 'authenticated';
      }
      if (url.pathname.endsWith('/cancel')) state = 'cancelled';
      await route.fulfill({json: {status:state,authenticated:state==='authenticated',email:state==='authenticated'?'owner@example.test':'',verificationUrl:state==='pending'?'https://claude.com/cai/oauth/authorize?state=dummy&code_challenge=dummy':''}});
    });
    await page.goto(`https://witt.test/vault-api/claude/login#${'A'.repeat(43)}`);
    await page.getByRole('button',{name:'开始登录'}).click();
    await page.locator('#official').waitFor({state:'visible'});
    assert.equal(new URL(page.url()).hash, '');
    await page.locator('#code').fill('dummy-authorization-code');
    await page.getByRole('button',{name:'完成授权'}).click();
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('已连接'));
    assert.equal(await page.locator('#code').inputValue(), '');
    assert.ok(submitted);
    await page.getByRole('button',{name:'登录其他账号'}).click();
    await page.locator('#cancel').click();
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('已取消'));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('Claude login UI passed on mobile and desktop: start, code submission, status, cancellation, no overflow.');
} finally { await browser.close(); }
