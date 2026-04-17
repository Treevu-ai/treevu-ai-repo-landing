/**
 * api/lead.js — CRM unificado de Treevu
 * Recibe leads de todos los canales y los escribe en Notion.
 *
 * Canales que llaman este endpoint:
 *  - api/submit.js   → formulario web gettreevu.com
 *  - api/chat.js     → chat Vü en la web
 *  - api/telegram.js → bot público @treevubot
 *
 * Protegido por x-webhook-secret (LEAD_WEBHOOK_SECRET)
 */

import { NOTION, PROGRAMA, SCORE_EMOJI, calcScore, CONFIG } from './lib/constants.js';
import { calcRenuncias } from './lib/sector-intel.js';
import { notionCreate, notionQuery }                from './lib/notion.js';
import { sendMessage, escapeMd }                    from './lib/telegram.js';
import { supabaseUpsert }                           from './lib/supabase.js';
import { captureException }                         from './lib/sentry.js';
import { redisCmd }                                 from './lib/redis.js';
import { getGmailToken, gmailSend }                 from './lib/gmail.js';
import { sendWhatsApp, normalizePhone }             from './lib/whatsapp.js';

const WEBHOOK_SECRET   = CONFIG.LEAD_WEBHOOK_SECRET;
const TELEGRAM_TOKEN   = CONFIG.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = CONFIG.TELEGRAM_ABM_CHAT_ID;

// ── Nurturing MEDIO ───────────────────────────────────────────────────────────
function buildNurturingD0(name, email, company, sector, employees, objetivo) {
  const firstName  = (name || 'equipo').split(/[\s,\-]+/)[0];
  const { costoStr: costo } = calcRenuncias(sector, employees);
  const diasCierre = Math.ceil((new Date(PROGRAMA.FECHA_CIERRE) - new Date()) / 864e5);

  return {
    to: email,
    subject: `${company || 'Tu empresa'} + Treevü — cuánto cuesta tu rotación`,
    bodyHtml: `
<p>Hola ${firstName},</p>
<p>Gracias por tu interés en Treevü. Estimamos que el costo anual de rotación en
<strong>${company || 'tu empresa'}</strong> podría superar <strong>S/ ${costo}</strong>
— solo en costos directos de reemplazo.</p>
<p>Treevü lo reduce hasta un 30% a través del acceso al salario devengado:
sin costo para el colaborador, sin riesgo financiero para la empresa,
setup en 2 semanas.</p>
<p>¿Tienes 15 minutos esta semana para conversarlo?</p>
<p><a href="${PROGRAMA.BOOKING}" style="background:#1a1a2e;color:#fff;padding:10px 22px;border-radius:6px;text-decoration:none;display:inline-block;font-weight:bold;">📅 Agendar 15 minutos</a></p>
<p style="color:#888;font-size:12px;">Quedan ${diasCierre} días para el cierre del Programa Fundadores
(condiciones preferenciales de por vida). Si ya coordinaste con nuestro equipo, ignora este mensaje.</p>
<p>Saludos,<br><strong>Equipo Treevü</strong><br>
<a href="https://gettreevu.com">gettreevu.com</a> · hello@gettreevu.com</p>`.trim(),
  };
}

async function scheduleNurturingMedio(notionId, { name, email, company, sector, employees, objetivo }) {
  const ts   = Math.floor(Date.now() / 1000);
  const data = JSON.stringify({ notion_id: notionId, name, email,
    company: company || '', sector: sector || '', employees: employees || '', objetivo: objetivo || '' });
  await Promise.all([
    redisCmd('ZADD', 'nurturings', ts, notionId),
    redisCmd('SET',  `nurturing:${notionId}`, data, 'EX', 2592000),
  ]);
}

// ── Notion ────────────────────────────────────────────────────────────────────
async function saveToNotion({ name, email, company, role, sector, employees, objetivo, message, source, score, probability, telegramChatId, phone }) {
  const nombreCargo = role ? `${name}, ${role}` : name;
  const scoreVal    = score || calcScore(sector, employees, objetivo);

  const properties = {
    'Nombre y Cargo': { title:     [{ text: { content: nombreCargo || 'Sin nombre' } }] },
    'Email':          { email:     email || null },
    'Empresa':        { rich_text: [{ text: { content: company   || '' } }] },
    'Score':          { select:    { name: scoreVal } },
    'Estado':         { select:    { name: 'Nuevo' } },
  };

  if (sector)    properties['Sector']        = { select:    { name: sector } };
  if (employees) properties['Colaboradores'] = { select:    { name: employees } };
  if (objetivo)  properties['Objetivo']      = { select:    { name: objetivo } };
  if (source)    properties['Fuente']        = { select:    { name: source } };
  if (typeof probability === 'number') properties['Probabilidad'] = { number: probability };

  const notaContent = [
    message || '',
    telegramChatId ? `[tg:${telegramChatId}]` : '',
    phone          ? `[wa:${normalizePhone(phone)}]` : '',
  ].filter(Boolean).join(' ');
  if (notaContent) properties['Notas'] = { rich_text: [{ text: { content: notaContent.slice(0, 2000) } }] };

  return notionCreate(NOTION.CRM_DB, properties);
}

// ── Deduplicación: ¿email ya existe en CRM? ──────────────────────────────────
async function findExistingLead(email) {
  if (!email) return null;
  try {
    const data = await notionQuery(NOTION.CRM_DB, { property: 'Email', email: { equals: email.toLowerCase().trim() } }, 1);
    return data.results?.[0] || null;
  } catch { return null; }
}

// ── Cross-reference: ¿empresa ya en pipeline outbound? ───────────────────────
async function checkEjecucionMatch(company) {
  if (!company || !NOTION.TOKEN) return null;
  try {
    const data = await notionQuery(NOTION.EJECUCION_DB, {
      property: 'Empresa', title: { contains: company },
    }, 1);
    return data.results?.[0] || null;
  } catch { return null; }
}

async function notifyMatch(company, matchPage, inboundName, inboundEmail) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  const estado  = matchPage.properties?.['Estado']?.select?.name || '';
  const decisor = matchPage.properties?.['Decisor']?.rich_text?.[0]?.plain_text || '';
  const d7      = matchPage.properties?.['Día 7 (WhatsApp)']?.date?.start || '';

  let msg = `⚠️ *MATCH inbound × outbound*\n\n`;
  msg += `🏢 *${escapeMd(company)}* ya está en tu pipeline ABM\n`;
  if (estado)  msg += `📌 Estado outbound: ${escapeMd(estado)}\n`;
  if (decisor) msg += `👤 Decisor ABM: ${escapeMd(decisor)}\n`;
  if (d7)      msg += `📅 D7 programado: ${d7}\n`;
  msg += `\n📥 Nuevo inbound: ${escapeMd(inboundName || 'Sin nombre')}`;
  if (inboundEmail) msg += ` · ${escapeMd(inboundEmail)}`;
  msg += `\n\n_¿Coordinar acciones para no duplicar contacto?_`;

  await sendMessage(TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, msg).catch(err =>
    console.error('[lead] telegram match error:', err.message)
  );
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-webhook-secret');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const secret = req.headers['x-webhook-secret'];
  if (!WEBHOOK_SECRET || secret !== WEBHOOK_SECRET) {
    console.warn('[lead] Intento sin secret válido');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { name, email, company, role, sector, employees, objetivo, message, source, score, probability, telegramChatId, phone } = req.body || {};

  if (!name || !email) {
    return res.status(400).json({ error: 'name y email son requeridos' });
  }

  const emailNorm = email.toLowerCase().trim();
  console.log(`[lead] Entrante: ${company || 'sin empresa'} | ${source || 'canal desconocido'}`);

  // Deduplicación: si el email ya existe, no crear duplicado
  const existing = await findExistingLead(emailNorm);
  if (existing) {
    console.log(`[lead] Dedup: ${emailNorm} ya existe (${existing.id}) — skipping Notion create`);
    // Supabase upsert sigue siendo idempotente — actualiza source si cambia
    const scoreVal = score || calcScore(sector, employees, objetivo);
    supabaseUpsert('leads', {
      notion_id: existing.id, name, email: emailNorm, company: company || null,
      source: source || null, score: scoreVal,
    }).catch(() => {});
    return res.status(200).json({ success: true, notionId: existing.id, deduplicated: true });
  }

  try {
    const [page, matchPage] = await Promise.all([
      saveToNotion({ name, email: emailNorm, company, role, sector, employees, objetivo, message, source, score, probability, telegramChatId, phone }),
      checkEjecucionMatch(company),
    ]);
    console.log(`[lead] Notion OK — ${name} (${source})`);

    // Dual-write to Supabase (fire-and-forget — Notion is primary read source)
    const scoreVal = score || calcScore(sector, employees, objetivo);
    supabaseUpsert('leads', {
      notion_id:   page.id,
      name,
      email:       emailNorm,
      company:     company     || null,
      role:        role        || null,
      sector:      sector      || null,
      employees:   employees   || null,
      objetivo:    objetivo    || null,
      message:     message     || null,
      source:      source      || null,
      score:       scoreVal,
      probability: typeof probability === 'number' ? probability : null,
      phone:       phone ? normalizePhone(phone) : null,
    }).catch(err => console.error('[lead] Supabase write:', err.message));

    // WhatsApp inmediato para leads ALTO con teléfono
    if (scoreVal === 'ALTO' && phone) {
      const firstName = (name || 'equipo').split(/[\s,\-]+/)[0];
      const waMsg = `Hola ${firstName} 👋\n\nSoy Ricardo de *Treevü*. Vi que tu empresa encaja con nuestro Programa Fundadores.\n\n¿Tienes 20 min esta semana para ver cómo reducimos rotación en *${company || 'tu empresa'}*? Quedan pocos cupos.\n\n📅 ${PROGRAMA.BOOKING}`;
      sendWhatsApp(phone, waMsg)
        .catch(err => console.error('[lead] WhatsApp ALTO:', err.message));
    }

    // Nurturing automático para leads MEDIO (fire-and-forget)
    if (scoreVal === 'MEDIO') {
      getGmailToken()
        .then(token => token && gmailSend(token, buildNurturingD0(name, email, company, sector, employees, objetivo)))
        .catch(err => console.error('[lead] Nurturing D+0:', err.message));
      scheduleNurturingMedio(page.id, { name, email, company, sector, employees, objetivo })
        .catch(err => console.error('[lead] Redis nurturing:', err.message));
    }

    if (matchPage) {
      console.log(`[lead] Match outbound encontrado para: ${company}`);
      // notifyMatch movida al daily-summary — sin alerta en tiempo real
    }
    return res.status(200).json({ success: true, notionId: page.id });
  } catch (err) {
    console.error('[lead] Error:', err.message);
    captureException(err, { name, email, company, source });
    return res.status(500).json({ error: err.message });
  }
}
