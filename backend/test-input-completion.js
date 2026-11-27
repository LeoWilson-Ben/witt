'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const {createInputCompletionRouter} = require('./routes/input-completion-routes');
const {sendJson,readJsonBody} = require('./core/http-utils');
(async()=>{
 let calls=0;
 const router=createInputCompletionRouter({sendJson,readJsonBody,allowed:id=>id==='owner',readKey:()=> 'test-only',fetchImpl:async(_url,opts)=>{
  calls++;const body=JSON.parse(opts.body);assert.equal(body.model,'deepseek-v4-flash');assert.equal(body.messages.at(-1).content,'帮我写');
  return {ok:true,json:async()=>({choices:[{message:{content:'帮我写一个脚本'}}]})};
 }});
 const server=http.createServer((req,res)=>router.handle(req,res,new URL(req.url,'http://localhost'),{userId:req.headers['x-test-user']||'owner'}));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url=`http://127.0.0.1:${server.address().port}/input-completion`;
 const request=(prefix,headers={})=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify({prefix})});
 try {
  assert.equal((await request('帮我写',{'x-test-user':'other'})).status,403);
  assert.equal((await request('x')).status,200);assert.equal(calls,0);
  let r=await request('帮我写');assert.equal(r.status,200);assert.equal((await r.json()).suffix,'一个脚本');
  assert.equal((await request('帮我写')).status,429);assert.equal(calls,1);
  console.log('PASS: owner isolation, input bounds, DeepSeek routing, prefix normalization and rate limit');
 }finally{await new Promise(r=>server.close(r));}
})().catch(()=>{console.error('completion test failed');process.exitCode=1});
