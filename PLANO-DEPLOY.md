# 📘 Plano de Deploy — Integração WhatsApp + Typebot + GLPI

> **Documento completo e definitivo** — baseado no diagnóstico real da VPS.
> Última atualização: 04/03/2026

---

## 1. Diagnóstico da VPS

| Item | Valor |
|---|---|
| **OS** | Ubuntu 20.04.6 LTS |
| **CPUs** | 2 |
| **RAM** | 2.9 GB total / 2.3 GB disponível |
| **Disco** | 67 GB total / 52 GB livres (19% usado) |
| **GLPI** | `/var/www/html/glpi` — Apache na porta 80 |
| **Banco GLPI** | MySQL em `127.0.0.1:3306` — user `glpiuser`, db `glpi` |
| **PHP** | 7.4.3 |
| **VHosts Apache** | `000-default.conf` + `glpi.conf` (`glpi.seudominio.com`) |
| **Docker** | ❌ Não instalado |
| **Nginx** | ❌ Não instalado |
| **SSL/Certbot** | ❌ Não instalado |
| **UFW/Firewall** | ❌ Não instalado |
| **SSH** | Porta 22 (acessível via `ssh -p 22009`) |

---

## 2. Arquitetura Final (Zero-Trust & Alta Disponibilidade)

```
                            INTERNET
                                │
                          ┌─────┴─────┐
                          │   Nginx   │  ← porta 80/443 (SSL/WAF básico)
                          │  (proxy)  │
                          └─────┬─────┘
               ┌────────────────┼────────────────┬──────────────┐
               │                │                │              │
        glpi.dom.com    evolution.dom.com  typebot.dom.com  bot.dom.com
               │                │                │              │
               ▼                ▼                ▼              ▼
       Apache:8888     evolution_api    typebot_builder  typebot_viewer
       (GLPI nativo)   (127.0.0.1:8080) (127.0.0.1:3001) (127.0.0.1:3002)
                                │                │              │
                                └────────────────┼──────────────┘
                                                 ▼
        ┌─────────────────────────────────────────────────────────────┐
        │  glpi_proxy (127.0.0.1:3003)                                │
        │  - express-rate-limit & helmet                              │
        │  - Fila persistente (Redis) e Dead Letter Queue (DLQ)       │
        └────────────────────────┬────────────────────────────────────┘
                                 │
                                 ▼
                     Apache:8888/glpi/apirest.php

          [Redes Isoladas Docker - Menor Privilégio]
          1. evolution_db_net: evolution_api ↔ evo_postgres / evo_redis
          2. typebot_db_net: typebots ↔ typebot_postgres
          3. internal_net: glpi_proxy ↔ typebot / evolution
```

### Mapa de Portas

| Serviço | Porta Host | Porta Container | Acessível externamente? |
|---|---|---|---|
| GLPI (Apache) | `127.0.0.1:8888` | — | Não (via Nginx) |
| MySQL (GLPI) | `127.0.0.1:3306` | — | Não (já existia) |
| Nginx | `0.0.0.0:80/443` | — | ✅ Sim |
| Evolution API | `127.0.0.1:8080` | `8080` | Não |
| Typebot Builder | `127.0.0.1:3001` | `3000` | Não |
| Typebot Viewer | `127.0.0.1:3002` | `3000` | Não |
| GLPI Proxy | `127.0.0.1:3003` | `3003` | Não |
| Postgres (Evolution) | — | `5432` | Não (evolution_db_net) |
| Postgres (Typebot) | — | `5432` | Não (typebot_db_net) |
| Redis | — | `6379` | Não (evolution_db_net) |

---

## 3. Arquivos do Projeto

```
/opt/stack/
├── docker-compose.yml          ← stack completa c/ redes isoladas
├── .env                        ← variáveis de ambiente (chmod 600)
├── glpi-proxy/
│   ├── Dockerfile              ← build do proxy autônomo
│   ├── package.json            ← dependências (express, helmet, ioredis)
│   └── server.js               ← proxy (fila no Redis, DLQ, auth, rate-limit)
├── nginx/
│   ├── glpi.conf               ← proxy GLPI → Apache:8888
│   ├── evolution.conf          ← proxy Evolution API
│   ├── typebot-builder.conf    ← proxy Typebot Builder
│   └── typebot-viewer.conf     ← proxy Typebot Viewer
└── scripts/
    ├── backup.sh               ← backup com validação de corrupção (-F c)
    └── monitor.sh              ← monitoramento auto-recuperável
```

---

## 4. Passo a Passo de Instalação

### FASE 1 — Instalar Docker ✅ Sem impacto no GLPI

```bash
# Atualizar sistema
apt update && apt upgrade -y

# Instalar Docker
curl -fsSL https://get.docker.com -o get-docker.sh && sh get-docker.sh
systemctl enable docker && systemctl start docker

# Verificar instalação
docker --version
docker compose version
```

---

### FASE 2 — Enviar Arquivos e Gerar Senhas ✅ Sem impacto no GLPI

#### 2.1 — Copiar arquivos para a VPS

```bash
# No seu PC (PowerShell/Terminal)
scp -P 22009 -r .\docker-compose.yml .\glpi-proxy .\scripts .\nginx .\.env.example oud-1@103.204.193.6:/opt/stack/
```

#### 2.2 — Gerar as 6 senhas

```bash
# Na VPS
for i in $(seq 1 6); do echo "Senha $i: $(openssl rand -hex 32)"; done
```

Anotar e associar:
1. `POSTGRES_EVOLUTION_PASSWORD`
2. `POSTGRES_TYPEBOT_PASSWORD`
3. `AUTHENTICATION_API_KEY` (Evolution)
4. `NEXTAUTH_SECRET` (Typebot)
5. `ENCRYPTION_SECRET` (Typebot)
6. `PROXY_SECRET` (GLPI Proxy)

#### 2.3 — Criar o .env

```bash
cd /opt/stack
cp .env.example .env
nano .env
# Preencher TODAS as variáveis com os valores reais
# ATENÇÃO: a senha em DATABASE_URL deve ser IDÊNTICA a POSTGRES_EVOLUTION_PASSWORD

chmod 600 .env
chown root:root .env
```

---

### FASE 3 — Configurar Tokens no GLPI ✅ Sem impacto no GLPI

Acesse o painel web do GLPI no navegador:

#### 3.1 — Habilitar API REST
`Configurar → Geral → API`
- Ativar API REST: **Sim**
- Adicionar um cliente API:
  - Nome: `Bot WhatsApp`
  - Ativo: **Sim**
  - Copiar o **App-Token** gerado

#### 3.2 — Criar usuário dedicado para o bot
`Administração → Usuários → Adicionar`
- Login: `bot-whatsapp`
- Senha: (gerar uma segura)
- Perfil: **Self-Service** ou perfil customizado com **apenas**:
  - Criar ticket ✅
  - Ver seus próprios tickets ✅
  - Tudo mais ❌

#### 3.3 — Gerar User Token
No perfil do usuário `bot-whatsapp`:
`Configurações → Chaves de acesso remoto → Regenerar`
- Copiar o **User API Token**

#### 3.4 — Atualizar o .env na VPS
```bash
nano /opt/stack/.env
# Preencher:
# GLPI_APP_TOKEN=<token copiado em 3.1>
# GLPI_USER_TOKEN=<token copiado em 3.3>
```

---

### FASE 4 — Subir Containers ✅ Sem impacto no GLPI

```bash
cd /opt/stack
docker compose up -d

# Acompanhar logs (Ctrl+C para sair dos logs, containers continuam rodando)
docker compose logs -f --tail 20
```

#### Verificação

```bash
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

Resultado esperado — **todos "Up"**:

```
NAMES               STATUS              PORTS
evolution_api       Up (healthy)        127.0.0.1:8080->8080/tcp
evolution_postgres  Up (healthy)
evolution_redis     Up (healthy)
typebot_builder     Up (healthy)        127.0.0.1:3001->3000/tcp
typebot_viewer      Up (healthy)        127.0.0.1:3002->3000/tcp
typebot_postgres    Up (healthy)
glpi_proxy          Up (healthy)        127.0.0.1:3003->3003/tcp
```

**Se algum não subiu:**
```bash
docker logs NOME_DO_CONTAINER --tail 50
```

**Verificar que o GLPI continua funcionando:**
```bash
curl -s http://localhost/glpi/ | head -5
# Deve retornar HTML normalmente
```

---

### FASE 5 — Nginx + Mover Apache ⚠️ ~2 min downtime no GLPI

> **⚠️ FAÇA EM HORÁRIO DE BAIXA UTILIZAÇÃO**
> Este é o ÚNICO passo que causa interrupção no GLPI.

#### 5.1 — Backup do Apache (OBRIGATÓRIO)
```bash
cp -r /etc/apache2 /etc/apache2.backup
echo "Backup salvo em /etc/apache2.backup — $(date)"
```

#### 5.2 — Mover Apache para porta 8888
```bash
# Alterar porta de escuta
sed -i 's/Listen 80/Listen 127.0.0.1:8888/' /etc/apache2/ports.conf

# Alterar VirtualHosts
sed -i 's/:80>/:8888>/' /etc/apache2/sites-enabled/*.conf

# Reiniciar Apache (neste momento GLPI fica offline)
systemctl restart apache2

# Verificar Apache na nova porta
curl -s http://127.0.0.1:8888/glpi/ | head -3
# Se retornar HTML do GLPI → Apache OK na porta 8888
```

#### 5.3 — Instalar e configurar Nginx
```bash
apt install -y nginx

# Copiar configs
cp /opt/stack/nginx/glpi.conf /etc/nginx/sites-available/
cp /opt/stack/nginx/evolution.conf /etc/nginx/sites-available/
cp /opt/stack/nginx/typebot-builder.conf /etc/nginx/sites-available/
cp /opt/stack/nginx/typebot-viewer.conf /etc/nginx/sites-available/

# ─── IMPORTANTE: Trocar domínio placeholder ───
# Substitua SEUDOMINIO.com.br pelo seu domínio real nos 4 arquivos:
sed -i 's/SEUDOMINIO.com.br/seudominio.com/g' /etc/nginx/sites-available/glpi.conf
sed -i 's/SEUDOMINIO.com.br/seudominio.com/g' /etc/nginx/sites-available/evolution.conf
sed -i 's/SEUDOMINIO.com.br/seudominio.com/g' /etc/nginx/sites-available/typebot-builder.conf
sed -i 's/SEUDOMINIO.com.br/seudominio.com/g' /etc/nginx/sites-available/typebot-viewer.conf

# Ativar os sites
ln -sf /etc/nginx/sites-available/glpi.conf /etc/nginx/sites-enabled/
ln -sf /etc/nginx/sites-available/evolution.conf /etc/nginx/sites-enabled/
ln -sf /etc/nginx/sites-available/typebot-builder.conf /etc/nginx/sites-enabled/
ln -sf /etc/nginx/sites-available/typebot-viewer.conf /etc/nginx/sites-enabled/

# Remover default do Nginx
rm -f /etc/nginx/sites-enabled/default

# TESTAR antes de aplicar
nginx -t
# Se retornar "syntax is ok" e "test is successful" → prossiga

# Iniciar Nginx (GLPI volta ao ar neste momento)
systemctl start nginx
systemctl enable nginx
```

#### 5.4 — Verificar tudo
```bash
# GLPI acessível pela porta 80 (via Nginx → Apache:8888)?
curl -s http://localhost/glpi/ | head -5

# Evolution respondendo?
curl -s http://localhost:8080/ | head -3

# Typebot respondendo?
curl -s http://localhost:3001/ -o /dev/null -w "%{http_code}"
# Deve retornar 200 ou 302
```

#### 🔥 ROLLBACK — Se algo der errado
```bash
# Parar Nginx
systemctl stop nginx

# Restaurar Apache original
cp -r /etc/apache2.backup/* /etc/apache2/
systemctl restart apache2

# GLPI volta ao normal em < 30 segundos
# Investigate o problema, corrija, e tente a Fase 5 novamente
```

---

### FASE 6 — DNS ✅ Sem impacto no GLPI

No painel do provedor de DNS, criar registros tipo **A**:

| Subdomínio | Valor |
|---|---|
| `evolution.seudominio.com` | IP da VPS |
| `typebot.seudominio.com` | IP da VPS |
| `bot.seudominio.com` | IP da VPS |

Aguardar propagação (5-30 min). Verificar:
```bash
dig evolution.seudominio.com +short
# Deve retornar o IP da VPS
```

---

### FASE 7 — SSL (HTTPS) ✅ Sem impacto no GLPI

```bash
# Instalar certbot
apt install -y certbot python3-certbot-nginx

# Gerar certificados
certbot --nginx \
  -d evolution.seudominio.com \
  -d typebot.seudominio.com \
  -d bot.seudominio.com \
  --email admin@seudominio.com \
  --agree-tos --no-eff-email

# Opcional: SSL no GLPI também
certbot --nginx \
  -d glpi.seudominio.com \
  --email admin@seudominio.com \
  --agree-tos --no-eff-email

# Verificar renovação automática
certbot renew --dry-run

# Verificar certificados emitidos
certbot certificates
```

---

### FASE 8 — Conectar WhatsApp ✅ Sem impacto no GLPI

```bash
APIKEY="SUA_APIKEY_AQUI"   # mesma do .env (AUTHENTICATION_API_KEY)

# 8.1 — Criar instância Baileys
curl -X POST "http://localhost:8080/instance/create" \
  -H "Content-Type: application/json" \
  -H "apikey: $APIKEY" \
  -d '{"instanceName":"glpi-bot","qrcode":true,"integration":"WHATSAPP-BAILEYS"}'

# 8.2 — Obter QR Code
curl "http://localhost:8080/instance/connect/glpi-bot" \
  -H "apikey: $APIKEY"
# A resposta contém o QR em base64 — decodifique ou acesse pelo painel:
# https://evolution.seudominio.com (com auth básica)

# 8.3 — Escaneie o QR com o número DEDICADO do WhatsApp

# 8.4 — Verificar conexão
curl "http://localhost:8080/instance/connectionState/glpi-bot" \
  -H "apikey: $APIKEY"
# Resposta esperada: {"instance":"glpi-bot","state":"open"}
```

> **IMPORTANTE:** Use um chip/número separado, dedicado exclusivamente para o bot.

---

### FASE 9 — Proteger Evolution API ✅ Sem impacto no GLPI

```bash
# Criar usuário para autenticação básica no Nginx
apt install -y apache2-utils
htpasswd -c /etc/nginx/.htpasswd_evolution admin
# Defina uma senha forte quando solicitado

# Recarregar Nginx para aplicar
nginx -t && systemctl reload nginx
```

---

### FASE 10 — Criar Fluxo no Typebot ✅ Sem impacto no GLPI

1. Acesse `https://typebot.seudominio.com`
2. Faça login com o `ADMIN_EMAIL` definido no `.env`
3. Crie um novo bot (o fluxo detalhado será definido na próxima etapa deste documento)
4. **Publique** o fluxo
5. Anote o **ID público** do fluxo (visível na URL do editor)

---

### FASE 11 — Ligar Evolution → Typebot ✅ Sem impacto no GLPI

```bash
APIKEY="SUA_APIKEY_AQUI"

curl -X POST "http://localhost:8080/typebot/set/glpi-bot" \
  -H "Content-Type: application/json" \
  -H "apikey: $APIKEY" \
  -d '{
    "enabled": true,
    "url": "https://bot.seudominio.com",
    "typebot": "ID_PUBLICO_DO_SEU_TYPEBOT",
    "triggerType": "all",
    "expire": 30,
    "keywordFinish": "#sair",
    "delayMessage": 1500,
    "unknownMessage": "Desculpe, não entendi. Envie qualquer mensagem para recomeçar ou digite #sair para encerrar.",
    "listeningFromMe": false,
    "stopBotFromMe": false,
    "keepOpen": false,
    "debounceTime": 0
  }'
```

---

### FASE 12 — Backup e Monitoramento ✅ Sem impacto no GLPI

```bash
# Tornar scripts executáveis
chmod +x /opt/stack/scripts/backup.sh /opt/stack/scripts/monitor.sh

# Backup automático às 3h da manhã (bancos + sessão WhatsApp)
echo "0 3 * * * root /opt/stack/scripts/backup.sh >> /var/log/stack-backup.log 2>&1" > /etc/cron.d/stack-backup

# Monitoramento a cada 3 minutos (WhatsApp, disco, RAM)
echo "*/3 * * * * root /opt/stack/scripts/monitor.sh >> /var/log/stack-monitor.log 2>&1" > /etc/cron.d/stack-monitor

# Criar diretório de backup
mkdir -p /opt/backups

# Testar backup manualmente
/opt/stack/scripts/backup.sh
```

---

### FASE 13 — Firewall ✅ Sem impacto no GLPI

```bash
apt install -y ufw

# Permitir SSH (porta customizada)
ufw allow 22/tcp

# Permitir HTTP e HTTPS
ufw allow 80/tcp
ufw allow 443/tcp

# Ativar firewall
ufw --force enable

# Verificar regras
ufw status verbose
```

---

## 5. Teste Final de Ponta a Ponta

```bash
echo "═══ 1. GLPI acessível? ═══"
curl -s -o /dev/null -w "%{http_code}" http://localhost/glpi/
# Esperado: 200 ou 302

echo "═══ 2. Containers saudáveis? ═══"
docker ps --format "table {{.Names}}\t{{.Status}}" | grep -c "healthy"
# Esperado: 7

echo "═══ 3. GLPI Proxy conectado? ═══"
curl -s http://localhost:3003/health | python3 -c \
  "import sys,json; d=json.load(sys.stdin); print(f'Status: {d[\"status\"]} | Sessão ativa: {d[\"session\"][\"active\"]}')"

echo "═══ 4. WhatsApp conectado? ═══"
curl -s "http://localhost:8080/instance/connectionState/glpi-bot" \
  -H "apikey: SUA_APIKEY" | python3 -c \
  "import sys,json; d=json.load(sys.stdin); print(f'Estado: {d[\"state\"]}')"

echo "═══ 5. SSL válido? ═══"
curl -s -o /dev/null -w "%{http_code}" https://evolution.seudominio.com/
curl -s -o /dev/null -w "%{http_code}" https://typebot.seudominio.com/
curl -s -o /dev/null -w "%{http_code}" https://bot.seudominio.com/
```

**Teste manual:**
1. Envie "oi" para o número do bot no WhatsApp
2. Siga o fluxo até criar um chamado
3. Verifique no painel do GLPI se o ticket apareceu

---

## 6. Runbook — Resolução de Problemas

| Problema | Diagnóstico | Solução |
|---|---|---|
| GLPI fora do ar | `curl http://localhost:8888/glpi/` e `systemctl status apache2` | Se Apache morreu: `systemctl restart apache2`. Se Nginx morreu: `systemctl restart nginx`. Se ambos falharam: rollback |
| WhatsApp desconectou | `curl localhost:8080/instance/connectionState/glpi-bot -H "apikey: ..."` | Acessar `https://evolution.seudominio.com` → reconectar QR |
| Container não sobe | `docker logs CONTAINER --tail 50` | Verificar `.env`. Reiniciar: `docker compose restart SERVIÇO` |
| Tickets não criam | `curl localhost:3003/health` → ver `queue.pending` e `queue.dead_letters` | Se sessão inativa: verificar tokens GLPI. Se dead letters cresce: GLPI está bloqueando permanentemente a API. |
| Disco cheio | `df -h` e `docker system df` | `docker system prune -f` + `find /opt/backups -mtime +7 -delete` |
| RAM esgotada | `free -h` e `docker stats --no-stream` | Identificar container consumindo mais e reiniciar. Redis tem limite maxmemory configurado. |
| Proxy não responde (Rate Limit) | `HTTP 429 Too Many Requests` no Typebot | O Proxy está se protegendo contra DDoS. Aguarde 1 min. Pode ajustar em `server.js` se for IP interno. |
| Nginx deu erro 502 | `nginx -t` e `docker ps` | Container de destino caiu → reiniciar container |

### Rollback completo (voltar tudo ao estado original)

```bash
# Parar tudo
cd /opt/stack && docker compose down
systemctl stop nginx
systemctl disable nginx

# Restaurar Apache original
cp -r /etc/apache2.backup/* /etc/apache2/
systemctl restart apache2

# GLPI volta 100% ao que era antes
```

---

## 7. Manutenção Periódica

| Ação | Frequência | Comando |
|---|---|---|
| Verificar logs do monitor | Diário | `tail -20 /var/log/stack-monitor.log` |
| Verificar backups | Semanal | `ls -lh /opt/backups/` |
| Atualizar imagens Docker | Mensal | `cd /opt/stack && docker compose pull && docker compose up -d` |
| Renovar SSL | Automático | Certbot renova sozinho (verificar: `certbot renew --dry-run`) |
| Limpar logs Docker | Mensal | `docker system prune -f` |
| Verificar espaço em disco | Semanal | `df -h /` |

---

## 8. Checklist Final

- [ ] Docker instalado e funcionando
- [ ] `.env` preenchido com todas as senhas
- [ ] API REST do GLPI habilitada com App-Token
- [ ] Usuário `bot-whatsapp` no GLPI com permissão mínima
- [ ] 7 containers `Up (healthy)`
- [ ] Apache na porta 8888, Nginx na 80/443
- [ ] GLPI acessível normalmente pelo navegador
- [ ] DNS dos 3 subdomínios propagado
- [ ] SSL válido nos 3 subdomínios
- [ ] WhatsApp conectado (`state: open`)
- [ ] Auth básica configurada no Evolution
- [ ] Fluxo Typebot publicado
- [ ] Integração Evolution → Typebot ativada
- [ ] Mensagem no WhatsApp → fluxo → ticket no GLPI ✅
- [ ] Backup automático configurado (cron 3h)
- [ ] Monitoramento configurado (cron 3 min)
- [ ] Firewall UFW ativo (22, 80, 443)
- [ ] `.env` com `chmod 600`
