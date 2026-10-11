"use strict";
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const backend=process.env.WITT_SECURITY_BACKEND||path.resolve(__dirname,'../backend');
const {ChatService}=require(path.join(backend,'chat-service'));
const {executionPolicy}=require(path.join(backend,'execution-policy'));
const {refreshChatAccess}=require(path.join(backend,'chat-access-policy'));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'witt-isolation-'));
(async()=>{
 for(const administrator of [false,true]){
  const base=path.join(root,String(administrator));const calls=[],responses=[];
  const service=new ChatService({serverAdministrator:administrator,chatDir:path.join(base,'chat'),dataDir:path.join(base,'files'),imageDir:path.join(base,'images'),codexBin:'unused',codexWorkDir:'/home/ubuntu',startWorkspace:false,sendJson(){},readJsonBody(){}});
  const conversation={id:crypto.randomUUID(),title:'isolation fixture',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),model:'gpt-6.1-sol',accessMode:'danger-full-access',workDir:'/home/ubuntu',messages:[]};
  const user={id:crypto.randomUUID(),role:'user',text:'fixture',status:'queued',createdAt:new Date().toISOString()};const assistant={id:crypto.randomUUID(),replyTo:user.id,role:'assistant',text:'',status:'queued',stream:[],activity:[]};conversation.messages=[user,assistant];
  service.writeConversation(conversation);let dequeued=false;service.nextQueued=()=>{if(dequeued)return null;dequeued=true;return{conversation,user,assistant};};
  service.clientFor=()=>({start:async()=>{},request:async(method,params)=>{calls.push({method,params});return method.startsWith('thread/')?{thread:{id:crypto.randomUUID()}}:{turn:{id:crypto.randomUUID()}};},respond:(id,response)=>responses.push({id,response})});
  await service.runNext();const thread=calls.find(c=>c.method==='thread/start'),turn=calls.find(c=>c.method==='turn/start');
  assert.equal(thread.params.sandbox,administrator?'danger-full-access':'workspace-write');assert.equal(thread.params.approvalPolicy,administrator?'on-request':'never');assert.equal(turn.params.approvalPolicy,thread.params.approvalPolicy);
  assert.equal(thread.params.cwd,administrator?'/home/ubuntu':service.userWorkspaceDir);
  assert.equal(service.publicConversation(conversation).accessMode,thread.params.sandbox);
  assert.equal(service.buildDeveloperInstructions(conversation).includes('本机通用 Root 权限'),administrator);
  if(!administrator){
   for(const method of ['item/commandExecution/requestApproval','item/fileChange/requestApproval','item/permissions/requestApproval'])service.handleServerRequest(conversation.id,assistant.id,{id:method,method,params:{}});
   assert.deepEqual(responses.map(r=>r.response),[{decision:'decline'},{decision:'decline'},{permissions:{},scope:'turn'}]);
   assert.equal((service.activeFor?.(conversation.id)||service.active).pendingApprovals.size,0);
   const models=service.allowedModels;
   refreshChatAccess(service,{serverAdministrator:false,allowedModels:models,defaultModel:service.defaultModel,quotaExhausted:false,allowedCodexProfiles:['default']});
   assert.equal(service.quotaExhausted,false);assert.ok(service.allowedCodexProfiles.has('default'));assert.equal(service.serverAdministrator,false);
  }
  for(const active of service.activeTurns?.values() || [service.active].filter(Boolean))for(const key of Object.keys(active))if(/timer|timeout/i.test(key))clearTimeout(active[key]);
  if(service.activeTurns)service.activeTurns.clear();else service.active=null;service.store.close();
 }
 for(const accessMode of ['danger-full-access','workspace-write','read-only','unexpected'])assert.equal(executionPolicy(false,{accessMode,admin:true}).approvalPolicy,'never');
 console.log('Non-admin execution cannot request full access, widen permissions or change shared host workspace; administrator execution and default account quota access preserved.');
})().finally(()=>fs.rmSync(root,{recursive:true,force:true})).catch(e=>{console.error(e.stack);process.exitCode=1;});
