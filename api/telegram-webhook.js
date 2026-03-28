// ── api/telegram-webhook.js ───────────────────────────────────────────────────
// Panel de control del CEO vía comandos Telegram
//
// Setup: registrar webhook en Telegram con:
//   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://gettreevu.com/api/telegram-webhook"
//
// Comandos disponibles:
//   /help                                    → lista de comandos
//   /pipeline                                → estado del pipeline en tiempo real
//   /stats                                   → métricas de conversión
//   /reunion <email>                         → briefing pre-reunión
//   /resultado <email> <resultado> [notas]   → registrar resultado de reunión
//   /nextstep <email> <acción>               → registrar próximo paso
//   /score <email>                           → re-scorear un lead
//   /reactivar <email>                       → disparar reactivación

import { sendTelegram, truncate }               from '../lib/telegram.js';
import { getLeadByEmail, logEvent, updateLead,
         logScoreHistory, getPipelineMetrics }  from '../lib/supabase.js';
import { findLeadByEmail, updateLeadEstado }    from '../lib/notion.js';
import { scoreWithLLM, calcScoreFallback,
         applyBehavioralSignals, SECTOR_MAP,
         OBJ_MAP, SCORE_EMOJI }                 from '../lib/scoring.js';
import { llmCall }                              from '../lib/llm.js';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

// ── Verificación de origen ────────────────────────────────────────────────────
function isAuthorized(chatId) {
  if (!TELEGRAM_CHAT_ID) return true; // no configurado → aceptar (desarrollo)
  return String(chatId) === String(TELEGRAM_CHAT_ID);
}

// ── Reply helper ──────────────────────────────────────────────────────────────
async function reply(chatId, text) {
  return sendTelegram(truncate(text), chatId);
}

// ── Comandos ──────────────────────────────────────────────────────────────────

async function cmdHelp(chatId) {
  const msg = `🤖 *Treevü Revenue Engine*\n\n*Comandos disponibles:*\n\n` +
    `/pipeline — estado del pipeline\n` +
    `/stats — métricas de conversión\n` +
    `/reunion <email> — briefing pre-reunión\n` +
    `/resultado <email> ganado|perdido|seguimiento|no\\_show [notas] — registrar resultado\n` +
    `/nextstep <email> <acción> — registrar próximo paso\n` +
    `/score <email> — re-scorear lead\n` +
    `/reactivar <email> — disparar reactivación`;
  return reply(chatId, msg);
}

async function cmdPipeline(chatId) {
  let msg = `📊 *Pipeline Treevü — ahora mismo*\n\n`;
  try {
    const m = await getPipelineMetrics();
    if (!m) {
      msg += '_Supabase no configurado. Consultando Notion..._';
      return reply(chatId, msg);
    }
    msg += `*Total leads: ${m.total}*\n`;
    msg += `🔥 ALTO: ${m.byScore.ALTO || 0}  🟡 MEDIO: ${m.byScore.MEDIO || 0}  🔵 BAJO: ${m.byScore.BAJO || 0}\n\n`;
    msg += `*Por estado:*\n`;
    const iconos = {
      'Nuevo': '🆕', 'Contactado': '📨', 'Reunión agendada': '📅',
      'En evaluación': '🔍', 'Propuesta enviada': '📄',
      'Piloto activo': '🚀', 'Firmado': '✅', 'Descartado': '❌'
    };
    for (const [estado, count] of Object.entries(m.byEstado)) {
      msg += `${iconos[estado] || '·'} ${estado}: ${count}\n`;
    }
    msg += `\n*Métricas:*\n`;
    msg += `📈 Lead → Reunión: ${m.convLeadToMeeting}%\n`;
    msg += `🏆 Win rate: ${m.winRate}%\n`;
    msg += `⏱ Tiempo promedio lead→reunión: ${m.avgDaysToMeeting} días\n`;
    msg += `\n💼 Reuniones completadas: ${m.meetingsDone} | Ganadas: ${m.won} | Perdidas: ${m.lost}`;
  } catch (err) {
    msg += `_Error: ${err.message}_`;
  }
  return reply(chatId, msg);
}

async function cmdStats(chatId) {
  let msg = `📈 *Métricas de conversión — Treevü*\n\n`;
  try {
    const m = await getPipelineMetrics();
    if (!m) { return reply(chatId, msg + '_Supabase no configurado._'); }
    msg += `*Funnel de conversión:*\n`;
    msg += `Leads totales: *${m.total}*\n`;
    msg += `↳ Con reunión: *${m.meetingsScheduled}* (${m.convLeadToMeeting}%)\n`;
    msg += `↳ Reuniones completadas: *${m.meetingsDone}*\n`;
    msg += `↳ Ganados: *${m.won}* · Perdidos: *${m.lost}*\n`;
    msg += `\n*Win rate general: ${m.winRate}%*\n`;
    msg += `⏱ Tiempo promedio lead→reunión: ${m.avgDaysToMeeting} días\n`;
    msg += `\n_Nota: métricas en tiempo real desde Supabase_`;
  } catch (err) {
    msg += `_Error: ${err.message}_`;
  }
  return reply(chatId, msg);
}

async function cmdReunion(chatId, args) {
  const email = args[0]?.toLowerCase();
  if (!email) return reply(chatId, '❌ Uso: `/reunion <email>`');

  await reply(chatId, `⏳ Generando briefing para ${email}...`);

  const lead = await getLeadByEmail(email);
  if (!lead) {
    return reply(chatId, `❌ Lead no encontrado: ${email}\n_¿Está en Supabase?_`);
  }

  const system = `Eres el asistente de ventas de Treevü. Genera briefings concisos y accionables pre-reunión.
Formato: secciones cortas, bullets, tono ejecutivo. Máximo 400 palabras.`;

  const user = `Genera briefing pre-reunión para este lead:
- Nombre: ${lead.nombre}
- Empresa: ${lead.empresa}
- Sector: ${SECTOR_MAP[lead.sector] || lead.sector}
- Colaboradores: ${lead.colaboradores}
- Objetivo: ${OBJ_MAP[lead.objetivo] || lead.objetivo}
- Reto declarado: ${lead.problema || 'No especificado'}
- Score: ${lead.score} (${lead.probabilidad}%)
- Estado: ${lead.estado}
- Análisis previo: ${lead.razon || 'No disponible'}
- Señales positivas: ${JSON.stringify(lead.señales_positivas || [])}
- Señales negativas: ${JSON.stringify(lead.señales_negativas || [])}

Incluye:
1. CONTEXTO DEL LEAD (2-3 bullets clave)
2. DOLOR PRINCIPAL (qué les duele más)
3. OBJECIONES PROBABLES (2-3 con respuesta sugerida)
4. APERTURA RECOMENDADA (1 oración)
5. OBJETIVO DE LA REUNIÓN (qué lograr en 30 min)`;

  try {
    const briefing = await llmCall({ task: 'meeting-briefing', system, user, model: 'claude_sonnet', maxTokens: 800 });
    const msg = `📋 *Briefing: ${lead.nombre} — ${lead.empresa}*\n\n${briefing}\n\n_${SCORE_EMOJI[lead.score]} ${lead.score} · ${lead.probabilidad}% prob._`;
    await logEvent(email, 'briefing_generated', { lead_id: lead.id }, { leadId: lead.id });
    return reply(chatId, msg);
  } catch (err) {
    return reply(chatId, `❌ Error generando briefing: ${err.message}`);
  }
}

async function cmdResultado(chatId, args) {
  // /resultado <email> <ganado|perdido|seguimiento|no_show> [notas...]
  const email     = args[0]?.toLowerCase();
  const resultado = args[1]?.toLowerCase();
  const notas     = args.slice(2).join(' ') || '';

  const resultadosValidos = ['ganado', 'perdido', 'seguimiento', 'no_show'];
  if (!email || !resultadosValidos.includes(resultado)) {
    return reply(chatId,
      `❌ Uso: \`/resultado <email> <ganado|perdido|seguimiento|no_show> [notas]\``
    );
  }

  const lead = await getLeadByEmail(email);
  if (!lead) return reply(chatId, `❌ Lead no encontrado: ${email}`);

  // 1. Registrar en Supabase
  const nuevoEstado = {
    ganado:      'Piloto activo',
    perdido:     'Descartado',
    seguimiento: 'En evaluación',
    no_show:     'Contactado'
  }[resultado];

  await Promise.all([
    updateLead(email, { estado: nuevoEstado }),
    logEvent(email, 'meeting_result', { resultado, notas, estado_anterior: lead.estado, nuevo_estado: nuevoEstado },
      { leadId: lead.id, stageFrom: lead.estado, stageTo: nuevoEstado })
  ]);

  // 2. Actualizar Notion
  try {
    const notionLead = await findLeadByEmail(email);
    if (notionLead) {
      const notaNotion = `Reunión ${resultado}. ${notas ? notas + '.' : ''} Actualizado desde Telegram.`;
      await updateLeadEstado(notionLead.id, nuevoEstado, notaNotion);
    }
  } catch (err) {
    console.error('[telegram-webhook] Notion update error:', err.message);
  }

  // 3. Guardar en learning_data
  try {
    const { sbInsert } = await import('../lib/supabase.js');
    const diasDesdeCreacion = lead.created_at
      ? Math.floor((Date.now() - new Date(lead.created_at)) / 86400000)
      : null;
    await sbInsert('learning_data', {
      lead_id:               lead.id,
      sector:                lead.sector,
      colaboradores:         lead.colaboradores,
      objetivo:              lead.objetivo,
      score_inicial:         lead.score,
      probabilidad_inicial:  lead.probabilidad,
      dias_hasta_reunion:    diasDesdeCreacion,
      result:                resultado,
      converted:             resultado === 'ganado'
    });
  } catch (err) {
    console.error('[telegram-webhook] learning_data error:', err.message);
  }

  // 4. Generar follow-up con Claude
  await reply(chatId, `✅ Resultado *${resultado}* registrado para ${lead.empresa}\n⏳ Generando follow-up...`);

  try {
    const system = `Eres el asistente de ventas de Treevü. Genera mensajes de seguimiento post-reunión concisos y directos.
Tono: profesional, cálido, ejecutivo. Sin relleno. Máximo 150 palabras.`;

    const followUpPrompts = {
      ganado:      `Lead ganado. Genera mensaje de bienvenida/onboarding para ${lead.empresa}. Notas: ${notas || 'N/A'}`,
      perdido:     `Lead perdido. Genera mensaje de cierre elegante para ${lead.empresa} que deje la puerta abierta. Notas: ${notas || 'N/A'}`,
      seguimiento: `Reunión con seguimiento pendiente. Genera mensaje de follow-up para ${lead.empresa} con próximo paso claro. Notas: ${notas || 'N/A'}`,
      no_show:     `No se presentó. Genera mensaje de re-agendamiento para ${lead.empresa}. Notas: ${notas || 'N/A'}`
    };

    const followUp = await llmCall({
      task:  'post-meeting-followup',
      system,
      user:  `${followUpPrompts[resultado]}\n\nDatos del lead:\n- Nombre: ${lead.nombre}\n- Sector: ${SECTOR_MAP[lead.sector] || lead.sector}\n- Objetivo: ${OBJ_MAP[lead.objetivo] || lead.objetivo}`,
      model: 'claude_haiku',
      maxTokens: 400
    });

    const emoji = { ganado: '🎉', perdido: '🤝', seguimiento: '📅', no_show: '🔄' }[resultado];
    const msg = `${emoji} *Follow-up sugerido para ${lead.nombre}:*\n\n${followUp}\n\n_Copia y envía desde tu email (hello@gettreevu.com)_`;
    await reply(chatId, msg);

    await logEvent(email, 'followup_generated', { resultado, follow_up: followUp }, { leadId: lead.id });
  } catch (err) {
    await reply(chatId, `⚠️ Resultado registrado. Error en follow-up: ${err.message}`);
  }
}

async function cmdNextstep(chatId, args) {
  const email  = args[0]?.toLowerCase();
  const accion = args.slice(1).join(' ');
  if (!email || !accion) {
    return reply(chatId, '❌ Uso: `/nextstep <email> <acción>`');
  }

  const lead = await getLeadByEmail(email);
  if (!lead) return reply(chatId, `❌ Lead no encontrado: ${email}`);

  await Promise.all([
    updateLead(email, { estado: 'Contactado' }),
    logEvent(email, 'nextstep_logged', { accion }, { leadId: lead.id })
  ]);

  // Actualizar score con señal de contacto manual
  const { newProb, newScore, delta, applied } = applyBehavioralSignals(lead.probabilidad || 50, {
    manual_contact_logged: true
  });

  if (delta !== 0) {
    await Promise.all([
      updateLead(email, { probabilidad: newProb, score: newScore }),
      logScoreHistory(email, lead.id, newScore, newProb, 'behavioral', { contact_manual: true, applied })
    ]);
  }

  const msg = `✅ *Next step registrado*\n\n🏢 ${lead.empresa}\n📧 ${email}\n📝 Acción: ${accion}` +
    (delta !== 0 ? `\n\n🎯 Score actualizado: ${SCORE_EMOJI[newScore]} ${newScore} (${newProb}%, ${delta > 0 ? '+' : ''}${delta}pts)` : '');
  return reply(chatId, msg);
}

async function cmdScore(chatId, args) {
  const email = args[0]?.toLowerCase();
  if (!email) return reply(chatId, '❌ Uso: `/score <email>`');

  const lead = await getLeadByEmail(email);
  if (!lead) return reply(chatId, `❌ Lead no encontrado: ${email}`);

  await reply(chatId, `⏳ Re-scoreando ${lead.empresa}...`);

  let result;
  let fuente = 'claude';
  try {
    result = await scoreWithLLM({
      nombre:        lead.nombre,
      empresa:       lead.empresa,
      sector:        lead.sector,
      colaboradores: lead.colaboradores,
      objetivo:      lead.objetivo,
      problema:      lead.problema
    });
  } catch {
    result = calcScoreFallback(lead.sector, lead.colaboradores, lead.objetivo);
    fuente = 'fallback';
  }

  await Promise.all([
    updateLead(email, {
      score:        result.score,
      probabilidad: result.probabilidad,
      razon:        result.razon
    }),
    logScoreHistory(email, lead.id, result.score, result.probabilidad, fuente, {
      señales_positivas: result.señales_positivas,
      señales_negativas: result.señales_negativas
    }),
    logEvent(email, 'lead_rescored', { fuente, score: result.score, probabilidad: result.probabilidad }, { leadId: lead.id })
  ]);

  const emoji = SCORE_EMOJI[result.score] || '⚪';
  const msg = `${emoji} *Re-score: ${lead.empresa}*\n\n` +
    `Score: *${result.score}* (${result.probabilidad}%)\n` +
    `Fuente: ${fuente}\n\n` +
    `📊 ${result.razon}\n\n` +
    `🚀 *Acción:* ${result.accion}`;
  return reply(chatId, msg);
}

async function cmdReactivar(chatId, args) {
  const email = args[0]?.toLowerCase();
  if (!email) return reply(chatId, '❌ Uso: `/reactivar <email>`');

  const lead = await getLeadByEmail(email);
  if (!lead) return reply(chatId, `❌ Lead no encontrado: ${email}`);

  if (['Piloto activo', 'Firmado'].includes(lead.estado)) {
    return reply(chatId, `⚠️ ${lead.empresa} ya está en estado *${lead.estado}* — no necesita reactivación.`);
  }

  const system = `Eres el asistente de ventas de Treevü. Genera mensajes de reactivación directos y con valor.
No uses frases genéricas como "espero que estés bien". Ofrece algo concreto. Máximo 120 palabras.`;

  const daysSince = lead.updated_at
    ? Math.floor((Date.now() - new Date(lead.updated_at)) / 86400000)
    : 30;

  try {
    const msg_text = await llmCall({
      task: 'reactivation',
      system,
      user: `Genera mensaje de reactivación para ${lead.nombre} de ${lead.empresa}.
Sector: ${SECTOR_MAP[lead.sector] || lead.sector}
Objetivo: ${OBJ_MAP[lead.objetivo] || lead.objetivo}
Días sin contacto: ${daysSince}
Último estado: ${lead.estado}
Contexto: ${lead.razon || 'Lead interesado anteriormente en Treevü EWA'}`,
      model: 'claude_haiku',
      maxTokens: 350
    });

    await Promise.all([
      logEvent(email, 'reactivation_triggered', { days_since: daysSince }, { leadId: lead.id }),
      updateLead(email, { estado: 'Contactado' })
    ]);

    const msg = `🔄 *Mensaje de reactivación — ${lead.empresa}:*\n\n${msg_text}\n\n` +
      `_Envía desde hello@gettreevu.com a ${email}_`;
    return reply(chatId, msg);
  } catch (err) {
    return reply(chatId, `❌ Error: ${err.message}`);
  }
}

// ── Router principal ──────────────────────────────────────────────────────────

const COMMAND_HANDLERS = {
  '/help':      cmdHelp,
  '/pipeline':  cmdPipeline,
  '/stats':     cmdStats,
  '/reunion':   cmdReunion,
  '/resultado': cmdResultado,
  '/nextstep':  cmdNextstep,
  '/score':     cmdScore,
  '/reactivar': cmdReactivar
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Responder 200 inmediatamente a Telegram (evita retries)
  res.status(200).json({ ok: true });

  const update  = req.body || {};
  const message = update.message || update.edited_message;
  if (!message?.text) return;

  const chatId = message.chat?.id;
  const text   = message.text?.trim() || '';

  if (!isAuthorized(chatId)) {
    console.warn(`[telegram-webhook] Chat no autorizado: ${chatId}`);
    return;
  }

  // Parsear comando: "/comando@botname args" → command + args
  const [rawCmd, ...args] = text.split(' ');
  const cmd = rawCmd.split('@')[0].toLowerCase(); // elimina @botname si existe

  console.log(`[telegram-webhook] Comando: ${cmd} | Args: ${args.join(' ')} | Chat: ${chatId}`);

  const handler_fn = COMMAND_HANDLERS[cmd];
  if (!handler_fn) {
    if (cmd.startsWith('/')) {
      await sendTelegram(`❓ Comando desconocido: ${cmd}\nEscribe /help para ver los disponibles.`, chatId);
    }
    return;
  }

  try {
    await handler_fn(chatId, args);
  } catch (err) {
    console.error(`[telegram-webhook] Error en ${cmd}:`, err.message);
    try {
      await sendTelegram(`❌ Error ejecutando ${cmd}: ${err.message}`, chatId);
    } catch {}
  }
}
