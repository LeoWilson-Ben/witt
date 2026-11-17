'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {AuthService}=require('../backend/auth-service');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'witt-device-notes-'));
let response,body;
const options={dir,sendJson(_res,status,data){response={status,data}},readJsonBody(_req,_limit,callback){callback(null,body)}};
const auth=new AuthService(options);
const invite=auth.initialize(crypto.randomBytes(24).toString('base64url'));
const activated=auth.activate({inviteCode:invite.code,deviceId:crypto.randomUUID(),deviceName:'保留设备名称'});
const id=activated.device.id,principal=auth.authenticateToken(activated.token),before=auth.read();
function route(url,principal,patch={note:'测试备注'},method='PATCH'){response=null;body=patch;assert.equal(auth.handle({method},{},new URL(url,'http://test'),principal),true);return response}
for(const url of [`/admin/devices/${id}/note`,`/chat/projects?view=device-note&deviceId=${id}`]){
 assert.equal(route(url,null).status,401);
 assert.equal(route(url,{admin:false}).status,403);
 assert.equal(route(url,principal,{},'GET').status,405);
 for(const note of [null,{},25,'a'.repeat(201)])assert.equal(route(url,principal,{note}).status,400);
 const r=route(url,principal,{note:'  我的手机\n测试 <img src=x onerror=alert(1)>  ',admin:false,disabled:true});
 assert.equal(r.status,200);assert.equal(r.data.device.note,'我的手机\n测试 <img src=x onerror=alert(1)>');
 assert.equal(r.data.device.tokenHash,undefined);assert.equal(r.data.device.label,'保留设备名称');assert.equal(r.data.device.admin,true);assert.equal(r.data.device.disabled,false);
}
const saved=auth.read();assert.deepEqual(saved.admin,before.admin);assert.deepEqual(saved.invites,before.invites);
for(const key of Object.keys(before.devices[0]))assert.deepEqual(saved.devices[0][key],before.devices[0][key],key);
assert(auth.authenticateToken(activated.token));
const reload=new AuthService(options);assert(reload.publicDevice(reload.read().devices[0]).note.includes('我的手机'));
assert.equal(route(`/admin/devices/${crypto.randomUUID()}/note`,principal).status,404);
const disabled=auth.read();disabled.devices[0].disabled=true;auth.write(disabled);
assert.equal(route(`/admin/devices/${id}/note`,principal,{note:'停用设备仍可备注'}).status,200);
assert.equal(route(`/admin/devices/${id}/note`,principal,{note:'   '}).data.device.note,'');
auth.store.db.close();reload.store.db.close();
console.log('PASS device note persistence, clear, disabled devices, type/length validation, admin-only canonical/native routes and credential preservation');
