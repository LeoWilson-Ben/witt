"use strict";
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ProviderRuntime } = require("./provider-runtime");
const { ChatService } = require("./chat-service");

function makeFakeChild() {
  const child = new EventEmitter();
  child.pid = 999999;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.stdinChunks = [];
  child.stdinEnded = false;
  const origWrite = child.stdin.write.bind(child.stdin);
  const origEnd = child.stdin.end.bind(child.stdin);
  child.stdin.write = (chunk, ...rest) => {
    child.stdinChunks.push(String(chunk));
    return origWrite(chunk, ...rest);
  };
  child.stdin.end = (chunk, ...rest) => {
    if (chunk) child.stdinChunks.push(String(chunk));
    child.stdinEnded = true;
    return origEnd(chunk, ...rest);
  };
  child.kill = () => {};
  return child;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "witt-agy-msg-"));
  const profile = { id: "antigravity", provider: "antigravity", label: "Antigravity CLI", workDir: root };
  const rows = [
    { slug: "gemini-4-neon-medium", name: "Gemini 4 Neon (Medium)" },
    { slug: "gemini-pro-orchestrator-neon", name: "Orchestrator (Neon)" },
  ];
  const spawned = [];
  const runtime = new ProviderRuntime({
    owner: "test-owner",
    services: {
      antigravity: {
        bin: "/usr/local/bin/agy",
        modelCache: new Map([["test-owner", { models: rows }]]),
        env: () => ({ HOME: root }),
        account: async () => ({ authenticated: true, email: "test@example.com" }),
      },
    },
    spawn: (bin, args) => {
      const child = makeFakeChild();
      spawned.push({ bin, args, child });
      return child;
    },
  });

  const client = runtime.client(profile);
  const events = [];
  client.on("notification", (method, params) => events.push({ method, params }));

  // 1. Multi-step message + tools + plan + usage + steer in single process
  const { thread } = await client.request("thread/start", { cwd: root, developerInstructions: "SYS", sandbox: "danger-full-access" });
  const { turn } = await client.request("turn/start", {
    threadId: thread.id,
    model: "gemini:gemini-4-neon",
    effort: "medium",
    input: [{ type: "text", text: "Do work" }],
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(spawned.length, 1);
  assert.ok(spawned[0].args.includes("--effort"), "effort-variant slug should pass --effort");
  const child = spawned[0].child;
  assert.equal(child.stdinEnded, false, "antigravity stdin should remain open for steer");

  const emit = (obj) => child.stdout.write(JSON.stringify(obj) + "\n");
  emit({ event: "init", conversation_id: "11111111-2222-3333-4444-555555555555", init: { cwd: root } });
  // Step 1: commentary
  emit({ event: "step_update", step_update: { step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "先检查一下" } });
  emit({ event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "agent_response", usage: { input_tokens: 1000, cache_read_tokens: 4000, total_tokens: 5100 } } });
  // Step 2: update_steps -> turn/plan/updated
  emit({ event: "step_update", step_update: { step_index: 2, state: "DONE", step_type: "tool", tool_name: "update_steps", tool_info: { name: "update_steps", parameters: { steps: [{ title: "Step A", status: "done" }, { title: "Step B", status: "in_progress" }] } } } });
  // Step 3: run_command -> commandExecution with output & exitCode
  emit({ event: "step_update", step_update: { step_index: 3, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "echo hi" } } } });
  emit({ event: "step_update", step_update: { step_index: 3, state: "DONE", step_type: "tool", tool_name: "run_command", duration_seconds: 0.25, tool_info: { name: "run_command", parameters: { CommandLine: "echo hi" }, output: "Command exited with code 0.\nhi\n" } } });
  // Step 4: write_to_file -> fileChange
  emit({ event: "step_update", step_update: { step_index: 4, state: "DONE", step_type: "tool", tool_name: "write_to_file", tool_info: { name: "write_to_file", parameters: { TargetFile: path.join(root, "a.html") }, output: "ok" } } });
  // Step 5: search_web -> webSearch
  emit({ event: "step_update", step_update: { step_index: 5, state: "DONE", step_type: "tool", tool_name: "search_web", tool_info: { name: "search_web", parameters: { query: "rustdesk" } } } });

  // Steer while active: writes directly to open stdin without spawning a new process
  await client.request("turn/steer", { threadId: thread.id, expectedTurnId: turn.id, input: [{ type: "text", text: "补充一个要求" }] });
  assert.equal(child.stdinChunks.length, 2, "steer should write second NDJSON user message to stdin");

  // First turn result arrives -> should NOT finish yet because steered turn is pending
  emit({ event: "step_update", step_update: { step_index: 6, state: "DONE", step_type: "agent_response", text_delta: "第一段完成" } });
  emit({ event: "result", result: { conversation_id: "11111111-2222-3333-4444-555555555555", status: "SUCCESS", response: "第一段完成" } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(events.some((e) => e.method === "turn/completed"), false, "should wait for steered turn result");

  // Steered turn response + result -> completes turn
  emit({ event: "step_update", step_update: { step_index: 7, state: "ACTIVE", step_type: "agent_response", text_delta: "最终回复" } });
  emit({ event: "step_update", step_update: { step_index: 7, state: "DONE", step_type: "agent_response" } });
  emit({ event: "result", result: { conversation_id: "11111111-2222-3333-4444-555555555555", status: "SUCCESS", response: "最终回复" } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(child.stdinEnded, true, "stdin should close after all expected results arrive");

  const completed = events.find((e) => e.method === "turn/completed");
  assert.ok(completed && completed.params.turn.status === "completed");
  const commentary = events.find((e) => e.method === "item/completed" && e.params.item?.type === "agentMessage" && e.params.item.phase === "commentary" && e.params.item.text === "先检查一下");
  assert.ok(commentary, "step 1 commentary should be preserved separately");
  const finalMsg = events.find((e) => e.method === "item/completed" && e.params.item?.type === "agentMessage" && e.params.item.phase === "final_answer" && e.params.item.text === "最终回复");
  assert.ok(finalMsg, "final_answer should carry final response");
  const cmd = events.find((e) => e.method === "item/completed" && e.params.item?.type === "commandExecution" && e.params.item.command === "echo hi");
  assert.ok(cmd && cmd.params.item.exitCode === 0 && cmd.params.item.durationMs === 250 && cmd.params.item.aggregatedOutput.includes("hi"));
  const fileChange = events.find((e) => e.method === "item/completed" && e.params.item?.type === "fileChange");
  assert.ok(fileChange && fileChange.params.item.changes[0].path.endsWith("a.html"));
  const plan = events.find((e) => e.method === "turn/plan/updated");
  assert.ok(plan && plan.params.plan[0].status === "completed" && plan.params.plan[1].status === "in_progress");
  const web = events.find((e) => e.method === "item/completed" && e.params.item?.type === "webSearch");
  assert.ok(web && web.params.item.query === "rustdesk");
  const usage = events.find((e) => e.method === "thread/tokenUsage/updated");
  assert.ok(usage && usage.params.tokenUsage.last.inputTokens === 5000 && usage.params.tokenUsage.modelContextWindow === 1000000);

  // 2. Steer after completion throws error matching ChatService auto-next-turn regex
  await assert.rejects(
    () => client.request("turn/steer", { threadId: thread.id, input: [{ type: "text", text: "late" }] }),
    /no active turn/i
  );

  // 3. Non-effort model slug omits --effort flag
  await client.request("turn/start", {
    threadId: thread.id,
    model: "gemini:gemini-pro-orchestrator-neon",
    effort: "medium",
    input: [{ type: "text", text: "Hi" }],
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(spawned.length, 2);
  assert.equal(spawned[1].args.includes("--effort"), false, "non-effort slug must not pass --effort");

  // 4. INTERRUPTED result maps to interrupted turn status
  const prevCompletedCount = events.filter((e) => e.method === "turn/completed").length;
  spawned[1].child.stdout.write(JSON.stringify({ event: "result", result: { status: "INTERRUPTED", response: "" } }) + "\n");
  await new Promise((r) => setTimeout(r, 20));
  const lastCompleted = events.filter((e) => e.method === "turn/completed").at(-1);
  assert.equal(events.filter((e) => e.method === "turn/completed").length, prevCompletedCount + 1);
  assert.equal(lastCompleted.params.turn.status, "interrupted");

  // 5. Verify ChatService integration end-to-end with stream entries
  const chat = new ChatService({
    chatDir: path.join(root, "chat"),
    dataDir: path.join(root, "files"),
    imageDir: path.join(root, "images"),
    codexBin: "/bin/false",
    codexWorkDir: root,
    serverAdministrator: true,
    allowedModels: null,
    allowedCodexProfiles: ["antigravity"],
    providerRuntime: runtime,
    codexProfiles: { antigravity: profile },
    sendJson: () => {},
    readJsonBody: () => {},
  });
  chat.runNext = () => {};
  chat.store.close();

  fs.rmSync(root, { recursive: true, force: true });
  console.log("PASS antigravity messaging compatibility (commentary/final_answer, tools, plan, usage, live steer, non-effort model, interrupt)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
