"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { CodemagicAndroidBuilder } = require("./codemagic-android-builder");

test("read Codemagic bundled metadata before validating APK content", async t => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const { execFileSync } = require("node:child_process");
  const { CERT } = require("./github-android-builder");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "witt-codemagic-artifact-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const commit = "c".repeat(40), requestId = "11111111-1111-4111-8111-111111111111", id = "b".repeat(24);
  const metadata = { commit, requestId, runId: id, packageName: "com.xuanyu.android",
    certificateSha256: CERT, sha256: "a".repeat(64), versionCode: 78, size: 30 * 1024 * 1024 };
  const file = path.join(root, "fixture.zip");
  execFileSync("python3", ["-c", "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('ci-artifact/build-metadata.json',sys.argv[2]); z.close()", file, JSON.stringify(metadata)]);
  const zip = fs.readFileSync(file);
  const client = new CodemagicAndroidBuilder({ fetch: async url => new Response(url.endsWith("/metadata") ? zip : Buffer.from("invalid-apk")) });
  const artifacts = [
    { name: "Flutter-app_1_artifacts.zip", size_in_bytes: zip.length, short_lived_download_url: "https://fixture.invalid/metadata" },
    { name: "app-release.apk", size_in_bytes: 11, short_lived_download_url: "https://fixture.invalid/apk" },
  ];
  await assert.rejects(client.receive({ id, artifacts }, { commit, requestId }, path.join(root, "download")), /APK SHA-256 或大小不匹配/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "download/build-metadata.json.part"))), metadata);
});

test("dispatch only the free-plan M2 runner with exact source and request ID", async () => {
  const client = new CodemagicAndroidBuilder();
  client.config = () => ({ appId: "a".repeat(24) });
  let request;
  client.api = async (route, method, data) => { request = { route, method, data }; return { data: { id: "b".repeat(24) } }; };
  const commit = "c".repeat(40), requestId = "11111111-1111-4111-8111-111111111111";
  assert.equal(await client.start(commit, requestId), "b".repeat(24));
  assert.equal(request.data.instance_type, "mac_mini_m2");
  assert.equal(request.data.workflow_id, "android-official-apk");
  assert.equal(request.data.environment.variables.XUANYU_SOURCE_COMMIT, commit);
  assert.equal(request.data.environment.variables.XUANYU_REQUEST_ID, requestId);
  await assert.rejects(client.start("not-a-commit", requestId));
});

test("reject a missing build identifier instead of monitoring another build", async () => {
  const client = new CodemagicAndroidBuilder();
  client.config = () => ({ appId: "a".repeat(24) });
  client.api = async () => ({ data: {} });
  await assert.rejects(client.start("c".repeat(40), "11111111-1111-4111-8111-111111111111"), /未返回有效构建编号/);
});
