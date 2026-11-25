'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ProviderRuntime}=require('./provider-runtime');
const {ChatService}=require('./chat-service');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'witt-agy-settings-'));
const profile={id:'antigravity',provider:'antigravity',workDir:root};
const rows=[{slug:'gemini-neon-xhigh',name:'Neon (XHigh)'},{slug:'gemini-neon-medium',name:'Neon (Medium)'},{slug:'gemini-carbon-high',name:'Carbon (High)'},{slug:'gemini-carbon-low',name:'Carbon (Low)'},{slug:'gemini-orchestrator',name:'Orchestrator'}];
const runtime=new ProviderRuntime({owner:'test',services:{antigravity:{modelCache:new Map([['test',{models:rows}]]),env:()=>({HOME:root})}}});
const service=new ChatService({chatDir:path.join(root,'chat'),dataDir:path.join(root,'files'),imageDir:path.join(root,'images'),codexBin:'/bin/false',codexWorkDir:root,serverAdministrator:true,allowedModels:null,allowedCodexProfiles:['antigravity'],providerRuntime:runtime,codexProfiles:{antigravity:profile},sendJson:(res,status,body)=>Object.assign(res,{status,body}),readJsonBody:(req,_limit,cb)=>cb(null,req.body)});
service.runNext=()=>{};
try{
 const models=runtime.models('antigravity');
 assert.equal(models[0].displayName,'Neon');
 assert.deepEqual(models[0].reasoningEfforts.map(e=>e.id),['medium','xhigh']);
 const c=service.createConversation('test','gemini:gemini-neon','xhigh','read-only','','antigravity');
 const patch=body=>{const res={};service.updateConversationSettings({body},res,c.id);return res;};
 let res=patch({model:'gemini:gemini-carbon',reasoning:'xhigh',codexProfile:'antigravity'});
 assert.equal(res.status,200);assert.equal(res.body.conversation.reasoning,'high');
 assert.equal(res.body.conversation.accessMode,'read-only');
 res=patch({model:'gemini:gemini-neon',reasoning:'xhigh'});
 assert.equal(res.status,200);assert.equal(res.body.conversation.reasoning,'xhigh');
 res=patch({model:'gemini:gemini-orchestrator',reasoning:'ultra'});
 assert.equal(res.status,200);assert.equal(res.body.conversation.reasoning,'medium');
 for(const body of [{model:'gemini:unknown'},{reasoning:'invalid'},{accessMode:'invalid'},{codexProfile:'default'}])assert.notEqual(patch(body).status,200);
 // Reproduce the four-argument installed Android bridge: no codexProfile.
 service.codexProfiles.default={id:'default',workDir:'/srv/projects'};
 service.allowedCodexProfiles.add('default');
 const blank=service.createConversation('Android','gpt-6.1-sol','medium','read-only','','default');
 const androidPatch=()=>{const res={};service.updateConversationSettings({body:{model:'gemini:gemini-neon',reasoning:'xhigh',accessMode:'read-only'}},res,blank.id);return res;};
 let android=androidPatch();assert.equal(android.status,200);assert.equal(android.body.conversation.codexProfile,'antigravity');
 const saved=service.readConversation(blank.id);saved.codexProfile='default';saved.codexThreadId='existing-context';service.writeConversation(saved);
 assert.equal(androidPatch().status,409);
 saved.codexThreadId=null;service.writeConversation(saved);service.allowedCodexProfiles.delete('antigravity');
 assert.equal(androidPatch().status,403);
 console.log('PASS model-specific efforts, model switches, default-only models, access preservation and invalid-setting rejection');
}finally{service.store.close();}
