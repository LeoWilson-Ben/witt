"use strict";
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {StringDecoder}=require('node:string_decoder');
const {ClaudeAccountService}=require('./claude-account-service');
const TTL=15*60_000;
function cleanTerminal(text){return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g,'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\r/g,'');}
function authorizationUrl(text){
 for(const value of text.match(/https:\/\/[^\s\x1b<>"']+/g)||[]){try{
  const u=new URL(value);
  if(u.hostname==='accounts.google.com'&&['/o/oauth2/auth','/o/oauth2/v2/auth'].includes(u.pathname)&&
    u.searchParams.get('state')&&u.searchParams.get('client_id')&&u.searchParams.get('code_challenge')&&
    u.searchParams.get('code_challenge_method')==='S256'&&u.searchParams.get('response_type')==='code'&&
    u.searchParams.get('redirect_uri')==='https://antigravity.google/oauth-callback')return u.href;
 }catch{}}
 return '';
}
class AntigravityAccountService extends ClaudeAccountService{
 constructor(options={}){super({...options,bin:options.bin||'/home/ubuntu/.local/bin/agy',root:options.root||'/home/ubuntu/.antigravity-witt'});this.helper=options.helper||path.join(__dirname,'antigravity-pty.py');this.modelCache=new Map();this.modelChecks=new Map();}
 owner(principal){if(!principal?.admin||!/^(?:legacy|[a-f0-9-]{36})$/.test(principal.userId||''))throw Error('仅管理员可连接自己的 Gemini 账号');return principal.userId;}
 env(owner){
  if(!/^(?:legacy|[a-f0-9-]{36})$/.test(owner))throw Error('账号无效');
  const home=path.join(this.root,owner,'home');fs.mkdirSync(home,{recursive:true,mode:0o700});fs.chmodSync(path.dirname(home),0o700);fs.chmodSync(home,0o700);
  const env={HOME:home,PATH:'/home/ubuntu/.local/bin:/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',TERM:'xterm-256color',BROWSER:'/bin/false',SSH_CONNECTION:'127.0.0.1 12345 127.0.0.1 22',XDG_CONFIG_HOME:path.join(home,'.config'),XDG_DATA_HOME:path.join(home,'.local/share')};
  for(const n of ['HTTPS_PROXY','HTTP_PROXY','NO_PROXY'])if(process.env[n])env[n]=process.env[n];return env;
 }
 marker(owner){return path.join(this.env(owner).HOME,'witt-account.json');}
 async account(owner,fresh=false){try{
  let v={authenticated:false,email:''};
  try{v=JSON.parse(fs.readFileSync(this.marker(owner),'utf8'));}catch{}
  if(!v.authenticated&&(fresh||!this.modelChecks.has(owner))){
   if((await this.availableModels(owner,true)).length){
    v={authenticated:true,email:v.email||'',connectedAt:new Date().toISOString()};
    fs.writeFileSync(this.marker(owner),JSON.stringify(v),{mode:0o600});
   }
  }
  if(fresh&&v.authenticated&&Date.now()-(this.modelChecks.get(owner)?.at||0)>10000){await this.availableModels(owner,true);if(this.modelChecks.get(owner)?.signedOut){v.authenticated=false;fs.writeFileSync(this.marker(owner),JSON.stringify(v),{mode:0o600});}}
  return {authenticated:v.authenticated===true,email:typeof v.email==='string'?v.email.slice(0,254):'',planType:''};
 }catch{return {authenticated:false,email:'',planType:''};}}
 async availableModels(owner, fresh=false){
  const cached=this.modelCache.get(owner);if(!fresh&&cached&&Date.now()-cached.at<60000)return cached.models;
  const models=await new Promise(resolve=>{let output='',errors='',done=false;const env=this.env(owner);const child=this.spawn(this.bin,['--log-file','/dev/null','models'],{cwd:env.HOME,env,stdio:['ignore','pipe','pipe']});
   const finish=(code=1)=>{if(done)return;done=true;clearTimeout(timer);const rows=[];
    this.modelChecks.set(owner,{at:Date.now(),signedOut:/authentication required|not (?:signed|logged) in|login required/i.test(errors)});
    if(code===0)for(const line of cleanTerminal(output).split('\n')){const m=line.trim().match(/^((?:gemini|claude|gpt)-[A-Za-z0-9._-]+)\s+(.+)$/);if(m)rows.push({slug:m[1],name:m[2].trim()});}resolve(rows);};
   const timer=setTimeout(()=>{child.kill();finish();},10000);child.stdout.on('data',chunk=>{if(output.length<65536)output+=chunk.toString();});child.stderr.on('data',chunk=>{if(errors.length<8192)errors+=chunk.toString();});child.on('error',()=>finish());child.on('close',finish);
  });if(models.length){this.modelCache.set(owner,{at:Date.now(),models});fs.writeFileSync(path.join(this.env(owner).HOME,'witt-models.json'),JSON.stringify(models),{mode:0o600});}return models;
 }
 authenticated(owner,login,email=''){
  if(login.finished)return;
  fs.writeFileSync(this.marker(owner),JSON.stringify({authenticated:true,email,connectedAt:new Date().toISOString()}),{mode:0o600});
  login.finish('authenticated');login.child.kill();
 }
 async verifyLogin(owner,login){
  if(login.finished||login.checking)return;
  login.checking=true;
  try{if((await this.availableModels(owner,true)).length)this.authenticated(owner,login);}finally{login.checking=false;}
 }
 async card(principal){const c=await super.card(principal);return {...c,id:'antigravity',provider:'antigravity',label:'Antigravity CLI',loginUrl:c.loginUrl.replace('/claude/','/antigravity/')};}
 async start(owner){
  const previous=this.logins.get(owner);if(previous&&!previous.finished)return this.status(owner);if((await this.account(owner,true)).authenticated)return this.status(owner);
  const env=this.env(owner),child=this.spawn('/usr/bin/python3',[this.helper,this.bin,'--log-file','/dev/null'],{cwd:env.HOME,env,stdio:['pipe','pipe','pipe']});
  const login={child,verificationUrl:'',state:'starting',finished:false,expiresAt:Date.now()+TTL,buffer:'',codeSubmitted:false,selected:false};this.logins.set(owner,login);
  const finish=(state)=>{if(login.finished)return;login.finished=true;login.state=state;login.buffer='';login.verificationUrl='';clearTimeout(login.timer);clearTimeout(login.startupTimer);clearInterval(login.verifyTimer);};login.finish=finish;
  login.timer=setTimeout(()=>{finish('expired');child.kill();},TTL);login.timer.unref?.();
  login.startupTimer=setTimeout(()=>{if(login.state==='starting'){finish('failed');child.kill();}},45000);login.startupTimer.unref?.();
  login.verifyTimer=setInterval(()=>{void this.verifyLogin(owner,login).catch(()=>{});},5000);login.verifyTimer.unref?.();
  const decoder=new StringDecoder('utf8');
  child.stdout.on('data',chunk=>{
   if(login.finished)return;
   login.buffer=cleanTerminal((login.buffer+decoder.write(chunk)).slice(-131072));
   if(!login.selected&&/Select login method:/i.test(login.buffer)){login.selected=true;child.stdin.write('\r');}
   const url=authorizationUrl(login.buffer);if(url){login.verificationUrl=url;login.state=login.codeSubmitted?'verifying':'pending';}
   if(login.codeSubmitted && /authentication failed|failed to (?:exchange|authenticate)|invalid_grant|invalid authorization code|token exchange failed/i.test(login.buffer)){finish('failed');child.kill();return;}
   if(/Successfully authenticated(?: as)?|Authentication successful/i.test(login.buffer)){
    const email=login.buffer.match(/Successfully authenticated as\s+([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+)/i)?.[1]||'';
    this.authenticated(owner,login,email);
   }
  });
  child.stderr.resume();child.stdin.on('error',()=>finish('failed'));child.on('error',()=>finish('failed'));
  child.on('close',()=>finish('failed'));
  return {status:'starting',authenticated:false};
 }
 async status(owner){const login=this.logins.get(owner);if(login&&!login.finished)return {status:login.state,authenticated:false,verificationUrl:login.verificationUrl,expiresAt:login.expiresAt};const account=await this.account(owner,true);return {status:account.authenticated?'authenticated':login?.state||'signedOut',...account};}
 complete(owner,code){const login=this.logins.get(owner);if(!login||login.finished||!login.verificationUrl||login.codeSubmitted)throw Error('请重新发起登录');if(typeof code!=='string'||!/^[-A-Za-z0-9_/.~]{8,4096}$/.test(code.trim()))throw Error('授权码无效');login.codeSubmitted=true;login.state='verifying';login.child.stdin.write(code.trim()+'\r');return {status:'verifying'};}
 cancel(owner){const login=this.logins.get(owner);if(login)clearInterval(login.verifyTimer);return super.cancel(owner);}
 handle(req,res,url){
  if(url.pathname==='/antigravity/login'&&req.method==='GET'){
   const html=fs.readFileSync(path.join(__dirname,'antigravity-login.html'),'utf8'),script=html.match(/<script>([\s\S]*?)<\/script>/)?.[1]||'',hash=crypto.createHash('sha256').update(script).digest('base64');
   res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Content-Security-Policy':`default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`});res.end(html);return true;
  }
  if(!/^\/antigravity\/login\/(status|start|complete|cancel)$/.test(url.pathname))return false;
  const mapped=new URL(url);mapped.pathname=url.pathname.replace('/antigravity/','/claude/');return super.handle(req,res,mapped);
 }
}
module.exports={AntigravityAccountService,authorizationUrl,cleanTerminal};
