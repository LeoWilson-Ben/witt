'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'../web'),source=fs.readFileSync(path.join(root,'app-workspace-20260916-r3.js'),'utf8');
const functions=source.slice(source.indexOf('  let adminDevices = [];'),source.indexOf('\n  function closeProfile()',source.indexOf('  let adminDevices = [];')));
const events=source.slice(source.indexOf('  $("#deviceList").addEventListener("click"'),source.indexOf('  $("#quotaConfirmBackdrop").addEventListener',source.indexOf('  $("#deviceList").addEventListener("click"')));
const css=['witt-base-20261008.css','witt-interface-20261008.css'].map(f=>fs.readFileSync(path.join(root,f),'utf8')).join('\n');
(async()=>{const browser=await chromium.launch({args:['--no-sandbox']});try{
for(const width of [320,390,844,1280])for(const native of [false,true]){
 const p=await browser.newPage({viewport:{width,height:850}}),errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.setContent(`<style>${css}</style><section id="adminSettingsSheet" class="sheet open" style="position:relative;display:block"><div class="admin-settings-panel"><section id="deviceAdmin" class="device-admin"><div id="deviceList" class="device-list"></div></section></div></section>`);
 await p.addScriptTag({content:`const $=s=>document.querySelector(s);const escapeHtml=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const formatDate=s=>'刚刚';const toast=s=>window.lastToast=s;const bridge=()=>({});window.failSave=false;window.apiCalls=[];window.records=[{id:'11111111-1111-4111-8111-111111111111',label:'测试设备名称'.repeat(10),note:'',disabled:false},{id:'22222222-2222-4222-8222-222222222222',label:'已停止的设备',note:'旧备注',disabled:true}];window.WittFeatures={request:async(endpoint,method,body)=>{window.apiCalls.push({endpoint,method});await new Promise(r=>setTimeout(r,50));if(window.failSave)throw Error('测试保存失败，请重试');const id=endpoint.includes('deviceId=')?new URLSearchParams(endpoint.split('?')[1]).get('deviceId'):endpoint.split('/')[2];const device=window.records.find(d=>d.id===id);device.note=body.note.trim();return {device}}};${functions}\n${events}\nwindow.renderTest=()=>renderAdminDevices(window.records);window.renderTest();`});
 if(native)await p.evaluate(()=>window.WittNative={});
 const first=p.locator('.device-row').first();await first.locator('[data-edit-device-note]').click();
 const textarea=first.locator('textarea');await textarea.fill('我的手机\n<img src=x onerror=alert(1)>');
 await first.locator('button[type=submit]').click();await p.waitForFunction(()=>window.lastToast==='备注已保存');
 assert.equal(await first.locator('.device-note').textContent(),'我的手机\n<img src=x onerror=alert(1)>');assert.equal(await p.locator('#deviceList img').count(),0);
 assert(await first.locator('form').isHidden());
 const call=await p.evaluate(()=>window.apiCalls[0]);assert.equal(call.method,'PATCH');assert.equal(call.endpoint.startsWith('chat/projects?view=device-note'),native);
 await p.evaluate(()=>window.renderTest());await first.locator('[data-edit-device-note]').click();await textarea.fill('不保存');await first.locator('[data-cancel-device-note]').click();await first.locator('[data-edit-device-note]').click();assert((await textarea.inputValue()).includes('我的手机'));
 await p.evaluate(()=>window.failSave=true);await textarea.fill('失败后保留的草稿');await first.locator('button[type=submit]').click();await first.locator('.device-note-hint').getByText('测试保存失败，请重试').waitFor();assert.equal(await textarea.inputValue(),'失败后保留的草稿');assert(await textarea.isEnabled());
 await p.evaluate(()=>window.failSave=false);await textarea.fill('a'.repeat(200));await first.locator('button[type=submit]').click();await p.waitForFunction(()=>window.records[0].note==='a'.repeat(200));
 assert(await p.evaluate(()=>document.querySelector('#deviceList').scrollWidth<=document.querySelector('#deviceList').clientWidth+1),'list overflow');
 await first.locator('[data-edit-device-note]').click();await textarea.fill('');await first.locator('button[type=submit]').click();await p.waitForFunction(()=>window.lastToast==='备注已清空');assert(await first.locator('.device-note').isHidden());
 assert(await p.locator('.device-row').last().locator('[data-edit-device-note]').isVisible());assert.equal(await p.locator('.device-row').last().locator('[data-disable-device]').count(),0);assert.deepEqual(errors,[]);
 console.log('PASS device notes UI',width,native?'native':'browser');await p.close();
}
}finally{await browser.close()}})().catch(e=>{console.error(e.message);process.exit(1)});
