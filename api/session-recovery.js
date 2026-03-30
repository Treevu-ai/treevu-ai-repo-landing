// ── api/session-recovery.js ───────────────────────────────────────────────────
// Cron job: detecta sesiones de @treevubot abandonadas hace 4-23h y envía un
// mensaje de recuperación al prospecto directamente por Telegram.
//
// Schedule: "0 */4 * * *" (cada 4 horas)
// Configurar en vercel.json: { "path": "/api/session-recovery", "schedule": "0 */4 * * *" }
//
// Una sesión "abandonada" es aquella donde:
//   - step !== 'DONE' (no completó el flujo)
//   - El prospecto no ha interactuado en las últimas 4h
//   - No es una sesión recién iniciada (tiene al menos sector seleccionado)

import { sendMessage }        from './lib/telegram.js';
import { redisCmd, redisScan } from './lib/redis.js';

const BOT_TOKEN   = process.env.TELEGRAM_VU_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;

const RECOVERY_MESSAGES = {
  SECTOR: '¿Te perdiste? 👋 Solo quedan 2 preguntas rápidas para ver cómo Treevü puede ayudar a tu empresa. ¿Seguimos?',
  SIZE:   '¿Te perdiste? 👋 Ya casi terminas — solo falta indicar tu objetivo principal. ¿Seguimos?',
  OBJETIVO: null, // No aplica — ya llegó al chat, no está realmente abandonado
  CHAT:   '¿Quedó alguna duda sin responder? Estoy aquí para ayudarte. 👇',
  CAPTURE_NAME:    '¿Listo/a para que el equipo te contacte? Solo necesito tu nombre para continuar. 👇',
  CAPTURE_COMPANY: '¿En qué empresa trabajas? Es el último paso antes de que el equipo se comunique contigo. 👇',
  CAPTURE_EMAIL:   '¿Cuál es tu correo corporativo? Es el último paso — el equipo te escribirá en menos de 24h. 👇',
};


const tgSend = (chatId, text) => sendMessage(BOT_TOKEN, chatId, text);

export default async function handler(req, res) {
  const authHeader    = req.headers['authorization'];
  const secret        = req.query?.secret;
  const isVercelCron  = authHeader === `Bearer ${CRON_SECRET}`;
  const isManual      = secret && secret === CRON_SECRET;

  if (!isVercelCron && !isManual) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const keys = await redisScan('sess:*');
    console.log(`[session-recovery] ${keys.length} sesiones encontradas en Redis`);

    let recovered = 0;
    let skipped   = 0;

    const now = Date.now();
    const MIN_AGE_MS = 4  * 60 * 60 * 1000; // 4h — mínimo para considerarla abandonada
    const MAX_AGE_MS = 23 * 60 * 60 * 1000; // 23h — cerca de expirar, ya no vale la pena

    for (const key of keys) {
      const raw = await redisCmd('GET', key);
      if (!raw) continue;

      let session;
      try { session = JSON.parse(raw); } catch { continue; }

      // Solo sesiones no completadas con al menos sector elegido
      if (session.step === 'DONE' || session.step === 'INIT' || !session.sector) {
        skipped++;
        continue;
      }

      // No recuperar si ya recibió mensaje de recuperación recientemente
      if (session.recoverySentAt) {
        const timeSinceRecovery = now - session.recoverySentAt;
        if (timeSinceRecovery < MIN_AGE_MS) { skipped++; continue; }
      }

      // Estimar antigüedad por TTL restante (sesión dura 86400s = 24h)
      const ttl = await redisCmd('TTL', key);
      if (ttl === null || ttl < 0) { skipped++; continue; }

      const ageMs = (86400 - ttl) * 1000;
      if (ageMs < MIN_AGE_MS || ageMs > MAX_AGE_MS) { skipped++; continue; }

      const message = RECOVERY_MESSAGES[session.step];
      if (!message) { skipped++; continue; }

      const chatId = key.replace('sess:', '');
      await tgSend(chatId, message);

      // Marcar para no volver a enviar en 4h
      session.recoverySentAt = now;
      await redisCmd('SET', key, JSON.stringify(session), 'KEEPTTL');

      recovered++;
      console.log(`[session-recovery] Mensaje enviado → chatId ${chatId} (step: ${session.step})`);
    }

    console.log(`[session-recovery] OK — ${recovered} recuperadas, ${skipped} omitidas`);
    return res.status(200).json({ success: true, recovered, skipped });

  } catch (err) {
    console.error('[session-recovery] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
