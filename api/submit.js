export const config = { runtime: 'edge' };

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const NOTION_TOKEN       = process.env.NOTION_TOKEN;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json' }
    });
  }

  const origin = req.headers.get('origin') || '';
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: corsHeaders
    });
  }

  const { nombre, email, empresa, colaboradores } = body;

  if (!nombre || !email || !empresa || !colaboradores) {
    return new Response(JSON.stringify({ error: 'Campos requeridos faltantes' }), {
      status: 400, headers: corsHeaders
    });
  }

  const results = await Promise.allSettled([
    sendToNotion({ nombre, email, empresa, colaboradores }),
    sendToTelegram({ nombre, email, empresa, colaboradores })
  ]);

  const notionOk   = results[0].status === 'fulfilled';
  const telegramOk = results[1].status === 'fulfilled';

  if (!notionOk) console.error('Notion error:', results[0].reason);
  if (!telegramOk) console.error('Telegram error:', results[1].reason);

  if (!notionOk && !telegramOk) {
    return new Response(JSON.stringify({ error: 'Error al procesar solicitud' }), {
      status: 500, headers: corsHeaders
    });
  }

  return new Response(JSON.stringify({ success: true, notion: notionOk, telegram: telegramOk }), {
    status: 200, headers: corsHeaders
  });
}

async function sendToNotion({ nombre, email, empresa, colaboradores }) {
  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28'
    },
    body: JSON.stringify({
      parent: { database_id: NOTION_DATABASE_ID },
      properties: {
        'Nombre y Cargo': { title: [{ text: { content: nombre } }] },
        'Email':          { email: email },
        'Empresa':        { rich_text: [{ text: { content: empresa } }] },
        'Colaboradores':  { select: { name: colaboradores } },
        'Estado':         { select: { name: 'Nuevo' } }
      }
    })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Notion ${res.status}: ${err}`);
  }
  return res.json();
}

async function sendToTelegram({ nombre, email, empresa, colaboradores }) {
  const mensaje = `🌱 *Nuevo Lead Fundador — Treevü*

👤 *${nombre}*
📧 ${email}
🏢 ${empresa}
👥 ${colaboradores} colaboradores

_Acceso Fundador solicitado desde gettreevu.com_`;

  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: mensaje,
      parse_mode: 'Markdown'
    })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Telegram ${res.status}: ${err}`);
  }
  return res.json();
}
