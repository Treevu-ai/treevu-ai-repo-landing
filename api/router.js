// api/router.js — Telegram webhook unificado
//
// Recibe TODOS los updates del bot y los despacha:
//   · chat_id === TELEGRAM_CHAT_ID  → ceo-bot.js  (Ricardo personal)
//   · cualquier otro chat_id        → abm-bot.js  (equipo ABM)
//
// Webhook activo: https://gettreevu.com/api/router

import ceoHandler from './ceo-bot.js';
import abmHandler from './abm-bot.js';

const CEO_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};

  // Extraer chat_id de cualquier tipo de update
  const chatId = String(
    body.message?.chat?.id          ||
    body.callback_query?.message?.chat?.id ||
    body.edited_message?.chat?.id   ||
    ''
  );

  if (chatId && chatId === String(CEO_CHAT_ID)) {
    return ceoHandler(req, res);
  }

  return abmHandler(req, res);
}
