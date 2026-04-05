// api/ceo-bot.js — Bot interno CEO (TELEGRAM_BOT_TOKEN)
//
// Responsabilidades de este archivo:
//   - State machine del flujo post-reunión (Redis)
//   - Keyboards inline
//   - Router principal (callbacks + mensajes de texto)
//
// Lógica de negocio delegada a:
//   - api/lib/ceo-deal.js     → propuesta, PandaDoc, cierre, post-meeting
//   - api/lib/ceo-commands.js → /pipeline, /sdr, /post, /tweet, /briefing, /enrich, Q&A

import { sendMessage, answerCallback, editMessage } from './lib/telegram.js';
import { redisCmd }                                  from './lib/redis.js';
import { NOTION, ESTADO_EMOJI, checkEnvVars }         from './lib/constants.js';

checkEnvVars(['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'CRON_SECRET'], 'ceo-bot');
import { handleCTO, clearCTOContext }                from './cto-bot.js';
import { postLinkedIn }                              from './lib/linkedin.js';
import { postInstagram }                             from './lib/instagram.js';

import {
  generateProposal, sendToPandaDoc,
  triggerCierre, completarPostMeeting,
} from './lib/ceo-deal.js';

import {
  handleHelp, handlePipeline, handleFollowup,
  handleSDR, handleBriefing, handlePost,
  handleTweet, handleEnrich, handleQA,
} from './lib/ceo-commands.js';

const BOT_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CEO_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET = process.env.CRON_SECRET;

// ── State ─────────────────────────────────────────────────────────────────────
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

// ── Keyboards ─────────────────────────────────────────────────────────────────
const SIG_MAP   = { d: 'diagnostico', n: 'nda', s: 'seguimiento', f: 'no_fit', c: 'cerrado' };
const SIG_LABEL = { d: '🟢 Diagnóstico', n: '🔵 NDA', s: '🟡 Seguimiento', f: '❌ No fit', c: '✅ Cerrado' };

function kbSiguiente(leadId) {
  return {
    inline_keyboard: [
      [{ text: '🟢 Diagnóstico', callback_data: `pm_sig:d:${leadId}` },
       { text: '🔵 NDA',         callback_data: `pm_sig:n:${leadId}` }],
      [{ text: '🟡 Seguimiento', callback_data: `pm_sig:s:${leadId}` },
       { text: '❌ No fit',      callback_data: `pm_sig:f:${leadId}` }],
      [{ text: '✅ Cerrado',     callback_data: `pm_sig:c:${leadId}` }],
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

function kbPropuesta(leadId) {
  return {
    inline_keyboard: [[
      { text: '📄 Generar propuesta', callback_data: `pm_prop:${leadId}` },
      { text: '⏭ Omitir',            callback_data: `pm_skip:${leadId}` },
    ]],
  };
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

      // ── Social publishing ─────────────────────────────────────────────────
      if (data.startsWith('ig_ok:')) {
        const draftKey = data.slice(6);
        await edit(chatId, msgId, (cq.message.text || '') + '\n\n_📤 Publicando en Instagram..._');
        try {
          const raw = await redisCmd('GET', draftKey);
          if (!raw) { await edit(chatId, msgId, '❌ El draft expiró (>5 min). Usá /post instagram de nuevo.'); return res.status(200).json({ ok: true }); }
          const { imageUrl, caption } = JSON.parse(raw);
          const result = await postInstagram(imageUrl, caption);
          await redisCmd('DEL', draftKey);
          await edit(chatId, msgId, `✅ *Publicado en Instagram*\n\n🔗 ${result.url}`, { parse_mode: 'Markdown' });
        } catch (err) { await edit(chatId, msgId, `❌ Instagram: ${err.message}`); }
        return res.status(200).json({ ok: true });
      }

      if (data === 'ig_cancel') {
        await edit(chatId, msgId, (cq.message.text || '') + '\n\n_📋 Copialo y publicalo manualmente._');
        return res.status(200).json({ ok: true });
      }

      if (data.startsWith('li_ok:')) {
        const draftKey = data.slice(6);
        await edit(chatId, msgId, (cq.message.text || '') + '\n\n_📤 Publicando en LinkedIn..._');
        try {
          const raw = await redisCmd('GET', draftKey);
          if (!raw) { await edit(chatId, msgId, '❌ El draft expiró (>5 min). Usá /post linkedin de nuevo.'); return res.status(200).json({ ok: true }); }
          const { urn, url } = await postLinkedIn(raw);
          await redisCmd('DEL', draftKey);
          await edit(chatId, msgId, `✅ *Publicado en LinkedIn*\n\n🔗 ${url}`, { parse_mode: 'Markdown' });
        } catch (err) { await edit(chatId, msgId, `❌ LinkedIn: ${err.message}`); }
        return res.status(200).json({ ok: true });
      }

      if (data === 'li_cancel') {
        await edit(chatId, msgId, (cq.message.text || '') + '\n\n_📋 Copialo y publicalo manualmente._');
        return res.status(200).json({ ok: true });
      }

      if (data.startsWith('tw_ok:')) {
        const draftKey = data.slice(6);
        await edit(chatId, msgId, (cq.message.text || '') + '\n\n_📤 Publicando..._');
        try {
          const raw = await redisCmd('GET', draftKey);
          if (!raw) { await edit(chatId, msgId, '❌ El draft expiró. Usá /tweet de nuevo.'); return res.status(200).json({ ok: true }); }
          const tweetRes  = await fetch('https://gettreevu.com/api/twitter-agent', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CRON_SECRET}` },
            body:   JSON.stringify({ action: 'publish', text: raw }),
          });
          const tweetData = await tweetRes.json();
          if (!tweetRes.ok || !tweetData.ok) throw new Error(tweetData.error || 'error al publicar');
          await redisCmd('DEL', draftKey);
          await edit(chatId, msgId, `✅ *Tweet publicado*\n\n_${raw}_\n\n🔗 ${tweetData.url || 'ver en X'}`, { parse_mode: 'Markdown' });
        } catch (err) { await edit(chatId, msgId, `❌ No se pudo publicar: ${err.message}`); }
        return res.status(200).json({ ok: true });
      }

      if (data === 'tw_cancel') {
        await edit(chatId, msgId, (cq.message.text || '') + '\n\n_❌ Tweet cancelado._');
        return res.status(200).json({ ok: true });
      }

      // ── Flujo post-meeting ────────────────────────────────────────────────
      if (data.startsWith('pm_start:')) {
        const lead_id = data.slice(9);
        await setState(chatId, { step: 'awaiting_siguiente', lead_id });
        await edit(chatId, msgId, (cq.message.text || '') + '\n\n_✏️ Registrando resultado..._');
        await send(chatId, '*¿Cuál fue el resultado de la reunión?*', { reply_markup: kbSiguiente(lead_id) });
        return res.status(200).json({ ok: true });
      }

      if (data.startsWith('pm_sig:')) {
        const parts    = data.split(':');
        const sigAbrev = parts[1];
        const lead_id  = parts.slice(2).join(':');
        const sig      = SIG_MAP[sigAbrev] || 'seguimiento';
        const sigLabel = SIG_LABEL[sigAbrev] || sig;
        await setState(chatId, { step: 'awaiting_dolor', lead_id, siguiente_paso: sig });
        await edit(chatId, msgId, `*Resultado: ${sigLabel}* ✓`);
        await send(chatId, `¿Cuál fue el *dolor principal* que mencionaron?\n_(Ej: "rotación 30%, piden adelantos al supervisor")_`);
        return res.status(200).json({ ok: true });
      }

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
          await send(chatId, `¿Cuándo es el próximo paso?\n_(Ej: "miércoles 2 de abril" — o /skip)_`);
        } else {
          await clearState(chatId);
          await completarPostMeeting(chatId, { ...state, interes }, send, kbPropuesta, SIG_LABEL, SIG_MAP);
        }
        return res.status(200).json({ ok: true });
      }

      if (data.startsWith('pm_prop:')) {
        const lead_id = data.slice(8);
        await edit(chatId, msgId, (cq.message.text || '') + '\n\n_📄 Generando propuesta..._');
        res.status(200).json({ ok: true });
        await generateProposal(lead_id, chatId, send);
        return;
      }

      if (data.startsWith('pm_skip:')) {
        await edit(chatId, msgId, (cq.message.text || '') + '\n\n_⏭ Propuesta omitida_');
        return res.status(200).json({ ok: true });
      }

      if (data.startsWith('pm_sign:')) {
        const lead_id = data.slice(8);
        await edit(chatId, msgId, (cq.message.text || '') + '\n\n_✍️ Enviando a PandaDoc..._');
        res.status(200).json({ ok: true });
        await sendToPandaDoc(lead_id, chatId, send);
        return;
      }

      if (data.startsWith('pm_nosign:')) {
        await edit(chatId, msgId, (cq.message.text || '') + '\n\n_📧 Quedó solo el borrador Gmail_');
        return res.status(200).json({ ok: true });
      }

      return res.status(200).json({ ok: true });
    }

    // ── Mensaje de texto ──────────────────────────────────────────────────────
    const message = body.message;
    if (!message?.text) return res.status(200).json({ ok: true });

    const chatId = String(message.chat.id);
    if (chatId !== String(CEO_CHAT_ID)) return res.status(200).json({ ok: true });

    const text = message.text.trim();

    // ── Comandos ──────────────────────────────────────────────────────────────
    if (text === '/help' || text === '/start') { await handleHelp(chatId, send);                                     return res.status(200).json({ ok: true }); }
    if (text === '/pipeline' || text === '/resumen') { await handlePipeline(chatId, send);                           return res.status(200).json({ ok: true }); }
    if (text === '/followup') { await handleFollowup(chatId, send);                                                  return res.status(200).json({ ok: true }); }
    if (text.startsWith('/sdr')) { await handleSDR(chatId, text.slice(4).trim(), send);                              return res.status(200).json({ ok: true }); }
    if (text === '/enrich') { await handleEnrich(chatId, send);                                                      return res.status(200).json({ ok: true }); }
    if (text.startsWith('/tweet')) { await handleTweet(chatId, text.slice(6).trim(), send);                          return res.status(200).json({ ok: true }); }
    if (text.startsWith('/briefing')) { await handleBriefing(chatId, text.slice(9).trim(), send);                    return res.status(200).json({ ok: true }); }
    if (text.startsWith('/post')) { await handlePost(chatId, text.slice(5).trim().toLowerCase() || null, send, edit); return res.status(200).json({ ok: true }); }

    if (text.startsWith('/cto')) {
      const query = text.slice(4).trim();
      if (!query || query === 'reset') {
        await clearCTOContext(chatId);
        await send(chatId, query === 'reset'
          ? '🔄 Contexto del CTO Agent reiniciado.'
          : 'Uso: `/cto <pregunta>`\n_Ej: /cto ¿cuánto tarda la integración con Buk?_',
          { parse_mode: 'Markdown' }
        );
      } else {
        await send(chatId, '_🧠 Consultando CTO Agent..._');
        await handleCTO(chatId, query, (text, opts) => send(chatId, text, opts));
      }
      return res.status(200).json({ ok: true });
    }

    // ── Flujo post-meeting (texto libre) ─────────────────────────────────────
    const state = await getState(chatId);

    if (!state) {
      if (!text.startsWith('/')) await handleQA(chatId, text, send);
      return res.status(200).json({ ok: true });
    }

    if (state.step === 'awaiting_dolor') {
      await setState(chatId, { ...state, step: 'awaiting_objeciones', dolor_principal: text });
      await send(chatId, `*Dolor registrado* ✓\n\n¿Alguna *objeción* mencionada?\n_(Ej: "necesitan NDA primero" — o /skip)_`);
      return res.status(200).json({ ok: true });
    }

    if (state.step === 'awaiting_objeciones') {
      const objeciones = text === '/skip' ? '' : text;
      await setState(chatId, { ...state, step: 'awaiting_interes', objeciones });
      await send(chatId, `¿Nivel de *interés* del prospecto? _(1 = frío · 5 = listo para firmar)_`, { reply_markup: kbInteres(state.lead_id) });
      return res.status(200).json({ ok: true });
    }

    if (state.step === 'awaiting_fecha') {
      const fecha_siguiente = text === '/skip' ? '' : text;
      await clearState(chatId);
      await completarPostMeeting(chatId, { ...state, fecha_siguiente }, send, kbPropuesta, SIG_LABEL, SIG_MAP);
      return res.status(200).json({ ok: true });
    }

  } catch (err) {
    console.error('[ceo-bot] error:', err.message);
  }

  return res.status(200).json({ ok: true });
}

export const config = { maxDuration: 60 };
