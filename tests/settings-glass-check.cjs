const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const ROOT=process.env.SCREENSHOT_DIR || path.join(require('os').tmpdir(),'witt-settings-glass-check');
const LIVE=path.resolve(process.env.WEB_ROOT || path.join(__dirname,'../web'));
const STAGED=process.env.STAGED_ROOT || LIVE;fs.mkdirSync(ROOT,{recursive:true});
const projectId='00000000-0000-4000-8000-000000000010';
const scheduleId='00000000-0000-4000-8000-000000000020';
const services={checkedAt:new Date().toISOString(),projects:[],servers:[],connections:[],serviceDiscovery:{available:true,complete:true,scope:'all'},services:[
 {id:'drop-vault.service',unit:'drop-vault.service',name:'维特',description:'模拟维特服务',status:'active',subState:'running',enabled:'enabled'},
 {id:'media-fetch.service',unit:'media-fetch.service',name:'拾片',description:'模拟下载服务',status:'active',subState:'running',enabled:'enabled'},
 ...Array.from({length:148},(_,i)=>({id:`example-${i}.service`,unit:`example-${i}.service`,name:`示例服务 ${i}`,description:'仅用于界面验证',status:i===0?'failed':i%2?'active':'inactive',subState:i===0?'failed':i%2?'running':'dead',enabled:'static'}))]};
const project={id:projectId,name:'维特工作区',workDir:'/home/ubuntu',conversationCount:3,instructions:'保持界面清晰，支持手机与电脑。',shortcuts:[{name:'检查项目',prompt:'检查当前项目'}],conversations:[],files:[]};
const schedules=[{id:scheduleId,name:'每周项目检查',enabled:true,nextAt:new Date().toISOString(),intervalMinutes:10080,prompt:'检查项目运行状态',projectId,runs:[]}];
(async()=>{const browser=await chromium.launch({headless:true,args:['--no-sandbox']});try{
for(const viewport of [{width:390,height:844},{width:844,height:390},{width:1280,height:900}])for(const theme of ['light','dark']){
 const p=await browser.newPage({viewport});p.setDefaultTimeout(6500);const errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.addInitScript(({theme,services,project,schedules})=>{
  if(window.top!==window)return;
  localStorage.setItem('wit_theme',theme);window.__bridgeCalls=[];
  const send=(name,data)=>setTimeout(()=>window.DropVault?.[name]?.(JSON.stringify(data)),0);
  window.WittNative={postMessage(raw){const {method,args}=JSON.parse(raw);window.__bridgeCalls.push({method,endpoint:args?.[0]});
   if(method==='workspaceRequest'){
    const [endpoint,verb,,id]=args;const clean=endpoint.split('?')[0];
    const allowed=/^chat\/(projects|schedules)(\/[a-f0-9-]{36}(\/(conversations|run))?)?$/.test(clean);
    let data=endpoint==='chat/projects?view=service-status'?services:endpoint==='chat/projects'?{projects:[project]}:endpoint.startsWith('chat/projects/')?{project}:endpoint==='chat/schedules'?{schedules}:{};
    if(window.__extraService&&endpoint.includes('view='))data={...data,services:[...services.services,{id:'new-app.service',unit:'new-app.service',name:'新增应用',description:'自动发现测试',status:'active',subState:'running',enabled:'enabled'}]};
    setTimeout(()=>window.WittFeatures.onResponse(id,allowed&&verb==='GET',JSON.stringify(allowed?data:{error:'请求不可用'})),0);return;
   }
   if(method==='requestAuthStatus')send('onAuthStatus',{initialized:true,authenticated:true,principal:{admin:true,label:'测试管理员'}});
   if(method==='requestConversations')send('onConversations',{conversations:[]});
   if(method==='requestCodexAccounts')send('onCodexAccounts',{accounts:[{id:'default',label:'Witt 默认账号',authenticated:true,account:{email:'demo@example.invalid',planType:'Plus'}},{id:'xuanyu',authenticated:false,authenticationRequired:true,readError:'该账号授权已失效，请重新登录'},{id:'account4',authenticated:false},{id:'claude',provider:'claude',label:'Claude',authenticated:true,account:{email:'demo@example.invalid'}},{id:'antigravity',provider:'antigravity',label:'Gemini',authenticated:false}]});
   if(method==='requestAdminDevices')send('onAdminDevices',{devices:Array.from({length:18},(_,i)=>({id:String(i),label:i===0?'当前手机':`测试设备 ${i+1}`,createdAt:new Date().toISOString(),disabled:i>12}))});
   if(method==='requestLocalSshProfiles')send('onLocalSshProfiles',{profiles:[{id:'demo',label:'开发服务器',host:'demo.example.invalid',username:'ubuntu',port:22}]});
   if(method==='requestLocalSshStatus')send('onLocalSshStatus',{connected:false,connecting:false});
   if(method==='requestUsage')send('onUsage',{codexProfile:'default',summary:{lifetimeTokens:824320,currentStreakDays:7,peakDailyTokens:120000,longestStreakDays:12},days:[],rateLimits:{primary:{usedPercent:28,windowDurationMins:300},secondary:{usedPercent:6,windowDurationMins:10080}}});
   if(method==='startCodexLogin')send('onCodexLoginStarted',{profile:args[0],verificationUrl:'https://example.invalid/',userCode:'DEMO-0000'});
   if(method==='requestCodexLoginStatus')send('onCodexLoginStatus',{status:'pending'});
   if(method==='taskNotificationSettings')setTimeout(()=>window.WittFeatures?.onNotificationSettings?.({enabled:true,supported:true,permission:true}),0);
  }};
 },{theme,services,project,schedules});
 await p.route('**/*',route=>{const u=new URL(route.request().url());if(u.hostname!=='witt.test')return route.abort();const name=decodeURIComponent(u.pathname).replace(/^\/vault\//,'')||'index.html';let file=path.resolve(LIVE,name);if(!file.startsWith(LIVE+'/'))return route.abort();const staged=path.join(STAGED,name);if(fs.existsSync(staged))file=staged;if(!fs.existsSync(file)||!fs.statSync(file).isFile())return route.fulfill({status:404,body:''});return route.fulfill({path:file,contentType:({'.js':'application/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml'})[path.extname(file)]});});
 await p.goto('https://witt.test/vault/index.html');await p.evaluate(()=>{DropVault.nativeReady({nativeLaunch:true,workspaceFeatures:true,workspaceOperations:true,version:'3.2.5',cacheScope:'glass-test'});DropVault.onAuthStatus(JSON.stringify({initialized:true,authenticated:true,principal:{admin:true,label:'测试'}}));DropVault.onConversations(JSON.stringify({conversations:[]}));});await p.locator('#bootScreen').waitFor({state:'hidden'});
 async function reset(){await p.evaluate(()=>{for(const selector of ['#featureClose','#closeWorkspace','#closeCodexAccounts','#closeAdminSettings','#closeProfile','#closeLocalSsh','#closeProject','#closeDrawerAccount','#closeDrawer'])document.querySelector(selector)?.click();});}
 async function settings(){await reset();await p.locator('#menuButton').click();await p.locator('#drawerAvatar').click();await p.locator('#drawerAccountMenu').waitFor({state:'visible'});}
 async function keyboard(button){
  await p.evaluate(()=>{Object.defineProperty(window.visualViewport,'height',{configurable:true,get:()=>320});window.visualViewport.dispatchEvent(new Event('resize'))});
  await p.waitForTimeout(150);await p.locator(button).scrollIntoViewIfNeeded();const bounds=await p.locator(button).boundingBox();assert(bounds&&bounds.y>=0&&bounds.y+bounds.height<=321,'action hidden by simulated keyboard');
  await p.evaluate(()=>{Object.defineProperty(window.visualViewport,'height',{configurable:true,get:()=>innerHeight});window.visualViewport.dispatchEvent(new Event('resize'))});await p.waitForTimeout(100);
 }
 async function check(name,panel,close){await p.waitForTimeout(750);const style=await p.locator(panel).evaluate(n=>{const r=n.getBoundingClientRect(),s=getComputedStyle(n);return{x:r.x,y:r.y,w:r.width,h:r.height,radius:parseFloat(s.borderTopLeftRadius),blur:s.backdropFilter,bg:s.backgroundImage,scroll:n.scrollHeight>n.clientHeight}});assert(style.x>=-1&&style.y>=-1&&style.x+style.w<=viewport.width+1&&style.y+style.h<=viewport.height+1,`${name} outside viewport ${JSON.stringify(style)}`);assert(style.radius>=24,`${name} missing rounding`);assert(style.blur.includes('blur'),`${name} missing glass`);if(close){const r=await p.locator(close).boundingBox();assert(r&&r.y>=0&&r.y+r.height<=viewport.height+1,`${name} close not reachable`)}if(viewport.width===390||viewport.width===1280&&theme==='light')await p.screenshot({path:ROOT+`/${name}-${theme}-${viewport.width}.png`});}
 await settings();await check('settings','#drawerAccountMenu .user-settings-panel','#closeDrawerAccount');
 await p.locator('#codexAccountsButton').click();await p.locator('[data-login-codex]').waitFor();await check('accounts','#codexAccountSheet .sheet-panel','#closeCodexAccounts');assert.equal(await p.locator('[data-login-codex]').count(),1);
 await p.locator('[data-account-category=claude]').click();await check('claude','#codexAccountSheet .sheet-panel','#closeCodexAccounts');await p.locator('[data-account-category=gemini]').click();await check('gemini','#codexAccountSheet .sheet-panel','#closeCodexAccounts');await p.locator('[data-account-category=gpt]').click();await p.locator('[data-login-codex]').click();await p.locator('#codexLoginFlow').waitFor({state:'visible'});await check('login','#codexAccountSheet .sheet-panel','#closeCodexAccounts');
 await settings();await p.locator('#featureProjects').click();await p.locator('[data-feature=project]').waitFor();await check('projects','#featurePanel','#featureClose');await p.locator('[data-feature=project]').click();await p.locator('[data-feature=edit-project]').waitFor();await check('project-detail','#featurePanel','#featureClose');await p.locator('[data-feature=edit-project]').click();await check('project-edit','#featurePanel','#featureClose');await p.locator('#featureForm textarea[name=instructions]').fill('输入测试，不提交');await p.locator('#featureForm [type=submit]').scrollIntoViewIfNeeded();assert(await p.locator('#featureForm [type=submit]').isVisible());if(viewport.width===390)await keyboard('#featureForm [type=submit]');
 await settings();await p.locator('#featureSchedules').click();await p.locator('[data-feature=edit-schedule]').waitFor();await check('schedules','#featurePanel','#featureClose');await p.locator('[data-feature=edit-schedule]').click();await p.locator('#featureForm[data-kind=schedule]').waitFor();await check('schedule-edit','#featurePanel','#featureClose');
 await settings();await p.locator('#workspaceOverviewButton').click();await p.locator('#workspaceServiceSearch').waitFor();await check('services','#workspaceOverview .workspace-panel','#closeWorkspace');assert((await p.locator('.service-status-card').count())>100);await p.locator('#workspaceServiceSearch').fill('media-fetch');assert.equal(await p.locator('.service-status-card').count(),1);await p.locator('#workspaceServiceSearch').fill('');await p.locator('[data-service-filter=active]').click();assert.equal(await p.locator('.service-status-card:not([data-state=active])').count(),0);await p.locator('[data-service-filter=all]').click();await p.evaluate(()=>window.__extraService=true);await p.locator('#refreshWorkspace').click();await p.locator('#workspaceServiceSearch').fill('new-app');await p.locator('.service-status-card').filter({hasText:'新增应用'}).waitFor();
 await settings();await p.locator('#adminSettingsButton').click();await p.locator('.device-row').first().waitFor();await check('devices','#adminSettingsSheet .sheet-panel','#closeAdminSettings');await p.locator('.device-row').last().scrollIntoViewIfNeeded();assert(await p.locator('.device-row').last().isVisible());
 await settings();await p.locator('#profileButton').click();await p.locator('#usageContent .usage-stats').waitFor();await check('usage','#profileSheet .sheet-panel','#closeProfile');
 await settings();await p.locator('#localSshButton').click();await p.locator('.local-ssh-profile').waitFor();await check('servers','#localSshSheet .local-ssh-panel','#closeLocalSsh');await p.locator('#addLocalSshProfile').click();await p.locator('#localSshConnectForm').waitFor({state:'visible'});await check('server-add','#localSshSheet .local-ssh-panel','#closeLocalSsh');if(viewport.width===390)await keyboard('#localSshConnectButton');
 assert.equal(await p.locator('#settingsSheet').isVisible(),false,'hidden model dialog restored');assert.deepEqual(errors,[]);
 console.log(`PASS all setting pages and native service route ${theme} ${viewport.width}x${viewport.height}`);await p.close();
}
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
