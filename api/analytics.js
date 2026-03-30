// api/analytics.js — Analytics de pipeline por canal, score y estado
//
// GET /api/analytics?secret=CRON_SECRET          → JSON con métricas
// GET /api/analytics?secret=CRON_SECRET&notify=1 → también envía resumen a Telegram
//
// Agrega todos los leads del CRM Notion y devuelve:
//   bySource, byScore, byEstado, conversionFunnel, leadsPerWeek, topSectors, mrrEstimado

import { NOTION, SCORE_EMOJI, ESTADO_EMOJI } from './lib/constants.js';
import { getProp, notionQuery }              from './lib/notion.js';
import { sendMessage }                       from './lib/telegram.js';
import { captureException }                  from './lib/sentry.js';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_ABM_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET        = process.env.CRON_SECRET;

// ── Fetch all leads (paginado) ────────────────────────────────────────────────
async function fetchAllLeads() {
  const leads = [];
  let cursor = null;
  do {
    const data = await notionQuery(NOTION.CRM_DB, null, 100, null, cursor);
    leads.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return leads;
}

// ── MRR estimado ─────────────────────────────────────────────────────────────
function estimateMrr(colabs, score, estado) {
  const n = parseInt((colabs || '').split('-')[0].replace('+', '')) || 0;
  if (!n) return 0;
  const mrr = (Math.round(n * 0.30) * 7) + 490;
  if (estado === 'Cerrado')    return mrr;
  if (score === 'ALTO')        return mrr * 0.40;
  if (score === 'MEDIO')       return mrr * 0.15;
  return 0;
}

// ── Aggregation ───────────────────────────────────────────────────────────────
function aggregate(leads) {
  const now    = Date.now();
  const D7     = now - 7  * 86400000;
  const D30    = now - 30 * 86400000;

  const bySource  = {};
  const byScore   = { ALTO: 0, MEDIO: 0, BAJO: 0 };
  const byEstado  = {};
  const bySector  = {};
  const weekBuckets = {}; // ISO week → count
  let mrrPotencial = 0;
  let mrrActual    = 0;
  let leadsLast7   = 0;
  let leadsLast30  = 0;

  for (const lead of leads) {
    const source   = getProp(lead, 'Fuente')         || 'Desconocido';
    const score    = getProp(lead, 'Score')          || 'BAJO';
    const estado   = getProp(lead, 'Estado')         || 'Nuevo';
    const sector   = getProp(lead, 'Sector')         || 'Otro';
    const colabs   = getProp(lead, 'Colaboradores')  || '';
    const createdMs = new Date(lead.created_time).getTime();

    bySource[source]  = (bySource[source]  || 0) + 1;
    byEstado[estado]  = (byEstado[estado]  || 0) + 1;
    bySector[sector]  = (bySector[sector]  || 0) + 1;
    if (byScore[score] !== undefined) byScore[score]++;

    mrrPotencial += estimateMrr(colabs, score, estado);
    if (estado === 'Cerrado') mrrActual += estimateMrr(colabs, score, estado);

    if (createdMs >= D7)  leadsLast7++;
    if (createdMs >= D30) leadsLast30++;

    // Weekly buckets (last 8 weeks)
    if (createdMs >= now - 56 * 86400000) {
      const d    = new Date(lead.created_time);
      const week = `${d.getFullYear()}-W${String(Math.ceil((d - new Date(d.getFullYear(), 0, 1)) / 604800000)).padStart(2,'0')}`;
      weekBuckets[week] = (weekBuckets[week] || 0) + 1;
    }
  }

  // Funnel conversion rates
  const total    = leads.length;
  const enCierre = (byEstado['Reunion'] || 0) + (byEstado['Propuesta'] || 0) + (byEstado['Cerrado'] || 0);
  const cerrados = byEstado['Cerrado'] || 0;

  const conversionFunnel = {
    total,
    contactados:    byEstado['Contactado'] || 0,
    enCierre,
    cerrados,
    tasaContacto:   total ? Math.round((total - (byEstado['Nuevo'] || 0)) / total * 100) : 0,
    tasaCierre:     total ? Math.round(enCierre / total * 100) : 0,
    tasaConversion: total ? Math.round(cerrados / total * 100) : 0,
  };

  // Top 5 sources by count
  const topSources = total === 0 ? [] : Object.entries(bySource)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([source, count]) => ({ source, count, pct: Math.round(count / total * 100) }));

  // Top 5 sectors
  const topSectors = Object.entries(bySector)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([sector, count]) => ({ sector, count }));

  // Weekly trend sorted
  const leadsPerWeek = Object.entries(weekBuckets)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([week, count]) => ({ week, count }));

  return {
    total,
    byScore,
    byEstado,
    topSources,
    topSectors,
    conversionFunnel,
    leadsPerWeek,
    leadsLast7,
    leadsLast30,
    mrrPotencial: Math.round(mrrPotencial),
    mrrActual:    Math.round(mrrActual),
  };
}

// ── Telegram report ───────────────────────────────────────────────────────────
async function sendAnalyticsReport(stats) {
  const div = '─────────────────';
  let msg = `📊 *Analytics Treevü*\n${div}\n\n`;

  // Pipeline overview
  msg += `*Pipeline total: ${stats.total} leads*\n`;
  msg += `📅 Últimos 7 días: +${stats.leadsLast7} · Últimos 30d: +${stats.leadsLast30}\n\n`;

  // Score distribution
  msg += `*Score*\n`;
  msg += `🔥 ALTO: ${stats.byScore.ALTO}  🟡 MEDIO: ${stats.byScore.MEDIO}  🔵 BAJO: ${stats.byScore.BAJO}\n\n`;

  // Funnel
  const f = stats.conversionFunnel;
  msg += `*Funnel de conversión*\n`;
  msg += `· Contactados: ${f.tasaContacto}%\n`;
  msg += `· En cierre (Reunión+Propuesta+Cerrado): ${f.enCierre} (${f.tasaCierre}%)\n`;
  msg += `· Cerrados: ${f.cerrados} (${f.tasaConversion}%)\n\n`;

  // Top sources
  msg += `${div}\n*Top canales*\n`;
  for (const s of stats.topSources) {
    msg += `· ${s.source}: ${s.count} (${s.pct}%)\n`;
  }
  msg += '\n';

  // Top sectors
  msg += `*Top sectores*\n`;
  for (const s of stats.topSectors) {
    msg += `· ${s.sector}: ${s.count}\n`;
  }
  msg += '\n';

  // MRR
  msg += `${div}\n`;
  msg += `💰 MRR real: *S/ ${stats.mrrActual.toLocaleString('es-PE')}*\n`;
  msg += `📈 MRR potencial pipeline: *S/ ${stats.mrrPotencial.toLocaleString('es-PE')}*\n`;

  // Estado funnel
  msg += `\n${div}\n*Estado del pipeline*\n`;
  const ESTADO_ORDER = ['Nuevo','Contactado','Reunion','Propuesta','Cerrado','Descartado'];
  for (const estado of ESTADO_ORDER) {
    const count = stats.byEstado[estado];
    if (count) msg += `${ESTADO_EMOJI[estado] || '·'} ${estado}: ${count}\n`;
  }

  // Weekly trend (last 4 weeks)
  const recentWeeks = stats.leadsPerWeek.slice(-4);
  if (recentWeeks.length) {
    msg += `\n${div}\n*Tendencia semanal*\n`;
    for (const w of recentWeeks) {
      const bar = '█'.repeat(Math.min(w.count, 10));
      msg += `${w.week}: ${bar} ${w.count}\n`;
    }
  }

  msg += `\n${div}\n_Treevü Analytics · ${new Date().toLocaleDateString('es-PE', { timeZone: 'America/Lima' })}_`;

  return sendMessage(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, msg);
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://gettreevu.com');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers['authorization'];
  const secret     = req.query?.secret;
  if (authHeader !== `Bearer ${CRON_SECRET}` && secret !== CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('[analytics] Generando analytics...');
    const leads = await fetchAllLeads();
    const stats = aggregate(leads);

    if (req.query?.notify === '1') {
      await sendAnalyticsReport(stats);
      console.log('[analytics] Reporte Telegram enviado');
    }

    console.log(`[analytics] OK — ${stats.total} leads procesados`);
    return res.status(200).json({ success: true, ...stats });
  } catch (err) {
    console.error('[analytics] Error:', err.message);
    captureException(err, { path: '/api/analytics' });
    return res.status(500).json({ error: err.message });
  }
}
