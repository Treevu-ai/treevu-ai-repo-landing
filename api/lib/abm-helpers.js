// api/lib/abm-helpers.js — Shared constants, bindings, and helpers for ABM bot modules

import { NOTION, PROGRAMA, CONFIG } from './constants.js';
import { sendMessage, answerCallback, editMessage } from './telegram.js';
import { askClaude } from './openai.js';
import { notionQuery, notionPatch, getProp } from './notion.js';

export const TOKEN   = CONFIG.TELEGRAM_ABM_BOT_TOKEN;
export const CHAT_ID = CONFIG.TELEGRAM_ABM_CHAT_ID;

export const NOTION_CRM_DB       = NOTION.CRM_DB;
export const NOTION_EJECUCION_DB = NOTION.EJECUCION_DB;
export const CUPOS_TOTAL         = PROGRAMA.CUPOS_TOTAL;
export const FECHA_CIERRE        = PROGRAMA.FECHA_CIERRE;
export const CALENDLY            = PROGRAMA.BOOKING;

export const ESTADO_CODES    = { C: 'Contactado', R: 'Reunion', P: 'Propuesta', X: 'Descartado' };
export const RESULTADO_CODES = { L: 'Propuesta', F: 'En cadencia', N: 'Descartado' };
export const RESULTADO_LABEL = { L: '📝 LOI enviado → Propuesta', F: '🔄 Follow-up pendiente', N: '❌ No interesó → Descartado' };
export const RESULTADO_SIG   = { L: 'diagnostico', F: 'seguimiento', N: 'no_fit' };

export const send             = (text, extra = {}) => sendMessage(TOKEN, CHAT_ID, text, extra);
export const _answerCallback  = (id, text = '')    => answerCallback(TOKEN, id, text);
export const _editMessage     = (chatId, msgId, text, extra = {}) => editMessage(TOKEN, chatId, msgId, text, extra);

export function _askClaude(promptOrOpts, maxTokens = 250) {
  if (typeof promptOrOpts === 'string') return askClaude(promptOrOpts, { maxTokens });
  const { system, user } = promptOrOpts;
  return askClaude(user, { system, maxTokens });
}

export function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00-05:00');
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
}

export async function autoFillFechas(empresaFiltro = null) {
  const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
  const filter = empresaFiltro
    ? { property: 'Empresa', title: { contains: empresaFiltro } }
    : { property: 'Día 1 (LinkedIn)', date: { is_empty: true } };

  const data  = await notionQuery(NOTION_EJECUCION_DB, filter, 50);
  const leads = data.results || [];
  let actualizados = 0;

  for (const lead of leads) {
    if (getProp(lead, 'Día 1 (LinkedIn)')) continue;
    await notionPatch(lead.id, {
      'Día 1 (LinkedIn)': { date: { start: hoy } },
      'Día 3 (Email)':    { date: { start: addDays(hoy, 2) } },
      'Día 7 (WhatsApp)': { date: { start: addDays(hoy, 6) } },
      'Estado':           { select: { name: 'En cadencia' } },
    });
    actualizados++;
  }
  return { actualizados, total: leads.length };
}

export async function triggerPreMeeting(leadId, fechaReunion) {
  try {
    await fetch('https://gettreevu.com/api/primera-reunion', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CONFIG.CRON_SECRET}` },
      body:    JSON.stringify({ action: 'pre-meeting', lead_id: leadId, fecha_reunion: fechaReunion || null }),
    });
    console.log(`[abm] pre-meeting triggered: ${leadId}`);
  } catch (err) { console.error('[abm] triggerPreMeeting error:', err.message); }
}

export async function triggerPostMeeting(leadId, notas) {
  try {
    await fetch('https://gettreevu.com/api/primera-reunion', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CONFIG.CRON_SECRET}` },
      body:    JSON.stringify({ action: 'post-meeting', lead_id: leadId, notas }),
    });
    console.log(`[abm] post-meeting triggered: ${leadId} → ${notas.siguiente_paso}`);
  } catch (err) { console.error('[abm] triggerPostMeeting error:', err.message); }
}
