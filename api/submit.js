const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

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

  const sectorMap = {
    'retail': 'Retail y consumo', 'manufactura': 'Manufactura',
    'servicios': 'Servicios', 'salud': 'Salud', 'tecnologia': 'Tecnologia',
    'construccion': 'Construccion / Mineria', 'educacion': 'Educacion', 'otro': 'Otro'
  };
  const objMap = {
    'reducir-rotacion': 'Reducir rotacion', 'mejorar-clima': 'Mejorar clima laboral',
    'optimizar-nomina': 'Optimizar nomina', 'bienestar-financiero': 'Bienestar financiero',
    'atraccion-talento': 'Atraer talento', 'otro': 'Otro objetivo'
  };

  const mensaje = `Nuevo Lead Fundador - Treevu\n\nNombre: ${nombre}\nEmail: ${email}\nEmpresa: ${empresa}\nSector: ${sectorMap[sector] || sector}\nColaboradores: ${colaboradores}\nObjetivo: ${objMap[objetivo] || objetivo}${problema ? '\nReto: ' + problema : ''}\n\nSolicitud desde gettreevu.com`;

  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: mensaje })
    });
    if (!tgRes.ok) throw new Error(`Telegram ${tgRes.status}`);
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Telegram error:', err);
    return res.status(500).json({ error: 'Error al enviar notificacion' });
  }
}
