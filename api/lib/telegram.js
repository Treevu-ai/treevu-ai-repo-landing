// api/lib/telegram.js — Helper centralizado para Telegram Bot API

// Escapa caracteres especiales de Markdown V1 en datos de usuarios
// (nombres, empresas, emails) para evitar mensajes rotos
export function escapeMd(str) {
  return String(str || '').replace(/[_*`[]/g, '\\$&');
}

// Llama a cualquier método de la Bot API
export async function tg(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) console.error(`[tg] ${method} error:`, data.description || JSON.stringify(data));
  return data;
}

// Envía un mensaje de texto a un chat
export async function sendMessage(token, chatId, text, extra = {}) {
  return tg(token, 'sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown', ...extra });
}

// Responde a un callback query (botones inline)
export async function answerCallback(token, callbackQueryId, text = '') {
  return tg(token, 'answerCallbackQuery', { callback_query_id: callbackQueryId, text });
}

// Edita un mensaje existente
export async function editMessage(token, chatId, messageId, text, extra = {}) {
  return tg(token, 'editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'Markdown', ...extra });
}

// Envía acción de "escribiendo..."
export async function sendTyping(token, chatId) {
  return tg(token, 'sendChatAction', { chat_id: chatId, action: 'typing' });
}
