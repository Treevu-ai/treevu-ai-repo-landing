// ── api/daily-summary.js ──────────────────────────────────────────────────────
// Cron job: resumen diario del pipeline a las 8am hora Perú (13:00 UTC)
// Configurar en vercel.json: { "crons": [{ "path": "/api/daily-summary", "schedule": "0 13 * * *" }] }
// También puede llamarse manualmente con ?secret=CRON_SECRET

const NOTION_TOKEN       = process.env.NOTION_TOKEN;
const NOTION_DATABASE_ID = "8a5cb4e6-16b9-4248-ac44-cab55c9ace6f";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET        = process.env.CRON_SECRET;

async function queryNotion(filter) {
  const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28'
    },
    body: JSON.stringify({ filter, page_size: 100 })
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

async function getPipelineStats() {
  // Traer todos los leads
  const all = await queryNotion({});
  const leads = all.results || [];

  const stats = {
    total: leads.length,
    byScore: { ALTO: 0, MEDIO: 0, BAJO: 0 },
    byEstado: {},
    cuposRestantes: 4,
    leadsHoy: [],
    altoPendientes: []
  };

  const hoy = new Date().toISOString().split('T')[0];

  for (const lead of leads) {
    const score  = getProp(lead, 'Score')  || 'BAJO';
    const estado = getProp(lead, 'Estado') || 'Nuevo';
    const nombre = getProp(lead, 'Nombre y Cargo') || 'Sin nombre';
    const empresa = getProp(lead, 'Empresa') || '';
    const creado = lead.created_time?.split('T')[0] || '';

    // Conteo por score
    if (stats.byScore[score] !== undefined) stats.byScore[score]++;
    else stats.byScore[score] = 1;

    // Conteo por estado
    stats.byEstado[estado] = (stats.byEstado[estado] || 0) + 1;

    // Leads de hoy
    if (creado === hoy) {
      stats.leadsHoy.push({ nombre, empresa, score });
    }

    // ALTOs pendientes de contactar
    if (score === 'ALTO' && ['Nuevo', 'Contactado'].includes(estado)) {
      stats.altoPendientes.push({ nombre, empresa, estado });
    }

    // Cupos usados = leads en estado Piloto activo o Firmado
    if (['Piloto activo', 'Firmado', 'Reunión agendada'].includes(estado)) {
      stats.cuposRestantes = Math.max(0, stats.cuposRestantes - 1);
    }
  }

  return stats;
}

async function sendTelegramSummary(stats) {
  const hoy = new Date().toLocaleDateString('es-PE', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'America/Lima'
  });

  let msg = `📊 *Resumen Treevü — ${hoy}*\n\n`;

  // Pipeline general
  msg += `*Pipeline total: ${stats.total} leads*\n`;
  msg += `🔥 ALTO: ${stats.byScore.ALTO || 0}  `;
  msg += `🟡 MEDIO: ${stats.byScore.MEDIO || 0}  `;
  msg += `🔵 BAJO: ${stats.byScore.BAJO || 0}\n\n`;

  // Estado del programa
  msg += `🎯 *Programa Fundadores Q2 2026*\n`;
  msg += `Cupos estimados disponibles: *${stats.cuposRestantes} de 4*\n\n`;

  // Por estado
  if (Object.keys(stats.byEstado).length) {
    msg += `*Estado del pipeline:*\n`;
    for (const [estado, count] of Object.entries(stats.byEstado)) {
      const icons = {
        'Nuevo': '🆕', 'Contactado': '📨', 'Reunión agendada': '📅',
        'En evaluación': '🔍', 'Propuesta enviada': '📄',
        'Piloto activo': '🚀', 'Firmado': '✅', 'Descartado': '❌'
      };
      msg += `${icons[estado] || '·'} ${estado}: ${count}\n`;
    }
    msg += '\n';
  }

  // Leads de hoy
  if (stats.leadsHoy.length) {
    msg += `*Nuevos leads hoy (${stats.leadsHoy.length}):*\n`;
    for (const l of stats.leadsHoy) {
      msg += `${SCORE_EMOJI[l.score] || '·'} ${l.nombre} — ${l.empresa}\n`;
    }
    msg += '\n';
  } else {
    msg += `_Sin nuevos leads hoy_\n\n`;
  }

  // ALTOs pendientes
  if (stats.altoPendientes.length) {
    msg += `⚠️ *ALTOs pendientes de acción (${stats.altoPendientes.length}):*\n`;
    for (const l of stats.altoPendientes) {
      msg += `🔥 ${l.nombre} — ${l.empresa} _(${l.estado})_\n`;
    }
    msg += '\n';
  }

  msg += `_Treevü CRM · hello@gettreevu.com_`;

  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'Markdown' })
  });

  if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text()}`);
  return res.json();
}

const SCORE_EMOJI = { ALTO: '🔥', MEDIO: '🟡', BAJO: '🔵' };

export default async function handler(req, res) {
  // Seguridad: solo GET con secret o llamada de cron de Vercel
  const authHeader = req.headers['authorization'];
  const secret = req.query?.secret;
  const isVercelCron = authHeader === `Bearer ${CRON_SECRET}`;
  const isManual = secret && secret === CRON_SECRET;

  if (!isVercelCron && !isManual) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('[daily-summary] Generando resumen del pipeline...');
    const stats = await getPipelineStats();
    await sendTelegramSummary(stats);
    console.log(`[daily-summary] Enviado OK — ${stats.total} leads`);
    return res.status(200).json({ success: true, total: stats.total });
  } catch (err) {
    console.error('[daily-summary] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
