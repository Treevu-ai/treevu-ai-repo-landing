// api/onboarding.js — Onboarding automatizado post-firma
//
// POST /api/onboarding  → inicia secuencia para un lead recién cerrado
// GET  /api/onboarding  → cron diario: envía emails de la secuencia
//
// Secuencia de emails:
//   D+1  (22-26h):  Próximos pasos técnicos
//   D+3  (70-74h):  Guía de integración con nómina
//   D+7  (166-170h): Check-in semana 1
//   D+30 (~720h):   NPS / satisfacción

import { getGmailToken, gmailSend } from './lib/gmail.js';
import { sendMessage }               from './lib/telegram.js';
import { redisCmd }                  from './lib/redis.js';
import { captureException }          from './lib/sentry.js';
import { PROGRAMA }                  from './lib/constants.js';
import { askClaude }                 from './lib/anthropic.js';

const BOT_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CEO_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET = process.env.CRON_SECRET;

const notify = (text) => sendMessage(BOT_TOKEN, CEO_CHAT_ID, text);

// ── Templates de email ────────────────────────────────────────────────────────
const SEQUENCES = [
  {
    key: 'ob_d1', minH: 22, maxH: 26, day: 1,
    build: (d) => ({
      to:      d.email,
      subject: `Bienvenidos a Treevü · Próximos pasos`,
      bodyHtml: `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a">
  <div style="background:#0f4c81;padding:28px 32px;border-radius:8px 8px 0 0">
    <h2 style="color:#fff;margin:0;font-size:20px">Próximos pasos — ${d.empresa}</h2>
  </div>
  <div style="padding:28px 32px;border:1px solid #e5e7eb;border-radius:0 0 8px 8px">
    <p>Hola${d.contacto ? ` ${d.contacto.split(' ')[0]}` : ''},</p>
    <p>Estamos emocionados de comenzar. Aquí está el plan para los próximos días:</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0">
      <tr style="background:#f0f9ff">
        <td style="padding:10px 14px;border-bottom:1px solid #e5e7eb;font-weight:bold;color:#0f4c81;width:80px">Hoy</td>
        <td style="padding:10px 14px;border-bottom:1px solid #e5e7eb">Nuestro equipo técnico te escribirá para agendar la sesión de integración</td>
      </tr>
      <tr>
        <td style="padding:10px 14px;border-bottom:1px solid #e5e7eb;font-weight:bold;color:#0f4c81">D+2</td>
        <td style="padding:10px 14px;border-bottom:1px solid #e5e7eb">Integración con tu sistema de nómina (max. 2 horas)</td>
      </tr>
      <tr style="background:#f0f9ff">
        <td style="padding:10px 14px;border-bottom:1px solid #e5e7eb;font-weight:bold;color:#0f4c81">D+3</td>
        <td style="padding:10px 14px;border-bottom:1px solid #e5e7eb">Plataforma lista — sesión de capacitación para RR.HH.</td>
      </tr>
      <tr>
        <td style="padding:10px 14px;font-weight:bold;color:#0f4c81">D+5</td>
        <td style="padding:10px 14px">Lanzamiento a colaboradores</td>
      </tr>
    </table>
    <p><strong>¿Qué necesitamos de tu lado?</strong></p>
    <ul>
      <li>Contacto del responsable de Nómina / Sistemas</li>
      <li>Sistema de nómina que usan (Softnet, SAP, T-Registro, etc.)</li>
      <li>Número aproximado de colaboradores a activar en la primera fase</li>
    </ul>
    <p>Responde este email con esa info y arrancamos hoy mismo.</p>
    <p>Saludos,<br><strong>Equipo Treevü</strong> · <a href="mailto:hello@gettreevu.com">hello@gettreevu.com</a></p>
  </div>
</div>`.trim(),
    }),
  },
  {
    key: 'ob_d3', minH: 70, maxH: 74, day: 3,
    build: (d) => ({
      to:      d.email,
      subject: `Guía de integración con nómina — ${d.empresa}`,
      bodyHtml: `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a">
  <div style="background:#0f4c81;padding:28px 32px;border-radius:8px 8px 0 0">
    <h2 style="color:#fff;margin:0;font-size:20px">Guía de integración</h2>
  </div>
  <div style="padding:28px 32px;border:1px solid #e5e7eb;border-radius:0 0 8px 8px">
    <p>Hola${d.contacto ? ` ${d.contacto.split(' ')[0]}` : ''},</p>
    <p>Para agilizar la integración, aquí están los 3 pasos técnicos:</p>
    <ol style="line-height:2.2">
      <li><strong>Exportar planilla:</strong> Archivo CSV/Excel con DNI, nombre, fecha de ingreso y sueldo bruto mensual</li>
      <li><strong>Configurar descuentos:</strong> Agregaremos el adelanto como una línea de descuento en tu planilla mensual</li>
      <li><strong>Período de corte:</strong> Definir el día de corte para los adelantos (recomendamos el 20 de cada mes)</li>
    </ol>
    <div style="background:#f0fdf4;border-left:4px solid #10b981;padding:16px;border-radius:4px;margin:16px 0">
      <p style="margin:0"><strong>Tiempo estimado:</strong> 1.5 horas con el equipo de nómina presente</p>
    </div>
    <p>¿Tienes al responsable de nómina disponible esta semana? Coordinamos una videollamada de 90 minutos.</p>
    <p>Saludos,<br><strong>Equipo Treevü</strong></p>
  </div>
</div>`.trim(),
    }),
  },
  {
    key: 'ob_d7', minH: 166, maxH: 170, day: 7,
    build: (d) => ({
      to:      d.email,
      subject: `Check-in semana 1 — ¿Cómo va ${d.empresa}?`,
      bodyHtml: `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a">
  <div style="background:#0f4c81;padding:28px 32px;border-radius:8px 8px 0 0">
    <h2 style="color:#fff;margin:0;font-size:20px">Check-in — Primera semana</h2>
  </div>
  <div style="padding:28px 32px;border:1px solid #e5e7eb;border-radius:0 0 8px 8px">
    <p>Hola${d.contacto ? ` ${d.contacto.split(' ')[0]}` : ''},</p>
    <p>Una semana desde que comenzaron con Treevü. Queríamos saber cómo va todo:</p>
    <ul>
      <li>¿La integración con nómina quedó lista?</li>
      <li>¿El equipo de RR.HH. tiene acceso al panel?</li>
      <li>¿Ya comunicaron a los colaboradores la nueva herramienta?</li>
    </ul>
    <p>Si hay algún bloqueante o pregunta, respondemos este email o escriben al WhatsApp del equipo.</p>
    <p><strong>Recuerda:</strong> los primeros colaboradores que usan el adelanto suelen ser los más entusiastas — son tus mejores embajadores internos.</p>
    <p>Saludos,<br><strong>Equipo Treevü</strong></p>
  </div>
</div>`.trim(),
    }),
  },
  {
    key: 'ob_d30', minH: 718, maxH: 722, day: 30,
    build: (d) => ({
      to:      d.email,
      subject: `Un mes con Treevü — Cuéntanos cómo van`,
      bodyHtml: `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a">
  <div style="background:#0f4c81;padding:28px 32px;border-radius:8px 8px 0 0">
    <h2 style="color:#fff;margin:0;font-size:20px">¡Un mes! 🎉</h2>
  </div>
  <div style="padding:28px 32px;border:1px solid #e5e7eb;border-radius:0 0 8px 8px">
    <p>Hola${d.contacto ? ` ${d.contacto.split(' ')[0]}` : ''},</p>
    <p>¡${d.empresa} ya lleva un mes con Treevü! Nos encantaría saber:</p>
    <ol>
      <li>¿Cuántos colaboradores han usado la plataforma este mes?</li>
      <li>¿Han notado algún cambio en el clima laboral?</li>
      <li>¿Qué mejorarías de la experiencia?</li>
    </ol>
    <p>Tu feedback nos ayuda a mejorar el producto. ¿Tienes 10 minutos para una llamada esta semana?</p>
    <p><a href="${PROGRAMA.BOOKING}" style="background:#10b981;color:#fff;padding:10px 22px;border-radius:6px;text-decoration:none;display:inline-block;">📅 Agendar check-in de 10 min</a></p>
    <p>Saludos,<br><strong>Equipo Treevü</strong></p>
  </div>
</div>`.trim(),
    }),
  },
];

// ── Personalizar email D+1 con Claude ────────────────────────────────────────
async function personalizeD1(d) {
  const prompt = `Personaliza este email de bienvenida de Treevü para ${d.empresa} (${d.sector || 'empresa peruana'}, ~${d.colabs || '?'} colaboradores).

Mantén la estructura base pero:
- Primer párrafo: menciona el sector específico y un beneficio concreto para ellos
- Lista de "¿qué necesitamos?": adapta el lenguaje al tamaño/sector
- Tono: cálido y ejecutivo, no genérico

Devuelve SOLO el HTML del body (sin <html><head>). Máximo 400 palabras.`;

  const base = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a">
  <div style="background:#0f4c81;padding:28px 32px;border-radius:8px 8px 0 0">
    <h2 style="color:#fff;margin:0;font-size:20px">Bienvenidos a Treevü · Próximos pasos — ${d.empresa}</h2>
  </div>
  <div style="padding:28px 32px;border:1px solid #e5e7eb;border-radius:0 0 8px 8px">
    <p>Hola${d.contacto ? ` ${d.contacto.split(' ')[0]}` : ''},</p>
    <p>Estamos emocionados de comenzar con ${d.empresa}. Aquí el plan para los primeros días:</p>
    <ul>
      <li><strong>Hoy:</strong> Nuestro equipo técnico te escribirá para agendar integración con nómina</li>
      <li><strong>D+2:</strong> Integración lista (máx. 2 horas)</li>
      <li><strong>D+3:</strong> Capacitación al equipo de RRHH</li>
      <li><strong>D+5:</strong> Lanzamiento a colaboradores</li>
    </ul>
    <p><strong>¿Qué necesitamos de tu lado?</strong></p>
    <ul>
      <li>Contacto del responsable de Nómina</li>
      <li>Sistema de nómina (Softnet, SAP, T-Registro, etc.)</li>
      <li>Número de colaboradores a activar en fase 1</li>
    </ul>
    <p>Responde este email y arrancamos hoy.</p>
    <p>Saludos,<br><strong>Equipo Treevü</strong> · <a href="mailto:hello@gettreevu.com">hello@gettreevu.com</a></p>
  </div>
</div>`.trim();

  try {
    const result = await askClaude(prompt, { maxTokens: 800 });
    return result || base;
  } catch {
    return base;
  }
}

// ── Detectar fricción y alertar al CEO ───────────────────────────────────────
async function checkFriction(leadId, d, nowTs) {
  const d1SentKey  = `ob_d1:${leadId}`;
  const fricKey    = `ob_fric:${leadId}`;
  const d1Sent     = await redisCmd('GET', d1SentKey);
  const fricAlerted = await redisCmd('GET', fricKey);

  if (!d1Sent || fricAlerted) return;

  const startedAt   = d.startedAt || 0;
  const horasDesdD1 = (nowTs - startedAt) / 3600;

  // Si pasaron 48h desde el inicio y D+1 fue enviado → posible fricción
  if (horasDesdD1 >= 48) {
    await redisCmd('SET', fricKey, '1', 'EX', 86400 * 7);
    const msg = `⚠️ *Fricción en onboarding — ${d.empresa}*\n` +
      `_Sin respuesta al email D+1 (${Math.round(horasDesdD1)}h)_\n\n` +
      `📧 ${d.email}\n` +
      `¿Hacemos seguimiento directo?`;
    await sendMessage(BOT_TOKEN, CEO_CHAT_ID, msg, {
      reply_markup: {
        inline_keyboard: [[
          { text: '📞 Llamar ahora',    callback_data: `ob_fric:call:${leadId}` },
          { text: '✅ Ya lo contacté',  callback_data: `ob_fric:ok:${leadId}`   },
        ]],
      },
    });
  }
}

// ── Iniciar onboarding para un lead ──────────────────────────────────────────
async function startOnboarding({ leadId, empresa, email, contacto, sector, colabs }) {
  if (!email) {
    console.warn('[onboarding] Sin email — no se puede iniciar secuencia');
    return false;
  }
  const now = Math.floor(Date.now() / 1000);
  const data = JSON.stringify({ leadId, empresa, email, contacto, sector, colabs, startedAt: now });

  await Promise.all([
    redisCmd('ZADD', 'onboardings', now, leadId),
    redisCmd('SET', `onboarding:${leadId}`, data, 'EX', 2592000 * 2), // 60 días
  ]);

  console.log(`[onboarding] Iniciado: ${empresa} (${leadId})`);
  await notify(`🎯 *Onboarding iniciado — ${empresa}*\n_Secuencia de 30 días activada para ${email}_`);
  return true;
}

// ── Procesar secuencia pendiente (cron) ───────────────────────────────────────
async function processSequences() {
  const nowTs = Math.floor(Date.now() / 1000);
  const token = await getGmailToken().catch(() => null);
  if (!token) {
    console.warn('[onboarding] Gmail token no disponible — secuencia pausada');
    return 0;
  }

  let total = 0;
  for (const seq of SEQUENCES) {
    const minTs = nowTs - seq.maxH * 3600;
    const maxTs = nowTs - seq.minH * 3600;
    const ids   = await redisCmd('ZRANGEBYSCORE', 'onboardings', minTs, maxTs);
    if (!ids?.length) continue;

    for (const leadId of ids) {
      const alreadySent = await redisCmd('GET', `${seq.key}:${leadId}`);
      if (alreadySent) continue;

      const raw = await redisCmd('GET', `onboarding:${leadId}`);
      if (!raw) continue;
      let d;
      try { d = JSON.parse(raw); } catch { continue; }
      if (!d.email) continue;

      const emailData = seq.key === 'ob_d1'
        ? { ...seq.build(d), bodyHtml: await personalizeD1(d) }
        : seq.build(d);
      const sent = await gmailSend(token, emailData);
      if (sent) {
        await redisCmd('SET', `${seq.key}:${leadId}`, '1', 'EX', 2592000);
        total++;
        console.log(`[onboarding] D+${seq.day} enviado: ${d.email} (${d.empresa})`);
        await notify(`📧 *Onboarding D+${seq.day} — ${d.empresa}*\n_Email enviado a ${d.email}_`);
      }
    }
  }
  // Detección de fricción: revisar onboardings activos en D+2 a D+5
  const activeIds = await redisCmd('ZRANGEBYSCORE', 'onboardings',
    nowTs - 5 * 24 * 3600, nowTs - 2 * 24 * 3600);
  for (const leadId of (activeIds || [])) {
    const raw = await redisCmd('GET', `onboarding:${leadId}`);
    if (!raw) continue;
    try {
      const d = JSON.parse(raw);
      await checkFriction(leadId, d, nowTs);
    } catch { /* continuar */ }
  }

  return total;
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // POST: trigger onboarding desde pandadoc-webhook u otro endpoint
  if (req.method === 'POST') {
    const authHeader = req.headers['authorization'];
    const secret     = req.body?.secret;
    if (authHeader !== `Bearer ${CRON_SECRET}` && secret !== CRON_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { leadId, empresa, email, contacto, sector, colabs } = req.body || {};
    if (!leadId || !email) {
      return res.status(400).json({ error: 'leadId y email son requeridos' });
    }

    try {
      const started = await startOnboarding({ leadId, empresa, email, contacto, sector, colabs });
      return res.status(200).json({ success: true, started });
    } catch (err) {
      console.error('[onboarding] POST error:', err.message);
      captureException(err, { path: '/api/onboarding', leadId });
      return res.status(500).json({ error: err.message });
    }
  }

  // GET: cron diario — procesa secuencias pendientes
  if (req.method === 'GET') {
    const authHeader = req.headers['authorization'];
    const secret     = req.query?.secret;
    if (authHeader !== `Bearer ${CRON_SECRET}` && secret !== CRON_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
      const total = await processSequences();
      console.log(`[onboarding] Cron OK — ${total} emails enviados`);
      return res.status(200).json({ success: true, emailsSent: total });
    } catch (err) {
      console.error('[onboarding] GET error:', err.message);
      captureException(err, { path: '/api/onboarding' });
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
