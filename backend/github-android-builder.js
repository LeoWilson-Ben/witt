"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const { Transform } = require("node:stream");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);
const CERT = "8be98025c156a7099643df5552d965b4182a03c3ddd3bc8dddf80bcb0dd1160b";

function validateMetadata(data, expected) {
  if (data.commit !== expected.commit || data.requestId !== expected.requestId ||
      String(data.runId) !== String(expected.runId)) throw Error("构建产物的提交或请求编号不匹配");
  if (data.packageName !== "com.xuanyu.android" || data.certificateSha256 !== CERT ||
      !/^[a-f0-9]{64}$/.test(data.sha256 || "") || !Number.isInteger(data.versionCode) ||
      data.size < 20 * 1024 * 1024 || data.size > 512 * 1024 * 1024) {
    throw Error("构建产物的包名、大小或签名元数据异常");
  }
}

class GitHubAndroidBuilder {
  constructor(options = {}) {
    this.repo = options.repo || "LeoWilson-Ben/Flutter-app";
    this.workflow = "android-apk.yml";
    this.tokenFile = options.tokenFile || "/var/lib/witt/runtime/auth/github-xuanyu-token";
    this.fetch = options.fetch || globalThis.fetch;
  }

  async api(route, method = "GET", body) {
    const response = await this.fetch(`https://api.github.com/repos/${this.repo}${route}`, {
      method, redirect: "manual", signal: AbortSignal.timeout(30000),
      headers: { Authorization: `Bearer ${fs.readFileSync(this.tokenFile, "utf8").trim()}`,
        Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "Witt-Xuanyu-Builder", "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 302) {
      const location = response.headers.get("location");
      if (!location || new URL(location).protocol !== "https:") throw Error("GitHub 下载地址异常");
      return { location };
    }
    if (!response.ok) {
      // Don't echo request headers, credentials, response bodies or signed URLs.
      throw Error(`GitHub Actions 请求失败 (${response.status})`);
    }
    if (response.status === 204) return {};
    return response.json();
  }

  async dispatch(commit, requestId) {
    if (!/^[a-f0-9]{40}$/.test(commit) || !/^[a-f0-9-]{36}$/.test(requestId)) throw Error("构建参数无效");
    return this.api(`/actions/workflows/${this.workflow}/dispatches`, "POST", {
      ref: "master", return_run_details: true, inputs: { source_commit: commit, request_id: requestId },
    });
  }

  async findRun(requestId) {
    const data = await this.api(`/actions/workflows/${this.workflow}/runs?event=workflow_dispatch&per_page=100`);
    return data.workflow_runs.find(run => run.display_title?.endsWith(` · ${requestId}`)) || null;
  }

  async run(id) { return this.api(`/actions/runs/${id}`); }
  async jobs(id) { return (await this.api(`/actions/runs/${id}/jobs?per_page=100`)).jobs; }
  async cancel(id) { await this.api(`/actions/runs/${id}/cancel`, "POST"); }

  async download(location, file, maxBytes) {
    const response = await this.fetch(location, { signal: AbortSignal.timeout(240000) });
    if (!response.ok || Number(response.headers.get("content-length")) > maxBytes) throw Error("构建产物下载失败或超过大小限制");
    let size = 0;
    const limit = new Transform({ transform(chunk, encoding, done) {
      size += chunk.length;
      done(size > maxBytes ? Error("下载超过大小限制") : null, chunk);
    } });
    await pipeline(response.body, limit, fs.createWriteStream(file, { mode: 0o600 }));
  }

  async receive(runId, expected, destination) {
    const listing = await this.api(`/actions/runs/${runId}/artifacts?per_page=100`);
    const item = listing.artifacts.find(a => a.name === `xuanyu-android-${expected.requestId}` && !a.expired);
    if (!item) throw Error("GitHub 构建成功但未找到对应 APK 产物");
    fs.mkdirSync(destination, { recursive: true });
    const zip = path.join(destination, `github-${runId}.zip.part`);
    const { location } = await this.api(`/actions/artifacts/${item.id}/zip`);
    if (!location) throw Error("GitHub 未返回产物下载地址");
    await this.download(location, zip, 550 * 1024 * 1024);
    if (item.digest?.startsWith("sha256:")) {
      const digest = await fileHash(zip);
      if (`sha256:${digest}` !== item.digest) throw Error("GitHub 产物归档 SHA-256 不匹配");
    }
    const { stdout } = await exec("python3", ["-c", `
import json,sys,zipfile,shutil
from pathlib import Path
z=zipfile.ZipFile(sys.argv[1]); out=Path(sys.argv[2])
for name in ['build-metadata.json','app-release.apk']:
    info=z.getinfo(name)
    limit=16384 if name.endswith('.json') else 512*1024*1024
    if info.file_size>limit: raise SystemExit('Artifact entry exceeds size limit')
    with z.open(info) as src, (out/(name+'.part')).open('wb') as dst: shutil.copyfileobj(src,dst)
print((out/'build-metadata.json.part').read_text())
`, zip, destination], { timeout: 120000 });
    const metadata = JSON.parse(stdout);
    validateMetadata(metadata, { ...expected, runId });
    const apk = path.join(destination, "app-release.apk.part");
    if (fs.statSync(apk).size !== metadata.size || await fileHash(apk) !== metadata.sha256) throw Error("APK 文件大小或 SHA-256 校验失败");
    const signed = await exec("/opt/android-sdk/build-tools/35.0.0/apksigner", ["verify", "--print-certs", apk], { timeout: 60000 });
    if (!signed.stdout.includes(`SHA-256 digest: ${CERT}`)) throw Error("APK 与玄遇正式签名不一致");
    const badging = await exec("/opt/android-sdk/build-tools/35.0.0/aapt", ["dump", "badging", apk], { timeout: 30000 });
    const match = badging.stdout.match(/package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/);
    if (!match || match[1] !== metadata.packageName || Number(match[2]) !== metadata.versionCode || match[3] !== metadata.versionName) throw Error("APK 实际版本与构建元数据不一致");
    fs.renameSync(apk, path.join(destination, "app-release.apk"));
    fs.renameSync(path.join(destination, "build-metadata.json.part"), path.join(destination, "build-metadata.json"));
    fs.unlinkSync(zip);
    return metadata;
  }

  async failureLogs(id, directory) {
    try {
      const { location } = await this.api(`/actions/runs/${id}/logs`);
      if (!location) return "";
      const file = path.join(directory, `github-${id}-logs.zip`);
      await this.download(location, file, 20 * 1024 * 1024);
      const { stdout } = await exec("python3", ["-c", `
import zipfile,sys
with zipfile.ZipFile(sys.argv[1]) as z:
 for i in z.infolist():
  if i.file_size < 10*1024*1024:
   lines=z.read(i).decode('utf-8',errors='replace').splitlines()
   if any('##[error]' in l or 'FAILURE:' in l for l in lines):print('\\n'.join(lines[-100:]))
`, file], { maxBuffer: 500000, timeout: 15000 });
      const token = fs.readFileSync(this.tokenFile, "utf8").trim();
      return stdout.replaceAll(token, "[hidden]").replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, "[hidden]").slice(-24000);
    } catch { return "构建失败日志暂不可读取，请在 GitHub Actions 查看对应任务。"; }
  }
}

async function fileHash(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

module.exports = { GitHubAndroidBuilder, validateMetadata, fileHash, CERT };
