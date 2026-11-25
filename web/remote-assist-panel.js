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
  let lastCreatedSession = null;

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
      #featureContent .ra-root .ra-badge {
        display: inline-flex;
        align-items: center;
        padding: 2px 9px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 600;
        white-space: nowrap;
      }
      #featureContent .ra-root .ra-badge.is-online {
        color: #15803d;
        background: rgba(22, 163, 74, .12);
      }
      #featureContent .ra-root .ra-badge.is-wait {
        color: #1d4ed8;
        background: rgba(37, 99, 235, .12);
      }
      #featureContent .ra-root .ra-badge.is-idle {
        color: var(--sg-muted, var(--sd-muted, #64748b));
        background: rgba(127, 127, 127, .12);
      }
      :root[data-theme="dark"] #featureContent .ra-root .ra-badge.is-online {
        color: #4ade80;
        background: rgba(74, 222, 128, .15);
      }
      :root[data-theme="dark"] #featureContent .ra-root .ra-badge.is-wait {
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
    if (s.state === "revoked") return { text: "已撤销", tone: "is-idle" };
    if (s.state === "expired") return { text: "已失效", tone: "is-idle" };
    return { text: s.state || "未知", tone: "is-idle" };
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
          模式：${escapeHtml(modeText)}${s.workspace_root ? ` · 目录：${escapeHtml(s.workspace_root)}` : ""}
        </div>
        <div class="ra-actions">
          ${canBind ? `<button type="button" class="ra-btn-primary ra-btn-sm" data-ra-bind="${escapeHtml(s.assist_session_id)}">${s.conversation_id ? "打开协助对话" : "进入协助对话"}</button>` : ""}
          <button type="button" class="ra-btn-secondary ra-btn-sm" data-ra-audit="${escapeHtml(s.assist_session_id)}">查看审计</button>
          ${canRevoke ? `<button type="button" class="ra-btn-danger ra-btn-sm" data-ra-revoke="${escapeHtml(s.assist_session_id)}">撤销</button>` : ""}
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
    const modeSelect = $("raAccessMode")?.value || "full";
    const labelInput = $("raLabel")?.value || "";
    shell(`
      <div class="ra-root">
        <p class="ra-lead">生成一次性协助码。客户在 Windows 终端安装一次后，输入 <code>chloe</code> 并填协助码即可接入，无需配置 AI 模型或密钥。</p>
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
      const container = $("raSessionList");
      if (container) {
        container.innerHTML = sessions.length ? sessions.map(sessionCard).join("") : '<p class="ra-lead">暂无远程协助会话。</p>';
      }
      if (lastCreatedSession && sessions.some((s) => s.assist_session_id === lastCreatedSession.assist_session_id && s.state !== "pending")) {
        lastCreatedSession = null;
        const card = $("remoteAssistPairingCard");
        if (card) card.remove();
      }
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
        }
      } catch (error) {
        window.WittUI?.toast?.(error.message || "进入协助对话失败");
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
        await refreshListOnly();
      } catch (error) {
        window.WittUI?.toast?.(error.message || "撤销失败");
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
})();
