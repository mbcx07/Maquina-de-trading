#!/usr/bin/env bash
set -euo pipefail

BRANCH="feature/v34-dual-market-engine"
COMPOSE="docker-compose.linux.yml"
EXPECTED_RELEASE="2026.09.02-R13"
EXPECTED_EDITION="CRYPTO_R11_FAST_PLUS_XAUUSDT_CLUSDT"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

echo "== Quantum Hybrid R13 updater =="
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

echo "[2/6] Reconstruyendo R13 SIN cache..."
sudo docker compose -f "$COMPOSE" build --no-cache backend frontend

echo "[3/6] Recreando contenedores sin borrar SQLite..."
sudo docker compose -f "$COMPOSE" up -d --force-recreate --remove-orphans

echo "[4/6] Estado Docker:"
sudo docker compose -f "$COMPOSE" ps

echo "[5/6] Verificando backend R13..."
BACKEND_OK=0
for i in {1..40}; do
  if curl -fsS http://127.0.0.1:8080/backend/health >/tmp/r13-health.json 2>/dev/null; then
    cat /tmp/r13-health.json
    echo
    if grep -q "$EXPECTED_EDITION" /tmp/r13-health.json; then
      BACKEND_OK=1
      break
    fi
  fi
  sleep 1
done
if [[ "$BACKEND_OK" -ne 1 ]]; then
  echo "ERROR: backend servido no es R13 Hybrid."
  sudo docker compose -f "$COMPOSE" logs --tail=120 backend
  exit 4
fi

echo "[6/6] Verificando release/frontend R13..."
RELEASE_TEXT="$(curl -fsS -H 'Cache-Control: no-cache' "http://127.0.0.1:8080/release.txt?ts=$(date +%s)" || true)"
printf '%s\n' "$RELEASE_TEXT"
if [[ "$RELEASE_TEXT" != *"Release: $EXPECTED_RELEASE"* ]]; then
  echo "ERROR: el frontend servido NO es $EXPECTED_RELEASE."
  exit 3
fi
HTML="$(curl -fsS -H 'Cache-Control: no-cache' "http://127.0.0.1:8080/?ts=$(date +%s)" || true)"
if [[ "$HTML" != *"Quantum R13"* ]]; then
  echo "ERROR: index.html no muestra Quantum R13."
  exit 5
fi

echo
printf 'OK. Release verificada: %s\n' "$EXPECTED_RELEASE"
echo "En el navegador debes ver: BUILD R13 · CRYPTO FAST · XAU + CRUDE."
echo "Crypto: hasta 10 slots simultáneos, ejecución paralela, anti-stale 25s/0.25R."
echo "TradFi: XAUUSDT BUY/SELL · CLUSDT BUY-ONLY. Forex/Twelve Data OFF."
