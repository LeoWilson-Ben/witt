"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { GitHubAndroidBuilder, validateMetadata, CERT } = require("./github-android-builder");
const commit = "a".repeat(40);
const requestId = "11111111-1111-4111-8111-111111111111";
const metadata = { commit, requestId, runId: "123", packageName: "com.xuanyu.android",
  certificateSha256: CERT, sha256: "b".repeat(64), versionCode: 78, size: 30 * 1024 * 1024 };

test("accept only the requested source, run, package and signing identity", () => {
  const expected = { commit, requestId, runId: 123 };
  assert.doesNotThrow(() => validateMetadata(metadata, expected));
  for (const changed of [{ commit: "c".repeat(40) }, { requestId: "other" }, { runId: "999" },
    { packageName: "another.app" }, { certificateSha256: "wrong" }, { size: 0 }]) {
    assert.throws(() => validateMetadata({ ...metadata, ...changed }, expected));
  }
});

test("associate concurrent workflow dispatches by unique request ID", async () => {
  const builder = new GitHubAndroidBuilder();
  builder.api = async () => ({ workflow_runs: [
    { id: 1, display_title: "Witt Android · old · another-request" },
    { id: 2, display_title: `Witt Android · ${commit} · ${requestId}` },
  ] });
  assert.equal((await builder.findRun(requestId)).id, 2);
  assert.equal(await builder.findRun("unknown"), null);
});

test("use a fixed workflow ref, validated inputs and a read-from-file token", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "witt-github-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tokenFile = path.join(dir, "fake-token");
  fs.writeFileSync(tokenFile, "test-fixture-only", { mode: 0o600 });
  let call;
  const builder = new GitHubAndroidBuilder({ tokenFile, fetch: async (url, options) => {
    call = { url, options }; return { ok: true, status: 204 };
  } });
  await builder.dispatch(commit, requestId);
  assert.equal(call.options.redirect, "manual");
  assert.deepEqual(JSON.parse(call.options.body), { ref: "master", return_run_details: true, inputs: { source_commit: commit, request_id: requestId } });
  await assert.rejects(builder.dispatch("invalid", requestId));
});

test("API errors do not expose response bodies or authorization headers", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "witt-github-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tokenFile = path.join(dir, "fake-token");
  fs.writeFileSync(tokenFile, "test-fixture-only");
  const builder = new GitHubAndroidBuilder({ tokenFile, fetch: async () => ({ ok: false, status: 403 }) });
  await assert.rejects(builder.api("/actions/runs"), /^Error: GitHub Actions 请求失败 \(403\)$/);
});
