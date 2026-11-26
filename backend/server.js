"use strict";

const fs = require("node:fs");
const http = require("node:http");
const { loadConfig } = require("./core/config");
const {
  sendJson,
  readJsonBody,
  parseName,
  sendFile,
  previewContentType,
  browserCookieRequest,
  createBrowserOriginChecker,
} = require("./core/http-utils");
const { createRemoteAssistServices } = require("./core/remote-assist-wiring");
const { createSessionContext } = require("./core/session-context");
const { createFilesService } = require("./routes/files-routes");
const { createTasksService } = require("./routes/tasks-routes");
const { createLicreRouter } = require("./routes/licre-routes");
const { createCodexRouter } = require("./routes/codex-routes");
const { AuthService } = require("./auth-service");
const {
  ChatService, servePublicArtifactPreview, servePublicArtifactSource,
} = require("./chat-service");
const { CodexAccountService } = require("./codex-account-service");
const { ClaudeAccountService } = require("./claude-account-service");
const { AntigravityAccountService } = require("./antigravity-account-service");
const { ProviderRuntime } = require("./provider-runtime");
const { claimStandby } = require("./failover");
const { WindowsNodeService } = require("./windows-node-service");

const config = loadConfig();
const {
  host,
  port,
  dataDir,
  taskDir,
  chatDir,
  imageDir,
  usersDir,
  authDir,
  remoteAssistDir,
  tokenFile,
  codexBin,
  codexWorkDir,
  codexProfiles,
  allowedBrowserOrigins,
  serverMigrationTargetUrl,
  licreBuildDir,
  licreConsoleDir,
  xuanyuPreviewDir,
  maxBytes,
  maxPromptBytes,
  maxTaskOutputBytes,
} = config;

const token = fs.readFileSync(tokenFile, "utf8").trim();
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(taskDir, { recursive: true });
fs.mkdirSync(usersDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(remoteAssistDir, { recursive: true, mode: 0o700 });

const browserOriginAllowed = createBrowserOriginChecker(allowedBrowserOrigins);
const filesService = createFilesService({ dataDir, maxBytes, sendJson, parseName });
const tasksService = createTasksService({
  taskDir,
  dataDir,
  codexBin,
  codexWorkDir,
  maxPromptBytes,
  maxTaskOutputBytes,
  sendJson,
  readJsonBody,
});
const licreRouter = createLicreRouter({
  licreBuildDir,
  licreConsoleDir,
  xuanyuPreviewDir,
  sendJson,
  sendFile,
  previewContentType,
});

let sessionContext = null;
const {
  deviceGateway,
  remoteAssist,
  remoteWorkspaceService,
} = createRemoteAssistServices({
  remoteAssistDir,
  host,
  port,
  readJsonBody,
  sendJson,
  chatFor: (principal) => sessionContext.chatFor(principal),
});

const chatService = new ChatService({
  serverAdministrator: true,
  chatDir,
  imageDir,
  dataDir,
  codexBin,
  codexWorkDir,
  sendJson,
  readJsonBody,
  codexProfiles,
  remoteWorkspaceService,
});
const authService = new AuthService({
  dir: authDir,
  sendJson,
  readJsonBody,
  serverMigrationTargetUrl,
  serverMigrationTokenFile: tokenFile,
});
const windowsNodeService = new WindowsNodeService({ dir: authDir, sendJson, readJsonBody });
const isProviderAuthorized = (ticket) => {
  if (ticket.owner === "legacy") return !authService.initialized();
  return authService.read().devices.some((device) => device.id === ticket.deviceId &&
    device.userId === ticket.owner && device.admin && !device.disabled);
};
const claudeAccountService = new ClaudeAccountService({
  sendJson,
  readJsonBody,
  isAuthorized: isProviderAuthorized,
});
const antigravityAccountService = new AntigravityAccountService({
  sendJson,
  readJsonBody,
  isAuthorized: isProviderAuthorized,
});
const providerRuntimeFor = (owner) => new ProviderRuntime({
  owner,
  services: { claude: claudeAccountService, antigravity: antigravityAccountService },
});
chatService.providerRuntime = providerRuntimeFor("legacy");
const codexAccountService = new CodexAccountService({
  codexBin,
  profiles: Object.fromEntries(Object.entries(codexProfiles).filter(([, profile]) => !profile.provider)),
  sendJson,
});
const handleCodexAndFailover = createCodexRouter({
  codexAccountService,
  claudeAccountService,
  antigravityAccountService,
  claimStandby,
  sendJson,
});
const userChatServices = new Map();
sessionContext = createSessionContext({
  token,
  authService,
  chatService,
  userChatServices,
  usersDir,
  dataDir,
  codexBin,
  codexWorkDir,
  codexProfiles,
  remoteWorkspaceService,
  providerRuntimeFor,
  sendJson,
  readJsonBody,
});

setImmediate(sessionContext.restoreScheduledUsers);
const scheduleRestoreTimer = setInterval(sessionContext.restoreScheduledUsers, 60000);
scheduleRestoreTimer.unref();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${host}:${port}`);
  if (remoteWorkspaceService.handleInternalMcp(req, res, url, readJsonBody, sendJson)) return;
  if (url.pathname === "/health") {
    sendJson(res, 200, { ok: true, nonAdminExecution: "sandboxed", serverAccessPolicy: "per-device" });
    return;
  }
  if (url.pathname === "/xuanyu-preview") {
    res.writeHead(302, { Location: "/vault-api/xuanyu-preview/" });
    res.end();
    return;
  }
  if (req.method === "GET" && url.pathname.startsWith("/xuanyu-preview/")) {
    licreRouter.sendXuanyuPreview(res, url.pathname);
    return;
  }
  if (licreRouter.handleLicre(req, res, url)) return;
  const publicPreviewMatch = url.pathname.match(/^\/chat\/artifact-previews\/([A-Za-z0-9_-]{32,128})$/);
  if (req.method === "GET" && publicPreviewMatch) {
    if (servePublicArtifactPreview(res, publicPreviewMatch[1])) return;
    sendJson(res, 404, { error: "交互预览已失效，请刷新对话后重试" });
    return;
  }
  const publicSourceMatch = url.pathname.match(/^\/chat\/artifact-sources\/([A-Za-z0-9_-]{32,128})$/);
  if (req.method === "GET" && publicSourceMatch) {
    if (servePublicArtifactSource(res, publicSourceMatch[1])) return;
    sendJson(res, 404, { error: "Artifact 源码已失效，请刷新对话后重试" });
    return;
  }
  const compatiblePreviewMatch = url.pathname.match(
    /^\/chat\/conversations\/([a-f0-9-]{36})\/messages\/([a-f0-9-]{36})\/artifacts\/([a-f0-9-]{36})\/preview$/);
  if (req.method === "GET" && compatiblePreviewMatch) {
    const services = [chatService, ...userChatServices.values()];
    if (services.some((service) => service.previewArtifactByIds(
      res, compatiblePreviewMatch[1], compatiblePreviewMatch[2], compatiblePreviewMatch[3]))) return;
    sendJson(res, 404, { error: "交互预览不存在或已失效" });
    return;
  }
  if (claudeAccountService.handle(req, res, url)) return;
  if (antigravityAccountService.handle(req, res, url)) return;
  const legacyAuthorized = sessionContext.authorized(req);
  const imageRequest = /^\/chat-images\/[a-f0-9-]{36}$/.test(url.pathname);
  const principal = sessionContext.principalFor(req);
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      url.pathname !== "/auth/activate" && browserCookieRequest(req) &&
      !browserOriginAllowed(req)) {
    sendJson(res, 403, { error: "请求来源无效，请刷新页面后重试" });
    return;
  }
  if (authService.handle(req, res, url, principal, legacyAuthorized)) return;
  if (windowsNodeService.handle(req, res, url, principal)) return;
  if (remoteAssist.routes.handleCustomer(req, res, url)) return;
  if (!principal) {
    sendJson(res, 401, { error: "未授权" });
    return;
  }
  if (remoteAssist.routes.handleOperator(req, res, url, principal)) return;
  if (req.method === "GET" && ["/chat/conversations", "/files"].includes(url.pathname)) {
    res.once("finish", () => {
      if (res.statusCode !== 200) return;
      try { authService.recordMigrationAccess(principal, url.pathname === "/files" ? "files" : "conversations"); }
      catch { console.error("Migration access confirmation could not be saved"); }
    });
  }
  if (handleCodexAndFailover(req, res, url, principal)) return;
  const userChat = sessionContext.chatFor(principal);
  if (req.method === "POST" && url.pathname === "/usage/reset") {
    url.pathname = "/chat/usage/reset";
  }
  if (imageRequest && userChat.handlePublicImage(req, res, url)) return;
  if (userChat.handle(req, res, url, principal)) return;
  if (req.method === "GET" && url.pathname === "/files") {
    filesService.listFiles(res, url, sessionContext.filesFor(principal));
    return;
  }
  if (req.method === "POST" && url.pathname === "/files") {
    filesService.upload(req, res, sessionContext.filesFor(principal));
    return;
  }
  if (!principal.legacy && url.pathname.startsWith("/tasks")) {
    sendJson(res, 404, { error: "接口不存在" });
    return;
  }
  if (req.method === "GET" && url.pathname === "/tasks") {
    tasksService.listTasks(res, url);
    return;
  }
  if (req.method === "POST" && url.pathname === "/tasks") {
    tasksService.createTask(req, res);
    return;
  }
  if (req.method === "GET" && url.pathname.startsWith("/tasks/")) {
    const task = tasksService.readTask(url.pathname.slice("/tasks/".length));
    if (!task) {
      sendJson(res, 404, { error: "任务不存在" });
      return;
    }
    sendJson(res, 200, { task: tasksService.publicTask(task) });
    return;
  }
  sendJson(res, 404, { error: "接口不存在" });
});
deviceGateway.attach(server);
server.listen(port, host, () => {
  console.log(`Witt API listening on http://${host}:${port}`);
  tasksService.recoverTasks();
});
