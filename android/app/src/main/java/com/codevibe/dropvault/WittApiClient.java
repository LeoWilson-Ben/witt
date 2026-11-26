package com.codevibe.dropvault;

import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;

/**
 * Encapsulates all authenticated HTTP API calls between the Android shell and Witt backend,
 * delivering responses back to the WebView via JsCaller.
 */
final class WittApiClient {
    interface JsCaller {
        void call(String script);
    }

    private final ExecutorService network;
    private final WittOriginPolicy originPolicy;
    private final AuthTokenStore authStore;
    private final JsCaller jsCaller;

    WittApiClient(ExecutorService network, WittOriginPolicy originPolicy,
                  AuthTokenStore authStore, JsCaller jsCaller) {
        this.network = network;
        this.originPolicy = originPolicy;
        this.authStore = authStore;
        this.jsCaller = jsCaller;
    }

    HttpURLConnection openApiConnection(String endpoint, String method) throws Exception {
        HttpURLConnection connection = (HttpURLConnection)
            new URL(originPolicy.activeApiUrl() + endpoint).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(30_000);
        connection.setRequestProperty("Authorization", "Bearer " + authStore.apiToken());
        return connection;
    }

    static String readBody(InputStream stream) throws Exception {
        if (stream == null) return "";
        try (BufferedInputStream input = new BufferedInputStream(stream);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int read;
            while ((read = input.read(buffer)) >= 0) output.write(buffer, 0, read);
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    static String apiError(String body) {
        try { return new JSONObject(body).optString("error", "服务器暂时无法处理"); }
        catch (Exception ignored) { return "服务器暂时无法处理"; }
    }

    private void callJs(String script) {
        jsCaller.call(script);
    }

    void requestHistory() {
        network.execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection)
                    new URL(originPolicy.activeApiUrl() + "files?limit=100").openConnection();
                connection.setConnectTimeout(10_000);
                connection.setReadTimeout(15_000);
                connection.setRequestProperty("Authorization", "Bearer " + authStore.apiToken());
                if (connection.getResponseCode() != 200) throw new IllegalStateException("Bad response");
                String body = readBody(connection.getInputStream());
                callJs("window.DropVault.onHistory(" + JSONObject.quote(body) + ")");
            } catch (Exception error) {
                callJs("window.DropVault.onHistoryError()");
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    void requestTasks() {
        network.execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = openApiConnection("tasks?limit=20", "GET");
                if (connection.getResponseCode() != 200) throw new IllegalStateException("Bad response");
                String body = readBody(connection.getInputStream());
                callJs("window.DropVault.onTasks(" + JSONObject.quote(body) + ")");
            } catch (Exception error) {
                callJs("window.DropVault.onTasksError()");
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    void submitTask(String prompt) {
        network.execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = openApiConnection("tasks", "POST");
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                byte[] body = new JSONObject().put("prompt", prompt)
                    .toString().getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(body.length);
                try (OutputStream output = connection.getOutputStream()) {
                    output.write(body);
                }
                int status = connection.getResponseCode();
                InputStream response = status >= 200 && status < 300
                    ? connection.getInputStream() : connection.getErrorStream();
                String responseBody = readBody(response);
                if (status >= 200 && status < 300) {
                    callJs("window.DropVault.onTaskSubmitted(" + JSONObject.quote(responseBody) + ")");
                } else {
                    String message = "任务提交失败";
                    try { message = new JSONObject(responseBody).optString("error", message); }
                    catch (Exception ignored) {}
                    callJs("window.DropVault.onTaskSubmitError(" + JSONObject.quote(message) + ")");
                }
            } catch (Exception error) {
                callJs("window.DropVault.onTaskSubmitError(" + JSONObject.quote("网络异常，请重试") + ")");
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    private synchronized void ensureOpenSession() throws Exception {
        if (!authStore.apiToken().isEmpty()) return;
        for (int attempt = 0; attempt < 2; attempt++) {
            HttpURLConnection connection = (HttpURLConnection)
                new URL(originPolicy.activeApiUrl() + "auth/open-enroll").openConnection();
            try {
                connection.setRequestMethod("POST");
                connection.setDoOutput(true);
                connection.setConnectTimeout(15_000);
                connection.setReadTimeout(60_000);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                byte[] bytes = new JSONObject().put("deviceId", authStore.deviceId())
                    .put("deviceName", Build.MANUFACTURER + " " + Build.MODEL)
                    .toString().getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream output = connection.getOutputStream()) { output.write(bytes); }
                int status = connection.getResponseCode();
                String body = readBody(status >= 200 && status < 300
                    ? connection.getInputStream() : connection.getErrorStream());
                if (status == 409 && attempt == 0) {
                    // An interrupted first login can leave a registered UUID without its local token.
                    authStore.regenerateDeviceId();
                    continue;
                }
                if (status != 201) throw new IllegalStateException("自动登录失败");
                JSONObject result = new JSONObject(body);
                String token = result.optString("token", "");
                if (token.isEmpty() || result.getJSONObject("principal").optBoolean("admin")) {
                    throw new IllegalStateException("设备凭据无效");
                }
                if (!authStore.saveToken(token, true)) {
                    throw new IllegalStateException("设备凭据未能保存");
                }
                return;
            } finally {
                connection.disconnect();
            }
        }
        throw new IllegalStateException("自动登录失败");
    }

    void requestAuthStatus() {
        network.execute(() -> {
            HttpURLConnection connection = null;
            try {
                if (BuildConfig.OPEN_ACCESS && authStore.apiToken().isEmpty()) ensureOpenSession();
                connection = openApiConnection("auth/status", "GET");
                int status = connection.getResponseCode();
                String body = readBody(status >= 200 && status < 300
                    ? connection.getInputStream() : connection.getErrorStream());
                if (status >= 200 && status < 300) {
                    callJs("window.DropVault.onAuthStatus(" + JSONObject.quote(body) + ")");
                } else {
                    callJs("window.DropVault.onAuthError(" + JSONObject.quote(apiError(body)) + ")");
                }
            } catch (Exception error) {
                callJs("window.DropVault.onAuthError(" + JSONObject.quote("无法连接服务器") + ")");
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    void activateInvite(String inviteCode) {
        if (BuildConfig.OPEN_ACCESS) { requestAuthStatus(); return; }
        network.execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection)
                    new URL(originPolicy.activeApiUrl() + "auth/activate").openConnection();
                connection.setRequestMethod("POST");
                connection.setDoOutput(true);
                connection.setConnectTimeout(15_000);
                connection.setReadTimeout(30_000);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                JSONObject payload = new JSONObject()
                    .put("inviteCode", inviteCode == null ? "" : inviteCode.trim())
                    .put("deviceId", authStore.deviceId())
                    .put("deviceName", Build.MANUFACTURER + " " + Build.MODEL);
                byte[] bytes = payload.toString().getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream output = connection.getOutputStream()) { output.write(bytes); }
                int status = connection.getResponseCode();
                String body = readBody(status >= 200 && status < 300
                    ? connection.getInputStream() : connection.getErrorStream());
                if (status >= 200 && status < 300) {
                    String token = new JSONObject(body).optString("token", "");
                    if (token.isEmpty()) throw new IllegalStateException("服务器未返回设备凭据");
                    authStore.saveToken(token, false);
                    callJs("window.DropVault.onActivation(" + JSONObject.quote(body) + ")");
                } else {
                    callJs("window.DropVault.onActivationError(" + JSONObject.quote(apiError(body)) + ")");
                }
            } catch (Exception error) {
                callJs("window.DropVault.onActivationError(" +
                    JSONObject.quote("邀请码激活失败，请检查后重试") + ")");
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    void requestAdmin(String endpoint, String method, String payload, String callback) {
        network.execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = openApiConnection(endpoint, method);
                if (payload != null) {
                    byte[] bytes = payload.getBytes(StandardCharsets.UTF_8);
                    connection.setDoOutput(true);
                    connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                    connection.setFixedLengthStreamingMode(bytes.length);
                    try (OutputStream output = connection.getOutputStream()) { output.write(bytes); }
                }
                int status = connection.getResponseCode();
                String body = readBody(status >= 200 && status < 300
                    ? connection.getInputStream() : connection.getErrorStream());
                if (status >= 200 && status < 300) {
                    callJs(callback + "(" + JSONObject.quote(body) + ")");
                } else {
                    callJs("window.DropVault.onAdminError(" + JSONObject.quote(apiError(body)) + ")");
                }
            } catch (Exception error) {
                callJs("window.DropVault.onAdminError(" + JSONObject.quote("管理请求失败，请重试") + ")");
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    void workspaceRequest(String endpoint, String method, String json, String requestId) {
        if (requestId == null || !requestId.matches("[a-zA-Z0-9_-]{8,100}")) return;
        String clean = endpoint == null ? "" : endpoint.split("\\?", 2)[0];
        boolean allowed = clean.matches("chat/(projects|schedules)(/[a-f0-9-]{36}(/(conversations|run))?)?")
            || clean.matches("chat/conversations/[a-f0-9-]{36}/(cancel|retry|artifact-content)")
            || clean.equals("chat/notifications")
            || clean.matches("windows-nodes(/[a-f0-9-]{36}/tasks)?")
            || clean.equals("windows-nodes/pair");
        if (!allowed || endpoint.contains("..") ||
                !("GET".equals(method) || "POST".equals(method) || "PATCH".equals(method))) {
            callJs("window.WittFeatures?.onResponse(" + JSONObject.quote(requestId) +
                ",false,'{\"error\":\"请求不可用\"}')");
            return;
        }
        network.execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = openApiConnection(endpoint, method);
                if (!"GET".equals(method)) {
                    byte[] bytes = (json == null || json.isEmpty() ? "{}" : json)
                        .getBytes(StandardCharsets.UTF_8);
                    if (bytes.length > 32768) throw new IOException("Payload too large");
                    connection.setDoOutput(true);
                    connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                    connection.setFixedLengthStreamingMode(bytes.length);
                    try (OutputStream out = connection.getOutputStream()) { out.write(bytes); }
                }
                int status = connection.getResponseCode();
                String body = readBody(status >= 200 && status < 300
                    ? connection.getInputStream() : connection.getErrorStream());
                callJs("window.WittFeatures?.onResponse(" + JSONObject.quote(requestId) + "," +
                    (status >= 200 && status < 300) + "," + JSONObject.quote(body) + ")");
            } catch (Exception ignored) {
                callJs("window.WittFeatures?.onResponse(" + JSONObject.quote(requestId) +
                    ",false,'{\"error\":\"请求失败，请重试\"}')");
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    void requestConversations() {
        requestChat("conversations", "window.DropVault.onConversations", "window.DropVault.onChatError");
    }

    void requestCapabilities() {
        requestChat("capabilities", "window.DropVault.onCapabilities", "window.DropVault.onCapabilitiesError");
    }

    void conversationAction(String id, String action, JSONObject payload, String successCallback) {
        if (id == null || !id.matches("[a-f0-9-]{36}")) return;
        network.execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = openApiConnection("chat/conversations/" + id + "/" + action, "POST");
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                byte[] body = (payload == null ? new JSONObject() : payload).toString()
                    .getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(body.length);
                try (OutputStream output = connection.getOutputStream()) { output.write(body); }
                int status = connection.getResponseCode();
                String response = readBody(status >= 200 && status < 300
                    ? connection.getInputStream() : connection.getErrorStream());
                if (status >= 200 && status < 300) {
                    callJs(successCallback + "(" + JSONObject.quote(response) + ")");
                } else {
                    callJs("window.DropVault.onAppServerActionError(" +
                        JSONObject.quote(apiError(response)) + ")");
                }
            } catch (Exception error) {
                callJs("window.DropVault.onAppServerActionError(" +
                    JSONObject.quote("App Server 操作失败，请重试") + ")");
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    void requestConversation(String id) {
        requestChat("conversations/" + id, "window.DropVault.onConversation", "window.DropVault.onChatError");
    }

    void requestConversationDelta(String id) {
        requestChat("conversations/" + id + "/sync",
            "window.DropVault.onConversationDelta", "window.DropVault.onChatError");
    }

    void resolveApproval(String conversationId, String approvalId, String choiceId) {
        if (!String.valueOf(conversationId).matches("[a-f0-9-]{36}") ||
            !String.valueOf(approvalId).matches("[a-f0-9-]{36}")) return;
        network.execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = openApiConnection("chat/conversations/" + conversationId +
                    "/approvals/" + approvalId, "POST");
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                byte[] body = new JSONObject().put("choiceId", choiceId).toString()
                    .getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(body.length);
                try (OutputStream output = connection.getOutputStream()) { output.write(body); }
                int status = connection.getResponseCode();
                String response = readBody(status >= 200 && status < 300
                    ? connection.getInputStream() : connection.getErrorStream());
                if (status >= 200 && status < 300) {
                    callJs("window.DropVault.onApprovalResolved(" + JSONObject.quote(response) + ")");
                } else {
                    callJs("window.DropVault.onApprovalError(" +
                        JSONObject.quote(apiError(response)) + ")");
                }
            } catch (Exception error) {
                callJs("window.DropVault.onApprovalError(" +
                    JSONObject.quote("权限确认失败，请重试") + ")");
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    void requestUsage(String conversationId) {
        String suffix = conversationId != null && conversationId.matches("[a-f0-9-]{36}")
            ? "?conversationId=" + conversationId : "";
        requestChat("usage" + suffix, "window.DropVault.onUsage", "window.DropVault.onUsageError");
    }

    void consumeRateLimitReset(String conversationId) {
        String suffix = conversationId != null && conversationId.matches("[a-f0-9-]{36}")
            ? "?conversationId=" + conversationId : "";
        network.execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = openApiConnection("chat/usage/reset" + suffix, "POST");
                connection.setDoOutput(true);
                connection.getOutputStream().close();
                int status = connection.getResponseCode();
                String response = readBody(status >= 200 && status < 300
                    ? connection.getInputStream() : connection.getErrorStream());
                if (status >= 200 && status < 300) {
                    callJs("window.DropVault.onUsageReset(" + JSONObject.quote(response) + ")");
                } else {
                    callJs("window.DropVault.onUsageResetError(" +
                        JSONObject.quote(apiError(response)) + ")");
                }
            } catch (Exception error) {
                callJs("window.DropVault.onUsageResetError(" +
                    JSONObject.quote("网络异常，请重试") + ")");
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    void requestStreamDetail(String conversationId, String messageId, String entryId) {
        requestChat("conversations/" + conversationId + "/messages/" + messageId +
            "/stream/" + entryId,
            "window.DropVault.onStreamDetail", "window.DropVault.onStreamDetailError");
    }

    void createConversation(String model, String reasoning, String accessMode,
                            String workDir, String codexProfile) {
        network.execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = openApiConnection("chat/conversations", "POST");
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                byte[] body = new JSONObject()
                    .put("model", model)
                    .put("reasoning", reasoning)
                    .put("accessMode", accessMode)
                    .put("workDir", workDir == null ? "" : workDir.trim())
                    .put("codexProfile", codexProfile == null ? "default" : codexProfile)
                    .toString().getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(body.length);
                try (OutputStream output = connection.getOutputStream()) { output.write(body); }
                int status = connection.getResponseCode();
                String response = readBody(status < 300
                    ? connection.getInputStream() : connection.getErrorStream());
                if (status >= 200 && status < 300) {
                    callJs("window.DropVault.onConversationCreated(" + JSONObject.quote(response) + ")");
                } else {
                    callJs("window.DropVault.onChatError(" + JSONObject.quote(apiError(response)) + ")");
                }
            } catch (Exception error) {
                callJs("window.DropVault.onChatError(" + JSONObject.quote("网络异常，请重试") + ")");
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    void updateConversationSettings(String id, String model, String reasoning, String accessMode) {
        network.execute(() -> {
            HttpURLConnection connection = null;
            try {
                byte[] body = new JSONObject()
                    .put("model", model)
                    .put("reasoning", reasoning)
                    .put("accessMode", accessMode)
                    .toString().getBytes(StandardCharsets.UTF_8);
                connection = openApiConnection("chat/conversations/" + id, "PATCH");
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                connection.setFixedLengthStreamingMode(body.length);
                try (OutputStream output = connection.getOutputStream()) { output.write(body); }
                int status = connection.getResponseCode();
                String response = readBody(status >= 200 && status < 300
                    ? connection.getInputStream() : connection.getErrorStream());
                if (status >= 200 && status < 300) {
                    callJs("window.DropVault.onSettingsUpdated(" + JSONObject.quote(response) + ")");
                } else {
                    callJs("window.DropVault.onChatError(" + JSONObject.quote(apiError(response)) + ")");
                }
            } catch (Exception error) {
                callJs("window.DropVault.onChatError(" + JSONObject.quote("设置保存失败，请重试") + ")");
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    void updateConversationProject(String id, String workDir) {
        network.execute(() -> {
            HttpURLConnection connection = null;
            try {
                byte[] body = new JSONObject()
                    .put("workDir", workDir == null ? "" : workDir.trim())
                    .toString().getBytes(StandardCharsets.UTF_8);
                connection = openApiConnection("chat/conversations/" + id, "PATCH");
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                connection.setFixedLengthStreamingMode(body.length);
                try (OutputStream output = connection.getOutputStream()) { output.write(body); }
                int status = connection.getResponseCode();
                String response = readBody(status >= 200 && status < 300
                    ? connection.getInputStream() : connection.getErrorStream());
                if (status >= 200 && status < 300) {
                    callJs("window.DropVault.onConversationProjectUpdated(" +
                        JSONObject.quote(response) + ")");
                } else {
                    callJs("window.DropVault.onConversationProjectError(" +
                        JSONObject.quote(apiError(response)) + ")");
                }
            } catch (Exception error) {
                callJs("window.DropVault.onConversationProjectError(" +
                    JSONObject.quote("项目切换失败，请重试") + ")");
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    void sendChatMessage(String conversationId, String text, String attachmentIdsJson) {
        network.execute(() -> {
            HttpURLConnection connection = null;
            try {
                JSONArray attachmentIds;
                try { attachmentIds = new JSONArray(attachmentIdsJson); }
                catch (Exception ignored) { attachmentIds = new JSONArray(); }
                JSONObject payload = new JSONObject()
                    .put("text", text)
                    .put("attachmentIds", attachmentIds);
                byte[] body = payload.toString().getBytes(StandardCharsets.UTF_8);
                connection = openApiConnection("chat/conversations/" + conversationId + "/messages", "POST");
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                connection.setFixedLengthStreamingMode(body.length);
                try (OutputStream output = connection.getOutputStream()) { output.write(body); }
                int status = connection.getResponseCode();
                String response = readBody(status >= 200 && status < 300
                    ? connection.getInputStream() : connection.getErrorStream());
                if (status >= 200 && status < 300) {
                    callJs("window.DropVault.onMessageSent(" + JSONObject.quote(response) + ")");
                } else {
                    callJs("window.DropVault.onMessageSendError(" +
                        JSONObject.quote(apiError(response)) + ")");
                }
            } catch (Exception error) {
                callJs("window.DropVault.onMessageSendError(" +
                    JSONObject.quote("网络异常，请重试") + ")");
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    void interruptConversation(String conversationId) {
        network.execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = openApiConnection(
                    "chat/conversations/" + conversationId + "/interrupt", "POST");
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(0);
                int status = connection.getResponseCode();
                String response = readBody(status >= 200 && status < 300
                    ? connection.getInputStream() : connection.getErrorStream());
                if (status >= 200 && status < 300) {
                    callJs("window.DropVault.onConversationInterruptRequested(" +
                        JSONObject.quote(response) + ")");
                } else {
                    callJs("window.DropVault.onConversationInterruptError(" +
                        JSONObject.quote(apiError(response)) + ")");
                }
            } catch (Exception error) {
                callJs("window.DropVault.onConversationInterruptError(" +
                    JSONObject.quote("网络异常，请重试") + ")");
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    void archiveConversation(String id) {
        network.execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = openApiConnection("chat/conversations/" + id, "DELETE");
                int status = connection.getResponseCode();
                String response = readBody(status >= 200 && status < 300
                    ? connection.getInputStream() : connection.getErrorStream());
                if (status >= 200 && status < 300) {
                    callJs("window.DropVault.onConversationArchived(" + JSONObject.quote(id) + ")");
                } else {
                    callJs("window.DropVault.onChatError(" + JSONObject.quote(apiError(response)) + ")");
                }
            } catch (Exception error) {
                callJs("window.DropVault.onChatError(" + JSONObject.quote("网络异常，请重试") + ")");
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    private void requestChat(String endpoint, String successCallback, String errorCallback) {
        network.execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = openApiConnection("chat/" + endpoint, "GET");
                int status = connection.getResponseCode();
                String response = readBody(status >= 200 && status < 300
                    ? connection.getInputStream() : connection.getErrorStream());
                if (status >= 200 && status < 300) {
                    callJs(successCallback + "(" + JSONObject.quote(response) + ")");
                } else {
                    callJs(errorCallback + "(" + JSONObject.quote(apiError(response)) + ")");
                }
            } catch (Exception error) {
                callJs(errorCallback + "(" + JSONObject.quote("网络异常，请重试") + ")");
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }
}
