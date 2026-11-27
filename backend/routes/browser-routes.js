"use strict";

const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const { createNekoProxy } = require("./neko-proxy");

function checkTcpPort(port, host = "127.0.0.1", timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function httpJsonRequest({ host = "127.0.0.1", port = 9222, path = "/json/list", method = "GET", timeoutMs = 2000 }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, path, method, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          resolve({ status: res.statusCode || 0, data: JSON.parse(text) });
        } catch {
          resolve({ status: res.statusCode || 0, data: text });
        }
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error("CDP request timeout"));
    });
    req.on("error", reject);
    req.end();
  });
}

function runSystemctl(args) {
  return new Promise((resolve, reject) => {
    execFile("systemctl", args, { timeout: 15000 }, (error, stdout, stderr) => {
      if (error) {
        const err = new Error(String(stderr || error.message || "systemctl failed").trim());
        err.code = error.code;
        reject(err);
        return;
      }
      resolve(String(stdout || "").trim());
    });
  });
}

function createBrowserRouter({
  serviceName = "witt-browser.service",
  wsPort = Number(process.env.WITT_BROWSER_WS_PORT || 6080),
  cdpPort = Number(process.env.WITT_CHROME_CDP_PORT || 9222),
  viewportWidth = Number(process.env.WITT_CHROME_WIDTH || 1280),
  viewportHeight = Number(process.env.WITT_CHROME_HEIGHT || 800),
  sendJson,
  readJsonBody,
  principalFor,
  collaborationEnabled = () => fs.existsSync("/var/lib/witt/neko/public-ready"),
}) {
  const neko = createNekoProxy({ principalFor });
  const tickets = new Map();
  const TICKET_TTL_MS = 60_000;

  function pruneTickets() {
    const now = Date.now();
    for (const [token, info] of tickets.entries()) {
      if (info.expiresAt <= now) tickets.delete(token);
    }
    while (tickets.size > 32) {
      const oldest = tickets.keys().next().value;
      if (!oldest) break;
      tickets.delete(oldest);
    }
  }

  function issueTicket(principal) {
    pruneTickets();
    const token = crypto.randomBytes(24).toString("hex");
    tickets.set(token, {
      principalId: principal.id || principal.deviceId || "admin",
      expiresAt: Date.now() + TICKET_TTL_MS,
    });
    return token;
  }

  function consumeTicket(token) {
    if (!token || !/^[a-f0-9]{48}$/.test(token)) return false;
    pruneTickets();
    const info = tickets.get(token);
    if (!info) return false;
    tickets.delete(token);
    return info.expiresAt > Date.now();
  }

  async function getStatus() {
    let serviceActive = false;
    try {
      const out = await runSystemctl(["is-active", serviceName]);
      serviceActive = out === "active";
    } catch {
      serviceActive = false;
    }
    const [vncReady, cdpReady] = await Promise.all([
      checkTcpPort(wsPort),
      checkTcpPort(cdpPort),
    ]);
    let tabs = [];
    if (cdpReady) {
      try {
        const res = await httpJsonRequest({ port: cdpPort, path: "/json/list" });
        if (Array.isArray(res.data)) {
          tabs = res.data
            .filter((item) => item && item.type === "page")
            .slice(0, 12)
            .map((item) => ({
              id: String(item.id || ""),
              title: String(item.title || "新标签页"),
              url: String(item.url || ""),
            }));
        }
      } catch {}
    }
    return {
      ok: true,
      running: serviceActive && vncReady,
      serviceActive,
      vncReady,
      cdpReady,
      viewport: { width: viewportWidth, height: viewportHeight },
      tabs,
    };
  }

  async function waitUntilReady(timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await getStatus();
      if (status.vncReady) return status;
      await new Promise((r) => setTimeout(r, 350));
    }
    return getStatus();
  }

  function handle(req, res, url, principal) {
    if (!url.pathname.startsWith("/browser/")) return false;
    if (!principal || !principal.admin) {
      sendJson(res, 403, { error: "仅管理员可使用服务器浏览器" });
      return true;
    }

    if (neko.handle(req, res, url, principal)) return true;
    if (req.method === "GET" && url.pathname === "/browser/collaboration/status") {
      checkTcpPort(8095).then(running=>sendJson(res,200,{ok:true,running,mode:"neko",publicReady:collaborationEnabled()}));return true;
    }
    if (req.method === "POST" && url.pathname === "/browser/connect") {
      if (!collaborationEnabled()) {
        (async()=>{
          let status=await getStatus();
          if(!status.vncReady){await runSystemctl(["start",serviceName]);status=await waitUntilReady(9000);}
          if(!status.vncReady)throw Error("兼容浏览器尚未就绪");
          const ticket=issueTicket(principal);
          const wsPath=encodeURIComponent(`vault-api/browser/ws?ticket=${ticket}`);
          sendJson(res,200,{ok:true,mode:"legacy",publicReady:false,viewerUrl:`/vault/novnc/vnc_lite.html?path=${wsPath}&scale=true`,status});
        })().catch(()=>sendJson(res,503,{error:"浏览器尚未就绪"}));
        return true;
      }
      checkTcpPort(8095).then(ready => {
        if (!ready) { sendJson(res, 503, { error: "协作浏览器尚未就绪，可使用兼容模式" });return; }
        const name = encodeURIComponent(String(principal.label || "维特用户").slice(0,48));
        sendJson(res,200,{ok:true,mode:"neko",viewerUrl:`/vault-api/browser/room/?usr=${name}&pwd=member&lang=zh-CN`});
      });
      return true;
    }
    if (req.method === "POST" && url.pathname === "/browser/collaboration/fit") {
      (async()=>{
        const body=await readJsonBody(req);
        const w=Number(body?.width),h=Number(body?.height);
        if(!Number.isFinite(w)||!Number.isFinite(h)||w<200||h<150||w>8000||h>8000)throw Error("窗口尺寸无效");
        const scale=Math.max(1,640/w,480/h);
        const cap=Math.min(scale,1920/w,1440/h);
        const width=Math.max(320,Math.floor(w*cap/8)*8),height=Math.max(240,Math.floor(h*cap/8)*8);
        const base="http://127.0.0.1:8095/vault-api/browser/room/api";
        const login=await fetch(`${base}/login`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({username:"显示调整",password:""}),signal:AbortSignal.timeout(4000)});
        const session=await login.json();if(!login.ok||!session.token)throw Error("显示服务不可用");
        const headers={"content-type":"application/json",authorization:`Bearer ${session.token}`};
        try{
          const response=await fetch(`${base}/room/screen/`,{method:"POST",headers,body:JSON.stringify({width,height,rate:30}),signal:AbortSignal.timeout(10000)});
          if(!response.ok)throw Error("调整画面失败");
          sendJson(res,200,{ok:true,width,height});
        }finally{await fetch(`${base}/logout`,{method:"POST",headers,signal:AbortSignal.timeout(2000)}).catch(()=>{});}
      })().catch(()=>sendJson(res,400,{error:"暂时无法调整画面尺寸，请稍后重试"}));
      return true;
    }
    if (req.method === "POST" && url.pathname === "/browser/collaboration/navigate") {
      readJsonBody(req).then(async body => {
        let raw=String(body?.url||"").trim();if(!raw)throw Error("请输入网址");
        if(!/^https?:\/\//i.test(raw))raw=`https://${raw}`;
        const target=new URL(raw);if(!["http:","https:"].includes(target.protocol))throw Error("仅支持 http/https 网址");
        const result=await httpJsonRequest({port:9223,path:`/json/new?${encodeURIComponent(target.href)}`,method:"PUT"});
        if(result.status!==200)throw Error("打开网址失败");sendJson(res,200,{ok:true});
      }).catch(()=>sendJson(res,400,{error:"无法打开网址，请检查网址或在浏览器内输入"}));
      return true;
    }
    if (req.method === "GET" && url.pathname === "/browser/status") {
      getStatus()
        .then((status) => sendJson(res, 200, status))
        .catch((err) => sendJson(res, 500, { error: err.message || "无法读取浏览器状态" }));
      return true;
    }

    if (req.method === "POST" && url.pathname === "/browser/start") {
      runSystemctl(["start", serviceName])
        .then(() => waitUntilReady(9000))
        .then((status) => sendJson(res, 200, status))
        .catch((err) => sendJson(res, 500, { error: err.message || "启动服务器浏览器失败" }));
      return true;
    }

    if (req.method === "POST" && url.pathname === "/browser/stop") {
      runSystemctl(["stop", serviceName])
        .then(() => getStatus())
        .then((status) => sendJson(res, 200, status))
        .catch((err) => sendJson(res, 500, { error: err.message || "停止服务器浏览器失败" }));
      return true;
    }

    if (req.method === "POST" && url.pathname === "/browser/restart") {
      runSystemctl(["restart", serviceName])
        .then(() => waitUntilReady(9000))
        .then((status) => sendJson(res, 200, status))
        .catch((err) => sendJson(res, 500, { error: err.message || "重启服务器浏览器失败" }));
      return true;
    }

    if (req.method === "POST" && url.pathname === "/browser/ticket") {
      (async () => {
        let status = await getStatus();
        if (!status.vncReady) {
          await runSystemctl(["start", serviceName]);
          status = await waitUntilReady(9000);
        }
        if (!status.vncReady) {
          sendJson(res, 503, { error: "服务器浏览器尚未就绪，请稍后重试", status });
          return;
        }
        const ticket = issueTicket(principal);
        sendJson(res, 200, {
          ok: true,
          ticket,
          wsPath: `vault-api/browser/ws?ticket=${ticket}`,
          expiresInMs: TICKET_TTL_MS,
          status,
        });
      })().catch((err) => sendJson(res, 500, { error: err.message || "无法创建浏览器会话" }));
      return true;
    }

    if (req.method === "POST" && url.pathname === "/browser/navigate") {
      readJsonBody(req)
        .then(async (body) => {
          let raw = String(body?.url || "").trim();
          if (!raw) {
            sendJson(res, 400, { error: "请输入网址" });
            return;
          }
          if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
          let parsed;
          try {
            parsed = new URL(raw);
          } catch {
            sendJson(res, 400, { error: "网址格式无效" });
            return;
          }
          if (!["http:", "https:"].includes(parsed.protocol)) {
            sendJson(res, 400, { error: "仅支持 http/https 网址" });
            return;
          }
          let status = await getStatus();
          if (!status.cdpReady) {
            await runSystemctl(["start", serviceName]);
            status = await waitUntilReady(9000);
          }
          if (!status.cdpReady) {
            sendJson(res, 503, { error: "Chrome 调试接口尚未就绪" });
            return;
          }
          const encoded = encodeURIComponent(parsed.toString());
          const result = await httpJsonRequest({
            port: cdpPort,
            path: `/json/new?${encoded}`,
            method: "PUT",
            timeoutMs: 4000,
          });
          sendJson(res, 200, { ok: true, url: parsed.toString(), tab: result.data });
        })
        .catch((err) => sendJson(res, 500, { error: err.message || "打开网址失败" }));
      return true;
    }

    sendJson(res, 404, { error: "浏览器接口不存在" });
    return true;
  }

  function attachUpgrade(server) {
    neko.attachUpgrade(server);
    server.on("upgrade", (req, socket, head) => {
      let parsed;
      try {
        parsed = new URL(req.url, "http://localhost");
      } catch {
        return;
      }
      if (parsed.pathname !== "/browser/ws") return;

      const ticket = parsed.searchParams.get("ticket") || "";
      const ticketValid = consumeTicket(ticket);
      const principal = !ticketValid && typeof principalFor === "function" ? principalFor(req) : null;
      if (!ticketValid && (!principal || !principal.admin)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }

      const upstream = net.connect({ host: "127.0.0.1", port: wsPort });
      let closed = false;
      const closeBoth = () => {
        if (closed) return;
        closed = true;
        socket.destroy();
        upstream.destroy();
      };

      upstream.once("connect", () => {
        const lines = [
          "GET /websockify HTTP/1.1",
          `Host: 127.0.0.1:${wsPort}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
        ];
        if (req.headers["sec-websocket-key"]) {
          lines.push(`Sec-WebSocket-Key: ${req.headers["sec-websocket-key"]}`);
        }
        if (req.headers["sec-websocket-version"]) {
          lines.push(`Sec-WebSocket-Version: ${req.headers["sec-websocket-version"]}`);
        }
        if (req.headers["sec-websocket-protocol"]) {
          lines.push(`Sec-WebSocket-Protocol: ${req.headers["sec-websocket-protocol"]}`);
        }
        if (req.headers["sec-websocket-extensions"]) {
          lines.push(`Sec-WebSocket-Extensions: ${req.headers["sec-websocket-extensions"]}`);
        }
        lines.push("", "");
        upstream.write(lines.join("\r\n"));
        if (head && head.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });

      upstream.on("error", () => {
        if (!closed) {
          try { socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"); } catch {}
        }
        closeBoth();
      });
      socket.on("error", closeBoth);
      upstream.on("close", closeBoth);
      socket.on("close", closeBoth);
    });
  }

  return { handle, attachUpgrade, getStatus };
}

module.exports = { createBrowserRouter };
