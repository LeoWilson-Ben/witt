"use strict";
const http = require("node:http");
const { createBrowserOriginChecker } = require("../core/http-utils");

function createNekoProxy({ principalFor, port = 8095,
  allowedOrigins = new Set(String(process.env.WITT_ALLOWED_ORIGINS || "").split(",").map(s=>s.trim()).filter(Boolean)) }) {
  const originAllowed = createBrowserOriginChecker(allowedOrigins);
  const prefix = "/browser/room/";
  function headersFor(req) {
    const headers = { ...req.headers, host: `127.0.0.1:${port}` };
    // Witt credentials are checked here and must never reach the browser container.
    delete headers.cookie;
    if (headers.authorization && principalFor({ ...req, headers: { ...req.headers, cookie: "" } })) {
      delete headers.authorization;
    }
    return headers;
  }
  function pathFor(url) { return `/vault-api${url.pathname}${url.search}`; }
  function handle(req, res, url, principal) {
    if (!url.pathname.startsWith(prefix)) return false;
    if (!principal?.admin) { res.writeHead(401);res.end();return true; }
    if(req.headers.origin && !originAllowed(req)){res.writeHead(403);res.end();return true;}
    const upstream = http.request({host:"127.0.0.1",port,path:pathFor(url),method:req.method,headers:headersFor(req)}, response => {
      const headers = {...response.headers, "cache-control":"no-store"};
      delete headers["set-cookie"];
      res.writeHead(response.statusCode, headers);response.pipe(res);
    });
    upstream.on("error",()=>{if(!res.headersSent)res.writeHead(502);res.end("Browser unavailable");});
    req.on("aborted",()=>upstream.destroy());res.on("close",()=>upstream.destroy());req.pipe(upstream);
    return true;
  }
  function attachUpgrade(server) {
    server.on("upgrade",(req,socket,head)=>{
      const url=new URL(req.url,"http://localhost");if(!url.pathname.startsWith(prefix))return;
      if(!principalFor(req)?.admin){socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");return;}
      if(req.headers.origin && !originAllowed(req)){socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");return;}
      const upstream=http.request({host:"127.0.0.1",port,path:pathFor(url),headers:headersFor(req)});
      upstream.on("upgrade",(response,peer,upHead)=>{
        let status=`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`;
        for(const [name,value]of Object.entries(response.headers))status+=`${name}: ${value}\r\n`;
        socket.write(status+"\r\n");if(upHead.length)socket.write(upHead);if(head.length)peer.write(head);
        socket.pipe(peer);peer.pipe(socket);socket.on("close",()=>peer.destroy());peer.on("close",()=>socket.destroy());peer.on("error",()=>socket.destroy());
      });
      upstream.on("response",response=>{socket.end(`HTTP/1.1 ${response.statusCode}\r\nConnection: close\r\n\r\n`);response.resume();});
      upstream.on("error",()=>socket.destroy());socket.on("error",()=>upstream.destroy());upstream.end();
    });
  }
  return {handle,attachUpgrade};
}
module.exports={createNekoProxy};
