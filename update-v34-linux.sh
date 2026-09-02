#!/usr/bin/env bash
set -euo pipefail

BRANCH="feature/v34-dual-market-engine"
COMPOSE="docker-compose.linux.yml"
EXPECTED_RELEASE="2026.09.02-R12"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

echo "== Quantum Commodities R12 updater =="
echo "Repo: $ROOT"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "ERROR: el repositorio tiene cambios locales. No haré reset para no borrarlos."
  git status --short
  exit 2
fi

echo "[1/6] Descargando rama correcta..."
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"
COMMIT="$(git rev-parse --short HEAD)"
echo "Commit desplegado: $COMMIT"

echo "[2/6] Reconstruyendo R12 SIN cache..."
sudo docker compose -f "$COMPOSE" build --no-cache backend frontend

echo "[3/6] Recreando contenedores sin borrar SQLite..."
sudo docker compose -f "$COMPOSE" up -d --force-recreate --remove-orphans

echo "[4/6] Estado Docker:"
sudo docker compose -f "$COMPOSE" ps

echo "[5/6] Verificando backend R12..."
BACKEND_OK=0
for i in {1..40}; do
  if curl -fsS http://127.0.0.1:8080/backend/health >/tmp/r12-health.json 2>/dev/null; then
    cat /tmp/r12-health.json
    echo
    if grep -q 'XAUUSDT_BINANCE_CLUSDT_ASTER' /tmp/r12-health.json; then
      BACKEND_OK=1
      break
    fi
  fi
  sleep 1
done
if [[ "$BACKEND_OK" -ne 1 ]]; then
  echo "ERROR: backend servido no es R12 Commodities."
  sudo docker compose -f "$COMPOSE" logs --tail=120 backend
  exit 4
fi

echo "[6/6] Verificando release/frontend R12..."
RELEASE_TEXT="$(curl -fsS -H 'Cache-Control: no-cache' "http://127.0.0.1:8080/release.txt?ts=$(date +%s)" || true)"
printf '%s\n' "$RELEASE_TEXT"
if [[ "$RELEASE_TEXT" != *"Release: $EXPECTED_RELEASE"* ]]; then
  echo "ERROR: el frontend servido NO es $EXPECTED_RELEASE."
  exit 3
fi
HTML="$(curl -fsS -H 'Cache-Control: no-cache' "http://127.0.0.1:8080/?ts=$(date +%s)" || true)"
if [[ "$HTML" != *"Quantum R12"* ]]; then
  echo "ERROR: index.html no muestra Quantum R12."
  exit 5
fi

echo
printf 'OK. Release verificada: %s\n' "$EXPECTED_RELEASE"
echo "En el navegador debes ver: BUILD R12 · XAU + CRUDE · 30s/1m."
echo "Política: XAUUSDT BUY/SELL · CLUSDT BUY-ONLY · PAPER por defecto · REAL bloqueado salvo habilitación explícita."
