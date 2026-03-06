#!/bin/bash
#################################################################
#  Monitoramento da conexão WhatsApp + saúde dos serviços
#  Adicionar no cron (como root):
#  */3 * * * * /opt/stack/scripts/monitor.sh >> /var/log/stack-monitor.log 2>&1
#################################################################

set -uo pipefail

APIKEY="${EVOLUTION_APIKEY:-SUA_APIKEY_AQUI}"
INSTANCE="glpi-bot"
LOG_PREFIX="$(date '+%Y-%m-%d %H:%M:%S')"

# ── Verificar WhatsApp ──────────────────────────────────────
WPP_STATUS=$(curl -sf "http://localhost:8080/instance/connectionState/$INSTANCE" \
  -H "apikey: $APIKEY" 2>/dev/null | python3 -c \
  "import sys,json; d=json.load(sys.stdin); print(d.get('state','unknown'))" 2>/dev/null || echo "unreachable")

if [ "$WPP_STATUS" != "open" ]; then
  echo "$LOG_PREFIX ❌ WhatsApp DESCONECTADO — estado: $WPP_STATUS"
  # Descomente a linha abaixo para receber alerta por email:
  # echo "WhatsApp desconectado ($WPP_STATUS)" | mail -s "⚠️ WhatsApp Bot Down" admin@seudominio.com.br
else
  echo "$LOG_PREFIX ✅ WhatsApp OK"
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
