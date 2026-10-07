import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chromium} from 'playwright';
const html=readFileSync(new URL('../web/index.html',import.meta.url),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
const browser=await chromium.launch({headless:true});
try {
 for(const entry of ['app.js','app-workspace-20260916-r3.js']) {
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://witt.test/**',r=>r.fulfill({contentType:'text/html',body:html}));
  await page.goto('https://witt.test/vault/index.html');
  await page.evaluate(()=>{window.DropVaultAndroid=new Proxy({}, {get:()=>()=>{}});});
  await page.addScriptTag({content:readFileSync(new URL('../web/'+entry,import.meta.url),'utf8')});
  const caps={default:{codexProfile:'default',models:[{id:'default-luna',displayName:'Default Luna'}],skills:[],mcpServers:[],features:[]},xuanyu:{codexProfile:'xuanyu',models:[{id:'xuanyu-astra',displayName:'Xuanyu Astra'}],skills:[],mcpServers:[],features:[]}};
  await page.evaluate(c=>window.DropVault.onCapabilities(JSON.stringify({...c.default,capabilitiesByProfile:c})),caps);
  for(const profile of ['default','xuanyu','default']) {
   await page.evaluate(p=>window.DropVault.onConversationCreated(JSON.stringify({conversation:{id:'00000000-0000-4000-8000-000000000001',codexProfile:p,model:p==='default'?'default-luna':'xuanyu-astra',reasoning:'medium',accessMode:'read-only',messages:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}})),profile);
   const want=[profile==='default'?'default-luna':'xuanyu-astra'];
   assert.deepEqual(await page.locator('.model-options [data-model]').evaluateAll(xs=>xs.map(x=>x.dataset.model)),want);
   assert.deepEqual(await page.locator('#quickModelOptions [data-quick-model]').evaluateAll(xs=>xs.map(x=>x.dataset.quickModel)),want);
  }
  const failed={...caps,xuanyu:{...caps.xuanyu,models:[],error:'Unavailable'}};
  await page.evaluate(c=>window.DropVault.onCapabilities(JSON.stringify({...c.default,capabilitiesByProfile:c})),failed);
  await page.evaluate(()=>window.DropVault.onConversationCreated(JSON.stringify({conversation:{id:'00000000-0000-4000-8000-000000000001',codexProfile:'xuanyu',model:'xuanyu-astra',messages:[]}})));
  assert.equal(await page.locator('.model-options [data-model]').count(),0);
  assert.equal(await page.locator('#quickModelOptions [data-quick-model]').count(),0);
  assert.deepEqual(errors,[]);
  await page.close();
 }
 console.log('Both web entry points passed account switching and failed-account model isolation.');
} finally {await browser.close();}
