// api/setup-webhook.js — Configura el webhook de Telegram
//
// Uso:
//   GET /api/setup-webhook?token=ceo  → configura webhook para CEO bot
//   GET /api/setup-webhook?token=abm  → configura webhook para ABM bot
//   GET /api/setup-webhook?token=vu   → configura webhook para VU bot
//
// Webhook URLs:
//   CEO Bot:  https://gettreevu.com/api/ceo-bot
//   ABM Bot:  https://gettreevu.com/api/abm-bot
//   VU Bot:   https://gettreevu.com/api/vu-bot

import { CONFIG } from './lib/constants.js';

const WEBHOOK_URLS = {
  CEO: 'https://gettreevu.com/api/ceo-bot',
  ABM: 'https://gettreevu.com/api/abm-bot',
  VU:  'https://gettreevu.com/api/vu-bot',
};

const BOT_TOKENS = {
  CEO: CONFIG.TELEGRAM_CEO_BOT_TOKEN,
  ABM: CONFIG.TELEGRAM_ABM_BOT_TOKEN,
  VU:  CONFIG.TELEGRAM_VU_BOT_TOKEN,
};

const BOT_NAMES = {
  CEO: 'CEO Bot (ceo_treevubot)',
  ABM: 'ABM Bot (treevuabmbot)',
  VU:  'VU Bot (@treevubot)',
};

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { token } = req.query;

  if (!token) {
    return res.status(400).json({
      error: 'Missing token parameter',
      usage: 'GET /api/setup-webhook?token=ceo|abm|vu',
      available: ['ceo', 'abm', 'vu']
    });
  }

  // Determinar cuál bot configurar
  let botToken;
  let botName;
  let webhookUrl;

  if (token === 'ceo') {
    botToken = BOT_TOKENS.CEO;
    botName = BOT_NAMES.CEO;
    webhookUrl = WEBHOOK_URLS.CEO;
  } else if (token === 'abm') {
    botToken = BOT_TOKENS.ABM;
    botName = BOT_NAMES.ABM;
    webhookUrl = WEBHOOK_URLS.ABM;
  } else if (token === 'vu') {
    botToken = BOT_TOKENS.VU;
    botName = BOT_NAMES.VU;
    webhookUrl = WEBHOOK_URLS.VU;
  } else {
    return res.status(400).json({
      error: 'Invalid token parameter',
      valid: ['ceo', 'abm', 'vu']
    });
  }

  if (!botToken) {
    return res.status(500).json({ error: `${token.toUpperCase()}_BOT_TOKEN not configured in environment` });
  }

  try {
    // Configurar webhook
    const webhookRes = await fetch(
      `https://api.telegram.org/bot${botToken}/setWebhook`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: webhookUrl,
          drop_pending_updates: true
        })
      }
    );

    const webhookData = await webhookRes.json();

    if (!webhookData.ok) {
      return res.status(500).json({
        error: 'Failed to set webhook',
        details: webhookData
      });
    }

    // Verificar webhook info
    const infoRes = await fetch(
      `https://api.telegram.org/bot${botToken}/getWebhookInfo`
    );

    const infoData = await infoRes.json();

    return res.json({
      success: true,
      bot: botName,
      webhook_url: webhookUrl,
      webhook_info: infoData.result
    });

  } catch (err) {
    return res.status(500).json({
      error: 'Error configuring webhook',
      message: err.message
    });
  }
}