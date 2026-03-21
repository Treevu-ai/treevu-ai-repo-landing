export const config = { runtime: 'edge' };

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'hello@gettreevu.com';

async function sendTelegram(name, cargo, email, company, size) {
  const sizeLabels = {
    '50-200': '50–200 colaboradores',
    '200-500': '200–500 colaboradores',
    '500-1000': '500–1,000 colaboradores',
    '1000-5000': '1,000–5,000 colaboradores',
    '5000+': '5,000+ colaboradores'
  };
  const msg = `🎯 *NUEVO LEAD — Programa Fundadores*\n\n👤 *Nombre:* ${name}\n💼 *Cargo:* ${cargo}\n🏢 *Empresa:* ${company}\n📧 *Email:* ${email}\n👥 *Tamaño:* ${sizeLabels[size] || size}\n\n⏰ ${new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' })}\n🌐 gettreevu.com`;

  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'Markdown' })
  });
  return res.ok;
}

async function sendEmail(name, cargo, email, company, size) {
  if (!RESEND_API_KEY) return true;
  const sizeLabels = { '50-200':'50–200','200-500':'200–500','500-1000':'500–1,000','1000-5000':'1,000–5,000','5000+':'5,000+' };
  const html = `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:32px"><div style="background:#059669;border-radius:8px;padding:20px 24px;margin-bottom:24px"><h1 style="color:white;margin:0;font-size:20px">🎯 Nuevo Lead — Programa Fundadores</h1><p style="color:rgba(255,255,255,0.8);margin:6px 0 0;font-size:14px">gettreevu.com</p></div><table style="width:100%;border-collapse:collapse"><tr><td style="padding:10px 0;border-bottom:1px solid #f1f5f9;color:#64748b;font-size:13px;width:40%">Nombre</td><td style="padding:10px 0;border-bottom:1px solid #f1f5f9;font-weight:600;color:#0f172a">${name}</td></tr><tr><td style="padding:10px 0;border-bottom:1px solid #f1f5f9;color:#64748b;font-size:13px">Cargo</td><td style="padding:10px 0;border-bottom:1px solid #f1f5f9;font-weight:600;color:#0f172a">${cargo}</td></tr><tr><td style="padding:10px 0;border-bottom:1px solid #f1f5f9;color:#64748b;font-size:13px">Empresa</td><td style="padding:10px 0;border-bottom:1px solid #f1f5f9;font-weight:600;color:#0f172a">${company}</td></tr><tr><td style="padding:10px 0;border-bottom:1px solid #f1f5f9;color:#64748b;font-size:13px">Email</td><td style="padding:10px 0;border-bottom:1px solid #f1f5f9"><a href="mailto:${email}" style="color:#059669;font-weight:600">${email}</a></td></tr><tr><td style="padding:10px 0;color:#64748b;font-size:13px">Colaboradores</td><td style="padding:10px 0;font-weight:600;color:#0f172a">${sizeLabels[size]||size}</td></tr></table><div style="margin-top:24px;padding:16px;background:#f8fafc;border-radius:8px;font-size:13px;color:#64748b">Recibido el ${new Date().toLocaleString('es-PE',{timeZone:'America/Lima'})}</div></div>`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify({ from: 'Treevü Leads <leads@gettreevu.com>', to: NOTIFY_EMAIL, subject: `🎯 Nuevo lead: ${name} — ${company}`, html })
  });
  return res.ok;
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } });
  }
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }
  try {
    const body = await req.json();
    const { name, cargo, email, company, size } = body;
    if (!name || !cargo || !email || !company || !size) {
      return new Response(JSON.stringify({ error: 'Campos incompletos' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    const [tgResult] = await Promise.allSettled([
      sendTelegram(name, cargo, email, company, size),
      sendEmail(name, cargo, email, company, size)
    ]);
    const success = tgResult.status === 'fulfilled' && tgResult.value;
    return new Response(JSON.stringify({ ok: success }), {
      status: success ? 200 : 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}
