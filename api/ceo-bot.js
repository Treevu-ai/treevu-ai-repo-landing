// api/ceo-bot.js — Bot interno CEO (TELEGRAM_BOT_TOKEN)
//
// Maneja el flujo post-reunión cuando el CEO toca "Registrar resultado"
// en el briefing de primera-reunion.js.
//
// Setup (una sola vez después de deploy):
//   curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
//        -d "url=https://gettreevu.com/api/ceo-bot"

import { sendMessage, answerCallback, editMessage } from './lib/telegram.js';
import { redisCmd } from './lib/redis.js';

const BOT_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CEO_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET = process.env.CRON_SECRET;

async function getState(chatId) {
  const raw = await redisCmd('GET', `ceobot:${chatId}`);
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}
async function setState(chatId, state) {
  await redisCmd('SET', `ceobot:${chatId}`, JSON.stringify(state), 'EX', 3600);
}
async function clearState(chatId) {
  await redisCmd('DEL', `ceobot:${chatId}`);
}

// ── Telegram helpers ──────────────────────────────────────────────────────────
const send   = (id, text, extra = {}) => sendMessage(BOT_TOKEN, id, text, extra);
const answer = (id, text = '')        => answerCallback(BOT_TOKEN, id, text);
const edit   = (id, mid, text, ex={}) => editMessage(BOT_TOKEN, id, mid, text, ex);

// Siguiente_paso abreviado para callback_data (max 64 bytes)
// pm_sig:{d|n|s|f}:{lead_id} — ejemplo: pm_sig:d:331d7881-... (45 chars ✓)
const SIG_MAP = { d: 'diagnostico', n: 'nda', s: 'seguimiento', f: 'no_fit' };
const SIG_LABEL = { d: '🟢 Diagnóstico', n: '🔵 NDA', s: '🟡 Seguimiento', f: '❌ No fit' };

function kbSiguiente(leadId) {
  return {
    inline_keyboard: [
      [{ text: '🟢 Diagnóstico', callback_data: `pm_sig:d:${leadId}` },
       { text: '🔵 NDA',         callback_data: `pm_sig:n:${leadId}` }],
      [{ text: '🟡 Seguimiento', callback_data: `pm_sig:s:${leadId}` },
       { text: '❌ No fit',      callback_data: `pm_sig:f:${leadId}` }],
    ],
  };
}

function kbInteres(leadId) {
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

// ── Llamar a post-meeting ──────────────────────────────────────────────────────
async function callPostMeeting(lead_id, notas) {
  try {
    await fetch('https://gettreevu.com/api/primera-reunion', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CRON_SECRET}` },
      body:    JSON.stringify({ action: 'post-meeting', lead_id, notas }),
    });
    console.log(`[ceo-bot] post-meeting llamado: ${lead_id}`);
  } catch (err) {
    console.error('[ceo-bot] error llamando post-meeting:', err.message);
  }
}

// ── Completar flujo post-meeting ──────────────────────────────────────────────
async function completarPostMeeting(chatId, state) {
  await clearState(chatId);
  await callPostMeeting(state.lead_id, {
    siguiente_paso:  state.siguiente_paso,
    dolor_principal: state.dolor_principal || '',
    objeciones:      state.objeciones      || '',
    interes:         state.interes         || null,
    fecha_siguiente: state.fecha_siguiente || '',
  });
  const resumen = [
    `• Sig. paso: ${SIG_LABEL[Object.keys(SIG_MAP).find(k => SIG_MAP[k] === state.siguiente_paso)] || state.siguiente_paso}`,
    state.dolor_principal ? `• Dolor: _${state.dolor_principal}_` : null,
    state.objeciones      ? `• Objeciones: _${state.objeciones}_` : null,
    state.interes         ? `• Interés: ${state.interes}/5` : null,
    state.fecha_siguiente ? `• Próx. paso: ${state.fecha_siguiente}` : null,
  ].filter(Boolean).join('\n');
  await send(chatId, `✅ *Post-reunión registrado*\n\n${resumen}\n\n_Notion actualizado · follow-up en proceso_`);
}

// ── Handler principal ─────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  const body = req.body || {};

  try {
    // ── Callback query (botones inline) ──────────────────────────────────────
    if (body.callback_query) {
      const cq     = body.callback_query;
      const chatId = String(cq.message?.chat?.id);
      const data   = cq.data || '';
      const msgId  = cq.message?.message_id;

      await answer(cq.id);

      if (chatId !== String(CEO_CHAT_ID)) return res.status(200).json({ ok: true });

      // Iniciar flujo: CEO tocó "Registrar resultado"
      if (data.startsWith('pm_start:')) {
        const lead_id = data.slice(9);
        await setState(chatId, { step: 'awaiting_siguiente', lead_id });
        await edit(chatId, msgId, (cq.message.text || '') + '\n\n_✏️ Registrando resultado..._');
        await send(chatId, '*¿Cuál fue el resultado de la reunión?*', { reply_markup: kbSiguiente(lead_id) });
        return res.status(200).json({ ok: true });
      }

      // CEO seleccionó siguiente paso
      if (data.startsWith('pm_sig:')) {
        const parts       = data.split(':');
        const sigAbrev    = parts[1];
        const lead_id     = parts.slice(2).join(':');
        const sig         = SIG_MAP[sigAbrev] || 'seguimiento';
        const sigLabel    = SIG_LABEL[sigAbrev] || sig;

        await setState(chatId, { step: 'awaiting_dolor', lead_id, siguiente_paso: sig });
        await edit(chatId, msgId, `*Resultado: ${sigLabel}* ✓`);
        await send(chatId,
          `¿Cuál fue el *dolor principal* que mencionaron?\n_(Ej: "rotación 30%, piden adelantos al supervisor")_`
        );
        return res.status(200).json({ ok: true });
      }

      // CEO seleccionó nivel de interés
      if (data.startsWith('pm_int:')) {
        const parts   = data.split(':');
        const interes = parseInt(parts[1]) || 3;
        const lead_id = parts.slice(2).join(':');
        const state   = await getState(chatId);
        if (!state) return res.status(200).json({ ok: true });

        const needsFecha = ['diagnostico', 'nda'].includes(state.siguiente_paso);
        const nextStep   = needsFecha ? 'awaiting_fecha' : 'complete';

        await setState(chatId, { ...state, step: nextStep, interes });
        await edit(chatId, msgId, `*Interés: ${interes}/5* ✓`);

        if (needsFecha) {
          await send(chatId,
            `¿Cuándo es el próximo paso?\n_(Ej: "miércoles 2 de abril" — o /skip si no quedó definido)_`
          );
        } else {
          await completarPostMeeting(chatId, { ...state, interes });
        }
        return res.status(200).json({ ok: true });
      }

      return res.status(200).json({ ok: true });
    }

    // ── Mensaje de texto ──────────────────────────────────────────────────────
    const message = body.message;
    if (!message?.text) return res.status(200).json({ ok: true });

    const chatId = String(message.chat.id);
    if (chatId !== String(CEO_CHAT_ID)) return res.status(200).json({ ok: true });

    const text  = message.text.trim();
    const state = await getState(chatId);

    if (!state) return res.status(200).json({ ok: true });

    if (state.step === 'awaiting_dolor') {
      await setState(chatId, { ...state, step: 'awaiting_objeciones', dolor_principal: text });
      await send(chatId,
        `*Dolor registrado* ✓\n\n¿Alguna *objeción* mencionada?\n_(Ej: "necesitan NDA primero" — o /skip)_`
      );
      return res.status(200).json({ ok: true });
    }

    if (state.step === 'awaiting_objeciones') {
      const objeciones = text === '/skip' ? '' : text;
      await setState(chatId, { ...state, step: 'awaiting_interes', objeciones });
      await send(chatId, `¿Nivel de *interés* del prospecto? _(1 = frío · 5 = listo para firmar)_`,
        { reply_markup: kbInteres(state.lead_id) }
      );
      return res.status(200).json({ ok: true });
    }

    if (state.step === 'awaiting_fecha') {
      const fecha_siguiente = text === '/skip' ? '' : text;
      await completarPostMeeting(chatId, { ...state, fecha_siguiente });
      return res.status(200).json({ ok: true });
    }

  } catch (err) {
    console.error('[ceo-bot] error:', err.message);
  }

  return res.status(200).json({ ok: true });
}
