// api/lib/state.js — State machine genérico sobre Redis para bots de Telegram
//
// Uso:
//   import { getState, setState, clearState } from './state.js';
//   const state = await getState('ceobot', chatId);
//   await setState('ceobot', chatId, { step: 'awaiting_dolor' }, 3600);
//   await clearState('ceobot', chatId);

import { redisCmd } from './redis.js';

/**
 * @param {string} prefix — namespace del bot (ej: 'ceobot', 'abmbot')
 * @param {string|number} chatId
 * @returns {Promise<object|null>}
 */
export async function getState(prefix, chatId) {
  const raw = await redisCmd('GET', `${prefix}:${chatId}`);
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

/**
 * @param {string} prefix
 * @param {string|number} chatId
 * @param {object} state
 * @param {number} ttlSeconds — default 1 hora
 */
export async function setState(prefix, chatId, state, ttlSeconds = 3600) {
  await redisCmd('SET', `${prefix}:${chatId}`, JSON.stringify(state), 'EX', ttlSeconds);
}

/**
 * @param {string} prefix
 * @param {string|number} chatId
 */
export async function clearState(prefix, chatId) {
  await redisCmd('DEL', `${prefix}:${chatId}`);
}
