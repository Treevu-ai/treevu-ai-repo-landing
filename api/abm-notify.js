/**
 * api/abm-notify.js
 * Notificaciones internas ABM al chat de @treev_abm_bot
 * Tipos: ALTA (nuevo lead), BAJA (descartado), MODIFICACION (cambio de estado)
 */

import { SCORE_EMOJI } from './lib/constants.js';
import { sendMessage } from './lib/telegram.js';

const TIPO_HEADER = {
  ALTA:         '🆕 *ALTA — Nuevo lead*',
  BAJA:         '🗑️ *BAJA — Lead descartado*',
  MODIFICACION: '✏️ *MODIFICACIÓN — Lead actualizado*',
};

// Botones inline para actualizar estado en Notion (solo en ALTA)
// callback_data formato: "e:[notionId_sin_guiones]:[estado_codigo]"
function buildKeyboard(notionId) {
  if (!notionId) return undefined;
  const id = notionId.replace(/-/g, '');
  return {
    inline_keyboard: [[
      { text: '📨 Contactado', callback_data: `e:${id}:C` },
      { text: '📅 Reunión',    callback_data: `e:${id}:R` },
      { text: '❌ Descartar',  callback_data: `e:${id}:X` },
    ]],
  };
}

/**
 * Envía una notificación ABM al chat interno de Telegram.
 *
 * @param {'ALTA'|'BAJA'|'MODIFICACION'} type
 * @param {{
 *   nombre: string,
 *   empresa?: string,
 *   sector?: string,
 *   colaboradores?: string,
 *   objetivo?: string,
 *   score?: string,
 *   email?: string,
 *   estadoAnterior?: string,
 *   estadoNuevo?: string,
 *   notionId?: string,
 * }} data
 */
export async function sendAbmNotification(type, data) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ABM_CHAT_ID;

  if (!token || !chatId || chatId.startsWith('PENDIENTE')) {
    console.warn('[abm-notify] TELEGRAM_ABM_CHAT_ID no configurado — notificación omitida');
    return;
  }

  const header = TIPO_HEADER[type] || `📋 *${type}*`;
  const score  = data.score ? `${SCORE_EMOJI[data.score] || ''} ${data.score}` : null;

  const lines = [header, ''];
  if (data.nombre)        lines.push(`👤 ${data.nombre}`);
  if (data.empresa)       lines.push(`🏢 ${data.empresa}`);
  if (data.sector)        lines.push(`🏭 ${data.sector}`);
  if (data.colaboradores) lines.push(`👥 ${data.colaboradores} colaboradores`);
  if (data.objetivo)      lines.push(`🎯 ${data.objetivo}`);
  if (score)              lines.push(`📊 Score: ${score}`);
  if (data.email)         lines.push(`📧 ${data.email}`);

  if (type === 'MODIFICACION' && data.estadoAnterior && data.estadoNuevo) {
    lines.push(`🔄 ${data.estadoAnterior} → *${data.estadoNuevo}*`);
  }

  const horaLima = new Date().toLocaleTimeString('es-PE', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Lima',
  });
  lines.push('');
  lines.push(`_${horaLima} · Lima_`);

  const extra = (type === 'ALTA' && data.notionId)
    ? { reply_markup: buildKeyboard(data.notionId) }
    : {};

  // Notificaciones en tiempo real movidas al daily-summary para un único mensaje diario
  return;
}
