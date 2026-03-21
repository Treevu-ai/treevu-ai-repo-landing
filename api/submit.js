export const config = { runtime: 'edge' };

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

export default async function handler(req) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: corsHeaders
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: corsHeaders
    });
  }

  const { nombre, email, empresa, sector, colaboradores, objetivo, problema } = body;

  if (!nombre || !email || !empresa || !sector || !colaboradores || !objetivo) {
    return new Response(JSON.stringify({ error: 'Campos requeridos faltantes' }), {
      status: 400, headers: corsHeaders
    });
  }

  try {
    await sendToTelegram({ nombre, email, empresa, colaboradores });
    return new Response(JSON.stringify({ success: true }), {
      status: 200, headers: corsHeaders
    });
  } catch (err) {
    console.error('Telegram error:', err);
    return new Response(JSON.stringify({ error: 'Error al enviar notificación' }), {
      status: 500, headers: corsHeaders
    });
  }
}

async function sendToTelegram({ nombre, email, empresa, sector, colaboradores, objetivo, problema }) {
  const sectorMap = {
    'retail': 'Retail y consumo', 'manufactura': 'Manufactura',
    'servicios': 'Servicios', 'salud': 'Salud', 'tecnologia': 'Tecnología',
    'construccion': 'Construcción / Minería', 'educacion': 'Educación', 'otro': 'Otro'
  };
  const objMap = {
    'reducir-rotacion': 'Reducir rotación', 'mejorar-clima': 'Mejorar clima laboral',
    'optimizar-nomina': 'Optimizar nómina', 'bienestar-financiero': 'Bienestar financiero',
    'atraccion-talento': 'Atraer talento', 'otro': 'Otro objetivo'
  };
  const mensaje = `🌱 *Nuevo Lead Fundador — Treevü*

👤 *${nombre}*
📧 ${email}
🏢 ${empresa}
🏭 ${sectorMap[sector] || sector}
👥 ${colaboradores} colaboradores
🎯 ${objMap[objetivo] || objetivo}${problema ? '
💬 ' + problema : ''}

_Solicitud desde gettreevu.com_`;

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
