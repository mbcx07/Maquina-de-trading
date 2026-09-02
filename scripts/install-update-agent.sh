#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-$(pwd)}"
ROOT="$(cd "$ROOT" && pwd)"
SERVICE_FILE="/etc/systemd/system/quantum-update-agent.service"
SOCKET_DIR="/run/quantum-updater"
SOCKET_FILE="$SOCKET_DIR/agent.sock"

mkdir -p "$SOCKET_DIR"
chmod 755 "$SOCKET_DIR"

cat >"$SERVICE_FILE" <<EOF
[Unit]
Description=Quantum Trading Local Update Agent
After=network-online.target local-fs.target
Wants=network-online.target

[Service]
Type=simple
User=root
Environment=QUANTUM_REPO_ROOT=$ROOT
Environment=QUANTUM_UPDATE_BRANCH=feature/v34-dual-market-engine
Environment=QUANTUM_UPDATE_SOCKET=$SOCKET_FILE
Environment=QUANTUM_UPDATE_LOG=/var/log/quantum-updater.log
ExecStart=/usr/bin/python3 $ROOT/scripts/quantum_update_agent.py
Restart=always
RestartSec=3
UMask=0000
NoNewPrivileges=false

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable quantum-update-agent.service >/dev/null
systemctl restart quantum-update-agent.service

for i in {1..30}; do
  if [[ -S "$SOCKET_FILE" ]]; then
    chmod 666 "$SOCKET_FILE"
    echo "Quantum Update Agent listo: $SOCKET_FILE"
    exit 0
  fi
  sleep 0.25
done

echo "ERROR: Quantum Update Agent no creó el socket local." >&2
systemctl status quantum-update-agent.service --no-pager || true
exit 1
