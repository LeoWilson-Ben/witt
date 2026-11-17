'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {AntigravityAccountService}=require('../backend/antigravity-account-service');
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'witt-agy-check-'));
 const a=crypto.randomUUID(),b=crypto.randomUUID(),device=crypto.randomUUID();
 const service=new AntigravityAccountService({root,sendJson(){},readJsonBody(){},isAuthorized:t=>t.owner===a&&t.deviceId===device});
 const first=await service.card({userId:a,deviceId:device,admin:false});
 const second=await service.card({userId:b,deviceId:crypto.randomUUID(),admin:false});
 assert(first.loginUrl.startsWith('/vault-api/antigravity/login#'));assert.notEqual(first.loginUrl,second.loginUrl);
 assert.notEqual(service.env(a).HOME,service.env(b).HOME);assert.equal(fs.statSync(service.env(a).HOME).mode&0o777,0o700);
 assert.throws(()=>service.owner(null));assert.throws(()=>service.env('../escape'));
 await service.start(a);
 try{
  let pending=false;
  for(let i=0;i<60;i++){
   await new Promise(r=>setTimeout(r,500));
   const state=await service.status(a);
   if(state.status==='failed')throw Error('Official CLI login startup failed');
   if(state.verificationUrl){const u=new URL(state.verificationUrl);assert.equal(u.hostname,'accounts.google.com');assert.equal(u.searchParams.get('code_challenge_method'),'S256');assert.equal(state.authenticated,false);pending=true;break}
  }
  assert(pending,'Official authorization flow did not become ready');
  console.log('PASS ordinary-user login entry, separate homes, private permissions and official Google PKCE authorization startup');
 }finally{service.cancel(a)}
})().catch(()=>{console.error('Antigravity authorization verification failed (private output suppressed).');process.exitCode=1});
