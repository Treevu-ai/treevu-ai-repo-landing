// ── api/reactivation.js ───────────────────────────────────────────────────────
// Cron job semanal: detecta leads fríos ALTO/MEDIO inactivos 45+ días y genera
// sugerencias de reactivación personalizadas (Claude) al chat interno ABM.
//
// Schedule: "0 14 * * 1" (lunes 9am Lima, 14:00 UTC)

import { NOTION, SCORE_EMOJI }  from './lib/constants.js';
import { getProp, notionQuery } from './lib/notion.js';
import { sendMessage }          from './lib/telegram.js';
import { askClaude }            from './lib/anthropic.js';
import { detectGender }         from './lib/validators.js';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_ABM_ID    = process.env.TELEGRAM_ABM_CHAT_ID;
const TELEGRAM_CEO_ID    = process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET        = process.env.CRON_SECRET;

const DIAS_INACTIVIDAD = 45;
const MAX_LEADS        = 5;

async function getLeadsFrios() {
  const hace45d = new Date(Date.now() - DIAS_INACTIVIDAD * 24 * 60 * 60 * 1000).toISOString();

  const filter = {
    and: [
      {
        or: [
          { property: 'Score', select: { equals: 'ALTO' } },
          { property: 'Score', select: { equals: 'MEDIO' } },
        ],
      },
      {
        or: [
          { property: 'Estado', select: { equals: 'Descartado' } },
          { property: 'Estado', select: { equals: 'Nuevo' } },
          { property: 'Estado', select: { equals: 'Contactado' } },
        ],
      },
      { timestamp: 'last_edited_time', last_edited_time: { before: hace45d } },
    ],
  };

  const sorts = [{ timestamp: 'last_edited_time', direction: 'ascending' }];
  const data  = await notionQuery(NOTION.CRM_DB, filter, MAX_LEADS, sorts);
  return data.results || [];
}

async function generateReactivationMessage(lead) {
  const nombre   = getProp(lead, 'Nombre y Cargo') || 'Sin nombre';
  const empresa  = getProp(lead, 'Empresa')        || '';
  const sector   = getProp(lead, 'Sector')         || 'empresa';
  const objetivo = getProp(lead, 'Objetivo')       || '';
  const score    = getProp(lead, 'Score')          || 'MEDIO';
  const estado   = getProp(lead, 'Estado')         || 'Nuevo';
  const diasInactivo = Math.floor(
    (Date.now() - new Date(lead.created_time).getTime()) / (1000 * 60 * 60 * 24)
  );
  const firstName  = nombre.split(/[\s,]+/)[0] || 'Hola';
  const genero     = detectGender(nombre);
  const dispuesto  = genero === 'F' ? 'dispuesta' : 'dispuesto';

  const system =
    `Eres el equipo de ventas de Treevü (Perú), redactando en nombre del fundador.\n` +
    `Tu tarea: generar mensajes cortos de reactivación para leads que no respondieron.\n\n` +
    `Contexto del producto:\n` +
    `- Treevü permite al equipo acceder a su propio salario antes del día de pago — sin costo para nadie\n` +
    `- Para el CFO: predice la caja 30 días antes, reduce la reserva hasta 45%, cero pasivo nuevo\n` +
    `- Para RRHH/CEO: renuncias por estrés financiero −40%, alertas de rotación 3 semanas antes\n` +
    `- El piloto Q2 cerró; el equipo mantiene lista de espera para Q3 — úsalo como contexto de "seguimiento natural", no lo menciones explícitamente\n\n` +
    `Reglas de formato:\n` +
    `- Elige el canal más natural para el perfil: Email (tono formal) o WhatsApp (directo y breve)\n` +
    `- Máximo 3 líneas\n` +
    `- Tono: directo, cálido, no insistente\n` +
    `- Español peruano\n` +
    `- Cierra siempre con una pregunta de 1 línea\n` +
    `- Responde SOLO con el mensaje listo para copiar, sin explicaciones ni etiquetas de canal`;

  const user =
    `Lead a reactivar:\n` +
    `- Nombre: ${firstName} (${nombre})\n` +
    `- Empresa: ${empresa || 'sin datos'}\n` +
    `- Sector: ${sector}\n` +
    `- Objetivo declarado: ${objetivo || 'no especificado'}\n` +
    `- Score: ${score}\n` +
    `- Último estado: ${estado}\n` +
    `- Días inactivo: ${diasInactivo}`;

  return askClaude(user, { system });
}

export default async function handler(req, res) {
  const authHeader   = req.headers['authorization'];
  const secret       = req.query?.secret;
  const isVercelCron = authHeader === `Bearer ${CRON_SECRET}`;
  const isManual     = secret && secret === CRON_SECRET;

  if (!isVercelCron && !isManual) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('[reactivation] Buscando leads fríos...');
    const leads = await getLeadsFrios();

    if (!leads.length) {
      console.log('[reactivation] Sin leads fríos para reactivar');
      return res.status(200).json({ success: true, reactivados: 0 });
    }

    const semana = new Date().toLocaleDateString('es-PE', {
      weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Lima',
    });
    const header = `♻️ *Reactivación semanal — ${leads.length} lead(s) fríos*\n` +
      `_${semana}_\n\nLeads ALTO/MEDIO sin actividad en +${DIAS_INACTIVIDAD} días. Sugerencias abajo 👇`;

    // Notificaciones Telegram movidas al daily-summary (8am) — un único mensaje diario
    console.log(`[reactivation] OK — ${leads.length} leads fríos (notificación vía daily-summary)`);
    return res.status(200).json({ success: true, reactivados: leads.length });

  } catch (err) {
    console.error('[reactivation] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
