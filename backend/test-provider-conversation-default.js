'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ChatService}=require('./chat-service');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'witt-provider-create-'));
const runtime={home:()=>root,models:()=>[{id:'gemini:gemini-3.8-flash',isDefault:true}],allowed:model=>model==='gemini:gemini-3.8-flash',defaultModel:()=> 'gemini:gemini-3.8-flash',reasoning:()=> 'medium'};
const service=new ChatService({chatDir:path.join(root,'chat'),dataDir:path.join(root,'files'),imageDir:path.join(root,'images'),codexBin:'/bin/false',codexWorkDir:'/srv/projects',serverAdministrator:true,allowedModels:null,allowedCodexProfiles:['default','antigravity'],providerRuntime:runtime,codexProfiles:{default:{id:'default',workDir:'/srv/projects'},antigravity:{id:'antigravity',provider:'antigravity',workDir:'/srv/projects'}},sendJson(){},readJsonBody(){}});
service.runNext=()=>{};
try{
 const c=service.createConversation('Gemini test','gpt-6.1-sol','medium','danger-full-access','','antigravity');
 assert.equal(c.codexProfile,'antigravity');assert.equal(c.model,'gemini:gemini-3.8-flash');assert.equal(c.workDir,null);
 assert.equal(service.effectiveWorkDir(c),'/home/ubuntu');
 assert.throws(()=>service.createConversation('test',undefined,undefined,undefined,'/etc','antigravity'),/允许的工作目录/);
 assert.equal(service.createConversation('GPT',undefined,undefined,undefined,'','default').workDir,null);
 service.serverAdministrator=false;assert.equal(service.effectiveWorkDir(c),service.userWorkspaceDir);
 console.log('PASS Gemini default directory, provider model selection, explicit-path restrictions and ordinary-user workspace isolation');
}finally{service.store.close()}
