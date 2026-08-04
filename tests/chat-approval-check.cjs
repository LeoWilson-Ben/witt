"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ChatService } = require("../backend/chat-service");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "witt-approval-"));
let lastResponse = null;
const service = new ChatService({
  chatDir: path.join(root, "chats"),
  dataDir: path.join(root, "uploads"),
  imageDir: path.join(root, "images"),
  codexBin: "codex",
  codexWorkDir: root,
  sendJson(_res, status, body) {
    lastResponse = { status, body };
  },
  readJsonBody(req, _limit, callback) {
    callback(null, req.body);
  },
});

const conversationId = "00000000-0000-4000-8000-000000000001";
const messageId = "00000000-0000-4000-8000-000000000002";
const userId = "00000000-0000-4000-8000-000000000003";
service.writeConversation({
  id: conversationId,
  title: "审批测试",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  archived: false,
  messages: [
    { id: userId, role: "user", text: "测试", status: "running" },
    { id: messageId, role: "assistant", text: "", status: "running", stream: [], activity: [] },
  ],
});

const responses = [];
service.active = {
  conversationId,
  messageId,
  userId,
  client: {
    respond(id, result) {
      responses.push({ id, result });
    },
  },
  pendingApprovals: new Map(),
};

service.handleServerRequest(conversationId, messageId, {
  id: 41,
  method: "item/commandExecution/requestApproval",
  params: {
    itemId: "item-1",
    reason: "需要检查服务状态",
    command: "systemctl is-active drop-vault.service",
    cwd: "/data/drop-vault",
    availableDecisions: [
      "accept",
      {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: ["systemctl", "is-active"],
        },
      },
      "decline",
      "cancel",
    ],
  },
});

let conversation = service.readConversation(conversationId);
let approval = conversation.messages[1].stream.find((entry) => entry.kind === "approval");
assert.ok(approval, "command approval should be persisted in the assistant stream");
assert.equal(approval.status, "pending");
assert.equal(approval.command, "systemctl is-active drop-vault.service");
assert.equal(approval.approvalOptions.length, 4);
assert.match(approval.approvalOptions[1].label, /允许并记住/);
assert.equal(responses.length, 0, "approval must wait for the user");

service.resolveApproval(
  { body: { choiceId: "choice-2" } },
  {},
  conversationId,
  approval.approvalId,
);
assert.equal(lastResponse.status, 200);
assert.deepEqual(responses.at(-1), {
  id: 41,
  result: {
    decision: {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: ["systemctl", "is-active"],
      },
    },
  },
});
conversation = service.readConversation(conversationId);
approval = conversation.messages[1].stream.find((entry) => entry.kind === "approval");
assert.equal(approval.status, "accepted");
assert.match(approval.resolutionLabel, /允许并记住/);

service.handleServerRequest(conversationId, messageId, {
  id: 42,
  method: "item/permissions/requestApproval",
  params: {
    itemId: "item-2",
    reason: "需要访问依赖服务",
    cwd: root,
    permissions: { network: { enabled: true } },
  },
});
conversation = service.readConversation(conversationId);
approval = conversation.messages[1].stream.findLast(
  (entry) => entry.kind === "approval" && entry.status === "pending");
assert.equal(approval.approvalType, "network");
service.resolveApproval(
  { body: { decision: "decline" } },
  {},
  conversationId,
  approval.approvalId,
);
assert.deepEqual(responses.at(-1), {
  id: 42,
  result: { permissions: {}, scope: "turn" },
});

service.handleServerRequest(conversationId, messageId, {
  id: 43,
  method: "item/tool/requestUserInput",
  params: {
    itemId: "item-3",
    questions: [{
      id: "figma-approval",
      header: "Figma 画布操作",
      question: "允许 Figma 修改当前设计文件吗？",
      isOther: false,
      isSecret: false,
      options: [
        { label: "Accept", description: "允许这次画布操作" },
        { label: "Decline", description: "拒绝并继续" },
        { label: "Cancel", description: "取消本轮" },
      ],
    }],
  },
});
conversation = service.readConversation(conversationId);
approval = conversation.messages[1].stream.findLast(
  (entry) => entry.kind === "approval" && entry.status === "pending");
assert.equal(approval.approvalType, "connector");
assert.equal(approval.approvalOptions.length, 3);
assert.match(approval.title, /Figma/);
service.resolveApproval(
  { body: { choiceId: "input-1" } }, {}, conversationId, approval.approvalId);
assert.deepEqual(responses.at(-1), {
  id: 43,
  result: { answers: { "figma-approval": { answers: ["Accept"] } } },
});

service.handleServerRequest(conversationId, messageId, {
  id: 44,
  method: "item/tool/requestUserInput",
  params: {
    itemId: "item-4",
    questions: [
      { id: "scope", header: "范围", question: "选择范围", isOther: false,
        isSecret: false, options: [{ label: "当前文件", description: "只允许当前文件" }] },
      { id: "note", header: "备注", question: "输入备注", isOther: true,
        isSecret: false, options: null },
    ],
  },
});
conversation = service.readConversation(conversationId);
approval = conversation.messages[1].stream.findLast(
  (entry) => entry.kind === "approval" && entry.status === "pending");
assert.equal(approval.approvalOptions.length, 0);
assert.equal(approval.approvalQuestions.length, 2);
const structuredAnswers = {
  scope: { answers: ["当前文件"] },
  note: { answers: ["Witt redesign"] },
};
service.resolveApproval(
  { body: { choiceId: JSON.stringify({ answers: structuredAnswers }) } }, {},
  conversationId, approval.approvalId);
assert.deepEqual(responses.at(-1), { id: 44, result: { answers: structuredAnswers } });

service.handleServerRequest(conversationId, messageId, {
  id: 45,
  method: "mcpServer/elicitation/request",
  params: {
    threadId: "thread-1",
    turnId: "turn-1",
    serverName: "figma",
    mode: "form",
    message: "确认画布写入范围",
    requestedSchema: {
      type: "object",
      properties: { fileName: { type: "string", title: "文件名称" } },
      required: ["fileName"],
    },
  },
});
conversation = service.readConversation(conversationId);
approval = conversation.messages[1].stream.findLast(
  (entry) => entry.kind === "approval" && entry.status === "pending");
assert.equal(approval.approvalType, "mcp");
assert.equal(approval.approvalForm.properties.fileName.type, "string");
service.resolveApproval(
  { body: { choiceId: JSON.stringify({ action: "accept", content: { fileName: "Witt" } }) } },
  {}, conversationId, approval.approvalId);
assert.deepEqual(responses.at(-1), {
  id: 45,
  result: { action: "accept", content: { fileName: "Witt" }, _meta: null },
});

service.handleServerRequest(conversationId, messageId, {
  id: 46,
  method: "mcpServer/elicitation/request",
  params: {
    threadId: "thread-1", turnId: "turn-1", serverName: "figma", mode: "url",
    message: "请完成外部授权", url: "https://www.figma.com/oauth", elicitationId: "url-1",
  },
});
conversation = service.readConversation(conversationId);
approval = conversation.messages[1].stream.findLast(
  (entry) => entry.kind === "approval" && entry.status === "pending");
assert.equal(approval.approvalOptions.length, 3);
service.resolveApproval(
  { body: { choiceId: "mcp-decline" } }, {}, conversationId, approval.approvalId);
assert.deepEqual(responses.at(-1), {
  id: 46,
  result: { action: "decline", content: null, _meta: null },
});

service.handleServerRequest(conversationId, messageId, {
  id: 47,
  method: "mcpServer/elicitation/request",
  params: {
    threadId: "thread-1", turnId: "turn-1", serverName: "codex_apps", mode: "form",
    message: "Allow Figma to run tool?",
    requestedSchema: { type: "object", properties: {} },
  },
});
conversation = service.readConversation(conversationId);
approval = conversation.messages[1].stream.findLast(
  (entry) => entry.kind === "approval" && entry.status === "pending");
assert.equal(approval.approvalOptions[0].id, "mcp-accept");
service.resolveApproval(
  { body: { choiceId: "mcp-accept" } }, {}, conversationId, approval.approvalId);
assert.deepEqual(responses.at(-1), {
  id: 47,
  result: { action: "accept", content: null, _meta: null },
});

fs.rmSync(root, { recursive: true, force: true });
console.log("chat approval checks passed");
