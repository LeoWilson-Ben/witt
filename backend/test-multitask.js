'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const {test} = require('node:test'); const {ChatService} = require('./chat-service');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t, maxConcurrentTurns = 2) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'witt-multitask-'));
 const service=new ChatService({serverAdministrator:true,chatDir:path.join(root,'chat'),dataDir:path.join(root,'files'),imageDir:path.join(root,'images'),codexBin:'/bin/false',codexWorkDir:root,maxConcurrentTurns,allowedModels:null,sendJson(res,status,payload){res.status=status;res.payload=payload},readJsonBody(req,_limit,cb){cb(null,req.body||{})}});
 const client=service.clientFor(service.codexProfiles.default);const calls=[];let number=0;
 client.start=async()=>{};
 client.request=async(method,args)=>{ calls.push({method,args}); if(method==='thread/start')return {thread:{id:`thread-${++number}`}};if(method==='thread/resume')return {thread:{id:args.threadId}};if(method==='turn/start')return {turn:{id:`turn-${args.threadId}`}};return {}; };
 client.respond=(id,result)=>calls.push({method:'respond',id,result});client.close=()=>{};
 const request=(method,suffix,body={},deviceId='owner')=>{const res={};service.handle({method,body},res,new URL(`http://local/chat/${suffix}`),{deviceId});return res;};
 t.after(()=>{service.runNext=()=>{};for(const active of service.activeTurns.values()){clearTimeout(active.timeout);clearTimeout(active.timeoutGrace)}for(const c of service.jsonCheckpoints.values())clearTimeout(c.timer);for(const timer of service.eventBroadcasts.values())clearTimeout(timer);service.store.close();fs.rmSync(root,{recursive:true,force:true})});
 return {service,client,calls,request};
}
test('one user runs independent conversations concurrently, with bounded queue and scoped events',async t=>{
 const {service,client,calls,request}=fixture(t);
 const [a,b,c]=Array.from({length:3},()=>service.createConversation());
 for(const value of [a,b,c]){assert.equal(request('POST',`conversations/${value.id}/messages`,{text:`task ${value.id}`}).status,202);await tick();}
 await tick();await tick();await tick();
 assert.equal(service.activeTurns.size,2);assert.ok(service.activeFor(a.id));assert.ok(service.activeFor(b.id));assert.equal(service.activeFor(c.id),null);
 assert.equal(service.publicConversation(c).taskStatus.state,'queued');
 const aa=service.activeFor(a.id),bb=service.activeFor(b.id);
 for(const turn of [aa,bb])client.emit('notification','turn/started',{threadId:turn.threadId,turn:{id:turn.turnId}});
 client.emit('notification','item/agentMessage/delta',{threadId:aa.threadId,turnId:aa.turnId,itemId:'a-text',delta:'Only A'});
 client.emit('notification','item/agentMessage/delta',{threadId:bb.threadId,turnId:bb.turnId,itemId:'b-text',delta:'Only B'});
 const assistantA=()=>a.messages.find(m=>m.id===aa.messageId),assistantB=()=>b.messages.find(m=>m.id===bb.messageId);
 assert.match(JSON.stringify(assistantA().stream),/Only A/);assert.doesNotMatch(JSON.stringify(assistantB().stream),/Only A/);
 client.emit('notification','item/agentMessage/delta',{itemId:'unscoped',delta:'Must not leak'});
 assert.doesNotMatch(JSON.stringify(a.messages)+JSON.stringify(b.messages),/Must not leak/);
 assert.equal(request('POST',`conversations/${b.id}/messages`,{text:'guide B'}).payload.steered,true);await tick();
 assert.equal(calls.filter(c=>c.method==='turn/steer').at(-1).args.threadId,bb.threadId);
 client.emit('request',{id:'approve-a',method:'item/commandExecution/requestApproval',params:{threadId:aa.threadId,turnId:aa.turnId,command:'echo test',availableDecisions:['accept','decline']}});
 assert.equal(aa.pendingApprovals.size,1);assert.equal(bb.pendingApprovals.size,0);
 assert.equal(service.publicConversation(a).taskStatus.state,'awaiting_confirmation');
 const approvalId=[...aa.pendingApprovals.keys()][0];
 assert.equal(request('POST',`conversations/${b.id}/approvals/${approvalId}`,{decision:'accept'}).status,409);
 assert.equal(request('POST',`conversations/${a.id}/approvals/${approvalId}`,{decision:'accept'},'other').status,409);
 assert.equal(request('POST',`conversations/${a.id}/approvals/${approvalId}`,{decision:'accept'}).status,200);
 assert.equal(request('POST',`conversations/${a.id}/interrupt`).status,202);await tick();
 assert.equal(calls.filter(c=>c.method==='turn/interrupt').at(-1).args.threadId,aa.threadId);
 client.emit('notification','turn/completed',{threadId:aa.threadId,turn:{id:aa.turnId,status:'interrupted'}});
 await tick();await tick();
 assert.equal(service.activeFor(a.id),null);assert.equal(service.activeFor(b.id),bb);assert.ok(service.activeFor(c.id));assert.equal(assistantB().status,'running');
 client.emit('notification','item/agentMessage/delta',{threadId:aa.threadId,turnId:aa.turnId,itemId:'stale',delta:'late A'});
 assert.doesNotMatch(JSON.stringify(b.messages)+JSON.stringify(c.messages),/late A/);
 const list=request('GET','conversations').payload;
 assert.equal(list.activeConversationIds.length,2);assert.equal(list.maxConcurrentTasks,2);
 assert.equal(request('DELETE',`conversations/${b.id}`).status,409);
 assert.equal(request('PATCH',`conversations/${b.id}`,{title:'renamed while running',pinned:true}).status,200);
 assert.equal(service.readConversation(b.id).title,'renamed while running');
});
test('a failed turn and an idle timeout leave other conversations running',async t=>{
 const {service,client,request}=fixture(t); const a=service.createConversation(),b=service.createConversation();
 for(const v of [a,b])request('POST',`conversations/${v.id}/messages`,{text:'work'});await tick();await tick();
 const aa=service.activeFor(a.id),bb=service.activeFor(b.id);
 service.failActive('failure in A',a.id);await tick();assert.equal(service.activeFor(b.id),bb);assert.equal(service.activeFor(a.id),null);
 assert.equal(a.messages.at(-1).status,'failed');assert.equal(b.messages.at(-1).status,'running');
 assert.equal(service.activeForEvent(client,{threadId:bb.threadId,turnId:'old-turn'}),null);
 assert.equal(request('PATCH',`conversations/${b.id}`,{title:'  '}).status,400);
});
test('a turn waiting for its start event flushes only its own pending guidance',async t=>{
 const {service,client,calls,request}=fixture(t);const [a,b]=[service.createConversation(),service.createConversation()];
 for(const value of [a,b]){request('POST',`conversations/${value.id}/messages`,{text:'work'});await tick();}await tick();
 const aa=service.activeFor(a.id),bb=service.activeFor(b.id);
 assert.equal(request('POST',`conversations/${b.id}/messages`,{text:'guide before start'}).payload.pending,true);
 assert.equal(bb.pendingSteers.length,1);assert.equal(aa.pendingSteers.length,0);
 client.emit('notification','turn/started',{threadId:bb.threadId,turn:{id:bb.turnId}});await tick();
 assert.equal(bb.pendingSteers.length,0);assert.equal(calls.filter(c=>c.method==='turn/steer').at(-1).args.threadId,bb.threadId);
});
test('idle expiration interrupts and finishes only the affected task',async t=>{
 const {service,client,calls,request}=fixture(t);const [a,b]=[service.createConversation(),service.createConversation()];
 for(const value of [a,b]){request('POST',`conversations/${value.id}/messages`,{text:'work'});await tick();}await tick();
 const aa=service.activeFor(a.id),bb=service.activeFor(b.id);clearTimeout(aa.timeout);clearTimeout(bb.timeout);
 t.mock.timers.enable({apis:['setTimeout']});service.turnIdleTimeoutMs=1000;service.armActiveIdleTimeout(aa);
 t.mock.timers.tick(1000);assert.equal(calls.filter(c=>c.method==='turn/interrupt').at(-1).args.threadId,aa.threadId);
 t.mock.timers.tick(30000);assert.equal(service.activeFor(a.id),null);assert.equal(service.activeFor(b.id),bb);assert.equal(b.messages.at(-1).status,'running');
});
