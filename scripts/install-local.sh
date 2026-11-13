#!/usr/bin/env bash
# MindFS local installer for macOS and Linux.
# Installs from a locally built .tar.gz (see scripts/build-local.sh) instead of
# downloading a release from GitHub.
#
# Usage:
#   bash scripts/install-local.sh dist/mindfs_v0.5.8_linux_amd64.tar.gz
#   bash scripts/install-local.sh dist/mindfs_v0.5.8_linux_amd64.tar.gz --prefix "$HOME/.local"
#   bash scripts/install-local.sh --uninstall [--purge]
set -euo pipefail

PREFIX="${HOME}/.local"
UNINSTALL=0
PURGE=0
ARCHIVE=""

usage() {
  cat <<'EOF'
Install MindFS from a locally built archive (see scripts/build-local.sh).

Usage:
  install-local.sh ARCHIVE.tar.gz [--prefix PREFIX]
  install-local.sh --uninstall [--purge] [--prefix PREFIX]

Options:
  --prefix PREFIX   Install prefix (default: ~/.local).
  --uninstall       Remove the installed binary and shared files.
  --purge           With --uninstall, also remove user config and logs.
  -h, --help        Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prefix)
      [[ $# -ge 2 ]] || { echo "Error: --prefix requires a value." >&2; exit 1; }
      PREFIX="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    --purge) PURGE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*)
      echo "Error: unknown option: $1" >&2
      usage >&2
      exit 1 ;;
    *)
      if [[ -n "$ARCHIVE" ]]; then
        echo "Error: unexpected argument: $1" >&2
        exit 1
      fi
      ARCHIVE="$1"; shift ;;
  esac
done

PREFIX="${PREFIX%/}"

if [[ "$PURGE" -eq 1 && "$UNINSTALL" -ne 1 ]]; then
  echo "Error: --purge can only be used with --uninstall." >&2
  exit 1
fi

config_dir() {
  case "$(uname -s)" in
    Darwin) printf '%s\n' "${HOME}/Library/Application Support/mindfs" ;;
    *) printf '%s\n' "${XDG_CONFIG_HOME:-${HOME}/.config}/mindfs" ;;
  esac
}

state_dir() {
  printf '%s\n' "${HOME}/.local/share/mindfs"
}

remove_path_entry() {
  local bin_dir="$1"
  local shell_name rc_file line marker tmp
  shell_name="$(basename "${SHELL:-}")"
  line="export PATH=\"${bin_dir}:\$PATH\""
  marker="# Added by MindFS installer (${bin_dir})"

  case "$shell_name" in
    zsh) rc_file="${HOME}/.zshrc" ;;
    bash)
      if [[ "$(uname -s)" == "Darwin" ]]; then
        rc_file="${HOME}/.bash_profile"
      else
        rc_file="${HOME}/.bashrc"
      fi
      ;;
    *) return 0 ;;
  esac

  [[ -f "$rc_file" ]] || return 0
  if ! grep -Fqx "$marker" "$rc_file"; then
    # The entry was not written by this installer (another program, a distro
    # default, or a manual edit), so leave it alone.
    if grep -Fqx "$line" "$rc_file"; then
      echo "  PATH    -> kept ${bin_dir} in ${rc_file} (not added by this installer)"
    fi
    return 0
  fi

  tmp="$(mktemp)"
  MARKER="$marker" LINE="$line" awk '
    $0 == ENVIRON["MARKER"] { found = 1; next }
    found == 1 { found = 0; if ($0 == ENVIRON["LINE"]) next }
    { print }
  ' "$rc_file" >"$tmp"
  cat "$tmp" >"$rc_file"
  rm -f "$tmp"
  echo "  PATH    -> removed ${bin_dir} from ${rc_file}"
}

remove_autostart() {
  local config_home="${XDG_CONFIG_HOME:-${HOME}/.config}"
  case "$(uname -s)" in
    Darwin)
      rm -f "${HOME}/Library/LaunchAgents/com.a9gent.mindfs.plist"
      ;;
    *)
      rm -f \
        "${config_home}/systemd/user/default.target.wants/mindfs.service" \
        "${config_home}/systemd/user/mindfs.service" \
        "${config_home}/autostart/mindfs.desktop"
      if command -v systemctl &>/dev/null; then
        systemctl --user daemon-reload >/dev/null 2>&1 || true
      fi
      ;;
  esac
  echo "  Removed automatic startup entry."
}

uninstall_mindfs() {
  local bin_path="${PREFIX}/bin/mindfs"
  local share_dir="${PREFIX}/share/mindfs"

  echo "Uninstalling mindfs"
  echo "  Prefix: ${PREFIX}"
  rm -f "$bin_path"
  echo "  Removed binary: ${bin_path}"
  rm -rf "$share_dir"
  echo "  Removed shared files: ${share_dir}"
  rmdir "${PREFIX}/bin" "${PREFIX}/share" "$PREFIX" 2>/dev/null || true
  remove_path_entry "${PREFIX}/bin"
  remove_autostart

  if [[ "$PURGE" -eq 1 ]]; then
    rm -rf "$(config_dir)" "$(state_dir)"
    echo "  Removed user config: $(config_dir)"
    echo "  Removed user state:  $(state_dir)"
    echo "  Project .mindfs directories were not removed."
  else
    echo "  User config and project .mindfs data were kept."
    echo "  Re-run with --uninstall --purge to remove user-level MindFS config and logs."
  fi
  echo "Done."
}

if [[ "$UNINSTALL" -eq 1 ]]; then
  uninstall_mindfs
  exit 0
fi

if [[ -z "$ARCHIVE" ]]; then
  echo "Error: missing archive argument." >&2
  usage >&2
  exit 1
fi

if [[ ! -f "$ARCHIVE" ]]; then
  echo "Error: archive not found: ${ARCHIVE}" >&2
  exit 1
fi

# Make the path absolute so it stays valid if the working directory changes.
ARCHIVE="$(cd "$(dirname "$ARCHIVE")" && pwd)/$(basename "$ARCHIVE")"

# ── Detect OS ──────────────────────────────────────────────────────────────
detect_os() {
  local raw; raw="$(uname -s | tr '[:upper:]' '[:lower:]')"
  case "$raw" in
    darwin) echo "darwin" ;;
    linux)  echo "linux"  ;;
    *) echo "Unsupported OS: $raw" >&2; exit 1 ;;
  esac
}

# ── Detect architecture ────────────────────────────────────────────────────
detect_arch() {
  local raw; raw="$(uname -m)"
  case "$raw" in
    x86_64|amd64)  echo "amd64" ;;
    aarch64|arm64) echo "arm64" ;;
    armv7*|armhf)  echo "arm"   ;;
    *) echo "Unsupported arch: $raw" >&2; exit 1 ;;
  esac
}

OS="$(detect_os)"
ARCH="$(detect_arch)"

# Version of an already installed binary, if any.
installed_version() {
  local bin="$1" out
  [[ -x "$bin" ]] || return 0
  out="$("$bin" --version 2>/dev/null || true)"
  out="${out#mindfs version: }"
  printf '%s\n' "$out"
}

pid_exe() {
  local pid="$1" exe=""
  if [[ -e "/proc/$pid/exe" ]]; then
    exe="$(readlink "/proc/$pid/exe" 2>/dev/null || true)"
  elif command -v lsof >/dev/null 2>&1; then
    exe="$(lsof -p "$pid" -a -d txt -Fn 2>/dev/null | sed -n 's/^n//p' || true)"
    exe="${exe%%$'\n'*}"
  fi
  printf '%s\n' "${exe% (deleted)}"
}

# PIDs of services registered in the per-user state directory that run the
# binary from this install prefix.
running_service_pids() {
  local bin="${PREFIX}/bin/mindfs" pidfile pid exe pids=""
  for pidfile in "$(state_dir)"/mindfs-*.pid; do
    [[ -f "$pidfile" ]] || continue
    pid="$(tr -dc '0-9' <"$pidfile" 2>/dev/null || true)"
    [[ -n "$pid" ]] || continue
    kill -0 "$pid" 2>/dev/null || continue
    exe="$(pid_exe "$pid")"
    if [[ -z "$exe" || "$exe" == "$bin" ]]; then
      pids="${pids:+${pids} }${pid}"
    fi
  done
  printf '%s\n' "$pids"
}

pid_cwd() {
  local pid="$1" cwd=""
  if [[ -e "/proc/$pid/cwd" ]]; then
    cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
  elif command -v lsof >/dev/null 2>&1; then
    cwd="$(lsof -p "$pid" -a -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' || true)"
    cwd="${cwd%%$'\n'*}"
  fi
  printf '%s\n' "$cwd"
}

# Remember how each running service was started before stopping it, so it can
# be relaunched with the same arguments after the new binary is installed.
capture_restart_spec() {
  local pid="$1" idx="$2" arg first=1
  pid_cwd "$pid" >"${RESTART_DIR}/${idx}.cwd"
  if [[ -r "/proc/$pid/cmdline" ]]; then
    : >"${RESTART_DIR}/${idx}.argv"
    while IFS= read -r -d '' arg; do
      if (( first )); then
        first=0
        continue
      fi
      printf '%s\0' "$arg" >>"${RESTART_DIR}/${idx}.argv"
    done <"/proc/$pid/cmdline"
    printf 'argv\n' >"${RESTART_DIR}/${idx}.mode"
  else
    # macOS has no /proc; ps gives a shell-quoted-lossy command line.
    ps -p "$pid" -ww -o args= 2>/dev/null >"${RESTART_DIR}/${idx}.cmdline" || true
    printf 'shell\n' >"${RESTART_DIR}/${idx}.mode"
  fi
}

# Send SIGTERM to the given PIDs and wait for them to exit. Prints the PIDs
# that are still alive and returns non-zero if any remain.
stop_running_services() {
  local pid remaining i=0
  for pid in $RUNNING_PIDS; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  while (( i < 50 )); do
    remaining=""
    for pid in $RUNNING_PIDS; do
      if kill -0 "$pid" 2>/dev/null; then
        remaining="${remaining:+$remaining }$pid"
      fi
    done
    if [[ -z "$remaining" ]]; then
      return 0
    fi
    sleep 0.2
    i=$((i + 1))
  done
  printf '%s\n' "$remaining"
  return 1
}

# Re-run the same command detached. MindFS starts its background service on its
# own when the arguments do not ask for --foreground, so its daemon keeps
# writing to its usual log file; the launcher's console output is discarded.
restart_services() {
  local modefile idx cwd cmdline
  local -a args
  for modefile in "$RESTART_DIR"/*.mode; do
    [[ -f "$modefile" ]] || continue
    idx="${modefile##*/}"
    idx="${idx%.mode}"
    cwd="$(cat "${RESTART_DIR}/${idx}.cwd" 2>/dev/null || true)"
    if [[ "$(cat "$modefile" 2>/dev/null || true)" == "argv" ]]; then
      args=()
      while IFS= read -r -d '' arg; do
        args+=("$arg")
      done <"${RESTART_DIR}/${idx}.argv"
      (
        cd "${cwd:-$HOME}" 2>/dev/null || cd "$HOME" 2>/dev/null || true
        if command -v setsid >/dev/null 2>&1; then
          setsid "${PREFIX}/bin/mindfs" "${args[@]}" </dev/null >/dev/null 2>&1 &
        else
          nohup "${PREFIX}/bin/mindfs" "${args[@]}" </dev/null >/dev/null 2>&1 &
        fi
      )
    else
      cmdline="$(cat "${RESTART_DIR}/${idx}.cmdline" 2>/dev/null || true)"
      [[ -n "$cmdline" ]] || continue
      (
        cd "${cwd:-$HOME}" 2>/dev/null || cd "$HOME" 2>/dev/null || true
        if command -v setsid >/dev/null 2>&1; then
          setsid sh -c "$cmdline" </dev/null >/dev/null 2>&1 &
        else
          nohup sh -c "$cmdline" </dev/null >/dev/null 2>&1 &
        fi
      )
    fi
  done
}

# ── Extract ─────────────────────────────────────────────────────────────────
TMPDIR="$(mktemp -d)"
RESTART_DIR=""
RESTART_PENDING=0
trap 'rm -rf "$TMPDIR"' EXIT

echo "Extracting ${ARCHIVE}"
tar -xzf "$ARCHIVE" -C "$TMPDIR"

# The archives produced by scripts/build-local.sh and scripts/build-all.sh
# contain a single top-level directory named mindfs_<version>_<os>_<arch>.
PKG_DIR=""
WINDOWS_ARCHIVE=0
for dir in "$TMPDIR"/mindfs_*/ "$TMPDIR"/*/; do
  [[ -d "$dir" ]] || continue
  if [[ -f "${dir}mindfs" ]]; then
    PKG_DIR="${dir%/}"
    break
  fi
  [[ -f "${dir}mindfs.exe" ]] && WINDOWS_ARCHIVE=1
done
if [[ -z "$PKG_DIR" ]]; then
  if [[ "$WINDOWS_ARCHIVE" -eq 1 ]]; then
    echo "Error: archive contains mindfs.exe (a Windows build)." >&2
    echo "       Use scripts/install-local.bat on Windows instead." >&2
  else
    echo "Error: archive does not contain a mindfs binary (expected mindfs_<version>_<os>_<arch>/mindfs)." >&2
  fi
  exit 1
fi

PKG_NAME="$(basename "$PKG_DIR")"
PKG_VERSION=""
PKG_OS=""
PKG_ARCH=""
if [[ "$PKG_NAME" =~ ^mindfs_(.+)_([a-z0-9]+)_([a-z0-9]+)$ ]]; then
  PKG_VERSION="${BASH_REMATCH[1]}"
  PKG_OS="${BASH_REMATCH[2]}"
  PKG_ARCH="${BASH_REMATCH[3]}"
fi

if [[ -n "$PKG_OS" && -n "$PKG_ARCH" ]] && [[ "$PKG_OS" != "$OS" || "$PKG_ARCH" != "$ARCH" ]]; then
  echo "Warning: archive is built for ${PKG_OS}/${PKG_ARCH} but this machine is ${OS}/${ARCH}." >&2
  echo "         The installed binary may not run here." >&2
fi

OLD_VERSION="$(installed_version "${PREFIX}/bin/mindfs")"
RUNNING_PIDS="$(running_service_pids)"

if [[ -n "$OLD_VERSION" ]]; then
  if [[ -n "$PKG_VERSION" ]]; then
    echo "Updating mindfs ${OLD_VERSION} -> ${PKG_VERSION} from local archive"
  else
    echo "Updating mindfs ${OLD_VERSION} from local archive"
  fi
elif [[ -n "$PKG_VERSION" ]]; then
  echo "Installing mindfs ${PKG_VERSION} from local archive"
else
  echo "Installing mindfs from local archive"
fi
echo "  Archive: ${ARCHIVE}"
echo "  Prefix:  ${PREFIX}"

if [[ -n "$RUNNING_PIDS" ]]; then
  echo "MindFS is running (pid ${RUNNING_PIDS})."
  printf "Stop it, install, and restart with the same arguments? [y/N] "
  answer=""
  # Read a single key without waiting for Enter. -s suppresses the echo, so the
  # key is printed after the read to keep the output readable.
  IFS= read -r -n 1 -s answer || true
  printf '%s\n' "$answer"
  case "$answer" in
    y|Y) ;;
    *)
      echo "Aborted; MindFS was left running."
      exit 1
      ;;
  esac

  RESTART_DIR="${TMPDIR}/restart"
  mkdir -p "$RESTART_DIR"
  idx=0
  for pid in $RUNNING_PIDS; do
    capture_restart_spec "$pid" "$idx"
    idx=$((idx + 1))
  done

  remaining=""
  if ! remaining="$(stop_running_services)"; then
    echo "Error: could not stop MindFS (pid ${remaining})." >&2
    echo "       Stop it manually and re-run this installer." >&2
    exit 1
  fi
  RESTART_PENDING=1
fi

# ── Install binary ──────────────────────────────────────────────────────────
mkdir -p "${PREFIX}/bin"
install -m 0755 "${PKG_DIR}/mindfs" "${PREFIX}/bin/mindfs"
echo "  Binary  -> ${PREFIX}/bin/mindfs"

# ── Install default agent config ────────────────────────────────────────────
if [[ -f "${PKG_DIR}/agents.json" ]]; then
  mkdir -p "${PREFIX}/share/mindfs"
  install -m 0644 "${PKG_DIR}/agents.json" "${PREFIX}/share/mindfs/agents.json"
  echo "  Agents  -> ${PREFIX}/share/mindfs/agents.json"
fi
if [[ -f "${PKG_DIR}/task_template.json" ]]; then
  mkdir -p "${PREFIX}/share/mindfs"
  install -m 0644 "${PKG_DIR}/task_template.json" "${PREFIX}/share/mindfs/task_template.json"
  echo "  Templates -> ${PREFIX}/share/mindfs/task_template.json"
fi

# ── Install web assets (optional) ───────────────────────────────────────────
if [[ -d "${PKG_DIR}/web" ]]; then
  WEB_DEST="${PREFIX}/share/mindfs/web"
  mkdir -p "${PREFIX}/share/mindfs"
  rm -rf "$WEB_DEST"
  cp -r "${PKG_DIR}/web" "$WEB_DEST"
  echo "  Web     -> ${WEB_DEST}"
fi

if [[ "$RESTART_PENDING" -eq 1 ]]; then
  restart_services
  echo "  Restarted MindFS with the same arguments."
fi

# ── Ensure PATH contains the user bin directory ─────────────────────────────
ensure_path_entry() {
  local bin_dir="$1"
  case ":${PATH}:" in
    *":${bin_dir}:"*) return 0 ;;
  esac

  local shell_name rc_file line marker tmp
  shell_name="$(basename "${SHELL:-}")"
  line="export PATH=\"${bin_dir}:\$PATH\""
  marker="# Added by MindFS installer (${bin_dir})"

  case "$shell_name" in
    zsh)
      rc_file="${HOME}/.zshrc"
      ;;
    bash)
      if [[ "$(uname -s)" == "Darwin" ]]; then
        rc_file="${HOME}/.bash_profile"
      else
        rc_file="${HOME}/.bashrc"
      fi
      ;;
    *)
      return 1
      ;;
  esac

  touch "$rc_file"
  if grep -Fqx "$line" "$rc_file"; then
    return 0
  fi
  if grep -Fqx "$marker" "$rc_file"; then
    # Stale marker whose export line was removed: drop it, add both below.
    tmp="$(mktemp)"
    grep -Fvx "$marker" "$rc_file" >"$tmp" || true
    cat "$tmp" >"$rc_file"
    rm -f "$tmp"
  fi

  {
    printf '\n'
    printf '%s\n' "$marker"
    printf '%s\n' "$line"
  } >>"$rc_file"

  echo "  PATH    -> added ${bin_dir} to ${rc_file}"
  echo "            Reload your shell or run: source ${rc_file}"
  return 0
}

# ── Verify ──────────────────────────────────────────────────────────────────
echo
if ensure_path_entry "${PREFIX}/bin"; then
  :
else
  echo "PATH was not updated automatically for shell: $(basename "${SHELL:-unknown}")"
  echo "  Add this line to your shell profile:"
  echo "    export PATH=\"${PREFIX}/bin:\$PATH\""
fi

if command -v mindfs &>/dev/null; then
  echo "Done. mindfs is available at: $(command -v mindfs)"
else
  echo "Done. Open a new terminal or ensure ${PREFIX}/bin is in your PATH."
fi
