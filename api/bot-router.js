// api/bot-router.js — Router unificado para todos los bots de Telegram
//
// Este router recibe TODOS los updates de los bots y los despacha:
//   · /api/ceo-bot  → ceo-bot.js  (CEO personal)
//   · /api/abm-bot  → abm-bot.js  (equipo ABM)
//   · /api/vu-bot   → telegram.js (VU público)
//
// Cada bot tiene su propio endpoint para mayor claridad.

import ceoHandler from './ceo-bot.js';
import abmHandler from './abm-bot.js';
import vuHandler from './telegram.js';
import { CONFIG } from './lib/constants.js';

// Chat IDs autorizados
const AUTHORIZED_CHATS = {
  CEO: CONFIG.TELEGRAM_CEO_CHAT_ID,
  ABM: CONFIG.TELEGRAM_ABM_CHAT_ID,
  // VU no tiene chat_id específico (público)
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  console.log('[bot-router] Request recibido', { pathname });

  // Extraer chat_id del update
  const chatId = String(
    body.message?.chat?.id          ||
    body.callback_query?.message?.chat?.id ||
    body.edited_message?.chat?.id   ||
    ''
  );

  // Determinar el bot por el pathname
  let bot = null;
  let handler = null;

  if (pathname === '/api/ceo-bot') {
    bot = 'CEO';
    handler = ceoHandler;

    // Validar chat_id para CEO
    if (chatId && chatId !== String(AUTHORIZED_CHATS.CEO)) {
      console.error('[bot-router] Chat no autorizado para CEO', { chatId, authorized: AUTHORIZED_CHATS.CEO });
      return res.status(403).json({ error: 'Unauthorized chat for CEO bot' });
    }
  } else if (pathname === '/api/abm-bot') {
    bot = 'ABM';
    handler = abmHandler;

    // Validar chat_id para ABM
    if (chatId && chatId !== String(AUTHORIZED_CHATS.ABM)) {
      console.error('[bot-router] Chat no autorizado para ABM', { chatId, authorized: AUTHORIZED_CHATS.ABM });
      return res.status(403).json({ error: 'Unauthorized chat for ABM bot' });
    }
  } else if (pathname === '/api/vu-bot') {
    bot = 'VU';
    handler = vuHandler;
    // VU no tiene validación de chat_id (público)
  } else {
    console.error('[bot-router] Pathname inválido', { pathname });
    return res.status(404).json({ error: 'Not found' });
  }

  console.log('[bot-router] Bot identificado', { bot, chatId });

  // Despachar al handler correspondiente
  try {
    console.log(`[bot-router] Despachando a ${bot.toLowerCase()}-bot.js`);
    return handler(req, res);
  } catch (err) {
    console.error('[bot-router] Error despachando al handler', { bot, error: err.message });
    return res.status(500).json({ error: 'Internal server error' });
  }
}