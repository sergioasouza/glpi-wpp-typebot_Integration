#!/bin/bash
#################################################################
#  Backup automático dos bancos e configs
#  Adicionar no cron (como root):
#  0 3 * * * /opt/stack/scripts/backup.sh >> /var/log/stack-backup.log 2>&1
#################################################################

set -euo pipefail

BACKUP_DIR="/opt/backups/$(date +%Y%m%d_%H%M)"
mkdir -p "$BACKUP_DIR"

echo "$(date): Iniciando backup..."

# Banco Evolution
docker exec evolution_postgres pg_dump -U evolution_user evolution_db > "$BACKUP_DIR/evolution_db.sql" 2>/dev/null && \
  echo "  ✅ evolution_db" || echo "  ❌ evolution_db (container off?)"

# Banco Typebot
docker exec typebot_postgres pg_dump -U typebot_user typebot_db > "$BACKUP_DIR/typebot_db.sql" 2>/dev/null && \
  echo "  ✅ typebot_db" || echo "  ❌ typebot_db (container off?)"

# Sessões Baileys (para não perder conexão WhatsApp)
docker cp evolution_api:/evolution/instances "$BACKUP_DIR/evolution_instances/" 2>/dev/null && \
  echo "  ✅ evolution_instances" || echo "  ❌ evolution_instances"

# Configs (sem os .env com senhas — esses devem estar em local seguro separado)
cp /opt/stack/docker-compose.yml "$BACKUP_DIR/" 2>/dev/null
cp -r /opt/stack/glpi-proxy "$BACKUP_DIR/" 2>/dev/null

# Comprimir
tar -czf "/opt/backups/stack-$(date +%Y%m%d).tar.gz" "$BACKUP_DIR"
rm -rf "$BACKUP_DIR"

# Limpar backups com mais de 14 dias
find /opt/backups -name "*.tar.gz" -mtime +14 -delete

echo "$(date): Backup concluído — /opt/backups/stack-$(date +%Y%m%d).tar.gz"
