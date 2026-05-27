#!/usr/bin/env bash
# vault-mcp installer — https://github.com/videnovnebojsa/vault-mcp
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/videnovnebojsa/vault-mcp/main/install.sh | sh
#   bash install.sh               # install or upgrade
#   bash install.sh --configure   # reconfigure only (skip binary download)
#
# Requires: curl or wget, bash 3.2+
# Supported: macOS (arm64, x86_64), Linux (x86_64)
set -euo pipefail

# ─── Constants ────────────────────────────────────────────────────────────────

REPO="videnovnebojsa/vault-mcp"
BIN_NAME="vault-mcp"
BIN_DIR="${HOME}/.local/bin"
CFG_DIR="${HOME}/.config/vault-mcp"
CFG_FILE="${CFG_DIR}/.env"
VER_FILE="${CFG_DIR}/.installed-version"

# ─── Colours ──────────────────────────────────────────────────────────────────

if [ -t 1 ]; then
  RED='\033[0;31m' GREEN='\033[0;32m' YELLOW='\033[1;33m'
  CYAN='\033[0;36m' BOLD='\033[1m' RESET='\033[0m'
else
  RED='' GREEN='' YELLOW='' CYAN='' BOLD='' RESET=''
fi

info()    { printf "${CYAN}→${RESET} %s\n" "$*"; }
ok()      { printf "${GREEN}✔${RESET} %s\n" "$*"; }
warn()    { printf "${YELLOW}⚠${RESET} %s\n" "$*"; }
die()     { printf "${RED}✘ Error:${RESET} %s\n" "$*" >&2; exit 1; }
header()  { printf "\n${BOLD}%s${RESET}\n%s\n" "$1" "$(printf '─%.0s' $(seq 1 ${#1}))"; }
ask()     { printf "${BOLD}%s${RESET}" "$*"; }  # no newline — caller uses read

# Read a value from the existing .env (returns empty string if not found)
cfg_get() {
  local key="$1"
  [ -f "$CFG_FILE" ] || return 0
  grep -E "^${key}=" "$CFG_FILE" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"' || true
}

# ─── Flags ────────────────────────────────────────────────────────────────────

CONFIGURE_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --configure) CONFIGURE_ONLY=true ;;
    --help|-h)
      printf "Usage: bash install.sh [--configure]\n\n"
      printf "  (no flags)    Install or upgrade vault-mcp binary + configure\n"
      printf "  --configure   Reconfigure only — skip binary download/upgrade\n"
      exit 0 ;;
    *) die "Unknown flag: $arg" ;;
  esac
done

# ─── Banner ───────────────────────────────────────────────────────────────────

printf "\n${BOLD}vault-mcp installer${RESET}\n"
printf "────────────────────────────────────────\n\n"

# ─── Step 1: Detect platform ──────────────────────────────────────────────────

OS="$(uname -s)"
ARCH="$(uname -m)"

if [ "$CONFIGURE_ONLY" = false ]; then
  case "${OS}-${ARCH}" in
    Darwin-arm64)  ARTIFACT="vault-mcp-macos-arm64" ;;
    Darwin-x86_64) ARTIFACT="vault-mcp-macos-x64"   ;;
    Linux-x86_64)  ARTIFACT="vault-mcp-linux-x64"    ;;
    Linux-aarch64) die "Linux arm64 is not yet supported via this script. Build from source: https://github.com/${REPO}#developer-install" ;;
    *) die "Unsupported platform: ${OS}-${ARCH}" ;;
  esac

  # ─── Step 2: Resolve fetch command ──────────────────────────────────────────

  if command -v curl &>/dev/null; then
    fetch() { curl -fsSL "$1"; }
    fetch_to() { curl -fsSL "$1" -o "$2"; }
  elif command -v wget &>/dev/null; then
    fetch() { wget -qO- "$1"; }
    fetch_to() { wget -qO "$2" "$1"; }
  else
    die "curl or wget is required but neither was found"
  fi

  # ─── Step 3: Get latest release tag ─────────────────────────────────────────

  info "Checking latest release..."
  LATEST_TAG=$(fetch "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep '"tag_name"' | head -1 | cut -d'"' -f4)
  [ -n "$LATEST_TAG" ] || die "Could not fetch latest release tag — check your internet connection"
  info "Latest release: ${LATEST_TAG}"

  # ─── Step 4: Download binary (skip if already on this version) ──────────────

  INSTALLED_BIN="${BIN_DIR}/${BIN_NAME}"
  INSTALLED_TAG="$(cat "${VER_FILE}" 2>/dev/null || true)"

  if [ -x "$INSTALLED_BIN" ] && [ "$INSTALLED_TAG" = "$LATEST_TAG" ]; then
    ok "Already on ${LATEST_TAG} — skipping download"
  else
    if [ -n "$INSTALLED_TAG" ]; then
      info "Upgrading ${INSTALLED_TAG} → ${LATEST_TAG}..."
    else
      info "Downloading ${ARTIFACT}..."
    fi

    mkdir -p "$BIN_DIR"
    DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${LATEST_TAG}/${ARTIFACT}"
    fetch_to "${DOWNLOAD_URL}" "${INSTALLED_BIN}" \
      || die "Download failed from ${DOWNLOAD_URL}"
    chmod +x "${INSTALLED_BIN}"
    mkdir -p "$CFG_DIR"
    printf '%s' "$LATEST_TAG" > "$VER_FILE"
    ok "Binary installed: ${INSTALLED_BIN} (${LATEST_TAG})"
  fi
fi

# ─── Step 5: Configuration ────────────────────────────────────────────────────

mkdir -p "$CFG_DIR"
header "Configuration"
printf "Settings file: ${CYAN}${CFG_FILE}${RESET}\n\n"

# Vault path (required)
CURRENT_VAULT="$(cfg_get VAULT_DEFAULT_PATH)"
if [ -n "$CURRENT_VAULT" ]; then
  ask "Vault path [${CURRENT_VAULT}]: "
else
  ask "Vault path (e.g. ~/Documents/obsidian): "
fi
read -r INPUT_VAULT
VAULT_PATH="${INPUT_VAULT:-${CURRENT_VAULT:-}}"
[ -n "$VAULT_PATH" ] || die "Vault path is required"
VAULT_PATH="${VAULT_PATH/#\~/$HOME}"          # expand leading ~
[ -d "$VAULT_PATH" ] || die "Directory not found: ${VAULT_PATH}"

# Port
CURRENT_PORT="$(cfg_get MCP_PORT)"
DEFAULT_PORT="${CURRENT_PORT:-3782}"
ask "Port [${DEFAULT_PORT}]: "
read -r INPUT_PORT
MCP_PORT="${INPUT_PORT:-${DEFAULT_PORT}}"
[[ "$MCP_PORT" =~ ^[0-9]+$ ]] || die "Port must be a number"

# API key (optional)
CURRENT_KEY="$(cfg_get MCP_API_KEY)"
if [ -n "$CURRENT_KEY" ]; then
  ask "API key [leave blank to keep current]: "
  read -r INPUT_KEY
  MCP_API_KEY="${INPUT_KEY:-${CURRENT_KEY}}"
else
  ask "API key (optional — leave empty for local-only): "
  read -r MCP_API_KEY
fi

# Embeddings (optional)
CURRENT_EMB="$(cfg_get ENABLE_EMBEDDINGS)"
CURRENT_EMB="${CURRENT_EMB:-false}"
if [ "$CURRENT_EMB" = "true" ]; then
  ask "Keep vector embeddings enabled? [Y/n]: "
  read -r INPUT_EMB
  if [[ "${INPUT_EMB,,}" == "n" || "${INPUT_EMB,,}" == "no" ]]; then
    ENABLE_EMBEDDINGS="false"
  else
    ENABLE_EMBEDDINGS="true"
  fi
else
  ask "Enable vector embeddings? [y/N]: "
  read -r INPUT_EMB
  if [[ "${INPUT_EMB,,}" == "y" || "${INPUT_EMB,,}" == "yes" ]]; then
    ENABLE_EMBEDDINGS="true"
  else
    ENABLE_EMBEDDINGS="false"
  fi
fi

EMBEDDINGS_ENDPOINT=""
EMBEDDINGS_API_KEY=""
if [ "$ENABLE_EMBEDDINGS" = "true" ]; then
  CURRENT_EMB_URL="$(cfg_get EMBEDDINGS_BASE_URL)"
  DEFAULT_EMB_URL="${CURRENT_EMB_URL:-https://api.openai.com/v1}"
  ask "Embeddings endpoint [${DEFAULT_EMB_URL}]: "
  read -r INPUT_EMB_URL
  EMBEDDINGS_ENDPOINT="${INPUT_EMB_URL:-${DEFAULT_EMB_URL}}"
  CURRENT_EMB_KEY="$(cfg_get EMBEDDINGS_API_KEY)"
  if [ -n "$CURRENT_EMB_KEY" ]; then
    ask "Embeddings API key [leave blank to keep current]: "
    read -r INPUT_EMB_KEY
    EMBEDDINGS_API_KEY="${INPUT_EMB_KEY:-${CURRENT_EMB_KEY}}"
  else
    ask "Embeddings API key: "
    read -r EMBEDDINGS_API_KEY
  fi
fi

# Write config file
{
  printf "# vault-mcp configuration\n"
  printf "# Generated by install.sh on %s\n" "$(date '+%Y-%m-%d')"
  printf "# Full config reference: https://github.com/%s/blob/main/docs/configuration.md\n" "$REPO"
  printf "# Interactive editor (requires Bun): bun run configure\n"
  printf "\n"
  printf "VAULT_DEFAULT_PATH=%s\n" "$VAULT_PATH"
  printf "MCP_PORT=%s\n" "$MCP_PORT"
  [ -n "$MCP_API_KEY" ]       && printf "MCP_API_KEY=%s\n"         "$MCP_API_KEY"
  printf "ENABLE_EMBEDDINGS=%s\n" "$ENABLE_EMBEDDINGS"
  [ -n "$EMBEDDINGS_ENDPOINT" ] && printf "EMBEDDINGS_BASE_URL=%s\n" "$EMBEDDINGS_ENDPOINT"
  [ -n "$EMBEDDINGS_API_KEY" ]  && printf "EMBEDDINGS_API_KEY=%s\n"  "$EMBEDDINGS_API_KEY"
} > "$CFG_FILE"

ok "Config written to ${CFG_FILE}"

# ─── Step 6: Service install / restart ────────────────────────────────────────

header "Background service"

INSTALLED_BIN="${BIN_DIR}/${BIN_NAME}"
SERVICE_RUNNING=false

if [ "$OS" = "Darwin" ]; then
  PLIST_DIR="${HOME}/Library/LaunchAgents"
  PLIST_FILE="${PLIST_DIR}/com.vault-mcp.plist"
  LOG_DIR="${HOME}/Library/Logs/vault-mcp"
  SERVICE_INSTALLED=false
  [ -f "$PLIST_FILE" ] && SERVICE_INSTALLED=true

  if [ "$SERVICE_INSTALLED" = true ] && [ "$CONFIGURE_ONLY" = true ]; then
    # Reconfigure: just restart
    launchctl kickstart -k "gui/$(id -u)/com.vault-mcp" 2>/dev/null \
      || launchctl unload "$PLIST_FILE" 2>/dev/null && launchctl load "$PLIST_FILE"
    ok "Service restarted with new config"
    SERVICE_RUNNING=true
  else
    ask "Install as a background service (auto-starts at login)? [Y/n]: "
    read -r INSTALL_SERVICE
    if [[ "${INSTALL_SERVICE,,}" != "n" && "${INSTALL_SERVICE,,}" != "no" ]]; then
      mkdir -p "$PLIST_DIR" "$LOG_DIR"
      cat > "$PLIST_FILE" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.vault-mcp</string>
  <key>ProgramArguments</key>
  <array>
    <string>${INSTALLED_BIN}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${CFG_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>VAULT_MCP_CONFIG</key>
    <string>${CFG_FILE}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/vault-mcp.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/vault-mcp.err</string>
</dict>
</plist>
PLIST
      launchctl unload "$PLIST_FILE" 2>/dev/null || true
      launchctl load "$PLIST_FILE"
      ok "Service installed and started (launchd)"
      printf "  Logs: ${CYAN}tail -f %s/vault-mcp.err${RESET}\n" "$LOG_DIR"
      printf "  Restart: ${CYAN}launchctl kickstart -k gui/\$(id -u)/com.vault-mcp${RESET}\n"
      SERVICE_RUNNING=true
    else
      info "Service install skipped. Start manually: ${CYAN}vault-mcp${RESET}"
    fi
  fi

elif [ "$OS" = "Linux" ]; then
  SYSTEMD_DIR="${HOME}/.config/systemd/user"
  SERVICE_FILE="${SYSTEMD_DIR}/vault-mcp.service"
  SERVICE_INSTALLED=false
  [ -f "$SERVICE_FILE" ] && SERVICE_INSTALLED=true

  if [ "$SERVICE_INSTALLED" = true ] && [ "$CONFIGURE_ONLY" = true ]; then
    systemctl --user daemon-reload
    systemctl --user restart vault-mcp
    ok "Service restarted with new config"
    SERVICE_RUNNING=true
  else
    ask "Install as a background service (auto-starts at login)? [Y/n]: "
    read -r INSTALL_SERVICE
    if [[ "${INSTALL_SERVICE,,}" != "n" && "${INSTALL_SERVICE,,}" != "no" ]]; then
      mkdir -p "$SYSTEMD_DIR"
      cat > "$SERVICE_FILE" <<SYSTEMD
[Unit]
Description=vault-mcp MCP server
After=default.target

[Service]
Type=simple
ExecStart=${INSTALLED_BIN}
WorkingDirectory=${CFG_DIR}
Environment=VAULT_MCP_CONFIG=${CFG_FILE}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
SYSTEMD
      systemctl --user daemon-reload
      systemctl --user enable --now vault-mcp
      ok "Service installed and started (systemd)"
      printf "  Logs: ${CYAN}journalctl --user -u vault-mcp -f${RESET}\n"
      printf "  Restart: ${CYAN}systemctl --user restart vault-mcp${RESET}\n"
      SERVICE_RUNNING=true
    else
      info "Service install skipped. Start manually: ${CYAN}vault-mcp${RESET}"
    fi
  fi
fi

# ─── Step 7: PATH reminder ────────────────────────────────────────────────────

if ! echo ":${PATH}:" | grep -q ":${BIN_DIR}:"; then
  printf "\n"
  warn "${BIN_DIR} is not in your PATH. Add this to ~/.zshrc or ~/.bashrc:"
  printf "  ${CYAN}export PATH=\"\$PATH:${BIN_DIR}\"${RESET}\n"
fi

# ─── Step 8: Connection instructions ─────────────────────────────────────────

printf "\n"
header "Connect Claude Code"
printf "Add to ${CYAN}.mcp.json${RESET} in your project root:\n\n"
printf '{\n  "mcpServers": {\n    "vault": { "type": "http", "url": "http://127.0.0.1:%s/mcp" }\n  }\n}\n' "$MCP_PORT"

printf "\n"
header "Verify"
printf "  ${CYAN}curl http://localhost:${MCP_PORT}/health${RESET}\n"

printf "\n"
header "Reconfigure anytime"
printf "  ${CYAN}bash install.sh --configure${RESET}   — quick wizard (no download)\n"
printf "  ${CYAN}bun run configure${RESET}             — full editor (requires Bun)\n"
printf "  ${CYAN}${CFG_FILE}${RESET}  — edit directly\n"

printf "\n${GREEN}${BOLD}✔ Done!${RESET}  vault-mcp ${LATEST_TAG:-} is ready.\n\n"
