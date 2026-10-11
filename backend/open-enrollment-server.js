"use strict";

const http = require("node:http");
const fs = require("node:fs");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const PROFILES = ["default", "xuanyu", "account4", "account5"];

function createOpenEnrollmentServer(options) {
  const pending = new Set();
  const limits = new Map();
  const send = (res, status, body) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };
  async function api(endpoint, method, body, token) {
    const response = await fetch(`${options.apiBase}${endpoint}`, {
      method,
      headers: { Authorization: `Bearer ${token || options.adminToken()}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("upstream failed");
    return response.json();
  }
  return http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      send(res, 200, { ok: true, enabled: options.enabled() }); return;
    }
    if (req.method !== "POST" || req.url !== "/auth/open-enroll") {
      send(res, 404, { error: "接口不存在" }); return;
    }
    if (!options.enabled()) {
      send(res, 503, { error: "开放版暂时停止登记，请稍后重试" }); return;
    }
    let deviceId;
    let createdDevice = false;
    let claimed = false;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4096) { send(res, 413, { error: "请求过大" }); return; }
        chunks.push(chunk);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { send(res, 400, { error: "请求格式无效" }); return; }
      if (!body || typeof body !== "object" || !UUID.test(String(body.deviceId || ""))) {
        send(res, 400, { error: "设备编号无效" }); return;
      }
      deviceId = body.deviceId.toLowerCase();
      if (pending.has(deviceId)) {
        send(res, 409, { error: "设备正在登记，请稍后重试" }); return;
      }
      const ip = String(req.headers["x-real-ip"] || req.socket.remoteAddress);
      const now = Date.now();
      for (const [key, value] of limits) if (value.until <= now) limits.delete(key);
      const rate = limits.get(ip) || { count: 0, until: now + 3_600_000 };
      if (rate.count >= (options.maxRegistrationsPerHour || 30)) {
        send(res, 429, { error: "设备登记过于频繁，请稍后重试" }); return;
      }
      rate.count++;
      limits.set(ip, rate);
      pending.add(deviceId);
      claimed = true;
      const devices = await api("admin/devices", "GET");
      if (devices.devices.some((device) => device.id === deviceId)) {
        send(res, 409, { error: "设备已登记，请使用本机已有的登录凭据" }); return;
      }
      const label = `开放版 ${String(body.deviceName || "设备").slice(0, 40)}`;
      // Use the existing auth APIs so all auth writes remain in the main process.
      // The one-use invite stays on the server and is never returned to clients.
      const invite = await api("admin/invites", "POST", { label, maxDevices: 1, admin: false });
      const activation = await api("auth/activate", "POST", {
        inviteCode: invite.invite.code, deviceId, deviceName: label,
      });
      createdDevice = true;
      await api(`admin/users/${activation.principal.userId}/policy`, "POST", {
        codexProfiles: PROFILES, unrestrictedModels: true,
      });
      const status = await api("auth/status", "GET", null, activation.token);
      if (!status.authenticated || status.principal.admin ||
          !status.principal.unrestrictedModels ||
          PROFILES.some((profile) => !status.principal.codexProfiles.includes(profile))) {
        throw new Error("policy verification failed");
      }
      send(res, 201, { token: activation.token, principal: status.principal });
    } catch {
      if (createdDevice) {
        try { await api(`admin/devices/${deviceId}/disable`, "POST", {}); } catch {}
      }
      // Never log upstream response bodies or any credential.
      if (!res.headersSent) send(res, 503, { error: "自动登录暂时失败，请稍后重试" });
    } finally {
      if (claimed) pending.delete(deviceId);
    }
  });
}

if (require.main === module) {
  const configPath = process.env.WITT_OPEN_CONFIG || "/data/drop-vault/auth/open-enrollment.json";
  const tokenPath = process.env.WITT_OPEN_ADMIN_TOKEN || "/data/drop-vault/auth/open-enrollment-service.token";
  const enabled = () => {
    try { return JSON.parse(fs.readFileSync(configPath, "utf8")).enabled === true; }
    catch { return false; }
  };
  createOpenEnrollmentServer({
    apiBase: "http://127.0.0.1:3003/",
    adminToken: () => fs.readFileSync(tokenPath, "utf8").trim(),
    enabled,
  }).listen(3004, "127.0.0.1", () => console.log("Witt open enrollment listening on loopback"));
}

module.exports = { createOpenEnrollmentServer };
