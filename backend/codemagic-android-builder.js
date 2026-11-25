"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const exec = promisify(execFile);
const { GitHubAndroidBuilder, validateMetadata, fileHash, CERT } = require("./github-android-builder");

class CodemagicAndroidBuilder {
  constructor(options = {}) {
    this.tokenFile = options.tokenFile || "/var/lib/witt/runtime/auth/codemagic-token";
    this.configFile = options.configFile || "/var/lib/witt/runtime/auth/codemagic-xuanyu.json";
    this.fetch = options.fetch || globalThis.fetch;
  }
  config() {
    const config = JSON.parse(fs.readFileSync(this.configFile, "utf8"));
    if (!/^[a-f0-9]{24}$/.test(config.appId || "")) throw Error("Codemagic 尚未连接玄遇应用");
    return config;
  }
  async api(route, method = "GET", data, legacy = false) {
    const response = await this.fetch((legacy ? "https://api.codemagic.io" : "https://codemagic.io/api/v3") + route, {
      method, redirect: "manual", signal: AbortSignal.timeout(30000),
      headers: { "x-auth-token": fs.readFileSync(this.tokenFile, "utf8").trim(),
        Accept: "application/json", "Content-Type": "application/json" },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    if (!response.ok) {
      if (response.status === 402) throw Error("Codemagic 免费构建额度不足，已停止；不会自动开通付费");
      throw Error(`Codemagic 请求失败 (${response.status})`);
    }
    if (response.status === 204) return {};
    return response.json();
  }
  async start(commit, requestId) {
    if (!/^[a-f0-9]{40}$/.test(commit) || !/^[a-f0-9-]{36}$/.test(requestId)) throw Error("构建参数无效");
    const result = await this.api(`/apps/${this.config().appId}/builds`, "POST", {
      workflow_id: "android-official-apk", branch: "master", instance_type: "mac_mini_m2",
      labels: ["witt", requestId], environment: { variables: {
        XUANYU_SOURCE_COMMIT: commit, XUANYU_REQUEST_ID: requestId,
      } },
    });
    const id = result.data?.id || result.data?.build_id || result.buildId;
    if (!/^[a-f0-9]{24}$/.test(id || "")) throw Error("Codemagic 未返回有效构建编号");
    return id;
  }
  async read(id) { return (await this.api(`/builds/${id}`)).data; }
  async actions(id) { return (await this.api(`/builds/${id}/actions`)).data || []; }
  async cancel(id) { await this.api(`/builds/${id}/cancel`, "POST", null, true); }

  async logs(id) {
    const data = await this.api(`/builds/${id}`, "GET", null, true);
    let result = "";
    for (const action of data.build?.buildActions || []) {
      if (!action.logUrl || !action.startedAt) continue;
      const url = new URL(action.logUrl);
      if (url.protocol !== "https:") continue;
      const headers = ["api.codemagic.io", "codemagic.io"].includes(url.hostname)
        ? { "x-auth-token": fs.readFileSync(this.tokenFile, "utf8").trim() } : {};
      let response = await this.fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(15000) });
      if (response.status === 302 && response.headers.get("location")?.startsWith("https://")) {
        response = await this.fetch(response.headers.get("location"), { signal: AbortSignal.timeout(15000) });
      }
      if (!response.ok) continue;
      const reader = response.body.getReader();
      const chunks = []; let size = 0;
      while (size < 2 * 1024 * 1024) {
        const next = await reader.read();
        if (next.done) break;
        chunks.push(Buffer.from(next.value)); size += next.value.length;
      }
      await reader.cancel();
      result += `\n--- ${action.name} ---\n` + Buffer.concat(chunks).toString("utf8").slice(-18000);
    }
    const token = fs.readFileSync(this.tokenFile, "utf8").trim();
    return result.replaceAll(token, "[hidden]").replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, "[hidden]").slice(-70000);
  }

  async receive(build, expected, destination) {
    fs.mkdirSync(destination, { recursive: true });
    const downloader = new GitHubAndroidBuilder({ fetch: this.fetch });
    for (const name of ["build-metadata.json", "app-release.apk"]) {
      const item = build.artifacts.find(a => path.basename(a.name) === name);
      if (!item && name === "build-metadata.json") {
        // Codemagic exposes APKs separately but bundles other files in an artifacts ZIP.
        const bundle = build.artifacts.find(a => a.name.endsWith("_artifacts.zip") && a.size_in_bytes < 10 * 1024 * 1024);
        if (!bundle?.short_lived_download_url?.startsWith("https://")) throw Error("Codemagic 未返回构建校验元数据");
        const zip = path.join(destination, "metadata.zip.part");
        await downloader.download(bundle.short_lived_download_url, zip, 10 * 1024 * 1024);
        await exec("python3", ["-c", `
import pathlib,sys,zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    entries=[i for i in z.infolist() if pathlib.PurePosixPath(i.filename).name=='build-metadata.json']
    if len(entries)!=1 or entries[0].file_size>16384:raise SystemExit('Invalid build metadata archive')
    pathlib.Path(sys.argv[2]).write_bytes(z.read(entries[0]))
`, zip, path.join(destination, name + ".part")], { timeout: 15000 });
        fs.unlinkSync(zip);
        continue;
      }
      if (!item || !item.short_lived_download_url?.startsWith("https://")) throw Error("Codemagic 未返回完整 APK 产物");
      await downloader.download(item.short_lived_download_url, path.join(destination, name + ".part"),
        name.endsWith(".json") ? 16384 : 512 * 1024 * 1024);
    }
    const metadata = JSON.parse(fs.readFileSync(path.join(destination, "build-metadata.json.part"), "utf8"));
    validateMetadata(metadata, { ...expected, runId: build.id });
    const apk = path.join(destination, "app-release.apk.part");
    if (fs.statSync(apk).size !== metadata.size || await fileHash(apk) !== metadata.sha256) throw Error("APK SHA-256 或大小不匹配");
    const signed = await exec("/opt/android-sdk/build-tools/35.0.0/apksigner", ["verify", "--print-certs", apk], { timeout: 60000 });
    if (!signed.stdout.includes(`SHA-256 digest: ${CERT}`)) throw Error("APK 不是玄遇正式签名");
    const { stdout } = await exec("/opt/android-sdk/build-tools/35.0.0/aapt", ["dump", "badging", apk], { timeout: 30000 });
    const m = stdout.match(/package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/);
    if (!m || m[1] !== metadata.packageName || Number(m[2]) !== metadata.versionCode || m[3] !== metadata.versionName) throw Error("APK 包名或版本不匹配");
    fs.renameSync(apk, path.join(destination, "app-release.apk"));
    fs.renameSync(path.join(destination, "build-metadata.json.part"), path.join(destination, "build-metadata.json"));
    return metadata;
  }
}
module.exports = { CodemagicAndroidBuilder };
