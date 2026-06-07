#!/usr/bin/env bash
#
# Deploy/restart do auditoria (suíte Auditoria — Casa Hacker).
#
# Reconstrói a imagem `localhost/auditoria:latest` (carimbando o APP_COMMIT no rodapé do
# relatório) e reinicia o serviço SEMPRE via systemd.
#
# ⚠️  NUNCA suba com `podman-compose up -d` direto. O unit auditoria.service tem ExecStartPre
#     que remove o container, a rede `auditoria_auditoria-net` e a **bridge kernel stale de
#     10.89.11.0/24** antes do `up`. Pular essa limpeza derruba a app (network create exit
#     125 — subnet em uso) depois que o `down` já matou o container.
#
# Uso:
#   ./restart.sh             # build (com APP_COMMIT) + restart + health check
#   ./restart.sh --no-build  # só reinicia o serviço (sem rebuild)
#
set -euo pipefail
cd "$(dirname "$0")"

PORT=18088
BUILD=1
[ "${1:-}" = "--no-build" ] && BUILD=0

if [ "$BUILD" = "1" ]; then
  APP_COMMIT="$(git rev-parse --short HEAD)"
  echo "==> Build da imagem (APP_COMMIT=$APP_COMMIT)..."
  # /var só tem ~4GB → TMPDIR no /data; BUILDAH_FORMAT=docker p/ HEALTHCHECK + ARG.
  sudo env TMPDIR=/data/podman-tmp/tmp BUILDAH_FORMAT=docker APP_COMMIT="$APP_COMMIT" \
    podman-compose build
fi

echo "==> Reiniciando o serviço (systemd limpa a bridge stale antes de subir)..."
sudo systemctl restart auditoria.service

echo "==> Aguardando health check (até 60s)..."
for i in $(seq 1 12); do
  sleep 5
  if curl -sf "http://127.0.0.1:${PORT}/api/health" 2>/dev/null | grep -q '"status":"ok"'; then
    echo "==> OK — auditoria saudável em http://127.0.0.1:${PORT}${APP_COMMIT:+ (APP_COMMIT $APP_COMMIT)}"
    exit 0
  fi
  echo "   aguardando... ($i/12)"
done

echo "ERRO: serviço não respondeu após 60s. Últimos logs:"
sudo podman logs --tail 30 auditoria
exit 1
