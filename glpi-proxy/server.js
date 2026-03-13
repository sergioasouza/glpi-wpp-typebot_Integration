/**
 * GLPI Proxy — Micro-serviço de sessão persistente
 *
 * Mantém UMA sessão GLPI ativa e renova automaticamente.
 * Inclui: retry automático com Redis, Dead Letter Queue (DLQ),
 * autenticação por header, auditoria e hardening (Helmet/Rate-limit).
 *
 * Endpoints:
 *   POST /ticket            → Criar chamado no GLPI
 *   GET  /ticket/:id        → Consultar status de um chamado
 *   POST /user/search       → Buscar usuário por email
 *   GET  /user/:id/tickets  → Listar tickets de um usuário
 *   POST /comercial/lead    → Salvar lead comercial + notificar gestores
 *   GET  /health            → Health check com status da sessão
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
const REDIS_URL = process.env.REDIS_URL || 'redis://proxy-redis:6379';

// Evolution API — Notificações para gestores via WhatsApp
const EVOLUTION_URL = process.env.EVOLUTION_API_URL; // ex: http://evolution-api:8080
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY;
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || 'glpi-bot';
const MANAGER_PHONES = process.env.MANAGER_PHONES; // ex: "5511999999999,5511888888888"

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
  leadsCreated: 0,
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

// Busca usuário no GLPI por email (campo 5 na Search API do GLPI)
// Fallback: busca por telefone (campo 11)
app.post('/user/search', async (req, res) => {
  const { email, telefone } = req.body;
  if (!email) {
    return res.status(400).json({ found: false, error: 'Campo "email" é obrigatório' });
  }

  const cleaned = email.trim().toLowerCase();
  const isEmailInput = cleaned.includes('@');
  const normalizePhone = (value) => String(value || '').replace(/\D/g, '');
  const providedPhone = normalizePhone(telefone);
  stats.usersSearched++;

  const pickField = (row, fieldId, fallbackKeys = []) => {
    const candidates = [
      row?.[fieldId],
      row?.[String(fieldId)],
      ...fallbackKeys.map((key) => row?.[key]),
    ];

    for (const value of candidates) {
      if (value !== undefined && value !== null && String(value).trim() !== '') {
        return String(value).trim();
      }
    }

    return '';
  };

  const mapUserFromSearchRow = (row) => {
    const userId = pickField(row, 2, ['id']);
    const loginName = pickField(row, 1, ['name']);
    const firstName = pickField(row, 9, ['firstname']);
    const lastName = pickField(row, 34, ['realname']);
    const userEmail = pickField(row, 5, ['email']);
    const mobile = pickField(row, 11, ['mobile']);
    const phone = pickField(row, 6, ['phone']);
    const phone2 = pickField(row, 10, ['phone2']);
    const mergedPhone = mobile || phone || phone2;

    const fullName = `${firstName} ${lastName}`.trim();
    const userName = fullName || loginName;

    return {
      found: true,
      user_id: userId,
      user_name: userName,
      user_email: userEmail,
      phone: mergedPhone,
    };
  };

  const isPhoneMatch = (glpiPhoneRaw, candidatePhoneRaw) => {
    const glpiPhone = normalizePhone(glpiPhoneRaw);
    const candidatePhone = normalizePhone(candidatePhoneRaw);

    if (!glpiPhone || !candidatePhone) return false;
    if (glpiPhone === candidatePhone) return true;

    return (
      (glpiPhone.length >= 8 && candidatePhone.endsWith(glpiPhone)) ||
      (candidatePhone.length >= 8 && glpiPhone.endsWith(candidatePhone))
    );
  };

  try {
    // 1) Busca por login exato (field=1). Em muitos cenários o login é o próprio e-mail.
    // forcedisplay: 1=login, 2=id, 5=email, 9=firstname, 34=realname, 11=phone
    const loginSearchRes = await glpiFetch(
      `/search/User?criteria[0][field]=1&criteria[0][searchtype]=equals&criteria[0][value]=${encodeURIComponent(cleaned)}&forcedisplay[0]=1&forcedisplay[1]=2&forcedisplay[2]=5&forcedisplay[3]=9&forcedisplay[4]=34&forcedisplay[5]=6&forcedisplay[6]=10&forcedisplay[7]=11&range=0-10`
    );

    if (loginSearchRes.ok) {
      const loginData = await loginSearchRes.json();
      if (loginData.data && loginData.data.length > 0) {
        const exactLogin = loginData.data.find((row) => pickField(row, 1).toLowerCase() === cleaned);
        if (exactLogin) {
          const mapped = mapUserFromSearchRow(exactLogin);

          if (providedPhone && !isPhoneMatch(mapped.phone, providedPhone)) {
            return res.json({ found: false, two_factor: true, reason: 'phone_mismatch' });
          }

          return res.json(mapped);
        }
      }
    }

    // 2) Busca por e-mail (field=5 = UserEmail no GLPI).
    // Neste GLPI, field=5 aceita contains/notcontains (não equals), então filtramos no código.
    const emailSearchRes = await glpiFetch(
      `/search/User?criteria[0][field]=5&criteria[0][searchtype]=contains&criteria[0][value]=${encodeURIComponent(cleaned)}&forcedisplay[0]=1&forcedisplay[1]=2&forcedisplay[2]=5&forcedisplay[3]=9&forcedisplay[4]=34&forcedisplay[5]=6&forcedisplay[6]=10&forcedisplay[7]=11&range=0-50`
    );

    if (emailSearchRes.ok) {
      const emailData = await emailSearchRes.json();
      if (emailData.data && emailData.data.length > 0) {
        const exactEmail = emailData.data.find((row) => {
          const login = pickField(row, 1).toLowerCase();
          const mail = pickField(row, 5).toLowerCase();
          return login === cleaned || mail === cleaned;
        });

        if (exactEmail) {
          const mapped = mapUserFromSearchRow(exactEmail);

          if (providedPhone && !isPhoneMatch(mapped.phone, providedPhone)) {
            return res.json({ found: false, two_factor: true, reason: 'phone_mismatch' });
          }

          return res.json(mapped);
        }
      }
    }

    if (isEmailInput) {
      return res.json({ found: false });
    }

    // Fallback: busca por telefone (field=11)
    const phoneRes = await glpiFetch(
      `/search/User?criteria[0][field]=11&criteria[0][searchtype]=contains&criteria[0][value]=${encodeURIComponent(cleaned)}&forcedisplay[0]=1&forcedisplay[1]=2&forcedisplay[2]=5&forcedisplay[3]=9&forcedisplay[4]=34&forcedisplay[5]=11&range=0-0`
    );

    if (phoneRes.ok) {
      const phoneData = await phoneRes.json();
      if (phoneData.data && phoneData.data.length > 0) {
        return res.json(mapUserFromSearchRow(phoneData.data[0]));
      }
    }

    return res.json({ found: false });
  } catch (err) {
    res.status(500).json({ found: false, error: err.message });
  }
});

// Nota: Endpoint /user/create removido — não é permitido criar
// usuários via WhatsApp. Usuários devem ser cadastrados pelo
// gestor do projeto diretamente no GLPI.

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
//  ENDPOINT COMERCIAL — Leads (orçamento / reunião)
// ══════════════════════════════════════════════════════════════════

/**
 * Salva lead comercial no Redis e notifica gestores via Evolution API (WhatsApp).
 * Tipos: "orcamento" ou "reuniao"
 */
app.post('/comercial/lead', async (req, res) => {
  const {
    tipo, nome, empresa, email, telefone,
    detalhes, data_preferencial, horario_preferencial,
  } = req.body;

  if (!tipo || !nome) {
    return res.status(400).json({ success: false, error: 'Campos "tipo" e "nome" são obrigatórios' });
  }

  const lead = {
    tipo, // 'orcamento' | 'reuniao'
    nome,
    empresa: empresa || '',
    email: email || '',
    telefone: telefone || '',
    detalhes: detalhes || '',
    data_preferencial: data_preferencial || '',
    horario_preferencial: horario_preferencial || '',
    created_at: new Date().toISOString(),
  };

  try {
    // Persistir no Redis
    await redis.lpush('comercial:leads', JSON.stringify(lead));
    stats.leadsCreated = (stats.leadsCreated || 0) + 1;

    console.log(`[${ts()}] 📊 Lead comercial salvo: ${tipo} — "${nome}" (${empresa})`);

    // Notificar gestores via Evolution API (WhatsApp)
    if (EVOLUTION_URL && EVOLUTION_KEY && MANAGER_PHONES) {
      const phones = MANAGER_PHONES.split(',').map(p => p.trim()).filter(Boolean);

      const tipoLabel = tipo === 'orcamento' ? 'Solicitação de Orçamento' : 'Agendamento de Reunião';
      const msgLines = [
        `🔔 *Novo Lead Comercial — ${tipoLabel}*`,
        ``,
        `👤 Nome: ${lead.nome}`,
        `🏢 Empresa: ${lead.empresa || '(não informado)'}`,
        `📧 Email: ${lead.email || '(não informado)'}`,
        `📱 Telefone: ${lead.telefone || '(não informado)'}`,
      ];
      if (lead.detalhes) msgLines.push(`📝 Detalhes: ${lead.detalhes}`);
      if (lead.data_preferencial) msgLines.push(`📅 Data preferencial: ${lead.data_preferencial}`);
      if (lead.horario_preferencial) msgLines.push(`🕐 Horário: ${lead.horario_preferencial}`);
      msgLines.push(``, `⏰ Recebido em: ${lead.created_at}`);

      const textMessage = msgLines.join('\n');

      for (const phone of phones) {
        try {
          await fetch(`${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'apikey': EVOLUTION_KEY },
            body: JSON.stringify({ number: phone, text: textMessage }),
          });
          console.log(`[${ts()}] 📩 Notificação enviada para gestor: ${phone}`);
        } catch (e) {
          console.error(`[${ts()}] ⚠️ Falha ao notificar ${phone}: ${e.message}`);
        }
      }
    } else {
      console.warn(`[${ts()}] ⚠️ Evolution API não configurada — notificação de lead não enviada`);
    }

    res.json({ success: true, message: 'Lead registrado e gestores notificados' });
  } catch (err) {
    console.error(`[${ts()}] ❌ Erro ao salvar lead: ${err.message}`);
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
  const leadsCount = await redis.llen('comercial:leads').catch(() => 0);

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
    comercial: {
      total_leads: leadsCount,
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
