'use strict';
const assert = require('node:assert/strict');
const {ChatService} = require('./chat-service');
function fixture(allowed = ['default', 'xuanyu']) {
  const s = Object.create(ChatService.prototype);
  Object.assign(s, {codexProfiles:{default:{id:'default',workDir:'/tmp'},xuanyu:{id:'xuanyu',workDir:'/tmp'},account4:{id:'account4',workDir:'/tmp'}},allowedCodexProfiles:new Set(allowed),defaultCodexProfile:allowed[0],allowedModels:null,deepseekEnabled:false,capabilityCache:new Map(),availableModels:new Map()});
  const calls=[];
  s.clientFor=(profile)=>({start:async()=>{},request:async(method)=>{calls.push([profile.id,method]);if(method==='model/list')return {data:[{id:profile.id==='default'?'luna':'astra',displayName:profile.id}]};return {data:[]};}});
  s.sendJson=(_res,status,payload)=>{s.response={status,payload};};
  return {s,calls};
}
(async()=>{
  const {s,calls}=fixture();
  await s.readCapabilities({});
  assert.equal(s.response.status,200);
  assert.deepEqual(s.response.payload.capabilitiesByProfile.default.models.map(x=>x.id),['luna']);
  assert.deepEqual(s.response.payload.capabilitiesByProfile.xuanyu.models.map(x=>x.id),['astra']);
  assert.equal(s.response.payload.capabilitiesByProfile.account4,undefined);
  const count=calls.length;
  await s.readCapabilities({},'xuanyu');
  assert.equal(s.response.payload.codexProfile,'xuanyu');
  assert.equal(s.response.payload.models[0].id,'astra');
  assert.equal(calls.length,count,'per-account cache reused');
  await s.readCapabilities({},'account4');
  assert.equal(s.response.status,403);
  assert.equal(calls.length,count,'unauthorized account never queried');
  s.capabilityCache.clear();
  const original=s.clientFor;
  s.clientFor=p=>p.id==='xuanyu'?{start:async()=>{throw Error('offline');}}:original(p);
  await s.readCapabilities({});
  assert.equal(s.response.status,200);
  assert.equal(s.response.payload.capabilitiesByProfile.default.models[0].id,'luna');
  assert.deepEqual(s.response.payload.capabilitiesByProfile.xuanyu.models,[]);
  assert.ok(s.response.payload.capabilitiesByProfile.xuanyu.error);
  assert.ok(!s.capabilityCache.has('xuanyu'),'failure is not cached as a successful empty list');
  console.log('Account-specific models, cache isolation, authorization and partial failure passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});
