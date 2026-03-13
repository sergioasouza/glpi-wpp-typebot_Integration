#!/bin/bash
#################################################################
#  Monitoramento: containers Docker + Evolution API + saúde dos serviços
#  Adicionar no cron (como root):
#  */3 * * * * /opt/stack/scripts/monitor.sh >> /var/log/stack-monitor.log 2>&1
#################################################################

set -uo pipefail

EVOLUTION_KEY="${AUTHENTICATION_API_KEY:-}"
EVOLUTION_INSTANCE="${EVOLUTION_INSTANCE_NAME:-glpi-bot}"
LOG_PREFIX="$(date '+%Y-%m-%d %H:%M:%S')"

# ── Verificar WhatsApp (Evolution API — local) ──────────────
if [ -n "$EVOLUTION_KEY" ]; then
  WPP_STATUS=$(curl -sf "http://localhost:8080/instance/connectionState/${EVOLUTION_INSTANCE}" \
    -H "apikey: $EVOLUTION_KEY" 2>/dev/null | python3 -c \
    "import sys,json; d=json.load(sys.stdin); print(d.get('instance',{}).get('state','unknown') if 'instance' in d else d.get('state','unknown'))" 2>/dev/null || echo "unreachable")

  if [ "$WPP_STATUS" != "open" ]; then
    echo "$LOG_PREFIX ❌ WhatsApp DESCONECTADO — estado: $WPP_STATUS (reconectar via painel Evolution)"
    # Descomente para alerta por email:
    # echo "WhatsApp desconectado ($WPP_STATUS)" | mail -s "⚠️ WhatsApp Bot Down" admin@seudominio.com.br
  else
    echo "$LOG_PREFIX ✅ WhatsApp OK (Evolution API)"
  fi
else
  echo "$LOG_PREFIX ⚠️ AUTHENTICATION_API_KEY não definida — pulando check WhatsApp"
fi

# ── Verificar GLPI Proxy ────────────────────────────────────
PROXY_STATUS=$(curl -sf "http://localhost:3003/health" 2>/dev/null | python3 -c \
  "import sys,json; d=json.load(sys.stdin); print(d.get('status','unknown'))" 2>/dev/null || echo "unreachable")

if [ "$PROXY_STATUS" != "ok" ]; then
  echo "$LOG_PREFIX ⚠️ GLPI Proxy — estado: $PROXY_STATUS"
fi

# ── Verificar Typebot ───────────────────────────────────────
TYPEBOT_OK=$(curl -sf "http://localhost:3001/" -o /dev/null -w "%{http_code}" 2>/dev/null || echo "000")

if [ "$TYPEBOT_OK" = "000" ]; then
  echo "$LOG_PREFIX ❌ Typebot Builder INACESSÍVEL"
fi

# ── Verificar containers Docker (auto-restart se parado) ───
for CONTAINER in evolution_api evolution_postgres evolution_redis typebot_builder typebot_viewer typebot_postgres glpi_proxy proxy_redis; do
  STATE=$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo "missing")
  if [ "$STATE" != "true" ]; then
    echo "$LOG_PREFIX ⚠️ Container $CONTAINER está $STATE — tentando restart..."
    docker start "$CONTAINER" 2>/dev/null || echo "$LOG_PREFIX ❌ Falha ao reiniciar $CONTAINER"
  fi
done

# ── Verificar disco (alerta se > 85%) ───────────────────────
DISK_USE=$(df / --output=pcent | tail -1 | tr -dc '0-9')
if [ "$DISK_USE" -gt 85 ]; then
  echo "$LOG_PREFIX ⚠️ DISCO em ${DISK_USE}% — limpar logs/backups antigos!"
fi

# ── Verificar memória (alerta se < 256MB livre) ─────────────
MEM_FREE=$(free -m | awk '/^Mem:/ {print $7}')
if [ "$MEM_FREE" -lt 256 ]; then
  echo "$LOG_PREFIX ⚠️ MEMÓRIA BAIXA — apenas ${MEM_FREE}MB disponível!"
fi
