// ── api/followup.js ───────────────────────────────────────────────────────────
// Cron job diario (9am Lima): seguimiento de leads, cadencias, briefings,
// re-engagement de sesiones abandonadas, y reactivación semanal (lunes).
// Schedule: "0 14 * * *" (9am Lima, 14:00 UTC)

import { NOTION, PROGRAMA, SCORE_EMOJI } from './lib/constants.js';
import { getProp, notionQuery, notionPatch } from './lib/notion.js';
import { sendMessage }       from './lib/telegram.js';
import { askClaude }         from './lib/anthropic.js';
import { detectGender }      from './lib/validators.js';
import { captureException }  from './lib/sentry.js';
import { redisCmd }          from './lib/redis.js';
import { getGmailToken, gmailSend } from './lib/gmail.js';

const NOTION_DATABASE_ID  = NOTION.CRM_DB;
const NOTION_EJECUCION_DB = NOTION.EJECUCION_DB;
const TELEGRAM_BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID    = process.env.TELEGRAM_ABM_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET = process.env.CRON_SECRET;

const DIAS_REACTIVACION = 45;
const MAX_REACTIVACION  = 5;

async function getLeadsPendingFollowup() {
  const hace48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const data = await notionQuery(NOTION_DATABASE_ID, {
    and: [
      { or: [
        { property: 'Score', select: { equals: 'ALTO' } },
        { property: 'Score', select: { equals: 'MEDIO' } }
      ]},
      { or: [
        { property: 'Estado', select: { equals: 'Nuevo' } },
        { property: 'Estado', select: { equals: 'Contactado' } }
      ]},
      { timestamp: 'created_time', created_time: { before: hace48h } }
    ]
  }, 20);
  return data.results || [];
}


function buildNurturingLine(score, nombre, empresa, objetivo, probabilidad) {
  const firstName = nombre?.split(/[\s,\-]+/)?.[0] || 'Hola';
  const genero    = detectGender(nombre);
  const dispuesto = genero === 'F' ? 'dispuesta' : 'dispuesto';
  const interesado = genero === 'F' ? 'interesada' : 'interesado';
  const probStr   = probabilidad ? ` (${probabilidad}% de fit)` : '';

  if (score === 'ALTO') {
    return `_💬 Sugerencia ALTO${probStr}_: "Hola ${firstName}, ¿pudiste revisar la info de Treevü? Quedan solo 10 cupos del Programa Fundadores — ¿estás ${dispuesto}/a a reservar uno esta semana?"`;
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

  return sendMessage(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, msg);
}

// ── #5: Brief pre-reunión (reuniones de hoy en la Ejecución DB) ──────────────
async function getBriefReunionesHoy() {
  const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
  try {
    const data = await notionQuery(NOTION_EJECUCION_DB, {
      and: [
        { property: 'Fecha Reunión',      date:     { equals: hoy } },
        { property: 'Reunión Confirmada', checkbox: { equals: true } },
      ],
    }, 10);
    return data.results || [];
  } catch { return []; }
}

async function sendBriefReuniones(reuniones) {
  if (!reuniones.length) return;

  for (const lead of reuniones) {
    const empresa  = lead.properties?.['Empresa']?.title?.[0]?.plain_text     || 'Sin empresa';
    const decisor  = lead.properties?.['Decisor']?.rich_text?.[0]?.plain_text || '';
    const sector   = lead.properties?.['Sector']?.select?.name                || '';
    const score    = lead.properties?.['Score ICP']?.number                   ?? '';
    const notas    = lead.properties?.['Notas']?.rich_text?.[0]?.plain_text   || '';
    const hoyLocal = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
    const hora     = lead.properties?.['Fecha Reunión']?.date?.start          || hoyLocal;
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

    await sendMessage(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, msg);
  }
}

// ── #4: Cadencia vencida (D7 pasó, sin reunión) ───────────────────────────────
async function getCadenciasVencidas() {
  const ayer = new Date(Date.now() - 24 * 60 * 60 * 1000)
    .toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
  try {
    const data = await notionQuery(NOTION_EJECUCION_DB, {
      and: [
        { property: 'Día 7 (WhatsApp)',   date:     { before: ayer } },
        { property: 'Reunión Confirmada', checkbox: { equals: false } },
        { property: 'Estado',             select:   { equals: 'En cadencia' } },
      ],
    }, 20);
    return data.results || [];
  } catch { return []; }
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

  await sendMessage(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, msg);
}

// ── Reactivación de leads fríos (solo lunes) ──────────────────────────────────
async function runReactivation() {
  const diaSemana = new Date().toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/Lima' });
  if (diaSemana !== 'Monday') return 0;

  const hace45d = new Date(Date.now() - DIAS_REACTIVACION * 24 * 60 * 60 * 1000).toISOString();

  try {
    const data = await notionQuery(NOTION_DATABASE_ID, {
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
    }, MAX_REACTIVACION);
    const leads = data.results || [];
    if (!leads.length) return 0;

    const semana = new Date().toLocaleDateString('es-PE', {
      weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Lima',
    });

    await sendMessage(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
      `♻️ *Reactivación semanal — ${leads.length} lead(s) fríos*\n_${semana}_\n\nLeads ALTO/MEDIO sin actividad en +${DIAS_REACTIVACION} días 👇`
    );

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

      const sugerencia = await askClaude(
        `Eres Ricardo Cuba, fundador de Treevü (EWA B2B2E, Perú). Genera un mensaje de reactivación para ${firstName} de ${empresa || 'su empresa'} (${sector}), objetivo: ${objetivo || 'no especificado'}, inactivo ${dias} días, estado anterior: ${estado}. Treevü reduce rotación 30%. Máximo 3 líneas, español peruano, cierra con pregunta. Solo el mensaje, sin explicaciones.`,
        { maxTokens: 200 }
      );

      let card = `${SCORE_EMOJI[score] || '·'} *${nombre}*\n`;
      if (empresa) card += `🏢 ${empresa}\n`;
      if (email)   card += `📧 ${email}\n`;
      card += `📌 ${estado} · _inactivo ${dias} días_\n`;
      if (sugerencia) card += `\n💬 *Sugerencia:*\n\`\`\`\n${sugerencia}\n\`\`\``;

      await sendMessage(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, card);
    }

    console.log(`[followup] reactivation: ${leads.length} sugerencias enviadas`);
    return leads.length;
  } catch (err) {
    console.error('[followup] reactivation error:', err.message);
    return 0;
  }
}

// ── Nurturing MEDIO — D+3 y D+7 ─────────────────────────────────────────────
async function runNurturingMedio() {
  const nowTs      = Math.floor(Date.now() / 1000);
  const diasCierre = Math.ceil((new Date(PROGRAMA.FECHA_CIERRE) - new Date()) / 864e5);
  const gmailToken = await getGmailToken().catch(() => null);
  if (!gmailToken) {
    if (process.env.GMAIL_CLIENT_ID) {
      captureException(new Error('Gmail token refresh failed'), { context: 'followup-nurturing' });
      sendMessage(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
        `⚠️ *Gmail token inválido* — nurturing emails pausados\n_Revisar credenciales OAuth2_`
      ).catch(() => {});
    }
    return 0;
  }

  const sequences = [
    {
      key: 'd3', minH: 70, maxH: 74,
      buildEmail: (d) => ({
        to:      d.email,
        subject: `Caso real: así redujeron rotación en ${d.sector || 'empresas peruanas'} con Treevü`,
        bodyHtml: `
<p>Hola ${(d.name || '').split(/[\s,\-]+/)[0] || 'equipo'},</p>
<p>Hace 3 días te compartimos información sobre Treevü. Quería mostrarte un caso concreto:</p>
<blockquote style="border-left:3px solid #1a1a2e;padding-left:12px;color:#444;">
  Una empresa de ${d.sector || 'servicios'} con ${d.employees || '200+'} colaboradores
  redujo su rotación en 28% en 6 meses y recuperó más de S/ 200,000 anuales en costos de reemplazo.
  Setup en 2 semanas, sin cambiar sistemas de nómina.
</blockquote>
<p>¿Esto es relevante para <strong>${d.company || 'tu empresa'}</strong>? Con gusto hacemos el cálculo específico para tu caso.</p>
<p><a href="${PROGRAMA.BOOKING}" style="background:#1a1a2e;color:#fff;padding:10px 22px;border-radius:6px;text-decoration:none;display:inline-block;">📅 Ver cómo aplica a mi empresa</a></p>
<p>Saludos,<br><strong>Equipo Treevü</strong><br>
<a href="https://gettreevu.com">gettreevu.com</a></p>`.trim(),
      }),
    },
    {
      key: 'd7', minH: 166, maxH: 170,
      buildEmail: (d) => ({
        to:      d.email,
        subject: `Quedan ${diasCierre} días — Programa Fundadores Treevü`,
        bodyHtml: `
<p>Hola ${(d.name || '').split(/[\s,\-]+/)[0] || 'equipo'},</p>
<p>El <strong>Programa Fundadores de Treevü</strong> cierra el <strong>${PROGRAMA.FECHA_CIERRE}</strong>
(en ${diasCierre} días). Los fundadores acceden a condiciones preferenciales de por vida.</p>
<p>Si <strong>${d.company || 'tu empresa'}</strong> está evaluando opciones de bienestar financiero para
${d.employees || 'tus colaboradores'}, este es el momento de agendar una conversación sin compromiso.</p>
<p><a href="${PROGRAMA.BOOKING}" style="background:#1a1a2e;color:#fff;padding:10px 22px;border-radius:6px;text-decoration:none;display:inline-block;">📅 Reservar uno de los últimos cupos</a></p>
<p style="color:#888;font-size:12px;">Si ya no tienes interés, puedes ignorar este mensaje — no te escribiremos más.</p>
<p>Saludos,<br><strong>Equipo Treevü</strong><br>
<a href="https://gettreevu.com">gettreevu.com</a></p>`.trim(),
      }),
    },
  ];

  let total = 0;
  for (const seq of sequences) {
    const minTs = nowTs - seq.maxH * 3600;
    const maxTs = nowTs - seq.minH * 3600;
    const ids   = await redisCmd('ZRANGEBYSCORE', 'nurturings', minTs, maxTs);
    if (!ids?.length) continue;

    for (const notionId of ids) {
      const alreadySent = await redisCmd('GET', `nurturing_${seq.key}:${notionId}`);
      if (alreadySent) continue;

      const raw = await redisCmd('GET', `nurturing:${notionId}`);
      if (!raw) continue;
      let data;
      try { data = JSON.parse(raw); } catch { continue; }
      if (!data.email) continue;

      const sent = await gmailSend(gmailToken, seq.buildEmail(data));
      if (sent) {
        await redisCmd('SET', `nurturing_${seq.key}:${notionId}`, '1', 'EX', 2592000);
        total++;
        console.log(`[followup] Nurturing ${seq.key} enviado: ${data.email} (${data.company})`);
      }
    }
  }
  return total;
}

// ── Propuestas vencidas (>14 días sin actividad) ──────────────────────────────
async function checkPropostasVencidas() {
  const hace14d = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  try {
    const data = await notionQuery(NOTION_DATABASE_ID, {
      and: [
        { property: 'Estado', select: { equals: 'Propuesta' } },
        { timestamp: 'last_edited_time', last_edited_time: { before: hace14d } },
      ],
    }, 10);
    const leads = data.results || [];
    if (!leads.length) return 0;

    let msg = `⚠️ *Propuestas vencidas — ${leads.length} lead(s)*\n`;
    msg += `_Sin actividad en +14 días_\n\n`;
    for (const lead of leads) {
      const nombre  = getProp(lead, 'Nombre y Cargo') || 'Sin nombre';
      const empresa = getProp(lead, 'Empresa')        || '';
      const dias    = Math.floor((Date.now() - new Date(lead.last_edited_time).getTime()) / (1000 * 60 * 60 * 24));
      msg += `📄 *${nombre}*${empresa ? ` · ${empresa}` : ''}\n`;
      msg += `_Inactiva ${dias} días_ — `;
      msg += `¿llamada de desbloqueo · \`/actualizar ${empresa} Contactado\` · descartar?\n\n`;
    }
    await sendMessage(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, msg);
    return leads.length;
  } catch (err) {
    console.error('[followup] propuestas vencidas:', err.message);
    return 0;
  }
}

// ── Secuencia post-reunión D+1 / D+3 / D+7 ───────────────────────────────────
async function checkPostMeetingSequence() {
  const nowTs = Math.floor(Date.now() / 1000);
  const sequences = [
    {
      key: 'd1', day: 1, minH: 22, maxH: 26,
      buildMsg: (d) =>
        `📋 *Follow-up D+1 — ${d.empresa}*\n\n` +
        `¿Enviaste el correo de seguimiento a *${(d.nombre || '').split(/[\s,]+/)[0] || d.nombre}*?\n\n` +
        `El follow-up en las primeras 24h tiene 3× más respuesta.\n` +
        `_Dolor: ${d.dolor || 'N/A'} · Sig. paso: ${d.siguiente_paso || 'N/A'}_`,
    },
    {
      key: 'd3', day: 3, minH: 70, maxH: 74,
      buildMsg: (d) =>
        `⏰ *D+3 post-reunión — ${d.empresa}*\n\n` +
        `3 días desde la reunión. Si no hubo respuesta considera:\n\n` +
        `_"Hola ${(d.nombre || '').split(/[\s,]+/)[0] || ''}, ¿pudiste revisar la propuesta? ` +
        `Quedé disponible para resolver cualquier duda."_\n\n` +
        `Sig. paso acordado: *${d.siguiente_paso || 'N/A'}*`,
    },
    {
      key: 'd7', day: 7, minH: 166, maxH: 170,
      buildMsg: (d) =>
        `🔔 *D+7 — ${d.empresa}*\n\n` +
        `Una semana sin respuesta de *${d.nombre || 'el contacto'}*. Opciones:\n\n` +
        `• Llamada de 10 min para desbloquear\n` +
        `• Mensaje de urgencia (quedan cupos Founders)\n` +
        `• \`/actualizar ${d.empresa} Contactado\` y reactivar en 30 días\n\n` +
        `_Dolor: ${d.dolor || 'N/A'}_`,
    },
  ];

  let total = 0;
  for (const seq of sequences) {
    const minTs = nowTs - seq.maxH * 3600;
    const maxTs = nowTs - seq.minH * 3600;
    const ids   = await redisCmd('ZRANGEBYSCORE', 'postmeetings', minTs, maxTs);
    if (!ids?.length) continue;

    for (const leadId of ids) {
      const alreadySent = await redisCmd('GET', `postmeeting_${seq.key}:${leadId}`);
      if (alreadySent) continue;

      const raw = await redisCmd('GET', `postmeeting:${leadId}`);
      if (!raw) continue;
      let data;
      try { data = JSON.parse(raw); } catch { continue; }

      await sendMessage(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, seq.buildMsg(data));
      await redisCmd('SET', `postmeeting_${seq.key}:${leadId}`, '1', 'EX', 2592000);
      total++;
      console.log(`[followup] D+${seq.day} enviado: ${leadId} (${data.empresa})`);
    }
  }
  return total;
}

// ── Cadencia de propuestas D+2 / D+5 / D+10 ─────────────────────────────────
async function checkProposalCadence() {
  const nowTs = Math.floor(Date.now() / 1000);
  const sequences = [
    {
      key: 'd2', minH: 46, maxH: 50,
      buildMsg: (d) =>
        `📄 *Cadencia propuesta D+2 — ${d.empresa}*\n\n` +
        `¿Recibiste respuesta de *${(d.nombre || '').split(/[\s,]+/)[0] || d.nombre}* sobre la propuesta?\n\n` +
        `Si no: envía un WhatsApp corto:\n` +
        `_"Hola ${(d.nombre || '').split(/[\s,]+/)[0] || ''}, ¿tuviste oportunidad de revisar la propuesta? Cualquier duda con gusto."_`,
    },
    {
      key: 'd5', minH: 118, maxH: 122,
      buildMsg: (d) =>
        `⏰ *Cadencia propuesta D+5 — ${d.empresa}*\n\n` +
        `5 días sin respuesta de *${d.nombre || 'el contacto'}*.\n\n` +
        `Opciones:\n` +
        `• Llamada de 10 min para resolver objeciones\n` +
        `• Enviar caso de éxito del sector ${d.sector || ''}\n` +
        `• \`/actualizar ${d.empresa} Contactado\` si ya no avanza`,
    },
    {
      key: 'd10', minH: 238, maxH: 242,
      buildMsg: (d) =>
        `🔔 *Propuesta sin respuesta D+10 — ${d.empresa}*\n\n` +
        `10 días sin cerrar. Última oportunidad antes de archivar:\n\n` +
        `_"${(d.nombre || '').split(/[\s,]+/)[0] || 'Hola'}, ¿sigue siendo prioridad para Q2? ` +
        `Quedan pocos cupos del Programa Fundadores — necesito saberlo para reservarte uno."_\n\n` +
        `Si no hay respuesta en 48h → \`/actualizar ${d.empresa} Descartado\``,
    },
  ];

  let total = 0;
  for (const seq of sequences) {
    const minTs = nowTs - seq.maxH * 3600;
    const maxTs = nowTs - seq.minH * 3600;
    const ids   = await redisCmd('ZRANGEBYSCORE', 'proposals', minTs, maxTs);
    if (!ids?.length) continue;

    for (const leadId of ids) {
      const alreadySent = await redisCmd('GET', `proposal_${seq.key}:${leadId}`);
      if (alreadySent) continue;

      const raw = await redisCmd('GET', `proposal:${leadId}`);
      if (!raw) continue;
      let data;
      try { data = JSON.parse(raw); } catch { continue; }

      await sendMessage(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, seq.buildMsg(data));
      await redisCmd('SET', `proposal_${seq.key}:${leadId}`, '1', 'EX', 2592000);
      total++;
      console.log(`[followup] Proposal ${seq.key} enviado: ${leadId} (${data.empresa})`);
    }
  }
  return total;
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

    // Redis health check — alerta pero no aborta (Notion tasks siguen funcionando)
    const redisPing = await redisCmd('PING').catch(() => null);
    if (!redisPing) {
      console.warn('[followup] Redis no disponible — cadencias pausadas');
      sendMessage(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
        `⚠️ *Redis no disponible* — cron /followup\n_Nurturing, post-meeting y proposal cadences pausadas. Notion tasks OK._`
      ).catch(() => {});
    }

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

    // runReactivation() removido — lo maneja exclusivamente /api/reactivation (cron lunes)
    const [postMeetingSeqs, nurturingEnviados, propuestasVencidas, proposalCadencia] = await Promise.all([
      checkPostMeetingSequence(),
      runNurturingMedio(),
      checkPropostasVencidas(),
      checkProposalCadence(),
    ]);

    console.log(`[followup] OK — ${leads.length} pendientes, ${vencidos.length} vencidos, ${reunionesHoy.length} reuniones, ${postMeetingSeqs} post-meeting, ${nurturingEnviados} nurturing, ${propuestasVencidas} propuestas vencidas, ${proposalCadencia} proposal cadencia`);
    return res.status(200).json({
      success: true,
      pendientes: leads.length,
      vencidos: vencidos.length,
      reuniones: reunionesHoy.length,
      postMeetingSeqs,
      nurturingEnviados,
      propuestasVencidas,
      proposalCadencia,
    });
  } catch (err) {
    console.error('[followup] Error:', err.message);
    captureException(err, { path: '/api/followup' });
    sendMessage(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
      `⚠️ *Error crítico en cron /api/followup*\n\`${err.message}\`\n_Secuencias pausadas — revisar Sentry_`
    ).catch(() => {});
    return res.status(500).json({ error: err.message });
  }
}
