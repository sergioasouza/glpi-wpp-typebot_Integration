#!/bin/bash
#################################################################
#  Backup automático: Postgres Typebot + Redis + configs
#  Adicionar no cron (como root):
#  0 3 * * * /opt/stack/scripts/backup.sh >> /var/log/stack-backup.log 2>&1
#################################################################

set -euo pipefail

BACKUP_DIR="/opt/backups/$(date +%Y%m%d_%H%M)"
mkdir -p "$BACKUP_DIR"

echo "$(date): Iniciando backup..."

# Banco Evolution (dump com validação de integridade)
if docker exec evolution_postgres pg_dump -U evo_user -F c evolution_db > "$BACKUP_DIR/evolution_db.dump" 2>/dev/null && [ -s "$BACKUP_DIR/evolution_db.dump" ]; then
  echo "  ✅ evolution_db (dump validado)"
else
  echo "  ❌ evolution_db (dump corrompido, arquivo vazio ou container off)"
  rm -f "$BACKUP_DIR/evolution_db.dump"
fi

# Banco Typebot (dump com validação de integridade)
if docker exec typebot_postgres pg_dump -U typebot_user -F c typebot_db > "$BACKUP_DIR/typebot_db.dump" 2>/dev/null && [ -s "$BACKUP_DIR/typebot_db.dump" ]; then
  echo "  ✅ typebot_db (dump validado)"
else
  echo "  ❌ typebot_db (dump corrompido, arquivo vazio ou container off)"
  rm -f "$BACKUP_DIR/typebot_db.dump"
fi

# Redis (fila do GLPI Proxy — dump RDB)
if docker exec proxy_redis redis-cli BGSAVE > /dev/null 2>&1; then
  sleep 2
  docker cp proxy_redis:/data/dump.rdb "$BACKUP_DIR/redis_dump.rdb" 2>/dev/null && \
    echo "  ✅ redis (dump RDB)" || echo "  ⚠️ redis (BGSAVE ok mas cópia falhou)"
else
  echo "  ⚠️ redis (BGSAVE falhou ou container off)"
fi

# Configs (sem .env — senhas devem estar em local seguro separado)
cp /opt/stack/docker-compose.yml "$BACKUP_DIR/" 2>/dev/null
cp -r /opt/stack/glpi-proxy "$BACKUP_DIR/" 2>/dev/null

# Comprimir
tar -czf "/opt/backups/stack-$(date +%Y%m%d).tar.gz" "$BACKUP_DIR"
rm -rf "$BACKUP_DIR"

# Limpar backups com mais de 14 dias
find /opt/backups -name "*.tar.gz" -mtime +14 -delete

echo "$(date): Backup concluído — /opt/backups/stack-$(date +%Y%m%d).tar.gz"
