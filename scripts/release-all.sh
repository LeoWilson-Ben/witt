#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${WITT_NODE_BIN:-/opt/witt-tools/node-v22.16.0-linux-x64/bin/node}"
if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node)"
fi

WEB_ROOT="${WITT_WEB_ROOT:-/var/www/witt}"
JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk-amd64}"
ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
GRADLE_BIN="${WITT_GRADLE_BIN:-/opt/witt-tools/gradle-8.11.1/bin/gradle}"
APKSIGNER_BIN="${WITT_APKSIGNER_BIN:-$ANDROID_HOME/build-tools/35.0.0/apksigner}"
SIGNING_PROPS="${WITT_SIGNING_PROPERTIES:-/etc/witt/android-signing/signing.properties}"

PRIMARY_ORIGIN="${WITT_PRIMARY_ORIGIN:-https://d3ej747b1y0btw.cloudfront.net}"
FALLBACK_ORIGIN="${WITT_FALLBACK_ORIGIN:-https://leowilson.duckdns.org}"

DO_CHECK=0
DO_WEB=0
DO_APK=0
DO_PUBLISH_APK=0
DO_LINT=0
RESTART_BACKEND=1
VERSION_CODE=""
VERSION_NAME=""
RELEASE_NOTES=""

usage() {
  cat <<'EOF'
Usage: scripts/release-all.sh [options]

Modes (at least one required):
  --check                     Run full backend, regression, TypeScript, Vitest, and Vite build checks
  --web                       Run --check, atomically deploy web-dist -> /var/www/witt with backup & rollback
  --apk                       Build signed Android release APK and verify with apksigner

Options:
  --no-restart                Do not restart witt.service during --web deploy
  --lint                      Also run :app:lintVitalRelease during --apk build
  --version-code <N>          Android versionCode (required with --publish)
  --version-name <V>          Android versionName, e.g. 2.2.33 (required with --publish)
  --notes "<text>"            Release notes for update.json when publishing APK
  --publish                   Publish built APK to /var/www/witt/witt-<V>.apk and atomically update update.json
  -h, --help                  Show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check) DO_CHECK=1 ;;
    --web) DO_WEB=1 ;;
    --apk) DO_APK=1 ;;
    --publish) DO_PUBLISH_APK=1 ;;
    --lint) DO_LINT=1 ;;
    --no-restart) RESTART_BACKEND=0 ;;
    --version-code) VERSION_CODE="${2:?missing value for --version-code}"; shift ;;
    --version-name) VERSION_NAME="${2:?missing value for --version-name}"; shift ;;
    --notes) RELEASE_NOTES="${2:-}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [ "$DO_CHECK" -eq 0 ] && [ "$DO_WEB" -eq 0 ] && [ "$DO_APK" -eq 0 ]; then
  usage >&2
  exit 2
fi

run_checks() {
  echo "==> [release-all] Running full verification suite (scripts/check-all.sh)"
  bash "$ROOT_DIR/scripts/check-all.sh"
}

verify_web_health() {
  local health_code index_code asset_path asset_code
  health_code="$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3003/health)"
  [ "$health_code" = "200" ] || { echo "Health check failed: HTTP $health_code" >&2; return 1; }

  if [ -f "$WEB_ROOT/index.html" ]; then
    asset_path="$(grep -oE '/vault/assets/[^"]+\.js' "$WEB_ROOT/index.html" | head -n 1 || true)"
    if [ -n "$asset_path" ]; then
      local rel="${asset_path#/vault/}"
      [ -r "$WEB_ROOT/$rel" ] || { echo "Missing built asset: $WEB_ROOT/$rel" >&2; return 1; }
    fi
  fi

  index_code="$(curl -sk -o /dev/null -w '%{http_code}' https://127.0.0.1/vault/index.html || true)"
  if [ "$index_code" = "200" ]; then
    echo "Verified local Nginx /vault/index.html -> HTTP $index_code"
  else
    echo "Local Nginx check returned HTTP ${index_code:-n/a} (skipped strict fail if Nginx bound to specific SNI)"
  fi
  echo "Verified backend /health -> HTTP $health_code"
}

deploy_web() {
  local src_dir="$ROOT_DIR/web-dist"
  local stamp backup_dir
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_dir="${WEB_ROOT}.bak-${stamp}"

  [ -d "$src_dir" ] && [ -f "$src_dir/index.html" ] || {
    echo "ERROR: $src_dir/index.html not found; run build-web-v3.js first" >&2
    exit 1
  }

  echo "==> [release-all] Backing up $WEB_ROOT -> $backup_dir"
  cp -a "$WEB_ROOT" "$backup_dir"

  rollback() {
    echo "!! Deployment verification failed; rolling back $WEB_ROOT from $backup_dir" >&2
    rsync -a --delete "$backup_dir/" "$WEB_ROOT/"
    chmod -R a+rX "$WEB_ROOT"
    if [ "$RESTART_BACKEND" -eq 1 ]; then
      systemctl restart witt.service || true
    fi
  }

  echo "==> [release-all] Syncing $src_dir -> $WEB_ROOT (preserving APK & update manifests)"
  if ! rsync -a --delete \
      --exclude 'update.json' \
      --exclude 'update-*.json' \
      --exclude 'witt-*.apk' \
      "$src_dir/" "$WEB_ROOT/"; then
    rollback
    exit 1
  fi
  chmod -R a+rX "$WEB_ROOT"

  if [ "$RESTART_BACKEND" -eq 1 ]; then
    echo "==> [release-all] Restarting witt.service"
    if ! systemctl restart witt.service; then
      rollback
      exit 1
    fi
    sleep 1
  fi

  if ! verify_web_health; then
    rollback
    exit 1
  fi

  echo "==> [release-all] Web deployment succeeded (backup retained at $backup_dir)"
}

build_and_verify_apk() {
  if [ "$DO_PUBLISH_APK" -eq 1 ]; then
    [ -n "$VERSION_CODE" ] && [ -n "$VERSION_NAME" ] || {
      echo "ERROR: --publish requires both --version-code and --version-name" >&2
      exit 2
    }
  fi

  [ -x "$GRADLE_BIN" ] || { echo "ERROR: Gradle not found at $GRADLE_BIN" >&2; exit 1; }
  [ -d "$JAVA_HOME" ] || { echo "ERROR: JAVA_HOME not found at $JAVA_HOME" >&2; exit 1; }
  [ -d "$ANDROID_HOME" ] || { echo "ERROR: ANDROID_HOME not found at $ANDROID_HOME" >&2; exit 1; }
  [ -f "$SIGNING_PROPS" ] || { echo "ERROR: Signing properties not found at $SIGNING_PROPS" >&2; exit 1; }

  export JAVA_HOME ANDROID_HOME
  export PATH="$JAVA_HOME/bin:$PATH"

  local gradle_tasks=(":app:assembleRelease")
  if [ "$DO_LINT" -eq 1 ]; then
    gradle_tasks+=(":app:lintVitalRelease")
  fi

  local gradle_args=(
    -p "$ROOT_DIR/android"
    "${gradle_tasks[@]}"
    --max-workers=1
    "-Dorg.gradle.jvmargs=-Xmx1024m -Dfile.encoding=UTF-8"
    "-PwittSigningProperties=$SIGNING_PROPS"
    "-PwittApplicationId=com.selfhosted.witt"
    "-PwittAppLabel=Witt"
    "-PwittWebUrl=${PRIMARY_ORIGIN}/vault/index.html"
    "-PwittApiUrl=${PRIMARY_ORIGIN}/vault-api/"
    "-PwittUpdateUrl=${PRIMARY_ORIGIN}/vault/update.json"
    "-PwittFallbackWebUrl=${FALLBACK_ORIGIN}/vault/index.html"
    "-PwittFallbackApiUrl=${FALLBACK_ORIGIN}/vault-api/"
  )
  if [ -n "$VERSION_CODE" ]; then
    gradle_args+=("-PwittVersionCode=$VERSION_CODE")
  fi
  if [ -n "$VERSION_NAME" ]; then
    gradle_args+=("-PwittVersionName=$VERSION_NAME")
  fi

  echo "==> [release-all] Building Android APK (${gradle_tasks[*]})"
  "$GRADLE_BIN" "${gradle_args[@]}"

  local apk_path="$ROOT_DIR/android/app/build/outputs/apk/release/app-release.apk"
  [ -f "$apk_path" ] || { echo "ERROR: Built APK not found at $apk_path" >&2; exit 1; }

  if [ -x "$APKSIGNER_BIN" ]; then
    echo "==> [release-all] Verifying APK signature with apksigner"
    "$APKSIGNER_BIN" verify --verbose "$apk_path" | grep -E 'Verifies|Verified using|Signer #1 certificate SHA-256' || true
    "$APKSIGNER_BIN" verify "$apk_path"
  else
    echo "WARN: apksigner not found at $APKSIGNER_BIN; skipped signature check" >&2
  fi

  local sha256 size_bytes
  sha256="$(sha256sum "$apk_path" | awk '{print $1}')"
  size_bytes="$(stat -c %s "$apk_path")"
  echo "==> [release-all] APK ready: $apk_path"
  echo "    size=$size_bytes bytes"
  echo "    sha256=$sha256"

  if [ "$DO_PUBLISH_APK" -eq 1 ]; then
    local apk_filename="witt-${VERSION_NAME}.apk"
    local dst_apk="$WEB_ROOT/$apk_filename"
    local tmp_manifest="$WEB_ROOT/.update.json.tmp.$$"

    echo "==> [release-all] Publishing $apk_filename -> $dst_apk"
    install -m 0644 "$apk_path" "$dst_apk"

    "$NODE_BIN" -e '
      const fs = require("fs");
      const [outPath, vCode, vName, url, sha, size, notes] = process.argv.slice(1);
      const manifest = {
        versionCode: Number(vCode),
        versionName: vName,
        apkUrl: url,
        sha256: sha,
        size: Number(size),
        notes: notes || `Witt v${vName}`,
        publishedAt: new Date().toISOString()
      };
      fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n");
    ' "$tmp_manifest" "$VERSION_CODE" "$VERSION_NAME" \
      "${PRIMARY_ORIGIN}/vault/${apk_filename}" "$sha256" "$size_bytes" "$RELEASE_NOTES"

    chmod 0644 "$tmp_manifest"
    mv -f "$tmp_manifest" "$WEB_ROOT/update.json"
    echo "==> [release-all] Published $WEB_ROOT/update.json (v${VERSION_NAME}, code=${VERSION_CODE})"
  fi
}

if [ "$DO_CHECK" -eq 1 ] || [ "$DO_WEB" -eq 1 ]; then
  run_checks
fi

if [ "$DO_WEB" -eq 1 ]; then
  deploy_web
fi

if [ "$DO_APK" -eq 1 ]; then
  build_and_verify_apk
fi
