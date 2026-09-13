#!/usr/bin/env bash
# Job Thresher — Ollama setup for macOS
# Installs Ollama, starts the service, configures CORS for the extension,
# and pulls the recommended model. Safe to re-run.
set -e

echo "==> Job Thresher: Ollama setup for macOS"
echo

if ! command -v brew >/dev/null 2>&1; then
  echo "ERROR: Homebrew is required."
  echo "Install from https://brew.sh, then re-run this script."
  exit 1
fi

if ! command -v ollama >/dev/null 2>&1; then
  echo "==> Installing Ollama via Homebrew..."
  brew install ollama
else
  echo "==> Ollama already installed ($(ollama --version 2>&1 | head -1))"
fi

echo "==> Starting Ollama service..."
brew services start ollama >/dev/null 2>&1 || true

echo "==> Setting OLLAMA_ORIGINS so the browser extension can call the API..."
ORIGINS="chrome-extension://*,http://localhost:*,brave://*"
# Set for the current session (takes effect after next ollama start)
launchctl setenv OLLAMA_ORIGINS "$ORIGINS"
# Persist across reboots by writing it into the LaunchAgent plist.
# launchctl setenv alone does NOT survive reboot/logout — this is the fix
# for the "worked yesterday, 403s today" symptom.
PLIST="$HOME/Library/LaunchAgents/homebrew.mxcl.ollama.plist"
if [ -f "$PLIST" ]; then
  /usr/libexec/PlistBuddy -c "Delete :EnvironmentVariables:OLLAMA_ORIGINS" "$PLIST" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:OLLAMA_ORIGINS string '$ORIGINS'" "$PLIST"
  echo "    persisted OLLAMA_ORIGINS in $PLIST"
else
  echo "    NOTE: $PLIST not found — env is set for this session only."
  echo "          After next reboot you may need to re-run this script."
fi
brew services restart ollama >/dev/null 2>&1 || true

echo "==> Waiting for Ollama to accept connections..."
timeout=30
while ! curl -sf http://localhost:11434/api/version >/dev/null 2>&1; do
  sleep 1
  timeout=$((timeout - 1))
  if [ $timeout -le 0 ]; then
    echo "ERROR: Ollama did not start within 30 seconds."
    echo "Try: brew services restart ollama"
    exit 1
  fi
done
echo "    ready."

MODEL="qwen2.5:14b-instruct"
if ollama list 2>/dev/null | grep -q "^${MODEL}"; then
  echo "==> Model ${MODEL} already pulled."
else
  echo "==> Pulling ${MODEL} (~9 GB, this can take a few minutes)..."
  ollama pull "${MODEL}"
fi

echo
echo "==> Done."
echo "    Return to Job Thresher Settings and click 'Recheck status'."
