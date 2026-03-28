// ── api/followup.js ───────────────────────────────────────────────────────────
// Cron job: detecta leads ALTO/MEDIO sin respuesta en 48h y alerta
// Schedule: "0 14 * * *" (9am Lima = 14:00 UTC)
// Fuente: Supabase primero, fallback a Notion

import { sbSelect, logEvent } from '../lib/supabase.js';
import { queryNotionDB, getProp } from '../lib/notion.js';
import { sendTelegram }           from '../lib/telegram.js';

const CRON_SECRET = process.env.CRON_SECRET;

// ── Leads pendientes desde Supabase ──────────────────────────────────────────
async function getLeadsPendingFromSupabase() {
  const hace48h = new Date(Date.now() - 48 * 3600000).toISOString();
  return sbSelect('leads', {
    filters: {
      updated_at: `lte.${hace48h}`,
      score:      'in.(ALTO,MEDIO)',
      estado:     'in.(Nuevo,Contactado)'
    },
    select: 'id,email,nombre,empresa,sector,score,probabilidad,estado,created_at',
    order:  'score.desc,created_at.asc',
    limit:  20
  });
}

// ── Fallback desde Notion ────────────────────────────────────────────────────
async function getLeadsPendingFromNotion() {
  const hace48h = new Date(Date.now() - 48 * 3600000).toISOString();
  const data = await queryNotionDB({
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
  return (data.results || []).map(p => ({
    email:   getProp(p, 'Email'),
    nombre:  getProp(p, 'Nombre y Cargo') || 'Sin nombre',
    empresa: getProp(p, 'Empresa')        || '',
    score:   getProp(p, 'Score')          || 'MEDIO',
    estado:  getProp(p, 'Estado')         || 'Nuevo',
    created_at: p.created_time,
    source: 'notion'
  }));
}

// ── Alerta Telegram ───────────────────────────────────────────────────────────
async function sendFollowupAlert(leads) {
  if (!leads.length) {
    console.log('[followup] Sin leads pendientes');
    return;
  }

  let msg = `⏰ *Seguimiento pendiente — Treevü*\n`;
  msg += `_${leads.length} lead(s) sin respuesta en +48h_\n\n`;

  for (const lead of leads) {
    const emoji  = lead.score === 'ALTO' ? '🔥' : '🟡';
    const creado = new Date(lead.created_at).toLocaleDateString('es-PE', { timeZone: 'America/Lima' });
    msg += `${emoji} *${lead.nombre}*\n`;
    msg += `🏢 ${lead.empresa}\n`;
    msg += `📧 ${lead.email}\n`;
    msg += `📅 ${creado} · Estado: ${lead.estado}`;
    if (lead.probabilidad) msg += ` · ${lead.probabilidad}% prob.`;
    msg += `\n\n`;
  }

  msg += `💡 Acciones rápidas:\n`;
  msg += `\`/reunion <email>\` — briefing\n`;
  msg += `\`/nextstep <email> <acción>\` — registrar contacto`;

  await sendTelegram(msg);
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const authHeader   = req.headers['authorization'];
  const secret       = req.query?.secret;
  const isVercelCron = authHeader === `Bearer ${CRON_SECRET}`;
  const isManual     = secret && secret === CRON_SECRET;

  if (!isVercelCron && !isManual) return res.status(401).json({ error: 'Unauthorized' });

  try {
    console.log('[followup] Buscando leads pendientes...');

    let leads = [];
    let source = 'supabase';
    try {
      leads = await getLeadsPendingFromSupabase() || [];
    } catch (err) {
      console.warn('[followup] Supabase falló, usando Notion:', err.message);
      leads  = await getLeadsPendingFromNotion();
      source = 'notion';
    }

    await sendFollowupAlert(leads);

    // Log evento para auditoría
    if (leads.length && source === 'supabase') {
      for (const l of leads) {
        logEvent(l.email, 'followup_alert_sent', { days_pending: Math.floor((Date.now() - new Date(l.created_at)) / 86400000) },
          { leadId: l.id }).catch(() => {});
      }
    }

    console.log(`[followup] OK — ${leads.length} pendientes (${source})`);
    return res.status(200).json({ success: true, pendientes: leads.length, source });
  } catch (err) {
    console.error('[followup] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
