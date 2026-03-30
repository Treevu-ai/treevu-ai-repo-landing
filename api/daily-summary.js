// ── api/daily-summary.js ──────────────────────────────────────────────────────
// Cron job: resumen diario del pipeline a las 8am hora Perú (13:00 UTC)
// Configurar en vercel.json: { "crons": [{ "path": "/api/daily-summary", "schedule": "0 13 * * *" }] }
// También puede llamarse manualmente con ?secret=CRON_SECRET

const NOTION_TOKEN        = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID  = "2e5f06c0295b46fbbc212bac5f6fcb3c";
const NOTION_EJECUCION_DB = "bcebf14878f04db087f052722f9a084d";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_ABM_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET        = process.env.CRON_SECRET;
const CALENDLY_TOKEN     = process.env.CALENDLY_TOKEN;
const CUPOS_TOTALES      = 10;

const SCORE_EMOJI = { ALTO: '🔥', MEDIO: '🟡', BAJO: '🔵' };

// ── Notion ────────────────────────────────────────────────────────────────────
async function queryNotion(filter) {
  const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28'
    },
    body: JSON.stringify(filter ? { filter, page_size: 100 } : { page_size: 100 })
  });
  if (!res.ok) throw new Error(`Notion ${res.status}: ${await res.text()}`);
  return res.json();
}

function getProp(page, name) {
  const prop = page.properties?.[name];
  if (!prop) return null;
  if (prop.type === 'select')    return prop.select?.name || null;
  if (prop.type === 'title')     return prop.title?.[0]?.plain_text || null;
  if (prop.type === 'rich_text') return prop.rich_text?.[0]?.plain_text || null;
  if (prop.type === 'email')     return prop.email || null;
  if (prop.type === 'number')    return prop.number ?? null;
  return null;
}

// ── Calendly: reuniones de hoy ────────────────────────────────────────────────
async function getCalendlyEventsToday() {
  if (!CALENDLY_TOKEN) return [];
  try {
    // Extraer user_uuid del JWT sin llamar /users/me
    const payload = JSON.parse(Buffer.from(CALENDLY_TOKEN.split('.')[1], 'base64').toString('utf8'));
    const userUri = `https://api.calendly.com/users/${payload.user_uuid}`;

    // Rango del día en Lima (UTC-5)
    const todayLima = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
    const minStart  = encodeURIComponent(`${todayLima}T00:00:00-05:00`);
    const maxStart  = encodeURIComponent(`${todayLima}T23:59:59-05:00`);

    const res = await fetch(
      `https://api.calendly.com/scheduled_events?user=${encodeURIComponent(userUri)}&min_start_time=${minStart}&max_start_time=${maxStart}&status=active&count=10`,
      { headers: { 'Authorization': `Bearer ${CALENDLY_TOKEN}` } }
    );
    if (!res.ok) return [];

    const data = await res.json();
    const eventos = [];

    for (const event of data.collection || []) {
      const uuid = event.uri.split('/').pop();

      // Obtener nombre del invitado
      let invitado = '';
      const invRes = await fetch(
        `https://api.calendly.com/scheduled_events/${uuid}/invitees?count=1`,
        { headers: { 'Authorization': `Bearer ${CALENDLY_TOKEN}` } }
      );
      if (invRes.ok) {
        const invData = await invRes.json();
        invitado = invData.collection?.[0]?.name || '';
      }

      const hora = new Date(event.start_time).toLocaleTimeString('es-PE', {
        hour: '2-digit', minute: '2-digit', timeZone: 'America/Lima'
      });

      eventos.push({ hora, invitado, tipo: event.name || 'Reunión' });
    }

    return eventos.sort((a, b) => a.hora.localeCompare(b.hora));
  } catch (err) {
    console.error('[daily-summary] Calendly error:', err.message);
    return [];
  }
}

// ── ABM: acciones de hoy (Ejecución 14 días) ─────────────────────────────────
async function getAccionesHoy() {
  if (!NOTION_TOKEN) return [];
  const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
  try {
    const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_EJECUCION_DB}/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
      body: JSON.stringify({
        filter: {
          or: [
            { property: 'Día 1 (LinkedIn)', date: { equals: hoy } },
            { property: 'Día 3 (Email)',    date: { equals: hoy } },
            { property: 'Día 7 (WhatsApp)', date: { equals: hoy } },
          ],
        },
        page_size: 100,
      }),
    });
    if (!res.ok) return [];
    const data = await res.json();

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

  const hoy    = new Date().toISOString().split('T')[0];
  const hace7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  const stats = {
    total: leads.length,
    byScore: { ALTO: 0, MEDIO: 0, BAJO: 0 },
    byEstado: {},
    cuposUsados: 0,
    leadsHoy: [],
    leadsSemana: 0,
    altoPendientes: [],   // { nombre, empresa, estado, dias }
    enCierre: [],         // { nombre, empresa, estado }
    mrrPotencial: 0,
    mrrActual: 0,
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
async function sendTelegramSummary(stats, reuniones, accionesHoy = []) {
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

  // ── Reuniones de hoy ──
  msg += `📅 *Reuniones hoy*\n`;
  if (reuniones.length) {
    for (const r of reuniones) {
      msg += `· ${r.hora} — ${r.invitado || r.tipo}\n`;
    }
  } else {
    msg += `_Sin reuniones agendadas_\n`;
  }
  msg += '\n';

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

  // ── Nuevos hoy ──
  msg += `\n${div}\n`;
  if (stats.leadsHoy.length) {
    msg += `✨ *Nuevos hoy (${stats.leadsHoy.length})*\n`;
    for (const l of stats.leadsHoy) {
      msg += `${SCORE_EMOJI[l.score] || '·'} ${l.nombre} · ${l.empresa}\n`;
    }
  } else {
    msg += `_Sin leads nuevos hoy_\n`;
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

  // ── MRR ──
  msg += `\n${div}\n`;
  msg += `💰 MRR real: *S/ ${stats.mrrActual.toLocaleString('es-PE')}*\n`;
  msg += `📈 MRR potencial: *S/ ${stats.mrrPotencial.toLocaleString('es-PE')}*\n`;
  msg += `${div}\n_Treevü · 8:00am Lima_`;

  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'Markdown' })
  });

  if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text()}`);
  return res.json();
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
    const [stats, reuniones, accionesHoy] = await Promise.all([
      getPipelineStats(),
      getCalendlyEventsToday(),
      getAccionesHoy(),
    ]);
    await sendTelegramSummary(stats, reuniones, accionesHoy);
    console.log(`[daily-summary] Enviado OK — ${stats.total} leads, ${reuniones.length} reuniones, ${accionesHoy.length} acciones ABM hoy`);
    return res.status(200).json({ success: true, total: stats.total, reuniones: reuniones.length });
  } catch (err) {
    console.error('[daily-summary] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
