package com.codevibe.dropvault;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Routes incoming WebMessage JSON envelopes from trusted Witt origins
 * to MainActivity.WebBridge and workspace notification hooks.
 */
final class WittBridgeDispatcher {
    interface WorkspaceCallbacks {
        void workspaceRequest(String endpoint, String method, String json, String requestId);
        void taskNotificationSettings(String json);
        void watchTasks(String json);
    }

    private WittBridgeDispatcher() {}

    static void dispatch(String rawMessage, MainActivity.WebBridge webBridge,
                         WorkspaceCallbacks workspace) {
        try {
            JSONObject message = new JSONObject(rawMessage == null ? "{}" : rawMessage);
            String method = message.optString("method", "");
            JSONArray args = message.optJSONArray("args");
            if (args == null) args = new JSONArray();
            switch (method) {
                case "launchSurfaceReady": webBridge.launchSurfaceReady(); break;
                case "contentReady": webBridge.contentReady(args.optString(0, "light")); break;
                case "requestAuthStatus": webBridge.requestAuthStatus(); break;
                case "activateInvite": webBridge.activateInvite(args.optString(0)); break;
                case "requestAdminDevices": webBridge.requestAdminDevices(); break;
                case "requestCodexAccounts": webBridge.requestCodexAccounts(); break;
                case "startCodexLogin": webBridge.startCodexLogin(args.optString(0)); break;
                case "requestCodexLoginStatus": webBridge.requestCodexLoginStatus(args.optString(0)); break;
                case "cancelCodexLogin": webBridge.cancelCodexLogin(args.optString(0)); break;
                case "startXuanyuCodexLogin": webBridge.startXuanyuCodexLogin(); break;
                case "requestXuanyuCodexLoginStatus": webBridge.requestXuanyuCodexLoginStatus(); break;
                case "cancelXuanyuCodexLogin": webBridge.cancelXuanyuCodexLogin(); break;
                case "createInvite": webBridge.createInvite(args.optString(0), args.optInt(1, 1)); break;
                case "disableDevice": webBridge.disableDevice(args.optString(0)); break;
                case "pickFiles": webBridge.pickFiles(); break;
                case "uploadFile": webBridge.uploadFile(args.optString(0)); break;
                case "requestHistory": webBridge.requestHistory(); break;
                case "requestTasks": webBridge.requestTasks(); break;
                case "submitTask": webBridge.submitTask(args.optString(0)); break;
                case "workspaceRequest":
                    workspace.workspaceRequest(args.optString(0), args.optString(1),
                        args.optString(2), args.optString(3));
                    break;
                case "taskNotificationSettings":
                    workspace.taskNotificationSettings(args.optString(0));
                    break;
                case "watchTasks":
                    workspace.watchTasks(args.optString(0));
                    break;
                case "requestConversations": webBridge.requestConversations(); break;
                case "requestCapabilities": webBridge.requestCapabilities(); break;
                case "requestConversation": webBridge.requestConversation(args.optString(0)); break;
                case "requestConversationDelta": webBridge.requestConversationDelta(args.optString(0)); break;
                case "subscribeConversationEvents":
                    webBridge.subscribeConversationEvents(args.optString(0));
                    break;
                case "unsubscribeConversationEvents": webBridge.unsubscribeConversationEvents(); break;
                case "requestUsage": webBridge.requestUsage(args.optString(0)); break;
                case "consumeRateLimitReset": webBridge.consumeRateLimitReset(args.optString(0)); break;
                case "requestStreamDetail":
                    webBridge.requestStreamDetail(args.optString(0), args.optString(1), args.optString(2));
                    break;
                case "createConversation":
                    webBridge.createConversation(args.optString(0), args.optString(1), args.optString(2));
                    break;
                case "createConversationWithPath":
                    webBridge.createConversationWithPath(args.optString(0), args.optString(1),
                        args.optString(2), args.optString(3));
                    break;
                case "createConversationWithProfile":
                    webBridge.createConversationWithProfile(args.optString(0), args.optString(1),
                        args.optString(2), args.optString(3), args.optString(4));
                    break;
                case "updateConversationSettings":
                    webBridge.updateConversationSettings(args.optString(0), args.optString(1),
                        args.optString(2), args.optString(3));
                    break;
                case "updateConversationProject":
                    webBridge.updateConversationProject(args.optString(0), args.optString(1));
                    break;
                case "sendChatMessage":
                    webBridge.sendChatMessage(args.optString(0), args.optString(1),
                        args.optString(2, "[]"));
                    break;
                case "interruptConversation": webBridge.interruptConversation(args.optString(0)); break;
                case "archiveConversation": webBridge.archiveConversation(args.optString(0)); break;
                case "forkConversation": webBridge.forkConversation(args.optString(0)); break;
                case "compactConversation": webBridge.compactConversation(args.optString(0)); break;
                case "reviewConversation": webBridge.reviewConversation(args.optString(0)); break;
                case "resolveApproval":
                    webBridge.resolveApproval(args.optString(0), args.optString(1), args.optString(2));
                    break;
                case "downloadArtifact":
                    webBridge.downloadArtifact(args.optString(0), args.optString(1),
                        args.optString(2), args.optString(3), args.optString(4));
                    break;
                case "downloadImage":
                    webBridge.downloadImage(args.optString(0), args.optString(1), args.optString(2));
                    break;
                case "requestLocalSshStatus": webBridge.requestLocalSshStatus(); break;
                case "requestLocalSshProfiles": webBridge.requestLocalSshProfiles(); break;
                case "connectLocalSsh":
                    webBridge.connectLocalSsh(args.optString(0), args.optString(1),
                        args.optInt(2, 22), args.optString(3));
                    break;
                case "saveAndConnectLocalSsh":
                    webBridge.saveAndConnectLocalSsh(args.optString(0), args.optString(1),
                        args.optString(2), args.optInt(3, 22), args.optString(4));
                    break;
                case "connectSavedLocalSsh": webBridge.connectSavedLocalSsh(args.optString(0)); break;
                case "deleteSavedLocalSsh": webBridge.deleteSavedLocalSsh(args.optString(0)); break;
                case "sendLocalSshInput": webBridge.sendLocalSshInput(args.optString(0)); break;
                case "resizeLocalSsh":
                    webBridge.resizeLocalSsh(args.optInt(0, 120), args.optInt(1, 36));
                    break;
                case "disconnectLocalSsh": webBridge.disconnectLocalSsh(); break;
                case "requestLocalSftp": webBridge.requestLocalSftp(args.optString(0, ".")); break;
                case "pickLocalSftpUpload":
                    webBridge.pickLocalSftpUpload(args.optString(0, "."));
                    break;
                case "downloadLocalSftp":
                    webBridge.downloadLocalSftp(args.optString(0), args.optString(1, "file"));
                    break;
                case "checkForUpdates": webBridge.checkForUpdates(); break;
                default: break;
            }
        } catch (Exception ignored) {}
    }
}
