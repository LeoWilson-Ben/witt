#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${WITT_NODE_BIN:-/opt/witt-tools/node-v22.16.0-linux-x64/bin/node}"
if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node)"
fi
SRC_WEB="$ROOT_DIR/web"
DST_WEB="${WITT_WEB_ROOT:-/var/www/witt}"

echo "==> 1. Building minified CSS bundles"
"$NODE_BIN" "$ROOT_DIR/scripts/build-web-css.js"

echo "==> 2. Running syntax & unit checks"
bash "$ROOT_DIR/scripts/check-all.sh"

echo "==> 3. Syncing active web assets ($SRC_WEB -> $DST_WEB)"
ACTIVE_CSS="$(grep -oE '/vault/[^"?]+\.css' "$SRC_WEB/index.html" | sed 's|^/vault/||' | sort -u)"
ACTIVE_CSS="$(printf '%s\nboot-w.css\n' "$ACTIVE_CSS" | sort -u)"

updated=0
unchanged=0
for src in "$SRC_WEB"/*; do
  [ -f "$src" ] || continue
  base="$(basename "$src")"
  case "$base" in
    update.example.json) continue ;;
    *.css)
      if ! printf '%s\n' "$ACTIVE_CSS" | grep -Fxq "$base"; then
        continue
      fi
      ;;
  esac
  dst="$DST_WEB/$base"
  if [ ! -f "$dst" ] || ! cmp -s "$src" "$dst"; then
    install -m 0644 "$src" "$dst"
    echo "  SYNC  $base"
    updated=$((updated + 1))
  else
    unchanged=$((unchanged + 1))
  fi
done

removed=0
for dst in "$DST_WEB"/*.css; do
  [ -f "$dst" ] || continue
  base="$(basename "$dst")"
  if ! printf '%s\n' "$ACTIVE_CSS" | grep -Fxq "$base"; then
    rm -f "$dst"
    removed=$((removed + 1))
  fi
done
echo "Web sync done (updated=$updated, unchanged=$unchanged, pruned_unused_css=$removed)"

echo "==> 4. Checking witt.service health"
systemctl is-active witt.service >/dev/null
health="$(curl -sS -w ' HTTP %{http_code}' http://127.0.0.1:3003/health)"
echo "Health: $health"
