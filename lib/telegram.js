// ── lib/telegram.js ──────────────────────────────────────────────────────────
// Utilidades compartidas para Telegram

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

export async function sendTelegram(text, chatId = null, parseMode = 'Markdown') {
  const target = chatId || TELEGRAM_CHAT_ID;
  if (!TELEGRAM_BOT_TOKEN || !target) {
    console.warn('[telegram] No configurado');
    return null;
  }
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: target, text, parse_mode: parseMode })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Telegram ${res.status}: ${err}`);
  }
  return res.json();
}

// Trunca texto para no reventar el límite de Telegram (4096 chars)
export function truncate(text, max = 3800) {
  if (!text) return '';
  return text.length > max ? text.slice(0, max) + '…' : text;
}
