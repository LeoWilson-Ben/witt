"use strict";
const http=require("node:http");
const fs=require("node:fs");
const path=require("node:path");
const {AuthService}=require("./auth-service");
const {sendJson,readJsonBody,createBrowserOriginChecker}=require("./core/http-utils");
const originAllowed=createBrowserOriginChecker(new Set(String(process.env.WITT_ALLOWED_ORIGINS||"").split(",").map(s=>s.trim()).filter(Boolean)));
const {createBrowserRouter}=require("./routes/browser-routes");
const authDir=process.env.DROP_VAULT_AUTH_DIR||"/var/lib/witt/runtime/auth";
if(!fs.existsSync(path.join(authDir,"auth.sqlite")))throw Error("Existing Witt authentication database is required");
// The chat server owns authentication writes. This gateway only validates sessions.
class ReadOnlyBrowserAuth extends AuthService {write() {}}
const auth=new ReadOnlyBrowserAuth({dir:authDir,sendJson,readJsonBody});
function principalFor(req){
 const bearer=auth.authenticate(req.headers.authorization);if(bearer)return bearer;
 const value=String(req.headers.cookie||"").split(";").map(s=>s.trim()).find(s=>s.startsWith("witt_session="));
 try{return value?auth.authenticateToken(decodeURIComponent(value.slice(13))):null;}catch{return null;}
}
const router=createBrowserRouter({principalFor,sendJson,readJsonBody});
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,"http://localhost");
 if(url.pathname==="/health"){sendJson(res,200,{ok:true});return;}
 const principal=principalFor(req);if(!principal?.admin){sendJson(res,401,{error:"请先登录维特"});return;}
 if(req.headers.origin&&!originAllowed(req)){sendJson(res,403,{error:"请求来源无效"});return;}
 if(!["GET","HEAD"].includes(req.method)&&!req.headers.origin&&!auth.authenticate(req.headers.authorization)){
  sendJson(res,403,{error:"需要同源请求"});return;
 }
 if(!router.handle(req,res,url,principal))sendJson(res,404,{error:"接口不存在"});
});
router.attachUpgrade(server);
server.listen(3004,"127.0.0.1",()=>console.log("Witt browser gateway ready"));
