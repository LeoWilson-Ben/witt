"use strict";

const fs = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const run = promisify(execFile);
const cache = new Map();
const { discoverServiceStatus } = require("./service-status");
const units = [
  ["witt", "维特服务", "drop-vault.service"],
  ["gateway", "网页入口", "nginx.service"],
  ["builder", "远程构建调度", "xuanyu-builder.service"],
];

const CLUSTER_SERVERS = [
  {
    id: "tokyo-witt",
    name: "日本东京 · Witt 主服",
    hostname: "witt-server",
    region: "日本东京",
    flag: "🇯🇵",
    provider: "GCP · asia-northeast1-b",
    ip: "136.110.95.193",
    spec: "2C / 8G / 80G",
    role: "Witt 后端 · Nginx · Xray",
    isLocal: true,
    serviceChecks: [
      { label: "Witt", unit: "witt.service" },
      { label: "Nginx", unit: "nginx.service" },
      { label: "Xray", unit: "xray.service" },
    ],
  },
  {
    id: "tw-vpn",
    name: "台湾彰化 · VPN 节点",
    hostname: "tw-vpn",
    region: "台湾彰化",
    flag: "🇹🇼",
    provider: "GCP · asia-east1-b",
    ip: "34.80.144.220",
    spec: "2共享C / 1G / 10G",
    role: "Xray Reality 节点",
    isLocal: false,
    tcpChecks: [
      { label: "Xray Reality", port: 443 },
    ],
  },
  {
    id: "shanghai-aliyun",
    name: "中国上海 · 阿里云中继",
    hostname: "Ubuntu-kmzb",
    region: "中国上海",
    flag: "🇨🇳",
    provider: "阿里云 SWAS · cn-shanghai",
    ip: "47.100.76.46",
    spec: "2C / 2G / 200M 峰值",
    role: "RustDesk 国内中继",
    isLocal: false,
    tcpChecks: [
      { label: "RustDesk ID", port: 21116 },
      { label: "RustDesk 中继", port: 21117 },
    ],
  },
];

async function exists(file) {
  try { return (await fs.stat(file)).isFile(); } catch { return false; }
}

async function serviceState(unit) {
  try {
    const { stdout } = await run("systemctl", ["show", unit, "--property=ActiveState", "--value"],
      { timeout: 2500, maxBuffer: 1024 });
    const value = stdout.trim();
    return ["active", "inactive", "failed", "activating", "deactivating"].includes(value) ? value : "unknown";
  } catch { return "unknown"; }
}

function probeTcp(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    const socket = net.createConnection({ host, port });
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ ok, latencyMs: ok ? Math.max(1, Date.now() - startedAt) : null });
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function readLocalMetrics() {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  const gb = 1024 ** 3;
  return {
    cpuCount: os.cpus().length,
    load1m: Number((os.loadavg()[0] || 0).toFixed(2)),
    memTotalGb: Number((totalBytes / gb).toFixed(1)),
    memUsedGb: Number((usedBytes / gb).toFixed(1)),
    memPercent: Math.round((usedBytes / Math.max(1, totalBytes)) * 100),
    uptimeSec: Math.floor(os.uptime()),
  };
}

async function probeServerCluster({
  servers = CLUSTER_SERVERS,
  tcpProbe = probeTcp,
  unitProbe = serviceState,
  localMetrics = readLocalMetrics,
} = {}) {
  return Promise.all(servers.map(async (server) => {
    let checks = [];
    let latencyMs = null;
    let metrics = null;
    if (server.isLocal) {
      checks = await Promise.all((server.serviceChecks || []).map(async (item) => {
        const state = await unitProbe(item.unit);
        return { label: item.label, ok: state === "active", state };
      }));
      latencyMs = 0;
      metrics = localMetrics();
    } else {
      checks = await Promise.all((server.tcpChecks || []).map(async (item) => {
        const result = await tcpProbe(server.ip, item.port, 2500);
        return { label: item.label, port: item.port, ok: Boolean(result.ok), latencyMs: result.latencyMs ?? null };
      }));
      const okLatencies = checks.map((c) => c.latencyMs).filter((ms) => Number.isFinite(ms));
      latencyMs = okLatencies.length ? Math.min(...okLatencies) : null;
    }
    const okCount = checks.filter((c) => c.ok).length;
    const status = checks.length === 0 ? "unknown"
      : okCount === checks.length ? "online"
      : okCount > 0 ? "degraded"
      : "offline";
    return {
      id: server.id,
      name: server.name,
      hostname: server.hostname,
      region: server.region,
      flag: server.flag,
      provider: server.provider,
      ip: server.ip,
      spec: server.spec,
      role: server.role,
      isLocal: Boolean(server.isLocal),
      status,
      latencyMs,
      metrics,
      checks,
    };
  }));
}

// Status checks are read-only and demand-driven. Never return credential contents or
// infer that a present file means authentication succeeded. Cache per user directory.
async function workspaceOverview({ workDir = "", dataDir = "", includeAllServices = false } = {}) {
  const key = JSON.stringify([workDir, dataDir, includeAllServices]);
  const previous = cache.get(key);
  if (previous && Date.now() - previous.at < 5000) return previous.promise;
  const promise = (async () => {
    const resolvedWorkDir = path.resolve(workDir || "/nonexistent");
    const isXuanyu = resolvedWorkDir === "/data/xuanyu-build-console" || resolvedWorkDir.startsWith("/data/xuanyu-build-console/");
    const services = await Promise.all(units.filter(([id]) => id !== "builder" || isXuanyu)
      .map(async ([id, name, unit]) => ({ id, name, status: await serviceState(unit) })));
    const [discovery, serverCluster] = await Promise.all([
      includeAllServices ? discoverServiceStatus() : Promise.resolve({ services, serviceDiscovery: { available: true, complete: true, scope: "limited" } }),
      includeAllServices ? probeServerCluster() : Promise.resolve([]),
    ]);
    const connections = [];
    if (isXuanyu) {
      const appleKeyPresent = dataDir && await exists(path.join(dataDir,
        "1788402438723-42600f64-c89d-49c3-bd7c-fbf806af024f.p8"));
      connections.push({ id: "apple", name: "App Store Connect", status: appleKeyPresent ? "configured_unverified" : "unconfigured",
        detail: appleKeyPresent ? "已找到该账号上传的密钥；此面板未发起认证，也不代表连接有效。" : "未找到已登记的密钥文件；可在对话中指定安全的凭据位置。" });
      connections.push({ id: "huawei", name: "华为应用市场", status: "unverified",
        detail: "未配置自动连接检查。可在对话中请求只读验证已有授权。" });
    }
    return {
      checkedAt: new Date().toISOString(),
      projects: [{ id: "current", name: isXuanyu ? "玄遇工作区" : "当前工作区", workDir,
        description: "对话按项目归类；凭据不保存在项目标签中。" }],
      servers: isXuanyu ? [
        { name: "业务服务器", role: "运行维特、接口与构建调度；不执行玄遇 APK 编译。" },
        { name: "远程构建机", role: "执行玄遇 Android 编译；未在此面板唤醒或轮询远程主机。" },
      ] : [{ name: "当前服务器", role: "运行维特与当前工作区服务。" }],
      ...(includeAllServices ? { serverCluster } : {}),
      ...discovery, connections,
      notice: "仅在打开面板时查询。服务运行状态来自 systemd；未运行不一定异常，定时与按需服务执行后会停止。这里不显示凭据。",
    };
  })();
  cache.set(key, { at: Date.now(), promise });
  if (cache.size > 32) cache.delete(cache.keys().next().value);
  try { return await promise; } catch (error) { cache.delete(key); throw error; }
}

module.exports = { workspaceOverview, probeServerCluster, CLUSTER_SERVERS };
