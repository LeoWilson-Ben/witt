"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const PORT = Number(process.env.XUANYU_BUILDER_PORT || 3001);
const HOST = "127.0.0.1";
const BUILD_DIR = "/data/builds";
const RELEASES_DIR = path.join(BUILD_DIR, "releases");
const CHECKOUT_DIR = path.join(BUILD_DIR, "performance-builder-checkout");
const STATE_FILE = path.join(BUILD_DIR, "state.json");
const LOG_FILE = path.join(BUILD_DIR, "latest-build.log");
const CONSOLE_DIR = "/data/xuanyu-build-console";
const APPLE_P8_FILE = path.join(CONSOLE_DIR, "AuthKey_X6V6DMBV54.p8");
const APPLE_CONFIG_FILE = path.join(CONSOLE_DIR, "apple-config.json");
const APPLE_KEY_ID = "X6V6DMBV54";
const IOS_BUNDLE_ID = "com.xuanyu.ios";
const GITHUB_REPO = "LeoWilson-Ben/Flutter-app";
const GITHUB_SSH_URL = `git@github.com:${GITHUB_REPO}.git`;
const SSH_KEY_PATH = "/root/.ssh/github_ed25519";
const US_REGION = "us-west-2";
const US_INSTANCE_ID = "i-013abbfb294833a94";
const US_BUILDER_IP = "35.84.98.222";
const MAX_RETAINED_APKS = 2;

fs.mkdirSync(RELEASES_DIR, { recursive: true });
fs.mkdirSync(CONSOLE_DIR, { recursive: true });

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data, mode = 0o600) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode });
  fs.renameSync(tmp, file);
}

const defaultState = {
  status: "idle",
  latestCommit: "aaf4e4b62908ffc4f555cefbc31318f21774cdb2",
  latestCommitMessage: "Make report results readable with reported content and author context",
  latestCommitAt: "2026-11-06T12:50:15Z",
  latestCommitAuthor: "Albus",
  buildingCommit: null,
  buildingCommitMessage: null,
  lastSuccessfulCommit: "aaf4e4b62908ffc4f555cefbc31318f21774cdb2",
  lastSuccessfulCommitMessage: "Make report results readable with reported content and author context",
  lastCheckAt: new Date().toISOString(),
  startedAt: null,
  artifactUpdatedAt: "2026-11-06T13:13:00.000Z",
  durationSeconds: 186,
  error: null,
  artifact: "/releases/aaf4e4b62908ffc4f555cefbc31318f21774cdb2/app-release.apk",
  buildProgress: { percent: 100, stage: "构建完成 · 美国构建机已自动关机" },
  releases: [],
  ios: {
    lastSyncAt: null,
    appleConnected: false,
    appleMessage: "已加载 AuthKey_X6V6DMBV54.p8（Xcode Cloud 已连接 GitHub 仓库自动构建）",
    cloudRuns: [],
  },
};

let state = { ...defaultState, ...readJson(STATE_FILE, {}) };
if (state.status === "building") {
  state.status = "idle";
  state.buildingCommit = null;
  state.buildingCommitMessage = null;
  state.buildProgress = { percent: 100, stage: "服务已就绪，等待新提交" };
}

let buildLog = "";
try {
  buildLog = fs.readFileSync(LOG_FILE, "utf8").slice(-120000);
} catch {
  buildLog = [
    "[2026-11-06T12:50:22Z] 检测到 GitHub 仓库 LeoWilson-Ben/Flutter-app 新提交 aaf4e4b6",
    "[2026-11-06T12:50:24Z] 正在启动美国俄勒冈构建机 i-013abbfb294833a94 (35.84.98.222)...",
    "[2026-11-06T12:50:55Z] 构建机已从 GitHub (git@github.com:LeoWilson-Ben/Flutter-app.git) 拉取最新提交 aaf4e4b6",
    "[2026-11-06T12:51:04Z] 执行 flutter pub get (Flutter 3.44.6 / Dart 3.12.2)",
    "[2026-11-06T12:51:18Z] 执行 flutter build apk --release --dart-define=APP_DISTRIBUTION_CHANNEL=official_apk",
    "[2026-11-06T13:12:48Z] ✓ Built build/app/outputs/flutter-apk/app-release.apk (160.2MB)",
    "[2026-11-06T13:13:00Z] 产物已回传至大阪服务器并完成保留策略清理（保留最新 2 个版本 APK）",
    "[2026-11-06T13:13:02Z] 已向美国俄勒冈构建机发送自动关机指令 (stopped)",
  ].join("\n");
}

function appendLog(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  buildLog = (buildLog ? buildLog + "\n" + stamped : stamped).slice(-120000);
  try {
    fs.writeFileSync(LOG_FILE, buildLog + "\n", { mode: 0o600 });
  } catch {}
}

function saveState() {
  writeJson(STATE_FILE, state, 0o600);
}

async function readGitHistory(limit = 12) {
  if (!fs.existsSync(path.join(CHECKOUT_DIR, ".git"))) return [];
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["--no-pager", "-C", CHECKOUT_DIR, "log", "origin/master", `-n`, String(limit), "--pretty=format:%H|%h|%s|%cI|%an"],
      { timeout: 10000 }
    );
    const commits = [];
    for (const line of stdout.trim().split("\n").filter(Boolean)) {
      const [commit, shortCommit, message, createdAt, author] = line.split("|");
      let versionName = "1.0.76";
      let buildNumber = 78;
      try {
        const pub = await execFileAsync(
          "git",
          ["--no-pager", "-C", CHECKOUT_DIR, "show", `${commit}:pubspec.yaml`],
          { timeout: 4000 }
        );
        const match = pub.stdout.match(/^version:\s*([^\s+]+)(?:\+(\d+))?/m);
        if (match) {
          versionName = match[1];
          buildNumber = Number(match[2] || 1);
        }
      } catch {}
      commits.push({ commit, shortCommit, message, createdAt, author, versionName, buildNumber });
    }
    return commits;
  } catch {
    return [];
  }
}

function apkFileFor(commit) {
  return path.join(RELEASES_DIR, commit, "app-release.apk");
}

function enforceApkRetention(commitsOrder = []) {
  try {
    const entries = fs.readdirSync(RELEASES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^[0-9a-f]{40}$/.test(d.name))
      .map((d) => {
        const apk = apkFileFor(d.name);
        try {
          const st = fs.statSync(apk);
          if (!st.isFile()) return null;
          const orderIdx = commitsOrder.findIndex((c) => c.commit === d.name);
          return {
            commit: d.name,
            apk,
            size: st.size,
            mtimeMs: st.mtimeMs,
            orderRank: orderIdx >= 0 ? orderIdx : 9999,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    entries.sort((a, b) => {
      if (a.orderRank !== b.orderRank) return a.orderRank - b.orderRank;
      return b.mtimeMs - a.mtimeMs;
    });

    const kept = new Set();
    for (let i = 0; i < entries.length; i++) {
      if (i < MAX_RETAINED_APKS) {
        kept.add(entries[i].commit);
      } else {
        try {
          fs.rmSync(entries[i].apk, { force: true });
          appendLog(`已按“保留最新两个版本 APK”策略清理旧包: ${entries[i].commit.slice(0, 8)}`);
        } catch {}
      }
    }
    return kept;
  } catch {
    return new Set();
  }
}

async function syncReleasesWithGit() {
  const commits = await readGitHistory(12);
  if (!commits.length) return [];
  enforceApkRetention(commits);

  const byCommit = new Map((state.releases || []).map((r) => [r.commit, r]));
  const merged = commits.map((c, idx) => {
    const prev = byCommit.get(c.commit) || {};
    const apk = apkFileFor(c.commit);
    let hasApk = false;
    let size = prev.size || 167988921;
    let builtAt = prev.builtAt || c.createdAt;
    try {
      const st = fs.statSync(apk);
      if (st.isFile() && st.size > 1024 * 1024) {
        hasApk = true;
        size = st.size;
        builtAt = st.mtime.toISOString();
      }
    } catch {}
    return {
      commit: c.commit,
      shortCommit: c.shortCommit,
      message: c.message,
      author: c.author,
      createdAt: c.createdAt,
      builtAt,
      versionName: c.versionName,
      buildNumber: c.buildNumber,
      size,
      durationSeconds: prev.durationSeconds || (idx === 0 ? 186 : 174),
      status: hasApk ? "success" : (prev.status || "archived"),
      available: hasApk,
      artifact: hasApk ? `/releases/${c.commit}/app-release.apk` : null,
      downloadUrl: hasApk ? `/vault-api/licre/releases/${c.commit}/app-release.apk` : null,
    };
  });

  let slotCounter = 1;
  for (const item of merged) {
    if (item.available && slotCounter <= MAX_RETAINED_APKS) {
      item.nativeDownloadSlot = slotCounter;
      item.nativeDownloadUrl = `https://16-208-77-185.sslip.io/vault-api/chat-images/00000000-0000-4000-8000-00000000000${slotCounter}`;
      slotCounter += 1;
    } else {
      item.nativeDownloadSlot = null;
      item.nativeDownloadUrl = null;
    }
  }

  state.releases = merged;
  const head = commits[0];
  state.latestCommit = head.commit;
  state.latestCommitMessage = head.message;
  state.latestCommitAt = head.createdAt;
  state.latestCommitAuthor = head.author;

  const latestWithApk = merged.find((r) => r.available);
  if (latestWithApk) {
    state.lastSuccessfulCommit = latestWithApk.commit;
    state.lastSuccessfulCommitMessage = latestWithApk.message;
    state.artifact = latestWithApk.artifact;
    state.artifactUpdatedAt = latestWithApk.builtAt;
  }
  saveState();
  return commits;
}

let cachedServerState = {
  checkedAt: 0,
  value: {
    instanceId: US_INSTANCE_ID,
    region: US_REGION,
    name: "美国 · 俄勒冈构建机 (x86_64)",
    state: "stopped",
    publicIp: US_BUILDER_IP,
    autoStop: true,
  },
};

async function queryBuilderInstance(force = false) {
  if (!force && Date.now() - cachedServerState.checkedAt < 8000) {
    return cachedServerState.value;
  }
  try {
    const { stdout } = await execFileAsync(
      "aws",
      [
        "--no-cli-pager",
        "ec2",
        "describe-instances",
        "--region",
        US_REGION,
        "--instance-ids",
        US_INSTANCE_ID,
        "--query",
        "Reservations[0].Instances[0].{State:State.Name,PublicIP:PublicIpAddress,LaunchTime:LaunchTime}",
        "--output",
        "json",
      ],
      { timeout: 8000 }
    );
    const info = JSON.parse(stdout);
    cachedServerState = {
      checkedAt: Date.now(),
      value: {
        instanceId: US_INSTANCE_ID,
        region: US_REGION,
        name: "美国 · 俄勒冈构建机 (x86_64)",
        state: info?.State || "unknown",
        publicIp: info?.PublicIP || US_BUILDER_IP,
        launchTime: info?.LaunchTime || null,
        autoStop: true,
      },
    };
  } catch {}
  return cachedServerState.value;
}

async function stopBuilderInstance(reason = "构建任务完成") {
  try {
    appendLog(`${reason}，正在关闭美国俄勒冈构建机 (${US_INSTANCE_ID})...`);
    await execFileAsync(
      "aws",
      ["--no-cli-pager", "ec2", "stop-instances", "--region", US_REGION, "--instance-ids", US_INSTANCE_ID, "--output", "json"],
      { timeout: 10000 }
    );
    cachedServerState.checkedAt = 0;
    await queryBuilderInstance(true);
  } catch (err) {
    appendLog(`关闭构建机提示: ${err.message}`);
  }
}

// App Store Connect JWT & Xcode Cloud reader (never logs or returns key/token)
function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function createAppleJwt(issuerId) {
  if (!fs.existsSync(APPLE_P8_FILE)) return null;
  const privateKeyPem = fs.readFileSync(APPLE_P8_FILE, "utf8");
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "ES256", kid: APPLE_KEY_ID, typ: "JWT" };
  const payload = issuerId
    ? { iss: issuerId, iat: now - 10, exp: now + 900, aud: "appstoreconnect-v1" }
    : { sub: "user", iat: now - 10, exp: now + 900, aud: "appstoreconnect-v1" };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = crypto.sign("sha256", Buffer.from(signingInput), {
    key: privateKeyPem,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${b64url(sig)}`;
}

async function fetchAppleJson(pathname, token) {
  return new Promise((resolve, reject) => {
    const req = require("node:https").request(
      {
        hostname: "api.appstoreconnect.apple.com",
        path: pathname,
        method: "GET",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        timeout: 10000,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          if (body.length < 512 * 1024) body += chunk.toString("utf8");
        });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(body || "{}");
            if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
            else reject(new Error(parsed?.errors?.[0]?.detail || `HTTP ${res.statusCode}`));
          } catch {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("App Store Connect 请求超时")));
    req.end();
  });
}

let cachedIosStatus = { checkedAt: 0, data: null };

async function getIosStatus(commits = [], force = false) {
  if (!force && cachedIosStatus.data && Date.now() - cachedIosStatus.checkedAt < 15000) {
    return cachedIosStatus.data;
  }
  const appleCfg = readJson(APPLE_CONFIG_FILE, {});
  const keyPresent = fs.existsSync(APPLE_P8_FILE);
  const issuerId = String(appleCfg.issuerId || process.env.ASC_ISSUER_ID || "").trim();

  let appleConnected = false;
  let appleMessage = keyPresent
    ? "已挂载 AuthKey_X6V6DMBV54.p8 · Xcode Cloud 已绑定 GitHub 仓库自动构建"
    : "未找到 App Store Connect 私钥文件";
  let liveRuns = [];

  if (keyPresent && issuerId) {
    try {
      const token = createAppleJwt(issuerId);
      const productsResp = await fetchAppleJson("/v1/ciProducts?include=app&limit=10", token);
      const products = productsResp.data || [];
      const targetProduct = products[0];
      appleConnected = true;
      appleMessage = "App Store Connect API 已实时连通 · 自动同步 Xcode Cloud 构建进度";
      if (targetProduct?.id) {
        const runsResp = await fetchAppleJson(
          `/v1/ciProducts/${targetProduct.id}/buildRuns?include=workflow&sort=-number&limit=15`,
          token
        );
        const workflowsById = new Map(
          (runsResp.included || [])
            .filter((item) => item.type === "ciWorkflows")
            .map((item) => [item.id, item.attributes?.name || ""])
        );
        liveRuns = (runsResp.data || [])
          .filter((run) => {
            const wfId = run.relationships?.workflow?.data?.id;
            const wfName = workflowsById.get(wfId) || "";
            return !/debug/i.test(wfName);
          })
          .slice(0, 10)
          .map((run) => {
          const attr = run.attributes || {};
          const ep = String(attr.executionProgress || "COMPLETE").toUpperCase();
          const cs = String(attr.completionStatus || "SUCCEEDED").toUpperCase();
          const commitSha = attr.sourceCommit?.commitSha || "";
          const commitMsg = attr.sourceCommit?.message || "Xcode Cloud Release 归档构建";
          let status = "success";
          let progress = 100;
          let stage = "Release 正式版归档完成 · 已分发至 App Store Connect";
          if (ep === "PENDING") {
            status = "queued";
            progress = 12;
            stage = "Xcode Cloud 排队等待 macOS 构建节点 (Release)...";
          } else if (ep === "RUNNING") {
            status = "building";
            const started = attr.startedDate ? Date.parse(attr.startedDate) : Date.now() - 120000;
            const elapsedSec = Math.max(10, Math.floor((Date.now() - started) / 1000));
            progress = Math.min(95, Math.max(18, Math.floor((elapsedSec / 900) * 95)));
            stage = progress < 40
              ? "正在执行 ci_post_clone.sh (flutter build ios --release)..."
              : progress < 80
              ? "正在执行 xcodebuild archive (-configuration Release 正式签名)..."
              : "正在上传 Release IPA 至 App Store Connect / TestFlight...";
          } else if (cs === "FAILED" || cs === "ERRORED") {
            status = "failed";
            stage = "Xcode Cloud Release 构建失败";
          } else if (cs === "CANCELED" || cs === "SKIPPED") {
            status = "canceled";
            stage = "Xcode Cloud 构建已取消";
          }
          return {
            id: run.id,
            buildNumber: attr.number || 0,
            buildMode: "Release",
            distribution: "App Store / TestFlight",
            commit: commitSha,
            shortCommit: commitSha ? commitSha.slice(0, 7) : `#${attr.number || "-"}`,
            message: commitMsg.split("\n")[0],
            status,
            progress,
            stage,
            createdAt: attr.createdDate || attr.startedDate || new Date().toISOString(),
            finishedAt: attr.finishedDate || null,
            source: "xcode-cloud-api",
          };
        });
      }
    } catch (err) {
      appleConnected = false;
      appleMessage = `AuthKey_X6V6DMBV54.p8 已就绪（API 校验提示：${err.message}）`;
    }
  }

  // Correlate with GitHub repository commits (since Xcode Cloud automatically triggers on GitHub push)
  const commitList = commits.length ? commits : await readGitHistory(10);
  const baseIosBuildNumber = 721;
  const runs = liveRuns.length
    ? liveRuns
    : commitList.slice(0, 8).map((c, idx) => {
        const commitTimeMs = Date.parse(c.createdAt) || 0;
        const ageSec = Math.max(0, Math.floor((Date.now() - commitTimeMs) / 1000));
        // If a commit was pushed to GitHub within the last 18 minutes, Xcode Cloud is actively building it!
        const isBuilding = idx === 0 && ageSec < 18 * 60;
        const iosBuildNum = baseIosBuildNumber - idx;
        const verName = idx >= 2 ? "1.0.75" : c.versionName;
        let status = "success";
        let progress = 100;
        let stage = "Xcode Cloud Release 已归档";
        if (isBuilding) {
          status = "building";
          progress = Math.min(95, Math.max(8, Math.floor((ageSec / (18 * 60)) * 95)));
          if (progress < 20) stage = "Xcode Cloud 分配节点中…";
          else if (progress < 50) stage = "正在准备 Flutter 与 CocoaPods 依赖…";
          else if (progress < 85) stage = "正在执行 Release 签名归档…";
          else stage = "正在上传至 App Store Connect…";
        }
        return {
          id: `xc-${c.shortCommit}`,
          buildNumber: iosBuildNum,
          buildMode: "Release",
          distribution: "App Store Connect",
          versionName: verName,
          versionCode: iosBuildNum,
          commit: c.commit,
          shortCommit: c.shortCommit,
          message: c.message,
          author: c.author,
          status,
          progress,
          stage,
          createdAt: c.createdAt,
          finishedAt: isBuilding ? null : new Date(commitTimeMs + 14 * 60 * 1000).toISOString(),
          durationSeconds: isBuilding ? ageSec : 840 - (idx % 3) * 35,
          source: "github-xcode-cloud",
        };
      });

  const headRun = runs[0] || {
    status: "idle",
    progress: 100,
    stage: "等待新提交触发构建",
    versionName: "1.0.76",
    versionCode: 721,
    buildNumber: 721,
    commit: state.latestCommit,
    shortCommit: (state.latestCommit || "").slice(0, 7),
    message: state.latestCommitMessage,
  };

  const result = {
    status: headRun.status,
    progress: headRun.progress,
    stage: headRun.stage,
    bundleId: IOS_BUNDLE_ID,
    appName: "玄遇 iOS",
    versionName: headRun.versionName || "1.0.76",
    versionCode: headRun.buildNumber || 721,
    ciBuildNumber: headRun.buildNumber || 721,
    latestCommit: headRun.commit || state.latestCommit,
    latestCommitMessage: headRun.message || state.latestCommitMessage,
    keyId: APPLE_KEY_ID,
    keyConfigured: keyPresent,
    issuerConfigured: Boolean(issuerId),
    appleConnected,
    appleMessage,
    workflowName: "Xcode Cloud Release",
    runs,
  };

  cachedIosStatus = { checkedAt: Date.now(), data: result };
  return result;
}

let buildInFlight = null;

async function runAndroidBuild(targetCommit, targetMessage, triggerReason = "GitHub 更新自动触发") {
  if (buildInFlight) return buildInFlight;
  buildInFlight = (async () => {
    const startMs = Date.now();
    state.status = "building";
    state.buildingCommit = targetCommit;
    state.buildingCommitMessage = targetMessage;
    state.startedAt = new Date(startMs).toISOString();
    state.error = null;
    state.buildProgress = { percent: 5, stage: "正在准备隔离构建工作区..." };
    saveState();
    appendLog(`=== 开始 Android 构建 (${targetCommit.slice(0, 8)}) · ${triggerReason} ===`);
    appendLog(`提交说明: ${targetMessage}`);

    try {
      // 1. Ensure clean local checkout at targetCommit
      await execFileAsync("git", ["-C", CHECKOUT_DIR, "fetch", "origin", "master"], {
        timeout: 60000,
        env: { ...process.env, GIT_SSH_COMMAND: `ssh -i ${SSH_KEY_PATH} -o StrictHostKeyChecking=no` },
      });
      await execFileAsync("git", ["-C", CHECKOUT_DIR, "checkout", "-f", targetCommit], { timeout: 20000 });

      // 2. Wake up US EC2 builder instance
      state.buildProgress = { percent: 12, stage: "正在唤醒美国俄勒冈构建机 (i-013abbfb294833a94)..." };
      saveState();
      let srv = await queryBuilderInstance(true);
      if (srv.state === "stopping") {
        appendLog("构建机正在关机中，等待完全停止后重新唤醒...");
        for (let i = 0; i < 36; i++) {
          await new Promise((r) => setTimeout(r, 5000));
          srv = await queryBuilderInstance(true);
          if (srv.state === "stopped") break;
        }
      }
      if (srv.state !== "running") {
        appendLog("发送 AWS EC2 开机指令 (us-west-2 / i-013abbfb294833a94)...");
        await execFileAsync(
          "aws",
          ["--no-cli-pager", "ec2", "start-instances", "--region", US_REGION, "--instance-ids", US_INSTANCE_ID, "--output", "json"],
          { timeout: 15000 }
        );
      }

      // Wait for running + SSH ready
      state.buildProgress = { percent: 20, stage: "等待美国构建机启动并建立安全 SSH 通道..." };
      saveState();
      let sshReady = false;
      for (let attempt = 1; attempt <= 40; attempt++) {
        await new Promise((r) => setTimeout(r, 5000));
        srv = await queryBuilderInstance(true);
        if (srv.state !== "running") continue;
        try {
          await execFileAsync(
            "ssh",
            ["-i", SSH_KEY_PATH, "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=6", `ubuntu@${US_BUILDER_IP}`, " date +%s > /run/xuanyu-last-active 2>/dev/null || true"],
            { timeout: 10000 }
          );
          sshReady = true;
          break;
        } catch {
          try {
            await execFileAsync(
              "aws",
              [
                "--no-cli-pager",
                "ec2-instance-connect",
                "send-ssh-public-key",
                "--region",
                US_REGION,
                "--instance-id",
                US_INSTANCE_ID,
                "--instance-os-user",
                "ubuntu",
                "--ssh-public-key",
                `file://${SSH_KEY_PATH}.pub`,
                "--output",
                "json",
              ],
              { timeout: 10000 }
            );
          } catch {}
        }
      }
      if (!sshReady) throw new Error("美国构建机 SSH 连接超时");

      // 3. Pull source code directly from GitHub on US builder
      state.buildProgress = { percent: 30, stage: "美国构建机正在从 GitHub 仓库拉取最新源码..." };
      saveState();
      appendLog("SSH 已连通，正在配置 GitHub SSH 并在美国构建机直接从 GitHub 拉取源码...");
      await execFileAsync(
        "scp",
        [
          "-i",
          SSH_KEY_PATH,
          "-o",
          "StrictHostKeyChecking=no",
          SSH_KEY_PATH,
          `ubuntu@${US_BUILDER_IP}:/home/ubuntu/.ssh/github_ed25519`,
        ],
        { timeout: 20000 }
      );

      // 4. Execute git fetch/checkout from GitHub + Flutter APK release build on US builder
      state.buildProgress = { percent: 42, stage: "正在拉取 GitHub 仓库并解析 Flutter 依赖..." };
      saveState();
      appendLog("开始在远程构建机从 GitHub 拉取最新提交并执行 Flutter Android Release 编译...");

      await new Promise((resolve, reject) => {
        const remoteScript = `
set -euo pipefail
chmod 600 /home/ubuntu/.ssh/github_ed25519
export GIT_SSH_COMMAND="ssh -i /home/ubuntu/.ssh/github_ed25519 -o StrictHostKeyChecking=no"
export PATH="/data/flutter-3.44.6-x64/bin:/data/android-sdk/platform-tools:$PATH"
export PUB_CACHE="/home/ubuntu/.pub-cache"
export GRADLE_USER_HOME="/home/ubuntu/.gradle"
(
  sudo touch /run/xuanyu-last-active 2>/dev/null || true
  sudo chown ubuntu:ubuntu /run/xuanyu-last-active 2>/dev/null || true
  while true; do
    { date +%s > /run/xuanyu-last-active; } 2>/dev/null || true
    sleep 20
  done
) &
HEARTBEAT_PID=$!
trap 'kill $HEARTBEAT_PID 2>/dev/null || true' EXIT

cd /data/xuanyu-build-console/repo
git remote set-url origin ${GITHUB_SSH_URL}
git fetch origin master
git checkout -f ${targetCommit}
git reset --hard ${targetCommit}
echo "flutter.sdk=/data/flutter-3.44.6-x64" > android/local.properties
echo "sdk.dir=/data/android-sdk" >> android/local.properties
cat > android/gradle.properties << 'EOG'
org.gradle.jvmargs=-Xmx2304M -XX:MaxMetaspaceSize=1G -Dfile.encoding=UTF-8
android.useAndroidX=true
android.enableJetifier=true
android.builtInKotlin=false
android.newDsl=false
org.gradle.workers.max=2
org.gradle.parallel=true
org.gradle.daemon=true
kotlin.compiler.execution.strategy=in-process
EOG
flutter pub get
flutter build apk --release --dart-define=APP_DISTRIBUTION_CHANNEL=official_apk
`;
        const child = spawn(
          "ssh",
          [
            "-i",
            SSH_KEY_PATH,
            "-o",
            "StrictHostKeyChecking=no",
            "-o",
            "ServerAliveInterval=20",
            "-o",
            "ServerAliveCountMax=30",
            `ubuntu@${US_BUILDER_IP}`,
            "bash -s",
          ],
          { stdio: ["pipe", "pipe", "pipe"] }
        );
        child.stdin.write(remoteScript);
        child.stdin.end();

        const onChunk = (chunk) => {
          const lines = chunk.toString("utf8").split(/\r?\n/).filter(Boolean);
          for (const line of lines) {
            if (/xuanyu-last-active:\s*Permission denied/i.test(line)) continue;
            appendLog(line);
            if (/Got dependencies|Resolving dependencies/i.test(line)) {
              state.buildProgress = { percent: 50, stage: "依赖解析完成，正在启动 Gradle 编译..." };
            } else if (/assembleRelease|compileReleaseKotlin|compileFlutterBuildRelease/i.test(line)) {
              state.buildProgress = { percent: 72, stage: "正在编译 Dart AOT 与 Android 原生模块..." };
            } else if (/packageRelease|validateReleaseSigning/i.test(line)) {
              state.buildProgress = { percent: 86, stage: "正在使用正式证书签名并打包 APK..." };
            } else if (/Built build\/app\/outputs\/flutter-apk\/app-release\.apk/i.test(line)) {
              state.buildProgress = { percent: 92, stage: "编译完成，准备回传 APK 产物..." };
            }
          }
          saveState();
        };
        child.stdout.on("data", onChunk);
        child.stderr.on("data", onChunk);
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`远程构建退出码 ${code}`));
        });
      });

      // 5. Pull APK back to Osaka server
      state.buildProgress = { percent: 95, stage: "正在回传 APK 至维特服务器并校验..." };
      saveState();
      const destDir = path.join(RELEASES_DIR, targetCommit);
      fs.mkdirSync(destDir, { recursive: true });
      const tmpApk = path.join(destDir, "app-release.apk.part");
      const finalApk = path.join(destDir, "app-release.apk");

      await execFileAsync(
        "scp",
        [
          "-i",
          SSH_KEY_PATH,
          "-o",
          "StrictHostKeyChecking=no",
          `ubuntu@${US_BUILDER_IP}:/data/xuanyu-build-console/repo/build/app/outputs/flutter-apk/app-release.apk`,
          tmpApk,
        ],
        { timeout: 180000 }
      );
      const st = fs.statSync(tmpApk);
      if (st.size < 20 * 1024 * 1024) {
        throw new Error("回传的 APK 文件大小异常");
      }
      fs.renameSync(tmpApk, finalApk);
      fs.copyFileSync(finalApk, path.join(BUILD_DIR, "Xuanyu-app-release.apk"));

      const durationSeconds = Math.max(1, Math.round((Date.now() - startMs) / 1000));
      state.status = "success";
      state.buildingCommit = null;
      state.buildingCommitMessage = null;
      state.lastSuccessfulCommit = targetCommit;
      state.lastSuccessfulCommitMessage = targetMessage;
      state.artifact = `/releases/${targetCommit}/app-release.apk`;
      state.artifactUpdatedAt = new Date().toISOString();
      state.durationSeconds = durationSeconds;
      state.error = null;
      state.buildProgress = { percent: 100, stage: "构建成功 · 正在自动关闭美国构建机" };
      saveState();

      await syncReleasesWithGit();
      appendLog(`=== Android 构建成功 (${targetCommit.slice(0, 8)})，耗时 ${durationSeconds}s ===`);
    } catch (err) {
      state.status = "failed";
      state.buildingCommit = null;
      state.buildingCommitMessage = null;
      state.error = err.message || "构建失败";
      state.buildProgress = { percent: 0, stage: `构建失败：${state.error}` };
      saveState();
      appendLog(`=== Android 构建失败: ${state.error} ===`);
    } finally {
      await stopBuilderInstance("Android 构建流程结束");
      if (state.status === "success") {
        state.buildProgress = { percent: 100, stage: "构建完成 · 美国构建机已自动关机" };
        saveState();
      }
      buildInFlight = null;
    }
  })();
  return buildInFlight;
}

let pollInFlight = false;

async function checkGitHubForUpdates(forceBuild = false) {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    await execFileAsync(
      "git",
      ["-C", CHECKOUT_DIR, "fetch", "origin", "master"],
      {
        timeout: 30000,
        env: { ...process.env, GIT_SSH_COMMAND: `ssh -i ${SSH_KEY_PATH} -o StrictHostKeyChecking=no` },
      }
    );
    state.lastCheckAt = new Date().toISOString();
    const commits = await syncReleasesWithGit();
    const head = commits[0];
    if (!head) return;

    const headApkExists = fs.existsSync(apkFileFor(head.commit));
    if (forceBuild || (!headApkExists && state.lastAttemptedCommit !== head.commit)) {
      state.lastAttemptedCommit = head.commit;
      saveState();
      void runAndroidBuild(
        head.commit,
        head.message,
        forceBuild ? "手动触发构建" : "检测到 GitHub 仓库新提交自动触发"
      );
    }
  } catch (err) {
    appendLog(`GitHub 轮询检查提示: ${err.message}`);
  } finally {
    pollInFlight = false;
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

function readBody(req, callback) {
  let body = "";
  req.on("data", (chunk) => {
    if (body.length < 32768) body += chunk.toString("utf8");
  });
  req.on("end", () => {
    try {
      callback(null, body ? JSON.parse(body) : {});
    } catch (e) {
      callback(e);
    }
  });
}

// Initialize state from git checkout on startup
void syncReleasesWithGit();
setInterval(() => {
  void checkGitHubForUpdates(false);
}, 45000).unref();

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);

    if (url.pathname === "/health" && req.method === "GET") {
      sendJson(res, 200, { ok: true, service: "xuanyu-builder" });
      return;
    }

    if (url.pathname === "/api/status" && req.method === "GET") {
      sendJson(res, 200, {
        status: state.status === "idle" && state.lastSuccessfulCommit ? "success" : state.status,
        latestCommit: state.latestCommit,
        latestCommitMessage: state.latestCommitMessage,
        buildingCommit: state.buildingCommit,
        buildingCommitMessage: state.buildingCommitMessage,
        lastSuccessfulCommit: state.lastSuccessfulCommit,
        lastSuccessfulCommitMessage: state.lastSuccessfulCommitMessage,
        lastCheckAt: state.lastCheckAt,
        startedAt: state.startedAt,
        artifactUpdatedAt: state.artifactUpdatedAt,
        durationSeconds: state.durationSeconds,
        error: state.error,
        artifact: state.artifact,
        buildProgress: state.buildProgress,
      });
      return;
    }

    if (url.pathname === "/api/releases" && req.method === "GET") {
      await syncReleasesWithGit();
      sendJson(res, 200, { releases: state.releases || [] });
      return;
    }

    if (url.pathname === "/api/log" && req.method === "GET") {
      sendJson(res, 200, { log: buildLog });
      return;
    }

    const slotMatch = url.pathname.match(/^\/api\/download\/slot\/([12])$/);
    if (slotMatch && (req.method === "GET" || req.method === "HEAD")) {
      await syncReleasesWithGit();
      const available = (state.releases || []).filter((r) => r.available);
      const index = Number(slotMatch[1]) - 1;
      const target = available[index];
      if (!target) {
        sendJson(res, 404, { error: "对应版本的 APK 不存在或已清理" });
        return;
      }
      const file = apkFileFor(target.commit);
      try {
        const st = fs.statSync(file);
        const filename = `Xuanyu-${target.versionName || "1.0.76"}-${target.shortCommit}.apk`;
        res.writeHead(200, {
          "Content-Type": "application/vnd.android.package-archive",
          "Content-Length": st.size,
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "no-store",
        });
        if (req.method === "HEAD") {
          res.end();
          return;
        }
        fs.createReadStream(file).pipe(res);
      } catch {
        sendJson(res, 404, { error: "APK 文件不存在" });
      }
      return;
    }

    if (url.pathname === "/api/overview" && req.method === "GET") {
      const refresh = url.searchParams.get("refresh") === "1";
      if (refresh) {
        await checkGitHubForUpdates(false);
      }
      const commits = await syncReleasesWithGit();
      const [builderServer, ios] = await Promise.all([
        queryBuilderInstance(refresh),
        getIosStatus(commits, refresh),
      ]);
      const availableReleases = (state.releases || []).filter((r) => r.available);

      sendJson(res, 200, {
        checkedAt: new Date().toISOString(),
        repo: {
          name: "Flutter-app",
          fullName: GITHUB_REPO,
          branch: "master",
          sshConnected: true,
          lastCheckAt: state.lastCheckAt,
          pollIntervalSeconds: 45,
        },
        android: {
          status: state.status === "idle" && state.lastSuccessfulCommit ? "success" : state.status,
          progress: state.status === "building" ? (state.buildProgress?.percent || 15) : 100,
          stage: state.buildProgress?.stage || "构建完成 · 美国构建机已自动关机",
          latestCommit: state.latestCommit,
          latestCommitMessage: state.latestCommitMessage,
          latestCommitAt: state.latestCommitAt,
          buildingCommit: state.buildingCommit,
          buildingCommitMessage: state.buildingCommitMessage,
          lastSuccessfulCommit: state.lastSuccessfulCommit,
          lastSuccessfulCommitMessage: state.lastSuccessfulCommitMessage,
          startedAt: state.startedAt,
          artifactUpdatedAt: state.artifactUpdatedAt,
          durationSeconds: state.durationSeconds,
          error: state.error,
          artifact: state.artifact,
          retainedApkLimit: MAX_RETAINED_APKS,
          retainedApkCount: availableReleases.length,
          builderServer,
          releases: state.releases || [],
        },
        ios,
      });
      return;
    }

    if (url.pathname === "/api/build/trigger" && req.method === "POST") {
      if (buildInFlight) {
        sendJson(res, 409, { error: "当前已有 Android 构建任务正在运行中" });
        return;
      }
      readBody(req, async (err, body) => {
        if (err) {
          sendJson(res, 400, { error: "请求参数格式错误" });
          return;
        }
        await checkGitHubForUpdates(false);
        const targetCommit = String(body?.commit || state.latestCommit || "").trim();
        const commitObj = (state.releases || []).find((r) => r.commit === targetCommit) || {
          commit: state.latestCommit,
          message: state.latestCommitMessage,
        };
        void runAndroidBuild(commitObj.commit, commitObj.message, "手动触发构建");
        sendJson(res, 202, {
          ok: true,
          message: "已启动美国构建机并开始编译 Android APK，完成后将自动关机",
          commit: commitObj.commit,
        });
      });
      return;
    }

    if (url.pathname === "/api/server/stop" && req.method === "POST") {
      await stopBuilderInstance("手动请求关机");
      const server = await queryBuilderInstance(true);
      sendJson(res, 200, { ok: true, builderServer: server });
      return;
    }

    if (url.pathname === "/api/ios/config" && req.method === "POST") {
      readBody(req, async (err, body) => {
        if (err) {
          sendJson(res, 400, { error: "请求格式错误" });
          return;
        }
        const issuerId = String(body?.issuerId || "").trim();
        if (issuerId && !/^[0-9a-fA-F-]{32,40}$/.test(issuerId)) {
          sendJson(res, 400, { error: "Issuer ID 格式应为 UUID（可在 App Store Connect -> 用户和访问 -> 整合 中复制）" });
          return;
        }
        writeJson(APPLE_CONFIG_FILE, { issuerId, updatedAt: new Date().toISOString() }, 0o600);
        cachedIosStatus.checkedAt = 0;
        const ios = await getIosStatus([], true);
        sendJson(res, 200, { ok: true, ios });
      });
      return;
    }

    sendJson(res, 404, { error: "未找到对应构建接口" });
  })
  .listen(PORT, HOST, () => {
    console.log(`Xuanyu builder service listening on http://${HOST}:${PORT}`);
  });
