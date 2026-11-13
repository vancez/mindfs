#!/usr/bin/env bash
# Build self-contained macOS/Linux/Windows archives locally.
#
# Usage:
#   bash scripts/build-local.sh
#   VERSION=v0.5.8 bash scripts/build-local.sh
#   PLATFORMS="linux/amd64 linux/arm64 windows/amd64 darwin/arm64" bash scripts/build-local.sh
#   SKIP_WEB_BUILD=1 bash scripts/build-local.sh
#
# WSL:
#   Non-interactive shells do not source ~/.bashrc, so fnm is activated
#   explicitly for the web build (set USE_FNM=0 to skip). Node/npm must be the
#   Linux build; the Windows node reached through /mnt/c interop is rejected.
#   If web/node_modules is missing or was installed on Windows, the script
#   reinstalls dependencies with npm ci using the WSL Node.js. Set
#   WEB_NPM_INSTALL=0 to disable that and fail with instructions instead.
#
# Each archive contains the CLI binary, web/ (the built frontend), agents.json
# and task_template.json. Windows, Linux and macOS all use .tar.gz by design.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WEB_DIR="${WEB_DIR:-$ROOT/web}"
DIST_DIR="${DIST_DIR:-$ROOT/dist}"
GO="${GO:-go}"
NPM="${NPM:-npm}"
VERSION="${VERSION:-$(git -C "$ROOT" describe --tags --abbrev=0 2>/dev/null || echo dev)}"
VERSION="${VERSION//\//-}"
PLATFORMS="${PLATFORMS:-linux/amd64 windows/amd64 darwin/arm64}"

is_wsl() {
  [[ -n "${WSL_DISTRO_NAME:-}" ]] && return 0
  [[ -r /proc/version ]] && grep -qiE 'microsoft|wsl' /proc/version
}

find_fnm() {
  local candidate
  if command -v fnm >/dev/null 2>&1; then
    candidate="$(command -v fnm)"
    # Ignore a Windows fnm reached through /mnt/c interop: its `fnm env`
    # output uses Windows paths and would break the Linux shell.
    if ! is_wsl || [[ "$candidate" != /mnt/[a-z]/* ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi
  for candidate in \
    "${FNM_DIR:+${FNM_DIR}/fnm}" \
    "$HOME/.local/share/fnm/fnm" \
    "$HOME/.local/bin/fnm" \
    "$HOME/bin/fnm" \
    "$HOME/.fnm/fnm" \
    "$HOME/.cargo/bin/fnm" \
    /usr/local/bin/fnm \
    /usr/bin/fnm; do
    if [[ -n "$candidate" && -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

# Make sure the web build uses the right Node.js. Inside WSL this means
# activating fnm, because a plain `bash script.sh` never sources ~/.bashrc and
# would otherwise fall through to the Windows node.exe exposed by interop.
setup_node() {
  local use_fnm="${USE_FNM:-auto}" wsl=0 fnm_bin npm_path node_platform
  is_wsl && wsl=1

  case "$use_fnm" in
    auto) use_fnm=$wsl ;;
    1|yes|true) use_fnm=1 ;;
    0|no|false) use_fnm=0 ;;
    *)
      echo "error: invalid USE_FNM='${USE_FNM}' (expected auto, 0 or 1)" >&2
      exit 1
      ;;
  esac

  if (( use_fnm )); then
    if fnm_bin="$(find_fnm)"; then
      echo "==> Activating Node with fnm"
      # shellcheck disable=SC2046  # fnm env prints shell assignments
      eval "$("$fnm_bin" env --shell bash)"
      if ! "$fnm_bin" use --silent-if-unchanged; then
        echo "error: fnm could not select a Node version." >&2
        echo "       Install one ('fnm install --lts') and set a default" >&2
        echo "       ('fnm default lts-latest') or add a .node-version file." >&2
        exit 1
      fi
      echo "    node $(node -v 2>/dev/null) at $(command -v node 2>/dev/null || echo 'not found')"
    elif (( wsl )); then
      echo "note: fnm not found, falling back to node/npm on PATH" >&2
    else
      echo "error: USE_FNM='${USE_FNM}' but fnm was not found" >&2
      exit 1
    fi
  fi

  if (( wsl )); then
    npm_path="$(command -v "$NPM" 2>/dev/null || true)"
    if [[ -z "$npm_path" ]]; then
      echo "error: npm not found in WSL (set NPM=/path/to/linux/npm)" >&2
      exit 1
    fi
    case "$npm_path" in
      /mnt/[a-z]/*)
        echo "error: npm resolves to Windows Node.js: ${npm_path}" >&2
        echo "       WSL builds need a Linux Node.js; install it with fnm" >&2
        echo "       or set NPM to a Linux npm." >&2
        exit 1
        ;;
    esac
    node_platform="$(node -p 'process.platform' 2>/dev/null || true)"
    if [[ "$node_platform" != "linux" ]]; then
      echo "error: node is not a Linux build ('node -p process.platform' -> '${node_platform:-error}')." >&2
      echo "       Activate fnm ('eval \"\$(fnm env --shell bash)\" && fnm use')" >&2
      echo "       or put a Linux node first on PATH." >&2
      exit 1
    fi
  fi
}

# vite's native helpers (rollup, esbuild, tailwind's oxide) are installed per
# platform. A node_modules tree installed on Windows has no Linux builds, and
# the build then dies with a confusing "Cannot find module
# '@rollup/rollup-linux-x64-gnu'" error.
web_deps_ok() {
  local nm="$WEB_DIR/node_modules" platform arch pkg
  [[ -d "$nm" && -d "$nm/@rollup" ]] || return 1
  platform="$(node -p 'process.platform' 2>/dev/null || true)"
  arch="$(node -p 'process.arch' 2>/dev/null || true)"
  [[ -n "$platform" && -n "$arch" ]] || return 0
  for pkg in "$nm/@rollup/rollup-${platform}-${arch}"*; do
    [[ -d "$pkg" ]] && return 0
  done
  return 1
}

ensure_web_deps() {
  if web_deps_ok; then
    return 0
  fi

  local platform arch
  if [[ ! -d "$WEB_DIR/node_modules" ]]; then
    echo "note: web/node_modules is missing" >&2
  else
    platform="$(node -p 'process.platform' 2>/dev/null || true)"
    arch="$(node -p 'process.arch' 2>/dev/null || true)"
    echo "note: web/node_modules has no @rollup/rollup-${platform:-unknown}-${arch:-unknown}* package;" >&2
    echo "      it was probably installed for another platform (e.g. Windows)." >&2
  fi

  case "${WEB_NPM_INSTALL:-auto}" in
    0|no|false)
      echo "error: reinstall web dependencies in this environment first:" >&2
      echo "         (cd \"$WEB_DIR\" && \"$NPM\" ci)" >&2
      exit 1
      ;;
  esac

  echo "==> Installing web dependencies with npm ci"
  (cd "$WEB_DIR" && "$NPM" ci)
  if ! web_deps_ok; then
    echo "error: web/node_modules is still unusable after npm ci" >&2
    exit 1
  fi
}

command -v "$GO" >/dev/null 2>&1 || {
  echo "error: go not found (set GO=/path/to/go or add it to PATH)" >&2
  exit 1
}

if [[ "${SKIP_WEB_BUILD:-0}" != "1" ]]; then
  setup_node

  command -v "$NPM" >/dev/null 2>&1 || {
    echo "error: npm not found (set NPM=/path/to/npm or add it to PATH)" >&2
    exit 1
  }

  ensure_web_deps

  echo "==> Building web assets"
  (cd "$WEB_DIR" && "$NPM" run build)
fi

[[ -f "$WEB_DIR/dist/index.html" ]] || {
  echo "error: missing $WEB_DIR/dist/index.html (build the web app first or unset SKIP_WEB_BUILD)" >&2
  exit 1
}

mkdir -p "$DIST_DIR"
STAGING="$(mktemp -d "${TMPDIR:-/tmp}/mindfs-build.XXXXXX")"
trap 'rm -rf "$STAGING"' EXIT

LDFLAGS="-s -w -X main.version=${VERSION}"
if [[ -n "${MINDFS_RELEASE_PUBLIC_KEY:-}" ]]; then
  LDFLAGS="${LDFLAGS} -X mindfs/server/internal/update.releaseManifestPublicKey=${MINDFS_RELEASE_PUBLIC_KEY}"
fi

echo "Version:   ${VERSION}"
echo "Platforms: ${PLATFORMS}"
echo "Output:    ${DIST_DIR}"
echo

for PLATFORM in $PLATFORMS; do
  GOOS="${PLATFORM%%/*}"
  GOARCH="${PLATFORM##*/}"
  if [[ "$PLATFORM" != */* || -z "$GOOS" || -z "$GOARCH" ]]; then
    echo "error: invalid platform '${PLATFORM}' (expected os/arch)" >&2
    exit 1
  fi
  case "$GOOS" in
    linux|windows|darwin) ;;
    *)
      echo "error: unsupported OS '${GOOS}' (this script builds macOS, Linux and Windows)" >&2
      exit 1
      ;;
  esac

  BIN_NAME="mindfs"
  [[ "$GOOS" == "windows" ]] && BIN_NAME="mindfs.exe"
  NAME="mindfs_${VERSION}_${GOOS}_${GOARCH}"
  PKG_DIR="${STAGING}/${NAME}"
  GOARM=""
  [[ "$GOARCH" == "arm" ]] && GOARM=7

  echo "==> Building ${GOOS}/${GOARCH}"
  rm -rf "$PKG_DIR"
  mkdir -p "$PKG_DIR"
  (
    cd "$ROOT"
    CGO_ENABLED=0 GOOS="$GOOS" GOARCH="$GOARCH" GOARM="$GOARM" \
      "$GO" build -trimpath -ldflags "$LDFLAGS" -o "${PKG_DIR}/${BIN_NAME}" ./cli/cmd
  )

  cp -R "$WEB_DIR/dist" "${PKG_DIR}/web"
  cp "$ROOT/agents.json" "${PKG_DIR}/agents.json"
  cp "$ROOT/task_template.json" "${PKG_DIR}/task_template.json"
  # Keep the Unix binary executable when the script runs on Windows and the
  # archive is later extracted on Linux or macOS.
  chmod 0755 "${PKG_DIR}/${BIN_NAME}"
  chmod -R u+rwX,go+rX "${PKG_DIR}/web"

  ARCHIVE="${DIST_DIR}/${NAME}.tar.gz"
  rm -f "$ARCHIVE"
  # Windows tar records 0644 for files even after chmod, which makes the Unix
  # binary non-executable after extraction. Write the binary with an explicit
  # 0755 mode first, then append the remaining files without touching their
  # modes. GNU tar (Git Bash, Linux, WSL) supports both operations.
  TAR_TMP="${ARCHIVE%.gz}"
  rm -f "$TAR_TMP"
  tar -cf "$TAR_TMP" --mode=0755 -C "$STAGING" "${NAME}/${BIN_NAME}"
  tar -rf "$TAR_TMP" --exclude="${NAME}/${BIN_NAME}" -C "$STAGING" "$NAME"
  gzip -9 -c "$TAR_TMP" > "$ARCHIVE"
  rm -f "$TAR_TMP"
  echo "    ${ARCHIVE} ($(du -h "$ARCHIVE" | cut -f1))"
  echo
done

echo "==> Done. Archives in ${DIST_DIR}/"
