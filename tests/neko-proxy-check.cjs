'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {createNekoProxy}=require('../backend/routes/neko-proxy');
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',r));
const principalFor=req=>req.headers.cookie==='test=session'||req.headers.authorization==='Bearer witt-test'?{admin:true,deviceId:'fixture'}:null;
async function fixture(t){
 let received;
 const sockets=new Set();
 const upstream=http.createServer((req,res)=>{received={path:req.url,headers:req.headers};res.end('ok');});
 upstream.on('upgrade',(req,socket)=>{socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');socket.on('data',data=>socket.write(data));});
 await listen(upstream);
 const proxy=createNekoProxy({principalFor,port:upstream.address().port,allowedOrigins:new Set(["https://cdn.example"])});
 const server=http.createServer((req,res)=>proxy.handle(req,res,new URL(req.url,'http://localhost'),principalFor(req)));
 proxy.attachUpgrade(server);await listen(server);
 for(const s of [server,upstream])s.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
 t.after(()=>{for(const s of sockets)s.destroy();server.close();upstream.close();});
 return {origin:`http://127.0.0.1:${server.address().port}`,received:()=>received};
}
test('Neko requests require Witt authentication and never forward Witt credentials',async t=>{
 const f=await fixture(t);
 assert.equal((await fetch(f.origin+'/browser/room/')).status,401);
 assert.equal((await fetch(f.origin+'/browser/room/api/whoami',{headers:{cookie:'test=session',authorization:'Bearer neko-test'}})).status,200);
 assert.equal(f.received().path,'/vault-api/browser/room/api/whoami');
 assert.equal(f.received().headers.cookie,undefined);assert.equal(f.received().headers.authorization,'Bearer neko-test');
 await fetch(f.origin+'/browser/room/',{headers:{cookie:'test=session',authorization:'Bearer witt-test'}});
 assert.equal(f.received().headers.authorization,undefined);
 assert.equal((await fetch(f.origin+'/browser/room/api/login',{method:'POST',headers:{cookie:'test=session',origin:'https://other.example'}})).status,403);
});
test('a second viewer websocket leaves the first websocket connected',async t=>{
 const f=await fixture(t);
 const connect=()=>new Promise((resolve,reject)=>{
  const req=http.request(f.origin+'/browser/room/api/ws',{headers:{cookie:'test=session',origin:f.origin,Connection:'Upgrade',Upgrade:'websocket'}});
  req.on('upgrade',(_res,socket)=>resolve(socket));req.on('error',reject);req.end();
 });
 const a=await connect(),b=await connect();
 for(const [socket,text]of [[a,'viewer-a'],[b,'viewer-b'],[a,'viewer-a-still-connected']]){
  const reply=new Promise(r=>socket.once('data',data=>r(data.toString())));socket.write(text);assert.equal(await reply,text);
 }
 a.destroy();b.destroy();
});

test('configured CDN origin works for HTTP and WebSocket despite origin host rewriting',async t=>{
 const f=await fixture(t);
 const response=await fetch(f.origin+'/browser/room/api/login',{method:'POST',headers:{cookie:'test=session',origin:'https://cdn.example'}});
 assert.equal(response.status,200);
 const socket=await new Promise((resolve,reject)=>{
  const req=http.request(f.origin+'/browser/room/api/ws',{headers:{cookie:'test=session',origin:'https://cdn.example',Connection:'Upgrade',Upgrade:'websocket'}});
  req.on('upgrade',(_res,s)=>resolve(s));req.on('response',r=>reject(Error('upgrade rejected '+r.statusCode)));req.on('error',reject);req.end();
 });
 const reply=new Promise(r=>socket.once('data',d=>r(d.toString())));socket.write('cdn viewer');assert.equal(await reply,'cdn viewer');socket.destroy();
});
