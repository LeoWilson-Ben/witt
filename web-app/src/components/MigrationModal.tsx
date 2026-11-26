import { useEffect, useState } from "preact/hooks";
import {
  activateBrowserInvite,
  fetchAuthStatus,
  isAndroidWebView,
  requestServerMigrationCode,
} from "../bridge/witt-bridge";

const DISMISS_KEY = "witt_server_migration_dismissed";

export function parseMigrationHash(hashValue: string): string {
  const hash = String(hashValue || "");
  if (!hash.startsWith("#migrate=")) return "";
  const raw = hash.slice("#migrate=".length).trim();
  if (!raw) return "";
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    return raw;
  }
}

export function shouldPromptServerMigration(
  authenticated: boolean,
  targetUrl: string | undefined,
  currentOrigin: string,
): boolean {
  if (!authenticated || !targetUrl) return false;
  try {
    return new URL(targetUrl).origin !== currentOrigin;
  } catch {
    return true;
  }
}

export function MigrationModal() {
  const [incomingCode, setIncomingCode] = useState<string>("");
  const [incomingStatus, setIncomingStatus] = useState<{ tone: "info" | "success" | "error"; text: string }>({
    tone: "info",
    text: "正在连接新服务器完成激活…",
  });
  const [incomingFailed, setIncomingFailed] = useState(false);

  const [targetUrl, setTargetUrl] = useState<string>("");
  const [promptOpen, setPromptOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [promptStatus, setPromptStatus] = useState<{ tone: "info" | "success" | "error"; text: string } | null>(null);
  const [fallbackCode, setFallbackCode] = useState("");
  const [jumpUrl, setJumpUrl] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (isAndroidWebView()) return;

    const code = parseMigrationHash(window.location.hash);
    if (code) {
      try {
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      } catch {
        // Ignore history restriction.
      }
      setIncomingCode(code);
      activateBrowserInvite(code)
        .then(() => {
          setIncomingStatus({ tone: "success", text: "迁移激活成功！正在进入新服务器…" });
          setTimeout(() => window.location.reload(), 500);
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error && err.message
            ? `${err.message}。请返回旧服务器重新点击「一键迁移」。`
            : "自动激活失败，请返回旧服务器重试。";
          setIncomingStatus({ tone: "error", text: msg });
          setIncomingFailed(true);
        });
      return;
    }

    const timer = setTimeout(() => {
      fetchAuthStatus()
        .then((data) => {
          const nextTarget = data.serverMigration?.targetUrl || "";
          if (!shouldPromptServerMigration(Boolean(data.authenticated), nextTarget, window.location.origin)) {
            return;
          }
          setTargetUrl(nextTarget);
          let dismissed = false;
          try {
            dismissed = sessionStorage.getItem(DISMISS_KEY) === "1";
          } catch {
            dismissed = false;
          }
          if (!dismissed) setPromptOpen(true);
        })
        .catch(() => {
          // Ignore transient network errors when checking migration banner.
        });
    }, 600);

    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!promptOpen) return;
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        dismissModal();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [promptOpen]);

  function dismissModal() {
    try {
      sessionStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // Ignore storage error.
    }
    setPromptOpen(false);
  }

  async function handleStartMigration() {
    setSubmitting(true);
    setPromptStatus({
      tone: "info",
      text: "正在向新服务器申请一次性迁移凭证（15 分钟有效，仅限本设备）…",
    });
    try {
      const data = await requestServerMigrationCode();
      const nextJumpUrl = `${data.targetUrl}#migrate=${encodeURIComponent(data.code)}`;
      setFallbackCode(data.code);
      setJumpUrl(nextJumpUrl);
      setPromptStatus({
        tone: "success",
        text: "迁移凭证已就绪，正在跳转至新服务器自动登录…",
      });
      window.location.href = nextJumpUrl;
    } catch (err: unknown) {
      const msg = err instanceof Error && err.message ? err.message : "申请迁移凭证失败，请稍后重试。";
      setPromptStatus({ tone: "error", text: msg });
      setSubmitting(false);
    }
  }

  async function handleCopyCode() {
    if (!fallbackCode) return;
    try {
      await navigator.clipboard.writeText(fallbackCode);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  if (incomingCode) {
    return (
      <div class="witt-mig-backdrop">
        <div class="witt-mig-card" role="dialog" aria-modal="true" aria-labelledby="wittMigAutoTitle">
          <div class="witt-mig-badge">账号迁移</div>
          <h2 class="witt-mig-title" id="wittMigAutoTitle">正在自动激活你的原账号</h2>
          <p class="witt-mig-desc">正在校验一次性迁移凭证并绑定当前浏览器，完成后将自动进入 Witt 工作区。</p>
          <div class={`witt-mig-status is-${incomingStatus.tone}`}>{incomingStatus.text}</div>
          {incomingFailed && (
            <div class="witt-mig-actions">
              <button
                type="button"
                class="witt-mig-btn witt-mig-btn-secondary"
                onClick={() => setIncomingCode("")}
              >
                关闭
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (!targetUrl) return null;

  let hostText = targetUrl;
  try {
    hostText = new URL(targetUrl).host;
  } catch {
    hostText = targetUrl;
  }

  return (
    <>
      {!promptOpen && (
        <button
          id="witt-migration-pill"
          type="button"
          class="witt-mig-pill"
          onClick={() => setPromptOpen(true)}
        >
          迁移至新服务器
        </button>
      )}
      {promptOpen && (
        <div
          id="witt-migration-modal"
          class="witt-mig-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) dismissModal();
          }}
        >
          <div class="witt-mig-card" role="dialog" aria-modal="true" aria-labelledby="wittMigTitle">
            <div class="witt-mig-badge">服务器迁移提醒</div>
            <h2 class="witt-mig-title" id="wittMigTitle">Witt 已迁移至新服务器</h2>
            <p class="witt-mig-desc">
              你的账号、全部历史聊天记录与附件已完整同步至新服务器{" "}
              <span class="witt-mig-host">{hostText}</span>
              。点击下方按钮将自动生成专属一次性迁移凭证并免输激活码登录新服务器。
            </p>
            {promptStatus && (
              <div class={`witt-mig-status is-${promptStatus.tone}`}>{promptStatus.text}</div>
            )}
            <div class="witt-mig-actions">
              <button
                type="button"
                class="witt-mig-btn witt-mig-btn-primary"
                disabled={submitting}
                onClick={handleStartMigration}
              >
                {submitting ? "正在跳转…" : promptStatus?.tone === "error" ? "重试一键迁移" : "一键迁移到新服务器"}
              </button>
              <button
                type="button"
                class="witt-mig-btn witt-mig-btn-secondary"
                onClick={dismissModal}
              >
                稍后提醒
              </button>
            </div>
            {fallbackCode && (
              <div class="witt-mig-fallback">
                <button
                  type="button"
                  class="witt-mig-btn witt-mig-btn-secondary"
                  onClick={handleCopyCode}
                >
                  {copied ? "已复制激活码" : "复制一次性激活码（备用）"}
                </button>
                <a
                  class="witt-mig-btn witt-mig-btn-secondary"
                  href={jumpUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  手动打开新服务器
                </a>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
