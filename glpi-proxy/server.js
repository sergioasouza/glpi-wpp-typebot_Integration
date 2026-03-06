/**
 * GLPI Proxy — Micro-serviço de sessão persistente
 *
 * Mantém UMA sessão GLPI ativa e renova automaticamente.
 * Inclui: retry automático com Redis, Dead Letter Queue (DLQ),
 * autenticação por header, auditoria e hardening (Helmet/Rate-limit).
 *
 * Endpoints:
 *   POST /ticket          → Criar chamado no GLPI
 *   GET  /ticket/:id      → Consultar status de um chamado
 *   POST /user/search     → Buscar usuário por CPF/matrícula
 *   POST /user/create     → Cadastrar novo usuário
 *   GET  /user/:id/tickets → Listar tickets de um usuário
 *   GET  /health          → Health check com status da sessão
 */

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Redis = require('ioredis');

const app = express();

// ── Configuração ────────────────────────────────────────────────
const GLPI_URL = process.env.GLPI_URL || 'http://host.docker.internal/glpi/apirest.php';
const APP_TOKEN = process.env.GLPI_APP_TOKEN;
const USER_TOKEN = process.env.GLPI_USER_TOKEN;
const PROXY_SECRET = process.env.PROXY_SECRET;
const REDIS_URL = process.env.REDIS_URL || 'redis://evolution-redis:6379/6';

const RENEW_MS = 25 * 60 * 1000; // renovar sessão a cada 25 min (GLPI expira em 30)
const MAX_RETRIES = 5;
const RETRY_INTERVAL_MS = 60_000; // processar fila a cada 1 min
const PORT = 3003;

// ── Conexão Redis ───────────────────────────────────────────────
const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
  retryStrategy(times) {
    return Math.min(times * 50, 2000);
  }
});
redis.on('error', (err) => console.error(`[${ts()}] ❌ Erro no Redis: ${err.message}`));
redis.on('connect', () => console.log(`[${ts()}] 🔗 Conectado ao Redis para persistência de fila`));

// ── Estado ──────────────────────────────────────────────────────
let sessionToken = null;
let sessionExpiry = 0;
let stats = {
  ticketsCreated: 0,
  ticketsFailed: 0,
  ticketsQueued: 0,
  ticketsRetried: 0,
  usersSearched: 0,
  usersCreated: 0,
  sessionRenewals: 0,
  startedAt: new Date().toISOString(),
};

// Mapeamento de status do GLPI para nomes legíveis
const STATUS_MAP = {
  1: { name: 'Novo', emoji: '🆕' },
  2: { name: 'Em atendimento (atribuído)', emoji: '🔄' },
  3: { name: 'Em atendimento (planejado)', emoji: '📅' },
  4: { name: 'Pendente', emoji: '⏸️' },
  5: { name: 'Solucionado', emoji: '✅' },
  6: { name: 'Fechado', emoji: '🔒' },
};

const URGENCY_MAP = {
  1: 'Muito Alta', 2: 'Alta', 3: 'Média', 4: 'Baixa', 5: 'Muito Baixa',
};

// ── Hardening & Middlewares ─────────────────────────────────────
app.use(helmet()); // Proteção contra vulnerabilidades web conhecidas
app.use(express.json({ limit: '2mb' })); // Limite de payload mitigando ataques de buffer

// Rate limiter para evitar DDoS no proxy
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minuto
  max: 120, // Limite de 120 requests por IP
  message: { success: false, error: 'Muitas requisições. Tente novamente mais tarde.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// Autenticação do proxy
app.use((req, res, next) => {
  if (req.path === '/health') return next();

  const key = req.headers['x-proxy-key'];
  if (!PROXY_SECRET || key !== PROXY_SECRET) {
    console.warn(`[${ts()}] ❌ Acesso negado — IP: ${req.ip}, Path: ${req.path}`);
    return res.status(403).json({ error: 'Forbidden — x-proxy-key inválido' });
  }
  next();
});

// ── Funções de sessão GLPI ──────────────────────────────────────
function ts() { return new Date().toISOString(); }

async function initSession() {
  try {
    const res = await fetch(`${GLPI_URL}/initSession`, {
      headers: {
        'App-Token': APP_TOKEN,
        'Authorization': `user_token ${USER_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`initSession HTTP ${res.status}: ${text}`);
    }

    const data = await res.json();
    sessionToken = data.session_token;
    sessionExpiry = Date.now() + RENEW_MS;
    stats.sessionRenewals++;
    console.log(`[${ts()}] ✅ Sessão GLPI renovada (renovação #${stats.sessionRenewals})`);
    return sessionToken;
  } catch (err) {
    console.error(`[${ts()}] ❌ Falha ao renovar sessão: ${err.message}`);
    sessionToken = null;
    throw err;
  }
}

async function getSession() {
  if (!sessionToken || Date.now() > sessionExpiry) {
    return await initSession();
  }
  return sessionToken;
}

async function glpiFetch(path, options = {}) {
  let token = await getSession();

  const headers = {
    'App-Token': APP_TOKEN,
    'Session-Token': token,
    'Content-Type': 'application/json',
    ...options.headers,
  };

  let res = await fetch(`${GLPI_URL}${path}`, { ...options, headers });

  // Se 401, renovar sessão e tentar uma vez mais
  if (res.status === 401) {
    console.warn(`[${ts()}] ⚠️ Sessão expirada, renovando...`);
    sessionToken = null;
    token = await getSession();
    headers['Session-Token'] = token;
    res = await fetch(`${GLPI_URL}${path}`, { ...options, headers });
  }

  return res;
}

// ══════════════════════════════════════════════════════════════════
//  ENDPOINTS DE USUÁRIO
// ══════════════════════════════════════════════════════════════════

app.post('/user/search', async (req, res) => {
  const { identificador } = req.body;
  if (!identificador) {
    return res.status(400).json({ found: false, error: 'Campo "identificador" é obrigatório' });
  }

  const cleaned = identificador.replace(/[\s.\-\/]/g, '');
  stats.usersSearched++;

  try {
    const searchRes = await glpiFetch(
      `/search/User?criteria[0][field]=6&criteria[0][searchtype]=contains&criteria[0][value]=${encodeURIComponent(cleaned)}&forcedisplay[0]=1&forcedisplay[1]=2&forcedisplay[2]=5&forcedisplay[3]=6&forcedisplay[4]=11&range=0-0`
    );

    if (!searchRes.ok) {
      const phoneRes = await glpiFetch(
        `/search/User?criteria[0][field]=11&criteria[0][searchtype]=contains&criteria[0][value]=${encodeURIComponent(cleaned)}&forcedisplay[0]=1&forcedisplay[1]=2&forcedisplay[2]=5&forcedisplay[3]=6&forcedisplay[4]=11&range=0-0`
      );

      if (!phoneRes.ok) return res.json({ found: false });

      const phoneData = await phoneRes.json();
      if (!phoneData.data || phoneData.data.length === 0) return res.json({ found: false });

      const user = phoneData.data[0];
      return res.json({
        found: true, user_id: user[1], user_name: user[2] || '', user_email: user[5] || '', registration_number: user[6] || '', phone: user[11] || '',
      });
    }

    const data = await searchRes.json();
    if (!data.data || data.data.length === 0) {
      const phoneRes = await glpiFetch(
        `/search/User?criteria[0][field]=11&criteria[0][searchtype]=contains&criteria[0][value]=${encodeURIComponent(cleaned)}&forcedisplay[0]=1&forcedisplay[1]=2&forcedisplay[2]=5&forcedisplay[3]=6&forcedisplay[4]=11&range=0-0`
      );
      if (phoneRes.ok) {
        const phoneData = await phoneRes.json();
        if (phoneData.data && phoneData.data.length > 0) {
          const user = phoneData.data[0];
          return res.json({
            found: true, user_id: user[1], user_name: user[2] || '', user_email: user[5] || '', registration_number: user[6] || '', phone: user[11] || '',
          });
        }
      }
      return res.json({ found: false });
    }

    const user = data.data[0];
    res.json({
      found: true, user_id: user[1], user_name: user[2] || '', user_email: user[5] || '', registration_number: user[6] || '', phone: user[11] || '',
    });
  } catch (err) {
    res.status(500).json({ found: false, error: err.message });
  }
});

app.post('/user/create', async (req, res) => {
  const { nome, email, telefone = '', setor = '', identificador = '' } = req.body;
  if (!nome) return res.status(400).json({ success: false, error: 'Campo "nome" é obrigatório' });

  try {
    const parts = nome.trim().toLowerCase().split(/\s+/);
    const login = parts.length > 1 ? `${parts[0]}.${parts[parts.length - 1]}` : parts[0];

    const userData = {
      input: {
        name: login,
        realname: parts.length > 1 ? parts.slice(1).join(' ') : '',
        firstname: parts[0],
        phone: telefone,
        registration_number: identificador,
        _useremails: email ? [email] : [],
        comment: `Cadastrado via WhatsApp Bot em ${new Date().toLocaleDateString('pt-BR')}`,
      },
    };

    const userRes = await glpiFetch('/User', { method: 'POST', body: JSON.stringify(userData) });
    if (!userRes.ok) throw new Error(`GLPI HTTP ${userRes.status}`);

    const result = await userRes.json();
    stats.usersCreated++;
    console.log(`[${ts()}] 👤 Usuário criado: ID ${result.id} — "${nome}"`);

    res.json({ success: true, user_id: result.id, login: login, message: `Usuário criado com sucesso (ID: ${result.id})` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/user/:id/tickets', async (req, res) => {
  try {
    const searchRes = await glpiFetch(
      `/search/Ticket?criteria[0][field]=4&criteria[0][searchtype]=equals&criteria[0][value]=${req.params.id}&criteria[1][link]=AND&criteria[1][field]=12&criteria[1][searchtype]=notequals&criteria[1][value]=6&forcedisplay[0]=1&forcedisplay[1]=2&forcedisplay[2]=12&forcedisplay[3]=15&forcedisplay[4]=10&sort=15&order=DESC&range=0-4`
    );

    if (!searchRes.ok) throw new Error(`GLPI HTTP ${searchRes.status}`);

    const data = await searchRes.json();
    if (!data.data || data.data.length === 0) return res.json({ success: true, tickets: [], total: 0 });

    const tickets = data.data.map(t => ({
      id: t[1], name: t[2] || 'Sem título', status: t[12],
      status_name: STATUS_MAP[t[12]]?.name || 'Desconhecido', status_emoji: STATUS_MAP[t[12]]?.emoji || '❓',
      date: t[15], urgency: t[10], urgency_name: URGENCY_MAP[t[10]] || 'Desconhecida',
    }));

    res.json({ success: true, tickets, total: data.totalcount || tickets.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  ENDPOINTS DE TICKETS & QUEUE (REDIS)
// ══════════════════════════════════════════════════════════════════

app.post('/ticket', async (req, res) => {
  const {
    nome, descricao, tipo = 1, urgencia = 3, categoria_id = 0, user_id = 0, telefone = '',
  } = req.body;

  if (!nome || !descricao) return res.status(400).json({ success: false, error: 'Campos "nome" e "descricao" são obrigatórios' });

  const ticketInput = {
    name: nome,
    content: `${descricao}\n\n---\n📱 Aberto via WhatsApp Bot${telefone ? ` | Tel: ${telefone}` : ''}`,
    type: tipo, urgency: urgencia, itilcategories_id: categoria_id,
  };
  if (user_id > 0) ticketInput._users_id_requester = user_id;

  const ticketData = { input: ticketInput };

  try {
    const ticketRes = await glpiFetch('/Ticket', { method: 'POST', body: JSON.stringify(ticketData) });
    if (!ticketRes.ok) throw new Error(`GLPI HTTP ${ticketRes.status}`);

    const ticket = await ticketRes.json();
    stats.ticketsCreated++;
    console.log(`[${ts()}] 🎫 Ticket #${ticket.id} criado — "${nome}"`);
    res.json({ success: true, ticket_id: ticket.id, message: `Chamado #${ticket.id} criado com sucesso` });
  } catch (err) {
    stats.ticketsFailed++;
    console.error(`[${ts()}] ❌ Erro ao criar ticket: ${err.message}`);

    // Persistir ticket pendente no Redis
    const pendingTicket = {
      data: req.body,
      timestamp: Date.now(),
      retries: 0,
      error: err.message,
    };

    await redis.lpush('glpi:pending_tickets', JSON.stringify(pendingTicket));
    stats.ticketsQueued++;
    const queueLength = await redis.llen('glpi:pending_tickets');

    console.log(`[${ts()}] 📋 Ticket enfileirado no Redis para retry (pendentes: ${queueLength})`);

    res.status(202).json({
      success: false, queued: true, queue_position: queueLength,
      message: 'GLPI indisponível — chamado será criado automaticamente quando voltar',
    });
  }
});

app.get('/ticket/:id', async (req, res) => {
  try {
    const ticketRes = await glpiFetch(`/Ticket/${req.params.id}`);
    if (!ticketRes.ok) return res.status(ticketRes.status).json({ success: false, error: `Ticket HTTP ${ticketRes.status}` });

    const ticket = await ticketRes.json();
    const statusInfo = STATUS_MAP[ticket.status] || { name: 'Desconhecido', emoji: '❓' };
    res.json({
      success: true,
      ticket: {
        id: ticket.id, name: ticket.name, status: ticket.status, status_name: statusInfo.name, status_emoji: statusInfo.emoji,
        date: ticket.date, urgency: ticket.urgency, urgency_name: URGENCY_MAP[ticket.urgency] || 'Desconhecida',
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════════
//  SISTEMA E PROCESSAMENTO EM BACKGROUND
// ══════════════════════════════════════════════════════════════════

app.get('/health', async (req, res) => {
  const sessionOk = !!sessionToken && Date.now() < sessionExpiry;
  const pendingCount = await redis.llen('glpi:pending_tickets').catch(() => 0);
  const dlqCount = await redis.llen('glpi:dlq_tickets').catch(() => 0);

  res.json({
    status: sessionOk ? 'ok' : 'degraded',
    session: {
      active: !!sessionToken,
      expires_in_seconds: sessionToken ? Math.max(0, Math.round((sessionExpiry - Date.now()) / 1000)) : 0,
    },
    queue: {
      pending: pendingCount,
      dead_letters: dlqCount,
    },
    stats,
    uptime_seconds: Math.round(process.uptime()),
  });
});

async function processQueue() {
  let pendingCount = await redis.llen('glpi:pending_tickets').catch(() => 0);
  if (pendingCount === 0) return;

  console.log(`[${ts()}] 🔄 Processando fila Redis — ${pendingCount} pendente(s)`);

  // Extrair um ticket (FIFO: como usamos lpush, usamos rpop)
  const item = await redis.rpop('glpi:pending_tickets');
  if (!item) return;

  let ticket;
  try { ticket = JSON.parse(item); } catch (e) { return console.error('Falha ao parsear item do Redis', e); }

  if (ticket.retries >= MAX_RETRIES) {
    console.error(`[${ts()}] ⛔ Ticket enviado para DLQ após ${MAX_RETRIES} tentativas: "${ticket.data.nome}"`);
    await redis.lpush('glpi:dlq_tickets', JSON.stringify(ticket));
    return;
  }

  try {
    const ticketData = {
      input: {
        name: ticket.data.nome,
        content: `${ticket.data.descricao}\n\n---\n📱 Aberto via WhatsApp Bot (retry #${ticket.retries + 1})${ticket.data.telefone ? ` | Tel: ${ticket.data.telefone}` : ''}`,
        type: ticket.data.tipo || 1, urgency: ticket.data.urgencia || 3, itilcategories_id: ticket.data.categoria_id || 0,
      },
    };
    if (ticket.data.user_id > 0) ticketData.input._users_id_requester = ticket.data.user_id;

    const ticketRes = await glpiFetch('/Ticket', { method: 'POST', body: JSON.stringify(ticketData) });
    if (!ticketRes.ok) throw new Error(`HTTP ${ticketRes.status}`);

    const result = await ticketRes.json();
    stats.ticketsRetried++;
    stats.ticketsCreated++;
    console.log(`[${ts()}] ✅ Ticket pendente criado: #${result.id} — "${ticket.data.nome}"`);
  } catch (err) {
    ticket.retries++;
    ticket.lastError = err.message;
    console.warn(`[${ts()}] ⚠️ Retry ${ticket.retries}/${MAX_RETRIES} falhou: ${err.message}`);
    // Coloca de volta na fila
    await redis.rpush('glpi:pending_tickets', JSON.stringify(ticket));
  }
}

async function startup() {
  console.log(`[${ts()}] 🚀 GLPI Proxy iniciando...`);
  console.log(`[${ts()}]    Auth: ${PROXY_SECRET ? 'ATIVADA' : '⚠️ DESATIVADA'}`);

  try { await initSession(); } catch (err) { console.error(`[${ts()}] ⚠️ Falha ao iniciar sessão GLPI`); }

  setInterval(async () => {
    try { await initSession(); } catch (e) { /* log no init */ }
  }, RENEW_MS);

  setInterval(processQueue, RETRY_INTERVAL_MS);

  app.listen(PORT, '0.0.0.0', () => console.log(`[${ts()}] ✅ Proxy rodando na porta ${PORT}`));
}

startup();
