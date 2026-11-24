(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => { const node = document.createElement("span"); node.textContent = String(value ?? ""); return node.innerHTML; };
  async function request(path, method = "GET", body) {
    if (!window.WittFeatures?.request) throw new Error("页面尚未就绪，请重开 Witt");
    return window.WittFeatures.request(path, method, body || {});
  }
  const shell = (html) => { $("featureTitle").textContent = "Windows 工作节点"; $("featureContent").innerHTML = html; $("featurePanel").scrollTop = 0; };
  function pairingCard(pairingToken, expiresAt) {
    if (!pairingToken) return "";
    return `<pre id="windowsNodePairing">一次性配对密钥（有效至 ${escapeHtml(new Date(expiresAt).toLocaleTimeString())}）：\n${escapeHtml(pairingToken)}\n\n在 Windows 管理员 PowerShell 中运行：\npowershell -ExecutionPolicy Bypass -File .\\witt-windows-node.ps1 -Pair\n\n按脚本提示粘贴此密钥。密钥不会再次显示。</pre>`;
  }
  function nodeCard(node) { return `<article class="windows-node-card"><strong>${escapeHtml(node.label)}</strong><small>${node.lastSeenAt ? "最近连接：" + escapeHtml(node.lastSeenAt) : "尚未连接"}</small><select id="windows-provider-${node.id}"><option value="codex">GPT / Codex（Windows）</option><option value="antigravity">Antigravity（Windows）</option><option value="stellarbit">Stellarbit（Windows 直连）</option></select><input id="windows-model-${node.id}" placeholder="可选模型名称"><textarea id="windows-prompt-${node.id}" maxlength="65536" placeholder="发送给此 Windows 本机 AI 的任务"></textarea><button type="button" data-windows-run="${node.id}">在 Windows 执行</button><div id="windows-output-${node.id}"></div></article>`; }
  async function render(pairing) {
    const data = await request("windows-nodes");
    shell(`<div class="windows-node-section"><p class="feature-note">Windows 节点在本机执行 Codex、Antigravity 或直连 Stellarbit。</p><input id="windowsNodeLabel" maxlength="48" placeholder="新节点名称，例如：办公室电脑"><button type="button" id="createWindowsNode">生成一次性配对密钥</button>${pairingCard(pairing?.token, pairing?.expiresAt)}<div class="windows-node-list">${data.nodes.length ? data.nodes.map(nodeCard).join("") : "<p>尚未配对 Windows 节点。</p>"}</div></div>`);
  }
  async function openPanel() { shell("<p class=\"feature-note\">读取节点中…</p>"); try { await render(); } catch (error) { shell(`<p>${escapeHtml(error.message)}</p>`); } }
  $("windowsNodesEntry")?.addEventListener("click", () => { $("closeDrawerAccount")?.click(); $("featureSheet").hidden = false; openPanel(); });
  $("featureContent").addEventListener("click", async (event) => {
    if (event.target.closest("#createWindowsNode")) {
      try { const data = await request("windows-nodes/pair", "POST", { label: $("windowsNodeLabel").value }); await render({ token: data.pairingToken, expiresAt: data.expiresAt }); } catch (error) { alert(error.message); }
      return;
    }
    const run = event.target.closest("[data-windows-run]"); if (!run) return;
    const id = run.dataset.windowsRun; const output = $("windows-output-" + id);
    try { run.disabled = true; const submitted = await request(`windows-nodes/${id}/tasks`, "POST", { provider: $("windows-provider-" + id).value, model: $("windows-model-" + id).value, prompt: $("windows-prompt-" + id).value });
      output.textContent = "任务已投递，等待 Windows 节点执行…";
      while (output.isConnected && !$("featureSheet").hidden) {
        await new Promise(resolve => setTimeout(resolve, 2500));
        if (!output.isConnected || $("featureSheet").hidden) break;
        const tasks = await request(`windows-nodes/${id}/tasks`);
        const task = tasks.tasks.find(t => t.id === submitted.task.id);
        if (!task) throw new Error("任务记录不存在");
        output.innerHTML = `<small>${escapeHtml(task.status)}</small><pre>${escapeHtml(task.error || task.text || "等待 Windows 返回结果…")}</pre>`;
        if (["completed", "failed"].includes(task.status)) break;
      } } catch (error) { output.textContent = error.message; } finally { run.disabled = false; }
  });
})();
