/**
 * api/abm-notify.js
 * Notificaciones internas ABM al chat de @treev_abm_bot
 * Tipos: ALTA (nuevo lead), BAJA (descartado), MODIFICACION (cambio de estado)
 * Incluye botones inline para actualizar Notion directamente desde Telegram.
 */

const SCORE_EMOJI = { ALTO: '🔥', MEDIO: '🟡', BAJO: '🔵' };

const TIPO_HEADER = {
  ALTA:         '🆕 *ALTA — Nuevo lead*',
  BAJA:         '🗑️ *BAJA — Lead descartado*',
  MODIFICACION: '✏️ *MODIFICACIÓN — Lead actualizado*',
};

// Botones inline para actualizar estado en Notion (solo en ALTA)
// callback_data formato: "e:[notionId_sin_guiones]:[estado_codigo]"
// Códigos: C=Contactado, R=Reunion, P=Propuesta, X=Descartado
function buildKeyboard(notionId) {
  if (!notionId) return undefined;
  const id = notionId.replace(/-/g, ''); // quitar guiones para caber en 64 bytes
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

  const body = {
    chat_id:    chatId,
    text:       lines.join('\n'),
    parse_mode: 'Markdown',
  };

  // Botones solo en ALTA y si tenemos el ID de Notion
  if (type === 'ALTA' && data.notionId) {
    body.reply_markup = buildKeyboard(data.notionId);
  }

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`[abm-notify] Telegram error ${res.status}: ${err}`);
  }

  return res.json();
}
