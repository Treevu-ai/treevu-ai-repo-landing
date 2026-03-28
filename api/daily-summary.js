// ── api/daily-summary.js ──────────────────────────────────────────────────────
// Cron job: resumen diario del pipeline a las 8am Lima (13:00 UTC)
// Fuente primaria: Supabase (métricas reales) | Fallback: Notion

import { getPipelineMetrics, sbSelect } from '../lib/supabase.js';
import { queryNotionDB, getProp }       from '../lib/notion.js';
import { sendTelegram }                 from '../lib/telegram.js';

const CRON_SECRET = process.env.CRON_SECRET;

const SCORE_EMOJI = { ALTO: '🔥', MEDIO: '🟡', BAJO: '🔵' };

// ── Resumen desde Supabase ────────────────────────────────────────────────────
async function buildSummaryFromSupabase() {
  const m = await getPipelineMetrics();
  if (!m) return null;

  const hoy = new Date().toISOString().split('T')[0];
  const leadsHoy = await sbSelect('leads', {
    filters: { created_at: `gte.${hoy}T00:00:00.000Z` },
    select: 'nombre,empresa,score',
    limit: 20
  }).catch(() => []);

  const altoPendientes = await sbSelect('leads', {
    filters: {
      score:  'eq.ALTO',
      estado: 'in.(Nuevo,Contactado)'
    },
    select: 'nombre,empresa,estado',
    limit:  10
  }).catch(() => []);

  return { ...m, leadsHoy: leadsHoy || [], altoPendientes: altoPendientes || [], source: 'supabase' };
}

// ── Fallback desde Notion ─────────────────────────────────────────────────────
async function buildSummaryFromNotion() {
  const all    = await queryNotionDB({});
  const leads  = all.results || [];
  const hoy    = new Date().toISOString().split('T')[0];

  const stats = {
    total:           leads.length,
    byScore:         { ALTO: 0, MEDIO: 0, BAJO: 0 },
    byEstado:        {},
    leadsHoy:        [],
    altoPendientes:  [],
    source:          'notion'
  };

  for (const lead of leads) {
    const score   = getProp(lead, 'Score')          || 'BAJO';
    const estado  = getProp(lead, 'Estado')         || 'Nuevo';
    const nombre  = getProp(lead, 'Nombre y Cargo') || 'Sin nombre';
    const empresa = getProp(lead, 'Empresa')        || '';
    const creado  = lead.created_time?.split('T')[0] || '';

    stats.byScore[score] = (stats.byScore[score] || 0) + 1;
    stats.byEstado[estado] = (stats.byEstado[estado] || 0) + 1;

    if (creado === hoy) stats.leadsHoy.push({ nombre, empresa, score });
    if (score === 'ALTO' && ['Nuevo','Contactado'].includes(estado)) {
      stats.altoPendientes.push({ nombre, empresa, estado });
    }
  }

  return stats;
}

// ── Construir mensaje Telegram ────────────────────────────────────────────────
function buildMessage(stats) {
  const hoy = new Date().toLocaleDateString('es-PE', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'America/Lima'
  });
  const sourceTag = stats.source === 'supabase' ? '📊 Supabase' : '🗂 Notion';

  let msg = `📊 *Resumen Treevü — ${hoy}*\n_${sourceTag}_\n\n`;

  // Pipeline
  msg += `*Pipeline total: ${stats.total} leads*\n`;
  msg += `🔥 ALTO: ${stats.byScore?.ALTO || 0}  `;
  msg += `🟡 MEDIO: ${stats.byScore?.MEDIO || 0}  `;
  msg += `🔵 BAJO: ${stats.byScore?.BAJO || 0}\n\n`;

  // Métricas de conversión (solo Supabase)
  if (stats.source === 'supabase') {
    msg += `*Conversión:*\n`;
    msg += `📈 Lead → Reunión: ${stats.convLeadToMeeting}%\n`;
    msg += `🏆 Win rate: ${stats.winRate}%\n`;
    msg += `⏱ Tiempo promedio lead→reunión: ${stats.avgDaysToMeeting} días\n\n`;
  }

  // Estado del pipeline
  if (stats.byEstado && Object.keys(stats.byEstado).length) {
    msg += `*Estado del pipeline:*\n`;
    const iconos = {
      'Nuevo': '🆕', 'Contactado': '📨', 'Reunión agendada': '📅',
      'En evaluación': '🔍', 'Propuesta enviada': '📄',
      'Piloto activo': '🚀', 'Firmado': '✅', 'Descartado': '❌'
    };
    for (const [estado, count] of Object.entries(stats.byEstado)) {
      msg += `${iconos[estado] || '·'} ${estado}: ${count}\n`;
    }
    msg += '\n';
  }

  // Leads de hoy
  if (stats.leadsHoy?.length) {
    msg += `*Nuevos leads hoy (${stats.leadsHoy.length}):*\n`;
    for (const l of stats.leadsHoy) {
      msg += `${SCORE_EMOJI[l.score] || '·'} ${l.nombre} — ${l.empresa}\n`;
    }
    msg += '\n';
  } else {
    msg += `_Sin nuevos leads hoy_\n\n`;
  }

  // ALTOs pendientes
  if (stats.altoPendientes?.length) {
    msg += `⚠️ *ALTOs sin acción (${stats.altoPendientes.length}):*\n`;
    for (const l of stats.altoPendientes) {
      msg += `🔥 ${l.nombre} — ${l.empresa} _(${l.estado})_\n`;
    }
    msg += '\n';
  }

  msg += `💡 Comandos: /pipeline /stats /reunion /resultado\n`;
  msg += `_Treevü Revenue Engine · hello@gettreevu.com_`;
  return msg;
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const authHeader   = req.headers['authorization'];
  const secret       = req.query?.secret;
  const isVercelCron = authHeader === `Bearer ${CRON_SECRET}`;
  const isManual     = secret && secret === CRON_SECRET;

  if (!isVercelCron && !isManual) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('[daily-summary] Generando resumen...');

    let stats;
    try {
      stats = await buildSummaryFromSupabase();
    } catch (err) {
      console.warn('[daily-summary] Supabase falló, usando Notion:', err.message);
    }
    if (!stats) stats = await buildSummaryFromNotion();

    const msg = buildMessage(stats);
    await sendTelegram(msg);

    console.log(`[daily-summary] OK — ${stats.total} leads (${stats.source})`);
    return res.status(200).json({ success: true, total: stats.total, source: stats.source });
  } catch (err) {
    console.error('[daily-summary] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
