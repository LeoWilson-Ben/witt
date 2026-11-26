#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${WITT_NODE_BIN:-/opt/witt-tools/node-v22.16.0-linux-x64/bin/node}"
if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node)"
fi

cd "$ROOT_DIR"

TMPDIR="$(mktemp -d /tmp/witt-check-XXXXXX)"
export TMPDIR
trap 'rm -rf "$TMPDIR"' EXIT

passed=0
failed=0
failed_list=()

echo "==> 1. Syntax check (backend/*.js, web/*.js)"
while IFS= read -r f; do
  [ -f "$f" ] || continue
  if "$NODE_BIN" --check "$f" 2>/dev/null; then
    passed=$((passed + 1))
  else
    echo "FAIL syntax: $f"
    "$NODE_BIN" --check "$f" || true
    failed=$((failed + 1))
    failed_list+=("syntax:$f")
  fi
done < <(find backend -name "*.js" -not -path "*/node_modules/*" | sort; find web -maxdepth 1 -name "*.js" | sort)
echo "Syntax checks done (passed=$passed, failed=$failed)"

# Fast, self-contained unit & regression tests (excludes browser/live-server
# tests and legacy pre-equal-permissions / hardcoded-/home/ubuntu tests).
UNIT_TESTS=(
  backend/test-account-capabilities.js
  backend/test-antigravity-messaging.js
  backend/test-antigravity-quota.js
  backend/test-antigravity-settings.js
  backend/test-chat-history-regressions.js
  backend/test-chat-improvements.js
  backend/test-chat-isolation.js
  backend/test-claude-account-service.js
  backend/test-codemagic-android-builder.js
  backend/test-github-android-builder.js
  backend/test-sqlite-store.js
  backend/test-user-projects.js
  backend/test-workspace-overview.js
  tests/account-list-check.cjs
  tests/antigravity-open-login-check.cjs
  tests/auth-service-check.cjs
  tests/chat-approval-check.cjs
  tests/conversation-model-badge-check.cjs
  tests/device-notes-check.cjs
  tests/execution-isolation-check.cjs
  tests/invite-permission-check.cjs
  tests/service-status-check.cjs
  tests/sqlite-store-coalescing-check.cjs
)

echo "==> 2. Unit & regression tests (${#UNIT_TESTS[@]} suites)"
for t in "${UNIT_TESTS[@]}"; do
  [ -f "$t" ] || continue
  if output=$("$NODE_BIN" "$t" 2>&1); then
    echo "PASS $t"
    passed=$((passed + 1))
  else
    echo "FAIL $t"
    echo "$output" | tail -n 20
    failed=$((failed + 1))
    failed_list+=("$t")
  fi
done

echo "=== Summary: passed=$passed, failed=$failed ==="
if [ "$failed" -gt 0 ]; then
  printf 'Failed items:\n'
  printf '  - %s\n' "${failed_list[@]}"
  exit 1
fi
