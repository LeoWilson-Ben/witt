(() => {
  "use strict";

  const API_BASE = "/vault-api/browser";
  const CHROME_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="4.1" fill="#4285F4"/>' +
    '<path fill="#EA4335" d="M12 2.5A9.5 9.5 0 0 1 20.66 8H12a4 4 0 0 0-3.46 2L5.1 4.05A9.48 9.48 0 0 1 12 2.5Z"/>' +
    '<path fill="#34A853" d="M5.1 4.05 9.2 11.15A4 4 0 0 0 12 16c.35 0 .69-.05 1.02-.14L9.56 21.18A9.5 9.5 0 0 1 5.1 4.05Z"/>' +
    '<path fill="#FBBC05" d="M20.66 8A9.5 9.5 0 0 1 9.56 21.18l3.46-5.32A4 4 0 0 0 12 8h8.66Z"/>' +
    "</svg>";

  let modalEl = null;
  let iframeEl = null;
  let statusBadgeEl = null;
  let urlInputEl = null;
  let emptyOverlayEl = null;
  let emptyTextEl = null;
  let isOpen = false;
  let isFullscreen = false;
  let busy = false;
  let browserMode = "neko";

  async function api(path, method = "GET", body) {
    const opts = {
      method,
      credentials: "include",
      headers: {},
    };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(`${API_BASE}${path}`, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `请求失败 (${res.status})`);
    }
    return data;
  }

  function ensureStyles() {
    if (document.getElementById("serverBrowserStyles")) return;
    const style = document.createElement("style");
    style.id = "serverBrowserStyles";
    style.textContent = `
      .witt-sb-backdrop{
        position:fixed;inset:0;z-index:1200;
        display:flex;align-items:center;justify-content:center;
        padding:12px;
        background:rgba(15,23,42,.56);
        backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
        opacity:0;pointer-events:none;transition:opacity .18s ease;
      }
      .witt-sb-backdrop.open{opacity:1;pointer-events:auto}
      .witt-sb-backdrop.fullscreen{padding:0}
      .witt-sb-shell{
        width:min(1320px,calc(100vw - 24px));
        height:min(88dvh,860px);
        display:flex;flex-direction:column;overflow:hidden;
        border-radius:20px;
        border:1px solid rgba(255,255,255,.16);
        background:#13161b;color:#f1f5f9;
        box-shadow:0 24px 70px rgba(0,0,0,.48);
        transform:scale(.97);transition:transform .2s cubic-bezier(.16,1,.3,1),width .2s ease,height .2s ease,border-radius .2s ease;
      }
      .witt-sb-backdrop.open .witt-sb-shell{transform:scale(1)}
      .witt-sb-backdrop.fullscreen .witt-sb-shell{
        width:100vw;height:100dvh;border-radius:0;border:0;
      }
      .witt-sb-bar{
        flex:none;display:flex;align-items:center;gap:8px;flex-wrap:wrap;
        padding:10px 14px;
        background:#1b1f27;
        border-bottom:1px solid rgba(255,255,255,.09);
      }
      .witt-sb-title{
        display:inline-flex;align-items:center;gap:8px;
        font-size:13px;font-weight:650;white-space:nowrap;
      }
      .witt-sb-title svg{width:20px;height:20px;display:block;flex:none}
      .witt-sb-status{
        display:inline-flex;align-items:center;gap:5px;
        padding:3px 9px;border-radius:999px;font-size:11px;font-weight:600;
        background:rgba(148,163,184,.16);color:#cbd5e1;white-space:nowrap;
      }
      .witt-sb-status[data-state="running"]{background:rgba(34,197,94,.16);color:#86efac}
      .witt-sb-status[data-state="loading"]{background:rgba(59,130,246,.18);color:#93c5fd}
      .witt-sb-status[data-state="error"]{background:rgba(239,68,68,.18);color:#fca5a5}
      .witt-sb-url-form{
        flex:1 1 240px;min-width:160px;display:flex;align-items:center;gap:6px;
      }
      .witt-sb-url-input{
        flex:1;min-width:0;height:32px;padding:0 12px;
        border-radius:999px;border:1px solid rgba(255,255,255,.14);
        background:rgba(255,255,255,.07);color:#f8fafc;
        font:inherit;font-size:12.5px;outline:none;
      }
      .witt-sb-url-input:focus{border-color:#60a5fa;background:rgba(255,255,255,.11)}
      .witt-sb-url-input::placeholder{color:#94a3b8}
      .witt-sb-actions{display:flex;align-items:center;gap:6px;flex:none}
      .witt-sb-btn{
        height:32px;padding:0 11px;border-radius:9px;
        border:1px solid rgba(255,255,255,.14);
        background:rgba(255,255,255,.07);color:#e2e8f0;
        font:inherit;font-size:12px;font-weight:550;cursor:pointer;white-space:nowrap;
        transition:background .15s ease,border-color .15s ease;
      }
      .witt-sb-btn:hover{background:rgba(255,255,255,.14)}
      .witt-sb-btn:disabled{opacity:.45;cursor:default}
      .witt-sb-btn.is-primary{background:#2563eb;border-color:#3b82f6;color:#fff}
      .witt-sb-btn.is-primary:hover{background:#1d4ed8}
      .witt-sb-btn.is-danger{color:#fca5a5;border-color:rgba(239,68,68,.32);background:rgba(239,68,68,.12)}
      .witt-sb-btn.is-danger:hover{background:rgba(239,68,68,.22)}
      .witt-sb-stage{
        position:relative;flex:1;min-height:0;background:#0b0d11;
      }
      .witt-sb-frame{
        position:absolute;inset:0;width:100%;height:100%;border:0;background:#0b0d11;
      }
      .witt-sb-overlay{
        position:absolute;inset:0;z-index:2;
        display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;
        background:rgba(11,13,17,.9);color:#cbd5e1;font-size:13px;text-align:center;padding:24px;
      }
      .witt-sb-overlay[hidden]{display:none!important}
      .witt-sb-spinner{
        width:28px;height:28px;border-radius:50%;
        border:2.5px solid rgba(148,163,184,.25);border-top-color:#60a5fa;
        animation:wittSbSpin .75s linear infinite;
      }
      @keyframes wittSbSpin{to{transform:rotate(360deg)}}
      @media (max-width:640px){
        .witt-sb-backdrop{padding:0}
        .witt-sb-shell{width:100vw;height:100dvh;border-radius:0;border:0}
        .witt-sb-bar{padding:8px 10px;gap:6px}
        .witt-sb-btn{padding:0 8px;font-size:11.5px;height:30px}
      }
    `;
    style.textContent += `
      .witt-sb-backdrop{inset:0 0 0 auto;width:var(--witt-browser-width,48vw);padding:0;background:none;backdrop-filter:none;-webkit-backdrop-filter:none;visibility:hidden}
      .witt-sb-backdrop.open{visibility:visible}
      .witt-sb-shell{width:100%;height:100%;max-height:none;border-radius:0;border:0;border-left:1px solid #394150;transform:none!important}
      .witt-sb-bar{padding:10px;gap:8px}.witt-sb-title{font-size:12px}.witt-sb-url-form{flex-basis:100%;order:3}
      .witt-sb-actions{margin-left:auto}.witt-sb-backdrop.fullscreen{width:100vw}
      .witt-sb-resize{position:absolute;left:-4px;top:0;bottom:0;width:8px;z-index:5;cursor:col-resize;touch-action:none}
      .witt-sb-resize:focus-visible{outline:2px solid #60a5fa;outline-offset:-2px}
      body.browser-resizing iframe{pointer-events:none!important}
      @media(min-width:1100px){
        html:root body.web-browser.browser-docked .app-shell{width:calc(100% - 260px - var(--witt-browser-width,48vw))!important}
        html:root body.web-browser.browser-docked #welcome .suggestions{grid-template-columns:minmax(0,1fr)!important}
        html:root body.web-browser.browser-docked #welcome .suggestions button{grid-column:auto!important}
        html:root body.web-browser.browser-docked #welcome h1{font-size:clamp(30px,3vw,44px)!important}
      }
      @media(max-width:1099px){
        .witt-sb-backdrop{width:100vw}.witt-sb-resize{display:none}
      }
      @media(prefers-reduced-motion:reduce){.witt-sb-backdrop,.witt-sb-shell{transition:none}}
    `;
    document.head.appendChild(style);
  }

  function setStatus(state, text) {
    if (statusBadgeEl) {
      statusBadgeEl.dataset.state = state;
      statusBadgeEl.textContent = text;
    }
    const orb = document.getElementById("headerBrowserSwitch");
    if (orb) {
      orb.dataset.browserRunning = state === "running" ? "true" : "false";
    }
  }

  function setOverlay(visible, text, showSpinner = true) {
    if (!emptyOverlayEl) return;
    emptyOverlayEl.hidden = !visible;
    if (emptyTextEl && text) emptyTextEl.textContent = text;
    const spinner = emptyOverlayEl.querySelector(".witt-sb-spinner");
    if (spinner) spinner.style.display = showSpinner ? "block" : "none";
  }

  function buildModal() {
    if (modalEl) return;
    ensureStyles();
    modalEl = document.createElement("div");
    modalEl.id = "serverBrowserModal";
    modalEl.className = "witt-sb-backdrop";
    modalEl.setAttribute("aria-hidden", "true");
    modalEl.innerHTML = `
      <div class="witt-sb-resize" role="separator" tabindex="0" aria-orientation="vertical" aria-label="调整浏览器宽度"></div>
      <section class="witt-sb-shell" role="region" aria-label="协作浏览器">
        <header class="witt-sb-bar">
          <div class="witt-sb-title">${CHROME_SVG}<span>协作浏览器</span><span class="witt-sb-status" id="wittSbStatus" data-state="idle">未连接</span></div>
          <form class="witt-sb-url-form" id="wittSbUrlForm">
            <input type="text" class="witt-sb-url-input" id="wittSbUrlInput" placeholder="输入网址直达，如 google.com" autocomplete="off" spellcheck="false">
            <button type="submit" class="witt-sb-btn is-primary">前往</button>
          </form>
          <div class="witt-sb-actions">
            <button type="button" class="witt-sb-btn" id="wittSbReconnect">重连</button>
            <button type="button" class="witt-sb-btn" id="wittSbRestart">兼容模式</button>
            <button type="button" class="witt-sb-btn" id="wittSbFit" title="按当前窗口调整共享画面尺寸">适应窗口</button>
            <button type="button" class="witt-sb-btn" id="wittSbFullscreen">全屏</button>
            <button type="button" class="witt-sb-btn" id="wittSbClose" aria-label="返回聊天，保持浏览器连接">返回聊天</button>
          </div>
        </header>
        <div class="witt-sb-stage">
          <iframe class="witt-sb-frame" id="wittSbFrame" title="服务器 Google 浏览器画面" allow="clipboard-read; clipboard-write"></iframe>
          <div class="witt-sb-overlay" id="wittSbOverlay">
            <div class="witt-sb-spinner"></div>
            <div id="wittSbOverlayText">正在连接服务器 Google 浏览器…</div>
          </div>
        </div>
      </section>
    `;
    document.body.appendChild(modalEl);

    iframeEl = modalEl.querySelector("#wittSbFrame");
    statusBadgeEl = modalEl.querySelector("#wittSbStatus");
    urlInputEl = modalEl.querySelector("#wittSbUrlInput");
    emptyOverlayEl = modalEl.querySelector("#wittSbOverlay");
    emptyTextEl = modalEl.querySelector("#wittSbOverlayText");

    modalEl.addEventListener("click", (ev) => {
      if (ev.target === modalEl) closeModal();
    });
    modalEl.querySelector("#wittSbClose").addEventListener("click", closeModal);
    modalEl.querySelector("#wittSbFullscreen").addEventListener("click", () => {
      isFullscreen = !isFullscreen;
      modalEl.classList.toggle("fullscreen", isFullscreen);
      modalEl.querySelector("#wittSbFullscreen").textContent = isFullscreen ? "还原" : "放大";
    });
    modalEl.querySelector("#wittSbFit").addEventListener("click", async () => {
      if(browserMode !== "neko")return;
      const rect=modalEl.querySelector(".witt-sb-stage").getBoundingClientRect();
      const button=modalEl.querySelector("#wittSbFit");button.disabled=true;
      try {await api("/collaboration/fit", "POST", {width:Math.round(rect.width),height:Math.round(rect.height)});}
      catch(error){setOverlay(true,error.message,false);setTimeout(()=>setOverlay(false),2500);}
      finally{button.disabled=false;}
    });
    modalEl.querySelector("#wittSbReconnect").addEventListener("click", () => connectBrowser());
    modalEl.querySelector("#wittSbRestart").addEventListener("click", () => {
      browserMode = browserMode === "neko" ? "legacy" : "neko";
      modalEl.querySelector("#wittSbRestart").textContent = browserMode === "neko" ? "兼容模式" : "协作模式";
      connectBrowser();
    });
    const resize = modalEl.querySelector(".witt-sb-resize");
    const setWidth = width => {
      const value = Math.max(360, Math.min(window.innerWidth - 660, width));
      document.documentElement.style.setProperty("--witt-browser-width", `${value}px`);
      resize.setAttribute("aria-valuenow", String(Math.round(value)));
      window.dispatchEvent(new Event("resize"));
    };
    resize.addEventListener("pointerdown", event => {
      resize.setPointerCapture(event.pointerId);document.body.classList.add("browser-resizing");
    });
    resize.addEventListener("pointermove", event => {
      if(resize.hasPointerCapture(event.pointerId)) setWidth(window.innerWidth - event.clientX);
    });
    const releaseResize = () => document.body.classList.remove("browser-resizing");
    resize.addEventListener("pointerup", releaseResize);resize.addEventListener("lostpointercapture", releaseResize);
    resize.addEventListener("keydown", event => {
      if(!["ArrowLeft","ArrowRight"].includes(event.key))return;event.preventDefault();
      setWidth(modalEl.getBoundingClientRect().width + (event.key === "ArrowLeft" ? 24 : -24));
    });
    modalEl.querySelector("#wittSbUrlForm").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const targetUrl = String(urlInputEl.value || "").trim();
      if (!targetUrl) return;
      try {
        await api(browserMode === "neko" ? "/collaboration/navigate" : "/navigate", "POST", { url: targetUrl });
        urlInputEl.blur();
      } catch (err) {
        setOverlay(true, err.message || "打开网址失败", false);
        setTimeout(() => {
          if (iframeEl && iframeEl.src && iframeEl.src !== "about:blank") {
            setOverlay(false);
          }
        }, 2000);
      }
    });

    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && isOpen) closeModal();
    });
  }

  async function connectBrowser() {
    buildModal();
    setStatus("loading", "连接中…");
    setOverlay(true, "正在启动并连接服务器 Google 浏览器…", true);
    try {
      const data = await api(browserMode === "neko" ? "/connect" : "/ticket", "POST");
      const viewerUrl = data.viewerUrl || `/vault/novnc/vnc_lite.html?path=${encodeURIComponent(data.wsPath)}&scale=true&autoconnect=1&resize=scale`;
      if(data.mode)browserMode=data.mode;
      if(browserMode === "neko") {
        const viewer=new URL(viewerUrl,location.origin);viewer.searchParams.set("embed","1");
        data.compactViewer=viewer.pathname+viewer.search;
      }
      modalEl.querySelector("#wittSbFit").hidden = browserMode !== "neko";
      modalEl.querySelector("#wittSbRestart").textContent = browserMode === "neko" ? "兼容模式" : "协作模式";
      iframeEl.onload = () => {
        if(browserMode === "neko")try{
          const doc=iframeEl.contentDocument;
          if(doc&&!doc.getElementById("witt-compact-neko")){
            const style=doc.createElement("style");style.id="witt-compact-neko";
            style.textContent='[data-testid="header"],button[aria-label="Fullscreen"],button[aria-label="Screen resolution"],button[aria-label="Picture-in-Picture"]{display:none!important}#neko>main{min-width:0!important}.video-container{min-height:0!important}';
            doc.head.appendChild(style);
          }
        }catch{}
        setStatus("running", browserMode === "neko" ? "协作模式" : "兼容模式");
        setOverlay(false);
      };
      iframeEl.src = data.compactViewer || viewerUrl;
      if (data.status && Array.isArray(data.status.tabs) && data.status.tabs[0]?.url && urlInputEl && !urlInputEl.value) {
        urlInputEl.value = data.status.tabs[0].url;
      }
    } catch (err) {
      setStatus("error", "连接失败");
      setOverlay(true, err.message || "无法连接服务器浏览器", false);
    }
  }

  function openModal() {
    buildModal();
    isOpen = true;
    modalEl.classList.add("open");
    modalEl.setAttribute("aria-hidden", "false");
    document.body.classList.add("browser-docked");
    if(!document.documentElement.style.getPropertyValue("--witt-browser-width")) {
      document.documentElement.style.setProperty("--witt-browser-width", `${Math.max(360, Math.min(innerWidth * .48, innerWidth - 760))}px`);
    }
    window.dispatchEvent(new Event("resize"));
    if(!iframeEl.getAttribute("src") || iframeEl.getAttribute("src") === "about:blank") connectBrowser();
  }

  function closeModal() {
    if (!modalEl) return;
    isOpen = false;
    modalEl.classList.remove("open");
    modalEl.setAttribute("aria-hidden", "true");
    document.body.classList.remove("browser-docked");
    window.dispatchEvent(new Event("resize"));
    document.getElementById("messageInput")?.focus();
  }

  async function syncOrbStatus() {
    try {
      const status = await api("/collaboration/status", "GET");
      const orb = document.getElementById("headerBrowserSwitch");
      if (orb) orb.dataset.browserRunning = status.running ? "true" : "false";
    } catch {}
  }

  function init() {
    const btn = document.getElementById("headerBrowserSwitch");
    if (!btn) return;
    const logo = btn.querySelector(".header-account-logo");
    if (logo && !logo.querySelector("svg")) {
      logo.innerHTML = CHROME_SVG;
    }
    btn.addEventListener("click", () => {
      if (isOpen) closeModal();
      else openModal();
    });
    window.addEventListener("resize", () => {
      if(innerWidth < 1100)return;
      const current=parseFloat(document.documentElement.style.getPropertyValue("--witt-browser-width"));
      if(current > innerWidth - 660)document.documentElement.style.setProperty("--witt-browser-width", `${Math.max(360,innerWidth - 660)}px`);
    });
    setTimeout(syncOrbStatus, 1800);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.WittServerBrowser = { open: openModal, close: closeModal, status: syncOrbStatus };
})();
