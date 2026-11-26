(() => {
  "use strict";

  const API_BASE = "/vault-api/";
  const DISMISS_KEY = "witt_server_migration_dismissed";
  const DEVICE_ID_KEY = "witt_web_device_id";
  const UUID_RE = /^[a-f0-9-]{36}$/;

  function ensureDeviceId() {
    let id = "";
    try { id = localStorage.getItem(DEVICE_ID_KEY) || ""; } catch {}
    if (!UUID_RE.test(id)) {
      id = (crypto && typeof crypto.randomUUID === "function")
        ? crypto.randomUUID()
        : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0;
            return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
          });
      try { localStorage.setItem(DEVICE_ID_KEY, id); } catch {}
    }
    return id;
  }

  function injectStyles() {
    if (document.getElementById("witt-migration-styles")) return;
    const style = document.createElement("style");
    style.id = "witt-migration-styles";
    style.textContent = `
      .witt-mig-backdrop {
        position: fixed;
        inset: 0;
        z-index: 2147483000;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
        background: rgba(15, 23, 42, 0.54);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        opacity: 0;
        transition: opacity 0.2s ease;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
      }
      .witt-mig-backdrop.is-open { opacity: 1; }
      .witt-mig-card {
        width: 100%;
        max-width: 440px;
        border-radius: 20px;
        padding: 24px 22px 20px;
        background: #ffffff;
        color: #0f172a;
        box-shadow: 0 24px 64px rgba(15, 23, 42, 0.28), 0 0 0 1px rgba(15, 23, 42, 0.06);
        transform: translateY(10px) scale(0.98);
        transition: transform 0.22s ease;
        box-sizing: border-box;
      }
      .witt-mig-backdrop.is-open .witt-mig-card {
        transform: translateY(0) scale(1);
      }
      .witt-mig-badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 10px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 600;
        color: #1d4ed8;
        background: rgba(37, 99, 235, 0.1);
        margin-bottom: 12px;
      }
      .witt-mig-badge::before {
        content: "";
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: #2563eb;
      }
      .witt-mig-title {
        margin: 0 0 10px;
        font-size: 19px;
        font-weight: 700;
        line-height: 1.35;
      }
      .witt-mig-desc {
        margin: 0 0 14px;
        font-size: 14px;
        line-height: 1.6;
        color: #475569;
      }
      .witt-mig-host {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 6px;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 12.5px;
        background: rgba(15, 23, 42, 0.06);
        color: #1e293b;
        word-break: break-all;
      }
      .witt-mig-status {
        margin: 0 0 14px;
        padding: 10px 12px;
        border-radius: 10px;
        font-size: 13px;
        line-height: 1.5;
        display: none;
      }
      .witt-mig-status.is-info {
        display: block;
        background: rgba(37, 99, 235, 0.08);
        color: #1d4ed8;
      }
      .witt-mig-status.is-error {
        display: block;
        background: rgba(220, 38, 38, 0.09);
        color: #b91c1c;
      }
      .witt-mig-status.is-success {
        display: block;
        background: rgba(22, 163, 74, 0.1);
        color: #15803d;
      }
      .witt-mig-actions {
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .witt-mig-btn {
        width: 100%;
        border: 0;
        border-radius: 12px;
        padding: 12px 16px;
        font-size: 14.5px;
        font-weight: 600;
        cursor: pointer;
        transition: opacity 0.15s ease, transform 0.1s ease, background 0.15s ease;
        text-align: center;
        text-decoration: none;
        box-sizing: border-box;
      }
      .witt-mig-btn:active { transform: scale(0.99); }
      .witt-mig-btn:disabled { opacity: 0.6; cursor: not-allowed; }
      .witt-mig-btn-primary {
        background: linear-gradient(135deg, #2563eb, #1d4ed8);
        color: #ffffff;
        box-shadow: 0 8px 20px rgba(37, 99, 235, 0.25);
      }
      .witt-mig-btn-primary:hover:not(:disabled) { opacity: 0.94; }
      .witt-mig-btn-secondary {
        background: rgba(15, 23, 42, 0.06);
        color: #334155;
      }
      .witt-mig-btn-secondary:hover:not(:disabled) { background: rgba(15, 23, 42, 0.1); }
      .witt-mig-fallback {
        display: none;
        margin-top: 10px;
        padding-top: 12px;
        border-top: 1px solid rgba(15, 23, 42, 0.08);
        gap: 8px;
        flex-direction: column;
      }
      .witt-mig-fallback.is-visible { display: flex; }
      .witt-mig-pill {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147482000;
        display: inline-flex;
        align-items: center;
        gap: 7px;
        border: 0;
        border-radius: 999px;
        padding: 9px 14px;
        font-size: 13px;
        font-weight: 600;
        color: #ffffff;
        background: linear-gradient(135deg, #2563eb, #1d4ed8);
        box-shadow: 0 10px 26px rgba(37, 99, 235, 0.34);
        cursor: pointer;
        font-family: inherit;
      }
      .witt-mig-pill:hover { opacity: 0.94; }
      @media (prefers-color-scheme: dark) {
        .witt-mig-card {
          background: #141923;
          color: #f1f5f9;
          box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.09);
        }
        .witt-mig-badge {
          color: #93c5fd;
          background: rgba(59, 130, 246, 0.18);
        }
        .witt-mig-badge::before { background: #60a5fa; }
        .witt-mig-desc { color: #94a3b8; }
        .witt-mig-host { background: rgba(255, 255, 255, 0.08); color: #e2e8f0; }
        .witt-mig-status.is-info { background: rgba(59, 130, 246, 0.16); color: #93c5fd; }
        .witt-mig-status.is-error { background: rgba(239, 68, 68, 0.16); color: #fca5a5; }
        .witt-mig-status.is-success { background: rgba(34, 197, 94, 0.16); color: #86efac; }
        .witt-mig-btn-secondary { background: rgba(255, 255, 255, 0.08); color: #e2e8f0; }
        .witt-mig-btn-secondary:hover:not(:disabled) { background: rgba(255, 255, 255, 0.14); }
        .witt-mig-fallback { border-top-color: rgba(255, 255, 255, 0.1); }
      }
    `;
    document.head.appendChild(style);
  }

  function showAutoActivateModal(code) {
    injectStyles();
    const backdrop = document.createElement("div");
    backdrop.className = "witt-mig-backdrop";
    backdrop.innerHTML = `
      <div class="witt-mig-card" role="dialog" aria-modal="true" aria-labelledby="wittMigAutoTitle">
        <div class="witt-mig-badge">账号迁移</div>
        <h2 class="witt-mig-title" id="wittMigAutoTitle">正在自动激活你的原账号</h2>
        <p class="witt-mig-desc">正在校验一次性迁移凭证并绑定当前浏览器，完成后将自动进入 Witt 工作区。</p>
        <div class="witt-mig-status is-info" id="wittMigAutoStatus">正在连接新服务器完成激活…</div>
        <div class="witt-mig-actions">
          <button type="button" class="witt-mig-btn witt-mig-btn-secondary" id="wittMigAutoClose" style="display:none">关闭</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add("is-open"));

    const statusEl = backdrop.querySelector("#wittMigAutoStatus");
    const closeBtn = backdrop.querySelector("#wittMigAutoClose");
    closeBtn.addEventListener("click", () => backdrop.remove());

    fetch(API_BASE + "auth/activate", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-Witt-Client": "browser",
      },
      body: JSON.stringify({
        inviteCode: code,
        deviceId: ensureDeviceId(),
        deviceName: `${navigator.platform || "浏览器"} · Web`,
      }),
    }).then(async (resp) => {
      const text = await resp.text();
      let data = {};
      try { data = text ? JSON.parse(text) : {}; } catch {}
      if (!resp.ok) throw new Error(data.error || `激活失败（${resp.status}）`);
      statusEl.className = "witt-mig-status is-success";
      statusEl.textContent = "迁移激活成功！正在进入新服务器…";
      setTimeout(() => { window.location.reload(); }, 500);
    }).catch((err) => {
      statusEl.className = "witt-mig-status is-error";
      statusEl.textContent = (err && err.message) ? `${err.message}。请返回旧服务器重新点击「一键迁移」。` : "自动激活失败，请返回旧服务器重试。";
      closeBtn.style.display = "block";
    });
  }

  function handleIncomingMigrationHash() {
    const hash = String(window.location.hash || "");
    if (!hash.startsWith("#migrate=")) return false;
    const raw = hash.slice("#migrate=".length).trim();
    let code = "";
    try { code = decodeURIComponent(raw).trim(); } catch { code = raw; }
    try {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    } catch {}
    if (!code) return false;
    const run = () => showAutoActivateModal(code);
    if (document.body) run();
    else window.addEventListener("DOMContentLoaded", run, { once: true });
    return true;
  }

  function openMigrationPrompt(targetUrl) {
    injectStyles();
    const existing = document.getElementById("witt-migration-modal");
    if (existing) existing.remove();

    let hostText = targetUrl;
    try { hostText = new URL(targetUrl).host; } catch {}

    const backdrop = document.createElement("div");
    backdrop.id = "witt-migration-modal";
    backdrop.className = "witt-mig-backdrop";
    backdrop.innerHTML = `
      <div class="witt-mig-card" role="dialog" aria-modal="true" aria-labelledby="wittMigTitle">
        <div class="witt-mig-badge">服务器迁移提醒</div>
        <h2 class="witt-mig-title" id="wittMigTitle">Witt 已迁移至新服务器</h2>
        <p class="witt-mig-desc">
          你的账号、全部历史聊天记录与附件已完整同步至新服务器
          <span class="witt-mig-host"></span>。
          点击下方按钮将自动生成专属一次性迁移凭证并免输激活码登录新服务器。
        </p>
        <div class="witt-mig-status" id="wittMigStatus"></div>
        <div class="witt-mig-actions">
          <button type="button" class="witt-mig-btn witt-mig-btn-primary" id="wittMigStart">一键迁移到新服务器</button>
          <button type="button" class="witt-mig-btn witt-mig-btn-secondary" id="wittMigLater">稍后提醒</button>
        </div>
        <div class="witt-mig-fallback" id="wittMigFallback">
          <button type="button" class="witt-mig-btn witt-mig-btn-secondary" id="wittMigCopy">复制一次性激活码（备用）</button>
          <a class="witt-mig-btn witt-mig-btn-secondary" id="wittMigLink" target="_blank" rel="noopener noreferrer">手动打开新服务器</a>
        </div>
      </div>
    `;
    backdrop.querySelector(".witt-mig-host").textContent = hostText;
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add("is-open"));

    const statusEl = backdrop.querySelector("#wittMigStatus");
    const startBtn = backdrop.querySelector("#wittMigStart");
    const laterBtn = backdrop.querySelector("#wittMigLater");
    const fallbackEl = backdrop.querySelector("#wittMigFallback");
    const copyBtn = backdrop.querySelector("#wittMigCopy");
    const linkEl = backdrop.querySelector("#wittMigLink");

    let latestCode = "";

    function closeModal(rememberDismiss) {
      if (rememberDismiss) {
        try { sessionStorage.setItem(DISMISS_KEY, "1"); } catch {}
      }
      backdrop.classList.remove("is-open");
      setTimeout(() => backdrop.remove(), 180);
    }

    laterBtn.addEventListener("click", () => closeModal(true));
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeModal(true);
    });
    const onKeyDown = (e) => {
      if (e.key === "Escape" && document.getElementById("witt-migration-modal")) {
        document.removeEventListener("keydown", onKeyDown);
        closeModal(true);
      }
    };
    document.addEventListener("keydown", onKeyDown);

    copyBtn.addEventListener("click", async () => {
      if (!latestCode) return;
      try {
        await navigator.clipboard.writeText(latestCode);
        copyBtn.textContent = "已复制激活码";
      } catch {
        copyBtn.textContent = "复制失败，请允许剪贴板权限";
      }
    });

    startBtn.addEventListener("click", async () => {
      startBtn.disabled = true;
      startBtn.textContent = "正在生成专属迁移凭证…";
      statusEl.className = "witt-mig-status is-info";
      statusEl.textContent = "正在向新服务器申请一次性迁移凭证（15 分钟有效，仅限本设备）…";
      try {
        const resp = await fetch(API_BASE + "auth/server-migration-code", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "X-Witt-Client": "browser",
          },
          body: "{}",
        });
        const text = await resp.text();
        let data = {};
        try { data = text ? JSON.parse(text) : {}; } catch {}
        if (!resp.ok || !data.code || !data.targetUrl) {
          throw new Error(data.error || `申请迁移凭证失败（${resp.status}）`);
        }
        latestCode = data.code;
        const jumpUrl = `${data.targetUrl}#migrate=${encodeURIComponent(data.code)}`;
        linkEl.href = jumpUrl;
        fallbackEl.classList.add("is-visible");
        statusEl.className = "witt-mig-status is-success";
        statusEl.textContent = "迁移凭证已就绪，正在跳转至新服务器自动登录…";
        startBtn.textContent = "正在跳转…";
        window.location.href = jumpUrl;
      } catch (err) {
        statusEl.className = "witt-mig-status is-error";
        statusEl.textContent = (err && err.message) || "申请迁移凭证失败，请稍后重试。";
        startBtn.disabled = false;
        startBtn.textContent = "重试一键迁移";
      }
    });
  }

  function mountFloatingPill(targetUrl) {
    if (document.getElementById("witt-migration-pill")) return;
    injectStyles();
    const pill = document.createElement("button");
    pill.id = "witt-migration-pill";
    pill.type = "button";
    pill.className = "witt-mig-pill";
    pill.textContent = "迁移至新服务器";
    pill.addEventListener("click", () => openMigrationPrompt(targetUrl));
    document.body.appendChild(pill);
  }

  async function checkServerMigrationNotice() {
    try {
      const resp = await fetch(API_BASE + "auth/status", {
        credentials: "same-origin",
        cache: "no-store",
        headers: { "X-Witt-Client": "browser" },
      });
      if (!resp.ok) return;
      const data = await resp.json();
      const targetUrl = data?.serverMigration?.targetUrl;
      if (!data?.authenticated || !targetUrl) return;
      try {
        if (new URL(targetUrl).origin === window.location.origin) return;
      } catch {}
      mountFloatingPill(targetUrl);
      let dismissed = false;
      try { dismissed = sessionStorage.getItem(DISMISS_KEY) === "1"; } catch {}
      if (!dismissed) openMigrationPrompt(targetUrl);
    } catch {}
  }

  if (handleIncomingMigrationHash()) return;
  if (document.readyState === "loading") {
    window.addEventListener("DOMContentLoaded", () => { setTimeout(checkServerMigrationNotice, 600); }, { once: true });
  } else {
    setTimeout(checkServerMigrationNotice, 600);
  }
})();
