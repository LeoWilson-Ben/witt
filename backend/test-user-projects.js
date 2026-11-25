"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ChatService } = require("./chat-service");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "witt-user-projects-"));

function makeService(name, serverAdministrator) {
  const base = path.join(root, name);
  const service = new ChatService({
    serverAdministrator,
    chatDir: path.join(base, "chat"),
    dataDir: path.join(base, "files"),
    imageDir: path.join(base, "images"),
    codexBin: "/bin/false",
    codexWorkDir: root,
    startWorkspace: false,
    allowedModels: null,
    sendJson(res, status, payload) {
      res.status = status;
      res.payload = payload;
    },
    readJsonBody(req, _limit, callback) {
      callback(null, req.body || {});
    },
  });
  service.runNext = () => {};
  const request = (method, suffix, body = {}, principal = { deviceId: `${name}-dev` }) => {
    const res = {};
    assert.equal(
      service.handle({ method, body }, res, new URL(`http://localhost/chat/${suffix}`), principal),
      true,
    );
    return res;
  };
  return { service, request };
}

try {
  const admin = makeService("admin-user", true);
  const member = makeService("member-user", false);

  // 1. Create private projects for admin and member; workDir input is ignored and never exposed.
  const createAdmin = admin.request("POST", "projects", {
    name: "我的论文",
    instructions: "保持严谨学术风格",
    workDir: "/etc",
    shortcuts: [{ name: "润色摘要", prompt: "请帮我润色这段摘要" }],
  });
  assert.equal(createAdmin.status, 201);
  const adminProj = createAdmin.payload.project;
  assert.equal(adminProj.name, "我的论文");
  assert.equal(adminProj.workDir, undefined, "public project payload must not expose raw server path");

  const expectedAdminDir = path.join(admin.service.projectsDir, adminProj.id);
  assert.ok(fs.existsSync(expectedAdminDir), "isolated project directory should be created automatically");

  const createMember = member.request("POST", "projects", {
    name: "个人记账",
    instructions: "使用中文表格输出",
  });
  assert.equal(createMember.status, 201);
  const memberProj = createMember.payload.project;
  const expectedMemberDir = path.join(member.service.projectsDir, memberProj.id);
  assert.ok(fs.existsSync(expectedMemberDir));

  // 2. Strict per-user isolation: neither user can see or bind the other's project.
  assert.equal(admin.request("GET", "projects").payload.projects.length, 1);
  assert.equal(member.request("GET", "projects").payload.projects.length, 1);
  assert.equal(member.request("GET", `projects/${adminProj.id}`).status, 404);
  assert.equal(admin.request("GET", `projects/${memberProj.id}`).status, 404);

  const memberConv = member.service.createConversation();
  assert.equal(
    member.request("PATCH", `conversations/${memberConv.id}`, { workspaceProjectId: adminProj.id }).status,
    404,
    "member must not bind another user's project",
  );

  // 3. Equal treatment: both admin and member use isolated project directory when bound.
  const adminConv = admin.service.createConversation();
  const bindAdmin = admin.request("PATCH", `conversations/${adminConv.id}`, {
    workspaceProjectId: adminProj.id,
  });
  assert.equal(bindAdmin.status, 200);
  assert.equal(bindAdmin.payload.conversation.workspaceProjectId, adminProj.id);
  assert.equal(bindAdmin.payload.conversation.project, "我的论文");
  assert.equal(admin.service.effectiveWorkDir(admin.service.readConversation(adminConv.id)), expectedAdminDir);
  assert.match(
    admin.service.buildDeveloperInstructions(admin.service.readConversation(adminConv.id)),
    /当前项目：我的论文/,
  );

  // Android bridge compatibility: workDir: "project:<uuid>"
  const bindMemberAndroid = member.request("PATCH", `conversations/${memberConv.id}`, {
    workDir: `project:${memberProj.id}`,
  });
  assert.equal(bindMemberAndroid.status, 200);
  assert.equal(bindMemberAndroid.payload.conversation.workspaceProjectId, memberProj.id);
  assert.equal(bindMemberAndroid.payload.conversation.project, "个人记账");
  assert.equal(member.service.effectiveWorkDir(member.service.readConversation(memberConv.id)), expectedMemberDir);

  // 4. Unified filtering by projectId and __none__.
  const freeConv = admin.service.createConversation();
  assert.equal(admin.request("GET", `conversations?projectId=${adminProj.id}`).payload.conversations.length, 1);
  assert.equal(admin.request("GET", `conversations?projectId=${adminProj.id}`).payload.conversations[0].id, adminConv.id);
  assert.equal(admin.request("GET", "conversations?projectId=__none__").payload.conversations.length, 1);
  assert.equal(admin.request("GET", "conversations?projectId=__none__").payload.conversations[0].id, freeConv.id);

  // 5. Mid-conversation switch injects context sync notice on next turn.
  const secondAdminProj = admin.request("POST", "projects", {
    name: "产品设计",
    instructions: "多给界面方案对比",
  }).payload.project;
  const loadedAdminConv = admin.service.readConversation(adminConv.id);
  loadedAdminConv.codexThreadId = "thread-existing";
  admin.service.writeConversation(loadedAdminConv);
  const switched = admin.request("PATCH", `conversations/${adminConv.id}`, {
    workspaceProjectId: secondAdminProj.id,
  });
  assert.equal(switched.status, 200);
  const afterSwitch = admin.service.readConversation(adminConv.id);
  const promptText = admin.service.buildPrompt(afterSwitch, { text: "继续分析" }, []);
  assert.match(promptText, /已切换至项目「产品设计」/);
  assert.match(promptText, /多给界面方案对比/);

  // 6. Rename propagates to bound conversations.
  const renamed = admin.request("PATCH", `projects/${secondAdminProj.id}`, { name: "产品设计 v2" });
  assert.equal(renamed.status, 200);
  assert.equal(admin.service.readConversation(adminConv.id).project, "产品设计 v2");

  // 6.5 Project reference files (knowledge base): upload, auto-inject into instructions, and remove.
  const addRef = admin.request("PATCH", `projects/${secondAdminProj.id}`, {
    addReference: {
      name: "设计规范.md",
      mimeType: "text/markdown",
      contentBase64: Buffer.from("# 设计规范\n统一使用圆角 12px\n", "utf8").toString("base64"),
    },
  });
  assert.equal(addRef.status, 201);
  assert.equal(addRef.payload.project.references.length, 1);
  assert.equal(addRef.payload.project.references[0].name, "设计规范.md");
  const instrWithRef = admin.service.buildDeveloperInstructions(admin.service.readConversation(adminConv.id));
  assert.match(instrWithRef, /项目常驻参考文件/);
  assert.match(instrWithRef, /设计规范\.md/);
  const removeRef = admin.request("PATCH", `projects/${secondAdminProj.id}`, {
    removeReferenceId: addRef.payload.reference.id,
  });
  assert.equal(removeRef.status, 200);
  assert.equal(removeRef.payload.project.references.length, 0);

  // 7. Delete via Android-compatible PATCH { deleted: true, removeFiles: true } unlinks conversations & cleans files.
  const secondDir = path.join(admin.service.projectsDir, secondAdminProj.id);
  fs.writeFileSync(path.join(secondDir, "draft.txt"), "hello", "utf8");
  const deleted = admin.request("PATCH", `projects/${secondAdminProj.id}`, { deleted: true, removeFiles: true });
  assert.equal(deleted.status, 200);
  assert.equal(deleted.payload.ok, true);
  assert.equal(fs.existsSync(secondDir), false, "project directory should be removed when removeFiles=true");
  const unlinkedConv = admin.service.readConversation(adminConv.id);
  assert.equal(unlinkedConv.workspaceProjectId, null);
  assert.equal(unlinkedConv.project, "");

  // 8. Non-project default chats in /var/lib/witt do not falsely block each other.
  const d1 = admin.service.createConversation();
  const d2 = admin.service.createConversation();
  admin.service.activeTurns.set(d1.id, { conversationId: d1.id });
  assert.equal(admin.service.workspace.conflict(d2), null);

  admin.service.store.close();
  member.service.store.close();
  console.log("user projects isolation, binding, sync and lifecycle tests passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
