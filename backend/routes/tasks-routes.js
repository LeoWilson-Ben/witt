"use strict";

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function extractCodexResult(output) {
  let answer = "";
  for (const line of String(output || "").split("\n")) {
    try {
      const event = JSON.parse(line);
      const item = event.item || {};
      if (event.type === "item.completed" && item.type === "agent_message" && item.text) {
        answer = item.text;
      }
    } catch {}
  }
  return answer.trim();
}

function createTasksService({
  taskDir,
  dataDir,
  codexBin,
  codexWorkDir,
  maxPromptBytes = 32 * 1024,
  maxTaskOutputBytes = 2 * 1024 * 1024,
  sendJson,
  readJsonBody,
}) {
  let taskCache = null;
  let activeTaskId = null;

  function taskPath(id) {
    return path.join(taskDir, `${id}.json`);
  }

  function writeTask(task) {
    const destination = taskPath(task.id);
    const temporary = `${destination}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(task)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, destination);
    taskCache = null;
  }

  function readTask(id) {
    if (!/^[a-f0-9-]{36}$/.test(String(id || ""))) return null;
    try {
      return JSON.parse(fs.readFileSync(taskPath(id), "utf8"));
    } catch {
      return null;
    }
  }

  function publicTask(task) {
    return {
      id: task.id,
      prompt: task.prompt,
      status: task.status,
      createdAt: task.createdAt,
      startedAt: task.startedAt || null,
      completedAt: task.completedAt || null,
      result: task.result || "",
      error: task.error || "",
    };
  }

  function readTasks() {
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(taskDir).mtimeMs;
    } catch {
      taskCache = null;
      return [];
    }
    if (taskCache && taskCache.mtimeMs === mtimeMs) return taskCache.tasks;
    const tasks = fs.readdirSync(taskDir)
      .filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
      .map((name) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(taskDir, name), "utf8"));
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    taskCache = { mtimeMs, tasks };
    return tasks;
  }

  function runNextTask() {
    if (activeTaskId) return;
    const task = readTasks().reverse().find((item) => item.status === "queued");
    if (!task) return;

    activeTaskId = task.id;
    task.status = "running";
    task.startedAt = new Date().toISOString();
    task.error = "";
    writeTask(task);

    const context = [
      "你是运行在用户私人服务器上的 Codex 助手 Witt。",
      `固定工作目录：${codexWorkDir}`,
      `Witt 文件目录：${dataDir}`,
      "只处理用户这条消息明确要求的任务；保留现有数据和未提交修改。",
      "禁止展示、记录或回传凭据原文。用户明确授权时，允许认证程序使用指定的本地凭据文件完成认证，不将凭据或生成的 Token 输出到聊天及日志。",
      "如果任务需要超出上述项目目录的写入、对外发送消息、删除数据或其他高风险操作，只说明需要用户确认，不要执行。",
      "",
      `用户通过 Witt 发来的消息：${task.prompt}`,
    ].join("\n");
    const args = [
      "exec",
      "--json",
      "--sandbox", "workspace-write",
      "--cd", codexWorkDir,
      "--skip-git-repo-check",
      context,
    ];
    const child = spawn(codexBin, args, {
      cwd: codexWorkDir,
      env: { ...process.env, HOME: "/home/ubuntu" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const append = (current, chunk) => (current + chunk.toString("utf8")).slice(-maxTaskOutputBytes);
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });

    child.on("error", (error) => {
      const latest = readTask(task.id) || task;
      latest.status = "failed";
      latest.completedAt = new Date().toISOString();
      latest.error = `无法启动 Codex：${error.message}`;
      writeTask(latest);
      activeTaskId = null;
      setImmediate(runNextTask);
    });
    child.on("close", (code, signal) => {
      const latest = readTask(task.id) || task;
      const answer = extractCodexResult(stdout);
      latest.completedAt = new Date().toISOString();
      if (code === 0 && answer) {
        latest.status = "completed";
        latest.result = answer;
        latest.error = "";
      } else {
        latest.status = "failed";
        latest.error = signal
          ? "任务被服务终止"
          : (stderr.trim().slice(-1200) || "Codex 未返回有效结果");
      }
      writeTask(latest);
      activeTaskId = null;
      setImmediate(runNextTask);
    });
  }

  function recoverTasks() {
    for (const task of readTasks()) {
      if (task.status !== "running") continue;
      task.status = "queued";
      task.startedAt = null;
      task.error = "服务重启后已自动重新排队";
      writeTask(task);
    }
    runNextTask();
  }

  function listTasks(res, url) {
    const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit")) || 20));
    sendJson(res, 200, {
      activeTaskId,
      tasks: readTasks().slice(0, limit).map(publicTask),
    });
  }

  function createTask(req, res) {
    readJsonBody(req, maxPromptBytes, (error, body) => {
      if (error) {
        sendJson(res, 400, { error: error.message });
        return;
      }
      const prompt = String(body?.prompt || "").trim();
      if (!prompt) {
        sendJson(res, 400, { error: "请填写要交给 Witt 的任务" });
        return;
      }
      if (Buffer.byteLength(prompt, "utf8") > maxPromptBytes) {
        sendJson(res, 413, { error: "任务内容过长" });
        return;
      }
      const now = new Date().toISOString();
      const task = {
        id: crypto.randomUUID(),
        prompt,
        status: "queued",
        createdAt: now,
        startedAt: null,
        completedAt: null,
        result: "",
        error: "",
      };
      writeTask(task);
      sendJson(res, 202, { task: publicTask(task) });
      setImmediate(runNextTask);
    });
  }

  return {
    readTask,
    publicTask,
    readTasks,
    runNextTask,
    recoverTasks,
    listTasks,
    createTask,
  };
}

module.exports = {
  createTasksService,
  extractCodexResult,
};
