#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

echo "==> Parando container anterior..."
sudo podman stop stack-audit 2>/dev/null || true
sudo podman rm   stack-audit 2>/dev/null || true

echo "==> Garantindo permissões no volume de dados..."
sudo mkdir -p /data/stack-audit/data

echo "==> Subindo via podman compose..."
sudo BUILDAH_FORMAT=docker podman compose up -d

echo "==> Aguardando health check (até 60s)..."
for i in $(seq 1 12); do
  sleep 5
  STATUS=$(curl -sf http://127.0.0.1:18088/api/health 2>/dev/null \
    | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || true)
  if [ "$STATUS" = "ok" ]; then
    echo "==> OK — serviço disponível em http://127.0.0.1:18088"
    exit 0
  fi
  echo "   aguardando... ($i/12)"
done

echo "ERRO: serviço não respondeu após 60s. Últimos logs:"
sudo podman logs --tail 30 stack-audit
exit 1
