# vault-mcp installer for Windows — https://github.com/videnovnebojsa/vault-mcp
#
# Usage:
#   irm https://raw.githubusercontent.com/videnovnebojsa/vault-mcp/main/install.ps1 | iex
#   .\install.ps1               # install or upgrade
#   .\install.ps1 -Configure    # reconfigure only (skip binary download)
#
# Requires: PowerShell 5.1+, Windows x64

[CmdletBinding()]
param(
    [switch]$Configure   # skip binary download, reconfigure only
)

$ErrorActionPreference = 'Stop'

# ─── Constants ────────────────────────────────────────────────────────────────

$REPO       = "videnovnebojsa/vault-mcp"
$ARTIFACT   = "vault-mcp-windows-x64.exe"
$BIN_DIR    = Join-Path $env:LOCALAPPDATA "vault-mcp"
$BIN_PATH   = Join-Path $BIN_DIR "vault-mcp.exe"
$CFG_DIR    = Join-Path $env:APPDATA "vault-mcp"
$CFG_FILE   = Join-Path $CFG_DIR ".env"
$VER_FILE   = Join-Path $CFG_DIR ".installed-version"

# ─── Helpers ──────────────────────────────────────────────────────────────────

function Write-Step  { Write-Host "→ $args" -ForegroundColor Cyan }
function Write-Ok    { Write-Host "✔ $args" -ForegroundColor Green }
function Write-Warn  { Write-Host "⚠ $args" -ForegroundColor Yellow }
function Write-Err   { Write-Host "✘ Error: $args" -ForegroundColor Red; exit 1 }

function Get-CfgValue([string]$Key) {
    if (-not (Test-Path $CFG_FILE)) { return "" }
    $line = Get-Content $CFG_FILE | Where-Object { $_ -match "^${Key}=" } | Select-Object -First 1
    if ($line) { return ($line -split "=", 2)[1].Trim('"') }
    return ""
}

function Prompt-Input([string]$Message, [string]$Default) {
    if ($Default) {
        Write-Host -NoNewline "${Message} [${Default}]: " -ForegroundColor White
    } else {
        Write-Host -NoNewline "${Message}: " -ForegroundColor White
    }
    $input = Read-Host
    if ([string]::IsNullOrWhiteSpace($input)) { return $Default }
    return $input
}

# ─── Banner ───────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "vault-mcp installer" -ForegroundColor White -BackgroundColor DarkBlue
Write-Host "────────────────────────────────────────" -ForegroundColor DarkGray
Write-Host ""

# ─── Step 1: Architecture check ───────────────────────────────────────────────

if (-not [Environment]::Is64BitOperatingSystem) {
    Write-Err "vault-mcp requires a 64-bit Windows installation"
}

# ─── Steps 2-4: Download binary ───────────────────────────────────────────────

if (-not $Configure) {
    Write-Step "Checking latest release..."
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$REPO/releases/latest"
    $LATEST_TAG = $release.tag_name
    if (-not $LATEST_TAG) { Write-Err "Could not fetch latest release tag — check your internet connection" }
    Write-Step "Latest release: $LATEST_TAG"

    $INSTALLED_TAG = if (Test-Path $VER_FILE) { Get-Content $VER_FILE -Raw } else { "" }
    $INSTALLED_TAG = $INSTALLED_TAG.Trim()

    if ((Test-Path $BIN_PATH) -and ($INSTALLED_TAG -eq $LATEST_TAG)) {
        Write-Ok "Already on $LATEST_TAG — skipping download"
    } else {
        if ($INSTALLED_TAG) {
            Write-Step "Upgrading $INSTALLED_TAG → $LATEST_TAG..."
        } else {
            Write-Step "Downloading $ARTIFACT..."
        }
        New-Item -ItemType Directory -Force -Path $BIN_DIR | Out-Null
        $DOWNLOAD_URL = "https://github.com/$REPO/releases/download/$LATEST_TAG/$ARTIFACT"
        Invoke-WebRequest -Uri $DOWNLOAD_URL -OutFile $BIN_PATH -UseBasicParsing
        New-Item -ItemType Directory -Force -Path $CFG_DIR | Out-Null
        Set-Content -Path $VER_FILE -Value $LATEST_TAG -NoNewline
        Write-Ok "Binary installed: $BIN_PATH ($LATEST_TAG)"
    }
}

# ─── Step 5: Configuration ────────────────────────────────────────────────────

New-Item -ItemType Directory -Force -Path $CFG_DIR | Out-Null
Write-Host ""
Write-Host "Configuration" -ForegroundColor White
Write-Host ("─" * 13)
Write-Host "Settings file: " -NoNewline; Write-Host $CFG_FILE -ForegroundColor Cyan
Write-Host ""

# Vault path (required)
$currentVault = Get-CfgValue "VAULT_DEFAULT_PATH"
$VAULT_PATH = Prompt-Input "Vault path (e.g. C:\Users\you\Documents\obsidian)" $currentVault
if ([string]::IsNullOrWhiteSpace($VAULT_PATH)) { Write-Err "Vault path is required" }
$VAULT_PATH = $VAULT_PATH -replace "^~", $env:USERPROFILE
if (-not (Test-Path $VAULT_PATH -PathType Container)) {
    Write-Err "Directory not found: $VAULT_PATH"
}

# Port
$currentPort = Get-CfgValue "MCP_PORT"
if (-not $currentPort) { $currentPort = "3782" }
$MCP_PORT = Prompt-Input "Port" $currentPort
if ($MCP_PORT -notmatch '^\d+$') { Write-Err "Port must be a number" }

# API key
$currentKey = Get-CfgValue "MCP_API_KEY"
if ($currentKey) {
    $input = Prompt-Input "API key (leave blank to keep current)" ""
    $MCP_API_KEY = if ($input) { $input } else { $currentKey }
} else {
    $MCP_API_KEY = Prompt-Input "API key (optional — leave empty for local-only)" ""
}

# Embeddings
$currentEmb = Get-CfgValue "ENABLE_EMBEDDINGS"
if (-not $currentEmb) { $currentEmb = "false" }
if ($currentEmb -eq "true") {
    $answer = Prompt-Input "Keep vector embeddings enabled? [Y/n]" "Y"
    $ENABLE_EMBEDDINGS = if ($answer -match '^[Nn]') { "false" } else { "true" }
} else {
    $answer = Prompt-Input "Enable vector embeddings? [y/N]" "N"
    $ENABLE_EMBEDDINGS = if ($answer -match '^[Yy]') { "true" } else { "false" }
}

$EMBEDDINGS_ENDPOINT = ""
$EMBEDDINGS_API_KEY  = ""
if ($ENABLE_EMBEDDINGS -eq "true") {
    $currentEmbUrl = Get-CfgValue "EMBEDDINGS_BASE_URL"
    if (-not $currentEmbUrl) { $currentEmbUrl = "https://api.openai.com/v1" }
    $EMBEDDINGS_ENDPOINT = Prompt-Input "Embeddings endpoint" $currentEmbUrl

    $currentEmbKey = Get-CfgValue "EMBEDDINGS_API_KEY"
    if ($currentEmbKey) {
        $input = Prompt-Input "Embeddings API key (leave blank to keep current)" ""
        $EMBEDDINGS_API_KEY = if ($input) { $input } else { $currentEmbKey }
    } else {
        $EMBEDDINGS_API_KEY = Prompt-Input "Embeddings API key" ""
    }
}

# Write config file
$cfg = @(
    "# vault-mcp configuration"
    "# Generated by install.ps1 on $(Get-Date -Format 'yyyy-MM-dd')"
    "# Full config reference: https://github.com/$REPO/blob/main/docs/configuration.md"
    "# Interactive editor (requires Bun): bun run configure"
    ""
    "VAULT_DEFAULT_PATH=$VAULT_PATH"
    "MCP_PORT=$MCP_PORT"
)
if ($MCP_API_KEY)        { $cfg += "MCP_API_KEY=$MCP_API_KEY" }
$cfg += "ENABLE_EMBEDDINGS=$ENABLE_EMBEDDINGS"
if ($EMBEDDINGS_ENDPOINT) { $cfg += "EMBEDDINGS_BASE_URL=$EMBEDDINGS_ENDPOINT" }
if ($EMBEDDINGS_API_KEY)  { $cfg += "EMBEDDINGS_API_KEY=$EMBEDDINGS_API_KEY" }

$cfg | Set-Content -Path $CFG_FILE
Write-Ok "Config written to $CFG_FILE"

# ─── Step 6: Add to PATH and register Task Scheduler ─────────────────────────

Write-Host ""
Write-Host "Background service" -ForegroundColor White
Write-Host ("─" * 18)

# Ensure BIN_DIR is in user PATH
$userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if ($userPath -notlike "*$BIN_DIR*") {
    [Environment]::SetEnvironmentVariable("PATH", "$userPath;$BIN_DIR", "User")
    Write-Ok "Added $BIN_DIR to your user PATH (restart your terminal to take effect)"
}

# Check if task already exists
$taskExists = schtasks /Query /TN "vault-mcp" 2>$null; $taskRegistered = $LASTEXITCODE -eq 0

if ($taskRegistered -and $Configure) {
    schtasks /End /TN "vault-mcp" 2>$null | Out-Null
    schtasks /Run /TN "vault-mcp" | Out-Null
    Write-Ok "Service restarted with new config"
} else {
    $answer = Prompt-Input "Install as a background service (auto-starts at login)? [Y/n]" "Y"
    if ($answer -notmatch '^[Nn]') {
        $xmlPath = Join-Path $env:TEMP "vault-mcp-task.xml"
        $xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.3" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled></LogonTrigger>
  </Triggers>
  <Actions>
    <Exec>
      <Command>$BIN_PATH</Command>
      <WorkingDirectory>$CFG_DIR</WorkingDirectory>
    </Exec>
  </Actions>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT30S</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
</Task>
"@
        $xml | Set-Content -Path $xmlPath -Encoding Unicode
        schtasks /Create /TN "vault-mcp" /XML $xmlPath /F | Out-Null
        schtasks /Run /TN "vault-mcp" | Out-Null
        Remove-Item $xmlPath -Force
        Write-Ok "Service registered in Task Scheduler and started"
        Write-Host "  Restart: " -NoNewline
        Write-Host 'schtasks /End /TN vault-mcp; schtasks /Run /TN vault-mcp' -ForegroundColor Cyan
    } else {
        Write-Step "Service install skipped. Start manually: vault-mcp"
    }
}

# ─── Step 7: Connection instructions ─────────────────────────────────────────

Write-Host ""
Write-Host "Connect Claude Code" -ForegroundColor White
Write-Host ("─" * 19)
Write-Host "Add to " -NoNewline; Write-Host ".mcp.json" -ForegroundColor Cyan -NoNewline; Write-Host " in your project root:"
Write-Host @"
{
  "mcpServers": {
    "vault": { "type": "http", "url": "http://127.0.0.1:$MCP_PORT/mcp" }
  }
}
"@

Write-Host "Verify" -ForegroundColor White
Write-Host ("─" * 6)
Write-Host "  " -NoNewline; Write-Host "curl http://localhost:$MCP_PORT/health" -ForegroundColor Cyan

Write-Host ""
Write-Host "Reconfigure anytime" -ForegroundColor White
Write-Host ("─" * 19)
Write-Host "  " -NoNewline; Write-Host ".\install.ps1 -Configure" -ForegroundColor Cyan -NoNewline
Write-Host "   — quick wizard (no download)"
Write-Host "  " -NoNewline; Write-Host "bun run configure" -ForegroundColor Cyan -NoNewline
Write-Host "          — full editor (requires Bun)"
Write-Host "  " -NoNewline; Write-Host $CFG_FILE -ForegroundColor Cyan -NoNewline
Write-Host "  — edit directly"

Write-Host ""
Write-Host "✔ Done! vault-mcp is ready." -ForegroundColor Green
Write-Host ""
