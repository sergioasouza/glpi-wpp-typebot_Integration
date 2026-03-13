# 📘 Passo a Passo: Ambiente Local (Docker) + GLPI Remoto

Este guia cobre toda a stack **rodando no seu computador local (Windows com Docker Desktop)**:
- **Evolution API** (WhatsApp via Baileys)
- **Typebot** (Builder + Viewer)
- **GLPI Proxy** (micro-serviço Node.js)
- **2x PostgreSQL** (Evolution + Typebot)
- **2x Redis** (Evolution cache + Proxy fila)
- **Mailpit** (servidor de email falso para login local)

Tudo se conecta ao **GLPI remoto da sua empresa** sem afetá-lo.

---

## 🚀 Passo 1: Preparar o Arquivo `.env`

O arquivo `.env` já existe na raiz do projeto com senhas e chaves pré-geradas.

**Verifique / edite estes campos obrigatórios:**

| Variável | O que colocar |
|---|---|
| `GLPI_API_URL` | URL da API REST do GLPI (ex: `https://helpdesk.suaempresa.com.br/apirest.php`) |
| `GLPI_APP_TOKEN` | Token de aplicação gerado no GLPI (Passo 2) |
| `GLPI_USER_TOKEN` | Token do usuário bot gerado no GLPI (Passo 2) |
| `ADMIN_EMAIL` | Seu e-mail pessoal (usado para login no Typebot) |
| `MANAGER_PHONES` | Telefone(s) do gestor para receber notificações (formato: `5565999999999`) |

Os demais valores (senhas, chaves, SMTP) já estão configurados e prontos para uso local.

---

## ⚙️ Passo 2: Configurar o GLPI da sua Empresa

Acesse o painel web do GLPI da sua empresa como Administrador.

### 1. Habilitar a API REST e Pegar o `App-Token`
1. Vá em **Configurar → Geral → API**.
2. Marque **Ativar API REST: Sim**.
3. Adicione um cliente API com o nome `Bot WhatsApp`.
4. Salve e copie o **App-Token** que foi gerado.
5. Cole no seu `.env` na linha: `GLPI_APP_TOKEN=...`

### 2. Criar um Usuário para o Bot
1. Vá em **Administração → Usuários → Adicionar**.
2. Crie um usuário chamado `bot-whatsapp` (use o perfil *Self-Service* ou um perfil que possa abrir e ler chamados).

### 3. Gerar o `User-Token`
1. Ainda no GLPI, acesse o perfil do novo usuário `bot-whatsapp`.
2. Vá na aba **Chaves de acesso remoto** e clique em **Regenerar**.
3. Copie o **User API Token**.
4. Cole no seu `.env` na linha: `GLPI_USER_TOKEN=...`

---

## 🐳 Passo 3: Iniciar os Containers (Docker)

Abra o terminal do VS Code (PowerShell) na pasta do projeto e rode:

```powershell
docker compose up -d
```

> ⚠️ *A primeira vez demora alguns minutos porque o Docker baixa todas as imagens.*

Para validar se tudo subiu corretamente:
```powershell
docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

Você verá **9 containers** rodando:

| Container | Porta Local | URL |
|---|---|---|
| `typebot_builder` | 3001 | http://localhost:3001 |
| `typebot_viewer` | 3002 | http://localhost:3002 |
| `evolution_api` | 8080 | http://localhost:8080 |
| `glpi_proxy` | 3003 | http://localhost:3003/health |
| `mailpit` | 8025 | http://localhost:8025 |
| `evolution_postgres` | — | (interno) |
| `typebot_postgres` | — | (interno) |
| `evolution_redis` | — | (interno) |
| `proxy_redis` | — | (interno) |

### Verificar saúde dos serviços
```powershell
# Verificar se o proxy está funcionando
Invoke-RestMethod -Uri "http://localhost:3003/health"

# Verificar se a Evolution API responde
Invoke-RestMethod -Uri "http://localhost:8080/" -Headers @{ "apikey"="oud_local_dev_api_key_987654321" }
```

---

## 💬 Passo 4: Configurar o Typebot

### 1. Fazer Login
1. Acesse **http://localhost:3001** no navegador.
2. Insira o email definido no `.env` (campo `ADMIN_EMAIL`).
3. Clique em **Enviar**.
4. Abra **http://localhost:8025** (Mailpit) em outra aba — aqui aparece o email com o link mágico.
5. Clique no link do email para fazer login no Typebot.

### 2. Importar o Fluxo
1. Dentro do painel do Typebot, clique em **Create a Bot** > **Import file**.
2. Selecione o arquivo **`typebot-fluxo-completo.json`** que está na raiz do projeto.
3. No painel do bot, revise o fluxo — ele já contém:
   - Triagem inicial (Cliente existente / Comercial)
   - Identificação por email via GLPI Proxy
   - Menu principal (6 opções)
   - Abertura de chamados (tipo, urgência, título, descrição, confirmação)
   - Consultar meus chamados / status de um chamado
   - Falar com atendente
   - Área comercial (Produtos, Orçamento, Reunião)
4. Clique em **Publish** (botão superior direito).
5. Copie o ID público do bot (está na URL: `http://localhost:3001/typebots/ID_DO_SEU_BOT/edit`). Guarde para o próximo passo.

### 3. Configurar as Variáveis do Fluxo
No editor do Typebot, acesse o grupo **"Variáveis Globais"** (primeiro grupo após o Start) e confira:
- `proxy_secret` → Deve ser o mesmo valor de `PROXY_SECRET` do `.env` (padrão: `proxy_secret_local_999`)
- `proxy_url` → Deve ser `http://glpi-proxy:3003` (URL interna entre containers)

> ⚠️ **IMPORTANTE:** A URL do proxy usa o nome do serviço Docker (`glpi-proxy`), **NÃO** `localhost`, pois o Typebot Viewer chama o proxy de dentro da rede Docker.

---

## 📱 Passo 5: Configurar Evolution API (WhatsApp)

Vamos conectar seu celular de testes e vincular a Evolution ao Typebot.

Abra o terminal PowerShell no VS Code e execute:

### 1. Criar a Instância do WhatsApp
```powershell
$apiKey = "oud_local_dev_api_key_987654321"

Invoke-RestMethod -Uri "http://localhost:8080/instance/create" -Method Post -Headers @{ "apikey"=$apiKey; "Content-Type"="application/json" } -Body '{"instanceName":"glpi-bot","integration":"WHATSAPP-BAILEYS"}'
```

### 2. Gerar QR Code para Ler com o Celular
```powershell
Invoke-RestMethod -Uri "http://localhost:8080/instance/connect/glpi-bot" -Method Get -Headers @{ "apikey"=$apiKey }
```
A resposta traz um campo `base64` com o QR Code. Copie a string e cole em [https://base64.guru/converter/decode/image](https://base64.guru/converter/decode/image) para visualizar. Leia com o WhatsApp do celular de testes (**Menu > Dispositivos Conectados > Conectar um dispositivo**).

### 3. Vincular a Evolution com o Typebot
> **Atenção:** Troque `COLOQUE_AQUI_O_ID_DO_BOT` pelo ID que você copiou no **Passo 4**.

```powershell
$botID = "COLOQUE_AQUI_O_ID_DO_BOT"

$body = @"
{
  "enabled": true,
  "url": "http://typebot-viewer:3000",
  "typebot": "$botID",
  "expire": 30,
  "keywordFinish": "#SAIR",
  "delayMessage": 1500,
  "unknownMessage": "Desculpe, não entendi. O que você quis dizer?",
  "listeningFromMe": false,
  "stopBotFromMe": true,
  "keepOpen": false,
  "debounceTime": 10
}
"@

Invoke-RestMethod -Uri "http://localhost:8080/typebot/set/glpi-bot" -Method Post -Headers @{ "apikey"=$apiKey; "Content-Type"="application/json" } -Body $body
```

---

## ✅ Passo 6: Testar Tudo

1. Pegue **outro celular** (ou outra conta WhatsApp) e mande **"Oi"** para o número que você conectou via QR Code.
2. O bot deve responder com a triagem: "Já sou cliente" ou "Comercial".
3. Teste o fluxo completo:
   - Digite **1** → Informe um email cadastrado no GLPI → Menu principal
   - Opção **1** → Abrir chamado (tipo, urgência, título, descrição) → Verificar no GLPI
   - Opção **2** → Ver seus chamados
   - Opção **3** → Consultar status de um chamado pelo número
   - Opção **5** → Área comercial (produtos, orçamento, reunião)
   - Opção **6** → Encerrar conversa

### Se algo falhar — Debug

```powershell
# Logs do proxy (erros de GLPI, sessão, tokens)
docker compose logs -f glpi-proxy

# Logs do Typebot Viewer (erros de fluxo, webhooks)
docker compose logs -f typebot-viewer

# Logs da Evolution API (conexão WhatsApp, integração Typebot)
docker compose logs -f evolution-api

# Verificar saúde de todos os containers
docker ps --format "table {{.Names}}\t{{.Status}}"
```

**Problemas comuns:**
- **Token inválido** → Revise `GLPI_APP_TOKEN` e `GLPI_USER_TOKEN` no `.env`
- **Firewall bloqueando** → O GLPI da empresa precisa aceitar conexões da sua rede
- **Proxy unhealthy** → Verifique `docker compose logs glpi-proxy` — geralmente é Redis não conectado
- **Bot não responde** → Confirme que o QR Code foi lido e que o `$botID` está correto no Passo 5.3
