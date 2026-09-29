"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const temporaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "witt-deepseek-test-"));
const keyFile = path.join(temporaryDir, "key");
fs.writeFileSync(keyFile, "test-key\n", { mode: 0o600 });
let capturedBody;

const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    capturedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "你好" } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_test", function: { name: "exec_command", arguments: "{\"cmd\":" } }] } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"pwd\"}" } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});

async function main() {
  await new Promise((resolve) => upstream.listen(33112, "127.0.0.1", resolve));
  const adapter = spawn(process.execPath, [path.join(__dirname, "deepseek-responses-adapter.js")], {
    env: {
      ...process.env,
      DEEPSEEK_ADAPTER_PORT: "33113",
      DEEPSEEK_API_URL: "http://127.0.0.1:33112/chat/completions",
      DEEPSEEK_API_KEY_FILE: keyFile,
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("adapter start timeout")), 5000);
    adapter.stdout.on("data", (chunk) => {
      if (!chunk.toString("utf8").includes("listening")) return;
      clearTimeout(timeout);
      resolve();
    });
    adapter.once("exit", (code) => reject(new Error(`adapter exited ${code}`)));
  });
  try {
    const response = await fetch("http://127.0.0.1:33113/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        instructions: "system",
        reasoning: { effort: "xhigh" },
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        tools: [{ type: "function", name: "exec_command", description: "run", parameters: { type: "object" } }],
      }),
    });
    const text = await response.text();
    assert.equal(response.status, 200);
    assert.match(text, /response\.output_text\.delta/);
    assert.match(text, /response\.function_call_arguments\.done/);
    assert.match(text, /response\.completed/);
    assert.equal(capturedBody.reasoning_effort, "max");
    assert.equal(capturedBody.messages[0].role, "system");
    assert.equal(capturedBody.messages[1].content, "hi");
    assert.equal(capturedBody.tools[0].function.name, "exec_command");
    console.log("deepseek adapter tests passed");
  } finally {
    adapter.kill("SIGTERM");
    upstream.close();
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  upstream.close();
  fs.rmSync(temporaryDir, { recursive: true, force: true });
  console.error(error.stack || error);
  process.exitCode = 1;
});
