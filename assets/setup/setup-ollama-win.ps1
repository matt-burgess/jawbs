# Career Pilot -- Ollama setup for Windows
# Installs Ollama via winget, configures CORS for the extension,
# and pulls the recommended model. Safe to re-run.

$ErrorActionPreference = "Stop"

Write-Host "==> Career Pilot: Ollama setup for Windows"
Write-Host ""

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: winget is required." -ForegroundColor Red
    Write-Host "Install App Installer from the Microsoft Store, then re-run."
    exit 1
}

if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
    Write-Host "==> Installing Ollama via winget..."
    winget install --id=Ollama.Ollama -e --accept-package-agreements --accept-source-agreements
    # Give the installer a moment and refresh PATH so we can call ollama in this session
    Start-Sleep -Seconds 2
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
} else {
    Write-Host "==> Ollama already installed."
}

Write-Host "==> Setting OLLAMA_ORIGINS for the browser extension (User scope)..."
[Environment]::SetEnvironmentVariable("OLLAMA_ORIGINS", "chrome-extension://*,http://localhost:*,brave://*", "User")

Write-Host "==> Waiting for Ollama to accept connections..."
$timeout = 30
while ($timeout -gt 0) {
    try {
        $resp = Invoke-WebRequest -Uri "http://localhost:11434/api/version" -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        if ($resp.StatusCode -eq 200) { break }
    } catch {
        Start-Sleep -Seconds 1
        $timeout -= 1
    }
}
if ($timeout -le 0) {
    Write-Host "WARNING: Ollama did not respond in 30s. If this is a fresh install, launch 'Ollama' from Start Menu once, then re-run." -ForegroundColor Yellow
    exit 1
}
Write-Host "    ready."

$model = "qwen2.5:14b-instruct"
$existing = ollama list 2>$null | Select-String "^$model"
if ($existing) {
    Write-Host "==> Model $model already pulled."
} else {
    Write-Host "==> Pulling $model (~9 GB, can take a few minutes)..."
    ollama pull $model
}

Write-Host ""
Write-Host "==> Done."
Write-Host "    Return to Career Pilot Settings and click 'Recheck status'."
