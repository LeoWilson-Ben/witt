(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => {
    const node = document.createElement("span");
    node.textContent = String(value ?? "");
    return node.innerHTML;
  };
  async function request(path, method = "GET", body) {
    if (!window.WittFeatures?.request) throw new Error("页面尚未就绪，请重开 Witt");
    return window.WittFeatures.request(path, method, body || {});
  }

  let pollTimer = null;
  let bannerTimer = null;
  let lastCreatedSession = null;
  let cachedSessions = [];
  let lastSyncedConvId = "";

  function ensureStyles() {
    if ($("remoteAssistPanelStyles")) return;
    const style = document.createElement("style");
    style.id = "remoteAssistPanelStyles";
    style.textContent = `
      #featureSheet #featureClose {
        padding: 0 !important;
        line-height: 1 !important;
        display: grid !important;
        place-items: center !important;
      }
      #remoteSpaceBanner {
        position: relative;
        z-index: 25;
        margin: 0 auto 8px;
        width: min(760px, calc(100% - 24px));
        padding: 8px 12px;
        border-radius: 12px;
        border: 1px solid color-mix(in srgb, var(--sd-accent, #5b4ee9) 28%, transparent);
        background: color-mix(in srgb, var(--sd-accent, #5b4ee9) 7%, var(--surface, #fff));
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        flex-wrap: wrap;
        box-sizing: border-box;
        font-size: 12px;
      }
      #remoteSpaceBanner[hidden] {
        display: none !important;
      }
      :root[data-theme="dark"] #remoteSpaceBanner {
        background: color-mix(in srgb, var(--sd-accent, #a78bfa) 10%, rgba(28, 28, 34, .92));
      }
      .ra-banner-info {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
        min-width: 0;
        flex: 1;
      }
      .ra-banner-title {
        font-weight: 650;
        color: var(--ink, #171717);
      }
      .ra-banner-path {
        color: var(--muted, #64748b);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 280px;
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
        font-size: 11px;
      }
      .ra-banner-actions {
        display: flex;
        align-items: center;
        gap: 6px;
        flex: none;
      }
      .ra-banner-actions button {
        height: 28px;
        padding: 0 10px;
        border-radius: 8px;
        font-size: 12px;
        font-weight: 550;
        cursor: pointer;
        border: 1px solid rgba(127, 127, 127, .24);
        background: rgba(255, 255, 255, .6);
        color: inherit;
      }
      :root[data-theme="dark"] .ra-banner-actions button {
        background: rgba(255, 255, 255, .08);
      }
      .ra-banner-actions button.is-danger {
        background: rgba(220, 38, 38, .1);
        border-color: rgba(220, 38, 38, .3);
        color: #dc2626;
      }
      :root[data-theme="dark"] .ra-banner-actions button.is-danger {
        color: #f87171;
      }
      #featureContent .ra-root {
        display: grid;
        gap: 14px;
      }
      #featureContent .ra-root .ra-lead {
        margin: 0;
        font-size: 13px;
        line-height: 1.6;
        color: var(--sg-muted, var(--sd-muted, #64748b));
      }
      #featureContent .ra-root .ra-lead code,
      #featureContent .ra-root .ra-step-label code {
        padding: 1px 6px;
        border-radius: 6px;
        background: rgba(127, 127, 127, .12);
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
        font-size: 12px;
      }
      #featureContent .ra-root .ra-card {
        border: 1px solid var(--sg-line, var(--sd-line, rgba(15, 23, 42, .1)));
        border-radius: 14px;
        padding: 14px;
        background: var(--sg-card, var(--sd-canvas, rgba(255, 255, 255, .72)));
      }
      #featureContent .ra-root .ra-form-card {
        display: grid;
        gap: 10px;
      }
      #featureContent .ra-root .ra-form-card :is(input:not([type="checkbox"]), select) {
        margin-top: 0 !important;
        min-height: 40px;
      }
      #featureContent .ra-root .ra-checkbox-row {
        display: flex;
        flex-wrap: wrap;
        gap: 14px;
        padding: 2px 2px 4px;
      }
      #featureContent .ra-root .ra-checkbox-label {
        display: inline-flex !important;
        align-items: center;
        gap: 6px;
        margin: 0 !important;
        font-size: 13px !important;
        font-weight: 500 !important;
        cursor: pointer;
      }
      #featureContent .ra-root .ra-checkbox-label input[type="checkbox"] {
        display: inline-block !important;
        width: 16px !important;
        height: 16px !important;
        min-height: 0 !important;
        margin: 0 !important;
        padding: 0 !important;
        accent-color: var(--sd-accent, #5b4ee9);
      }
      #featureContent .ra-root button {
        width: auto !important;
        min-height: 0 !important;
        flex: none !important;
        white-space: nowrap;
        font-weight: 550;
      }
      #featureContent .ra-root .ra-btn-primary {
        background: var(--sd-accent, #5b4ee9) !important;
        border: 1px solid var(--sd-accent, #5b4ee9) !important;
        color: #fff !important;
        height: 34px;
        padding: 0 14px !important;
        border-radius: 10px !important;
        font-size: 13px !important;
      }
      #featureContent .ra-root .ra-btn-primary:hover:not(:disabled) {
        background: var(--sd-accent, #5b4ee9) !important;
        filter: brightness(.95);
      }
      :root[data-theme="dark"] #featureContent .ra-root .ra-btn-primary {
        color: #21132f !important;
      }
      #featureContent .ra-root .ra-btn-block {
        width: 100% !important;
        height: 42px;
        border-radius: 12px !important;
        font-size: 14px !important;
        font-weight: 600;
      }
      #featureContent .ra-root .ra-btn-secondary {
        background: var(--sg-soft, rgba(127, 127, 127, .08)) !important;
        border: 1px solid var(--sg-line, var(--sd-line, rgba(15, 23, 42, .12))) !important;
        color: var(--sg-ink, var(--sd-ink, inherit)) !important;
        height: 32px;
        padding: 0 12px !important;
        border-radius: 8px !important;
        font-size: 12px !important;
      }
      #featureContent .ra-root .ra-btn-sm {
        height: 32px;
        padding: 0 12px !important;
        border-radius: 8px !important;
        font-size: 12px !important;
      }
      #featureContent .ra-root .ra-btn-danger {
        background: rgba(220, 38, 38, .08) !important;
        border: 1px solid rgba(220, 38, 38, .28) !important;
        color: #dc2626 !important;
        height: 32px;
        padding: 0 12px !important;
        border-radius: 8px !important;
        font-size: 12px !important;
      }
      #featureContent .ra-root .ra-btn-danger:hover:not(:disabled) {
        background: rgba(220, 38, 38, .14) !important;
      }
      :root[data-theme="dark"] #featureContent .ra-root .ra-btn-danger {
        color: #f87171 !important;
        border-color: rgba(248, 113, 113, .35) !important;
      }
      #featureContent .ra-root .ra-pairing-card {
        border: 1px solid color-mix(in srgb, var(--sd-accent, #5b4ee9) 35%, transparent);
        background: color-mix(in srgb, var(--sd-accent, #5b4ee9) 6%, var(--sg-card, var(--sd-canvas, #fff)));
        display: grid;
        gap: 10px;
      }
      #featureContent .ra-root .ra-pairing-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 10px;
        flex-wrap: wrap;
      }
      #featureContent .ra-root .ra-pairing-title {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      #featureContent .ra-root .ra-pairing-label {
        font-size: 12px;
        color: var(--sg-muted, var(--sd-muted, #64748b));
        font-weight: 600;
      }
      #featureContent .ra-root .ra-code-badge {
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
        font-size: 18px;
        font-weight: 700;
        letter-spacing: 0.06em;
        color: var(--sd-accent, #4f46e5);
      }
      #featureContent .ra-root .ra-step-block {
        display: grid;
        gap: 6px;
      }
      #featureContent .ra-root .ra-step-label {
        margin: 0;
        font-size: 12px;
        line-height: 1.45;
        color: var(--sg-muted, var(--sd-muted, #64748b));
      }
      #featureContent .ra-root .ra-cmd-row {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }
      #featureContent .ra-root .ra-cmd-code {
        flex: 1;
        min-width: 0;
        overflow-x: auto;
        white-space: nowrap;
        padding: 7px 10px;
        border-radius: 8px;
        border: 1px solid var(--sg-line, var(--sd-line, rgba(15, 23, 42, .08)));
        background: rgba(15, 23, 42, .05);
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
        font-size: 12px;
        line-height: 1.4;
        scrollbar-width: thin;
      }
      :root[data-theme="dark"] #featureContent .ra-root .ra-cmd-code {
        background: rgba(255, 255, 255, .07);
      }
      #featureContent .ra-root .ra-section-title {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 12px;
        font-weight: 600;
        color: var(--sg-muted, var(--sd-muted, #64748b));
        margin: 2px 2px -4px;
      }
      #featureContent .ra-root .ra-session-list {
        display: grid;
        gap: 10px;
      }
      #featureContent .ra-root .ra-session-card {
        display: grid;
        gap: 8px;
      }
      #featureContent .ra-root .ra-session-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
      }
      #featureContent .ra-root .ra-session-name {
        font-size: 14px;
        font-weight: 650;
        overflow-wrap: anywhere;
      }
      .ra-badge {
        display: inline-flex;
        align-items: center;
        padding: 2px 9px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 600;
        white-space: nowrap;
      }
      .ra-badge.is-online {
        color: #15803d;
        background: rgba(22, 163, 74, .12);
      }
      .ra-badge.is-wait {
        color: #1d4ed8;
        background: rgba(37, 99, 235, .12);
      }
      .ra-badge.is-idle {
        color: var(--sg-muted, var(--sd-muted, #64748b));
        background: rgba(127, 127, 127, .12);
      }
      :root[data-theme="dark"] .ra-badge.is-online {
        color: #4ade80;
        background: rgba(74, 222, 128, .15);
      }
      :root[data-theme="dark"] .ra-badge.is-wait {
        color: #60a5fa;
        background: rgba(96, 165, 250, .16);
      }
      #featureContent .ra-root .ra-session-meta {
        font-size: 12px;
        line-height: 1.5;
        color: var(--sg-muted, var(--sd-muted, #64748b));
        overflow-wrap: anywhere;
      }
      #featureContent .ra-root .ra-actions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        padding-top: 2px;
      }
      #featureContent .ra-root .ra-audit-box:empty {
        display: none;
      }
      #featureContent .ra-root .ra-audit-pre {
        margin: 4px 0 0;
        max-height: 180px;
        overflow: auto;
        font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
        font-size: 11px;
        line-height: 1.5;
        padding: 10px;
        border-radius: 10px;
        border: 1px solid var(--sg-line, var(--sd-line, rgba(15, 23, 42, .08)));
        background: rgba(15, 23, 42, .04);
      }
      :root[data-theme="dark"] #featureContent .ra-root .ra-audit-pre {
        background: rgba(255, 255, 255, .06);
      }
    `;
    document.head.appendChild(style);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function installCommand() {
    const base = `${window.location.origin}/vault/cli/install.ps1`;
    return `irm ${base} | iex`;
  }

  function connectCommand(code) {
    return `chloe ${code}`;
  }

  function statusInfo(s) {
    if (s.state === "active" && s.connected) return { text: "已连接 · 在线", tone: "is-online" };
    if (s.state === "active") return { text: "已授权 · 等待重连", tone: "is-wait" };
    if (s.state === "pending") return { text: "等待客户输入协助码", tone: "is-wait" };
    if (s.state === "paused") return { text: "已暂停", tone: "is-idle" };
    if (s.state === "revoked") return { text: "已结束 · 空间已清理", tone: "is-idle" };
    if (s.state === "expired") return { text: "已失效 · 空间已清理", tone: "is-idle" };
    return { text: s.state || "未知", tone: "is-idle" };
  }

  function currentConversationId() {
    const activeRow = document.querySelector(".conversation-row.active");
    if (activeRow?.dataset?.id) return activeRow.dataset.id;
    const welcome = $("welcome");
    if (welcome && !welcome.hidden) return "";
    return localStorage.getItem("wit_active_conversation") || "";
  }

  function currentConversationMeta(convId) {
    if (!convId || !window.WittUI?.conversations) return null;
    return window.WittUI.conversations().find((item) => item.id === convId) || null;
  }

  function renderSpaceBanner(session, fallbackMeta) {
    const banner = $("remoteSpaceBanner");
    if (!banner) return;
    if (!session && !fallbackMeta?.remoteWorkspace) {
      banner.hidden = true;
      banner.innerHTML = "";
      return;
    }
    ensureStyles();
    const state = session?.state || fallbackMeta?.remoteWorkspace?.state || "revoked";
    const connected = session ? Boolean(session.connected) : false;
    const label = session?.customer_label || fallbackMeta?.title?.replace(/^协助空间\s*·\s*/, "") || "临时协助";
    const pathText = session?.workspace_root || fallbackMeta?.remoteWorkspace?.displayPath || "";
    const status = session
      ? statusInfo(session)
      : (state === "active"
        ? { text: "独立临时空间运行中", tone: "is-wait" }
        : { text: "已结束 · 服务器临时文件已清理", tone: "is-idle" });
    const canEnd = session && ["pending", "active", "paused"].includes(session.state);
    banner.innerHTML = `
      <div class="ra-banner-info">
        <span class="ra-banner-title">独立临时协作空间 · ${escapeHtml(label)}</span>
        <span class="ra-badge ${status.tone}">${escapeHtml(status.text)}</span>
        ${pathText ? `<span class="ra-banner-path" title="${escapeHtml(pathText)}">${escapeHtml(pathText)}</span>` : ""}
      </div>
      <div class="ra-banner-actions">
        ${canEnd ? `<button type="button" class="is-danger" data-ra-banner-end="${escapeHtml(session.assist_session_id)}">结束并清理空间</button>` : ""}
        <button type="button" id="raBannerPanelBtn">协助面板</button>
      </div>`;
    banner.hidden = false;
  }

  async function syncSpaceBanner(forceFetch = false) {
    const convId = currentConversationId();
    if (!convId) {
      lastSyncedConvId = "";
      renderSpaceBanner(null, null);
      return;
    }
    const meta = currentConversationMeta(convId);
    let matched = cachedSessions.find((s) => s.conversation_id === convId) || null;
    const isRemoteConv = Boolean(matched || meta?.remoteWorkspace || meta?.title?.startsWith("协助空间 · "));
    if (!isRemoteConv) {
      renderSpaceBanner(null, null);
      return;
    }
    if (forceFetch || convId !== lastSyncedConvId || !matched || ["pending", "active", "paused"].includes(matched.state)) {
      lastSyncedConvId = convId;
      try {
        const data = await request("remote-assist/sessions");
        cachedSessions = (data.sessions || []).slice().sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
        matched = cachedSessions.find((s) => s.conversation_id === convId) || null;
      } catch {}
    }
    if (currentConversationId() !== convId) return;
    renderSpaceBanner(matched, meta);
  }

  function startBannerMonitor() {
    if (bannerTimer) return;
    const originalSelect = window.WittUI?.select;
    if (typeof originalSelect === "function" && !originalSelect.__raWrapped) {
      const wrapped = function (...args) {
        const res = originalSelect.apply(this, args);
        setTimeout(() => { syncSpaceBanner(true); }, 60);
        return res;
      };
      wrapped.__raWrapped = true;
      window.WittUI.select = wrapped;
    }
    const listNode = $("conversationList");
    if (listNode && window.MutationObserver) {
      const observer = new MutationObserver(() => {
        syncSpaceBanner(false);
      });
      observer.observe(listNode, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    }
    bannerTimer = setInterval(() => {
      syncSpaceBanner(false);
    }, 4000);
    setTimeout(() => syncSpaceBanner(true), 400);
  }

  function copyText(text, btn) {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        if (btn) {
          const old = btn.textContent;
          btn.textContent = "已复制";
          setTimeout(() => { btn.textContent = old; }, 1500);
        }
        window.WittUI?.toast?.("已复制到剪贴板");
      }).catch(() => window.WittUI?.toast?.("复制失败，请手动复制"));
    }
  }

  function pairingBlock(session) {
    if (!session?.pairing_code) return "";
    const installCmd = installCommand();
    const runCmd = connectCommand(session.pairing_code);
    return `
      <div class="ra-card ra-pairing-card" id="remoteAssistPairingCard">
        <div class="ra-pairing-head">
          <div class="ra-pairing-title">
            <span class="ra-pairing-label">协助码</span>
            <span class="ra-code-badge">${escapeHtml(session.pairing_code)}</span>
          </div>
          <button type="button" class="ra-btn-secondary ra-btn-sm" data-ra-copy="${escapeHtml(session.pairing_code)}">复制协助码</button>
        </div>
        <div class="ra-step-block">
          <p class="ra-step-label">1. 首次使用在客户 Windows 终端安装 Chloe CLI（已装可跳过）：</p>
          <div class="ra-cmd-row">
            <code class="ra-cmd-code">${escapeHtml(installCmd)}</code>
            <button type="button" class="ra-btn-secondary ra-btn-sm" data-ra-copy="${escapeHtml(installCmd)}">复制</button>
          </div>
        </div>
        <div class="ra-step-block">
          <p class="ra-step-label">2. 终端输入 <code>chloe</code> 后填协助码，或直接运行：</p>
          <div class="ra-cmd-row">
            <code class="ra-cmd-code">${escapeHtml(runCmd)}</code>
            <button type="button" class="ra-btn-secondary ra-btn-sm" data-ra-copy="${escapeHtml(runCmd)}">复制</button>
          </div>
        </div>
      </div>`;
  }

  function sessionCard(s) {
    const modeText = s.access_mode === "full" ? "完整执行模式" : "单目录安全模式";
    const status = statusInfo(s);
    const canBind = s.state === "active" && s.connected;
    const canRevoke = ["pending", "active", "paused"].includes(s.state);
    return `
      <article class="ra-card ra-session-card">
        <div class="ra-session-head">
          <strong class="ra-session-name">${escapeHtml(s.customer_label || "临时协助")}</strong>
          <span class="ra-badge ${status.tone}">${escapeHtml(status.text)}</span>
        </div>
        <div class="ra-session-meta">
          模式：${escapeHtml(modeText)}${s.workspace_root ? ` · 目录：${escapeHtml(s.workspace_root)}` : ""}${s.space_cleaned ? " · 服务器临时空间文件已清理" : ""}
        </div>
        <div class="ra-actions">
          ${canBind ? `<button type="button" class="ra-btn-primary ra-btn-sm" data-ra-bind="${escapeHtml(s.assist_session_id)}">${s.conversation_id ? "打开协作空间" : "进入独立协作空间"}</button>` : ""}
          <button type="button" class="ra-btn-secondary ra-btn-sm" data-ra-audit="${escapeHtml(s.assist_session_id)}">查看审计</button>
          ${canRevoke ? `<button type="button" class="ra-btn-danger ra-btn-sm" data-ra-revoke="${escapeHtml(s.assist_session_id)}">结束并清理</button>` : ""}
        </div>
        <div class="ra-audit-box" id="ra-audit-${escapeHtml(s.assist_session_id)}"></div>
      </article>`;
  }

  function shell(html) {
    ensureStyles();
    $("featureTitle").textContent = "远程协助 CLI";
    $("featureContent").innerHTML = html;
  }

  async function render() {
    const data = await request("remote-assist/sessions");
    const sessions = (data.sessions || []).slice().sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    cachedSessions = sessions;
    const modeSelect = $("raAccessMode")?.value || "full";
    const labelInput = $("raLabel")?.value || "";
    shell(`
      <div class="ra-root">
        <p class="ra-lead">生成一次性协助码并分配独立临时协作空间。任务结束或撤销后，服务器侧临时空间文件将自动彻底删除，确保服务器干净。</p>
        <div class="ra-card ra-form-card">
          <input id="raLabel" maxlength="48" placeholder="备注名称，例如：客户电脑 / 测试机" value="${escapeHtml(labelInput)}">
          <select id="raAccessMode" aria-label="授权模式">
            <option value="full"${modeSelect === "full" ? " selected" : ""}>完整执行模式（推荐，免逐条审批）</option>
            <option value="workspace"${modeSelect === "workspace" ? " selected" : ""}>单目录安全模式（逐条确认修改/命令）</option>
          </select>
          <div id="raWorkspaceOptions" class="ra-checkbox-row" style="display:${modeSelect === "workspace" ? "flex" : "none"};">
            <label class="ra-checkbox-label"><input type="checkbox" id="raAllowEdits" checked> 允许修改文件</label>
            <label class="ra-checkbox-label"><input type="checkbox" id="raAllowCommands" checked> 允许执行命令</label>
          </div>
          <button type="button" class="ra-btn-primary ra-btn-block" id="raCreateBtn">生成协助码</button>
        </div>
        ${pairingBlock(lastCreatedSession)}
        <div class="ra-section-title">
          <span>协助会话</span>
          <span>${sessions.length} 条记录</span>
        </div>
        <div id="raSessionList" class="ra-session-list">
          ${sessions.length ? sessions.map(sessionCard).join("") : '<p class="ra-lead">暂无远程协助会话。</p>'}
        </div>
      </div>
    `);
  }

  async function refreshListOnly() {
    if ($("featureSheet")?.hidden || !$("raSessionList")) {
      stopPolling();
      return;
    }
    try {
      const data = await request("remote-assist/sessions");
      const sessions = (data.sessions || []).slice().sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
      cachedSessions = sessions;
      const container = $("raSessionList");
      if (container) {
        container.innerHTML = sessions.length ? sessions.map(sessionCard).join("") : '<p class="ra-lead">暂无远程协助会话。</p>';
      }
      if (lastCreatedSession && sessions.some((s) => s.assist_session_id === lastCreatedSession.assist_session_id && s.state !== "pending")) {
        lastCreatedSession = null;
        const card = $("remoteAssistPairingCard");
        if (card) card.remove();
      }
      syncSpaceBanner(false);
    } catch {}
  }

  async function openPanel() {
    lastCreatedSession = null;
    shell('<div class="ra-root"><p class="ra-lead">读取远程协助会话中…</p></div>');
    try {
      await render();
      stopPolling();
      pollTimer = setInterval(refreshListOnly, 3000);
    } catch (error) {
      shell(`<div class="ra-root"><p class="ra-lead">${escapeHtml(error.message)}</p></div>`);
    }
  }

  $("remoteAssistEntry")?.addEventListener("click", () => {
    $("closeDrawerAccount")?.click();
    $("featureSheet").hidden = false;
    openPanel();
  });

  $("remoteSpaceBanner")?.addEventListener("click", async (event) => {
    if (event.target.closest("#raBannerPanelBtn")) {
      $("featureSheet").hidden = false;
      openPanel();
      return;
    }
    const endBtn = event.target.closest("[data-ra-banner-end]");
    if (endBtn) {
      const id = endBtn.dataset.raBannerEnd;
      try {
        endBtn.disabled = true;
        await request(`remote-assist/sessions/${id}/revoke`, "POST", {});
        window.WittUI?.toast?.("协助已结束，服务器临时空间文件已全部删除");
        await syncSpaceBanner(true);
      } catch (error) {
        window.WittUI?.toast?.(error.message || "清理空间失败");
      } finally {
        if (endBtn.isConnected) endBtn.disabled = false;
      }
    }
  });

  $("featureContent")?.addEventListener("change", (event) => {
    if (event.target.id === "raAccessMode") {
      const box = $("raWorkspaceOptions");
      if (box) box.style.display = event.target.value === "workspace" ? "flex" : "none";
    }
  });

  $("featureContent")?.addEventListener("click", async (event) => {
    const copyBtn = event.target.closest("[data-ra-copy]");
    if (copyBtn) {
      copyText(copyBtn.dataset.raCopy, copyBtn);
      return;
    }

    if (event.target.closest("#raCreateBtn")) {
      const btn = $("raCreateBtn");
      try {
        if (btn) btn.disabled = true;
        const accessMode = $("raAccessMode")?.value || "full";
        const body = {
          customer_label: $("raLabel")?.value?.trim() || "临时协助",
          access_mode: accessMode,
        };
        if (accessMode === "workspace") {
          body.allow_edits = Boolean($("raAllowEdits")?.checked);
          body.allow_commands = Boolean($("raAllowCommands")?.checked);
          body.allow_environment = true;
        }
        lastCreatedSession = await request("remote-assist/sessions", "POST", body);
        await render();
      } catch (error) {
        window.WittUI?.toast?.(error.message || "生成失败");
      } finally {
        if (btn && btn.isConnected) btn.disabled = false;
      }
      return;
    }

    const bindBtn = event.target.closest("[data-ra-bind]");
    if (bindBtn) {
      const id = bindBtn.dataset.raBind;
      try {
        bindBtn.disabled = true;
        const uiSettings = window.WittUI?.settings?.() || {};
        const data = await request(`remote-assist/sessions/${id}/workspace`, "POST", {
          model: uiSettings.model,
          reasoning: uiSettings.reasoning,
          codexProfile: uiSettings.codexProfile,
        });
        stopPolling();
        if (data.conversation) {
          window.DropVault?.onConversationCreated?.(JSON.stringify({ conversation: data.conversation }));
          window.WittFeatures?.openConversation?.(data.conversation.id);
          setTimeout(() => syncSpaceBanner(true), 150);
        }
      } catch (error) {
        window.WittUI?.toast?.(error.message || "进入独立协作空间失败");
      } finally {
        if (bindBtn.isConnected) bindBtn.disabled = false;
      }
      return;
    }

    const revokeBtn = event.target.closest("[data-ra-revoke]");
    if (revokeBtn) {
      const id = revokeBtn.dataset.raRevoke;
      try {
        revokeBtn.disabled = true;
        await request(`remote-assist/sessions/${id}/revoke`, "POST", {});
        window.WittUI?.toast?.("协助已结束，服务器临时空间已清理");
        await refreshListOnly();
      } catch (error) {
        window.WittUI?.toast?.(error.message || "结束并清理失败");
      } finally {
        if (revokeBtn.isConnected) revokeBtn.disabled = false;
      }
      return;
    }

    const auditBtn = event.target.closest("[data-ra-audit]");
    if (auditBtn) {
      const id = auditBtn.dataset.raAudit;
      const target = $("ra-audit-" + id);
      if (!target) return;
      if (target.innerHTML.trim()) {
        target.innerHTML = "";
        return;
      }
      try {
        const data = await request(`remote-assist/sessions/${id}/audit`);
        const rows = (data.audit || []).slice(0, 15);
        target.innerHTML = rows.length
          ? `<pre class="ra-audit-pre">${escapeHtml(rows.map((r) => `${r.at} | ${r.operation} | ${r.status}${r.path ? ` | ${r.path}` : ""}`).join("\n"))}</pre>`
          : '<small class="ra-lead">暂无审计记录</small>';
      } catch (error) {
        target.textContent = error.message || "读取审计失败";
      }
    }
  });

  startBannerMonitor();
})();
