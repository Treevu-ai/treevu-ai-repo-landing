const TELEGRAM_BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID    = process.env.TELEGRAM_CHAT_ID;
const NOTION_TOKEN        = process.env.NOTION_TOKEN;
const NOTION_DATABASE_ID  = "8a5cb4e6-16b9-4248-ac44-cab55c9ace6f";

// ── Scoring logic ─────────────────────────────────────────────────────────────
function calcScore(sector, colaboradores, objetivo) {
  let pts = 0;

  // Tamaño ideal: 100-5000
  if (['200-500','500-1000','1000-5000'].includes(colaboradores)) pts += 3;
  else if (colaboradores === '50-200') pts += 2;
  else if (colaboradores === '5000+') pts += 1;

  // Objetivo alineado al producto
  if (objetivo === 'reducir-rotacion') pts += 3;
  else if (['bienestar-financiero','mejorar-clima'].includes(objetivo)) pts += 2;
  else pts += 1;

  // Sectores prioritarios para Treevu
  if (['retail','manufactura'].includes(sector)) pts += 2;
  else if (['servicios','salud','construccion'].includes(sector)) pts += 1;

  if (pts >= 7) return 'ALTO';
  if (pts >= 4) return 'MEDIO';
  return 'BAJO';
}

const SECTOR_MAP = {
  'retail':'Retail y consumo','manufactura':'Manufactura','servicios':'Servicios',
  'salud':'Salud','tecnologia':'Tecnologia','construccion':'Construccion/Mineria',
  'educacion':'Educacion','otro':'Otro'
};
const OBJ_MAP = {
  'reducir-rotacion':'Reducir rotacion','mejorar-clima':'Mejorar clima laboral',
  'optimizar-nomina':'Optimizar nomina','bienestar-financiero':'Bienestar financiero',
  'atraccion-talento':'Atraer talento','otro':'Otro'
};
const COLAB_MAP = {
  '50-200':'50-200','200-500':'200-500','500-1000':'500-1000',
  '1000-5000':'1000-5000','5000+':'5000+'
};
const SCORE_ICON = { 'ALTO': 'ALTO', 'MEDIO': 'MEDIO', 'BAJO': 'BAJO' };
const SCORE_EMOJI = { 'ALTO': '🔥', 'MEDIO': '🟡', 'BAJO': '🔵' };

async function saveToNotion({ nombre, email, empresa, sector, colaboradores, objetivo, problema, score }) {
  const body = {
    parent: { database_id: NOTION_DATABASE_ID },
    properties: {
      "Nombre y Cargo": { title: [{ text: { content: nombre } }] },
      "Email":          { email: email },
      "Empresa":        { rich_text: [{ text: { content: empresa } }] },
      "Sector":         { select: { name: SECTOR_MAP[sector] || 'Otro' } },
      "Colaboradores":  { select: { name: COLAB_MAP[colaboradores] || colaboradores } },
      "Objetivo":       { select: { name: OBJ_MAP[objetivo] || 'Otro' } },
      "Score":          { select: { name: score } },
      "Estado":         { select: { name: 'Nuevo' } }
    }
  };
  if (problema) {
    body.properties["Reto libre"] = { rich_text: [{ text: { content: problema } }] };
  }
  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Notion ${res.status}: ${await res.text()}`);
  return res.json();
}

async function sendToTelegram({ nombre, email, empresa, sector, colaboradores, objetivo, problema, score }) {
  const scoreEmoji = SCORE_EMOJI[score] || '';
  const accion = score === 'ALTO' ? 'Contactar HOY' : score === 'MEDIO' ? 'Contactar esta semana' : 'Evaluar con calma';

  const msg = `${scoreEmoji} *Nuevo Lead Fundador — Treevü*\n\n`
    + `*Score: ${score}* — ${accion}\n\n`
    + `👤 *${nombre}*\n`
    + `📧 ${email}\n`
    + `🏢 ${empresa}\n`
    + `🏭 ${SECTOR_MAP[sector] || sector}\n`
    + `👥 ${colaboradores} colaboradores\n`
    + `🎯 ${OBJ_MAP[objetivo] || objetivo}`
    + (problema ? `\n💬 _${problema}_` : '')
    + `\n\n_Registrado en Notion CRM_`;

  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'Markdown' })
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}`);
  return res.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { nombre, email, empresa, sector, colaboradores, objetivo, problema } = req.body || {};

  if (!nombre || !email || !empresa || !sector || !colaboradores || !objetivo) {
    return res.status(400).json({ error: 'Campos requeridos faltantes' });
  }

  const score = calcScore(sector, colaboradores, objetivo);

  const [notionResult, telegramResult] = await Promise.allSettled([
    saveToNotion({ nombre, email, empresa, sector, colaboradores, objetivo, problema, score }),
    sendToTelegram({ nombre, email, empresa, sector, colaboradores, objetivo, problema, score })
  ]);

  if (notionResult.status === 'rejected') console.error('Notion error:', notionResult.reason);
  if (telegramResult.status === 'rejected') console.error('Telegram error:', telegramResult.reason);

  if (notionResult.status === 'rejected' && telegramResult.status === 'rejected') {
    return res.status(500).json({ error: 'Error al procesar solicitud' });
  }

  return res.status(200).json({ success: true, score });
}
