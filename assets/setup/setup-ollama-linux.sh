#!/usr/bin/env bash
# Job Thresher — Ollama setup for Linux
# Uses Ollama's official install script, configures CORS for the extension,
# and pulls the recommended model. Safe to re-run.
set -e

echo "==> Job Thresher: Ollama setup for Linux"
echo

if ! command -v ollama >/dev/null 2>&1; then
  echo "==> Installing Ollama via official installer..."
  curl -fsSL https://ollama.com/install.sh | sh
else
  echo "==> Ollama already installed ($(ollama --version 2>&1 | head -1))"
fi

echo "==> Configuring OLLAMA_ORIGINS so the extension can call the API..."
# Prefer a systemd drop-in when systemd is running
if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet ollama 2>/dev/null; then
  sudo mkdir -p /etc/systemd/system/ollama.service.d
  sudo tee /etc/systemd/system/ollama.service.d/override.conf >/dev/null <<'EOF'
[Service]
Environment="OLLAMA_ORIGINS=chrome-extension://*,http://localhost:*,brave://*"
EOF
  sudo systemctl daemon-reload
  sudo systemctl restart ollama
else
  echo "    systemd not detected; export OLLAMA_ORIGINS in your shell profile:"
  echo "    export OLLAMA_ORIGINS=\"chrome-extension://*,http://localhost:*,brave://*\""
fi

echo "==> Waiting for Ollama to accept connections..."
timeout=30
while ! curl -sf http://localhost:11434/api/version >/dev/null 2>&1; do
  sleep 1
  timeout=$((timeout - 1))
  if [ $timeout -le 0 ]; then
    echo "ERROR: Ollama did not start within 30 seconds."
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
