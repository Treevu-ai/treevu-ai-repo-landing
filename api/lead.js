/**
 * api/lead.js — AsisTreevü CRM unificado
 * Recibe leads de todos los canales y los escribe en Notion.
 *
 * Canales que llaman este endpoint:
 *  - api/submit.js        → formulario web gettreevu.com
 *  - api/chat.js          → chat Vü en la web
 *  - api/telegram.js      → bot público @treevubot
 *
 * Protegido por x-webhook-secret (LEAD_WEBHOOK_SECRET)
 */

const NOTION_TOKEN        = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;
const NOTION_DATABASE_ID  = '2e5f06c0295b46fbbc212bac5f6fcb3c'; // CRM unificado
const NOTION_EJECUCION_DB = 'bcebf14878f04db087f052722f9a084d'; // Ejecución 14 días
const WEBHOOK_SECRET      = process.env.LEAD_WEBHOOK_SECRET;
const TELEGRAM_TOKEN      = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID    = process.env.TELEGRAM_ABM_CHAT_ID;

// ── Scoring fallback (cuando el canal no envía score) ─────────────────────────
function calcScore(sector, employees, objetivo) {
  let pts = 0;
  const emp = String(employees || '');
  if (['200-500','500-1000','1000-5000'].includes(emp)) pts += 3;
  else if (emp === '50-200') pts += 2;
  else if (emp === '5000+')  pts += 1;
  if (['reducir-rotacion','Reducir rotacion'].includes(objetivo))       pts += 3;
  else if (['bienestar-financiero','Bienestar financiero',
             'mejorar-clima','Mejorar clima laboral'].includes(objetivo)) pts += 2;
  else pts += 1;
  if (['retail','Retail y consumo','manufactura','Manufactura',
       'banca','Banca y finanzas','Banca/Finanzas'].includes(sector))    pts += 2;
  else if (sector) pts += 1;
  if (pts >= 7) return 'ALTO';
  if (pts >= 4) return 'MEDIO';
  return 'BAJO';
}

// ── Notion ────────────────────────────────────────────────────────────────────
async function saveToNotion({ name, email, company, role, sector, employees, objetivo, message, source, score, probability, telegramChatId }) {
  const nombreCargo = role ? `${name}, ${role}` : name;
  const scoreVal    = score || calcScore(sector, employees, objetivo);

  const properties = {
    'Nombre y Cargo': { title:     [{ text: { content: nombreCargo || 'Sin nombre' } }] },
    'Email':          { email:     email || null },
    'Empresa':        { rich_text: [{ text: { content: company   || '' } }] },
    'Score':          { select:    { name: scoreVal } },
    'Estado':         { select:    { name: 'Nuevo' } },
  };

  if (sector)    properties['Sector']        = { select: { name: sector } };
  if (employees) properties['Colaboradores'] = { select: { name: employees } };
  if (objetivo)  properties['Objetivo']      = { select: { name: objetivo } };
  if (source)    properties['Fuente']        = { rich_text: [{ text: { content: source } }] };
  if (typeof probability === 'number') properties['Probabilidad'] = { number: probability };
  const notaContent = [
    message || '',
    telegramChatId ? `[tg:${telegramChatId}]` : '',
  ].filter(Boolean).join(' ');
  if (notaContent) properties['Notas'] = { rich_text: [{ text: { content: notaContent.slice(0, 2000) } }] };

  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      'Authorization':  `Bearer ${NOTION_TOKEN}`,
      'Content-Type':   'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: JSON.stringify({ parent: { database_id: NOTION_DATABASE_ID }, properties }),
  });

  if (!res.ok) throw new Error(`Notion ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── Cross-reference: ¿empresa ya en pipeline outbound? ───────────────────────
async function checkEjecucionMatch(company) {
  if (!company || !NOTION_TOKEN) return null;
  try {
    const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_EJECUCION_DB}/query`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
      body: JSON.stringify({ filter: { property: 'Empresa', title: { contains: company } }, page_size: 1 }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.results?.[0] || null;
  } catch { return null; }
}

async function notifyMatch(company, matchPage, inboundName, inboundEmail) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  const estado  = matchPage.properties?.['Estado']?.select?.name || '';
  const decisor = matchPage.properties?.['Decisor']?.rich_text?.[0]?.plain_text || '';
  const d7      = matchPage.properties?.['Día 7 (WhatsApp)']?.date?.start || '';
  let msg = `⚠️ *MATCH inbound × outbound*\n\n`;
  msg += `🏢 *${company}* ya está en tu pipeline ABM\n`;
  if (estado)  msg += `📌 Estado outbound: ${estado}\n`;
  if (decisor) msg += `👤 Decisor ABM: ${decisor}\n`;
  if (d7)      msg += `📅 D7 programado: ${d7}\n`;
  msg += `\n📥 Nuevo inbound: ${inboundName || 'Sin nombre'}`;
  if (inboundEmail) msg += ` · ${inboundEmail}`;
  msg += `\n\n_¿Coordinar acciones para no duplicar contacto?_`;

  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'Markdown' }),
  }).catch(err => console.error('[lead] telegram match error:', err.message));
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-webhook-secret');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  // Autenticación
  const secret = req.headers['x-webhook-secret'];
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
    console.warn('[lead] Intento sin secret válido');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { name, email, company, role, sector, employees, objetivo, message, source, score, probability, telegramChatId } = req.body || {};

  if (!name || !email) {
    return res.status(400).json({ error: 'name y email son requeridos' });
  }

  console.log(`[lead] Entrante: ${company || 'sin empresa'} | ${source || 'canal desconocido'}`);

  try {
    const [page, matchPage] = await Promise.all([
      saveToNotion({ name, email, company, role, sector, employees, objetivo, message, source, score, probability, telegramChatId }),
      checkEjecucionMatch(company),
    ]);
    console.log(`[lead] Notion OK — ${name} (${source})`);
    if (matchPage) {
      console.log(`[lead] Match outbound encontrado para: ${company}`);
      notifyMatch(company, matchPage, name, email).catch(() => {});
    }
    return res.status(200).json({ success: true, notionId: page.id });
  } catch (err) {
    console.error('[lead] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
