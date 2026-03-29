// ── api/calendly-webhook.js ───────────────────────────────────────────────────
// Recibe webhooks de Calendly cuando un lead agenda una reunión
// y actualiza el estado en Notion de "Nuevo/Contactado" → "Reunión agendada"
//
// Setup en Calendly: https://calendly.com/integrations/webhooks
// URL: https://gettreevu.com/api/calendly-webhook
// Eventos: invitee.created

import { createHmac } from 'crypto';
import { NOTION }                    from './lib/constants.js';
import { notionQuery, notionPatch, getProp } from './lib/notion.js';
import { sendMessage }               from './lib/telegram.js';
import { captureException }          from './lib/sentry.js';
import { redisCmd }                  from './lib/redis.js';

async function storeReunionRedis(lead, startTime) {
  if (!startTime) return;
  const ts = Math.floor(new Date(startTime).getTime() / 1000);
  // Extraer teléfono de Notas si fue guardado con [wa:XXXXXXXX]
  const notas = getProp(lead, 'Notas') || '';
  const phoneMatch = notas.match(/\[wa:(\d+)\]/);
  const phone = phoneMatch ? phoneMatch[1] : '';
  const data = JSON.stringify({
    lead_id:       lead.id,
    empresa:       getProp(lead, 'Empresa') || '',
    nombre:        getProp(lead, 'Nombre y Cargo') || '',
    email:         getProp(lead, 'Email') || '',
    phone,
    fecha_reunion: startTime,
  });
  await Promise.all([
    redisCmd('ZADD', 'reuniones', ts, lead.id),           // sorted set para queries por tiempo
    redisCmd('SET',  `reunion:${lead.id}`, data, 'EX', 604800), // datos del lead (7 días TTL)
  ]);
  console.log(`[calendly] Reunion guardada en Redis: ${lead.id} ts=${ts}`);
}

const TELEGRAM_BOT_TOKEN      = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID        = process.env.TELEGRAM_CHAT_ID;
const CALENDLY_WEBHOOK_SECRET = process.env.CALENDLY_WEBHOOK_SECRET;
const LEAD_WEBHOOK_SECRET     = process.env.LEAD_WEBHOOK_SECRET;
const CRON_SECRET             = process.env.CRON_SECRET;

async function findLeadByEmail(email) {
  const data = await notionQuery(NOTION.CRM_DB, {
    property: 'Email', email: { equals: email },
  }, 1);
  return data.results?.[0] || null;
}

async function updateLeadEstado(pageId, nuevoEstado, notaAdicional) {
  const properties = { 'Estado': { select: { name: nuevoEstado } } };
  if (notaAdicional) {
    properties['Notas'] = { rich_text: [{ text: { content: notaAdicional } }] };
  }
  return notionPatch(pageId, properties);
}

async function notifyTelegramCancelled(invitee, event) {
  const fechaReunion = new Date(event.start_time).toLocaleString('es-PE', {
    timeZone: 'America/Lima', weekday: 'long', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
  let msg = `❌ *Reunión cancelada — Treevü*\n\n`;
  msg += `👤 *${invitee.name}*\n`;
  msg += `📧 ${invitee.email}\n`;
  msg += `🗓 ~~${fechaReunion}~~\n`;
  msg += `\n📝 CRM → Estado revertido a Contactado\n🗂 Eliminado de cola de recordatorios`;
  await sendMessage(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, msg);
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

  const result = await sendMessage(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, msg);
  if (!result.ok) console.error('[calendly] Telegram error:', result);
}

// ── Trigger briefing pre-reunión ──────────────────────────────────────────────
async function triggerPreMeeting(leadId, fechaReunion) {
  if (!CRON_SECRET) return;
  try {
    await fetch('https://gettreevu.com/api/primera-reunion', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CRON_SECRET}` },
      body: JSON.stringify({ action: 'pre-meeting', lead_id: leadId, fecha_reunion: fechaReunion }),
    });
    console.log(`[calendly] Pre-meeting briefing triggered: ${leadId}`);
  } catch (err) {
    console.error('[calendly] Error triggering pre-meeting:', err.message);
  }
}

// ── Crear lead en CRM vía AsisTreevü cuando no existe ──────────────────────
async function createLeadFromCalendly(invitee, eventData) {
  if (!LEAD_WEBHOOK_SECRET) return;
  try {
    await fetch('https://gettreevu.com/api/lead', {
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
      return res.status(401).json({ error: 'Signature verification failed' });
    }
  }

  const { event, payload } = req.body || {};

  // ── invitee.cancelled: revertir CRM + limpiar Redis ──────────────────────
  if (event === 'invitee.cancelled') {
    const cancelInvitee  = payload?.invitee  || {};
    const cancelEvent    = payload?.event    || {};
    const cancelEmail    = cancelInvitee?.email;
    if (cancelEmail) {
      const lead = await findLeadByEmail(cancelEmail).catch(() => null);
      if (lead) {
        const estadoActual = getProp(lead, 'Estado');
        const promises = [
          redisCmd('ZREM', 'reuniones', lead.id),
          redisCmd('DEL',  `reunion:${lead.id}`),
          redisCmd('DEL',  `reminder_sent:${lead.id}`),
        ];
        if (estadoActual === 'Reunion') {
          const nota = `Reunión cancelada vía Calendly el ${new Date().toLocaleDateString('es-PE', { timeZone: 'America/Lima' })}.`;
          promises.push(notionPatch(lead.id, {
            'Estado': { select:    { name: 'Contactado' } },
            'Notas':  { rich_text: [{ text: { content: nota } }] },
          }));
        }
        await Promise.all(promises);
        console.log(`[calendly] Reunión cancelada: ${cancelEmail} — Redis limpiado, CRM revertido`);
      }
      await notifyTelegramCancelled(cancelInvitee, cancelEvent).catch(() => {});
    }
    return res.status(200).json({ ok: true, cancelled: true });
  }

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
      // Re-score a ALTO: si alguien agenda una reunión demuestra intención real
      const scoreActual = getProp(lead, 'Score');
      if (scoreActual !== 'ALTO') {
        notionPatch(lead.id, { 'Score': { select: { name: 'ALTO' } } })
          .catch(err => console.error('[calendly] Re-score error:', err.message));
        console.log(`[calendly] Re-score: ${email} ${scoreActual} → ALTO`);
      }

      const nota = `Reunión agendada vía Calendly el ${new Date().toLocaleDateString('es-PE', { timeZone: 'America/Lima' })}. Evento: ${eventData.name || 'Llamada 30 min'}`;
      await updateLeadEstado(lead.id, 'Reunion', nota);
      console.log(`[calendly] Notion actualizado: ${email} → Reunión agendada`);
      await notifyTelegram(invitee, eventData, nombre);
      await Promise.all([
        triggerPreMeeting(lead.id, eventData.start_time),
        storeReunionRedis(lead, eventData.start_time),
      ]);
    } else {
      // Lead no existe — crear automáticamente en CRM y notificar
      console.warn(`[calendly] Lead no encontrado para ${email} — creando automáticamente`);
      await createLeadFromCalendly(invitee, eventData);
      await notifyTelegram(invitee, eventData, null);
    }

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[calendly] Error:', err.message);
    captureException(err, { email, nombre });
    return res.status(500).json({ error: err.message });
  }
}
