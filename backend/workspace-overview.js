"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const run = promisify(execFile);
const cache = new Map();
const units = [
  ["witt", "维特服务", "drop-vault.service"],
  ["gateway", "网页入口", "nginx.service"],
  ["builder", "远程构建调度", "xuanyu-builder.service"],
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

// Status checks are read-only and demand-driven. Never return credential contents or
// infer that a present file means authentication succeeded. Cache per user directory.
async function workspaceOverview({ workDir = "", dataDir = "" } = {}) {
  const key = JSON.stringify([workDir, dataDir]);
  const previous = cache.get(key);
  if (previous && Date.now() - previous.at < 15000) return previous.promise;
  const promise = (async () => {
    const resolvedWorkDir = path.resolve(workDir || "/nonexistent");
    const isXuanyu = resolvedWorkDir === "/data/xuanyu-build-console" || resolvedWorkDir.startsWith("/data/xuanyu-build-console/");
    const services = await Promise.all(units.filter(([id]) => id !== "builder" || isXuanyu)
      .map(async ([id, name, unit]) => ({ id, name, status: await serviceState(unit) })));
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
      services, connections,
      notice: "仅在打开面板时查询。文件存在不等于授权有效；这里不显示密钥、Token、发布版本或审核状态。",
    };
  })();
  cache.set(key, { at: Date.now(), promise });
  if (cache.size > 32) cache.delete(cache.keys().next().value);
  try { return await promise; } catch (error) { cache.delete(key); throw error; }
}

module.exports = { workspaceOverview };
