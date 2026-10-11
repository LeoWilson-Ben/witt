"use strict";
const fs=require('node:fs'),http=require('node:http'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const path=require('node:path');
const stage=process.env.WITT_WORKSPACE_TEST_WEB||path.resolve(__dirname,'../web');
const server=http.createServer((req,res)=>{const name=new URL(req.url,'http://local').pathname.replace(/^\/vault\//,'');if(name.includes('..')){res.writeHead(400);return res.end();}const file=path.join(stage,name);if(!fs.existsSync(file)){res.writeHead(404);return res.end();}res.setHeader('Content-Type',name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(fs.readFileSync(file));});
(async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({headless:true});try{
for(const [width,height,theme] of [[393,852,'light'],[852,393,'dark'],[1280,800,'light']]){
 const page=await browser.newPage({viewport:{width,height}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(theme=>{if(window.top!==window)return;localStorage.setItem('wit_theme',theme);window.calls=[];window.WittNative={postMessage(s){calls.push(JSON.parse(s));}};},theme);
 await page.goto(`http://127.0.0.1:${server.address().port}/vault/index.html`);await page.waitForFunction(()=>window.WittFeatures);
 await page.evaluate(()=>{DropVault.nativeReady({version:'2.2.27',workspaceFeatures:true,workspaceOperations:true});DropVault.onAuthStatus(JSON.stringify({authenticated:true,principal:{admin:true}}));document.querySelector('#bootScreen').remove();});
 await page.locator('#menuButton').click();await page.locator('#drawerAvatar').click();await page.locator('#workspaceOverviewButton').click();
 const request=await page.evaluate(()=>calls.find(c=>c.method==='workspaceRequest'&&c.args[0]==='chat/workspace-overview'));assert.ok(request,'native overview request missing');
 assert.equal(await page.locator('#drawerAccountMenu').evaluate(n=>n.hidden),true);
 await page.evaluate(id=>WittFeatures.onResponse(id,true,JSON.stringify({projects:[{name:'连接测试项目'}],servers:[{name:'私人服务器',status:'connected'}],services:[],connections:[],checkedAt:new Date().toISOString()})),request.args[3]);
 await page.waitForFunction(()=>document.querySelector('#workspaceOverviewContent').textContent.includes('连接测试项目'));
 await page.locator('#refreshWorkspace').click();
 const next=await page.evaluate(()=>calls.filter(c=>c.method==='workspaceRequest'&&c.args[0]==='chat/workspace-overview').at(-1));assert.notEqual(next.args[3],request.args[3]);
 await page.evaluate(id=>WittFeatures.onResponse(id,false,JSON.stringify({error:'网络检查失败，请重试'})),next.args[3]);
 await page.waitForFunction(()=>document.querySelector('#workspaceOverviewContent').textContent==='网络检查失败，请重试');
 await page.locator('#closeWorkspace').click();assert.equal(await page.locator('#workspaceOverview').getAttribute('aria-hidden'),'true');assert.deepEqual(errors,[]);await page.close();
}
console.log('Workspace overview opens, reads results, refreshes, reports errors and closes across mobile/landscape/desktop.');
}finally{await browser.close();server.close();}})().catch(e=>{console.error(e.message);server.close();process.exitCode=1;});
