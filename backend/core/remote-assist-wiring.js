"use strict";

const path = require("node:path");
const { DeviceGateway } = require("../remote-device/device-gateway");
const { WorkspaceStore, WorkspaceAuditStore, ApprovalGate, WorkspaceDispatcher } = require("../remote-workspace");
const { RemoteWorkspaceService } = require("../remote-workspace-service");
const { createRemoteAssist } = require("../remote-assist");

function createRemoteAssistServices({
  remoteAssistDir,
  host,
  port,
  readJsonBody,
  sendJson,
  chatFor,
}) {
  const deviceGateway = new DeviceGateway({ configFile: path.join(remoteAssistDir, "devices.json") });
  const workspaceStore = new WorkspaceStore(remoteAssistDir);
  const workspaceApprovals = new ApprovalGate();
  const workspaceAudit = new WorkspaceAuditStore(remoteAssistDir);
  let remoteWorkspaceService = null;
  const remoteAssist = createRemoteAssist({
    gateway: deviceGateway,
    workspaceStore,
    auditDirectory: remoteAssistDir,
    readJsonBody,
    sendJson,
    chatFor,
    prepareWorkspace: (workspace) => remoteWorkspaceService?.runtimeFor(workspace),
    onWorkspaceClosed: (workspaceId) => remoteWorkspaceService?.destroySpace(workspaceId),
  });
  const workspaceDispatcher = new WorkspaceDispatcher({
    workspaceStore,
    transport: remoteAssist.transport,
    approvals: workspaceApprovals,
    audit: workspaceAudit,
    assistCommandsFor: (deviceId) => remoteAssist.sessions.commandsAllowed(deviceId),
    fullAccessFor: (deviceId) => remoteAssist.sessions.fullAccessAllowed(deviceId),
  });
  remoteWorkspaceService = new RemoteWorkspaceService({
    workspaceStore,
    dispatcher: workspaceDispatcher,
    approvals: workspaceApprovals,
    audit: workspaceAudit,
    runtimeDir: path.join(remoteAssistDir, "runtime"),
    apiBase: `http://${host}:${port}`,
    capabilitiesFor: (deviceId) => deviceGateway.registry.definition(deviceId)?.capabilities || null,
  });
  return { deviceGateway, remoteAssist, remoteWorkspaceService };
}

module.exports = { createRemoteAssistServices };
