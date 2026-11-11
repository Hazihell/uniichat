#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
command -v brave-browser >/dev/null
command -v npm >/dev/null
if ss -H -ltn 'sport = :9222' | grep -q .; then
  if ! systemctl --user is-active --quiet unii-browser.service; then
    echo 'Port 9222 is already in use; leaving it alone.' >&2
    exit 1
  fi
fi
npm ci --ignore-scripts
install -d -m 700 "$HOME/.local/share/unii-browser/profile"
install -d "$HOME/.config/systemd/user"
install -m 644 brave.service "$HOME/.config/systemd/user/unii-browser.service"
systemctl --user daemon-reload
systemctl --user enable --now unii-browser.service
