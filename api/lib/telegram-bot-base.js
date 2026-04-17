// api/lib/telegram-bot-base.js — Factory de helpers Telegram por bot
// Uso: const { send, answer, edit } = createBotHelpers(TOKEN, CHAT_ID)

import { sendMessage, answerCallback, editMessage } from './telegram.js';
import { getState, setState, clearState } from './state.js';

/**
 * Crea helpers de Telegram vinculados a un token y chat específico.
 * @param {string} token - Bot token
 * @param {string|number} chatId - Chat ID de destino
 * @returns {{ send, answer, edit, getState, setState, clearState }}
 */
export function createBotHelpers(token, chatId) {
  return {
    send:   (text, extra = {})              => sendMessage(token, chatId, text, extra),
    answer: (callbackId, text = '')         => answerCallback(token, callbackId, text),
    edit:   (cId, msgId, text, extra = {})  => editMessage(token, cId, msgId, text, extra),
    getState:   (prefix) => getState(prefix, chatId),
    setState:   (prefix, state) => setState(prefix, chatId, state),
    clearState: (prefix) => clearState(prefix, chatId),
  };
}

/**
 * Valida que el mensaje o callback viene del chat autorizado.
 * @param {object} body - req.body de Telegram webhook
 * @param {string|number} authorizedChatId
 * @returns {boolean}
 */
export function isAuthorized(body, authorizedChatId) {
  const id = body.callback_query?.message?.chat?.id
    ?? body.message?.chat?.id;
  return String(id) === String(authorizedChatId);
}
