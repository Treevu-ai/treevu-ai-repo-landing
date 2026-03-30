// ── api/calendly-webhook.js ───────────────────────────────────────────────────
// Recibe webhooks de Calendly cuando un lead agenda una reunión
// y actualiza el estado en Notion de "Nuevo/Contactado" → "Reunión agendada"
//
// Setup en Calendly: https://calendly.com/integrations/webhooks
// URL: https://gettreevu.com/api/calendly-webhook
// Eventos: invitee.created

import { createHmac } from 'crypto';

const NOTION_TOKEN            = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID      = "2e5f06c0295b46fbbc212bac5f6fcb3c";
const TELEGRAM_BOT_TOKEN      = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID        = process.env.TELEGRAM_CHAT_ID;
const CALENDLY_WEBHOOK_SECRET = process.env.CALENDLY_WEBHOOK_SECRET;
const LEAD_WEBHOOK_SECRET     = process.env.LEAD_WEBHOOK_SECRET;

async function findLeadByEmail(email) {
  const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28'
    },
    body: JSON.stringify({
      filter: { property: 'Email', email: { equals: email } },
      page_size: 1
    })
  });
  if (!res.ok) throw new Error(`Notion query ${res.status}`);
  const data = await res.json();
  return data.results?.[0] || null;
}

async function updateLeadEstado(pageId, nuevoEstado, notaAdicional) {
  const body = {
    properties: {
      'Estado': { select: { name: nuevoEstado } }
    }
  };
  if (notaAdicional) {
    body.properties['Notas'] = { rich_text: [{ text: { content: notaAdicional } }] };
  }
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Notion update ${res.status}: ${await res.text()}`);
  return res.json();
}

async function notifyTelegram(invitee, event, leadNombre) {
  const fechaReunion = new Date(event.start_time).toLocaleString('es-PE', {
    timeZone: 'America/Lima',
    weekday: 'long', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });

  let msg = `📅 *¡Reunión agendada! — Treevü*\n\n`;
  msg += `👤 *${invitee.name}*\n`;
  msg += `📧 ${invitee.email}\n`;
  msg += `🗓 ${fechaReunion}\n`;
  msg += `📋 ${event.name || 'Llamada Treevü 30 min'}\n`;
  if (leadNombre) msg += `\n_Lead identificado: ${leadNombre}_\n`;
  msg += `\n✅ *Estado actualizado en Notion → Reunión*`;

  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'Markdown' })
  });
  if (!res.ok) console.error('[calendly] Telegram error:', res.status);
}

// ── Crear lead en CRM vía AsisTreevü cuando no existe ──────────────────────
async function createLeadFromCalendly(invitee, eventData) {
  if (!LEAD_WEBHOOK_SECRET) return;
  try {
    await fetch('https://treevu-bot.vercel.app/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': LEAD_WEBHOOK_SECRET },
      body: JSON.stringify({
        name:    invitee.name  || 'Invitado Calendly',
        email:   invitee.email,
        company: '',
        message: `Agendó reunión vía Calendly sin lead previo. Evento: ${eventData.name || 'Llamada 30 min'}`,
        source:  'Calendly (directo)',
        score:   'MEDIO',
      }),
    });
    console.log(`[calendly] Lead creado automáticamente: ${invitee.email}`);
  } catch (err) {
    console.error('[calendly] Error creando lead:', err.message);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // ── Verificar firma HMAC de Calendly ──────────────────────────────────────
  if (CALENDLY_WEBHOOK_SECRET) {
    const sigHeader = req.headers['calendly-webhook-signature'];
    if (!sigHeader) {
      console.warn('[calendly] Firma faltante — request rechazado');
      return res.status(401).json({ error: 'Missing signature' });
    }
    try {
      const parts     = Object.fromEntries(sigHeader.split(',').map(p => p.split('=')));
      const timestamp = parts['t'];
      const v1        = parts['v1'];
      const payload   = `${timestamp}.${JSON.stringify(req.body)}`;
      const expected  = createHmac('sha256', CALENDLY_WEBHOOK_SECRET).update(payload).digest('hex');
      if (v1 !== expected) {
        console.warn('[calendly] Firma inválida');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    } catch (err) {
      console.error('[calendly] Error verificando firma:', err.message);
    }
  }

  const { event, payload } = req.body || {};

  // Solo procesar invitee.created (nueva reunión agendada)
  if (event !== 'invitee.created') {
    return res.status(200).json({ ignored: true, event });
  }

  const invitee = payload?.invitee || {};
  const eventData = payload?.event || {};
  const email = invitee?.email;
  const nombre = invitee?.name;

  if (!email) {
    console.warn('[calendly] Webhook sin email de invitado');
    return res.status(200).json({ ok: true, note: 'no email' });
  }

  console.log(`[calendly] Nueva reunión agendada: ${nombre} <${email}>`);

  try {
    // Buscar lead en Notion por email
    const lead = await findLeadByEmail(email);

    if (lead) {
      const nota = `Reunión agendada vía Calendly el ${new Date().toLocaleDateString('es-PE', { timeZone: 'America/Lima' })}. Evento: ${eventData.name || 'Llamada 30 min'}`;
      await updateLeadEstado(lead.id, 'Reunion', nota);
      console.log(`[calendly] Notion actualizado: ${email} → Reunión agendada`);
      await notifyTelegram(invitee, eventData, nombre);
    } else {
      // Lead no existe — crear automáticamente en CRM y notificar
      console.warn(`[calendly] Lead no encontrado para ${email} — creando automáticamente`);
      await createLeadFromCalendly(invitee, eventData);
      await notifyTelegram(invitee, eventData, null);
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[calendly] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
