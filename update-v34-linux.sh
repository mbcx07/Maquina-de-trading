#!/usr/bin/env bash
set -euo pipefail

BRANCH="feature/v34-dual-market-engine"
COMPOSE="docker-compose.linux.yml"
EXPECTED_RELEASE="2026.08.27-R9"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

echo "== Quantum Dual V34 updater =="
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

echo "[2/6] Reconstruyendo SIN cache..."
sudo docker compose -f "$COMPOSE" build --no-cache backend frontend

echo "[3/6] Recreando contenedores sin borrar el volumen SQLite..."
sudo docker compose -f "$COMPOSE" up -d --force-recreate --remove-orphans

echo "[4/6] Estado Docker:"
sudo docker compose -f "$COMPOSE" ps

echo "[5/6] Verificando backend..."
BACKEND_OK=0
for i in {1..30}; do
  if curl -fsS http://127.0.0.1:8080/backend/health >/tmp/v34-health.json 2>/dev/null; then
    cat /tmp/v34-health.json
    echo
    BACKEND_OK=1
    break
  fi
  sleep 1
done
if [[ "$BACKEND_OK" -ne 1 ]]; then
  echo "ERROR: backend no respondió por el proxy después del despliegue."
  sudo docker compose -f "$COMPOSE" logs --tail=80 backend
  exit 4
fi

echo "[6/6] Verificando release servido por el frontend..."
RELEASE_TEXT="$(curl -fsS -H 'Cache-Control: no-cache' "http://127.0.0.1:8080/release.txt?ts=$(date +%s)" || true)"
printf '%s\n' "$RELEASE_TEXT"
if [[ "$RELEASE_TEXT" != *"Release: $EXPECTED_RELEASE"* ]]; then
  echo "ERROR: el frontend servido NO es $EXPECTED_RELEASE."
  echo "Revisa contenedores/imágenes Docker; no continúes suponiendo que la UI se actualizó."
  exit 3
fi

echo
printf 'OK. Release verificada: %s\n' "$EXPECTED_RELEASE"
echo "En el navegador debes ver: Quantum Dual V34 R9 y la etiqueta BUILD R9 · M5/M15 · AUTO."
