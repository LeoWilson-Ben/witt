import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {chromium} from 'playwright';
const web=new URL('../web/',import.meta.url);
const html=readFileSync(new URL('index.html',web),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'');
const browser=await chromium.launch({headless:true});
try {
 for(const [width,theme] of [[320,'light'],[390,'light'],[1280,'light'],[390,'dark'],[1280,'dark'],[844,'light']]) {
  const page=await browser.newPage({viewport:{width,height:width===844?390:860}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://witt.test/**',r=>{
   const name=new URL(r.request().url()).pathname.replace(/^\/vault\//,'');const file=new URL(name,web);
   if(name==='index.html')return r.fulfill({contentType:'text/html',body:html});
   if(name.endsWith('.css')&&existsSync(file))return r.fulfill({contentType:'text/css',body:readFileSync(file)});
   return r.fulfill({body:''});
  });
  await page.goto('https://witt.test/vault/index.html');
  await page.evaluate(({theme,width})=>{localStorage.setItem('wit_theme',theme);if(width>600)document.body.classList.add('web-browser');window.DropVaultAndroid=new Proxy({}, {get:()=>()=>{}});},{theme,width});
  await page.addScriptTag({content:readFileSync(new URL('app-workspace-20260916-r3.js',web),'utf8')});
  await page.evaluate(()=>window.DropVault.onConversations(JSON.stringify({conversations:[]})));
  const now=new Date().toISOString();
  const c={id:'00000000-0000-4000-8000-000000000001',title:'界面调整',codexProfile:'default',model:'gpt-6-luna',busy:true,createdAt:now,updatedAt:now,messages:[{id:'u',role:'user',text:'输入框静态，只保留按钮呼吸。',createdAt:now,status:'completed'},{id:'a',role:'assistant',text:'正在调整界面。',createdAt:now,status:'running',stream:[{id:'cmd',kind:'command',status:'running',label:'修改输入框样式',hasDetails:false}]}]};
  await page.evaluate(c=>window.DropVault.onConversationCreated(JSON.stringify({conversation:c})),c);
  await page.evaluate(c=>window.DropVault.onConversation(JSON.stringify({conversation:c})),c);
  assert.equal(await page.locator('#voiceButton,.voice-button').count(),0);
  for(const selector of ['.composer-wrap','#composer','#messageInput','.composer-meta']) {
   const element=page.locator(selector).first();if(await element.count())assert.equal(await element.evaluate(n=>getComputedStyle(n).animationName),'none',selector);
  }
  assert.deepEqual(await page.locator('#composer').evaluate(n=>['::before','::after'].map(p=>getComputedStyle(n,p).animationName)),['none','none']);
  assert.equal(await page.locator('#sendButton').evaluate(n=>getComputedStyle(n).animationName),'quiet-button-breathe');
  assert.equal(await page.locator('#sendButton svg').evaluate(n=>getComputedStyle(n).animationName),'none');
  assert.equal(await page.locator('.message.user .bubble').evaluate(n=>getComputedStyle(n).backgroundColor),'rgb(255, 230, 138)');
  await page.locator('#modelLabel').evaluate(n=>n.textContent='GPT-6.1 Sol');
  const layout=await page.evaluate(()=>{
   const rect=s=>document.querySelector(s).getBoundingClientRect();
   const shell=rect('.app-shell'),wrap=rect('#composerWrap'),input=rect('#messageInput'),tool=rect('.composer-toolbar'),model=rect('#modelButton'),send=rect('#sendButton'),attach=rect('#attachButton');
   const label=document.querySelector('#modelLabel');
   const css=getComputedStyle(document.querySelector('#composer'));
   return {centerOffset:Math.abs(wrap.x+wrap.width/2-shell.x-shell.width/2),inputBottom:input.bottom,toolbarTop:tool.top,modelLeft:model.left,modelRight:model.right,attachRight:attach.right,sendLeft:send.left,labelOverflow:label.scrollWidth>label.clientWidth+1,blur:css.backdropFilter,background:css.backgroundColor};
  });
  assert.ok(layout.centerOffset<1,'centered within app shell');
  assert.ok(layout.inputBottom<=layout.toolbarTop,'textarea and toolbar use separate rows');
  assert.ok(layout.modelLeft>=layout.attachRight&&layout.modelRight<=layout.sendLeft,'model does not overlap buttons');
  assert.ok(!layout.labelOverflow,'model name is fully visible');
  assert.ok(layout.blur.includes('blur(22px)'),'frosted glass enabled');
  assert.ok(layout.background.startsWith('rgba('),'translucent surface');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:`/tmp/witt-composer-quiet-${width}-${theme}.png`,fullPage:true});
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await page.locator('#sendButton').evaluate(n=>getComputedStyle(n).animationName),'none');
  await page.emulateMedia({reducedMotion:'no-preference'});
  c.busy=false;c.messages[1].status='completed';c.messages[1].stream[0].status='completed';
  await page.evaluate(c=>window.DropVault.onConversation(JSON.stringify({conversation:c})),c);
  assert.equal(await page.locator('#sendButton').evaluate(n=>getComputedStyle(n).animationName),'none');
  assert.deepEqual(errors,[]);await page.close();
 }
 console.log('Composer passed mobile, desktop, light and dark: static input, breathing busy button, yellow user bubbles, no voice icon, reduced motion and completion.');
}finally{await browser.close();}
