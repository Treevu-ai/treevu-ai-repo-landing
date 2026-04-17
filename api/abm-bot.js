/**
 * api/abm-bot.js — Webhook bidireccional de @treev_abm_bot
 *
 * Comandos CRM (Notion CRM unificado):
 *   /pipeline      →  resumen rápido (inbound + outbound)
 *   /buscar texto  →  busca leads por nombre o empresa
 *
 * Comandos ABM (base "🎯 EJECUCIÓN — 14 DÍAS"):
 *   /hoy           →  acciones de hoy según cadencia D1/D3/D7
 *   /manana        →  acciones del día siguiente
 *   /agenda        →  calendario completo 14 días
 *   /mensaje empresa → genera mensaje listo para copiar (Claude)
 *
 * Nota: WhatsApp removido del flujo automatizado — todos los envíos son manuales.
 */

import { CONFIG, checkEnvVars } from './lib/constants.js';
import { sendMessage, answerCallback } from './lib/telegram.js';
import { captureException } from './lib/sentry.js';
import * as ABM from './lib/abm-commands.js';

checkEnvVars(['TELEGRAM_ABM_BOT_TOKEN', 'TELEGRAM_ABM_CHAT_ID', 'NOTION_API_KEY'], 'abm-bot');

const TOKEN   = CONFIG.TELEGRAM_ABM_BOT_TOKEN;
const CHAT_ID = CONFIG.TELEGRAM_ABM_CHAT_ID;

const send = (text, extra = {}) => sendMessage(TOKEN, CHAT_ID, text, extra);




// ── Handler principal ──────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  const body = req.body || {};

  // ── Callbacks de botones inline ────────────────────────────────────────────
  if (body.callback_query) {
    const cq = body.callback_query;
    await answerCallback(TOKEN, cq.id);

    if (cq.data?.startsWith('e:')) {
      await ABM.handleEstadoButton(cq);
    } else if (cq.data?.startsWith('r:')) {
      await ABM.handleResultadoButton(cq);
    } else if (cq.data?.startsWith('menu:')) {
      const action = cq.data.split(':')[1];
      try {
        if      (action === 'hoy')        await ABM.handleHoy();
        else if (action === 'alertas')    await ABM.handleAlerta();
        else if (action === 'estado')     await ABM.handleEstado();
        else if (action === 'nextstep')   await ABM.handleNextStep();
        else if (action === 'bloqueantes') await ABM.handleBloqueantes();
        else if (action === 'decision')   await ABM.handleDecision();
        else if (action === 'reporte')    await ABM.handleReporte();
        else if (action === 'agenda')     await ABM.handleAgenda();
        else if (action === 'reunion')    await send('Usa `/reunion [empresa]` para registrar una reunión.\n_Ejemplo: `/reunion Alicorp`_');
        else if (action === 'resultado')  await send('Usa `/resultado [empresa]` para registrar el resultado.\n_Ejemplo: `/resultado Alicorp`_');
        else if (action === 'cuenta')     await ABM.handleCuenta();
        else if (action === 'autonomo')   await ABM.handleAutonomo();
        else if (action === 'inicio')     await ABM.handleHelp();
        else if (action === 'buscar')     await send('Escribe `/buscar [nombre o empresa]` para buscar en CRM y ABM.');
        else if (action === 'comandos')   await send(
          `*Todos los comandos:*\n\n` +
          `📊 \`/estado\` \`/alerta\` \`/reporte\` \`/nextstep\` \`/pipeline\`\n` +
          `🎯 \`/hoy\` \`/manana\` \`/agenda\`\n` +
          `🔄 \`/iniciar [empresa]\` \`/mensaje [empresa]\` \`/resultado [empresa]\` \`/reunion [empresa]\`\n` +
          `🔍 \`/buscar\` \`/leads\` \`/leads alto\` \`/leads reunion\` \`/contactos\`\n` +
          `📌 \`/actualizar [empresa] [estado]\`\n` +
          `📅 \`/cuenta\` \`/cronograma\` \`/bloqueantes\` \`/decision\`\n` +
          `🧠 \`/pregunta [consulta]\` \`/objecion [tipo]\`\n` +
          `⚙️ \`/compliance\` \`/partners\` \`/ml\` \`/gatereview 2|4|6\``
        );
      } catch (err) {
        console.error(`[abm-bot] menu:${action} error:`, err.message);
      }
    }
    return res.status(200).json({ ok: true });
  }

  // ── Comandos de texto ──────────────────────────────────────────────────────
  const message = body.message;
  if (!message?.text) return res.status(200).json({ ok: true });

  const text      = message.text.trim();
  const inChatId  = String(message.chat.id);


  // Procesar comando y luego responder — el Lambda permanece vivo durante el await.
  // Telegram espera hasta 5s; el timeout de Vercel serverless es 10s (plan gratuito).
  try {
    if (text === '/hoy')                              await ABM.handleHoy();
    else if (text === '/manana' || text === '/mañana') await ABM.handleManana();
    else if (text === '/agenda')                      await ABM.handleAgenda();
    else if (text.startsWith('/resultado'))           await ABM.handleResultado(text.replace('/resultado', '').trim());
    else if (text.startsWith('/reunion'))             await ABM.handleReunion(text.replace('/reunion', '').trim());
    else if (text.startsWith('/mensaje'))             await ABM.handleMensaje(text.replace('/mensaje', '').trim());
    else if (text.startsWith('/iniciar'))             await ABM.handleIniciar(text.replace('/iniciar', '').trim());
    else if (text.startsWith('/buscar'))              await ABM.handleBuscar(text.replace('/buscar', '').trim());
    else if (text === '/pipeline')                    await ABM.handlePipeline();
    else if (text.startsWith('/pregunta'))            await ABM.handlePregunta(text.replace('/pregunta', '').trim());
    // ── Command Center ────────────────────────────────────────────────────────
    else if (text === '/estado')                      await ABM.handleEstado();
    else if (text === '/alerta')                      await ABM.handleAlerta();
    else if (text === '/reporte')                     await ABM.handleReporte();
    else if (text === '/nextstep')                    await ABM.handleNextStep();
    else if (text === '/cronograma')                  await ABM.handleCronograma();
    else if (text === '/semana')                      await ABM.handleSemana(); // alias
    else if (text === '/bloqueantes')                 await ABM.handleBloqueantes();
    else if (text === '/decision')                    await ABM.handleDecision();
    else if (text.startsWith('/leads'))               await ABM.handleLeads(text.replace('/leads', '').trim().toLowerCase());
    else if (text === '/contactos')                   await ABM.handleContactos();
    else if (text.startsWith('/actualizar'))          await ABM.handleActualizar(text.replace('/actualizar', '').trim());
    else if (text === '/compliance')                  await ABM.handleCompliance();
    else if (text === '/partners')                    await ABM.handlePartners();
    else if (text === '/ml')                          await ABM.handleMl();
    else if (text.startsWith('/gatereview'))          await ABM.handleGatereview(text.replace('/gatereview', '').trim());
    else if (text === '/cuenta')                      await ABM.handleCuenta();
    else if (text.startsWith('/objecion'))            await ABM.handleObjecion(text.replace('/objecion', '').trim());
    else if (text === '/help' || text === '/start')    await ABM.handleHelp();
    else if (text === '/autonomo')                     await ABM.handleAutonomo();
  } catch (err) {
    console.error(`[abm-bot] handler error for "${text}":`, err.message);
    captureException(err, { text, chat_id: inChatId });
  }

  return res.status(200).json({ ok: true });
}
