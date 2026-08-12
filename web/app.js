(() => {
  const $ = (selector) => document.querySelector(selector);
  const nativeBridge = new Proxy({}, {
    get(_target, method) {
      return (...args) => window.WittNative?.postMessage(JSON.stringify({ method, args }));
    },
  });
  const bridge = () => window.WittNative ? nativeBridge : (window.DropVaultAndroid || null);
  const state = {
    conversations: [],
    activeId: localStorage.getItem("wit_active_conversation") || null,
    active: null,
    attachments: new Map(),
    pendingSend: null,
    sending: false,
    archiveId: null,
    lastCompletedId: null,
    model: localStorage.getItem("wit_model") || "gpt-5.6-sol",
    reasoning: localStorage.getItem("wit_reasoning") || "medium",
    accessMode: localStorage.getItem("wit_access") || "danger-full-access",
    codexProfile: localStorage.getItem("wit_codex_profile") || "default",
    allowedCodexProfiles: ["default"],
    workDir: "",
    optimisticMessage: null,
    draftModel: null,
    draftReasoning: null,
    draftAccessMode: null,
    busy: false,
    transmitting: false,
    pausing: false,
    lastSubmittedText: "",
    supports21: false,
    nativeInitialized: false,
    detailRequest: null,
    usage: null,
    usageLoading: false,
    authenticated: false,
    admin: false,
    bootstrapClaiming: false,
    expandedMessages: new Set(),
    activeScene: Math.min(2, Math.max(0,
      Number.parseInt(localStorage.getItem("wit_scene") || "0", 10) || 0)),
    sceneTransitioning: false,
    cacheScope: "",
    cacheHydrated: false,
    codexAccounts: [],
    codexLoginUrl: "",
    codexLoginTimer: null,
    appVisible: !document.hidden,
    supportsSse: false,
    capabilities: null,
  };
  let pollTimer;
  let toastTimer;
  let collapseResizeTimer;
  function applyTheme(mode, persist = false) {
    const selected = ["light", "colorful", "dark"].includes(mode) ? mode : "colorful";
    const resolved = selected;
    document.documentElement.dataset.themeMode = selected;
    document.documentElement.dataset.theme = resolved;
    if (persist) localStorage.setItem("wit_theme", selected);
    const cinematicStylesheet = $("#cinematicStylesheet");
    if (cinematicStylesheet) cinematicStylesheet.disabled = selected !== "colorful";
    $("#themeColor")?.setAttribute("content",
      resolved === "light" ? "#f7f8fc" : resolved === "dark" ? "#08111f" : "#000000");
    document.querySelectorAll("[data-scene-video]").forEach((video) => {
      const active = Number(video.dataset.sceneVideo) === state.activeScene;
      if (state.appVisible && selected === "colorful" && active) video.play().catch(() => {});
      else video.pause();
    });
    document.querySelectorAll("[data-theme-choice]").forEach((button) => {
      const active = button.dataset.themeChoice === selected;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  }

  function setScene(index, force = false) {
    const target = Number(index);
    if (!Number.isInteger(target) || target < 0 || target > 2) return;
    if (!force && (state.sceneTransitioning || target === state.activeScene)) return;
    state.activeScene = target;
    localStorage.setItem("wit_scene", String(target));
    document.documentElement.dataset.sceneTone = target === 2 ? "dark" : "light";
    document.querySelectorAll("[data-scene-video]").forEach((video) => {
      const active = Number(video.dataset.sceneVideo) === target;
      video.classList.toggle("active", active);
      if (state.appVisible && active && document.documentElement.dataset.themeMode === "colorful") {
        if (video.currentTime > .05 || video.ended) video.currentTime = 0;
        video.play().catch(() => {});
      } else {
        video.pause();
      }
    });
    if (!force) {
      state.sceneTransitioning = true;
      setTimeout(() => { state.sceneTransitioning = false; }, 1000);
    }
  }

  applyTheme(localStorage.getItem("wit_theme") || "colorful");
  setScene(state.activeScene, true);
  document.querySelectorAll("[data-scene-video]").forEach((video) => {
    video.addEventListener("ended", () => {
      const index = Number(video.dataset.sceneVideo);
      if (document.documentElement.dataset.themeMode !== "colorful" ||
          index !== state.activeScene) return;
      setScene((index + 1) % 3, true);
    });
  });
  function escapeHtml(value) {
    const node = document.createElement("span");
    node.textContent = String(value ?? "");
    return node.innerHTML;
  }

  function formatBytes(bytes) {
    if (!Number(bytes)) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / Math.pow(1024, index)).toFixed(index ? 1 : 0)} ${units[index]}`;
  }

  function formatDate(iso) {
    const date = new Date(iso);
    const now = new Date();
    if (date.toDateString() === now.toDateString()) {
      return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    }
    return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
  }

  function taskDurationMs(message) {
    const start = Date.parse(message.startedAt || message.createdAt || "");
    let end = Date.parse(message.completedAt || "");
    if (!Number.isFinite(end)) {
      end = Math.max(...(message.stream || [])
        .map((entry) => Date.parse(entry.createdAt || ""))
        .filter(Number.isFinite), start);
    }
    return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
  }

  function formatTaskDuration(durationMs) {
    if (!Number.isFinite(durationMs)) return "用时未知";
    const seconds = Math.max(1, Math.round(durationMs / 1000));
    if (seconds < 60) return `用时 ${seconds} 秒`;
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    if (minutes < 60) return `用时 ${minutes} 分${remainder ? ` ${remainder} 秒` : ""}`;
    const hours = Math.floor(minutes / 60);
    const minuteRemainder = minutes % 60;
    return `用时 ${hours} 小时${minuteRemainder ? ` ${minuteRemainder} 分` : ""}`;
  }

  const cacheDatabase = (() => {
    if (!("indexedDB" in window)) return Promise.resolve(null);
    return new Promise((resolve) => {
      const request = indexedDB.open("witt-local-conversations", 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("records")) {
          request.result.createObjectStore("records", { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
  })();

  async function cacheRecord(key, value) {
    if (!state.cacheScope || !key) return;
    const database = await cacheDatabase;
    if (!database) return;
    await new Promise((resolve) => {
      const transaction = database.transaction("records", "readwrite");
      transaction.objectStore("records").put({
        key: `${state.cacheScope}:${key}`,
        value,
        savedAt: Date.now(),
      });
      transaction.oncomplete = resolve;
      transaction.onerror = resolve;
      transaction.onabort = resolve;
    });
  }

  async function readCachedRecord(key) {
    if (!state.cacheScope || !key) return null;
    const database = await cacheDatabase;
    if (!database) return null;
    return new Promise((resolve) => {
      const request = database.transaction("records", "readonly")
        .objectStore("records").get(`${state.cacheScope}:${key}`);
      request.onsuccess = () => resolve(request.result?.value || null);
      request.onerror = () => resolve(null);
    });
  }

  async function deleteCachedRecord(key) {
    if (!state.cacheScope || !key) return;
    const database = await cacheDatabase;
    if (!database) return;
    await new Promise((resolve) => {
      const transaction = database.transaction("records", "readwrite");
      transaction.objectStore("records").delete(`${state.cacheScope}:${key}`);
      transaction.oncomplete = resolve;
      transaction.onerror = resolve;
      transaction.onabort = resolve;
    });
  }

  function persistConversationList() {
    cacheRecord("list", state.conversations);
  }

  function persistConversation(conversation = state.active) {
    if (conversation?.id) cacheRecord(`conversation:${conversation.id}`, conversation);
  }

  async function hydrateConversationCache() {
    if (state.cacheHydrated) return;
    const scope = state.cacheScope || "";
    if (!/^[a-f0-9]{24,64}$/.test(scope)) return;
    state.cacheScope = scope;
    const cachedList = await readCachedRecord("list");
    if (Array.isArray(cachedList)) {
      state.conversations = cachedList;
      renderConversations();
    }
    const preferredId = state.activeId &&
      state.conversations.some((item) => item.id === state.activeId)
      ? state.activeId
      : state.conversations[0]?.id;
    if (preferredId) {
      const cachedConversation = await readCachedRecord(`conversation:${preferredId}`);
      if (cachedConversation?.id === preferredId) {
        state.activeId = preferredId;
        state.active = cachedConversation;
        state.model = cachedConversation.model || state.model;
        state.reasoning = cachedConversation.reasoning || state.reasoning;
        state.accessMode = cachedConversation.accessMode || state.accessMode;
        state.codexProfile = cachedConversation.codexProfile || state.codexProfile;
        state.workDir = cachedConversation.workDir || "";
        localStorage.setItem("wit_active_conversation", preferredId);
        updateModelControls();
        setConnected(true, "已载入本地记录 · 正在同步");
        dismissBoot();
        renderMessages();
      }
    }
    state.cacheHydrated = true;
  }

  function versionLessThan(current, target) {
    const left = String(current || "").split(".").map((part) => Number.parseInt(part, 10) || 0);
    const right = String(target || "").split(".").map((part) => Number.parseInt(part, 10) || 0);
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      if ((left[index] || 0) !== (right[index] || 0)) {
        return (left[index] || 0) < (right[index] || 0);
      }
    }
    return false;
  }

  function extension(name) {
    const ext = String(name || "").split(".").pop();
    return ext && ext !== name ? ext.slice(0, 5).toUpperCase() : "FILE";
  }

  function toast(message) {
    const node = $("#toast");
    node.textContent = message;
    node.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove("show"), 2600);
  }

  function formulaHtml(source, displayMode = false) {
    const formula = String(source || "").trim();
    if (!formula) return "";
    if (!window.katex?.renderToString) {
      return `<code class="math-fallback">${escapeHtml(formula)}</code>`;
    }
    try {
      return `<span class="math-render${displayMode ? " display" : ""}">${window.katex.renderToString(formula, {
        displayMode,
        throwOnError: false,
        strict: "ignore",
        trust: false,
        output: "htmlAndMathml",
      })}</span>`;
    } catch {
      return `<code class="math-fallback">${escapeHtml(formula)}</code>`;
    }
  }

  function safeWebUrl(value) {
    try {
      const url = new URL(String(value || "").trim());
      return ["http:", "https:"].includes(url.protocol) ? url.href : "";
    } catch {
      return "";
    }
  }

  function chatLinkHtml(label, target) {
    const url = safeWebUrl(target);
    if (!url) return escapeHtml(label || target);
    return `<a class="chat-link" href="${escapeHtml(url)}" rel="noopener noreferrer" aria-label="${escapeHtml(label || url)}，打开链接">${escapeHtml(label || url)}<span aria-hidden="true">↗</span></a>`;
  }

  function inlineRichHtml(value) {
    const fragments = [];
    const hold = (html) => {
      const token = `WITTRICH${fragments.length}TOKEN`;
      fragments.push({ token, html });
      return token;
    };
    let source = String(value || "");
    source = source.replace(/`([^`\n]+)`/g, (_, code) =>
      hold(`<code class="inline-code">${escapeHtml(code)}</code>`));
    source = source.replace(/\$\$([\s\S]+?)\$\$/g, (_, formula) =>
      hold(formulaHtml(formula, true)));
    source = source.replace(/\\\[([\s\S]+?)\\\]/g, (_, formula) =>
      hold(formulaHtml(formula, true)));
    source = source.replace(/\\\(([\s\S]+?)\\\)/g, (_, formula) =>
      hold(formulaHtml(formula, false)));
    source = source.replace(/(^|[^\\$])\$([^$\n]+?)\$/g, (_, prefix, formula) =>
      `${prefix}${hold(formulaHtml(formula, false))}`);
    source = source.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/gi, (_, label, url) =>
      hold(chatLinkHtml(label, url)));
    source = source.replace(/(^|[\s（(])((?:https?:\/\/)[^\s<>"'）)]+)/gi,
      (_, prefix, rawUrl) => {
        let url = rawUrl;
        let suffix = "";
        while (/[.,!?;:，。！？；：]$/.test(url)) {
          suffix = url.slice(-1) + suffix;
          url = url.slice(0, -1);
        }
        return `${prefix}${hold(chatLinkHtml(url, url))}${suffix}`;
      });
    let html = escapeHtml(source)
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\n/g, "<br>");
    for (const fragment of fragments) html = html.split(fragment.token).join(fragment.html);
    return html;
  }

  function codeBlockHtml(source, language = "") {
    const labels = {
      js: "JavaScript", javascript: "JavaScript", ts: "TypeScript", typescript: "TypeScript",
      jsx: "JSX", tsx: "TSX", html: "HTML", css: "CSS", json: "JSON", bash: "Bash",
      sh: "Shell", shell: "Shell", python: "Python", py: "Python", java: "Java",
      kotlin: "Kotlin", dart: "Dart", sql: "SQL", yaml: "YAML", yml: "YAML",
      markdown: "Markdown", md: "Markdown", text: "TEXT",
    };
    const rawLanguage = String(language || "").trim().split(/\s+/)[0].toLowerCase();
    const label = labels[rawLanguage] || (rawLanguage ? rawLanguage.toUpperCase() : "CODE");
    const code = String(source || "").replace(/^\n|\n$/g, "");
    return `<section class="chat-code-block">
      <header><span>${escapeHtml(label)}</span><button type="button" data-copy-code aria-label="复制代码">复制</button></header>
      <pre><code>${escapeHtml(code)}</code></pre>
    </section>`;
  }

  function markdownTableCells(line) {
    let source = String(line || "").trim();
    if (source.startsWith("|")) source = source.slice(1);
    if (source.endsWith("|") && !source.endsWith("\\|")) source = source.slice(0, -1);
    const cells = [];
    let cell = "";
    let inCode = false;
    for (let index = 0; index < source.length; index += 1) {
      const character = source[index];
      if (character === "\\" && source[index + 1] === "|") {
        cell += "|";
        index += 1;
      } else if (character === "`") {
        inCode = !inCode;
        cell += character;
      } else if (character === "|" && !inCode) {
        cells.push(cell.trim());
        cell = "";
      } else {
        cell += character;
      }
    }
    cells.push(cell.trim());
    return cells;
  }

  function markdownTableAlignment(delimiter) {
    const value = String(delimiter || "").replace(/\s/g, "");
    if (/^:-{3,}:$/.test(value)) return "center";
    if (/^-{3,}:$/.test(value)) return "right";
    return "left";
  }

  function isMarkdownTableDelimiter(line) {
    const cells = markdownTableCells(line);
    return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, "")));
  }

  function markdownTableHtml(headerLine, delimiterLine, bodyLines) {
    const headers = markdownTableCells(headerLine);
    const delimiters = markdownTableCells(delimiterLine);
    const alignments = headers.map((_, index) =>
      markdownTableAlignment(delimiters[index] || delimiters.at(-1)));
    const cellHtml = (tag, value, index) =>
      `<${tag} class="align-${alignments[index]}">${inlineRichHtml(value)}</${tag}>`;
    const head = headers.map((value, index) => cellHtml("th", value, index)).join("");
    const body = bodyLines.map((line) => {
      const cells = markdownTableCells(line);
      return `<tr>${headers.map((_, index) => cellHtml("td", cells[index] || "", index)).join("")}</tr>`;
    }).join("");
    return `<div class="chat-table-scroll" role="region" aria-label="表格，可横向滚动" tabindex="0">
      <table class="chat-table"><thead><tr>${head}</tr></thead>${body ? `<tbody>${body}</tbody>` : ""}</table>
    </div>`;
  }

  function richBlockHtml(value) {
    const lines = String(value || "").replace(/\r\n?/g, "\n").split("\n");
    const rendered = [];
    let plain = [];
    const flushPlain = () => {
      if (!plain.length) return;
      rendered.push(inlineRichHtml(plain.join("\n")));
      plain = [];
    };
    for (let index = 0; index < lines.length; index += 1) {
      const hasTableHeader = lines[index].includes("|") &&
        index + 1 < lines.length && isMarkdownTableDelimiter(lines[index + 1]);
      if (!hasTableHeader) {
        plain.push(lines[index]);
        continue;
      }
      flushPlain();
      const bodyLines = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
        bodyLines.push(lines[index]);
        index += 1;
      }
      rendered.push(markdownTableHtml(lines[index - bodyLines.length - 2],
        lines[index - bodyLines.length - 1], bodyLines));
      index -= 1;
    }
    flushPlain();
    return rendered.join("");
  }

  function textHtml(text) {
    const source = String(text || "");
    const pattern = /```([^`\n]*)\n?([\s\S]*?)```/g;
    const rendered = [];
    let cursor = 0;
    let match;
    while ((match = pattern.exec(source))) {
      if (match.index > cursor) rendered.push(richBlockHtml(source.slice(cursor, match.index)));
      rendered.push(codeBlockHtml(match[2], match[1]));
      cursor = pattern.lastIndex;
    }
    if (cursor < source.length) rendered.push(richBlockHtml(source.slice(cursor)));
    return rendered.join("");
  }

  function setConnected(connected, label) {
    $("#connectionLabel").textContent = label || (connected ? "服务器在线" : "等待网络");
    $(".identity-copy small").classList.toggle("offline", !connected);
  }

  const modelNames = {
    "gpt-5.6-sol": "Sol",
    "gpt-5.6-terra": "Terra",
    "gpt-5.6-luna": "Luna",
  };

  const reasoningMeta = {
    low: { label: "快速", code: "LOW", description: "轻量响应，适合明确、直接和低复杂度的任务。", intensity: 0 },
    medium: { label: "均衡", code: "MEDIUM", description: "适合大多数任务，在速度与分析深度之间取得平衡。", intensity: 1 },
    high: { label: "深入", code: "HIGH", description: "增加推理深度，适合多步骤分析、调试和复杂改动。", intensity: 2 },
    xhigh: { label: "极致", code: "EXTRA HIGH", description: "投入更多推理时间，处理高难度架构、审查与综合任务。", intensity: 3 },
    max: { label: "巅峰", code: "MAX", description: "接近模型的最大推理预算，适合非常复杂且高价值的任务。", intensity: 4 },
    ultra: { label: "超维", code: "ULTRA", description: "最高强度推理，优先追求完整性、深度与多路径验证。", intensity: 5 },
  };

  function selectedModelCapability() {
    const models = Array.isArray(state.capabilities?.models) ? state.capabilities.models : [];
    return models.find((model) => model.id === (state.draftModel || state.model)) || null;
  }

  function renderReasoningControl() {
    const selectedModel = selectedModelCapability();
    const offered = (selectedModel?.reasoningEfforts || [])
      .map((effort) => effort.id)
      .filter((effort) => reasoningMeta[effort]);
    const efforts = offered.length ? offered : ["low", "medium", "high", "xhigh"];
    let current = state.draftReasoning || state.reasoning;
    if (!efforts.includes(current)) {
      const preferred = selectedModel?.defaultReasoningEffort;
      current = efforts.includes(preferred) ? preferred : efforts.includes("medium") ? "medium" : efforts[0];
      state.draftReasoning = current;
    }
    const index = Math.max(0, efforts.indexOf(current));
    const meta = reasoningMeta[current] || reasoningMeta.medium;
    const control = $("#reasoningControl");
    if (!control) return;
    control.dataset.level = current;
    control.dataset.intensity = String(meta.intensity);
    control.style.setProperty("--reasoning-progress", `${((index + 0.5) / efforts.length) * 100}%`);
    control.style.setProperty("--reasoning-count", String(efforts.length));
    control.style.setProperty("--reasoning-intensity", String(meta.intensity));
    const segments = $("#reasoningSegments");
    if (segments) {
      segments.style.setProperty("--reasoning-count", String(efforts.length));
      segments.innerHTML = `
        <span class="reasoning-liquid-fill" aria-hidden="true"></span>
        <span class="reasoning-liquid-sheen" aria-hidden="true"></span>
        <i class="reasoning-liquid-orb" aria-hidden="true"></i>
        <div class="reasoning-liquid-hitbox" role="radiogroup" aria-label="在轨道上选择智能程度">
          ${efforts.map((effort) => {
            const option = reasoningMeta[effort];
            const selected = effort === current;
            return `<button type="button" data-reasoning="${escapeHtml(effort)}" role="radio" aria-checked="${selected}" aria-label="${escapeHtml(option.label)}，${escapeHtml(option.code)}"></button>`;
          }).join("")}
        </div>`;
    }
    $("#reasoningCurrentLabel").textContent = meta.label;
    $("#reasoningCurrentCode").textContent = meta.code;
    $("#reasoningDescription").textContent = meta.description;
    $("#reasoningSupportLabel").textContent = `${efforts.length} 档可用`;
    $("#reasoningStops").innerHTML = efforts.map((effort) => {
      const option = reasoningMeta[effort];
      const selected = effort === current;
      return `<button type="button" class="${selected ? "selected" : ""}" data-reasoning="${effort}" role="radio" aria-checked="${selected}" aria-label="${escapeHtml(option.label)}，${escapeHtml(option.code)}"><strong>${escapeHtml(option.label)}</strong><small>${escapeHtml(option.code)}</small></button>`;
    }).join("");
  }

  function renderCapabilities() {
    const capabilities = state.capabilities;
    const serverLive = $("#appServerLive");
    if (serverLive) {
      serverLive.classList.remove("offline");
      serverLive.innerHTML = "<i></i>ONLINE";
    }
    const actions = ["#forkConversationButton", "#compactConversationButton", "#reviewConversationButton"];
    actions.forEach((selector) => {
      const button = $(selector);
      if (button) button.disabled = !state.activeId || state.busy || !state.active?.hasCodexContext;
    });
    if (!capabilities) {
      renderReasoningControl();
      return;
    }
    const models = Array.isArray(capabilities.models) ? capabilities.models : [];
    if (models.length) {
      models.forEach((model) => {
        modelNames[model.id] = modelNames[model.id] || model.displayName || model.id;
      });
      $(".model-options").innerHTML = models.map((model) => {
        const name = model.displayName || model.id;
        const glyph = name.replace(/^GPT[- ]?/i, "").slice(0, 1).toUpperCase() || "✦";
        const efforts = (model.reasoningEfforts || []).map((effort) => effort.id).join(" · ");
        const selectedClass = model.id === (state.draftModel || state.model) ? "selected" : "";
        const selected = Boolean(selectedClass);
        return `<button type="button" class="${selectedClass}" data-model="${escapeHtml(model.id)}" role="radio" aria-checked="${selected}"><span class="model-glyph sol">${escapeHtml(glyph)}</span><span><strong>${escapeHtml(name)}</strong><small>${escapeHtml(efforts || "App Server")}</small></span><i></i></button>`;
      }).join("");
    }
    renderReasoningControl();
    const enabledSkills = (capabilities.skills || []).filter((skill) => skill.enabled).length;
    const connectedMcp = (capabilities.mcpServers || []).filter((server) =>
      !["failed", "error", "disabled"].includes(server.status)).length;
    const enabledFeatures = (capabilities.features || []).filter((feature) => feature.enabled).length;
    const featureNames = (capabilities.features || [])
      .filter((feature) => feature.enabled)
      .map((feature) => feature.displayName || feature.name)
      .filter(Boolean)
      .slice(0, 3)
      .map((name) => String(name).replaceAll("_", " "));
    $("#appServerStatus").innerHTML = `
      <div class="app-server-metrics">
        <div><strong>${models.length}</strong><small>动态模型</small></div>
        <div><strong>${enabledSkills}</strong><small>Skills</small></div>
        <div><strong>${connectedMcp}</strong><small>MCP 在线</small></div>
        <div><strong>${enabledFeatures}</strong><small>运行特性</small></div>
      </div>
      <div class="app-server-sync">
        <span><i></i>能力已实时同步</span>
        <small>${escapeHtml(featureNames.join(" · ") || "Codex runtime ready")}</small>
      </div>`;
  }
  const reasoningNames = Object.fromEntries(Object.entries(reasoningMeta).map(([id, meta]) => [id, meta.label]));
  const accessNames = {
    "danger-full-access": "完全访问",
    "workspace-write": "项目读写",
    "read-only": "只读",
  };
  const projects = {
    "": "空白",
    "/home/ubuntu/Documents/Codex/2026-07-20-skill/upload-app": "维特",
    "/home/ubuntu/Documents/Codex/2026-07-26-xlsb": "年报",
    "/data/xuanyu-build-console/repo": "玄遇",
  };

  function projectName(workDir) {
    return projects[String(workDir || "")] || "自定义项目";
  }

  function formatTokens(value) {
    const tokens = Math.max(0, Number(value || 0));
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 10_000_000 ? 0 : 1)}M`;
    if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 100_000 ? 0 : 1)}K`;
    return Math.round(tokens).toLocaleString("zh-CN");
  }

  function quotaPercent(used, total) {
    if (used === null || used === undefined || !Number.isFinite(Number(used)) || !Number(total) || Number(total) <= 0) return null;
    return Math.max(0, Math.min(100, Math.round((1 - Number(used) / Number(total)) * 100)));
  }

  function updateQuotaStatus() {
    const button = $("#quotaButton");
    const primary = state.usage?.rateLimits?.primary || null;
    const context = state.active?.contextUsage || state.usage?.context || null;
    const weekly = primary ? Math.max(0, Math.min(100, Math.round(100 - Number(primary.usedPercent || 0)))) : null;
    const contextRemaining = context ? quotaPercent(context.usedTokens, context.contextWindow) : null;
    if (weekly === null && contextRemaining === null) {
      button.hidden = true;
      return;
    }
    button.hidden = false;
    $("#weeklyQuotaLabel").textContent = weekly === null ? "—" : `${weekly}%`;
    $("#contextQuotaLabel").textContent = contextRemaining === null ? "—" : `${contextRemaining}%`;
    $("#weeklyQuotaMeter").style.width = `${weekly === null ? 0 : weekly}%`;
    $("#contextQuotaMeter").style.width = `${contextRemaining === null ? 0 : contextRemaining}%`;
    button.setAttribute("aria-label", `查看 Codex 额度：每周剩余 ${weekly === null ? "暂不可用" : `${weekly}%`}，上下文剩余 ${contextRemaining === null ? "暂不可用" : `${contextRemaining}%`}`);
  }

  function refreshUsage() {
    if (state.usageLoading || typeof bridge()?.requestUsage !== "function") return;
    state.usageLoading = true;
    bridge().requestUsage(state.activeId || "");
  }

  function dismissBoot() {
    const boot = $("#bootScreen");
    if (!boot || boot.classList.contains("leaving")) return;
    bridge()?.contentReady?.(document.documentElement.dataset.themeMode || "light");
    boot.classList.add("leaving");
    setTimeout(() => boot.remove(), 520);
  }

  function applyPrincipalPolicy(principal = {}) {
    const profiles = principal.admin
      ? ["default", "xuanyu"]
      : Array.isArray(principal.codexProfiles) && principal.codexProfiles.length
        ? principal.codexProfiles.filter((profile) =>
          profile === "default" || profile === "xuanyu")
        : ["default"];
    state.allowedCodexProfiles = profiles.length ? profiles : ["default"];
    if (!state.allowedCodexProfiles.includes(state.codexProfile)) {
      state.codexProfile = state.allowedCodexProfiles[0];
      localStorage.setItem("wit_codex_profile", state.codexProfile);
    }
    const xuanyuOnly = state.allowedCodexProfiles.length === 1 &&
      state.allowedCodexProfiles[0] === "xuanyu";
    const title = $("#drawerNewChat strong");
    const subtitle = $("#drawerNewChat small");
    if (title) title.textContent = xuanyuOnly ? "新建玄遇对话" : "新建对话";
    if (subtitle) subtitle.textContent =
      xuanyuOnly ? "使用玄遇专用 Codex 账号" : "开启一个独立上下文";
  }

  function updateModelControls() {
    $("#modelLabel").textContent = modelNames[state.model] || "Sol";
    $("#reasoningLabel").textContent = reasoningNames[state.reasoning] || "均衡";
    $("#accessLabel").textContent = accessNames[state.accessMode] || "完全访问";
    $("#projectLabel").textContent = projectName(state.workDir);
    document.querySelectorAll("[data-model]").forEach((button) =>
      button.classList.toggle("selected", button.dataset.model === state.draftModel));
    document.querySelectorAll("[data-access]").forEach((button) =>
      button.classList.toggle("selected", button.dataset.access === state.draftAccessMode));
    renderCapabilities();
  }

  function openProject() {
    if (!state.activeId) {
      toast("请稍候，正在创建新对话");
      return;
    }
    if (state.busy) {
      toast("当前任务完成后再切换项目");
      return;
    }
    document.querySelectorAll("[data-project-path]").forEach((button) =>
      button.classList.toggle("selected", button.dataset.projectPath === (state.workDir || "")));
    $("#projectSheet").classList.add("open");
    $("#projectSheet").setAttribute("aria-hidden", "false");
  }

  function closeProject() {
    $("#projectSheet").classList.remove("open");
    $("#projectSheet").setAttribute("aria-hidden", "true");
  }

  function renderUsage() {
    const payload = state.usage;
    if (!payload) {
      $("#usageContent").innerHTML = `<div class="usage-loading"><i></i><span>正在读取 Token 用量</span></div>`;
      return;
    }
    const summary = payload.summary || {};
    const rate = payload.rateLimits || {};
    const primary = rate.primary || null;
    const resetCredits = Math.max(0, Number(rate.resetCredits || 0));
    const weeklyRemaining = primary ? Math.max(0, Math.min(100, Math.round(100 - Number(primary.usedPercent || 0)))) : null;
    const resetAt = primary?.resetsAt ? new Date(primary.resetsAt * 1000).toLocaleString("zh-CN", {
      month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "暂未提供";
    const weeklySummary = primary ? `<section class="weekly-quota-summary"><div><small>本周额度</small><strong>剩余 ${weeklyRemaining}%</strong></div><span>${resetAt} 重置</span><i><b style="width:${weeklyRemaining}%"></b></i></section>` : "";
    const actionCard = `
      <section class="quota-actions quota-compact">
        ${weeklySummary}
        <div class="quota-action-row">
          <div><b>重置本周额度</b><small>${resetCredits ? `可用 ${resetCredits} 次 · 使用前会确认` : "当前没有可用的重置额度"}</small></div>
          ${resetCredits ? `<button class="quota-reset glow-reset" data-reset-rate-limit><i></i><span>确认重置</span><em>✦</em></button>` : `<button class="quota-reset" disabled>暂无额度</button>`}
        </div>
      </section>`;
    const buckets = new Map((payload.dailyUsageBuckets || [])
      .map((bucket) => [bucket.startDate, Math.max(0, Number(bucket.tokens || 0))]));
    const peak = Math.max(1, ...buckets.values());
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const mondayOffset = (today.getDay() + 6) % 7;
    const currentMonday = new Date(today);
    currentMonday.setDate(today.getDate() - mondayOffset);
    let recentTokens = 0;
    let recentActiveDays = 0;
    for (let offset = 0; offset < 7; offset += 1) {
      const date = new Date(today);
      date.setDate(today.getDate() - offset);
      const key = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
      const tokens = buckets.get(key) || 0;
      recentTokens += tokens;
      if (tokens > 0) recentActiveDays += 1;
    }
    const recentActivity = Math.round(recentActiveDays / 7 * 100);
    const start = new Date(currentMonday);
    start.setDate(currentMonday.getDate() - (15 * 7));
    const weeks = [];
    for (let week = 0; week < 16; week += 1) {
      const days = [];
      for (let day = 0; day < 7; day += 1) {
        const date = new Date(start);
        date.setDate(start.getDate() + week * 7 + day);
        const key = [
          date.getFullYear(),
          String(date.getMonth() + 1).padStart(2, "0"),
          String(date.getDate()).padStart(2, "0"),
        ].join("-");
        const tokens = buckets.get(key) || 0;
        const level = tokens ? Math.max(1, Math.min(4, Math.ceil(tokens / peak * 4))) : 0;
        const future = date > today;
        days.push(`<button class="usage-day level-${future ? 0 : level}" data-usage-date="${key}" data-usage-tokens="${tokens}" ${future ? "disabled" : ""} aria-label="${key} ${tokens} tokens"></button>`);
      }
      weeks.push(`<span class="usage-week">${days.join("")}</span>`);
    }
    $("#usageContent").innerHTML = `
      <section class="usage-stats">
        <article class="usage-stat lifetime"><i>Σ</i><small>累计 Token</small><strong>${formatTokens(summary.lifetimeTokens)}</strong></article>
        <article class="usage-stat streak"><i>↗</i><small>连续使用</small><strong>${Number(summary.currentStreakDays || 0)}<em> 天</em></strong></article>
        <article class="usage-stat peak"><i>◆</i><small>单日峰值</small><strong>${formatTokens(summary.peakDailyTokens)}</strong></article>
      </section>
      ${actionCard}
      <section class="usage-card">
        <header><div><strong>每日使用</strong><small>最近 16 周</small></div><span>${Number(summary.longestStreakDays || 0)} 天最长连续</span></header>
        <div class="usage-board">
          <div class="usage-weekdays"><span>一</span><span>三</span><span>五</span><span>日</span></div>
          <div class="usage-grid">${weeks.join("")}</div>
          <aside class="usage-insight"><i style="--activity:${recentActivity}%"><b>${recentActiveDays}<small>/7</small></b></i><span><small>近 7 天</small><strong>${formatTokens(recentTokens)}</strong><em>${recentActiveDays ? `${recentActiveDays} 天有记录` : "等待首次使用"}</em></span></aside>
        </div>
        <footer><span>每天完成一点，就会在这里留下颜色</span><div>少<i class="level-0"></i><i class="level-1"></i><i class="level-2"></i><i class="level-3"></i><i class="level-4"></i>多</div></footer>
      </section>`;
  }

  function openProfile() {
    closeDrawer();
    $("#profileSheet").classList.add("open");
    $("#profileSheet").setAttribute("aria-hidden", "false");
    renderUsage();
    refreshUsage();
  }

  function renderAdminDevices(devices = []) {
    $("#deviceList").innerHTML = devices.length ? devices.map((device) => `
      <article class="device-row"><span>⌁</span><div><strong>${escapeHtml(device.label || "未命名设备")}</strong><small>${device.disabled ? "已停止访问" : `最近活跃：${formatDate(device.lastSeenAt || device.createdAt)}`}</small></div>${device.disabled ? "" : `<button data-disable-device="${escapeHtml(device.id)}">停止</button>`}</article>`).join("")
      : `<small>还没有已激活的设备。</small>`;
  }

  function closeProfile() {
    $("#profileSheet").classList.remove("open");
    $("#profileSheet").setAttribute("aria-hidden", "true");
  }

  function openAdminSettings() {
    if (!state.admin) return;
    closeDrawer();
    $("#adminSettingsSheet").classList.add("open");
    $("#adminSettingsSheet").setAttribute("aria-hidden", "false");
    bridge()?.requestAdminDevices?.();
  }

  function closeAdminSettings() {
    $("#adminSettingsSheet").classList.remove("open");
    $("#adminSettingsSheet").setAttribute("aria-hidden", "true");
  }

  function renderCodexAccounts(accounts = []) {
    state.codexAccounts = accounts;
    $("#codexAccountList").innerHTML = accounts.map((account) => {
      const signedIn = Boolean(account.authenticated);
      const detail = signedIn
        ? `${account.account?.email || "已登录"}${account.account?.planType ? ` · ${account.account.planType}` : ""}`
        : "尚未登录";
      const action = signedIn
        ? `<div class="codex-account-actions">${account.id === "xuanyu"
          ? `<button class="relogin" data-login-codex="xuanyu">重新登录</button>` : ""}
          <button class="new-chat" data-new-codex-chat="${escapeHtml(account.id)}">新建对话</button></div>`
        : account.id === "xuanyu"
          ? `<div class="codex-account-actions"><button class="login" data-login-codex="xuanyu">登录账号</button></div>`
          : "";
      return `<article class="codex-account-card ${account.id === "xuanyu" ? "xuanyu" : ""}">
        <span class="codex-account-avatar">${account.id === "xuanyu" ? "玄" : "W"}</span>
        <div class="codex-account-identity"><strong>${escapeHtml(account.label || account.id)}</strong><small>${escapeHtml(detail)}</small></div>
        ${action}
      </article>`;
    }).join("") || `<article class="codex-account-card"><span class="codex-account-avatar">!</span><div class="codex-account-identity"><strong>暂无账号信息</strong><small>请稍后重试</small></div></article>`;
  }

  function openCodexAccounts() {
    if (!state.admin) return;
    closeDrawer();
    $("#codexAccountSheet").classList.add("open");
    $("#codexAccountSheet").setAttribute("aria-hidden", "false");
    bridge()?.requestCodexAccounts?.();
  }

  function stopCodexLoginPolling() {
    if (state.codexLoginTimer) clearInterval(state.codexLoginTimer);
    state.codexLoginTimer = null;
  }

  function closeCodexAccounts() {
    $("#codexAccountSheet").classList.remove("open");
    $("#codexAccountSheet").setAttribute("aria-hidden", "true");
  }

  function pollCodexLogin() {
    bridge()?.requestXuanyuCodexLoginStatus?.();
  }

  function startCodexLoginPolling() {
    stopCodexLoginPolling();
    state.codexLoginTimer = setInterval(pollCodexLogin, 2200);
  }

  function openQuotaResetConfirm() {
    $("#quotaConfirm").classList.add("open");
    $("#quotaConfirm").setAttribute("aria-hidden", "false");
  }

  function closeQuotaResetConfirm() {
    $("#quotaConfirm").classList.remove("open");
    $("#quotaConfirm").setAttribute("aria-hidden", "true");
  }

  function consumeQuotaReset() {
    closeQuotaResetConfirm();
    if (typeof bridge()?.consumeRateLimitReset !== "function") {
      toast("请先更新 Witt 后再使用重置额度");
      bridge()?.checkForUpdates?.();
      return;
    }
    bridge().consumeRateLimitReset();
  }

  function openSettings() {
    if (state.busy) {
      toast("当前任务完成后再切换设置");
      return;
    }
    state.draftModel = state.model;
    state.draftReasoning = state.reasoning;
    state.draftAccessMode = state.accessMode;
    updateModelControls();
    $("#settingsSheet").classList.add("open");
    $("#settingsSheet").setAttribute("aria-hidden", "false");
  }

  function closeSettings() {
    $("#settingsSheet").classList.remove("open");
    $("#settingsSheet").setAttribute("aria-hidden", "true");
  }

  function openDrawer() {
    $("#drawer").classList.add("open");
    $("#drawer").setAttribute("aria-hidden", "false");
  }

  function closeDrawer() {
    $("#drawer").classList.remove("open");
    $("#drawer").setAttribute("aria-hidden", "true");
  }

  function allArtifacts() {
    return (state.active?.messages || []).flatMap((message) =>
      (message.artifacts || []).map((artifact) => ({ ...artifact, messageId: message.id })));
  }

  function renderDeliveries() {
    const artifacts = allArtifacts();
    $("#deliveryBadge").textContent = artifacts.length;
    $("#deliveryButton").classList.toggle("has-files", artifacts.length > 0);
    $("#deliveryBadge").hidden = !artifacts.length;
    $("#deliveryList").innerHTML = artifacts.length
      ? artifacts.slice().reverse().map((artifact) => `
        <button class="delivery-file" data-artifact="${artifact.id}" data-message="${artifact.messageId}">
          <span class="delivery-type">${extension(artifact.name)}</span>
          <span><strong>${escapeHtml(artifact.name)}</strong><small>${formatBytes(artifact.size)} · 点击下载到手机</small></span>
          <svg viewBox="0 0 24 24"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14"/></svg>
        </button>`).join("")
      : `<div class="delivery-empty"><span>↓</span><strong>暂无交付文件</strong><p>需要文件时直接告诉我“把它放到交付区”。</p></div>`;
  }

  function openDelivery() {
    renderDeliveries();
    $("#deliverySheet").classList.add("open");
    $("#deliverySheet").setAttribute("aria-hidden", "false");
  }

  function closeDelivery() {
    $("#deliverySheet").classList.remove("open");
    $("#deliverySheet").setAttribute("aria-hidden", "true");
  }

  function openActionDetail(messageId, entryId, label) {
    state.detailRequest = { messageId, entryId };
    $("#actionDetailTitle").textContent = label || "执行详情";
    $("#actionDetailContent").innerHTML = `<div class="detail-loading"><i></i><span>正在读取详情</span></div>`;
    $("#actionDetailSheet").classList.add("open");
    $("#actionDetailSheet").setAttribute("aria-hidden", "false");
    if (typeof bridge()?.requestStreamDetail !== "function") {
      $("#actionDetailContent").innerHTML = `<div class="detail-error">请先更新到新版 App，再查看执行详情。</div>`;
      bridge()?.checkForUpdates?.();
      return;
    }
    bridge().requestStreamDetail(state.activeId, messageId, entryId);
  }

  function closeActionDetail() {
    state.detailRequest = null;
    $("#actionDetailSheet").classList.remove("open");
    $("#actionDetailSheet").setAttribute("aria-hidden", "true");
  }

  function openImageViewer(url, name, mimeType = "") {
    if (!url) return;
    $("#imageViewerImage").src = url;
    $("#imageViewerImage").alt = name || "Witt 图片";
    $("#imageViewerName").textContent = name || "Witt 图片";
    $("#downloadImageViewer").dataset.url = url;
    $("#downloadImageViewer").dataset.name = name || "Witt 图片";
    $("#downloadImageViewer").dataset.mimeType = mimeType;
    $("#imageViewer").classList.add("open");
    $("#imageViewer").setAttribute("aria-hidden", "false");
  }

  function closeImageViewer() {
    $("#imageViewer").classList.remove("open");
    $("#imageViewer").setAttribute("aria-hidden", "true");
    $("#imageViewerImage").removeAttribute("src");
    delete $("#downloadImageViewer").dataset.url;
  }

  function detailBlock(title, value, className = "") {
    if (value === null || value === undefined || value === "") return "";
    return `<section class="detail-block ${className}"><h3>${escapeHtml(title)}</h3><pre>${escapeHtml(value)}</pre></section>`;
  }

  function renderActionDetail(entry) {
    const details = entry.details || {};
    if (entry.kind === "command") {
      const status = entry.status === "completed" ? "已完成"
        : entry.status === "failed" ? "失败" : "执行中";
      const meta = [
        status,
        Number.isInteger(details.exitCode) ? `退出码 ${details.exitCode}` : "",
        Number.isInteger(details.durationMs) ? `${(details.durationMs / 1000).toFixed(2)} 秒` : "",
      ].filter(Boolean).join(" · ");
      $("#actionDetailTitle").textContent = "命令执行详情";
      $("#actionDetailContent").innerHTML = `
        <div class="detail-summary"><span>⌘</span><div><strong>${escapeHtml(meta)}</strong><small>${escapeHtml(details.cwd || "未提供工作目录")}</small></div></div>
        ${detailBlock("完整命令", details.command, "command")}
        ${detailBlock("执行输出", details.output || "该命令没有输出", "output")}`;
      return;
    }
    const kindNames = { add: "新增", update: "修改", delete: "删除" };
    $("#actionDetailTitle").textContent = "文件修改详情";
    const changes = Array.isArray(details.changes) ? details.changes : [];
    $("#actionDetailContent").innerHTML = changes.length
      ? changes.map((change) => `
        <article class="file-change-detail">
          <header><span class="${escapeHtml(change.kind)}">${escapeHtml(kindNames[change.kind] || "修改")}</span><strong>${escapeHtml(change.path)}</strong></header>
          ${change.movePath ? `<p>移动到：${escapeHtml(change.movePath)}</p>` : ""}
          ${change.diff ? `<pre>${escapeHtml(change.diff)}</pre>` : `<p>没有可显示的差异内容</p>`}
        </article>`).join("")
      : `<div class="detail-error">暂时没有可显示的文件差异。</div>`;
  }

  function renderConversations() {
    $("#conversationList").innerHTML = state.conversations.length
      ? state.conversations.map((conversation) => `
        <article class="conversation-row ${conversation.id === state.activeId ? "active" : ""}" data-id="${conversation.id}">
          <button class="conversation-open" data-open="${conversation.id}">
            <span class="conversation-mark">${conversation.busy ? '<i></i>' : '<svg viewBox="0 0 24 24"><path d="M5 6h14v10H9l-4 4V6Z"/></svg>'}</span>
            <span><strong>${escapeHtml(conversation.title)}</strong><small>${conversation.busy ? "正在处理" : formatDate(conversation.updatedAt)} · ${escapeHtml(conversation.lastMessage || "暂无消息")}</small></span>
          </button>
          <button class="conversation-more" data-archive="${conversation.id}" aria-label="移除对话">•••</button>
        </article>`).join("")
      : `<div class="drawer-empty">还没有历史对话</div>`;
  }

  function attachmentHtml(file) {
    return `<span class="message-file"><b>${extension(file.name)}</b><span><strong>${escapeHtml(file.name)}</strong><small>${formatBytes(file.size)}</small></span></span>`;
  }

  function imageUrl(image) {
    const id = String(image?.id || "");
    if (!/^[a-f0-9-]{36}$/.test(id)) return "";
    return new URL(`/vault-api/chat-images/${encodeURIComponent(id)}`, window.location.origin).toString();
  }

  function showActivation(message = "") {
    dismissBoot();
    const gate = $("#authGate");
    gate.classList.add("open");
    gate.setAttribute("aria-hidden", "false");
    if (message) $("#authGateHint").textContent = message;
    $("#messageInput").disabled = true;
    $("#attachButton").disabled = true;
    $("#sendButton").disabled = true;
  }

  function hideActivation() {
    const gate = $("#authGate");
    gate.classList.remove("open");
    gate.setAttribute("aria-hidden", "true");
    $("#messageInput").disabled = false;
    $("#attachButton").disabled = false;
    $("#sendButton").disabled = false;
  }

  function claimThisDevice() {
    if (state.bootstrapClaiming) return;
    state.bootstrapClaiming = true;
    showActivation("请输入管理员邀请码以激活此设备。");
    state.bootstrapClaiming = false;
  }

  function respondToApproval(approvalId, choiceId) {
    if (!state.activeId || !approvalId) return;
    const card = document.querySelector(`[data-approval-card="${CSS.escape(approvalId)}"]`);
    const buttons = card?.querySelectorAll("button") || [];
    buttons.forEach((button) => { button.disabled = true; });
    card?.querySelectorAll("input, select, textarea").forEach((field) => { field.disabled = true; });
    card?.classList.add("submitting");
    bridge()?.resolveApproval?.(state.activeId, approvalId, choiceId);
  }

  function inlineImageHtml(image, className = "") {
    const url = imageUrl(image);
    if (!url) return "";
    const name = String(image.name || "Witt 图片");
    return `<button type="button" class="inline-image ${className}" data-inline-image="${escapeHtml(url)}" data-image-name="${escapeHtml(name)}" data-image-mime="${escapeHtml(image.mimeType || "")}">
      <img src="${escapeHtml(url)}" alt="${escapeHtml(name)}" loading="lazy" decoding="async">
      <span><b>${escapeHtml(name)}</b><small>${formatBytes(image.size)}</small></span>
    </button>`;
  }

  function activityHtml(message) {
    const activities = message.activity || [];
    if (!activities.length) return "";
    const latest = activities.at(-1);
    const icon = latest.type === "command" ? "⌘" : latest.type === "file" ? "◇" : latest.type === "web" ? "◎" : "✦";
    return `<details class="activity" ${message.status === "running" ? "open" : ""}>
      <summary><span class="${message.status}">${icon}</span><b>${escapeHtml(latest.label)}</b><i></i></summary>
      <div>${activities.map((item) => `<p><span class="${item.status}"></span>${escapeHtml(item.label)}</p>`).join("")}</div>
    </details>`;
  }

  function streamActionHtml(message, entry) {
    const icon = entry.kind === "command" ? "⌘"
      : entry.kind === "file" ? "◇"
      : entry.kind === "web" ? "◎" : "✦";
    const detailAttributes = entry.hasDetails
      ? `data-stream-detail="${escapeHtml(entry.id)}" data-message-id="${escapeHtml(message.sourceMessageId || message.id)}"`
      : "";
    const tag = entry.hasDetails ? "button" : "div";
    return `<${tag} ${entry.hasDetails ? 'type="button"' : ""} class="stream-action ${entry.kind || "tool"} ${entry.status || ""} ${entry.hasDetails ? "clickable" : ""}" ${detailAttributes}>
      <span>${icon}</span><p>${escapeHtml(entry.label || "正在处理")}</p>
      <div class="stream-tail"><i></i>${entry.hasDetails ? `<svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6"/></svg>` : ""}</div>
    </${tag}>`;
  }

  function approvalQuestionFormHtml(entry) {
    const questions = Array.isArray(entry.approvalQuestions) ? entry.approvalQuestions : [];
    const fields = questions.map((question, questionIndex) => {
      const options = Array.isArray(question.options) ? question.options : [];
      const input = options.length ? `<div class="approval-choice-grid">${options.map((option, index) => `
        <label><input type="radio" name="approval-question-${questionIndex}" value="${escapeHtml(option.label)}" ${index === 0 ? "required" : ""}>
          <span><b>${escapeHtml(option.label)}</b><small>${escapeHtml(option.description || "")}</small></span></label>`).join("")}
        ${question.isOther ? `<label><input type="radio" name="approval-question-${questionIndex}" value="__other__"><span><b>其他</b><small>输入自定义回答</small></span></label>
          <input class="approval-other-input" type="text" maxlength="2000" placeholder="输入回答">` : ""}</div>`
        : `<input class="approval-text-input" type="${question.isSecret ? "password" : "text"}" maxlength="2000" required autocomplete="off" placeholder="输入回答">`;
      return `<fieldset class="approval-question" data-question-id="${escapeHtml(question.id)}">
        <legend>${escapeHtml(question.header || `问题 ${questionIndex + 1}`)}</legend>
        <p>${escapeHtml(question.question || "请选择如何继续")}</p>${input}</fieldset>`;
    }).join("");
    return `<form class="approval-structured-form" data-approval-input-form data-approval-id="${escapeHtml(entry.approvalId)}">
      ${fields}<div class="approval-form-actions"><button type="submit">提交选择</button></div></form>`;
  }

  function approvalSchemaFieldHtml(key, schema, required) {
    const label = schema?.title || key;
    const description = schema?.description || "";
    const enumValues = Array.isArray(schema?.enum) ? schema.enum :
      Array.isArray(schema?.oneOf) ? schema.oneOf.map((item) => item?.const) : [];
    const enumLabels = Array.isArray(schema?.oneOf) ? schema.oneOf.map((item) => item?.title) : enumValues;
    let control;
    if (schema?.type === "boolean") {
      control = `<label class="approval-switch"><input type="checkbox" ${schema.default ? "checked" : ""}><span>确认</span></label>`;
    } else if (enumValues.length) {
      control = `<select ${required ? "required" : ""}>${!required ? "<option value=\"\">请选择</option>" : ""}${enumValues.map((value, index) =>
        `<option value="${escapeHtml(value)}">${escapeHtml(enumLabels[index] || value)}</option>`).join("")}</select>`;
    } else {
      const type = ["number", "integer"].includes(schema?.type) ? "number" :
        schema?.format === "email" ? "email" : schema?.format === "uri" ? "url" :
        schema?.format === "date" ? "date" : schema?.format === "date-time" ? "datetime-local" : "text";
      control = `<input type="${type}" ${required ? "required" : ""} maxlength="2000" value="${escapeHtml(schema?.default ?? "")}">`;
    }
    return `<label class="approval-schema-field" data-field-key="${escapeHtml(key)}" data-value-type="${escapeHtml(schema?.type || "string")}">
      <span><b>${escapeHtml(label)}</b>${description ? `<small>${escapeHtml(description)}</small>` : ""}</span>${control}</label>`;
  }

  function approvalSchemaFormHtml(entry) {
    const schema = entry.approvalForm && typeof entry.approvalForm === "object" ? entry.approvalForm : {};
    const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const fields = Object.entries(properties).slice(0, 24)
      .map(([key, value]) => approvalSchemaFieldHtml(key, value, required.has(key))).join("");
    return `<form class="approval-structured-form" data-approval-mcp-form data-approval-id="${escapeHtml(entry.approvalId)}">
      ${fields || "<p>此连接器未提供可填写字段。</p>"}
      <div class="approval-form-actions"><button type="submit">确认并继续</button>
        <button type="button" class="secondary" data-approval-payload="decline" data-approval-id="${escapeHtml(entry.approvalId)}">拒绝</button></div></form>`;
  }

  function approvalHtml(entry) {
    const statusLabels = {
      accepted: "已允许本次操作",
      declined: "已拒绝",
      expired: "请求已失效",
    };
    const pending = entry.status === "pending";
    const typeLabels = {
      command: "COMMAND",
      file: "FILE CHANGE",
      network: "NETWORK",
      permissions: "PERMISSION",
      connector: "APP CONNECTOR",
      mcp: "MCP ELICITATION",
    };
    const evidence = [
      entry.host ? `<div><span>目标</span><code>${escapeHtml(`${entry.protocol || "https"}://${entry.host}`)}</code></div>` : "",
      entry.command ? `<div><span>命令</span><code>${escapeHtml(entry.command)}</code></div>` : "",
      entry.permissionSummary ? `<div><span>范围</span><code>${escapeHtml(entry.permissionSummary)}</code></div>` : "",
      entry.grantRoot ? `<div><span>目录</span><code>${escapeHtml(entry.grantRoot)}</code></div>` : "",
      entry.cwd ? `<div><span>位置</span><code>${escapeHtml(entry.cwd)}</code></div>` : "",
      entry.approvalUrl ? `<div><span>授权页</span><code>${escapeHtml(entry.approvalUrl)}</code></div>` : "",
    ].filter(Boolean).join("");
    const fallbackOptions = [
      { id: "accept", label: "允许一次", description: "仅批准当前这项操作", tone: "accepted" },
      { id: "decline", label: "拒绝并继续", description: "不执行操作，让 Codex 尝试其他做法", tone: "declined" },
    ];
    const options = Array.isArray(entry.approvalOptions) && entry.approvalOptions.length
      ? entry.approvalOptions : fallbackOptions;
    const optionHtml = options.map((option, index) => `
      <button type="button" class="approval-option ${option.tone || ""}"
        data-approval-choice="${escapeHtml(option.id)}"
        data-approval-id="${escapeHtml(entry.approvalId)}">
        <span>${index + 1}</span>
        <div><strong>${escapeHtml(option.label)}</strong><small>${escapeHtml(option.description)}</small></div>
        <i>›</i>
      </button>`).join("");
    const structuredHtml = !entry.approvalOptions?.length && entry.approvalQuestions?.length
      ? approvalQuestionFormHtml(entry)
      : !entry.approvalOptions?.length && entry.approvalForm
        ? approvalSchemaFormHtml(entry) : `<div class="approval-options">${optionHtml}</div>`;
    const resolvedLabel = entry.resolutionLabel || statusLabels[entry.status] || "已处理";
    return `<section class="approval-card ${entry.status || "pending"}" data-approval-card="${escapeHtml(entry.approvalId)}">
      <header>
        <span class="approval-shield" aria-hidden="true"><i></i></span>
        <div><small>${escapeHtml(typeLabels[entry.approvalType] || "APPROVAL")}</small><strong>${escapeHtml(entry.title || "允许这项操作？")}</strong></div>
        <b>${pending ? "请选择" : escapeHtml(statusLabels[entry.status] || "已处理")}</b>
      </header>
      ${entry.reason ? `<p>${escapeHtml(entry.reason)}</p>` : ""}
      ${evidence ? `<div class="approval-evidence">${evidence}</div>` : ""}
      ${pending ? `${structuredHtml}
        <footer class="approval-note"><span>只会提交你选择的这一项</span><b>CODEX APPROVAL</b></footer>`
        : `<footer class="approval-resolution"><i></i><span>${escapeHtml(resolvedLabel)}</span></footer>`}
    </section>`;
  }

  function streamGroupLabel(entries) {
    const commands = entries.filter((entry) => entry.kind === "command").length;
    const files = entries
      .filter((entry) => entry.kind === "file")
      .reduce((total, entry) => total + Math.max(1, Number(entry.count) || 1), 0);
    const tools = entries.filter((entry) => !["command", "file", "web"].includes(entry.kind)).length;
    const web = entries.filter((entry) => entry.kind === "web").length;
    const parts = [];
    if (commands) parts.push(`执行 ${commands} 条命令`);
    if (files) parts.push(`修改 ${files} 个文件`);
    if (web) parts.push(`查询 ${web} 次`);
    if (tools) parts.push(`调用 ${tools} 个工具`);
    return parts.join(" · ") || `处理 ${entries.length} 项操作`;
  }

  function streamHtml(message, streamOverride) {
    const hasOverride = Array.isArray(streamOverride);
    const stream = hasOverride ? streamOverride
      : Array.isArray(message.stream) ? message.stream : [];
    if (!stream.length) {
      if (hasOverride) return "";
      const typing = !message.text &&
        (message.status === "queued" || message.status === "running");
      return `${typing
        ? `<div class="typing"><i></i><i></i><i></i></div>`
        : `<div class="assistant-text">${textHtml(message.text)}</div>`}
        ${activityHtml(message)}`;
    }
    const rendered = [];
    let actionBuffer = [];
    const flushActions = () => {
      if (!actionBuffer.length) return;
      if (actionBuffer.length === 1) {
        rendered.push(streamActionHtml(message, actionBuffer[0]));
      } else {
        const running = actionBuffer.some((entry) => entry.status === "running");
        const failed = actionBuffer.filter((entry) => entry.status === "failed").length;
        const groupStatus = running ? "running" : failed ? "failed" : "completed";
        const statusText = running ? "正在执行" : failed ? `${failed} 项未完成` : "执行完成";
        rendered.push(`<details class="stream-action-group ${groupStatus}" ${message.status === "running" ? "open" : ""}>
          <summary>
            <span class="stream-group-icon">⌘</span>
            <span class="stream-group-copy"><strong>${escapeHtml(streamGroupLabel(actionBuffer))}</strong><small>${statusText} · 点击${message.status === "running" ? "收起" : "展开"}详情</small></span>
            <span class="stream-group-tail"><i></i><svg viewBox="0 0 24 24"><path d="m7 10 5 5 5-5"/></svg></span>
          </summary>
          <div class="stream-action-list">${actionBuffer.map((entry) => streamActionHtml(message, entry)).join("")}</div>
        </details>`);
      }
      actionBuffer = [];
    };
    stream.forEach((entry) => {
      if (entry.kind === "message") {
        flushActions();
        if (!entry.text) return;
        const phase = entry.phase === "final_answer" ? "final" : "commentary";
        rendered.push(`<div class="stream-message ${phase} ${entry.status || ""}">${textHtml(entry.text)}</div>`);
        return;
      }
      if (entry.kind === "image") {
        flushActions();
        const image = (message.images || []).find((candidate) => candidate.id === entry.imageId);
        if (image) rendered.push(inlineImageHtml(image, "execution-image"));
        return;
      }
      if (entry.kind === "approval") {
        flushActions();
        rendered.push(approvalHtml(entry));
        return;
      }
      actionBuffer.push(entry);
    });
    flushActions();
    const entries = rendered.join("");
    const showTyping = message.status === "running" &&
      !stream.some((entry) => entry.kind === "message" && entry.status === "running");
    return `${entries}${showTyping ? `<div class="typing"><i></i><i></i><i></i></div>` : ""}`;
  }

  function completedMessageHtml(message) {
    const stream = Array.isArray(message.stream) ? message.stream : [];
    const finalEntries = stream.filter((entry) =>
      entry.kind === "message" && entry.phase === "final_answer" && String(entry.text || "").trim());
    const finalEntry = finalEntries.at(-1);
    const processEntries = stream.filter((entry) => entry !== finalEntry);
    const processHtml = streamHtml(message, processEntries) || activityHtml(message);
    const processCount = processEntries.length || (message.activity || []).length;
    const duration = formatTaskDuration(taskDurationMs(message));
    const failed = message.status === "failed";
    const interrupted = message.status === "interrupted";
    const stateLabel = failed ? "执行未完成" : interrupted ? "执行已暂停" : "执行过程";
    const resultText = finalEntry?.text || message.text || (failed ? "任务未完成。" : "任务已完成。");
    const processSummary = processHtml ? `<details class="completed-process ${message.status || "completed"}">
      <summary>
        <span class="completed-process-mark" aria-hidden="true">${failed ? "!" : interrupted ? "Ⅱ" : "✓"}</span>
        <span class="completed-process-copy"><strong>${stateLabel}</strong><small>${processCount ? `${processCount} 项 · ` : ""}${duration}</small></span>
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>
      </summary>
      <div class="completed-process-body">${processHtml}</div>
    </details>` : `<div class="completed-runtime ${message.status || "completed"}"><span>${failed ? "!" : interrupted ? "Ⅱ" : "✓"}</span>${stateLabel} · ${duration}</div>`;
    return `${processSummary}<div class="completed-result"><div class="stream-message final ${message.status || "completed"}">${textHtml(resultText)}</div></div>`;
  }

  function messageInnerHtml(message) {
    const files = (message.attachments || []).map(attachmentHtml).join("");
    if (message.role === "user") {
      return `<div class="bubble">${message.text
        ? `<div class="user-message-copy"><div class="user-message-rich">${textHtml(message.text)}</div></div>
          <button type="button" class="user-message-toggle" aria-expanded="false" hidden>展开全文</button>`
        : ""}${files ? `<div class="message-files">${files}</div>` : ""}</div>
        <time>${message.status === "sending"
          ? (message.steeredInto ? "正在引导" : "正在发送")
          : `${message.steeredInto ? "已引导 · " : ""}${formatDate(message.createdAt)}${message.status === "failed" ? " · 发送失败，可重试" : ""}`}</time>`;
    }
    const streamedImageIds = new Set(
      (message.stream || []).filter((entry) => entry.kind === "image").map((entry) => entry.imageId));
    const deliveredImages = (message.images || [])
      .filter((image) => image.source === "delivery" || !streamedImageIds.has(image.id))
      .map((image) => inlineImageHtml(image, "delivery-image"))
      .join("");
    return `<div class="assistant-body">
      ${["completed", "failed", "interrupted"].includes(message.status)
        ? completedMessageHtml(message) : streamHtml(message)}
      ${deliveredImages ? `<div class="message-image-gallery">${deliveredImages}</div>` : ""}
      <time>${formatDate(message.createdAt)}</time>
    </div>`;
  }

  function fingerprint(message) {
    const source = JSON.stringify([
      message.role, message.status, message.text, message.attachments,
      message.activity, message.stream, message.images, message.steeredInto,
      message.startedAt, message.completedAt,
      message.sourceMessageId, message.segmentIndex, message.steerAtStreamIndex,
    ]);
    let hash = 2166136261;
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${source.length}-${hash >>> 0}`;
  }

  function scrollToBottom() {
    const stage = $("#chatStage");
    const previous = stage.style.scrollBehavior;
    stage.style.scrollBehavior = "auto";
    stage.scrollTop = stage.scrollHeight;
    requestAnimationFrame(() => { stage.style.scrollBehavior = previous; });
  }

  let rotationAnchor = null;
  let latestPinned = true;
  let lastLandscape = matchMedia("(orientation: landscape)").matches;

  function distanceFromBottom() {
    const stage = $("#chatStage");
    return Math.max(0, stage.scrollHeight - stage.scrollTop - stage.clientHeight);
  }

  function captureRotationAnchor() {
    if (rotationAnchor) return;
    const stage = $("#chatStage");
    const stageTop = stage.getBoundingClientRect().top;
    const visible = [...$("#messageList").children].find((message) =>
      message.getBoundingClientRect().bottom > stageTop + 1);
    rotationAnchor = {
      stickToLatest: latestPinned || distanceFromBottom() < 180,
      bottomGap: distanceFromBottom(),
      messageId: visible?.dataset.message || "",
      offset: visible ? visible.getBoundingClientRect().top - stageTop : 0,
    };
  }

  function restoreRotationAnchor(anchor) {
    if (!anchor) return;
    const stage = $("#chatStage");
    if (anchor.stickToLatest) {
      scrollToBottom();
      latestPinned = true;
      return;
    }
    const message = anchor.messageId
      ? $("#messageList").querySelector(`[data-message="${CSS.escape(anchor.messageId)}"]`)
      : null;
    if (message) {
      const stageTop = stage.getBoundingClientRect().top;
      stage.scrollTop += message.getBoundingClientRect().top - stageTop - anchor.offset;
    } else {
      stage.scrollTop = Math.max(
        0, stage.scrollHeight - stage.clientHeight - anchor.bottomGap);
    }
    latestPinned = distanceFromBottom() < 180;
  }

  function beginOrientationChange() {
    captureRotationAnchor();
  }

  function finishViewportResize() {
    const landscape = matchMedia("(orientation: landscape)").matches;
    if (landscape !== lastLandscape && !rotationAnchor) captureRotationAnchor();
    lastLandscape = landscape;
    clearTimeout(collapseResizeTimer);
    collapseResizeTimer = setTimeout(() => {
      const anchor = rotationAnchor;
      renderMessages(true);
      requestAnimationFrame(() => requestAnimationFrame(() => restoreRotationAnchor(anchor)));
      setTimeout(() => {
        restoreRotationAnchor(anchor);
        if (rotationAnchor === anchor) rotationAnchor = null;
      }, 240);
    }, 120);
  }

  $("#chatStage").addEventListener("scroll", () => {
    if (!rotationAnchor) latestPinned = distanceFromBottom() < 180;
  }, { passive: true });
  window.addEventListener("orientationchange", beginOrientationChange);
  window.screen.orientation?.addEventListener?.("change", beginOrientationChange);
  window.addEventListener("resize", finishViewportResize);

  function syncUserMessageCollapse(article, message) {
    if (message.role !== "user" || !message.text) return;
    const copy = article.querySelector(".user-message-copy");
    const content = copy?.querySelector(".user-message-rich");
    const button = article.querySelector(".user-message-toggle");
    if (!copy || !content || !button) return;
    article.classList.remove("long-message");
    const style = getComputedStyle(content);
    const lineHeight = Number.parseFloat(style.lineHeight) ||
      Number.parseFloat(style.fontSize) * 1.65;
    const needsCollapse = content.scrollHeight > lineHeight * 7 + 2;
    const expanded = needsCollapse && state.expandedMessages.has(message.id);
    article.classList.toggle("long-message", needsCollapse);
    article.classList.toggle("expanded", expanded);
    button.hidden = !needsCollapse;
    button.textContent = expanded ? "收起" : "展开全文";
    button.setAttribute("aria-expanded", String(expanded));
  }

  function streamBoundaryForSteer(stream, steer, minimum) {
    const recorded = Number(steer.steerAtStreamIndex);
    if (Number.isInteger(recorded) && recorded >= 0) {
      return Math.max(minimum, Math.min(stream.length, recorded));
    }
    const steeredAt = Date.parse(steer.createdAt || "");
    if (!Number.isFinite(steeredAt)) return stream.length;
    const nextIndex = stream.findIndex((entry, index) =>
      index >= minimum && Date.parse(entry.createdAt || "") > steeredAt);
    return nextIndex < 0 ? stream.length : nextIndex;
  }

  function splitAssistantAroundSteers(message, steers) {
    if (!steers.length) return [message];
    const stream = Array.isArray(message.stream) ? message.stream : [];
    const allStreamImageIds = new Set(
      stream.filter((entry) => entry.kind === "image").map((entry) => entry.imageId));
    const result = [];
    let start = 0;
    let segmentIndex = 0;

    const makeSegment = (end, finalSegment, anchorSteer = null) => {
      const segmentStream = stream.slice(start, end);
      const segmentImageIds = new Set(
        segmentStream.filter((entry) => entry.kind === "image").map((entry) => entry.imageId));
      const images = (message.images || []).filter((image) =>
        segmentImageIds.has(image.id) ||
        (finalSegment && (image.source === "delivery" || !allStreamImageIds.has(image.id))));
      const segment = {
        ...message,
        id: segmentIndex === 0
          ? message.id
          : `${message.id}--continuation-${segmentIndex}`,
        sourceMessageId: message.id,
        segmentIndex,
        stream: segmentStream,
        images,
        text: finalSegment ? message.text : "",
        activity: finalSegment
          ? message.activity
          : (segmentIndex === 0 && !segmentStream.length ? message.activity : []),
        status: finalSegment ? message.status : "completed",
        createdAt: anchorSteer?.createdAt || message.createdAt,
      };
      segmentIndex += 1;
      start = end;
      return segment;
    };

    steers.forEach((steer) => {
      const boundary = streamBoundaryForSteer(stream, steer, start);
      const hasVisiblePriorOutput = boundary > start ||
        (result.length === 0 && (message.text || (message.activity || []).length));
      if (hasVisiblePriorOutput) result.push(makeSegment(boundary, false));
      result.push(steer);
    });
    result.push(makeSegment(stream.length, true, steers.at(-1)));
    return result;
  }

  function renderMessages(keepPosition = false) {
    const list = $("#messageList");
    const nearBottom = $("#chatStage").scrollHeight - $("#chatStage").scrollTop - $("#chatStage").clientHeight < 180;
    const messages = [...(state.active?.messages || [])];
    if (state.optimisticMessage) {
      const runningIndex = messages.findLastIndex((message) =>
        message.role === "assistant" &&
        (message.status === "queued" || message.status === "running"));
      messages.splice(runningIndex >= 0 ? runningIndex + 1 : messages.length, 0, state.optimisticMessage);
    }
    // Split an active assistant turn at each steering boundary so new output appears
    // below the user's guidance instead of making that guidance trail the whole turn.
    const steeringByAssistant = new Map();
    messages.forEach((message) => {
      if (!message.steeredInto) return;
      const steering = steeringByAssistant.get(message.steeredInto) || [];
      steering.push(message);
      steeringByAssistant.set(message.steeredInto, steering);
    });
    const orderedMessages = [];
    messages.forEach((message) => {
      if (message.steeredInto) return;
      const steers = steeringByAssistant.get(message.id) || [];
      orderedMessages.push(...(
        message.role === "assistant"
          ? splitAssistantAroundSteers(message, steers)
          : [message, ...steers]
      ));
    });
    $("#welcome").hidden = orderedMessages.length > 0;
    $("#chatTitle").textContent = state.active?.title || "Witt";
    const liveIds = new Set(orderedMessages.map((message) => message.id));
    let changed = false;
    list.querySelectorAll(":scope > .message").forEach((node) => {
      if (!liveIds.has(node.dataset.message)) {
        node.remove();
        changed = true;
      }
    });
    orderedMessages.forEach((message, index) => {
      let article = list.querySelector(`[data-message="${CSS.escape(message.id)}"]`);
      const isNew = !article;
      if (isNew) {
        article = document.createElement("article");
        article.dataset.message = message.id;
      }
      const signature = fingerprint(message);
      if (article.dataset.fingerprint !== signature) {
        const previousStatus = article.dataset.status;
        const wasOpen = Boolean(article.querySelector("details[open]"));
        article.className = `message ${message.role} ${message.status || ""} ${message.steeredInto ? "guided" : ""}`;
        article.innerHTML = messageInnerHtml(message);
        if (wasOpen && previousStatus === message.status) {
          article.querySelector("details")?.setAttribute("open", "");
        }
        article.dataset.status = message.status || "";
        article.dataset.fingerprint = signature;
        changed = true;
      }
      const reference = list.children[index];
      if (reference !== article) {
        list.insertBefore(article, reference || null);
        changed = true;
      }
      syncUserMessageCollapse(article, message);
    });
    if (changed && (!keepPosition || nearBottom)) {
      requestAnimationFrame(scrollToBottom);
    }
    const busy = messages.some((message) =>
      message.role === "assistant" &&
      (message.status === "queued" || message.status === "running"));
    setBusy(busy);
    renderDeliveries();
    clearTimeout(pollTimer);
    if (!state.supportsSse && busy && state.activeId && state.appVisible) {
      pollTimer = setTimeout(requestActiveConversationSync, 1200);
    }
  }

  function requestActiveConversationSync() {
    if (!state.appVisible || !state.activeId || state.supportsSse) return;
    const nativeBridge = bridge();
    if (typeof nativeBridge?.requestConversationDelta === "function") {
      nativeBridge.requestConversationDelta(state.activeId);
    } else {
      nativeBridge?.requestConversation?.(state.activeId);
    }
  }

  function setAppVisible(visible) {
    state.appVisible = Boolean(visible);
    document.body.classList.toggle("power-paused", !state.appVisible);
    clearTimeout(pollTimer);
    if (!state.appVisible) {
      if (state.supportsSse) bridge()?.unsubscribeConversationEvents?.();
      document.querySelectorAll("[data-scene-video]").forEach((video) => video.pause());
      return;
    }
    applyTheme(document.documentElement.dataset.themeMode || "light");
    if (state.supportsSse && state.activeId) {
      bridge()?.subscribeConversationEvents?.(state.activeId);
    } else if (state.busy && state.activeId) {
      pollTimer = setTimeout(requestActiveConversationSync, 120);
    }
  }

  function setBusy(busy) {
    state.busy = busy;
    if (!busy) state.pausing = false;
    $("#messageInput").disabled = false;
    $("#attachButton").disabled = state.transmitting;
    $(".composer").classList.toggle("has-active-turn", busy);
    refreshActionButton();
    $("#composerHint").textContent = busy
      ? "处理中 · 你可以继续补充要求"
      : "由你服务器上的 Codex 处理 · 重要操作会先确认";
  }

  function hasComposerContent() {
    return Boolean($("#messageInput").value.trim() || state.attachments.size);
  }

  function refreshActionButton() {
    const button = $("#sendButton");
    const canGuide = hasComposerContent();
    button.classList.toggle("sending", state.transmitting);
    button.classList.toggle("working", state.busy && !canGuide && !state.transmitting);
    button.classList.toggle("pausing", state.pausing);
    button.disabled = state.transmitting || state.pausing;
    button.setAttribute("aria-label",
      state.busy && !canGuide ? "暂停当前执行" : state.busy ? "发送引导" : "发送");
  }

  function renderAttachments() {
    const files = [...state.attachments.values()];
    $("#attachmentStrip").innerHTML = files.map((file) => `
      <span class="attachment-chip ${file.state || ""}">
        <b>${extension(file.name)}</b>
        <span><strong>${escapeHtml(file.name)}</strong><small>${file.label || formatBytes(file.size)}</small></span>
        <button data-remove-file="${file.id}" ${file.state === "uploading" ? "disabled" : ""}>×</button>
        <i style="width:${file.progress || 0}%"></i>
      </span>`).join("");
    $("#attachmentStrip").classList.toggle("visible", files.length > 0);
    refreshActionButton();
  }

  function selectConversation(id) {
    if (!id) return;
    state.activeId = id;
    localStorage.setItem("wit_active_conversation", id);
    closeDrawer();
    renderConversations();
    setConnected(true, "读取对话中");
    bridge()?.requestConversation?.(id);
    if (state.supportsSse && state.appVisible) {
      bridge()?.subscribeConversationEvents?.(id);
    }
  }

  function applyConversation(conversation) {
    if (!conversation || conversation.id !== state.activeId) return;
    const wasBusy = state.busy;
    state.active = conversation;
    state.model = conversation.model || state.model;
    state.reasoning = conversation.reasoning || state.reasoning;
    state.accessMode = conversation.accessMode || state.accessMode;
    state.codexProfile = conversation.codexProfile || "default";
    state.workDir = conversation.workDir || "";
    persistConversation(conversation);
    updateModelControls();
    setConnected(true, conversation.busy ? "Witt 正在处理" : "服务器在线");
    renderMessages(true);
    updateQuotaStatus();
    if (!state.usage) refreshUsage();
    const summary = state.conversations.find((item) => item.id === conversation.id);
    if (summary) {
      summary.title = conversation.title;
      summary.updatedAt = conversation.updatedAt;
      summary.lastMessage = conversation.lastMessage ||
        conversation.messages?.at(-1)?.text || summary.lastMessage;
      summary.busy = state.busy;
      renderConversations();
      persistConversationList();
    }
    if (wasBusy && !state.busy) bridge()?.requestConversations?.();
  }

  function requestConversationCreation(workDir, callback = null) {
    state.afterCreate = callback;
    const nativeBridge = bridge();
    if (typeof nativeBridge?.createConversation !== "function") {
      state.afterCreate = null;
      window.DropVault.onMessageSendError("当前版本无法创建对话，请更新 App");
      return;
    }
    try {
      if (typeof nativeBridge.createConversationWithProfile === "function") {
        nativeBridge.createConversationWithProfile(
          state.model, state.reasoning, state.accessMode, workDir || "",
          state.codexProfile || "default");
      } else if (typeof nativeBridge.createConversationWithPath === "function") {
        nativeBridge.createConversationWithPath(
          state.model, state.reasoning, state.accessMode, workDir || "");
      } else if (workDir) {
        state.afterCreate = null;
        window.DropVault.onMessageSendError("选择项目路径需要更新到最新版 App");
      } else if (state.supports21) {
        nativeBridge.createConversation(state.model, state.reasoning, state.accessMode);
      } else {
        nativeBridge.createConversation(state.model, state.reasoning);
      }
    } catch {
      state.afterCreate = null;
      window.DropVault.onMessageSendError("创建对话失败，请重启 App 后再试");
    }
  }

  function ensureConversation(callback) {
    if (state.activeId) {
      callback();
      return;
    }
    requestConversationCreation("", callback);
  }

  function submitUploadedMessage() {
    if (!state.pendingSend) return;
    const { text, uploadedIds } = state.pendingSend;
    bridge()?.sendChatMessage?.(state.activeId, text, JSON.stringify(uploadedIds));
  }

  function sendMessage(prefill) {
    const text = typeof prefill === "string" ? prefill.trim() : $("#messageInput").value.trim();
    const files = [...state.attachments.values()];
    if (!text && !files.length) return;
    if (state.transmitting) {
      toast("上一条消息正在送达，请稍候");
      return;
    }
    state.transmitting = true;
    state.lastSubmittedText = text;
    state.optimisticMessage = {
      id: `local-${Date.now()}`,
      role: "user",
      text,
      attachments: files.map((file) => ({ ...file })),
      createdAt: new Date().toISOString(),
      status: "sending",
      steeredInto: state.busy
        ? state.active?.messages?.findLast((message) =>
          message.role === "assistant" &&
          (message.status === "queued" || message.status === "running"))?.id || "active"
        : null,
      steerAtStreamIndex: state.busy
        ? (state.active?.messages?.findLast((message) =>
          message.role === "assistant" &&
          (message.status === "queued" || message.status === "running"))?.stream || []).length
        : null,
    };
    setBusy(state.busy);
    renderMessages();
    ensureConversation(() => {
      if (files.length) {
        state.pendingSend = { text, waiting: new Set(files.map((file) => file.id)), uploadedIds: [] };
        files.forEach((file) => {
          file.state = "uploading";
          file.label = "准备上传";
          bridge()?.uploadFile?.(file.id);
        });
        renderAttachments();
      } else {
        bridge()?.sendChatMessage?.(state.activeId, text, "[]");
      }
    });
  }

  function resetComposer() {
    $("#messageInput").value = "";
    $("#messageInput").style.height = "";
    state.attachments.clear();
    state.pendingSend = null;
    state.optimisticMessage = null;
    renderAttachments();
  }

  window.DropVault = {
    nativeReady(info = {}) {
      if (state.nativeInitialized) return;
      state.nativeInitialized = true;
      document.body.classList.add("native");
      const version = String(info.version || window.DropVaultAndroid?.getVersion?.() || "");
      const cacheScope = String(info.cacheScope || window.DropVaultAndroid?.getCacheScope?.() || "");
      state.supportsSse = Boolean(info.supportsSse);
      if (/^[a-f0-9]{24,64}$/.test(cacheScope)) {
        state.cacheScope = cacheScope;
      }
      if (version) $("#appVersion").textContent = `v${version}`;
      if (versionLessThan(version, "2.1.7")) {
        setTimeout(() => bridge()?.checkForUpdates?.(), 900);
      }
      state.supports21 = /^2\.(?:[1-9]|\d{2,})\.|^[3-9]\./.test(version || "");
      if (typeof bridge()?.requestConversations !== "function" ||
          typeof bridge()?.requestAuthStatus !== "function") {
        dismissBoot();
        setConnected(false, "需要更新 App");
        $("#welcome h1").textContent = "新版对话已经准备好";
        $("#welcome>p").textContent = "请先更新 Witt，更新完成后即可在这里连续对话。";
        $(".suggestions").innerHTML = `<button id="legacyUpdate"><b>立即更新 Witt</b><small>安装支持连续对话的新版本</small></button>`;
        $("#legacyUpdate").addEventListener("click", () => bridge()?.checkForUpdates?.());
        $("#messageInput").disabled = true;
        $("#attachButton").disabled = true;
        $("#sendButton").disabled = true;
        setTimeout(() => bridge()?.checkForUpdates?.(), 500);
        return;
      }
      bridge()?.requestAuthStatus?.();
    },
    onAuthStatus(json) {
      const payload = JSON.parse(json);
      if (payload.authenticated) {
        state.authenticated = true;
        state.admin = Boolean(payload.principal?.admin);
        applyPrincipalPolicy(payload.principal);
        $("#adminSettingsButton").hidden = !state.admin;
        $("#codexAccountsButton").hidden = !state.admin;
        hideActivation();
        bridge()?.requestCapabilities?.();
        hydrateConversationCache().finally(() => bridge()?.requestConversations?.());
        return;
      }
      if (payload.initialized) {
        if (payload.bootstrapEligible) {
          claimThisDevice();
          return;
        }
        showActivation("此设备尚未获授权，请输入邀请码。邀请码不会保存到网页中。");
        return;
      }
      showActivation("管理员正在初始化访问控制，请稍后重新连接。");
    },
    onAuthError(message) {
      showActivation(message || "无法验证这台设备，请检查网络后重试。");
    },
    onActivation(json) {
      const payload = JSON.parse(json);
      state.authenticated = true;
      state.admin = Boolean(payload.principal?.admin);
      applyPrincipalPolicy(payload.principal);
      $("#adminSettingsButton").hidden = !state.admin;
      $("#codexAccountsButton").hidden = !state.admin;
      $("#inviteCode").value = "";
      hideActivation();
      bridge()?.requestCapabilities?.();
      setConnected(true, "设备已激活");
      toast(`已激活：${payload.principal?.label || "此设备"}`);
      state.cacheHydrated = false;
      state.cacheScope = "";
      hydrateConversationCache().finally(() => bridge()?.requestConversations?.());
    },
    onActivationError(message) {
      $("#authGateHint").textContent = message || "邀请码无效或该设备未获授权。";
      $("#activateInviteButton").disabled = false;
      $("#activateInviteButton span").textContent = "再次尝试";
    },
    onConversations(json) {
      const payload = JSON.parse(json);
      state.conversations = payload.conversations || [];
      persistConversationList();
      setConnected(true, "服务器在线");
      dismissBoot();
      renderConversations();
      if (state.activeId && state.conversations.some((item) => item.id === state.activeId)) {
        selectConversation(state.activeId);
      } else if (state.conversations.length) {
        selectConversation(state.conversations[0].id);
      } else {
        state.activeId = null;
        state.active = null;
        state.workDir = "";
        updateModelControls();
        renderMessages();
      }
    },
    onCapabilities(json) {
      state.capabilities = JSON.parse(json);
      renderCapabilities();
    },
    onCapabilitiesError(message) {
      const serverLive = $("#appServerLive");
      if (serverLive) {
        serverLive.classList.add("offline");
        serverLive.innerHTML = "<i></i>OFFLINE";
      }
      $("#appServerStatus").textContent = message || "App Server 能力暂时不可用";
    },
    onConversationCreated(json) {
      const conversation = JSON.parse(json).conversation;
      state.activeId = conversation.id;
      state.active = conversation;
      state.model = conversation.model || state.model;
      state.reasoning = conversation.reasoning || state.reasoning;
      state.accessMode = conversation.accessMode || state.accessMode;
      state.codexProfile = conversation.codexProfile || "default";
      state.workDir = conversation.workDir || "";
      updateModelControls();
      localStorage.setItem("wit_active_conversation", conversation.id);
      persistConversation(conversation);
      if (state.supportsSse && state.appVisible) {
        bridge()?.subscribeConversationEvents?.(conversation.id);
      }
      bridge()?.requestConversations?.();
      renderMessages();
      const next = state.afterCreate;
      state.afterCreate = null;
      if (next) {
        next();
      } else {
        state.transmitting = false;
        setBusy(false);
        $("#messageInput").focus();
      }
    },
    onConversationForked(json) {
      const conversation = JSON.parse(json).conversation;
      state.activeId = conversation.id;
      state.active = conversation;
      localStorage.setItem("wit_active_conversation", conversation.id);
      persistConversation(conversation);
      if (state.supportsSse && state.appVisible) {
        bridge()?.subscribeConversationEvents?.(conversation.id);
      }
      closeSettings();
      bridge()?.requestConversations?.();
      renderMessages();
      toast("已创建独立对话分支");
    },
    onConversationCompacted(json) {
      const conversation = JSON.parse(json).conversation;
      if (conversation?.id === state.activeId) {
        state.active = conversation;
        persistConversation(conversation);
      }
      closeSettings();
      toast("已开始压缩上下文");
    },
    onReviewStarted(json) {
      const conversation = JSON.parse(json).conversation;
      if (conversation?.id === state.activeId) {
        state.active = conversation;
        persistConversation(conversation);
        renderMessages(true);
      }
      closeSettings();
      setBusy(true);
      toast("代码审查已开始");
    },
    onAppServerActionError(message) {
      toast(message || "App Server 操作失败");
      renderCapabilities();
    },
    onConversation(json) {
      const conversation = JSON.parse(json).conversation;
      applyConversation(conversation);
    },
    onConversationDelta(json) {
      const payload = JSON.parse(json);
      const metadata = payload.conversation;
      if (!metadata || metadata.id !== state.activeId) return;
      const currentMessages = state.active?.messages || [];
      const replaceFrom = Number(payload.replaceFrom);
      const messages = Array.isArray(payload.messages) ? payload.messages : [];
      if (!Number.isInteger(replaceFrom) || replaceFrom < 0 || replaceFrom > currentMessages.length ||
          replaceFrom + messages.length !== Number(payload.totalMessages)) {
        bridge()?.requestConversation?.(state.activeId);
        return;
      }
      applyConversation({
        ...state.active,
        ...metadata,
        messages: [...currentMessages.slice(0, replaceFrom), ...messages],
      });
    },
    onAppVisibility(visible) {
      setAppVisible(visible);
    },
    onConversationInterruptRequested(json) {
      const conversation = JSON.parse(json).conversation;
      if (conversation?.id === state.activeId) {
        state.active = conversation;
        persistConversation(conversation);
      }
      state.pausing = true;
      renderMessages(true);
      toast("正在暂停当前执行");
    },
    onConversationInterruptError(message) {
      state.pausing = false;
      setBusy(state.busy);
      toast(message || "暂时无法暂停");
    },
    onApprovalResolved(json) {
      const payload = JSON.parse(json);
      if (payload.conversation?.id === state.activeId) {
        state.active = payload.conversation;
        persistConversation();
        renderMessages(true);
      }
      toast("权限选择已提交");
    },
    onApprovalError(message) {
      document.querySelectorAll("[data-approval-card].submitting").forEach((card) => {
        card.classList.remove("submitting");
        card.querySelectorAll("button").forEach((button) => { button.disabled = false; });
      });
      toast(message || "权限确认失败");
      if (state.activeId) bridge()?.requestConversation?.(state.activeId);
    },
    onMessageSent(json) {
      state.active = JSON.parse(json).conversation;
      persistConversation(state.active);
      state.transmitting = false;
      state.optimisticMessage = null;
      if ($("#messageInput").value.trim() === state.lastSubmittedText) {
        $("#messageInput").value = "";
        $("#messageInput").style.height = "";
      }
      state.lastSubmittedText = "";
      state.attachments.clear();
      state.pendingSend = null;
      renderAttachments();
      renderMessages();
      bridge()?.requestConversations?.();
    },
    onMessageSendError(message) {
      state.pendingSend = null;
      state.transmitting = false;
      if (state.optimisticMessage) state.optimisticMessage.status = "failed";
      setBusy(state.busy);
      renderMessages(true);
      toast(message || "消息发送失败");
    },
    onSettingsUpdated(json) {
      const conversation = JSON.parse(json).conversation;
      state.active = conversation;
      state.model = conversation.model;
      state.reasoning = conversation.reasoning;
      state.accessMode = conversation.accessMode;
      state.codexProfile = conversation.codexProfile || "default";
      state.workDir = conversation.workDir || "";
      persistConversation(conversation);
      localStorage.setItem("wit_model", state.model);
      localStorage.setItem("wit_reasoning", state.reasoning);
      localStorage.setItem("wit_access", state.accessMode);
      localStorage.setItem("wit_codex_profile", state.codexProfile);
      updateModelControls();
      closeSettings();
      toast(`设置已更新 · ${modelNames[state.model]} · ${reasoningNames[state.reasoning]}`);
      bridge()?.requestConversations?.();
    },
    onConversationProjectUpdated(json) {
      const conversation = JSON.parse(json).conversation;
      if (conversation.id !== state.activeId) return;
      state.active = conversation;
      state.workDir = conversation.workDir || "";
      persistConversation(conversation);
      updateModelControls();
      closeProject();
      toast(`已切换到${projectName(state.workDir)}`);
      bridge()?.requestConversations?.();
    },
    onConversationProjectError(message) {
      toast(message || "项目切换失败");
    },
    onUsage(json) {
      state.usageLoading = false;
      state.usage = JSON.parse(json);
      updateQuotaStatus();
      renderUsage();
    },
    onUsageError(message) {
      state.usageLoading = false;
      $("#usageContent").innerHTML = `
        <div class="usage-error"><strong>暂时无法读取用量</strong><small>${escapeHtml(message || "稍后再试")}</small><button id="retryUsage">重新读取</button></div>`;
      $("#retryUsage")?.addEventListener("click", () => {
        state.usageLoading = true;
        renderUsage();
        bridge()?.requestUsage?.(state.activeId || "");
      });
    },
    onUsageReset(json) {
      const outcome = JSON.parse(json)?.outcome;
      toast(outcome === "reset" ? "额度已重置" : outcome === "nothingToReset" ? "当前无需重置" : "没有可用重置额度");
      state.usage = null;
      state.usageLoading = true;
      renderUsage();
      bridge()?.requestUsage?.(state.activeId || "");
    },
    onUsageResetError(message) { toast(message || "重置额度失败"); },
    onAdminDevices(json) { renderAdminDevices(JSON.parse(json).devices || []); },
    onInviteCreated(json) {
      const invite = JSON.parse(json).invite;
      $("#latestInvite").innerHTML = `<div class="latest-invite"><small>新邀请码 · ${escapeHtml(invite.label || "新设备")}</small><code>${escapeHtml(invite.code || "")}</code></div>`;
      $("#inviteLabel").value = "";
      toast("邀请码已创建，请安全地发送给对方");
    },
    onDeviceDisabled() { toast("该设备已停止访问"); bridge()?.requestAdminDevices?.(); },
    onCodexAccounts(json) {
      renderCodexAccounts(JSON.parse(json).accounts || []);
    },
    onCodexLoginStarted(json) {
      const login = JSON.parse(json);
      state.codexLoginUrl = login.verificationUrl || "";
      $("#codexDeviceCode").textContent = login.userCode || "";
      $("#codexLoginFlow").hidden = false;
      $("#codexLoginHint").textContent = "等待你完成授权…";
      startCodexLoginPolling();
    },
    onCodexLoginStatus(json) {
      const result = JSON.parse(json);
      if (result.status === "pending") {
        $("#codexLoginHint").textContent = "等待你完成授权…";
        return;
      }
      stopCodexLoginPolling();
      if (result.status === "authenticated") {
        $("#codexLoginFlow").hidden = true;
        state.codexLoginUrl = "";
        toast("玄遇 Codex 账号已连接");
        bridge()?.requestCodexAccounts?.();
        return;
      }
      $("#codexLoginHint").textContent =
        result.status === "failed" ? (result.error || "登录未完成，请重试") : "尚未完成登录";
    },
    onCodexLoginCancelled() {
      stopCodexLoginPolling();
      state.codexLoginUrl = "";
      $("#codexLoginFlow").hidden = true;
      toast("已取消子账号登录");
    },
    onAdminError(message) { toast(message || "设备管理操作失败"); },
    onChatError(message) {
      dismissBoot();
      setConnected(false, "连接失败");
      state.afterCreate = null;
      state.transmitting = false;
      if (state.optimisticMessage) state.optimisticMessage.status = "failed";
      setBusy(state.busy);
      renderMessages(true);
      toast(message || "暂时无法连接服务器");
    },
    onFilesPicked(json) {
      JSON.parse(json).forEach((file) => state.attachments.set(file.id, { ...file, progress: 0 }));
      renderAttachments();
    },
    onUploadProgress(id, percent) {
      const file = state.attachments.get(id);
      if (!file) return;
      file.progress = percent;
      file.state = "uploading";
      file.label = `${percent}%`;
      renderAttachments();
    },
    onUploadFinished(id, ok, message, responseJson) {
      const file = state.attachments.get(id);
      if (!file || !state.pendingSend) return;
      if (!ok) {
        file.state = "error";
        file.label = "上传失败";
        state.pendingSend = null;
        state.transmitting = false;
        setBusy(state.busy);
        renderAttachments();
        toast(message || "附件上传失败");
        return;
      }
      try {
        const uploadId = JSON.parse(responseJson).file.id;
        state.pendingSend.uploadedIds.push(uploadId);
      } catch {
        this.onMessageSendError("服务器没有返回附件编号");
        return;
      }
      file.progress = 100;
      file.state = "done";
      file.label = "已上传";
      state.pendingSend.waiting.delete(id);
      renderAttachments();
      if (!state.pendingSend.waiting.size) submitUploadedMessage();
    },
    onConversationArchived(id) {
      if (state.activeId === id) {
        state.activeId = null;
        state.active = null;
        localStorage.removeItem("wit_active_conversation");
      }
      deleteCachedRecord(`conversation:${id}`);
      state.archiveId = null;
      closeArchiveDialog();
      bridge()?.requestConversations?.();
      renderMessages();
      toast("对话已移出列表");
    },
    onStreamDetail(json) {
      const payload = JSON.parse(json);
      if (!state.detailRequest || !payload.entry) return;
      renderActionDetail(payload.entry);
    },
    onStreamDetailError(message) {
      if (!state.detailRequest) return;
      $("#actionDetailContent").innerHTML =
        `<div class="detail-error">${escapeHtml(message || "暂时无法读取执行详情")}</div>`;
    },
  };

  function beginNewConversation(codexProfile = null) {
    const selectedProfile = codexProfile || state.allowedCodexProfiles[0] || "default";
    state.activeId = null;
    state.active = null;
    state.codexProfile = state.allowedCodexProfiles.includes(selectedProfile)
      ? selectedProfile : state.allowedCodexProfiles[0];
    state.workDir = state.codexProfile === "xuanyu" ? "/data/xuanyu-build-console" : "";
    localStorage.setItem("wit_codex_profile", state.codexProfile);
    localStorage.removeItem("wit_active_conversation");
    resetComposer();
    updateModelControls();
    renderMessages();
    state.transmitting = true;
    setBusy(false);
    requestConversationCreation(state.workDir);
  }

  function openArchiveDialog(id) {
    state.archiveId = id;
    $("#dialogLayer").classList.add("open");
    $("#dialogLayer").setAttribute("aria-hidden", "false");
  }

  function closeArchiveDialog() {
    $("#dialogLayer").classList.remove("open");
    $("#dialogLayer").setAttribute("aria-hidden", "false");
  }

  $("#menuButton").addEventListener("click", openDrawer);
  $("#identityButton").addEventListener("click", openDrawer);
  $("#closeDrawer").addEventListener("click", closeDrawer);
  $("#drawerBackdrop").addEventListener("click", closeDrawer);
  $("#profileButton").addEventListener("click", openProfile);
  $("#adminSettingsButton").addEventListener("click", openAdminSettings);
  $("#codexAccountsButton").addEventListener("click", openCodexAccounts);
  $(".theme-options").addEventListener("click", (event) => {
    const button = event.target.closest("[data-theme-choice]");
    if (!button) return;
    applyTheme(button.dataset.themeChoice, true);
  });
  $("#quotaButton").addEventListener("click", openProfile);
  $("#closeProfile").addEventListener("click", closeProfile);
  $("#profileBackdrop").addEventListener("click", closeProfile);
  $("#closeAdminSettings").addEventListener("click", closeAdminSettings);
  $("#adminSettingsBackdrop").addEventListener("click", closeAdminSettings);
  $("#closeCodexAccounts").addEventListener("click", closeCodexAccounts);
  $("#codexAccountBackdrop").addEventListener("click", closeCodexAccounts);
  $("#codexAccountList").addEventListener("click", (event) => {
    const login = event.target.closest("[data-login-codex]")?.dataset.loginCodex;
    if (login === "xuanyu") {
      $("#codexLoginHint").textContent = "正在创建安全登录流程…";
      bridge()?.startXuanyuCodexLogin?.();
      return;
    }
    const profile = event.target.closest("[data-new-codex-chat]")?.dataset.newCodexChat;
    if (!profile) return;
    closeCodexAccounts();
    beginNewConversation(profile);
  });
  $("#copyCodexDeviceCode").addEventListener("click", async () => {
    const code = $("#codexDeviceCode").textContent.trim();
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      toast("一次性代码已复制");
    } catch {
      toast("长按代码即可复制");
    }
  });
  $("#openCodexLogin").addEventListener("click", () => {
    if (!state.codexLoginUrl) return;
    window.location.href = state.codexLoginUrl;
  });
  $("#cancelCodexLogin").addEventListener("click", () =>
    bridge()?.cancelXuanyuCodexLogin?.());
  $("#createInviteButton").addEventListener("click", () => {
    const label = $("#inviteLabel").value.trim() || "新设备";
    bridge()?.createInvite?.(label, 1);
  });
  $("#deviceList").addEventListener("click", (event) => {
    const id = event.target.closest("[data-disable-device]")?.dataset.disableDevice;
    if (id) bridge()?.disableDevice?.(id);
  });
  $("#quotaConfirmBackdrop").addEventListener("click", closeQuotaResetConfirm);
  $("#cancelQuotaReset").addEventListener("click", closeQuotaResetConfirm);
  $("#confirmQuotaReset").addEventListener("click", consumeQuotaReset);
  $("#usageContent").addEventListener("click", (event) => {
    if (event.target.closest("[data-reset-rate-limit]")) {
      openQuotaResetConfirm();
      return;
    }
    const day = event.target.closest("[data-usage-date]");
    if (!day) return;
    toast(`${day.dataset.usageDate} · ${Number(day.dataset.usageTokens || 0).toLocaleString("zh-CN")} tokens`);
  });
  $("#deliveryButton").addEventListener("click", openDelivery);
  $("#closeDelivery").addEventListener("click", closeDelivery);
  $("#deliveryBackdrop").addEventListener("click", closeDelivery);
  $("#closeActionDetail").addEventListener("click", closeActionDetail);
  $("#actionDetailBackdrop").addEventListener("click", closeActionDetail);
  $("#closeImageViewer").addEventListener("click", closeImageViewer);
  $("#downloadImageViewer").addEventListener("click", () => {
    const button = $("#downloadImageViewer");
    if (!button.dataset.url) return;
    if (typeof bridge()?.downloadImage === "function") {
      bridge().downloadImage(button.dataset.url, button.dataset.name, button.dataset.mimeType);
      toast("正在下载图片");
      return;
    }
    const link = document.createElement("a");
    link.href = button.dataset.url;
    link.download = button.dataset.name || "Witt 图片";
    link.click();
  });
  $("#imageViewerBackdrop").addEventListener("click", closeImageViewer);
  $("#deliveryList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-artifact]");
    if (!button || !state.activeId) return;
    const artifact = allArtifacts().find((item) =>
      item.id === button.dataset.artifact && item.messageId === button.dataset.message);
    if (!artifact) return;
    if (typeof bridge()?.downloadArtifact !== "function") {
      toast("请先更新到新版 App 再下载交付文件");
      bridge()?.checkForUpdates?.();
      return;
    }
    bridge()?.downloadArtifact?.(
      state.activeId, artifact.messageId, artifact.id, artifact.name, artifact.mimeType || "");
    toast("正在下载交付文件");
  });
  $("#drawerNewChat").addEventListener("click", () => {
    closeDrawer();
    beginNewConversation();
  });
  $("#attachButton").addEventListener("click", () => bridge()?.pickFiles?.());
  $("#activateInviteButton").addEventListener("click", () => {
    const code = $("#inviteCode").value.trim();
    if (!code) { $("#authGateHint").textContent = "请先输入邀请码。"; return; }
    const button = $("#activateInviteButton");
    button.disabled = true;
    button.querySelector("span").textContent = "正在验证";
    $("#authGateHint").textContent = "正在为这台设备创建独立访问凭据…";
    bridge()?.activateInvite?.(code);
  });
  $("#inviteCode").addEventListener("keydown", (event) => {
    if (event.key === "Enter") $("#activateInviteButton").click();
  });
  $("#sendButton").addEventListener("click", () => {
    if (!state.busy || hasComposerContent()) {
      sendMessage();
      return;
    }
    if (!state.activeId || state.pausing) return;
    if (typeof bridge()?.interruptConversation !== "function") {
      toast("暂停功能需要更新到最新版 App");
      bridge()?.checkForUpdates?.();
      return;
    }
    state.pausing = true;
    setBusy(true);
    bridge().interruptConversation(state.activeId);
  });
  $("#messageInput").addEventListener("input", (event) => {
    event.target.style.height = "auto";
    event.target.style.height = `${Math.min(128, event.target.scrollHeight)}px`;
    refreshActionButton();
  });
  $("#messageInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      sendMessage();
    }
  });
  $("#attachmentStrip").addEventListener("click", (event) => {
    const id = event.target.closest("[data-remove-file]")?.dataset.removeFile;
    if (!id) return;
    state.attachments.delete(id);
    renderAttachments();
  });
  $("#messageList").addEventListener("click", (event) => {
    const codeCopy = event.target.closest("[data-copy-code]");
    if (codeCopy) {
      const code = codeCopy.closest(".chat-code-block")?.querySelector("code")?.textContent || "";
      if (!code) return;
      navigator.clipboard.writeText(code).then(() => {
        codeCopy.textContent = "已复制";
        codeCopy.classList.add("copied");
        setTimeout(() => {
          codeCopy.textContent = "复制";
          codeCopy.classList.remove("copied");
        }, 1500);
      }).catch(() => toast("暂时无法复制代码"));
      return;
    }
    const messageToggle = event.target.closest(".user-message-toggle");
    if (messageToggle) {
      const article = messageToggle.closest(".message.user");
      if (!article) return;
      if (state.expandedMessages.has(article.dataset.message)) {
        state.expandedMessages.delete(article.dataset.message);
      } else {
        state.expandedMessages.add(article.dataset.message);
      }
      article.classList.toggle("expanded", state.expandedMessages.has(article.dataset.message));
      messageToggle.textContent = article.classList.contains("expanded") ? "收起" : "展开全文";
      messageToggle.setAttribute("aria-expanded", String(article.classList.contains("expanded")));
      return;
    }
    const approvalButton = event.target.closest("[data-approval-choice]");
    if (approvalButton) {
      respondToApproval(
        approvalButton.dataset.approvalId,
        approvalButton.dataset.approvalChoice,
      );
      return;
    }
    const approvalPayload = event.target.closest("[data-approval-payload]");
    if (approvalPayload) {
      respondToApproval(approvalPayload.dataset.approvalId, JSON.stringify({
        action: approvalPayload.dataset.approvalPayload,
        content: null,
      }));
      return;
    }
    const image = event.target.closest("[data-inline-image]");
    if (image) {
      openImageViewer(image.dataset.inlineImage, image.dataset.imageName, image.dataset.imageMime);
      return;
    }
    const action = event.target.closest("[data-stream-detail]");
    if (!action) return;
    openActionDetail(action.dataset.messageId, action.dataset.streamDetail,
      action.querySelector("p")?.textContent || "执行详情");
  });
  document.addEventListener("submit", (event) => {
    const inputForm = event.target.closest("[data-approval-input-form]");
    const mcpForm = event.target.closest("[data-approval-mcp-form]");
    if (!inputForm && !mcpForm) return;
    event.preventDefault();
    if (inputForm) {
      const answers = {};
      let valid = true;
      inputForm.querySelectorAll(".approval-question").forEach((field) => {
        const checked = field.querySelector('input[type="radio"]:checked');
        const textInput = field.querySelector(".approval-text-input");
        let value = checked?.value || textInput?.value.trim() || "";
        if (value === "__other__") value = field.querySelector(".approval-other-input")?.value.trim() || "";
        if (!value) valid = false;
        answers[field.dataset.questionId] = { answers: value ? [value] : [] };
      });
      if (!valid) { toast("请完成所有连接器问题"); return; }
      respondToApproval(inputForm.dataset.approvalId, JSON.stringify({ answers }));
      return;
    }
    const content = {};
    mcpForm.querySelectorAll(".approval-schema-field").forEach((field) => {
      const input = field.querySelector("input, select, textarea");
      if (!input) return;
      const type = field.dataset.valueType;
      if (type === "boolean") content[field.dataset.fieldKey] = Boolean(input.checked);
      else if (["number", "integer"].includes(type)) {
        if (input.value !== "") content[field.dataset.fieldKey] = Number(input.value);
      } else if (input.value !== "") content[field.dataset.fieldKey] = input.value;
    });
    respondToApproval(mcpForm.dataset.approvalId, JSON.stringify({ action: "accept", content }));
  });
  $("#conversationList").addEventListener("click", (event) => {
    const openId = event.target.closest("[data-open]")?.dataset.open;
    const archiveId = event.target.closest("[data-archive]")?.dataset.archive;
    if (openId) selectConversation(openId);
    if (archiveId) openArchiveDialog(archiveId);
  });
  $(".suggestions").addEventListener("click", (event) => {
    const prompt = event.target.closest("[data-prompt]")?.dataset.prompt;
    if (prompt) {
      $("#messageInput").value = prompt;
      $("#messageInput").dispatchEvent(new Event("input"));
      $("#messageInput").focus();
    }
  });
  $("#cancelArchive").addEventListener("click", closeArchiveDialog);
  $(".dialog-backdrop").addEventListener("click", closeArchiveDialog);
  $("#confirmArchive").addEventListener("click", () => {
    if (state.archiveId) bridge()?.archiveConversation?.(state.archiveId);
  });
  $("#updateButton").addEventListener("click", () => bridge()?.checkForUpdates?.());
  $("#projectButton").addEventListener("click", openProject);
  $("#closeProject").addEventListener("click", closeProject);
  $("#projectBackdrop").addEventListener("click", closeProject);
  $(".project-options").addEventListener("click", (event) => {
    const button = event.target.closest("[data-project-path]");
    if (!button || !state.activeId) return;
    const workDir = button.dataset.projectPath || "";
    if (workDir === state.workDir) {
      closeProject();
      return;
    }
    document.querySelectorAll("[data-project-path]").forEach((item) =>
      item.classList.toggle("selected", item === button));
    if (typeof bridge()?.updateConversationProject !== "function") {
      toast("项目切换需要更新到最新版 App");
      bridge()?.checkForUpdates?.();
      return;
    }
    bridge().updateConversationProject(state.activeId, workDir);
  });
  $("#modelButton").addEventListener("click", openSettings);
  $("#closeSettings").addEventListener("click", closeSettings);
  $("#sheetBackdrop").addEventListener("click", closeSettings);
  $(".model-options").addEventListener("click", (event) => {
    const model = event.target.closest("[data-model]")?.dataset.model;
    if (!model) return;
    state.draftModel = model;
    updateModelControls();
  });
  const selectReasoning = (event) => {
    const reasoning = event.target.closest("[data-reasoning]")?.dataset.reasoning;
    if (!reasoning) return;
    state.draftReasoning = reasoning;
    updateModelControls();
  };
  $("#reasoningStops").addEventListener("click", selectReasoning);
  $("#reasoningSegments").addEventListener("click", selectReasoning);
  $(".access-options").addEventListener("click", (event) => {
    const accessMode = event.target.closest("[data-access]")?.dataset.access;
    if (!accessMode) return;
    state.draftAccessMode = accessMode;
    updateModelControls();
  });
  $("#saveSettings").addEventListener("click", () => {
    state.model = state.draftModel || state.model;
    state.reasoning = state.draftReasoning || state.reasoning;
    state.accessMode = state.draftAccessMode || state.accessMode;
    localStorage.setItem("wit_model", state.model);
    localStorage.setItem("wit_reasoning", state.reasoning);
    localStorage.setItem("wit_access", state.accessMode);
    updateModelControls();
    if (state.activeId) {
      if (state.supports21) {
        bridge()?.updateConversationSettings?.(
          state.activeId, state.model, state.reasoning, state.accessMode);
      } else {
        bridge()?.updateConversationSettings?.(state.activeId, state.model, state.reasoning);
      }
    } else {
      closeSettings();
      toast(`新对话将使用 ${modelNames[state.model]} · ${reasoningNames[state.reasoning]}`);
    }
  });
  $("#forkConversationButton").addEventListener("click", () => {
    if (state.activeId) bridge()?.forkConversation?.(state.activeId);
  });
  $("#compactConversationButton").addEventListener("click", () => {
    if (state.activeId) bridge()?.compactConversation?.(state.activeId);
  });
  $("#reviewConversationButton").addEventListener("click", () => {
    if (state.activeId) bridge()?.reviewConversation?.(state.activeId);
  });

  updateModelControls();
  renderDeliveries();
  document.addEventListener("visibilitychange", () => setAppVisible(!document.hidden));
  // Native calls nativeReady with version and cache scope after the main frame is loaded.
})();
