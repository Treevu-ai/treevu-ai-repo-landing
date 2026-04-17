// ── api/reactivation.js ───────────────────────────────────────────────────────
// Cron job semanal: detecta leads fríos ALTO/MEDIO inactivos 45+ días y genera
// sugerencias de reactivación personalizadas (Claude) al chat interno ABM.
//
// Schedule: "0 14 * * 1" (lunes 9am Lima, 14:00 UTC)

import { NOTION, SCORE_EMOJI, CONFIG } from './lib/constants.js';
import { getProp, notionQuery } from './lib/notion.js';
import { sendMessage }          from './lib/telegram.js';
import { askClaude }            from './lib/anthropic.js';
import { detectGender }         from './lib/validators.js';
import { REACTIVACION }         from './lib/prompts.js';

const TELEGRAM_BOT_TOKEN = CONFIG.TELEGRAM_BOT_TOKEN;
const TELEGRAM_ABM_ID    = CONFIG.TELEGRAM_ABM_CHAT_ID;
const TELEGRAM_CEO_ID    = CONFIG.TELEGRAM_CHAT_ID;
const CRON_SECRET        = CONFIG.CRON_SECRET;

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

  const system = REACTIVACION;

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

    const TARGET = TELEGRAM_ABM_ID || TELEGRAM_CEO_ID;
    await sendMessage(TELEGRAM_BOT_TOKEN, TARGET, header);

    // Genera todos los mensajes en paralelo y envía las cards simultáneamente
    const sugerencias = await Promise.allSettled(leads.map(l => generateReactivationMessage(l)));

    await Promise.all(leads.map(async (lead, i) => {
      const nombre       = getProp(lead, 'Nombre y Cargo') || 'Sin nombre';
      const empresa      = getProp(lead, 'Empresa')        || '';
      const score        = getProp(lead, 'Score')          || 'MEDIO';
      const estado       = getProp(lead, 'Estado')         || 'Nuevo';
      const email        = getProp(lead, 'Email')          || '';
      const diasInactivo = Math.floor(
        (Date.now() - new Date(lead.created_time).getTime()) / (1000 * 60 * 60 * 24)
      );
      const sugerencia = sugerencias[i].status === 'fulfilled' ? sugerencias[i].value : null;

      let card = `${SCORE_EMOJI[score] || '·'} *${nombre}*\n`;
      if (empresa)    card += `🏢 ${empresa}\n`;
      if (email)      card += `📧 ${email}\n`;
      card += `📌 ${estado} · _inactivo ${diasInactivo} días_\n`;
      if (sugerencia) card += `\n💬 *Sugerencia:*\n\`\`\`\n${sugerencia}\n\`\`\``;

      return sendMessage(TELEGRAM_BOT_TOKEN, TARGET, card);
    }));

    console.log(`[reactivation] OK — ${leads.length} sugerencias enviadas`);
    return res.status(200).json({ success: true, reactivados: leads.length });

  } catch (err) {
    console.error('[reactivation] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
