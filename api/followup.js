// ── api/followup.js ───────────────────────────────────────────────────────────
// Cron job diario (9am Lima): seguimiento de leads, cadencias, briefings,
// re-engagement de sesiones abandonadas, y reactivación semanal (lunes).
// Schedule: "0 14 * * *" (9am Lima, 14:00 UTC)

const NOTION_TOKEN        = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID  = "2e5f06c0295b46fbbc212bac5f6fcb3c"; // CRM unificado
const NOTION_EJECUCION_DB = "bcebf14878f04db087f052722f9a084d"; // Ejecución 14 días
const TELEGRAM_BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID    = process.env.TELEGRAM_ABM_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_VU_TOKEN   = process.env.TELEGRAM_VU_BOT_TOKEN;
const CRON_SECRET         = process.env.CRON_SECRET;
const ANTHROPIC_KEY       = process.env.ANTHROPIC_API_KEY;
const UPSTASH_URL         = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN       = process.env.UPSTASH_REDIS_REST_TOKEN;

const DIAS_REACTIVACION = 45;
const MAX_REACTIVACION  = 5;

function getProp(page, name) {
  const prop = page.properties?.[name];
  if (!prop) return null;
  if (prop.type === 'select')    return prop.select?.name || null;
  if (prop.type === 'title')     return prop.title?.[0]?.plain_text || null;
  if (prop.type === 'rich_text') return prop.rich_text?.[0]?.plain_text || null;
  if (prop.type === 'email')     return prop.email || null;
  return null;
}

async function getLeadsPendingFollowup() {
  // Buscar leads ALTO o MEDIO en estado "Nuevo" o "Contactado" creados hace más de 48h
  const hace48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28'
    },
    body: JSON.stringify({
      filter: {
        and: [
          {
            or: [
              { property: 'Score', select: { equals: 'ALTO' } },
              { property: 'Score', select: { equals: 'MEDIO' } }
            ]
          },
          {
            or: [
              { property: 'Estado', select: { equals: 'Nuevo' } },
              { property: 'Estado', select: { equals: 'Contactado' } }
            ]
          },
          {
            timestamp: 'created_time',
            created_time: { before: hace48h }
          }
        ]
      },
      page_size: 20
    })
  });

  if (!res.ok) throw new Error(`Notion ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.results || [];
}

function detectGender(fullName) {
  if (!fullName) return 'M';
  const first = fullName.trim().split(/[\s,\-]+/)[0]
    .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const maleEx     = ['joseba','nikola','luca','bautista','joshua','elia','andrea','garcia'];
  const femaleSpec = ['isabel','pilar','carmen','belen','mercedes','ines','rocio',
                      'flor','luz','paz','sol','esperanza','milagros','nieves',
                      'trinidad','dolores','consuelo','amparo','fe','ruth','esther','mar'];
  if (maleEx.includes(first))     return 'M';
  if (femaleSpec.includes(first)) return 'F';
  if (first.endsWith('a'))        return 'F';
  return 'M';
}

function buildNurturingLine(score, nombre, empresa, objetivo, probabilidad) {
  const firstName = nombre?.split(/[\s,\-]+/)?.[0] || 'Hola';
  const genero    = detectGender(nombre);
  const dispuesto = genero === 'F' ? 'dispuesta' : 'dispuesto';
  const interesado = genero === 'F' ? 'interesada' : 'interesado';
  const probStr   = probabilidad ? ` (${probabilidad}% de fit)` : '';

  if (score === 'ALTO') {
    return `_💬 Sugerencia ALTO${probStr}_: "Hola ${firstName}, ¿pudiste revisar la info de Treevü? Quedan solo 4 cupos del Programa Fundadores — ¿estás ${dispuesto}/a a reservar uno esta semana?"`;
  }
  const objMsg = objetivo ? `Tu objetivo de ${objetivo.toLowerCase()} es exactamente donde Treevü genera impacto.` : '';
  return `_💬 Sugerencia MEDIO${probStr}_: "Hola ${firstName}, ¿sigues ${interesado}/a en optimizar el bienestar de tu equipo en ${empresa || 'tu empresa'}? ${objMsg} ¿Conversamos 15 min?"`;
}

async function sendFollowupAlert(leads) {
  if (!leads.length) {
    console.log('[followup] Sin leads pendientes de seguimiento');
    return;
  }

  const altos  = leads.filter(l => (getProp(l, 'Score') || '') === 'ALTO');
  const medios = leads.filter(l => (getProp(l, 'Score') || '') !== 'ALTO');

  let msg = `⏰ *Seguimiento pendiente — Treevü*\n`;
  msg += `_${leads.length} lead(s) sin respuesta en +48h_\n\n`;

  for (const lead of [...altos, ...medios]) {
    const score       = getProp(lead, 'Score')         || 'MEDIO';
    const nombre      = getProp(lead, 'Nombre y Cargo') || 'Sin nombre';
    const empresa     = getProp(lead, 'Empresa')        || '';
    const email       = getProp(lead, 'Email')          || '';
    const estado      = getProp(lead, 'Estado')         || 'Nuevo';
    const objetivo    = getProp(lead, 'Objetivo')       || '';
    const fuente      = getProp(lead, 'Fuente')         || '';
    const probabilidad = typeof lead.properties?.Probabilidad?.number === 'number'
      ? lead.properties.Probabilidad.number : null;
    const creado  = new Date(lead.created_time).toLocaleDateString('es-PE', { timeZone: 'America/Lima' });
    const emoji   = score === 'ALTO' ? '🔥' : '🟡';

    msg += `${emoji} *${nombre}*\n`;
    if (empresa) msg += `🏢 ${empresa}\n`;
    msg += `📧 ${email}\n`;
    msg += `📅 ${creado} · ${estado}`;
    if (fuente) msg += ` · ${fuente}`;
    msg += `\n`;
    msg += buildNurturingLine(score, nombre, empresa, objetivo, probabilidad) + '\n\n';
  }

  msg += `💡 _Los leads se enfrían en 72h — actúa hoy._`;

  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'Markdown' })
  });

  if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── #5: Brief pre-reunión (reuniones de hoy en la Ejecución DB) ──────────────
async function getBriefReunionesHoy() {
  const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
  const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_EJECUCION_DB}/query`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
    body: JSON.stringify({
      filter: {
        and: [
          { property: 'Fecha Reunión',     date:   { equals: hoy } },
          { property: 'Reunión Confirmada', checkbox: { equals: true } },
        ],
      },
      page_size: 10,
    }),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.results || [];
}

async function sendBriefReuniones(reuniones) {
  if (!reuniones.length) return;

  for (const lead of reuniones) {
    const empresa  = lead.properties?.['Empresa']?.title?.[0]?.plain_text     || 'Sin empresa';
    const decisor  = lead.properties?.['Decisor']?.rich_text?.[0]?.plain_text || '';
    const sector   = lead.properties?.['Sector']?.select?.name                || '';
    const score    = lead.properties?.['Score ICP']?.number                   ?? '';
    const notas    = lead.properties?.['Notas']?.rich_text?.[0]?.plain_text   || '';
    const hora     = lead.properties?.['Fecha Reunión']?.date?.start          || hoy;
    const email    = lead.properties?.['Email Decisor']?.email                || '';
    const telefono = lead.properties?.['Teléfono']?.phone_number              || '';

    let msg = `📅 *Reunión hoy — ${empresa}*\n\n`;
    if (decisor)  msg += `👤 ${decisor}\n`;
    if (email)    msg += `📧 ${email}\n`;
    if (telefono) msg += `📱 ${telefono}\n`;
    if (sector)   msg += `🏭 ${sector}\n`;
    if (score)    msg += `📊 Score ICP: ${score}\n`;
    if (notas)    msg += `\n📝 _${notas}_\n`;

    msg += `\n*Brief diagnóstico (20 min):*\n`;
    msg += `· "¿Cuál es tu rotación anual hoy?"\n`;
    msg += `· "¿En qué áreas es mayor?"\n`;
    msg += `· "¿Qué costo tiene reemplazar a uno?"\n\n`;
    msg += `Cuando termines: \`/resultado ${empresa}\``;

    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'Markdown' }),
    });
  }
}

// ── #4: Cadencia vencida (D7 pasó, sin reunión) ───────────────────────────────
async function getCadenciasVencidas() {
  const ayer = new Date(Date.now() - 24 * 60 * 60 * 1000)
    .toLocaleDateString('en-CA', { timeZone: 'America/Lima' });

  const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_EJECUCION_DB}/query`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
    body: JSON.stringify({
      filter: {
        and: [
          { property: 'Día 7 (WhatsApp)', date: { before: ayer } },
          { property: 'Reunión Confirmada', checkbox: { equals: false } },
          { property: 'Estado', select: { equals: 'En cadencia' } },
        ],
      },
      page_size: 20,
    }),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.results || [];
}

async function sendCadenciaVencidaAlert(leads) {
  if (!leads.length) return;

  let msg = `⏰ *Cadencia vencida — ${leads.length} lead(s)*\n`;
  msg += `_D7 superado sin reunión confirmada_\n\n`;

  for (const lead of leads) {
    const empresa  = lead.properties?.['Empresa']?.title?.[0]?.plain_text || 'Sin empresa';
    const decisor  = lead.properties?.['Decisor']?.rich_text?.[0]?.plain_text || '';
    const d7       = lead.properties?.['Día 7 (WhatsApp)']?.date?.start || '';
    msg += `🏢 *${empresa}*`;
    if (decisor) msg += ` · ${decisor}`;
    msg += `\n📅 D7: ${d7}\n`;
    msg += `¿Qué hacemos? \`/iniciar ${empresa}\` para reiniciar · o marca reunión en Notion\n\n`;
  }

  msg += `_Opciones: reiniciar cadencia, escalar a CEO, o descartar_`;

  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'Markdown' }),
  });
}

// ── Session recovery (diario) ─────────────────────────────────────────────────
async function redisCmd(...args) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  try {
    const res = await fetch(UPSTASH_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    const data = await res.json();
    return data.result ?? null;
  } catch { return null; }
}

async function runSessionRecovery() {
  if (!UPSTASH_URL || !UPSTASH_TOKEN || !TELEGRAM_VU_TOKEN) return 0;

  const RECOVERY_MESSAGES = {
    SECTOR:          '¿Te perdiste? 👋 Solo quedan 2 preguntas rápidas para ver cómo Treevü puede ayudar a tu empresa. ¿Seguimos?',
    SIZE:            '¿Te perdiste? 👋 Ya casi terminas — solo falta indicar tu objetivo principal. ¿Seguimos?',
    CHAT:            '¿Quedó alguna duda sin responder? Estoy aquí para ayudarte. 👇',
    CAPTURE_NAME:    '¿Listo/a para que el equipo te contacte? Solo necesito tu nombre para continuar. 👇',
    CAPTURE_COMPANY: '¿En qué empresa trabajas? Es el último paso antes de que el equipo se comunique contigo. 👇',
    CAPTURE_EMAIL:   '¿Cuál es tu correo corporativo? El equipo te escribirá en menos de 24h. 👇',
  };

  try {
    const scanRes = await fetch(`${UPSTASH_URL}/scan/0/match/sess:*/count/200`, {
      headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}` },
    });
    const scanData = await scanRes.json();
    const keys = scanData.result?.[1] || [];

    const now = Date.now();
    const MIN_AGE_MS = 4  * 60 * 60 * 1000;
    const MAX_AGE_MS = 23 * 60 * 60 * 1000;
    let recovered = 0;

    for (const key of keys) {
      const raw = await redisCmd('GET', key);
      if (!raw) continue;
      let session;
      try { session = JSON.parse(raw); } catch { continue; }

      if (session.step === 'DONE' || session.step === 'INIT' || !session.sector) continue;
      if (session.recoverySentAt && (now - session.recoverySentAt) < MIN_AGE_MS) continue;

      const ttl = await redisCmd('TTL', key);
      if (!ttl || ttl < 0) continue;
      const ageMs = (86400 - ttl) * 1000;
      if (ageMs < MIN_AGE_MS || ageMs > MAX_AGE_MS) continue;

      const message = RECOVERY_MESSAGES[session.step];
      if (!message) continue;

      const chatId = key.replace('sess:', '');
      await fetch(`https://api.telegram.org/bot${TELEGRAM_VU_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'Markdown' }),
      });

      session.recoverySentAt = now;
      await redisCmd('SET', key, JSON.stringify(session), 'KEEPTTL');
      recovered++;
    }

    console.log(`[followup] session-recovery: ${recovered} sesiones recuperadas`);
    return recovered;
  } catch (err) {
    console.error('[followup] session-recovery error:', err.message);
    return 0;
  }
}

// ── Reactivación de leads fríos (solo lunes) ──────────────────────────────────
async function runReactivation() {
  const diaSemana = new Date().toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/Lima' });
  if (diaSemana !== 'Monday') return 0;

  const hace45d = new Date(Date.now() - DIAS_REACTIVACION * 24 * 60 * 60 * 1000).toISOString();

  try {
    const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
      body: JSON.stringify({
        filter: {
          and: [
            { or: [
              { property: 'Score', select: { equals: 'ALTO' } },
              { property: 'Score', select: { equals: 'MEDIO' } },
            ]},
            { or: [
              { property: 'Estado', select: { equals: 'Descartado' } },
              { property: 'Estado', select: { equals: 'Nuevo' } },
              { property: 'Estado', select: { equals: 'Contactado' } },
            ]},
            { timestamp: 'created_time', created_time: { before: hace45d } },
          ],
        },
        sorts: [{ timestamp: 'created_time', direction: 'ascending' }],
        page_size: MAX_REACTIVACION,
      }),
    });
    if (!res.ok) return 0;
    const data = await res.json();
    const leads = data.results || [];
    if (!leads.length) return 0;

    const semana = new Date().toLocaleDateString('es-PE', {
      weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Lima',
    });

    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: `♻️ *Reactivación semanal — ${leads.length} lead(s) fríos*\n_${semana}_\n\nLeads ALTO/MEDIO sin actividad en +${DIAS_REACTIVACION} días 👇`,
        parse_mode: 'Markdown',
      }),
    });

    const SCORE_EMOJI = { ALTO: '🔥', MEDIO: '🟡' };

    for (const lead of leads) {
      const nombre  = getProp(lead, 'Nombre y Cargo') || 'Sin nombre';
      const empresa = getProp(lead, 'Empresa')        || '';
      const score   = getProp(lead, 'Score')          || 'MEDIO';
      const estado  = getProp(lead, 'Estado')         || 'Nuevo';
      const email   = getProp(lead, 'Email')          || '';
      const objetivo = getProp(lead, 'Objetivo')      || '';
      const sector  = getProp(lead, 'Sector')         || '';
      const dias    = Math.floor((Date.now() - new Date(lead.created_time).getTime()) / (1000 * 60 * 60 * 24));
      const firstName = nombre.split(/[\s,]+/)[0] || 'Hola';
      const genero  = detectGender(nombre);
      const dispuesto = genero === 'F' ? 'dispuesta' : 'dispuesto';

      let sugerencia = null;
      if (ANTHROPIC_KEY) {
        try {
          const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 200,
              messages: [{ role: 'user', content:
                `Eres Ricardo Cuba, fundador de Treevü (EWA B2B2E, Perú). Genera un mensaje de reactivación para ${firstName} de ${empresa || 'su empresa'} (${sector}), objetivo: ${objetivo || 'no especificado'}, inactivo ${dias} días, estado anterior: ${estado}. Treevü reduce rotación 30%. Máximo 3 líneas, español peruano, cierra con pregunta. Solo el mensaje, sin explicaciones.`
              }],
            }),
          });
          const aiData = await aiRes.json();
          sugerencia = aiData.content?.[0]?.text || null;
        } catch { /* sin IA, continuar */ }
      }

      let card = `${SCORE_EMOJI[score] || '·'} *${nombre}*\n`;
      if (empresa) card += `🏢 ${empresa}\n`;
      if (email)   card += `📧 ${email}\n`;
      card += `📌 ${estado} · _inactivo ${dias} días_\n`;
      if (sugerencia) card += `\n💬 *Sugerencia:*\n\`\`\`\n${sugerencia}\n\`\`\``;

      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: card, parse_mode: 'Markdown' }),
      });
    }

    console.log(`[followup] reactivation: ${leads.length} sugerencias enviadas`);
    return leads.length;
  } catch (err) {
    console.error('[followup] reactivation error:', err.message);
    return 0;
  }
}

// ── Handler principal ──────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const authHeader = req.headers['authorization'];
  const secret = req.query?.secret;
  const isVercelCron = authHeader === `Bearer ${CRON_SECRET}`;
  const isManual = secret && secret === CRON_SECRET;

  if (!isVercelCron && !isManual) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('[followup] Ejecutando cron diario...');
    const [leads, vencidos, reunionesHoy] = await Promise.all([
      getLeadsPendingFollowup(),
      getCadenciasVencidas(),
      getBriefReunionesHoy(),
    ]);
    await Promise.all([
      sendFollowupAlert(leads),
      sendCadenciaVencidaAlert(vencidos),
      sendBriefReuniones(reunionesHoy),
    ]);

    const [recovered, reactivados] = await Promise.all([
      runSessionRecovery(),
      runReactivation(),
    ]);

    console.log(`[followup] OK — ${leads.length} pendientes, ${vencidos.length} vencidos, ${reunionesHoy.length} reuniones, ${recovered} sesiones recuperadas, ${reactivados} reactivados`);
    return res.status(200).json({
      success: true,
      pendientes: leads.length,
      vencidos: vencidos.length,
      reuniones: reunionesHoy.length,
      sessionRecovery: recovered,
      reactivados,
    });
  } catch (err) {
    console.error('[followup] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
