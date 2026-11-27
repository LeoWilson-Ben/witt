(() => {
  "use strict";

  const $ = (s, root = document) => root.querySelector(s);
  const esc = (v) => {
    const el = document.createElement("span");
    el.textContent = String(v ?? "");
    return el.innerHTML.replaceAll('"', "&quot;").replaceAll("'", "&#39;");
  };

  let overviewData = null;
  let activeTab = "all";
  let showLog = false;
  let logText = "";
  let pendingLogText = null;
  let isDraggingLog = false;
  let pollTimer = null;
  let busyAction = false;

  function toast(msg) {
    if (window.WittUI?.toast) {
      window.WittUI.toast(msg);
      return;
    }
    const t = $("#toast");
    if (t) {
      t.textContent = msg;
      t.classList.add("visible");
      setTimeout(() => t.classList.remove("visible"), 2600);
    }
  }

  function formatTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function formatBytes(bytes) {
    const n = Number(bytes || 0);
    if (!n) return "—";
    return `${(n / (1024 * 1024)).toFixed(0)} MB`;
  }

  function statusLabel(st, isIos = false) {
    if (st === "building") return "构建中";
    if (st === "queued") return "排队中";
    if (st === "failed") return "失败";
    if (st === "canceled") return "已取消";
    return isIos ? "已归档" : "已完成";
  }

  function serverStateLabel(st) {
    const map = {
      ready: "Codemagic · 就绪",
      queued: "Codemagic · 排队中",
      unconfigured: "Codemagic · 等待账号授权",
      stopped: "已自动关机",
      stopping: "关机中…",
      pending: "开机中…",
      running: "运行中",
    };
    return map[st] || st || "待命";
  }

  async function api(path, method = "GET", body = null) {
    const res = await fetch(`/vault-api/licre${path}`, {
      method,
      cache: "no-store",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
    return data;
  }

  function triggerApkDownload(release) {
    if (!release || !release.available) {
      toast("仅保留最新两个版本的 APK");
      return;
    }
    const filename = `Xuanyu-${release.versionName || "1.0.76"}-${release.shortCommit || "release"}.apk`;
    if (window.WittNative && release.nativeDownloadUrl) {
      try {
        window.WittNative.postMessage(
          JSON.stringify({
            method: "downloadImage",
            args: [release.nativeDownloadUrl, filename, "application/vnd.android.package-archive"],
          })
        );
        toast(`已开始下载 ${filename}`);
        return;
      } catch {}
    }
    const url = release.downloadUrl || `/vault-api/licre/releases/${release.commit}/app-release.apk`;
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast(`正在下载 ${filename}`);
  }

  const buildIconSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2.5 20 7v10l-8 4.5L4 17V7l8-4.5Z"/><path d="M12 21.5V12"/><path d="m20 7-8 5-8-5"/><path d="m8 4.75 8 5"/></svg>`;

  function renderMoreMenuWidget() {
    const widget = $("#xuanyuMoreWidget");
    if (!widget) return;
    const android = overviewData?.android;
    const ios = overviewData?.ios;
    const aStatus = android?.status || "success";
    const iStatus = ios?.status || "success";
    const aPct = android?.progress ?? 100;
    const iPct = ios?.progress ?? 100;
    const latestApk = (android?.releases || []).find((r) => r.available) || null;
    const aVer = latestApk ? `${latestApk.versionName} (${latestApk.buildNumber})` : "1.0.76 (78)";
    const iVer = ios ? `${ios.versionName} (${ios.ciBuildNumber || 721})` : "1.0.76 (721)";

    const moreBtn = $("#chatMoreButton");
    if (moreBtn) {
      moreBtn.classList.toggle("xb-has-active-build", aStatus === "building" || iStatus === "building");
    }

    widget.innerHTML = `
      <div class="xb-more-head" data-xb-action="open-sheet">
        <div class="xb-more-brand">
          <span class="xb-more-logo">${buildIconSvg}</span>
          <div class="xb-more-title-wrap">
            <strong>玄遇构建</strong>
          </div>
        </div>
        <span class="xb-more-enter">历史与下载 ›</span>
      </div>
      <div class="xb-more-rows">
        <div class="xb-more-row" data-xb-action="open-sheet" data-xb-tab="android">
          <div class="xb-more-row-left">
            <span class="xb-dot ${aStatus === "building" ? "building" : aStatus === "failed" ? "failed" : ""}"></span>
            <span class="xb-more-platform">Android</span>
            <span class="xb-more-ver">${esc(aVer)}</span>
          </div>
          <span class="xb-more-state ${aStatus === "building" ? "building" : ""}">
            ${esc(statusLabel(aStatus, false))}${aStatus === "building" ? ` ${aPct}%` : ""}
          </span>
        </div>
        <div class="xb-more-row" data-xb-action="open-sheet" data-xb-tab="ios">
          <div class="xb-more-row-left">
            <span class="xb-dot ${iStatus === "building" ? "building" : iStatus === "failed" ? "failed" : ""}"></span>
            <span class="xb-more-platform">iOS</span>
            <span class="xb-more-ver">${esc(iVer)}</span>
          </div>
          <span class="xb-more-state ${iStatus === "building" ? "building" : ""}">
            ${esc(statusLabel(iStatus, true))}${iStatus === "building" ? ` ${iPct}%` : ""}
          </span>
        </div>
      </div>
    `;
  }

  function applyLogTextPreservingScroll(logBox, nextText) {
    if (!logBox) return;
    const cleaned = String(nextText || "正在读取编译日志…")
      .split("\n")
      .filter((line) => !/xuanyu-last-active:\s*Permission denied/i.test(line))
      .join("\n");
    const normalized = cleaned || "正在读取编译日志…";
    if (logBox.dataset.renderedLog === normalized) return;
    if (isDraggingLog) {
      pendingLogText = normalized;
      return;
    }
    const body = $("#xuanyuBuildBody");
    const prevLogTop = logBox.scrollTop;
    const prevLogLeft = logBox.scrollLeft;
    const prevBodyTop = body ? body.scrollTop : 0;

    logBox.textContent = normalized;
    logBox.dataset.renderedLog = normalized;

    logBox.scrollTop = prevLogTop;
    logBox.scrollLeft = prevLogLeft;
    if (body) body.scrollTop = prevBodyTop;
  }

  function ensureSheetSkeleton(body) {
    if ($('[data-xb-el="platform-grid"]', body)) return;
    body.innerHTML = `
      <div class="xb-platform-grid" data-xb-el="platform-grid">
        <!-- Android Card -->
        <article class="xb-card android-card">
          <div class="xb-card-top">
            <div class="xb-platform-title">
              <span class="xb-platform-badge android">Android</span>
              <strong data-xb-el="android-ver">1.0.76 (78)</strong>
            </div>
            <span class="xb-status-pill" data-xb-el="android-pill">
              <span class="xb-dot" data-xb-el="android-dot"></span>
              <span data-xb-el="android-status-text">已完成</span>
            </span>
          </div>

          <div class="xb-progress-wrap">
            <div class="xb-progress-row">
              <span class="xb-progress-stage" data-xb-el="android-stage">服务已就绪</span>
              <span class="xb-progress-pct" data-xb-el="android-pct">100%</span>
            </div>
            <div class="xb-progress-bar">
              <div class="xb-progress-fill" data-xb-el="android-fill" style="width:100%"></div>
            </div>
          </div>

          <div class="xb-meta-list">
            <div class="xb-meta-item">
              <span>构建平台</span>
              <b data-xb-el="android-srv">Codemagic · 就绪</b>
            </div>
            <div class="xb-meta-item">
              <span>最新提交</span>
              <b data-xb-el="android-commit">—</b>
            </div>
          </div>

          <div class="xb-card-actions">
            <button type="button" class="xb-btn" data-xb-action="trigger-build" data-xb-el="android-trigger-btn">
              重新构建
            </button>
            <button type="button" class="xb-btn" data-xb-action="toggle-log" data-xb-el="android-log-btn">
              编译日志
            </button>
          </div>
        </article>

        <!-- iOS Card -->
        <article class="xb-card ios-card">
          <div class="xb-card-top">
            <div class="xb-platform-title">
              <span class="xb-platform-badge ios">iOS Release</span>
              <strong data-xb-el="ios-ver">1.0.76 (721)</strong>
            </div>
            <span class="xb-status-pill" data-xb-el="ios-pill">
              <span class="xb-dot" data-xb-el="ios-dot"></span>
              <span data-xb-el="ios-status-text">已归档</span>
            </span>
          </div>

          <div class="xb-progress-wrap">
            <div class="xb-progress-row">
              <span class="xb-progress-stage" data-xb-el="ios-stage">Xcode Cloud Release 已归档</span>
              <span class="xb-progress-pct" data-xb-el="ios-pct">100%</span>
            </div>
            <div class="xb-progress-bar">
              <div class="xb-progress-fill" data-xb-el="ios-fill" style="width:100%"></div>
            </div>
          </div>

          <div class="xb-meta-list">
            <div class="xb-meta-item">
              <span>云端通道</span>
              <b>Xcode Cloud · 正式版</b>
            </div>
            <div class="xb-meta-item">
              <span>最新归档</span>
              <b data-xb-el="ios-archive">—</b>
            </div>
          </div>
        </article>
      </div>

      <section data-xb-el="log-section" hidden>
        <div class="xb-section-head" style="margin-bottom:8px">
          <h3>编译日志</h3>
          <button type="button" class="xb-icon-btn" data-xb-action="refresh-log">刷新</button>
        </div>
        <pre class="xb-log-box" data-xb-el="log-box">正在读取编译日志…</pre>
      </section>

      <section data-xb-el="history-section">
        <div class="xb-section-head">
          <h3>历史记录</h3>
          <div class="xb-tabs" role="tablist">
            <button type="button" class="xb-tab active" data-xb-tab-select="all">全部</button>
            <button type="button" class="xb-tab" data-xb-tab-select="android">Android</button>
            <button type="button" class="xb-tab" data-xb-tab-select="ios">iOS</button>
          </div>
        </div>
        <div class="xb-history-list" data-xb-el="history-list" style="margin-top:10px"></div>
      </section>
    `;

    const logBox = $('[data-xb-el="log-box"]', body);
    if (logBox) {
      const startDrag = () => {
        isDraggingLog = true;
      };
      const endDrag = () => {
        isDraggingLog = false;
        if (pendingLogText !== null) {
          const next = pendingLogText;
          pendingLogText = null;
          applyLogTextPreservingScroll(logBox, next);
        }
      };
      logBox.addEventListener("touchstart", startDrag, { passive: true });
      logBox.addEventListener("touchend", endDrag, { passive: true });
      logBox.addEventListener("touchcancel", endDrag, { passive: true });
      logBox.addEventListener("pointerdown", startDrag, { passive: true });
      logBox.addEventListener("pointerup", endDrag, { passive: true });
      logBox.addEventListener("pointercancel", endDrag, { passive: true });
    }
  }

  function renderBuildSheet() {
    const body = $("#xuanyuBuildBody");
    if (!body) return;
    if (!overviewData) {
      if (!body.children.length) {
        body.innerHTML = `<div class="xb-card"><p style="margin:0;color:var(--xb-muted)">正在同步构建状态…</p></div>`;
      }
      return;
    }

    ensureSheetSkeleton(body);

    const { android, ios } = overviewData;
    const aStatus = android.status || "success";
    const iStatus = ios.status || "success";
    const availableApks = (android.releases || []).filter((r) => r.available);
    const latestApk = availableApks[0] || null;
    const srv = android.builderServer || {};

    // Update Android Card in place
    const aVerEl = $('[data-xb-el="android-ver"]', body);
    if (aVerEl) aVerEl.textContent = latestApk ? `${latestApk.versionName} (${latestApk.buildNumber})` : "1.0.76 (78)";

    const aPillEl = $('[data-xb-el="android-pill"]', body);
    if (aPillEl) {
      aPillEl.className = `xb-status-pill ${aStatus === "building" ? "building" : aStatus === "failed" ? "failed" : ""}`;
    }
    const aDotEl = $('[data-xb-el="android-dot"]', body);
    if (aDotEl) {
      aDotEl.className = `xb-dot ${aStatus === "building" ? "building" : aStatus === "failed" ? "failed" : ""}`;
    }
    const aStatusTextEl = $('[data-xb-el="android-status-text"]', body);
    if (aStatusTextEl) aStatusTextEl.textContent = statusLabel(aStatus, false);

    const aStageEl = $('[data-xb-el="android-stage"]', body);
    if (aStageEl) aStageEl.textContent = android.stage || "—";

    const aPct = Math.max(0, Math.min(100, Number(android.progress ?? 100)));
    const aPctEl = $('[data-xb-el="android-pct"]', body);
    if (aPctEl) aPctEl.textContent = `${aPct}%`;

    const aFillEl = $('[data-xb-el="android-fill"]', body);
    if (aFillEl) {
      aFillEl.className = `xb-progress-fill ${aStatus === "building" ? "building" : ""}`;
      aFillEl.style.width = `${Math.max(4, aPct)}%`;
    }

    const aSrvEl = $('[data-xb-el="android-srv"]', body);
    if (aSrvEl) aSrvEl.textContent = srv.provider === "codemagic" && srv.state === "running" ? "Codemagic · 构建中" : serverStateLabel(srv.state);

    const aCommitEl = $('[data-xb-el="android-commit"]', body);
    if (aCommitEl) {
      const commitHtml = `<code class="xb-code">${esc((android.latestCommit || "").slice(0, 7))}</code> · ${esc(formatTime(android.latestCommitAt))}`;
      if (aCommitEl.innerHTML !== commitHtml) aCommitEl.innerHTML = commitHtml;
    }

    const aTriggerBtn = $('[data-xb-el="android-trigger-btn"]', body);
    if (aTriggerBtn) {
      aTriggerBtn.disabled = aStatus === "building" || busyAction;
      aTriggerBtn.textContent = aStatus === "building" ? "编译中…" : "重新构建";
    }

    const aLogBtn = $('[data-xb-el="android-log-btn"]', body);
    if (aLogBtn) {
      aLogBtn.textContent = showLog ? "收起日志" : "编译日志";
    }

    // Update iOS Card in place
    const iVerEl = $('[data-xb-el="ios-ver"]', body);
    if (iVerEl) iVerEl.textContent = `${ios.versionName || "1.0.76"} (${ios.ciBuildNumber || 721})`;

    const iPillEl = $('[data-xb-el="ios-pill"]', body);
    if (iPillEl) {
      iPillEl.className = `xb-status-pill ${iStatus === "building" ? "building" : iStatus === "failed" ? "failed" : ""}`;
    }
    const iDotEl = $('[data-xb-el="ios-dot"]', body);
    if (iDotEl) {
      iDotEl.className = `xb-dot ${iStatus === "building" ? "building" : iStatus === "failed" ? "failed" : ""}`;
    }
    const iStatusTextEl = $('[data-xb-el="ios-status-text"]', body);
    if (iStatusTextEl) iStatusTextEl.textContent = statusLabel(iStatus, true);

    const iStageEl = $('[data-xb-el="ios-stage"]', body);
    if (iStageEl) iStageEl.textContent = ios.stage || "—";

    const iPct = Math.max(0, Math.min(100, Number(ios.progress ?? 100)));
    const iPctEl = $('[data-xb-el="ios-pct"]', body);
    if (iPctEl) iPctEl.textContent = `${iPct}%`;

    const iFillEl = $('[data-xb-el="ios-fill"]', body);
    if (iFillEl) {
      iFillEl.className = `xb-progress-fill ${iStatus === "building" ? "building" : ""}`;
      iFillEl.style.width = `${Math.max(4, iPct)}%`;
    }

    const iArchiveEl = $('[data-xb-el="ios-archive"]', body);
    if (iArchiveEl) {
      const archiveHtml = `Build #${esc(ios.ciBuildNumber || 721)} · <code class="xb-code">${esc((ios.latestCommit || "").slice(0, 7))}</code>`;
      if (iArchiveEl.innerHTML !== archiveHtml) iArchiveEl.innerHTML = archiveHtml;
    }

    // Update Log Section in place without resetting scroll
    const logSection = $('[data-xb-el="log-section"]', body);
    const logBox = $('[data-xb-el="log-box"]', body);
    if (logSection) {
      logSection.hidden = !showLog;
    }
    if (showLog && logBox) {
      applyLogTextPreservingScroll(logBox, logText || "正在读取编译日志…");
    }

    // Update History Tabs & List in place
    body.querySelectorAll("[data-xb-tab-select]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.xbTabSelect === activeTab);
    });

    const androidItems = (android.releases || []).map((r, idx) => ({
      platform: "android",
      ...r,
      rank: idx + 1,
    }));
    const iosItems = (ios.runs || []).map((r, idx) => ({
      platform: "ios",
      ...r,
      rank: idx + 1,
    }));

    let historyRows = [];
    if (activeTab === "android") {
      historyRows = androidItems;
    } else if (activeTab === "ios") {
      historyRows = iosItems;
    } else {
      const maxLen = Math.max(androidItems.length, iosItems.length);
      for (let i = 0; i < maxLen; i++) {
        if (androidItems[i]) historyRows.push(androidItems[i]);
        if (iosItems[i]) historyRows.push(iosItems[i]);
      }
    }

    const historyList = $('[data-xb-el="history-list"]', body);
    if (historyList) {
      const historyHtml = historyRows
        .map((item) => {
          if (item.platform === "android") {
            return `
              <div class="xb-history-item ${item.available ? "retained" : ""}">
                <div class="xb-history-main">
                  <div class="xb-history-top">
                    <span class="xb-platform-badge android">Android</span>
                    <code class="xb-code">${esc(item.versionName || "1.0.76")} (${esc(item.buildNumber || 78)})</code>
                    <code class="xb-code">${esc(item.shortCommit)}</code>
                    <span style="font-size:11px;color:var(--xb-muted)">${esc(formatTime(item.createdAt))}</span>
                  </div>
                  <p class="xb-history-msg">${esc(item.message)}</p>
                </div>
                ${
                  item.available
                    ? `<button type="button" class="xb-btn primary xb-history-action" data-xb-action="download-commit" data-commit="${esc(item.commit)}">
                        ↓ 下载 APK (${esc(formatBytes(item.size))})
                      </button>`
                    : `<span class="xb-tag pruned" style="align-self:flex-start">旧包已清理</span>`
                }
              </div>
            `;
          }
          return `
            <div class="xb-history-item">
              <div class="xb-history-main">
                <div class="xb-history-top">
                  <span class="xb-platform-badge ios">iOS</span>
                  <code class="xb-code">${esc(item.versionName || "1.0.76")} (${esc(item.buildNumber || 721)})</code>
                  <code class="xb-code">${esc(item.shortCommit)}</code>
                  <span style="font-size:11px;color:var(--xb-muted)">${esc(formatTime(item.createdAt))}</span>
                  <span class="xb-tag ios-tag">${esc(statusLabel(item.status, true))}</span>
                </div>
                <p class="xb-history-msg">${esc(item.message)}</p>
              </div>
            </div>
          `;
        })
        .join("");

      if (historyList.dataset.renderedHtml !== historyHtml) {
        const prevBodyTop = body.scrollTop;
        historyList.innerHTML = historyHtml;
        historyList.dataset.renderedHtml = historyHtml;
        body.scrollTop = prevBodyTop;
      }
    }
  }

  async function refreshOverview(force = false) {
    try {
      const sheet = $("#xuanyuBuildSheet");
      const sheetOpen = Boolean(sheet && !sheet.hidden);
      const [overview, logResp] = await Promise.all([
        api(`/api/overview${force ? "?refresh=1" : ""}`),
        sheetOpen && showLog ? api("/api/log").catch(() => ({ log: logText })) : Promise.resolve(null),
      ]);
      overviewData = overview;
      if (logResp && typeof logResp.log === "string") {
        logText = logResp.log;
      }
      renderMoreMenuWidget();
      if (sheetOpen) {
        renderBuildSheet();
      }
    } catch (err) {
      if ($("#xuanyuBuildSheet") && !$("#xuanyuBuildSheet").hidden) {
        toast(err.message || "无法读取构建状态");
      }
    }
  }

  function openBuildSheet(initialTab = null) {
    if (initialTab) activeTab = initialTab;
    const moreMenu = $("#chatMoreMenu");
    if (moreMenu && moreMenu.classList.contains("open")) {
      moreMenu.classList.remove("open");
      moreMenu.setAttribute("aria-hidden", "true");
      $("#chatMoreButton")?.setAttribute("aria-expanded", "false");
    }
    const sheet = $("#xuanyuBuildSheet");
    if (!sheet) return;
    sheet.hidden = false;
    renderBuildSheet();
    void refreshOverview(false);
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (sheet.hidden) {
        clearInterval(pollTimer);
        return;
      }
      void refreshOverview(false);
    }, 6000);
  }

  function closeBuildSheet() {
    const sheet = $("#xuanyuBuildSheet");
    if (sheet) sheet.hidden = true;
    clearInterval(pollTimer);
  }

  function mountUi() {
    const moreMenu = $("#chatMoreMenu");
    if (moreMenu && !$("#xuanyuMoreWidget")) {
      const widget = document.createElement("div");
      widget.id = "xuanyuMoreWidget";
      widget.className = "xb-more-widget";
      moreMenu.insertBefore(widget, moreMenu.firstChild);
    }

    if (!$("#xuanyuBuildSheet")) {
      const sheet = document.createElement("aside");
      sheet.id = "xuanyuBuildSheet";
      sheet.className = "xb-sheet";
      sheet.hidden = true;
      sheet.innerHTML = `
        <button type="button" class="xb-backdrop" id="xuanyuBuildBackdrop" aria-label="关闭构建中心"></button>
        <section class="xb-panel" role="dialog" aria-modal="true" aria-labelledby="xuanyuBuildTitle">
          <header class="xb-panel-header">
            <div class="xb-panel-brand">
              <span class="xb-panel-icon">${buildIconSvg}</span>
              <div class="xb-panel-titles">
                <h2 id="xuanyuBuildTitle">玄遇构建</h2>
                <p>Flutter-app · 自动构建</p>
              </div>
            </div>
            <div class="xb-panel-controls">
              <button type="button" class="xb-icon-btn" id="xuanyuRefreshBtn">↻ 刷新</button>
              <button type="button" class="xb-close-btn" id="xuanyuCloseBtn" aria-label="关闭">×</button>
            </div>
          </header>
          <div class="xb-body" id="xuanyuBuildBody"></div>
        </section>
      `;
      document.body.appendChild(sheet);
    }

    renderMoreMenuWidget();

    $("#chatMoreButton")?.addEventListener("click", () => {
      void refreshOverview(false);
    });

    $("#xuanyuMoreWidget")?.addEventListener("click", (e) => {
      const actionEl = e.target.closest("[data-xb-action]");
      if (!actionEl) {
        openBuildSheet();
        return;
      }
      const action = actionEl.dataset.xbAction;
      if (action === "open-sheet") {
        e.stopPropagation();
        openBuildSheet(actionEl.dataset.xbTab || "all");
      }
    });

    $("#xuanyuBuildBackdrop")?.addEventListener("click", closeBuildSheet);
    $("#xuanyuCloseBtn")?.addEventListener("click", closeBuildSheet);
    $("#xuanyuRefreshBtn")?.addEventListener("click", async () => {
      await refreshOverview(true);
      toast("已刷新");
    });

    $("#xuanyuBuildBody")?.addEventListener("click", async (e) => {
      const tabBtn = e.target.closest("[data-xb-tab-select]");
      if (tabBtn) {
        activeTab = tabBtn.dataset.xbTabSelect;
        renderBuildSheet();
        return;
      }
      const btn = e.target.closest("[data-xb-action]");
      if (!btn) return;
      const action = btn.dataset.xbAction;

      if (action === "download-commit") {
        const commit = btn.dataset.commit;
        const rel = (overviewData?.android?.releases || []).find((r) => r.commit === commit);
        triggerApkDownload(rel);
        return;
      }

      if (action === "toggle-log" || action === "refresh-log") {
        if (action === "toggle-log") showLog = !showLog;
        if (showLog) {
          const l = await api("/api/log").catch(() => ({ log: "暂无日志" }));
          logText = l.log || "";
        }
        renderBuildSheet();
        return;
      }

      if (action === "trigger-build" || action === "rebuild-commit") {
        if (busyAction) return;
        busyAction = true;
        try {
          const targetCommit = btn.dataset.commit || overviewData?.android?.latestCommit;
          const res = await api("/api/build/trigger", "POST", { commit: targetCommit });
          toast(res.message || "已提交 Codemagic 免费构建");
          await refreshOverview(false);
        } catch (err) {
          toast(err.message);
        } finally {
          busyAction = false;
        }
      }
    });

    void refreshOverview(false);
    setInterval(() => {
      if (overviewData?.android?.status === "building" || overviewData?.ios?.status === "building") {
        void refreshOverview(false);
      }
    }, 10000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountUi);
  } else {
    mountUi();
  }
})();
