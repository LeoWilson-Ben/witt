# Claude account connection

The administrator can open **账号与项目 → Claude → 登录账号**. The portal launches the unmodified official `claude auth login` process. The user authenticates on Claude's own website; a returned authorization code is piped to that running process. CLI credentials stay in its private, per-user `CLAUDE_CONFIG_DIR`. Witt only reads the sanitized output of `claude auth status --json`.

Install the official binary on the host, currently pinned to `@anthropic-ai/claude-code@2.1.292` under `/home/ubuntu/.claude-cli`. The backend expects `/home/ubuntu/.claude-cli/node_modules/.bin/claude`. Login directories are `/home/ubuntu/.claude-witt/<Witt user id>` with mode 0700. Do not copy credentials into the API or logs.

The app's existing account-list bridge also works on older Android clients. Its administrator-only Claude entry contains a 15-minute capability in the URL fragment. The portal removes that fragment from browser history and sends the capability only in Authorization headers. It grants only access to the requesting user's login process, not general Witt API access. Each request checks that the issuing device is still an active administrator. No cookies or CORS exceptions are needed, and the portal has a strict CSP and no external resources.

This change adds account connection and status only. It does not provide a Claude conversation adapter or silently change the provider of an existing Codex conversation. No subscription inference was tested without an account authorized by its owner.

Official references:
- https://code.claude.com/docs/en/authentication
- https://code.claude.com/docs/en/cli-reference
- https://code.claude.com/docs/en/legal-and-compliance

Checks:
- `node --test backend/test-claude-account-service.js`
- `node tests/claude-login-check.mjs` (Playwright; mobile and desktop)
- The pre-existing full `tests/ui-check.mjs` currently fails at its approval-choice count assertion, also reproduced against the unchanged baseline commit 32199fa. This unrelated assertion was not weakened.

# Osaka independent Android release

Version 2.2.21 (40) uses package `com.codevibe.dropvault.osaka` and label `Witt 大阪`. The owner authorized a new signing identity rather than requiring an in-place upgrade. Keep the prior application installed if its local settings are needed; the independent package requires signing in again.

Web, API and update metadata now point to `upload.13.208.127.58.sslip.io`. No endpoint uses the deleted `upload.16.208.20.133.sslip.io` server. The new update channel is `/vault/update-osaka.json`, separate from the original package's manifest so it is never advertised as a same-package upgrade.

The new keystore and signing properties are stored outside Git at `/home/ubuntu/.config/witt-signing/` (directory 0700; files 0600). Future Osaka APKs must keep this package id and signing identity. Build unsigned on the x86_64 builder and sign on the main server so the private key never needs to leave its host. Publish an update manifest only after verifying the signed APK's package, version, certificate, and hash.
