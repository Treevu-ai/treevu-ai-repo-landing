// api/reunion-reminder.js — Cron de recordatorio pre-reunión y alerta post-reunión
//
// Corre cada hora. Dos funciones:
//   1. Envía briefing de recordatorio 45–75 min antes de la reunión
//   2. Alertar al CEO para registrar resultado 3–6h después de la reunión
//
// Trigger manual: GET /api/reunion-reminder?secret=CRON_SECRET

import { sendMessage } from './lib/telegram.js';
import { notionQuery, getProp, getNotionPage } from './lib/notion.js';
import { PROGRAMA } from './lib/constants.js';
import { captureException } from './lib/sentry.js';
import { redisCmd }         from './lib/redis.js';
import { sendWhatsApp }     from './lib/whatsapp.js';

const BOT_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID     = process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET = process.env.CRON_SECRET;

async function getReunionData(leadId) {
  const raw = await redisCmd('GET', `reunion:${leadId}`);
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

// ── WhatsApp recordatorio 24h antes ──────────────────────────────────────────
async function checkReuniones24h(nowTs) {
  const minTs = nowTs + 23 * 3600;
  const maxTs = nowTs + 25 * 3600;
  const ids   = await redisCmd('ZRANGEBYSCORE', 'reuniones', minTs, maxTs);
  if (!ids?.length) return;

  for (const leadId of ids) {
    const yaEnviado = await redisCmd('GET', `wa_reminder_24h:${leadId}`);
    if (yaEnviado) continue;

    const data = await getReunionData(leadId);
    if (!data?.phone) continue;

    const fechaStr = new Date(data.fecha_reunion).toLocaleString('es-PE', {
      timeZone: 'America/Lima', weekday: 'long', hour: '2-digit', minute: '2-digit',
    });
    const firstName = (data.nombre || '').split(/[\s,\-]+/)[0] || 'equipo';

    const msg = `Hola ${firstName} 👋\n\nTe recordamos nuestra reunión *mañana ${fechaStr}*.\n\nSi necesitas reagendar, puedes hacerlo aquí: ${PROGRAMA.BOOKING}\n\n_Equipo Treevü_`;

    const ok = await sendWhatsApp(data.phone, msg).catch(() => false);
    if (ok) {
      await redisCmd('SET', `wa_reminder_24h:${leadId}`, '1', 'EX', 86400);
      console.log(`[reunion-reminder] WhatsApp 24h enviado: ${leadId} (${data.empresa})`);
    }
  }
}

// ── Reuniones próximas (45–75 min desde ahora) ────────────────────────────────
async function checkReunionesProximas(nowTs) {
  const minTs = nowTs + 45 * 60;   // 45 min desde ahora
  const maxTs = nowTs + 75 * 60;   // 75 min desde ahora
  const ids   = await redisCmd('ZRANGEBYSCORE', 'reuniones', minTs, maxTs);
  if (!ids?.length) return;

  for (const leadId of ids) {
    // Evitar doble recordatorio
    const yaEnviado = await redisCmd('GET', `reminder_sent:${leadId}`);
    if (yaEnviado) continue;

    const data = await getReunionData(leadId);
    if (!data) continue;

    const fechaStr = new Date(data.fecha_reunion).toLocaleString('es-PE', {
      timeZone: 'America/Lima', weekday: 'short',
      hour: '2-digit', minute: '2-digit',
    });

    let msg = `⏰ *Recordatorio — reunión en ~1 hora*\n\n`;
    msg += `🏢 *${data.empresa || 'empresa'}*\n`;
    msg += `👤 ${data.nombre || 'contacto'}\n`;
    msg += `🕐 ${fechaStr}\n\n`;
    msg += `_Revisa el briefing que te envié cuando se agendó._`;

    await sendMessage(BOT_TOKEN, CHAT_ID, msg);
    // Marcar como enviado (TTL 2h para no duplicar)
    await redisCmd('SET', `reminder_sent:${leadId}`, '1', 'EX', 7200);

    console.log(`[reunion-reminder] Recordatorio enviado: ${leadId} (${data.empresa})`);
  }
}

// ── Reuniones pasadas sin resultado registrado (3–6h atrás) ──────────────────
async function checkReunionesVencidas(nowTs) {
  const minTs = nowTs - 6 * 3600;  // hace 6h
  const maxTs = nowTs - 3 * 3600;  // hace 3h
  const ids   = await redisCmd('ZRANGEBYSCORE', 'reuniones', minTs, maxTs);
  if (!ids?.length) return;

  for (const leadId of ids) {
    // Evitar alertar dos veces
    const yaAlertado = await redisCmd('GET', `postmeeting_alerted:${leadId}`);
    if (yaAlertado) continue;

    // Verificar que el lead aún está en "Reunion" (no fue procesado ya)
    let estadoActual = null;
    try {
      const page = await getNotionPage(leadId);
      estadoActual = getProp(page, 'Estado');
    } catch (err) {
      console.error(`[reunion-reminder] Error leyendo Notion para ${leadId}:`, err.message);
    }

    // Si ya cambió de estado, limpiar de la cola y saltar
    if (estadoActual && estadoActual !== 'Reunion') {
      await redisCmd('ZREM', 'reuniones', leadId);
      continue;
    }

    const data = await getReunionData(leadId);
    if (!data) continue;

    const msg = `📋 *¿Cómo fue la reunión con ${data.empresa || 'la empresa'}?*\n\n` +
      `_Toca el botón para registrar el resultado y generar el follow-up automáticamente._`;

    await sendMessage(BOT_TOKEN, CHAT_ID, msg, {
      reply_markup: {
        inline_keyboard: [[{
          text:          '✅ Registrar resultado',
          callback_data: `pm_start:${leadId}`,
        }]],
      },
    });

    await redisCmd('SET', `postmeeting_alerted:${leadId}`, '1', 'EX', 86400);
    console.log(`[reunion-reminder] Alerta post-meeting enviada: ${leadId} (${data.empresa})`);
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const secret = req.headers['authorization']?.replace('Bearer ', '')
    || new URL(req.url || '/', 'https://x').searchParams.get('secret');
  if (secret !== CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const nowTs = Math.floor(Date.now() / 1000);

  try {
    await Promise.all([
      checkReuniones24h(nowTs),
      checkReunionesProximas(nowTs),
      checkReunionesVencidas(nowTs),
    ]);
    return res.status(200).json({ ok: true, ts: nowTs });
  } catch (err) {
    console.error('[reunion-reminder] error:', err.message);
    captureException(err, { path: '/api/reunion-reminder' });
    return res.status(500).json({ error: err.message });
  }
}
