#!/usr/bin/env bash
set -euo pipefail

BRANCH="feature/v34-dual-market-engine"
COMPOSE="docker-compose.linux.yml"
EXPECTED_RELEASE="2026.09.02-R15"
EXPECTED_EDITION="XAU_CRUDE_DUAL_REALTIME_BACKTEST"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UPDATER_SOCKET="/run/quantum-updater/agent.sock"
FROM_AGENT=0
if [[ "${1:-}" == "--from-agent" ]]; then FROM_AGENT=1; fi
cd "$ROOT"

if [[ "$EUID" -eq 0 ]]; then SUDO=""; else SUDO="sudo"; fi
DOCKER=( $SUDO docker compose -f "$COMPOSE" )

echo "== Quantum Commodities Dual R15 updater =="
echo "Repo: $ROOT"
echo "Mode: $([[ "$FROM_AGENT" -eq 1 ]] && echo WEB_AGENT || echo MANUAL)"

if [[ "$FROM_AGENT" -eq 0 ]]; then
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "ERROR: el repositorio tiene cambios locales. No haré reset para no borrarlos."
    git status --short
    exit 2
  fi
  echo "[1/8] Descargando rama correcta..."
  git fetch origin "$BRANCH"
  git checkout "$BRANCH"
  git reset --hard "origin/$BRANCH"
else
  echo "[1/8] Git ya fue actualizado por Quantum Update Agent."
fi

COMMIT="$(git rev-parse --short HEAD 2>/dev/null || true)"
echo "Commit desplegado: $COMMIT"

if [[ "$FROM_AGENT" -eq 0 ]]; then
  echo "[2/8] Instalando/actualizando Quantum Update Agent local..."
  $SUDO bash scripts/install-update-agent.sh "$ROOT"
else
  echo "[2/8] Update Agent ya está ejecutando este despliegue."
fi

if [[ ! -S "$UPDATER_SOCKET" ]]; then
  echo "ERROR: falta $UPDATER_SOCKET; no iniciaré frontend con un mount inválido."
  exit 6
fi

echo "[3/8] Reconstruyendo R15 SIN cache..."
"${DOCKER[@]}" build --no-cache backend frontend

echo "[4/8] Recreando contenedores sin borrar SQLite..."
"${DOCKER[@]}" up -d --force-recreate --remove-orphans

echo "[5/8] Estado Docker:"
"${DOCKER[@]}" ps

echo "[6/8] Verificando backend R15..."
BACKEND_OK=0
for i in {1..50}; do
  if curl -fsS http://127.0.0.1:8080/backend/health >/tmp/r15-health.json 2>/dev/null; then
    cat /tmp/r15-health.json
    echo
    if grep -q "$EXPECTED_EDITION" /tmp/r15-health.json; then
      BACKEND_OK=1
      break
    fi
  fi
  sleep 1
done
if [[ "$BACKEND_OK" -ne 1 ]]; then
  echo "ERROR: backend servido no es R15 Dual Realtime/Backtest."
  "${DOCKER[@]}" logs --tail=180 backend
  exit 4
fi

echo "[7/8] Verificando updater vía Nginx..."
UPDATER_OK=0
for i in {1..20}; do
  if curl -fsS http://127.0.0.1:8080/updater/status >/tmp/r15-updater.json 2>/dev/null; then
    cat /tmp/r15-updater.json
    echo
    UPDATER_OK=1
    break
  fi
  sleep 0.5
done
if [[ "$UPDATER_OK" -ne 1 ]]; then
  echo "ERROR: Quantum Update Agent no es accesible vía /updater/status."
  $SUDO systemctl status quantum-update-agent.service --no-pager || true
  exit 7
fi

echo "[8/8] Verificando release/frontend R15..."
RELEASE_TEXT="$(curl -fsS -H 'Cache-Control: no-cache' "http://127.0.0.1:8080/release.txt?ts=$(date +%s)" || true)"
printf '%s\n' "$RELEASE_TEXT"
if [[ "$RELEASE_TEXT" != *"Release: $EXPECTED_RELEASE"* ]]; then
  echo "ERROR: el frontend servido NO es $EXPECTED_RELEASE."
  exit 3
fi
HTML="$(curl -fsS -H 'Cache-Control: no-cache' "http://127.0.0.1:8080/?ts=$(date +%s)" || true)"
if [[ "$HTML" != *"Quantum Dual Commodities R15"* ]]; then
  echo "ERROR: index.html no muestra Quantum Dual Commodities R15."
  exit 5
fi

echo
printf 'OK. Release verificada: %s\n' "$EXPECTED_RELEASE"
echo "En el navegador debes ver: BUILD R15 · REALTIME 500ms · BACKTEST."
echo "Las siguientes versiones podrán aplicarse desde la propia app."
