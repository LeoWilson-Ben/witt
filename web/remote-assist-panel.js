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

  function statusLabel(s) {
    if (s.state === "active" && s.connected) return "已连接 · 在线";
    if (s.state === "active") return "已授权 · 等待重连";
    if (s.state === "pending") return "等待客户终端输入协助码";
    if (s.state === "paused") return "已暂停";
    if (s.state === "revoked") return "已撤销";
    if (s.state === "expired") return "已过期";
    return s.state || "未知";
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
      <div class="feature-card" id="remoteAssistPairingCard" style="border:1px solid rgba(26,115,232,.25);border-radius:12px;padding:12px;margin:10px 0;background:rgba(26,115,232,.04);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <strong>协助码：${escapeHtml(session.pairing_code)}</strong>
          <small>有效至 ${escapeHtml(new Date(session.expires_at).toLocaleTimeString())}</small>
        </div>
        <p class="feature-note" style="margin:4px 0;">1. 首次使用在客户 Windows 终端安装 Chloe CLI（已装可跳过）：</p>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
          <code style="flex:1;overflow-x:auto;padding:6px 8px;border-radius:8px;background:rgba(0,0,0,.06);font-size:12px;">${escapeHtml(installCmd)}</code>
          <button type="button" data-ra-copy="${escapeHtml(installCmd)}">复制</button>
        </div>
        <p class="feature-note" style="margin:4px 0;">2. 终端输入 <code>chloe</code> 后填协助码，或直接运行：</p>
        <div style="display:flex;gap:8px;align-items:center;">
          <code style="flex:1;overflow-x:auto;padding:6px 8px;border-radius:8px;background:rgba(0,0,0,.06);font-size:12px;">${escapeHtml(runCmd)}</code>
          <button type="button" data-ra-copy="${escapeHtml(runCmd)}">复制</button>
        </div>
      </div>`;
  }

  function sessionCard(s) {
    const modeText = s.access_mode === "full" ? "完整执行模式" : "单目录安全模式";
    const canBind = s.state === "active" && s.connected;
    const canRevoke = ["pending", "active", "paused"].includes(s.state);
    return `
      <article class="windows-node-card" style="border:1px solid rgba(0,0,0,.08);border-radius:12px;padding:12px;margin-top:8px;">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <strong>${escapeHtml(s.customer_label || "临时协助")}</strong>
          <small>${escapeHtml(statusLabel(s))}</small>
        </div>
        <div style="font-size:12px;opacity:.75;margin:4px 0 8px;">
          模式：${escapeHtml(modeText)} · 至 ${escapeHtml(new Date(s.expires_at).toLocaleTimeString())}
          ${s.workspace_root ? ` · 目录：${escapeHtml(s.workspace_root)}` : ""}
        </div>
        <div class="feature-toolbar" style="display:flex;flex-wrap:wrap;gap:8px;">
          ${canBind ? `<button type="button" data-ra-bind="${escapeHtml(s.assist_session_id)}">${s.conversation_id ? "打开协助对话" : "进入协助对话"}</button>` : ""}
          <button type="button" data-ra-audit="${escapeHtml(s.assist_session_id)}">查看审计</button>
          ${canRevoke ? `<button type="button" data-ra-revoke="${escapeHtml(s.assist_session_id)}">撤销</button>` : ""}
        </div>
        <div id="ra-audit-${escapeHtml(s.assist_session_id)}" style="margin-top:8px;"></div>
      </article>`;
  }

  function shell(html) {
    $("featureTitle").textContent = "远程协助 CLI";
    $("featureContent").innerHTML = html;
  }

  async function render() {
    const data = await request("remote-assist/sessions");
    const sessions = (data.sessions || []).slice().sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    const modeSelect = $("raAccessMode")?.value || "full";
    const ttlSelect = $("raTtl")?.value || "30";
    const labelInput = $("raLabel")?.value || "";
    shell(`
      <div class="windows-node-section">
        <p class="feature-note">生成一次性协助码。客户在 Windows 终端安装一次后，输入 <code>chloe</code> 并填协助码即可接入，无需配置 AI 模型或密钥。</p>
        <div style="display:grid;gap:8px;margin-bottom:10px;">
          <input id="raLabel" maxlength="48" placeholder="备注名称，例如：客户电脑 / 测试机" value="${escapeHtml(labelInput)}">
          <div style="display:flex;gap:8px;flex-wrap:wrap;">
            <select id="raTtl" aria-label="有效期">
              <option value="15"${ttlSelect === "15" ? " selected" : ""}>有效期：15 分钟</option>
              <option value="30"${ttlSelect === "30" ? " selected" : ""}>有效期：30 分钟</option>
              <option value="60"${ttlSelect === "60" ? " selected" : ""}>有效期：60 分钟</option>
            </select>
            <select id="raAccessMode" aria-label="授权模式">
              <option value="full"${modeSelect === "full" ? " selected" : ""}>完整执行模式（推荐，免逐条审批）</option>
              <option value="workspace"${modeSelect === "workspace" ? " selected" : ""}>单目录安全模式（逐条确认修改/命令）</option>
            </select>
          </div>
          <div id="raWorkspaceOptions" style="display:${modeSelect === "workspace" ? "flex" : "none"};gap:12px;font-size:13px;">
            <label><input type="checkbox" id="raAllowEdits" checked> 允许修改文件</label>
            <label><input type="checkbox" id="raAllowCommands" checked> 允许执行命令</label>
          </div>
          <button type="button" id="raCreateBtn">生成协助码</button>
        </div>
        ${pairingBlock(lastCreatedSession)}
        <div id="raSessionList">
          ${sessions.length ? sessions.map(sessionCard).join("") : "<p class=\"feature-note\">暂无远程协助会话。</p>"}
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
        container.innerHTML = sessions.length ? sessions.map(sessionCard).join("") : '<p class="feature-note">暂无远程协助会话。</p>';
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
    shell('<p class="feature-note">读取远程协助会话中…</p>');
    try {
      await render();
      stopPolling();
      pollTimer = setInterval(refreshListOnly, 3000);
    } catch (error) {
      shell(`<p>${escapeHtml(error.message)}</p>`);
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
          ttl_minutes: Number($("raTtl")?.value || 30),
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
      try {
        const data = await request(`remote-assist/sessions/${id}/audit`);
        const rows = (data.audit || []).slice(0, 15);
        target.innerHTML = rows.length
          ? `<pre style="max-height:180px;overflow:auto;font-size:11px;padding:8px;border-radius:8px;background:rgba(0,0,0,.04);">${escapeHtml(rows.map((r) => `${r.at} | ${r.operation} | ${r.status}${r.path ? ` | ${r.path}` : ""}`).join("\n"))}</pre>`
          : '<small class="feature-note">暂无审计记录</small>';
      } catch (error) {
        target.textContent = error.message || "读取审计失败";
      }
    }
  });
})();
