(() => {
  "use strict";

  const STORAGE_KEY = "witt_input_history_v1";
  const MAX_HISTORY = 120;

  const SLASH_TOOLS = [
    { cmd: "/canvas ", tool: "canvas", hint: "Canvas 画布" },
    { cmd: "/research ", tool: "research", hint: "Deep Research" },
    { cmd: "/image ", tool: "image", hint: "生成图片" },
    { cmd: "/search ", tool: "search", hint: "联网搜索" },
  ];

  const BUILTIN_PHRASES = [
    "帮我检查一下这段代码有没有隐藏的 Bug 或性能问题",
    "帮我写一个自包含的单文件交互网页演示",
    "帮我优化一下这段文案，让表达更简洁自然",
    "帮我排查一下这个报错的根本原因并给出修复方案",
    "帮我总结这份文档的核心要点和关键结论",
    "帮我对比一下这几个方案的优缺点和适用场景",
    "帮我生成一个完整的配置文件并校验语法",
    "帮我查一下服务器的运行状态和最近日志",
    "帮我重构这段代码，提升可读性和可维护性",
    "请把下面这段内容翻译成自然流畅的中文",
    "请把下面这段内容翻译成地道简洁的英文",
    "请整理成清晰的 Markdown 表格进行对比",
    "请用通俗易懂的语言解释一下背后的原理",
    "请给出一份分步骤的可执行实施方案",
    "请先分析原因，不要直接修改代码",
    "请先列出修改计划，确认后再动手",
    "给我画一张高质量、构图精致的配图",
    "给我做一个可交互的数据可视化页面",
    "解释一下这段代码每一部分的作用",
    "分析一下为什么会出现这个问题",
    "看看当前服务的健康状态是否正常",
    "有没有更简洁优雅的实现方式？",
    "能不能把这个界面做得更精致一点？",
    "继续完善刚才的方案，补充边界情况处理",
    "总结一下我们刚才讨论的最终结论",
    "写出对应的单元测试并运行验证",
    "检查一下 Nginx 配置和 SSL 证书状态",
    "优化一下手机端和暗黑模式的显示效果",
    "Explain how this works step by step",
    "Summarize the key takeaways in bullet points",
    "Refactor this code for clarity and performance",
    "Find the root cause of this error and fix it",
  ];

  let historyList = loadHistory();
  let composing = false;
  let dismissedValue = "";
  let currentSuggestion = null; // { full, suffix, slashTool? }
  let textarea = null;
  let mirror = null;
  let acceptPill = null;

  function loadHistory() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      return Array.isArray(raw) ? raw.filter((s) => typeof s === "string" && s.trim().length >= 3).slice(0, MAX_HISTORY) : [];
    } catch {
      return [];
    }
  }

  function saveHistory() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(historyList.slice(0, MAX_HISTORY)));
    } catch {}
  }

  function rememberPhrase(text) {
    const clean = String(text || "").trim().replace(/\s+/g, " ");
    if (clean.length < 3 || clean.length > 180) return;
    if (clean.startsWith("/")) return;
    historyList = [clean, ...historyList.filter((item) => item !== clean)].slice(0, MAX_HISTORY);
    saveHistory();
  }

  function harvestHistoryFromDom() {
    const nodes = document.querySelectorAll("#messageList .message.user .user-message-rich");
    if (!nodes.length) return;
    let changed = false;
    nodes.forEach((node) => {
      const text = (node.textContent || "").trim().replace(/\s+/g, " ");
      if (text.length >= 4 && text.length <= 160 && !historyList.includes(text)) {
        historyList.push(text);
        changed = true;
      }
    });
    if (changed) {
      historyList = historyList.slice(0, MAX_HISTORY);
      saveHistory();
    }
  }

  function projectShortcuts() {
    const items = [];
    document.querySelectorAll("#projectShortcutsStrip button").forEach((btn) => {
      const prompt = (btn.dataset.prompt || btn.getAttribute("title") || btn.textContent || "").trim();
      if (prompt.length >= 3) items.push(prompt);
    });
    return items;
  }

  function escapeHtml(str) {
    return String(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  function findMatch(value) {
    if (!value || value.includes("\n")) return null;
    if (value === dismissedValue) return null;

    // 1. Slash tool commands
    if (value.startsWith("/")) {
      const lower = value.toLowerCase();
      for (const item of SLASH_TOOLS) {
        if (item.cmd.startsWith(lower) && item.cmd.length > value.length) {
          return { full: item.cmd, suffix: item.cmd.slice(value.length), slashTool: item.tool };
        }
      }
      return null;
    }

    // Require at least 1 CJK char or 2 ASCII chars
    const hasCjk = /[\u4e00-\u9fff]/.test(value);
    if (!hasCjk && value.trim().length < 2) return null;

    const lower = value.toLowerCase();
    const pools = [historyList, projectShortcuts(), BUILTIN_PHRASES];

    for (const pool of pools) {
      for (const candidate of pool) {
        if (!candidate || candidate.length <= value.length) continue;
        if (candidate.toLowerCase().startsWith(lower)) {
          const suffix = candidate.slice(value.length);
          if (suffix.trim().length > 0) {
            return { full: value + suffix, suffix };
          }
        }
      }
    }
    return null;
  }

  function syncMirrorMetrics() {
    if (!textarea || !mirror) return;
    const cs = window.getComputedStyle(textarea);
    mirror.style.fontFamily = cs.fontFamily;
    mirror.style.fontSize = cs.fontSize;
    mirror.style.fontWeight = cs.fontWeight;
    mirror.style.lineHeight = cs.lineHeight;
    mirror.style.letterSpacing = cs.letterSpacing;
    mirror.style.paddingTop = cs.paddingTop;
    mirror.style.paddingRight = cs.paddingRight;
    mirror.style.paddingBottom = cs.paddingBottom;
    mirror.style.paddingLeft = cs.paddingLeft;
    mirror.style.textAlign = cs.textAlign;
    mirror.scrollTop = textarea.scrollTop;
  }

  function clearGhost() {
    currentSuggestion = null;
    if (mirror) mirror.innerHTML = "";
    if (acceptPill) acceptPill.hidden = true;
  }

  function updateGhost() {
    if (!textarea || !mirror) return;
    if (composing || textarea.disabled) {
      clearGhost();
      return;
    }
    const value = textarea.value;
    const atEnd = textarea.selectionStart === value.length && textarea.selectionEnd === value.length;
    if (!atEnd) {
      clearGhost();
      return;
    }
    const match = findMatch(value);
    if (!match) {
      clearGhost();
      return;
    }
    currentSuggestion = match;
    syncMirrorMetrics();
    mirror.innerHTML =
      `<span class="ghost-prefix">${escapeHtml(value)}</span>` +
      `<span class="ghost-suffix">${escapeHtml(match.suffix)}</span>` +
      `<kbd class="ghost-kbd">Tab</kbd>`;
    if (acceptPill) acceptPill.hidden = false;
  }

  function acceptSuggestion() {
    if (!textarea || !currentSuggestion) return false;
    const chosen = currentSuggestion;
    clearGhost();

    if (chosen.slashTool) {
      textarea.value = "";
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      const modeBtn = document.querySelector(`#toolsMenu [data-tool-mode="${chosen.slashTool}"]`);
      if (modeBtn) modeBtn.click();
      textarea.focus();
      return true;
    }

    textarea.value = chosen.full;
    textarea.selectionStart = textarea.selectionEnd = chosen.full.length;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.focus();
    return true;
  }

  function mount() {
    textarea = document.getElementById("messageInput");
    if (!textarea || textarea.dataset.ghostMounted === "1") return;
    textarea.dataset.ghostMounted = "1";

    const parent = textarea.parentElement;
    if (!parent) return;

    const shell = document.createElement("div");
    shell.className = "composer-input-shell";
    shell.id = "composerInputShell";

    mirror = document.createElement("div");
    mirror.className = "composer-ghost-mirror";
    mirror.id = "composerGhostMirror";
    mirror.setAttribute("aria-hidden", "true");

    parent.insertBefore(shell, textarea);
    shell.appendChild(mirror);
    shell.appendChild(textarea);

    const toolbar = document.querySelector(".composer-toolbar");
    const sendBtn = document.getElementById("sendButton");
    if (toolbar && sendBtn) {
      acceptPill = document.createElement("button");
      acceptPill.type = "button";
      acceptPill.className = "ghost-accept-pill";
      acceptPill.id = "ghostAcceptPill";
      acceptPill.hidden = true;
      acceptPill.textContent = "Tab 补全";
      acceptPill.setAttribute("aria-label", "采纳输入补全建议");
      acceptPill.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        acceptSuggestion();
      });
      toolbar.insertBefore(acceptPill, sendBtn);
    }

    textarea.addEventListener("compositionstart", () => {
      composing = true;
      clearGhost();
    });
    textarea.addEventListener("compositionend", () => {
      composing = false;
      dismissedValue = "";
      requestAnimationFrame(updateGhost);
    });
    textarea.addEventListener("input", () => {
      if (textarea.value !== dismissedValue) dismissedValue = "";
      updateGhost();
    });
    textarea.addEventListener("scroll", () => {
      if (mirror) mirror.scrollTop = textarea.scrollTop;
    });
    textarea.addEventListener("click", updateGhost);
    textarea.addEventListener("keyup", (e) => {
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
        updateGhost();
      }
    });
    textarea.addEventListener("blur", () => {
      setTimeout(() => {
        if (document.activeElement !== textarea) clearGhost();
      }, 120);
    });
    textarea.addEventListener("focus", () => {
      harvestHistoryFromDom();
      updateGhost();
    });

    textarea.addEventListener("keydown", (e) => {
      if (composing || e.isComposing) return;
      if (e.key === "Tab" && currentSuggestion) {
        e.preventDefault();
        e.stopPropagation();
        acceptSuggestion();
        return;
      }
      if (e.key === "ArrowRight" && currentSuggestion &&
          textarea.selectionStart === textarea.value.length &&
          textarea.selectionEnd === textarea.value.length) {
        e.preventDefault();
        acceptSuggestion();
        return;
      }
      if (e.key === "Escape" && currentSuggestion) {
        dismissedValue = textarea.value;
        clearGhost();
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (textarea.value.trim()) rememberPhrase(textarea.value);
        clearGhost();
      }
    }, true);

    document.getElementById("sendButton")?.addEventListener("click", () => {
      if (textarea?.value?.trim()) rememberPhrase(textarea.value);
      clearGhost();
    }, true);

    window.addEventListener("resize", syncMirrorMetrics);
    setTimeout(harvestHistoryFromDom, 1500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }
})();
