// api/lib/telegram-keyboards.js — Keyboards inline compartidos entre bots
//
// Ambos bots (ceo-bot.js y abm-bot.js) usan los mismos keyboards post-meeting.
// Centralizado aquí para que un cambio de texto o callback_data se propague a ambos.

// Mapa de siguiente paso: key corta → valor interno
export const SIG_MAP = {
  d: 'diagnostico',
  n: 'nda',
  s: 'seguimiento',
  f: 'no_fit',
  c: 'cerrado',
};

// Labels para mostrar en Telegram
export const SIG_LABEL = {
  d: '🟢 Diagnóstico',
  n: '🔵 NDA',
  s: '🟡 Seguimiento',
  f: '❌ No fit',
  c: '✅ Cerrado',
};

/**
 * Keyboard de resultado post-reunión (siguiente paso del deal).
 * @param {string} leadId
 */
export function kbSiguiente(leadId) {
  return {
    inline_keyboard: [
      [{ text: SIG_LABEL.d, callback_data: `pm_sig:d:${leadId}` },
       { text: SIG_LABEL.n, callback_data: `pm_sig:n:${leadId}` }],
      [{ text: SIG_LABEL.s, callback_data: `pm_sig:s:${leadId}` },
       { text: SIG_LABEL.f, callback_data: `pm_sig:f:${leadId}` }],
      [{ text: SIG_LABEL.c, callback_data: `pm_sig:c:${leadId}` }],
    ],
  };
}

/**
 * Keyboard de nivel de interés del prospecto (1–5).
 * @param {string} leadId
 */
export function kbInteres(leadId) {
  return {
    inline_keyboard: [[
      { text: '1 😐', callback_data: `pm_int:1:${leadId}` },
      { text: '2 🙂', callback_data: `pm_int:2:${leadId}` },
      { text: '3 😊', callback_data: `pm_int:3:${leadId}` },
      { text: '4 🤩', callback_data: `pm_int:4:${leadId}` },
      { text: '5 🔥', callback_data: `pm_int:5:${leadId}` },
    ]],
  };
}

/**
 * Keyboard de propuesta comercial post-reunión.
 * @param {string} leadId
 */
export function kbPropuesta(leadId) {
  return {
    inline_keyboard: [[
      { text: '📄 Generar propuesta', callback_data: `pm_prop:${leadId}` },
      { text: '⏭ Omitir',            callback_data: `pm_skip:${leadId}` },
    ]],
  };
}
