"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");

const host = process.env.DEEPSEEK_ADAPTER_HOST || "127.0.0.1";
const port = Number(process.env.DEEPSEEK_ADAPTER_PORT || 33111);
const apiUrl = process.env.DEEPSEEK_API_URL || "https://api.deepseek.com/chat/completions";
const keyFile = process.env.DEEPSEEK_API_KEY_FILE ||
  "/home/ubuntu/.config/drop-vault/deepseek-api-key";
const maxBodyBytes = 32 * 1024 * 1024;

function sendJson(res, status, body) {
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

function readApiKey() {
  try {
    const value = fs.readFileSync(keyFile, "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (["input_text", "output_text", "text"].includes(part?.type)) {
      return String(part.text || "");
    }
    if (part?.type === "input_image") return "[图片输入暂不受 DeepSeek 接入支持]";
    return "";
  }).filter(Boolean).join("\n");
}

function translateInput(input, instructions) {
  const messages = [];
  if (instructions) messages.push({ role: "system", content: String(instructions) });
  const pendingToolCalls = [];
  const flushToolCalls = () => {
    if (!pendingToolCalls.length) return;
    messages.push({ role: "assistant", content: null, tool_calls: pendingToolCalls.splice(0) });
  };
  for (const item of Array.isArray(input) ? input : []) {
    if (item?.type === "message") {
      flushToolCalls();
      const role = ["system", "developer", "user", "assistant"].includes(item.role)
        ? item.role : "user";
      messages.push({
        role: role === "developer" ? "system" : role,
        content: textFromContent(item.content),
      });
    } else if (item?.type === "function_call") {
      pendingToolCalls.push({
        id: String(item.call_id || item.id || crypto.randomUUID()),
        type: "function",
        function: {
          name: String(item.name || "tool"),
          arguments: typeof item.arguments === "string"
            ? item.arguments : JSON.stringify(item.arguments || {}),
        },
      });
    } else if (item?.type === "function_call_output") {
      flushToolCalls();
      messages.push({
        role: "tool",
        tool_call_id: String(item.call_id || item.id || ""),
        content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? ""),
      });
    }
  }
  flushToolCalls();
  return messages;
}

function translateTools(tools) {
  return (Array.isArray(tools) ? tools : []).filter((tool) => tool?.type === "function")
    .map((tool) => ({
      type: "function",
      function: {
        name: String(tool.name || "tool"),
        description: String(tool.description || ""),
        parameters: tool.parameters || { type: "object", properties: {} },
        ...(tool.strict == null ? {} : { strict: Boolean(tool.strict) }),
      },
    }));
}

function translateToolChoice(choice) {
  if (["auto", "none", "required"].includes(choice)) return choice;
  if (choice?.type === "function" && choice.name) {
    return { type: "function", function: { name: String(choice.name) } };
  }
  return "auto";
}

function responseObject(id, model, status = "in_progress") {
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    error: null,
    incomplete_details: null,
    instructions: null,
    model,
    output: [],
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: "auto",
    tools: [],
    top_p: null,
    usage: null,
  };
}

function writeEvent(res, type, payload) {
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
}

async function relayDeepSeek(body, res, apiKey) {
  const tools = translateTools(body.tools);
  const upstreamBody = {
    model: String(body.model || "deepseek-v4-pro"),
    messages: translateInput(body.input, body.instructions),
    stream: true,
    stream_options: { include_usage: true },
    reasoning_effort: body.reasoning?.effort === "xhigh" ? "max" : "high",
    ...(tools.length ? {
      tools,
      tool_choice: translateToolChoice(body.tool_choice),
      parallel_tool_calls: body.parallel_tool_calls !== false,
    } : {}),
    ...(Number.isFinite(body.max_output_tokens)
      ? { max_tokens: Math.max(1, Number(body.max_output_tokens)) } : {}),
  };
  const upstream = await fetch(apiUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(upstreamBody),
    signal: AbortSignal.timeout(30 * 60 * 1000),
  });
  if (!upstream.ok) {
    const detail = (await upstream.text()).slice(0, 2000);
    sendJson(res, upstream.status, {
      error: { message: `DeepSeek 请求失败 (${upstream.status})：${detail}` },
    });
    return;
  }

  res.writeHead(200, {
    "cache-control": "no-store",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no",
  });
  const responseId = `resp_${crypto.randomUUID().replaceAll("-", "")}`;
  const response = responseObject(responseId, upstreamBody.model);
  let sequence = 0;
  writeEvent(res, "response.created", { response, sequence_number: sequence++ });
  writeEvent(res, "response.in_progress", { response, sequence_number: sequence++ });

  let buffer = "";
  let messageItem = null;
  let messageText = "";
  let usage = null;
  const toolItems = new Map();
  const ensureMessage = () => {
    if (messageItem) return messageItem;
    messageItem = {
      id: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
      type: "message",
      status: "in_progress",
      role: "assistant",
      content: [],
    };
    writeEvent(res, "response.output_item.added", {
      output_index: 0, item: messageItem, sequence_number: sequence++,
    });
    writeEvent(res, "response.content_part.added", {
      item_id: messageItem.id, output_index: 0, content_index: 0,
      part: { type: "output_text", text: "", annotations: [], logprobs: [] },
      sequence_number: sequence++,
    });
    return messageItem;
  };
  const ensureTool = (index, call) => {
    if (toolItems.has(index)) return toolItems.get(index);
    const outputIndex = messageItem ? toolItems.size + 1 : toolItems.size;
    const item = {
      id: `fc_${crypto.randomUUID().replaceAll("-", "")}`,
      type: "function_call",
      status: "in_progress",
      arguments: "",
      call_id: String(call.id || `call_${crypto.randomUUID().replaceAll("-", "")}`),
      name: String(call.function?.name || "tool"),
    };
    toolItems.set(index, { item, outputIndex });
    writeEvent(res, "response.output_item.added", {
      output_index: outputIndex, item, sequence_number: sequence++,
    });
    return toolItems.get(index);
  };

  for await (const chunk of upstream.body) {
    buffer += Buffer.from(chunk).toString("utf8");
    let boundary;
    while ((boundary = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, boundary).trimEnd();
      buffer = buffer.slice(boundary + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let event;
      try { event = JSON.parse(data); } catch { continue; }
      if (event.usage) usage = event.usage;
      const delta = event.choices?.[0]?.delta || {};
      if (typeof delta.content === "string" && delta.content) {
        ensureMessage();
        messageText += delta.content;
        writeEvent(res, "response.output_text.delta", {
          item_id: messageItem.id, output_index: 0, content_index: 0,
          delta: delta.content, logprobs: [], sequence_number: sequence++,
        });
      }
      for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const record = ensureTool(Number(call.index || 0), call);
        if (call.id) record.item.call_id = String(call.id);
        if (call.function?.name) record.item.name = String(call.function.name);
        const argumentDelta = String(call.function?.arguments || "");
        if (argumentDelta) {
          record.item.arguments += argumentDelta;
          writeEvent(res, "response.function_call_arguments.delta", {
            item_id: record.item.id, output_index: record.outputIndex,
            delta: argumentDelta, sequence_number: sequence++,
          });
        }
      }
    }
  }

  const output = [];
  if (messageItem) {
    messageItem.status = "completed";
    messageItem.content = [{ type: "output_text", text: messageText, annotations: [], logprobs: [] }];
    writeEvent(res, "response.output_text.done", {
      item_id: messageItem.id, output_index: 0, content_index: 0,
      text: messageText, logprobs: [], sequence_number: sequence++,
    });
    writeEvent(res, "response.content_part.done", {
      item_id: messageItem.id, output_index: 0, content_index: 0,
      part: messageItem.content[0], sequence_number: sequence++,
    });
    writeEvent(res, "response.output_item.done", {
      output_index: 0, item: messageItem, sequence_number: sequence++,
    });
    output.push(messageItem);
  }
  for (const { item, outputIndex } of toolItems.values()) {
    item.status = "completed";
    writeEvent(res, "response.function_call_arguments.done", {
      item_id: item.id, output_index: outputIndex, arguments: item.arguments,
      sequence_number: sequence++,
    });
    writeEvent(res, "response.output_item.done", {
      output_index: outputIndex, item, sequence_number: sequence++,
    });
    output.push(item);
  }
  const completed = {
    ...response,
    status: "completed",
    output,
    usage: usage ? {
      input_tokens: Number(usage.prompt_tokens || 0),
      input_tokens_details: { cached_tokens: Number(usage.prompt_cache_hit_tokens || 0) },
      output_tokens: Number(usage.completion_tokens || 0),
      output_tokens_details: { reasoning_tokens: Number(usage.completion_tokens_details?.reasoning_tokens || 0) },
      total_tokens: Number(usage.total_tokens || 0),
    } : null,
  };
  writeEvent(res, "response.completed", { response: completed, sequence_number: sequence++ });
  res.end();
}

http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, { ok: true, configured: Boolean(readApiKey()) });
    return;
  }
  if (req.method !== "POST" || req.url !== "/v1/responses") {
    sendJson(res, 404, { error: { message: "接口不存在" } });
    return;
  }
  const apiKey = readApiKey();
  if (!apiKey) {
    sendJson(res, 503, { error: { message: "DeepSeek API Key 尚未配置" } });
    return;
  }
  const chunks = [];
  let size = 0;
  req.on("data", (chunk) => {
    size += chunk.length;
    if (size > maxBodyBytes) req.destroy(new Error("请求过大"));
    else chunks.push(chunk);
  });
  req.on("end", () => {
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch {
      sendJson(res, 400, { error: { message: "请求 JSON 无效" } });
      return;
    }
    relayDeepSeek(body, res, apiKey).catch((error) => {
      if (!res.headersSent) {
        sendJson(res, 502, { error: { message: `DeepSeek 连接失败：${error.message}` } });
      } else {
        res.destroy(error);
      }
    });
  });
}).listen(port, host, () => {
  console.log(`DeepSeek Responses adapter listening on http://${host}:${port}`);
});
