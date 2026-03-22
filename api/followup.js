// ── api/followup.js ───────────────────────────────────────────────────────────
// Cron job: detecta leads ALTO/MEDIO sin respuesta en 48h y notifica por Telegram
// Schedule: "0 14 * * *" (9am Lima, 14:00 UTC)

const NOTION_TOKEN       = process.env.NOTION_TOKEN;
const NOTION_DATABASE_ID = "8a5cb4e6-16b9-4248-ac44-cab55c9ace6f";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET        = process.env.CRON_SECRET;

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

async function sendFollowupAlert(leads) {
  if (!leads.length) {
    console.log('[followup] Sin leads pendientes de seguimiento');
    return;
  }

  let msg = `⏰ *Seguimiento pendiente — Treevü*\n`;
  msg += `_${leads.length} lead(s) sin respuesta en +48h_\n\n`;

  for (const lead of leads) {
    const score   = getProp(lead, 'Score') || 'MEDIO';
    const nombre  = getProp(lead, 'Nombre y Cargo') || 'Sin nombre';
    const empresa = getProp(lead, 'Empresa') || '';
    const email   = getProp(lead, 'Email') || '';
    const estado  = getProp(lead, 'Estado') || 'Nuevo';
    const creado  = new Date(lead.created_time).toLocaleDateString('es-PE', { timeZone: 'America/Lima' });
    const emoji   = score === 'ALTO' ? '🔥' : '🟡';

    msg += `${emoji} *${nombre}*\n`;
    msg += `🏢 ${empresa}\n`;
    msg += `📧 ${email}\n`;
    msg += `📅 Registrado: ${creado} · Estado: ${estado}\n\n`;
  }

  msg += `💡 _Responde pronto — los leads se enfrían rápido._`;

  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'Markdown' })
  });

  if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text()}`);
  return res.json();
}

export default async function handler(req, res) {
  const authHeader = req.headers['authorization'];
  const secret = req.query?.secret;
  const isVercelCron = authHeader === `Bearer ${CRON_SECRET}`;
  const isManual = secret && secret === CRON_SECRET;

  if (!isVercelCron && !isManual) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('[followup] Buscando leads sin seguimiento...');
    const leads = await getLeadsPendingFollowup();
    await sendFollowupAlert(leads);
    console.log(`[followup] OK — ${leads.length} leads pendientes`);
    return res.status(200).json({ success: true, pendientes: leads.length });
  } catch (err) {
    console.error('[followup] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
