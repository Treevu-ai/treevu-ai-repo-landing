// ── api/daily-summary.js ──────────────────────────────────────────────────────
// Cron job: resumen diario del pipeline a las 8am hora Perú (13:00 UTC)
// Configurar en vercel.json: { "crons": [{ "path": "/api/daily-summary", "schedule": "0 13 * * *" }] }
// También puede llamarse manualmente con ?secret=CRON_SECRET

import { NOTION, PROGRAMA, SCORE_EMOJI } from './lib/constants.js';
import { getProp, notionQuery }           from './lib/notion.js';
import { sendMessage }                    from './lib/telegram.js';
import { captureException }               from './lib/sentry.js';
import { getGmailToken }                  from './lib/gmail.js';

const NOTION_DATABASE_ID  = NOTION.CRM_DB;
const NOTION_EJECUCION_DB = NOTION.EJECUCION_DB;
const TELEGRAM_BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID    = process.env.TELEGRAM_ABM_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET         = process.env.CRON_SECRET;
const CUPOS_TOTALES       = PROGRAMA.CUPOS_TOTAL;

// Helper local: query al CRM DB con paginación completa
async function queryNotionAll(filter) {
  let results = [];
  let cursor;
  do {
    const data = await notionQuery(NOTION_DATABASE_ID, filter || null, 100, null, cursor);
    results = results.concat(data.results || []);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return { results };
}
const queryNotion = queryNotionAll;

// ── Health checks ─────────────────────────────────────────────────────────────
async function checkGmail() {
  try { return !!(await getGmailToken()); }
  catch { return false; }
}

// ── ABM: acciones de hoy (Ejecución 14 días) ─────────────────────────────────
async function getAccionesHoy() {
  if (!NOTION.TOKEN) return [];
  const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
  try {
    const data = await notionQuery(NOTION_EJECUCION_DB, {
      or: [
        { property: 'Día 1 (LinkedIn)', date: { equals: hoy } },
        { property: 'Día 3 (Email)',    date: { equals: hoy } },
        { property: 'Día 7 (WhatsApp)', date: { equals: hoy } },
      ],
    });

    return (data.results || []).map(page => {
      const props   = page.properties || {};
      const empresa = props['Empresa']?.title?.[0]?.plain_text || 'Sin empresa';
      const decisor = props['Decisor']?.rich_text?.[0]?.plain_text || '';
      const d1      = props['Día 1 (LinkedIn)']?.date?.start;
      const d3      = props['Día 3 (Email)']?.date?.start;
      const d7      = props['Día 7 (WhatsApp)']?.date?.start;
      const canal   = d7 === hoy ? 'WhatsApp' : d3 === hoy ? 'Email' : 'LinkedIn';
      return { empresa, decisor, canal };
    });
  } catch { return []; }
}

// ── Cadencias vencidas (D7 sin reunión confirmada) ───────────────────────────
async function getCadenciasVencidas() {
  if (!NOTION.TOKEN) return [];
  const ayer = new Date(Date.now() - 24 * 60 * 60 * 1000).toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
  try {
    const data = await notionQuery(NOTION_EJECUCION_DB, {
      and: [
        { property: 'Día 7 (WhatsApp)',   date:     { before: ayer } },
        { property: 'Reunión Confirmada', checkbox: { equals: false } },
        { property: 'Estado',             select:   { equals: 'En cadencia' } },
      ],
    }, 10);
    return (data.results || []).map(l => ({
      empresa: l.properties?.['Empresa']?.title?.[0]?.plain_text || 'Sin empresa',
      decisor: l.properties?.['Decisor']?.rich_text?.[0]?.plain_text || '',
    }));
  } catch { return []; }
}

// ── MRR potencial estimado ────────────────────────────────────────────────────
function calcMrrEstimado(leads) {
  let mrr = 0;
  for (const lead of leads) {
    const colabs    = parseInt((lead._colaboradores || '').split('-')[0]) || 0;
    const activacion = Math.round(colabs * 0.30);
    const potencial  = (activacion * 7) + 490;
    if (['Cerrado'].includes(lead._estado)) {
      mrr += potencial;
    } else if (lead._score === 'ALTO') {
      mrr += potencial * 0.40;
    } else if (lead._score === 'MEDIO') {
      mrr += potencial * 0.15;
    }
  }
  return Math.round(mrr);
}

// ── Stats del pipeline ────────────────────────────────────────────────────────
async function getPipelineStats() {
  const all   = await queryNotion(null);
  const leads = all.results || [];

  const hoy     = new Date().toISOString().split('T')[0];
  const ayer    = new Date(Date.now() -  1 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const hace2d  = new Date(Date.now() -  2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const hace7d  = new Date(Date.now() -  7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const hace45d = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const isMonday = new Date().toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/Lima' }) === 'Monday';

  const stats = {
    total: leads.length,
    byScore: { ALTO: 0, MEDIO: 0, BAJO: 0 },
    byEstado: {},
    cuposUsados: 0,
    leadsHoy: [],
    leadsSemana: 0,
    altoPendientes: [],
    enCierre: [],
    mrrPotencial: 0,
    mrrActual: 0,
    newLeads24h:        [],   // leads creados desde ayer
    followupPendiente:  [],   // ALTO/MEDIO + Nuevo/Contactado + >48h
    reactivacionFrios:  [],   // ALTO/MEDIO + inactivo 45d+ (solo lunes)
  };

  for (const lead of leads) {
    const score   = getProp(lead, 'Score')          || 'BAJO';
    const estado  = getProp(lead, 'Estado')         || 'Nuevo';
    const nombre  = getProp(lead, 'Nombre y Cargo') || 'Sin nombre';
    const empresa = getProp(lead, 'Empresa')        || '';
    const creado  = lead.created_time?.split('T')[0] || '';

    // Score
    if (stats.byScore[score] !== undefined) stats.byScore[score]++;

    // Estado
    stats.byEstado[estado] = (stats.byEstado[estado] || 0) + 1;

    // Leads de hoy
    if (creado === hoy) stats.leadsHoy.push({ nombre, empresa, score });

    // Leads de esta semana
    if (creado >= hace7d) stats.leadsSemana++;

    // ALTOs sin avanzar — con días transcurridos
    if (score === 'ALTO' && ['Nuevo', 'Contactado'].includes(estado)) {
      const dias = Math.floor((Date.now() - new Date(lead.created_time).getTime()) / (1000 * 60 * 60 * 24));
      stats.altoPendientes.push({ nombre, empresa, estado, dias });
    }

    // En cierre (Reunion o Propuesta)
    if (['Reunion', 'Propuesta'].includes(estado)) {
      stats.enCierre.push({ nombre, empresa, estado });
    }

    // Cupos
    if (estado === 'Cerrado') stats.cuposUsados++;

    const email = lead.properties?.['Email']?.email || '';

    // Nuevos (últimas 24h)
    if (creado >= ayer) stats.newLeads24h.push({ nombre, empresa, score, email });

    // Follow-up pendiente (ALTO/MEDIO, sin avanzar, >48h)
    if (['ALTO','MEDIO'].includes(score) && ['Nuevo','Contactado'].includes(estado) && creado <= hace2d) {
      stats.followupPendiente.push({ nombre, empresa, score, email });
    }

    // Reactivación fríos (solo lunes, 45d+ inactivos)
    if (isMonday && ['ALTO','MEDIO'].includes(score) && ['Nuevo','Contactado','Descartado'].includes(estado) && creado <= hace45d) {
      const dias = Math.floor((Date.now() - new Date(lead.created_time).getTime()) / (1000 * 60 * 60 * 24));
      stats.reactivacionFrios.push({ nombre, empresa, score, email, dias });
    }

    lead._score        = score;
    lead._estado       = estado;
    lead._colaboradores = getProp(lead, 'Colaboradores') || '';
  }

  // ALTOs ordenados por días sin contacto (más urgentes primero)
  stats.altoPendientes.sort((a, b) => b.dias - a.dias);

  stats.mrrPotencial = calcMrrEstimado(leads);
  stats.mrrActual    = calcMrrEstimado(leads.filter(l => l._estado === 'Cerrado'));

  return stats;
}

// ── Mensaje Telegram ──────────────────────────────────────────────────────────
async function sendTelegramSummary(stats, accionesHoy = [], cadenciasVencidas = [], health = {}) {
  const hoy = new Date().toLocaleDateString('es-PE', {
    weekday: 'long', day: 'numeric', month: 'long',
    timeZone: 'America/Lima'
  });

  const cuposRestantes = Math.max(0, CUPOS_TOTALES - stats.cuposUsados);
  const div = '─────────────────';

  const ESTADO_ICON = {
    'Nuevo': '🆕', 'Contactado': '📨', 'Reunion': '📅',
    'Propuesta': '📄', 'Cerrado': '✅', 'Descartado': '❌'
  };

  // ── Encabezado ──
  let msg = `☀️ *Buenos días — ${hoy}*\n${div}\n\n`;

  // ── ABM: acciones de hoy ──
  msg += `${div}\n`;
  const CANAL_ICON = { LinkedIn: '🔵', Email: '📧', WhatsApp: '📱' };
  if (accionesHoy.length) {
    msg += `📋 *ABM — Hacer hoy (${accionesHoy.length})*\n`;
    for (const a of accionesHoy) {
      msg += `${CANAL_ICON[a.canal]} ${a.canal} → *${a.empresa}*`;
      if (a.decisor) msg += ` · ${a.decisor}`;
      msg += '\n';
    }
  } else {
    msg += `📋 *ABM* · _Sin acciones programadas hoy_\n`;
  }
  msg += '\n';

  // ── Pipeline ──
  msg += `${div}\n`;
  msg += `📊 *Pipeline* · ${stats.total} leads`;
  if (stats.leadsSemana > 0) msg += ` _(+${stats.leadsSemana} esta semana)_`;
  msg += `\n`;
  msg += `🔥 ${stats.byScore.ALTO || 0} ALTO   🟡 ${stats.byScore.MEDIO || 0} MEDIO   🔵 ${stats.byScore.BAJO || 0} BAJO\n\n`;

  // Funnel
  for (const [estado, count] of Object.entries(stats.byEstado)) {
    msg += `${ESTADO_ICON[estado] || '·'} ${estado}: ${count}\n`;
  }

  // ── Cupos ──
  msg += `\n${div}\n`;
  msg += `🎯 *Fundadores Q2*   ${stats.cuposUsados} ocupados · *${cuposRestantes} disponibles*\n`;

  // ── Nuevos leads (24h) ──
  msg += `\n${div}\n`;
  if (stats.newLeads24h.length) {
    msg += `✨ *Nuevos leads (${stats.newLeads24h.length})*\n`;
    for (const l of stats.newLeads24h) {
      msg += `${SCORE_EMOJI[l.score] || '·'} ${l.nombre}${l.empresa ? ` · ${l.empresa}` : ''}\n`;
    }
  } else {
    msg += `_Sin leads nuevos en 24h_\n`;
  }

  // ── Follow-up pendiente ──
  if (stats.followupPendiente.length) {
    msg += `\n${div}\n`;
    msg += `⏰ *Follow-up pendiente (${stats.followupPendiente.length})*\n`;
    msg += `_ALTO/MEDIO sin contacto en +48h_\n`;
    for (const l of stats.followupPendiente) {
      msg += `${SCORE_EMOJI[l.score]} ${l.nombre}${l.empresa ? ` · ${l.empresa}` : ''}${l.email ? `\n   📧 ${l.email}` : ''}\n`;
    }
  }

  // ── Cadencias vencidas ──
  if (cadenciasVencidas.length) {
    msg += `\n${div}\n`;
    msg += `⚠️ *Cadencias vencidas (${cadenciasVencidas.length})*\n`;
    msg += `_D7 superado sin reunión confirmada_\n`;
    for (const c of cadenciasVencidas) {
      msg += `🏢 ${c.empresa}${c.decisor ? ` · ${c.decisor}` : ''}\n`;
    }
  }

  // ── En cierre ──
  if (stats.enCierre.length) {
    msg += `\n${div}\n`;
    msg += `🏁 *En cierre (${stats.enCierre.length})*\n`;
    for (const l of stats.enCierre) {
      msg += `${ESTADO_ICON[l.estado] || '·'} ${l.nombre} · ${l.empresa}\n`;
    }
  }

  // ── ALTOs urgentes ──
  if (stats.altoPendientes.length) {
    msg += `\n${div}\n`;
    msg += `⚡ *Acción urgente (${stats.altoPendientes.length})*\n`;
    for (const l of stats.altoPendientes) {
      const diasStr = l.dias === 0 ? 'hoy' : l.dias === 1 ? '1 día' : `${l.dias} días`;
      const urgencia = l.dias >= 3 ? '🔴' : '🟠';
      msg += `${urgencia} ${l.nombre} · ${l.empresa} · _sin contacto: ${diasStr}_\n`;
    }
  }

  // ── Reactivación semanal (solo lunes) ──
  if (stats.reactivacionFrios.length) {
    msg += `\n${div}\n`;
    msg += `♻️ *Reactivación semanal (${stats.reactivacionFrios.length})*\n`;
    msg += `_Leads ALTO/MEDIO inactivos +45 días_\n`;
    for (const l of stats.reactivacionFrios) {
      msg += `${SCORE_EMOJI[l.score]} ${l.nombre}${l.empresa ? ` · ${l.empresa}` : ''} · _${l.dias}d inactivo_\n`;
    }
  }

  // ── MRR ──
  msg += `\n${div}\n`;
  msg += `💰 MRR real: *S/ ${stats.mrrActual.toLocaleString('es-PE')}*\n`;
  msg += `📈 MRR potencial: *S/ ${stats.mrrPotencial.toLocaleString('es-PE')}*\n`;

  // ── Alerta cupos críticos ──
  if (cuposRestantes <= 3 && cuposRestantes > 0) {
    msg += `\n${div}\n`;
    msg += `⚠️ *¡ALERTA — solo quedan ${cuposRestantes} cupo${cuposRestantes === 1 ? '' : 's'}!*\n`;
    msg += `_Cierre del Programa Fundadores: ${PROGRAMA.FECHA_CIERRE}_\n`;
    msg += `Prioriza a los leads en Reunion/Propuesta hoy.\n`;
  } else if (cuposRestantes === 0) {
    msg += `\n${div}\n🎉 *Programa Fundadores COMPLETO — todos los cupos ocupados*\n`;
  }

  // ── Alertas de sistema ──
  const alertas = [];
  if (health.gmail === false) alertas.push(`⚠️ *Gmail token caducó* — renovar en OAuth Playground`);
  if (alertas.length) {
    msg += `\n${div}\n🔧 *Sistema*\n` + alertas.join('\n') + '\n';
  }

  msg += `${div}\n_Treevü · 8:00am Lima_`;

  return sendMessage(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, msg);
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const authHeader = req.headers['authorization'];
  const secret     = req.query?.secret;
  const isVercelCron = authHeader === `Bearer ${CRON_SECRET}`;
  const isManual     = secret && secret === CRON_SECRET;

  if (!isVercelCron && !isManual) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('[daily-summary] Generando resumen...');
    const [stats, accionesHoy, cadenciasVencidas, gmailOk] = await Promise.all([
      getPipelineStats(),
      getAccionesHoy(),
      getCadenciasVencidas(),
      checkGmail(),
    ]);
    const health = { gmail: gmailOk };
    if (!gmailOk) console.warn('[daily-summary] ⚠️ Gmail token inválido o ausente');
    await sendTelegramSummary(stats, accionesHoy, cadenciasVencidas, health);
    console.log(`[daily-summary] Enviado OK — ${stats.total} leads, ${accionesHoy.length} acciones ABM, ${stats.newLeads24h.length} nuevos, ${stats.followupPendiente.length} followup pendiente`);
    return res.status(200).json({ success: true, total: stats.total });
  } catch (err) {
    console.error('[daily-summary] Error:', err.message);
    captureException(err, { path: '/api/daily-summary' });
    sendMessage(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
      `⚠️ *Error en cron /api/daily-summary*\n\`${err.message}\`\n_Resumen diario no enviado_`
    ).catch(() => {});
    return res.status(500).json({ error: err.message });
  }
}
