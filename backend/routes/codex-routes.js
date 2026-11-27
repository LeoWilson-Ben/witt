"use strict";

function createCodexRouter({
  codexAccountService,
  claudeAccountService,
  antigravityAccountService,
  antigravity2AccountService,
  claimStandby,
  sendJson,
}) {
  return function handleCodexAndFailover(req, res, url, principal) {
    if (url.pathname === "/failover/claim") {
      if (req.method !== "POST") {
        sendJson(res, 405, { error: "请求方式不支持" });
        return true;
      }
      claimStandby().then(({ status, body }) => sendJson(res, status, body));
      return true;
    }
    if (url.pathname === "/codex/accounts") {
      if (req.method !== "GET") {
        sendJson(res, 405, { error: "请求方式不支持" });
        return true;
      }
      const extraAccounts = Promise.allSettled([
        ...(principal.admin ? [claudeAccountService.card(principal)] : []),
        ...((principal.admin || principal.codexProfiles?.includes("antigravity"))
          ? [antigravityAccountService.card(principal)]
          : []),
        ...(antigravity2AccountService && (principal.admin || principal.codexProfiles?.includes("antigravity2"))
          ? [antigravity2AccountService.card(principal)]
          : []),
      ]).then((results) => results.filter((r) => r.status === "fulfilled").map((r) => r.value));
      extraAccounts.then((accounts) => codexAccountService.list(
        res,
        principal.admin ? null : (principal.codexProfiles || ["default"]),
        accounts,
      ));
      return true;
    }
    const codexLoginMatch = url.pathname.match(
      /^\/codex\/accounts\/([a-z0-9-]+)\/login\/(start|status|cancel)$/,
    );
    if (!codexLoginMatch) return false;
    if (!principal.admin) {
      sendJson(res, 403, { error: "仅管理员可管理 Codex 账号" });
      return true;
    }
    const [, profileId, action] = codexLoginMatch;
    if (action === "start" && req.method === "POST") {
      codexAccountService.startLogin(res, profileId);
      return true;
    }
    if (action === "status" && req.method === "GET") {
      codexAccountService.loginStatus(res, profileId);
      return true;
    }
    if (action === "cancel" && req.method === "POST") {
      codexAccountService.cancelLogin(res, profileId);
      return true;
    }
    sendJson(res, 405, { error: "请求方式不支持" });
    return true;
  };
}

module.exports = { createCodexRouter };
