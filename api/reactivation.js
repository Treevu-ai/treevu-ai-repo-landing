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
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_ABM_CHAT_ID || process.env.TELEGRAM_CHAT_ID;
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
      { timestamp: 'created_time', created_time: { before: hace45d } },
    ],
  };

  const sorts = [{ timestamp: 'created_time', direction: 'ascending' }];
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

  const prompt =
    `Eres Ricardo Cuba, fundador de Treevü (EWA B2B2E, Perú). ` +
    `Genera un mensaje corto de reactivación para un lead que contactaste hace ${diasInactivo} días y no respondió (o fue descartado).\n\n` +
    `Lead:\n` +
    `- Nombre: ${firstName} (${nombre})\n` +
    `- Empresa: ${empresa || 'sin datos'}\n` +
    `- Sector: ${sector}\n` +
    `- Objetivo declarado: ${objetivo || 'no especificado'}\n` +
    `- Score: ${score}\n` +
    `- Último estado: ${estado}\n\n` +
    `Contexto: Treevü reduce rotación 30% y el stress financiero de colaboradores. ` +
    `El piloto Q2 ya cerró, pero el equipo mantiene una lista de espera para Q3. ` +
    `No menciones el cierre Q2, usa el contexto de "seguimiento" natural.\n\n` +
    `Instrucciones:\n` +
    `- Canal: Email o WhatsApp (tú decides cuál suena más natural para este perfil)\n` +
    `- Máximo 3 líneas\n` +
    `- Tono: directo, cálido, no insistente\n` +
    `- Español peruano\n` +
    `- Cierra con una pregunta de 1 línea\n\n` +
    `Responde SOLO con el mensaje listo para copiar. Sin explicaciones.`;

  return askClaude(prompt);
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
    await sendMessage(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
      `♻️ *Reactivación semanal — ${leads.length} lead(s) fríos*\n` +
      `_${semana}_\n\n` +
      `Leads ALTO/MEDIO sin actividad en +${DIAS_INACTIVIDAD} días. Sugerencias abajo 👇`
    );

    for (const lead of leads) {
      const nombre  = getProp(lead, 'Nombre y Cargo') || 'Sin nombre';
      const empresa = getProp(lead, 'Empresa')        || '';
      const score   = getProp(lead, 'Score')          || 'MEDIO';
      const estado  = getProp(lead, 'Estado')         || 'Nuevo';
      const email   = getProp(lead, 'Email')          || '';
      const dias    = Math.floor(
        (Date.now() - new Date(lead.created_time).getTime()) / (1000 * 60 * 60 * 24)
      );

      const mensaje = await generateReactivationMessage(lead);

      let card = `${SCORE_EMOJI[score] || '·'} *${nombre}*\n`;
      if (empresa) card += `🏢 ${empresa}\n`;
      if (email)   card += `📧 ${email}\n`;
      card += `📌 ${estado} · _inactivo ${dias} días_\n\n`;
      card += mensaje
        ? `💬 *Sugerencia:*\n\`\`\`\n${mensaje}\n\`\`\``
        : `_Sin sugerencia generada — revisa manualmente_`;

      await sendMessage(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, card);
    }

    console.log(`[reactivation] OK — ${leads.length} sugerencias enviadas`);
    return res.status(200).json({ success: true, reactivados: leads.length });

  } catch (err) {
    console.error('[reactivation] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
