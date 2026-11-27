(() => {
  "use strict";
  if (window.WittNative || window.DropVaultAndroid) return;

  document.body?.classList.add("web-browser");

  const API = "/vault-api/";
  const files = new Map();
  let events = null;

  const callback = (name, ...args) => {
    const fn = window.DropVault?.[name];
    if (typeof fn === "function") fn(...args);
  };
  const payload = (value) => JSON.stringify(value);
  const parse = (text) => {
    try { return text ? JSON.parse(text) : {}; }
    catch { return {}; }
  };
  const message = (text, fallback) => parse(text).error || fallback;
  const validId = (value) => /^[a-f0-9-]{36}$/.test(String(value || ""));
  const encode = (value) => encodeURIComponent(String(value || ""));
  const browserDeviceId = () => {
    let value = localStorage.getItem("witt_web_device_id");
    if (!validId(value)) {
      value = crypto.randomUUID();
      localStorage.setItem("witt_web_device_id", value);
    }
    return value;
  };

  async function request(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.json !== undefined) {
      headers.set("Content-Type", "application/json; charset=utf-8");
      options.body = JSON.stringify(options.json);
    }
    const response = await fetch(API + path, {
      ...options,
      headers,
      credentials: "same-origin",
      cache: "no-store",
    });
    const text = await response.text();
    if (!response.ok) throw new Error(message(text, `服务器请求失败（${response.status}）`));
    return text || "{}";
  }

  function run(path, options, success, failure, fallback) {
    request(path, options).then((text) => callback(success, text))
      .catch((error) => callback(failure, error.message || fallback));
  }

  function conversationAction(id, action, body, success) {
    if (!validId(id)) return;
    run(`chat/conversations/${id}/${action}`, { method: "POST", json: body || {} },
      success, "onAppServerActionError", "操作失败，请重试");
  }

  function download(path, name, artifact = null) {
    const progress = (status, loaded = 0, total = 0, error = "") => {
      if (artifact) callback("onArtifactDownloadProgress", payload({ ...artifact, status, loaded, total, error }));
    };
    return Promise.resolve().then(async () => {
      progress("starting");
      const response = await fetch(API + path, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error(`下载失败（${response.status}）`);
      const total = Number(response.headers.get("Content-Length")) || 0;
      let loaded = 0; const chunks = [];
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const result = await reader.read();
          if (result.done) break;
          chunks.push(result.value); loaded += result.value.byteLength;
          progress("downloading", loaded, total);
        }
      } else { const buffer = await response.arrayBuffer(); chunks.push(buffer); loaded = buffer.byteLength; }
      progress("saving", loaded, total);
      const url = URL.createObjectURL(new Blob(chunks, { type: response.headers.get("Content-Type") || "application/octet-stream" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = name || "Witt-文件";
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      progress("completed", loaded, total || loaded);
    }).catch((error) => {
      if (artifact) progress("failed", 0, 0, error.message || "下载失败");
      else callback("onChatError", error.message || "下载失败");
    });
  }

  const bridge = {
    getVersion: () => "3.0.0",
    getCacheScope() {
      let value = localStorage.getItem("witt_web_cache_scope");
      if (!/^[a-f0-9]{32}$/.test(value || "")) {
        value = [...crypto.getRandomValues(new Uint8Array(16))]
          .map((item) => item.toString(16).padStart(2, "0")).join("");
        localStorage.setItem("witt_web_cache_scope", value);
      }
      return value;
    },
    hasBundledLumoraMedia: () => false,
    contentReady: () => {},
    launchSurfaceReady: () => {},
    checkForUpdates: () => {},

    requestAuthStatus() {
      run("auth/status", {}, "onAuthStatus", "onAuthError", "无法连接服务器");
    },
    activateInvite(inviteCode) {
      request("auth/activate", {
        method: "POST",
        headers: { "X-Witt-Client": "browser" },
        json: {
          inviteCode: String(inviteCode || "").trim(),
          deviceId: browserDeviceId(),
          deviceName: `${navigator.platform || "浏览器"} · Web`,
        },
      }).then((text) => callback("onActivation", text))
        .catch((error) => callback("onActivationError", error.message || "邀请码激活失败"));
    },
    requestConversations() {
      run("chat/conversations", {}, "onConversations", "onChatError", "无法读取对话");
    },
    searchConversations(query, project, attachments, requestId) {
      const params = new URLSearchParams({ q: query || "" });
      if (project) {
        if (project === "__none__" || validId(project)) params.set("projectId", project);
        else params.set("project", project);
      }
      if (String(attachments) === "true") params.set("attachments", "1");
      request(`chat/conversations?${params}`).then((text) => {
        const data = parse(text);
        data.requestId = requestId;
        callback("onHistorySearch", payload(data));
      }).catch((error) => callback("onHistorySearchError", error.message));
    },
    requestCapabilities() {
      run("chat/capabilities", {}, "onCapabilities", "onCapabilitiesError", "无法读取服务能力");
    },
    requestConversation(id) {
      if (validId(id)) run(`chat/conversations/${id}?view=latest`, {}, "onConversation", "onChatError", "无法读取对话");
    },
    requestConversationDelta(id) {
      if (validId(id)) run(`chat/conversations/${id}/sync`, {}, "onConversationDelta", "onChatError", "同步失败");
    },
    requestConversationPage(id, before, limit) {
      if (!validId(id)) return;
      run(`chat/conversations/${id}/messages?before=${encode(before)}&limit=${encode(limit || 40)}`,
        {}, "onConversationPage", "onConversationPageError", "历史消息加载失败");
    },
    subscribeConversationEvents(id) {
      if (!validId(id)) return;
      this.unsubscribeConversationEvents();
      events = new EventSource(`${API}chat/conversations/${id}/events?view=latest`);
      const source = events;
      let receivedSnapshot = false, fallbackRequested = false;
      events.addEventListener("snapshot", (event) => {
        if (events !== source) return;
        receivedSnapshot = true;
        callback("onConversation", event.data);
      });
      events.addEventListener("delta", (event) => {
        if (events === source) callback("onConversationDelta", event.data);
      });
      events.addEventListener("error", () => {
        if (events === source && !receivedSnapshot && !fallbackRequested) {
          fallbackRequested = true;
          this.requestConversation(id);
        }
      });
    },
    unsubscribeConversationEvents() {
      events?.close();
      events = null;
    },
    requestUsage(conversationId) {
      const suffix = validId(conversationId) ? `?conversationId=${conversationId}` : "";
      run(`chat/usage${suffix}`, {}, "onUsage", "onUsageError", "无法读取用量");
    },
    consumeRateLimitReset(conversationId) {
      const suffix = validId(conversationId) ? `?conversationId=${conversationId}` : "";
      run(`chat/usage/reset${suffix}`, { method: "POST" }, "onUsageReset", "onUsageResetError", "重置失败");
    },
    requestStreamDetail(conversationId, messageId, entryId) {
      run(`chat/conversations/${conversationId}/messages/${messageId}/stream/${encode(entryId)}`,
        {}, "onStreamDetail", "onStreamDetailError", "无法读取执行详情");
    },
    createConversation(model, reasoning, accessMode) {
      this.createConversationWithProfile(model, reasoning, accessMode, "", "default");
    },
    createConversationWithPath(model, reasoning, accessMode, workDir) {
      this.createConversationWithProfile(model, reasoning, accessMode, workDir, "default");
    },
    createConversationWithProfile(model, reasoning, accessMode, workDir, codexProfile) {
      run("chat/conversations", { method: "POST", json: {
        model, reasoning, accessMode, workDir: workDir || "", codexProfile: codexProfile || "default",
      } }, "onConversationCreated", "onChatError", "无法创建对话");
    },
    updateConversationSettings(id, model, reasoning, accessMode, codexProfile) {
      const payload = { model, reasoning, accessMode };
      if (codexProfile) payload.codexProfile = codexProfile;
      run(`chat/conversations/${id}`, { method: "PATCH", json: payload },
        "onSettingsUpdated", "onChatError", "设置保存失败");
    },
    updateConversationProject(id, projectOrWorkDir) {
      const raw = String(projectOrWorkDir || "").trim();
      const workspaceProjectId = raw.startsWith("project:") ? raw.slice("project:".length) : (raw || null);
      run(`chat/conversations/${id}`, { method: "PATCH", json: { workspaceProjectId } },
        "onConversationProjectUpdated", "onConversationProjectError", "项目切换失败");
    },
    updateConversationMetadata(id, json) {
      run(`chat/conversations/${id}`, { method: "PATCH", json: parse(json) },
        "onConversationMetadataUpdated", "onConversationMetadataError", "同步失败");
    },
    sendChatMessage(id, text, attachmentIdsJson, toolMode = "") {
      this.sendChatMessageWithRequestId(id, text, attachmentIdsJson, "", toolMode);
    },
    sendChatMessageWithRequestId(id, text, attachmentIdsJson, clientRequestId, toolMode = "") {
      request(`chat/conversations/${id}/messages`, { method: "POST", json: {
        text, attachmentIds: parse(attachmentIdsJson),
        ...(clientRequestId ? { clientRequestId } : {}),
        ...(toolMode ? { toolMode } : {}),
      } }).then((responseText) => {
        const data = parse(responseText);
        if (clientRequestId) data.clientRequestId = clientRequestId;
        callback("onMessageSent", payload(data));
      }).catch((error) => callback("onMessageSendError", error.message, clientRequestId));
    },
    interruptConversation(id) {
      conversationAction(id, "interrupt", {}, "onConversationInterruptRequested");
    },
    archiveConversation(id) {
      request(`chat/conversations/${id}`, { method: "DELETE" })
        .then(() => callback("onConversationArchived", id))
        .catch((error) => callback("onChatError", error.message));
    },
    forkConversation(id) { conversationAction(id, "fork", {}, "onConversationForked"); },
    compactConversation(id) { conversationAction(id, "compact", {}, "onConversationCompacted"); },
    reviewConversation(id) { conversationAction(id, "review", { type: "uncommittedChanges" }, "onReviewStarted"); },
    resolveApproval(conversationId, approvalId, choiceId) {
      run(`chat/conversations/${conversationId}/approvals/${approvalId}`,
        { method: "POST", json: { choiceId } }, "onApprovalResolved", "onApprovalError", "权限确认失败");
    },
    requestWorkspaceOverview() {
      run("chat/workspace-overview", {}, "onWorkspaceOverview", "onWorkspaceOverviewError", "检查失败");
    },

    requestAdminDevices() { run("admin/devices", {}, "onAdminDevices", "onAdminError", "无法读取设备"); },
    createInvite(label, maxDevices) {
      run("admin/invites", { method: "POST", json: { label, maxDevices } },
        "onInviteCreated", "onAdminError", "无法创建邀请码");
    },
    disableDevice(id) {
      run(`admin/devices/${id}/disable`, { method: "POST", json: {} },
        "onDeviceDisabled", "onAdminError", "无法停用设备");
    },
    requestCodexAccounts() {
      run("codex/accounts", {}, "onCodexAccounts", "onAdminError", "无法读取账号");
    },
    startCodexLogin(profileId) {
      run(`codex/accounts/${encode(profileId)}/login/start`, { method: "POST", json: {} },
        "onCodexLoginStarted", "onAdminError", "无法开始登录");
    },
    requestCodexLoginStatus(profileId) {
      run(`codex/accounts/${encode(profileId)}/login/status`, {},
        "onCodexLoginStatus", "onAdminError", "无法读取登录状态");
    },
    cancelCodexLogin(profileId) {
      run(`codex/accounts/${encode(profileId)}/login/cancel`, { method: "POST", json: {} },
        "onCodexLoginCancelled", "onAdminError", "无法取消登录");
    },
    startXuanyuCodexLogin() {
      run("codex/accounts/xuanyu/login/start", { method: "POST", json: {} },
        "onCodexLoginStarted", "onAdminError", "无法开始登录");
    },
    requestXuanyuCodexLoginStatus() {
      run("codex/accounts/xuanyu/login/status", {}, "onCodexLoginStatus", "onAdminError", "无法读取登录状态");
    },
    cancelXuanyuCodexLogin() {
      run("codex/accounts/xuanyu/login/cancel", { method: "POST", json: {} },
        "onCodexLoginCancelled", "onAdminError", "无法取消登录");
    },

    addPickedFiles(fileList) {
      const selected = [...(fileList || [])]
        .filter((file) => file && file.size >= 0 && file.size <= 500 * 1024 * 1024)
        .map((file) => {
          const id = crypto.randomUUID();
          const relName = file.webkitRelativePath ? file.webkitRelativePath.replace(/^\/+/, "") : (file.name || `file-${Date.now()}`);
          files.set(id, file);
          const isImg = /^image\//i.test(file.type || "") || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(relName);
          let previewUrl = "";
          if (isImg) { try { previewUrl = URL.createObjectURL(file); } catch {} }
          return { id, name: relName, size: file.size, type: file.type || "application/octet-stream", ...(previewUrl ? { previewUrl } : {}) };
        });
      if (selected.length) callback("onFilesPicked", payload(selected));
      return selected.length;
    },
    pickFiles() {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.onchange = () => {
        this.addPickedFiles(input.files);
      };
      input.click();
    },
    pickFolder() {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.setAttribute("webkitdirectory", "");
      input.setAttribute("directory", "");
      const ignored = /(^|\/)(\.git|node_modules|dist|build|\.next|\.nuxt|__pycache__|\.venv|venv|target|\.gradle|\.idea|\.vscode|\.DS_Store)(\/|$)/i;
      input.onchange = () => {
        const raw = [...(input.files || [])];
        const filtered = raw.filter((file) => {
          const rel = file.webkitRelativePath || file.name || "";
          return file.size > 0 && !ignored.test(rel);
        });
        const maxFiles = 40;
        const picked = filtered.slice(0, maxFiles);
        const added = this.addPickedFiles(picked);
        if (!added) {
          callback("onChatError", "未找到可上传的有效文件（空文件或依赖目录已自动忽略）");
        } else if (filtered.length > maxFiles) {
          callback("onChatError", `目录文件较多，已选取前 ${maxFiles} 个文件`);
        }
      };
      input.click();
    },
    async captureMedia() {
      const isTouch = window.matchMedia?.("(pointer: coarse)")?.matches;
      const canScreenCapture = !isTouch && typeof navigator.mediaDevices?.getDisplayMedia === "function";
      if (!canScreenCapture) {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.setAttribute("capture", "environment");
        input.onchange = () => {
          this.addPickedFiles(input.files);
        };
        input.click();
        return;
      }
      let stream = null;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: "always" }, audio: false });
        const video = document.createElement("video");
        video.srcObject = stream;
        video.muted = true;
        await video.play();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const width = video.videoWidth || 1280;
        const height = video.videoHeight || 720;
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d")?.drawImage(video, 0, 0, width, height);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
        if (blob) {
          const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          const file = new File([blob], `screenshot-${stamp}.png`, { type: "image/png" });
          this.addPickedFiles([file]);
        }
      } catch (error) {
        if (error?.name !== "AbortError" && error?.name !== "NotAllowedError") {
          callback("onChatError", error?.message || "截屏失败，请重试");
        }
      } finally {
        stream?.getTracks?.().forEach((track) => track.stop());
      }
    },
    uploadFile(id) {
      const file = files.get(id);
      if (!file) { callback("onUploadFinished", id, false, "文件授权已失效，请重新选择", ""); return; }
      const xhr = new XMLHttpRequest();
      xhr.open("POST", API + "files");
      xhr.withCredentials = true;
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
      xhr.setRequestHeader("X-File-Type", file.type || "application/octet-stream");
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) callback("onUploadProgress", id, Math.min(99, Math.round(event.loaded * 100 / event.total)));
      };
      xhr.onload = () => {
        const ok = xhr.status >= 200 && xhr.status < 300;
        if (ok) files.delete(id);
        callback("onUploadFinished", id, ok, ok ? "" : message(xhr.responseText, "上传失败"), ok ? xhr.responseText : "");
      };
      xhr.onerror = () => callback("onUploadFinished", id, false, "网络异常，请重试", "");
      xhr.send(file);
    },
    downloadArtifact(conversationId, messageId, artifactId, name) {
      return download(`chat/conversations/${conversationId}/messages/${messageId}/artifacts/${artifactId}`, name, { conversationId, messageId, artifactId });
    },
    downloadImage(url, name) {
      const resolved = new URL(String(url), location.origin);
      const prefix = `${location.origin}${API}`;
      if (!resolved.href.startsWith(prefix)) return;
      download(resolved.href.slice(prefix.length), name);
    },
  };

  window.DropVaultAndroid = bridge;
  const ready = () => {
    if (!window.DropVault?.nativeReady) { setTimeout(ready, 10); return; }
    document.getElementById("localSshButton")?.setAttribute("hidden", "");
    document.getElementById("updateButton")?.setAttribute("hidden", "");
    const drawerTitle = document.querySelector(".drawer-head h2");
    if (drawerTitle) drawerTitle.textContent = "Witt";
    const input = document.getElementById("messageInput");
    if (input) input.placeholder = "向 Witt 发送消息";
    window.DropVault.nativeReady({
      version: "3.0.0",
      cacheScope: bridge.getCacheScope(),
      workspaceFeatures: true,
      supportsSse: true,
      browser: true,
      artifactDownloadProgress: true,
    });
  };
  ready();
})();
