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

import { NOTION, PROGRAMA, SCORE_EMOJI, ESTADO_EMOJI } from './lib/constants.js';
import { getProp, restoreId, notionQuery, notionPatch } from './lib/notion.js';
import { tg, sendMessage, answerCallback, editMessage } from './lib/telegram.js';
import { askClaude }                                    from './lib/anthropic.js';
import { captureException }                             from './lib/sentry.js';
import { redisCmd }                                     from './lib/redis.js';

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_ABM_CHAT_ID;

const NOTION_CRM_DB       = NOTION.CRM_DB;
const NOTION_EJECUCION_DB = NOTION.EJECUCION_DB;
const CUPOS_TOTAL         = PROGRAMA.CUPOS_TOTAL;
const FECHA_CIERRE        = PROGRAMA.FECHA_CIERRE;
const CALENDLY            = PROGRAMA.CALENDLY;

const ESTADO_CODES    = { C: 'Contactado', R: 'Reunion', P: 'Propuesta', X: 'Descartado' };
const RESULTADO_CODES = { L: 'Propuesta', F: 'En cadencia', N: 'Descartado' };
const RESULTADO_LABEL = { L: '📝 LOI enviado → Propuesta', F: '🔄 Follow-up pendiente', N: '❌ No interesó → Descartado' };

// Siguiente_paso que corresponde a cada código de resultado ABM
const RESULTADO_SIG   = { L: 'diagnostico', F: 'seguimiento', N: 'no_fit' };

// ── Triggers a primera-reunion.js ─────────────────────────────────────────────
async function triggerPreMeeting(leadId, fechaReunion) {
  try {
    await fetch('https://gettreevu.com/api/primera-reunion', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.CRON_SECRET}` },
      body:    JSON.stringify({ action: 'pre-meeting', lead_id: leadId, fecha_reunion: fechaReunion || null }),
    });
    console.log(`[abm-bot] pre-meeting triggered: ${leadId}`);
  } catch (err) { console.error('[abm-bot] triggerPreMeeting error:', err.message); }
}

async function triggerPostMeeting(leadId, notas) {
  try {
    await fetch('https://gettreevu.com/api/primera-reunion', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.CRON_SECRET}` },
      body:    JSON.stringify({ action: 'post-meeting', lead_id: leadId, notas }),
    });
    console.log(`[abm-bot] post-meeting triggered: ${leadId} → ${notas.siguiente_paso}`);
  } catch (err) { console.error('[abm-bot] triggerPostMeeting error:', err.message); }
}

// Helper local: envía al chat ABM (binding fijo de CHAT_ID)
async function send(text, extra = {}) {
  return sendMessage(TOKEN, CHAT_ID, text, extra);
}

// ── CEO bot: post-meeting (fusionado — mismo TELEGRAM_BOT_TOKEN) ──────────────
const CEO_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function getCeoState(chatId) {
  const raw = await redisCmd('GET', `ceobot:${chatId}`);
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}
async function setCeoState(chatId, state) {
  await redisCmd('SET', `ceobot:${chatId}`, JSON.stringify(state), 'EX', 3600);
}
async function clearCeoState(chatId) {
  await redisCmd('DEL', `ceobot:${chatId}`);
}

const PM_SIG_MAP   = { d: 'diagnostico', n: 'nda', s: 'seguimiento', f: 'no_fit' };
const PM_SIG_LABEL = { d: '🟢 Diagnóstico', n: '🔵 NDA', s: '🟡 Seguimiento', f: '❌ No fit' };

function kbSiguientePM(leadId) {
  return {
    inline_keyboard: [
      [{ text: '🟢 Diagnóstico', callback_data: `pm_sig:d:${leadId}` },
       { text: '🔵 NDA',         callback_data: `pm_sig:n:${leadId}` }],
      [{ text: '🟡 Seguimiento', callback_data: `pm_sig:s:${leadId}` },
       { text: '❌ No fit',      callback_data: `pm_sig:f:${leadId}` }],
    ],
  };
}

function kbInteresPM(leadId) {
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

async function completarCeoPostMeeting(chatId, state) {
  await clearCeoState(chatId);
  await triggerPostMeeting(state.lead_id, {
    siguiente_paso:  state.siguiente_paso,
    dolor_principal: state.dolor_principal || '',
    objeciones:      state.objeciones      || '',
    interes:         state.interes         || null,
    fecha_siguiente: state.fecha_siguiente || '',
  });
  const sigLabel = Object.entries(PM_SIG_MAP).find(([, v]) => v === state.siguiente_paso)?.[0];
  const resumen = [
    `• Sig. paso: ${PM_SIG_LABEL[sigLabel] || state.siguiente_paso}`,
    state.dolor_principal ? `• Dolor: _${state.dolor_principal}_` : null,
    state.objeciones      ? `• Objeciones: _${state.objeciones}_` : null,
    state.interes         ? `• Interés: ${state.interes}/5`        : null,
    state.fecha_siguiente ? `• Próx. paso: ${state.fecha_siguiente}` : null,
  ].filter(Boolean).join('\n');
  await sendMessage(TOKEN, chatId, `✅ *Post-reunión registrado*\n\n${resumen}\n\n_Notion actualizado · follow-up en proceso_`);
}

// Wrapper para answerCallback y editMessage sin repetir token
const _answerCallback = (id, text = '') => answerCallback(TOKEN, id, text);
const _editMessage    = (chatId, msgId, text, extra = {}) => editMessage(TOKEN, chatId, msgId, text, extra);

// Wrapper askClaude con maxTokens opcional
const _askClaude = (prompt, maxTokens = 250) => askClaude(prompt, { maxTokens });

// ── ABM: calcular fechas cadencia ─────────────────────────────────────────────
function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00-05:00');
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
}

// Rellena D1/D3/D7 en leads sin fechas. Si se pasa empresa, solo ese lead.
async function autoFillFechas(empresaFiltro = null) {
  const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });

  const filter = empresaFiltro
    ? { property: 'Empresa', title: { contains: empresaFiltro } }
    : { property: 'Día 1 (LinkedIn)', date: { is_empty: true } };

  const data  = await notionQuery(NOTION_EJECUCION_DB, filter, 50);
  const leads = data.results || [];
  let actualizados = 0;

  for (const lead of leads) {
    const d1 = getProp(lead, 'Día 1 (LinkedIn)');
    if (d1) continue; // ya tiene fechas, saltar

    await notionPatch(lead.id, {
      'Día 1 (LinkedIn)': { date: { start: hoy } },
      'Día 3 (Email)':    { date: { start: addDays(hoy, 2) } },
      'Día 7 (WhatsApp)': { date: { start: addDays(hoy, 6) } },
      'Estado':           { select: { name: 'En cadencia' } },
    });
    actualizados++;
  }
  return { actualizados, total: leads.length };
}

// Comando /iniciar [empresa] — activa cadencia para uno o todos los sin fecha
async function handleIniciar(query) {
  try {
    await send('⏳ _Calculando fechas de cadencia..._');
    const { actualizados, total } = await autoFillFechas(query || null);

    if (total === 0) {
      await send(query
        ? `Sin resultados para _"${query}"_ en la base de ejecución.`
        : '✅ Todos los leads ya tienen fechas asignadas.'
      );
      return;
    }

    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
    await send(
      `✅ *Cadencia iniciada — ${actualizados} lead(s)*\n\n` +
      `📅 Día 1 (LinkedIn): hoy\n` +
      `📧 Día 3 (Email): ${addDays(hoy, 2)}\n` +
      `📞 Día 7 (Seguimiento): ${addDays(hoy, 6)}\n\n` +
      `_Estado → En cadencia_`
    );
  } catch (err) {
    console.error('[abm-bot] /iniciar error:', err.message);
    await send('❌ Error al iniciar cadencia.');
  }
}

// ── ABM: acciones de hoy ───────────────────────────────────────────────────────
async function handleHoy() {
  const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });

  try {
    const data  = await notionQuery(NOTION_EJECUCION_DB, {
      or: [
        { property: 'Día 1 (LinkedIn)', date: { equals: hoy } },
        { property: 'Día 3 (Email)',    date: { equals: hoy } },
        { property: 'Día 7 (WhatsApp)', date: { equals: hoy } },
      ],
    });

    // Ordenar por Score ICP descendente (prioridad alta primero)
    const leads = (data.results || []).sort((a, b) =>
      (getProp(b, 'Score ICP') || 0) - (getProp(a, 'Score ICP') || 0)
    );

    if (!leads.length) {
      await send(`📋 *Plan de hoy* — ${hoy}\n\n_Sin acciones programadas para hoy._\n\nUsa \`/agenda\` para ver el calendario completo.`);
      return;
    }

    const fechaHoy = new Date().toLocaleDateString('es-PE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Lima' });
    await send(`📋 *Acciones de hoy — ${fechaHoy}* · ${leads.length} lead(s)`);

    for (const lead of leads) {
      const empresa  = getProp(lead, 'Empresa')       || 'Sin empresa';
      const decisor  = getProp(lead, 'Decisor')       || '';
      const email    = getProp(lead, 'Email Decisor') || getProp(lead, 'Email') || '';
      const telefono = getProp(lead, 'Teléfono')      || '';
      const score    = getProp(lead, 'Score ICP')     || '';
      const d1       = getProp(lead, 'Día 1 (LinkedIn)');
      const d3       = getProp(lead, 'Día 3 (Email)');
      const d7       = getProp(lead, 'Día 7 (WhatsApp)');

      let accion = '';
      if (d1 === hoy) accion = '🔵 *LinkedIn* — Enviar conexión + mensaje';
      if (d3 === hoy) accion = '📧 *Email* — Enviar con one-pager adjunto';
      if (d7 === hoy) accion = '📞 *Seguimiento* — Email breve de cierre' + (telefono ? ' o llamada' : '');

      let msg = `━━━━━━━━━━━━━━━\n🏢 *${empresa}*`;
      if (score) msg += ` · ICP ${score}/10`;
      msg += '\n';
      if (decisor)  msg += `👤 ${decisor}\n`;
      if (email)    msg += `📧 ${email}\n`;
      if (telefono) msg += `📞 ${telefono}\n`;
      msg += accion;
      msg += `\n💬 \`/mensaje ${empresa}\` para generar el texto`;

      await send(msg);
    }
  } catch (err) {
    console.error('[abm-bot] /hoy error:', err.message);
    await send('❌ Error al consultar la base de ejecución.');
  }
}

// ── ABM: generar mensaje personalizado ────────────────────────────────────────
async function handleMensaje(query) {
  if (!query?.trim()) {
    await send('Uso: `/mensaje nombre de empresa`');
    return;
  }

  try {
    const data  = await notionQuery(NOTION_EJECUCION_DB, {
      property: 'Empresa', title: { contains: query.trim() },
    }, 3);

    const leads = data.results || [];
    if (!leads.length) {
      await send(`Sin resultados para _"${query}"_ en la base de ejecución.`);
      return;
    }

    const lead     = leads[0];
    const empresa  = getProp(lead, 'Empresa')       || query;
    const decisor  = getProp(lead, 'Decisor')       || 'Decisor';
    const sector   = getProp(lead, 'Sector')        || 'manufactura';
    const notas    = getProp(lead, 'Notas')         || '';
    const score    = getProp(lead, 'Score ICP')     || '';
    const hoy      = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
    const d1       = getProp(lead, 'Día 1 (LinkedIn)');
    const d3       = getProp(lead, 'Día 3 (Email)');
    const d7       = getProp(lead, 'Día 7 (WhatsApp)');

    // Determinar canal activo: el día más reciente que ya llegó
    let canal = 'LinkedIn';
    if      (d7 && d7 <= hoy) canal = 'Seguimiento';
    else if (d3 && d3 <= hoy) canal = 'Email';
    else if (d1 && d1 <= hoy) canal = 'LinkedIn';

    const primerNombre = decisor.split(/[\s,]+/)[0] || 'Hola';

    const prompt = `Eres Ricardo, fundador de Treevü (EWA B2B2E Perú). Genera un mensaje corto y directo para el canal: ${canal}.

Lead:
- Empresa: ${empresa}
- Decisor: ${decisor} (primer nombre: ${primerNombre})
- Sector: ${sector}
- Score ICP: ${score}
- Notas: ${notas || 'ninguna'}

Producto: Treevü = acceso anticipado al salario devengado sin costo para el colaborador. Motor ML predice renuncia 3 semanas antes. Modelo no-custodio (cero riesgo para la empresa). Quedan ${CUPOS_TOTAL} cupos piloto Q2. Cierre: 30 abril. Calendly: ${CALENDLY}

Canal ${canal} — instrucciones:
${canal === 'LinkedIn' ? `Conexión + mensaje. Max 3 líneas. Menciona rotación en ${sector}. Termina con pregunta: "¿Te interesa charlar 20 min?"` : ''}
${canal === 'Email' ? `Asunto: "${empresa} — Reducción rotación (${CUPOS_TOTAL} cupos, cierre 30 abr)". Cuerpo: 5-6 líneas. Menciona S/ 8,000 costo de reemplazo. Adjunto one-pager. CTA: confirmar 20 min.` : ''}
${canal === 'Seguimiento' ? `Email breve de seguimiento. Asunto: "Re: Treevü — cupos Q2 cerrando". Max 3 líneas. Tono directo y urgente: quedan pocos cupos, cierre 30 abr. CTA: "¿Agendamos 20 min esta semana?" + link Calendly.` : ''}

Responde SOLO con el mensaje listo para copiar. Sin explicaciones.`;

    await send(`⏳ _Generando mensaje ${canal} para ${empresa}..._`);

    const mensaje = await _askClaude(prompt, 300);

    if (!mensaje) {
      await send('❌ Error generando mensaje con IA.');
      return;
    }

    const canal_emoji = canal === 'LinkedIn' ? '🔵' : canal === 'Email' ? '📧' : '📞';
    await send(`${canal_emoji} *Mensaje ${canal} — ${empresa}*\n\n\`\`\`\n${mensaje}\n\`\`\`\n\n_Copia y envía manualmente por ${canal}_`);

  } catch (err) {
    console.error('[abm-bot] /mensaje error:', err.message);
    await send('❌ Error al generar el mensaje.');
  }
}

// ── CRM: pipeline (ambas bases) ───────────────────────────────────────────────
async function handlePipeline() {
  try {
    const [crmData, abmData] = await Promise.all([
      notionQuery(NOTION_CRM_DB),
      notionQuery(NOTION_EJECUCION_DB),
    ]);

    const crmLeads = crmData.results || [];
    const abmLeads = abmData.results || [];

    // CRM stats
    const byEstado = {};
    const byScore  = { ALTO: 0, MEDIO: 0, BAJO: 0 };
    for (const lead of crmLeads) {
      const estado = getProp(lead, 'Estado') || 'Nuevo';
      const score  = getProp(lead, 'Score')  || 'BAJO';
      byEstado[estado] = (byEstado[estado] || 0) + 1;
      if (byScore[score] !== undefined) byScore[score]++;
    }

    // ABM stats
    const abmByEstado = {};
    let reunConfirmadas = 0;
    for (const lead of abmLeads) {
      const estado = getProp(lead, 'Estado') || 'Sin estado';
      abmByEstado[estado] = (abmByEstado[estado] || 0) + 1;
      if (getProp(lead, 'Reunión Confirmada')) reunConfirmadas++;
    }

    const hora = new Date().toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Lima' });
    const div = '─────────────────';

    let msg = `📊 *Pipeline Treevü* · ${hora} Lima\n\n`;

    msg += `${div}\n`;
    msg += `📥 *Inbound CRM* · ${crmLeads.length} leads\n`;
    msg += `${SCORE_EMOJI.ALTO} ${byScore.ALTO} ALTO  ${SCORE_EMOJI.MEDIO} ${byScore.MEDIO} MEDIO  ${SCORE_EMOJI.BAJO} ${byScore.BAJO} BAJO\n`;
    for (const [estado, count] of Object.entries(byEstado)) {
      msg += `${ESTADO_EMOJI[estado] || '·'} ${estado}: ${count}\n`;
    }

    msg += `\n${div}\n`;
    msg += `📤 *Outbound ABM* · ${abmLeads.length} leads`;
    if (reunConfirmadas) msg += ` · ${reunConfirmadas} reunión(es) confirmada(s)`;
    msg += `\n`;
    for (const [estado, count] of Object.entries(abmByEstado)) {
      msg += `· ${estado}: ${count}\n`;
    }

    await send(msg);
  } catch (err) {
    console.error('[abm-bot] /pipeline error:', err.message);
    await send('❌ Error al consultar Notion.');
  }
}

// ── CRM: buscar (ambas bases) ─────────────────────────────────────────────────
async function handleBuscar(query) {
  if (!query?.trim()) { await send('Uso: `/buscar nombre o empresa`'); return; }
  try {
    const [crmData, abmData] = await Promise.all([
      notionQuery(NOTION_CRM_DB, {
        or: [
          { property: 'Nombre y Cargo', title:     { contains: query } },
          { property: 'Empresa',        rich_text: { contains: query } },
        ],
      }, 5),
      notionQuery(NOTION_EJECUCION_DB, {
        property: 'Empresa', title: { contains: query },
      }, 3),
    ]);

    const crmLeads = crmData.results || [];
    const abmLeads = abmData.results || [];

    if (!crmLeads.length && !abmLeads.length) {
      await send(`Sin resultados para _"${query}"_ en CRM ni en pipeline ABM.`);
      return;
    }

    let msg = `🔍 *Resultados: "${query}"*\n\n`;

    if (crmLeads.length) {
      msg += `📥 *Inbound CRM (${crmLeads.length})*\n`;
      for (const lead of crmLeads) {
        const nombre  = getProp(lead, 'Nombre y Cargo') || 'Sin nombre';
        const empresa = getProp(lead, 'Empresa')        || '';
        const estado  = getProp(lead, 'Estado')         || 'Nuevo';
        const score   = getProp(lead, 'Score')          || 'BAJO';
        const email   = getProp(lead, 'Email')          || '';
        msg += `${SCORE_EMOJI[score]} *${nombre}*\n`;
        if (empresa) msg += `🏢 ${empresa}\n`;
        if (email)   msg += `📧 ${email}\n`;
        msg += `${ESTADO_EMOJI[estado] || '·'} ${estado}\n\n`;
      }
    }

    if (abmLeads.length) {
      msg += `📤 *Outbound ABM (${abmLeads.length})*\n`;
      for (const lead of abmLeads) {
        const empresa = getProp(lead, 'Empresa')       || 'Sin empresa';
        const decisor = getProp(lead, 'Decisor')       || '';
        const estado  = getProp(lead, 'Estado')        || '';
        const d7      = getProp(lead, 'Día 7 (WhatsApp)') || '';
        const reunConf = getProp(lead, 'Reunión Confirmada');
        msg += `🏢 *${empresa}*\n`;
        if (decisor) msg += `👤 ${decisor}\n`;
        if (estado)  msg += `📌 ${estado}\n`;
        if (d7)      msg += `📅 D7: ${d7}\n`;
        if (reunConf) msg += `✅ Reunión confirmada\n`;
        msg += `\n`;
      }
    }

    await send(msg);
  } catch (err) {
    console.error('[abm-bot] /buscar error:', err.message);
    await send('❌ Error al buscar en Notion.');
  }
}

// ── Comando /resultado [empresa] ──────────────────────────────────────────────
async function handleResultado(query) {
  if (!query?.trim()) { await send('Uso: `/resultado nombre de empresa`'); return; }
  try {
    const data  = await notionQuery(NOTION_EJECUCION_DB, {
      property: 'Empresa', title: { contains: query.trim() },
    }, 3);
    const leads = data.results || [];
    if (!leads.length) { await send(`Sin resultados para _"${query}"_.`); return; }

    const lead    = leads[0];
    const empresa = getProp(lead, 'Empresa') || query;
    const estado  = getProp(lead, 'Estado')  || '';
    const id      = lead.id.replace(/-/g, '');

    await send(
      `📋 *${empresa}*${estado ? ` · _${estado}_` : ''}\n\n¿Cuál fue el resultado del contacto?`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '📝 LOI enviado',   callback_data: `r:${id}:L` },
            { text: '🔄 Follow-up',     callback_data: `r:${id}:F` },
            { text: '❌ No interesó',   callback_data: `r:${id}:N` },
          ]],
        },
      }
    );
  } catch (err) {
    console.error('[abm-bot] /resultado error:', err.message);
    await send('❌ Error al registrar resultado.');
  }
}

// ── /reunion [empresa] — Confirma reunión, actualiza CRM y dispara briefing CEO ──
async function handleReunion(query) {
  if (!query?.trim()) {
    await send('Uso: `/reunion [empresa]`\n_Ej: `/reunion Textil Peru`_');
    return;
  }
  const empresa = query.trim();
  try {
    // 1. Buscar en Ejecución DB y marcar Reunión Confirmada
    const [abmData, crmData] = await Promise.all([
      notionQuery(NOTION_EJECUCION_DB, { property: 'Empresa', title:     { contains: empresa } }, 1),
      notionQuery(NOTION_CRM_DB,       { property: 'Empresa', rich_text: { contains: empresa } }, 1),
    ]);

    const abmLead = abmData.results?.[0];
    const crmLead = crmData.results?.[0];
    const hoy     = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });

    if (abmLead) {
      await notionPatch(abmLead.id, {
        'Reunión Confirmada': { checkbox: true },
        'Fecha Reunión':      { date:     { start: hoy } },
      });
    }

    if (!crmLead) {
      await send(
        `⚠️ *${empresa}* no está en el CRM todavía.\n` +
        (abmLead ? `✅ Ejecución ABM → Reunión Confirmada\n\n` : '\n') +
        `Para generar el briefing, agrega el lead al CRM con \`/actualizar\` o espera a que llegue por inbound.`
      );
      return;
    }

    // 2. Actualizar CRM a "Reunion" y disparar briefing
    await notionPatch(crmLead.id, { 'Estado': { select: { name: 'Reunion' } } });
    await triggerPreMeeting(crmLead.id, null);

    // Guardar en Redis para alerta post-meeting del cron (ts = ahora → alerta en 3-6h)
    const reunionTs   = Math.floor(Date.now() / 1000);
    const reunionData = JSON.stringify({
      lead_id:       crmLead.id,
      empresa:       getProp(crmLead, 'Empresa') || empresa,
      nombre:        getProp(crmLead, 'Nombre y Cargo') || '',
      email:         getProp(crmLead, 'Email') || '',
      fecha_reunion: new Date().toISOString(),
    });
    await Promise.all([
      redisCmd('ZADD', 'reuniones', reunionTs, crmLead.id),
      redisCmd('SET',  `reunion:${crmLead.id}`, reunionData, 'EX', 604800),
    ]);

    const nombreCrm = getProp(crmLead, 'Empresa') || empresa;
    await send(
      `✅ *Reunión confirmada — ${nombreCrm}*\n\n` +
      `📋 Briefing enviado al CEO por Telegram\n` +
      `📝 CRM → Estado: Reunión\n` +
      (abmLead ? `✅ ABM → Reunión Confirmada\n` : '') +
      `\n_Usa \`/resultado ${empresa}\` después de la reunión para registrar el cierre_`
    );
  } catch (err) {
    console.error('[abm-bot] /reunion error:', err.message);
    await send('❌ Error al confirmar la reunión.');
  }
}

// ── /estado — Dashboard métricas en vivo ──────────────────────────────────────
async function handleEstado() {
  try {
    const [crmData, abmData] = await Promise.all([
      notionQuery(NOTION_CRM_DB),
      notionQuery(NOTION_EJECUCION_DB),
    ]);
    const crm = crmData.results || [];
    const abm = abmData.results || [];
    let alto = 0, medio = 0, bajo = 0;
    const byEstadoCrm = {};
    for (const l of crm) {
      const s = getProp(l, 'Score') || 'BAJO';
      const e = getProp(l, 'Estado') || 'Nuevo';
      if (s === 'ALTO') alto++; else if (s === 'MEDIO') medio++; else bajo++;
      byEstadoCrm[e] = (byEstadoCrm[e] || 0) + 1;
    }
    const abmPorEstado = {};
    for (const l of abm) {
      const e = getProp(l, 'Estado') || 'Sin estado';
      abmPorEstado[e] = (abmPorEstado[e] || 0) + 1;
    }
    const cerrados   = crm.filter(l => getProp(l, 'Estado') === 'Cerrado').length;
    const enReunion  = (byEstadoCrm['Reunion'] || 0) + (byEstadoCrm['Propuesta'] || 0);
    const conversion = crm.length > 0 ? Math.round(enReunion / crm.length * 100) : 0;
    const diasCierre = Math.ceil((new Date(FECHA_CIERRE) - new Date()) / 864e5);
    const hora = new Date().toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Lima' });
    const div = '─────────────────';
    let msg = `📊 *Estado del Piloto — ${hora} Lima*\n\n${div}\n`;
    msg += `📥 *CRM Inbound* · ${crm.length} leads\n`;
    msg += `🔥 ${alto} ALTO  🟡 ${medio} MEDIO  🔵 ${bajo} BAJO\n`;
    for (const [e, n] of Object.entries(byEstadoCrm)) msg += `${ESTADO_EMOJI[e] || '·'} ${e}: ${n}\n`;
    msg += `📈 Conversión a reunión: ${conversion}%\n\n${div}\n`;
    msg += `📤 *ABM Outbound* · ${abm.length} empresas\n`;
    for (const [e, n] of Object.entries(abmPorEstado)) msg += `· ${e}: ${n}\n`;
    msg += `\n${div}\n`;
    msg += `🎯 *Cupos Q2* · Cierre 30 abr · *${diasCierre}d restantes*\n`;
    msg += `✅ ${cerrados}/${CUPOS_TOTAL} firmados · *${Math.max(0, CUPOS_TOTAL - cerrados)} disponibles*`;
    await send(msg);
  } catch (err) { await send('❌ Error al obtener métricas.'); }
}

// ── /alerta — Alertas KPIs ─────────────────────────────────────────────────────
async function handleAlerta() {
  try {
    const hace3d = new Date(Date.now() - 3 * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
    const hace5d = new Date(Date.now() - 5 * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
    const [crmData, abmData] = await Promise.all([
      notionQuery(NOTION_CRM_DB),
      notionQuery(NOTION_EJECUCION_DB),
    ]);
    const leads = crmData.results || [];
    const abm   = abmData.results  || [];
    const hoy   = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
    const alertas = [];

    for (const l of leads) {
      const score   = getProp(l, 'Score')           || 'BAJO';
      const estado  = getProp(l, 'Estado')          || 'Nuevo';
      const nombre  = getProp(l, 'Nombre y Cargo')  || 'Sin nombre';
      const empresa = getProp(l, 'Empresa')         || '';
      const ultimoContacto = getProp(l, 'Fecha Último Contacto') || l.created_time?.split('T')[0] || '';

      // Leads ALTO sin contacto en 3+ días
      if (score === 'ALTO' && ['Nuevo', 'Contactado'].includes(estado) && ultimoContacto <= hace3d) {
        const dias = Math.floor((Date.now() - new Date(ultimoContacto)) / 864e5);
        alertas.push(`🔴 *${nombre}* · ${empresa} · ${dias}d sin contacto`);
      }

      // Leads en Reunión sin avanzar en 5+ días (cadencia post-reunión)
      if (['Reunion', 'Propuesta'].includes(estado)) {
        const fechaReunion = getProp(l, 'Fecha Reunión') || ultimoContacto;
        if (fechaReunion && fechaReunion <= hace5d) {
          const dias = Math.floor((Date.now() - new Date(fechaReunion)) / 864e5);
          alertas.push(`🟠 *${nombre}* · ${empresa} · Reunión hace ${dias}d — ¿enviaste propuesta?`);
        }
      }
    }

    // ABM: leads con cadencia vencida (D7 ya pasó y siguen "En cadencia")
    for (const l of abm) {
      const estado  = getProp(l, 'Estado')           || '';
      const empresa = getProp(l, 'Empresa')          || 'Sin empresa';
      const d7      = getProp(l, 'Día 7 (WhatsApp)') || '';
      if (estado === 'En cadencia' && d7 && d7 < hoy) {
        alertas.push(`⚠️ *${empresa}* · ABM — cadencia completada, define next step`);
      }
    }

    const cerrados   = leads.filter(l => getProp(l, 'Estado') === 'Cerrado').length;
    const diasCierre = Math.ceil((new Date(FECHA_CIERRE) - new Date()) / 864e5);
    if (diasCierre <= 14 && cerrados < CUPOS_TOTAL)
      alertas.push(`⏰ *${diasCierre}d para cierre Q2* · ${CUPOS_TOTAL - cerrados} cupo(s) sin llenar`);
    if (diasCierre <= 7)
      alertas.push(`🔴 *Semana crítica* — cierre Q2 el 30 de abril`);

    if (!alertas.length) { await send('✅ *Sin alertas activas* — pipeline en orden.'); return; }
    await send(`🚨 *Alertas KPI* · ${alertas.length} activa(s)\n\n${alertas.join('\n')}`);
  } catch (err) { await send('❌ Error al verificar alertas.'); }
}

// ── /reporte — Reporte semanal ─────────────────────────────────────────────────
async function handleReporte() {
  try {
    const [crmData, abmData] = await Promise.all([
      notionQuery(NOTION_CRM_DB),
      notionQuery(NOTION_EJECUCION_DB),
    ]);
    const crm = crmData.results || [];
    const abm = abmData.results || [];
    const hace7d  = new Date(Date.now() - 7 * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
    const nuevos  = crm.filter(l => (l.created_time || '').split('T')[0] >= hace7d);
    const reunion = crm.filter(l => ['Reunion', 'Propuesta'].includes(getProp(l, 'Estado') || ''));
    const cerrados = crm.filter(l => getProp(l, 'Estado') === 'Cerrado');
    const diasCierre = Math.ceil((new Date(FECHA_CIERRE) - new Date()) / 864e5);
    const semana = new Date().toLocaleDateString('es-PE', { day: 'numeric', month: 'long', timeZone: 'America/Lima' });
    const div = '─────────────────';
    let msg = `📈 *Reporte Semanal Treevü*\n_Al ${semana}_\n\n${div}\n`;
    msg += `📥 *Inbound* · ${nuevos.length} nuevos esta semana · ${crm.length} total\n\n${div}\n`;
    msg += `📤 *ABM* · ${abm.length} empresas · ${abm.filter(l => getProp(l, 'Estado') === 'En cadencia').length} en cadencia\n\n${div}\n`;
    msg += `🏁 *Piloto* · ${reunion.length} en reunión/propuesta · ${cerrados.length}/${CUPOS_TOTAL} firmados\n`;
    msg += `⏱️ ${diasCierre}d para cierre Q2 (30 abr)\n\n${div}\n`;
    msg += `_/nextstep para recomendaciones · /alerta para KPIs críticos_`;
    await send(msg);
  } catch (err) { await send('❌ Error al generar reporte.'); }
}

// ── /nextstep — Próximos pasos IA ──────────────────────────────────────────────
async function handleNextStep() {
  try {
    const [crmData, abmData] = await Promise.all([
      notionQuery(NOTION_CRM_DB),
      notionQuery(NOTION_EJECUCION_DB),
    ]);
    const crm = crmData.results || [];
    const abm = abmData.results || [];
    const alto = crm.filter(l => getProp(l, 'Score') === 'ALTO').length;
    const enReunion = crm.filter(l => ['Reunion', 'Propuesta'].includes(getProp(l, 'Estado') || '')).length;
    const cerrados = crm.filter(l => getProp(l, 'Estado') === 'Cerrado').length;
    const diasCierre = Math.ceil((new Date(FECHA_CIERRE) - new Date()) / 864e5);
    const prompt =
      `Eres el asesor estratégico de Ricardo Cuba, fundador de Treevü (EWA B2B2E Perú).\n` +
      `Pipeline: ${crm.length} leads CRM (${alto} ALTO, ${enReunion} en reunión), ${abm.length} ABM outbound.\n` +
      `Estado piloto: ${cerrados}/${CUPOS_TOTAL} firmados, ${diasCierre} días para cierre 30 abril.\n\n` +
      `Da exactamente 3 próximos pasos accionables para esta semana. Numerados, 1 línea c/u. Sin relleno.`;
    await send('⏳ _Analizando pipeline..._');
    const resp = await _askClaude(prompt, 120);
    await send(`🎯 *Próximos pasos — esta semana*\n\n${resp}`);
  } catch (err) { await send('❌ Error al generar próximos pasos.'); }
}

// ── /cronograma — Fases del piloto ────────────────────────────────────────────
async function handleCronograma() {
  const hoy = new Date();
  const f1 = hoy < new Date('2026-04-15') ? ' ← *aquí*' : ' ✓';
  const f2 = hoy >= new Date('2026-04-15') && hoy < new Date(FECHA_CIERRE) ? ' ← *aquí*' : (hoy >= new Date(FECHA_CIERRE) ? ' ✓' : '');
  const f3 = hoy >= new Date('2026-05-01') && hoy < new Date('2026-05-15') ? ' ← *aquí*' : (hoy >= new Date('2026-05-15') ? ' ✓' : '');
  const f4 = hoy >= new Date('2026-05-15') ? ' ← *aquí*' : '';
  await send(
    `📅 *Cronograma Piloto Treevü — Q2 2026*\n\n` +
    `*Fase 1 — Captación*${f1} _(25 mar → 15 abr)_\n` +
    `· Cadencia ABM activa: D1 LinkedIn · D3 Email · D7 Seguimiento\n` +
    `· Meta: 6-8 reuniones agendadas\n\n` +
    `*Fase 2 — Cierre*${f2} _(15 abr → 30 abr)_\n` +
    `· Follow-up, negociación, firma de LOI\n` +
    `· Meta: 2 pilotos firmados\n\n` +
    `*Fase 3 — Onboarding*${f3} _(1 may → 15 may)_\n` +
    `· Setup técnico e integración de nómina\n` +
    `· Capacitación a colaboradores\n\n` +
    `*Fase 4 — Piloto activo*${f4} _(15 may → 30 jun)_\n` +
    `· Colaboradores usan EWA en producción\n` +
    `· Medición: NPS · rotación · ML predictor\n\n` +
    `_/gatereview 2 · /gatereview 4 · /gatereview 6_`
  );
}

// ── /semana — Acciones de la semana completa ───────────────────────────────────
async function handleSemana() {
  try {
    const hoy  = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
    const en7d = new Date(Date.now() + 7 * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
    const data = await notionQuery(NOTION_EJECUCION_DB, {
      or: [
        { property: 'Día 1 (LinkedIn)', date: { on_or_after: hoy } },
        { property: 'Día 3 (Email)',    date: { on_or_after: hoy } },
        { property: 'Día 7 (WhatsApp)', date: { on_or_after: hoy } },
      ],
    });
    const leads = data.results || [];
    if (!leads.length) {
      await send('📋 *Sin acciones esta semana*\n\nUsa `/iniciar [empresa]` para activar leads.');
      return;
    }
    const byDay = {};
    for (const l of leads) {
      const empresa = getProp(l, 'Empresa') || 'Sin empresa';
      [['Día 1 (LinkedIn)', 'LinkedIn'], ['Día 3 (Email)', 'Email'], ['Día 7 (WhatsApp)', 'Seguimiento']].forEach(([campo, canal]) => {
        const fecha = getProp(l, campo);
        if (fecha && fecha >= hoy && fecha <= en7d) {
          if (!byDay[fecha]) byDay[fecha] = [];
          byDay[fecha].push({ empresa, canal });
        }
      });
    }
    const ICON = { LinkedIn: '🔵', Email: '📧', Seguimiento: '📞' };
    let msg = `📅 *Acciones esta semana*\n\n`;
    for (const [fecha, acc] of Object.entries(byDay).sort()) {
      const label = fecha === hoy ? '*Hoy*' : `*${new Date(fecha + 'T12:00:00-05:00').toLocaleDateString('es-PE', { weekday: 'short', day: 'numeric', timeZone: 'America/Lima' })}*`;
      msg += `${label} (${acc.length})\n`;
      for (const a of acc) msg += `${ICON[a.canal]} ${a.canal} → ${a.empresa.slice(0, 35)}\n`;
      msg += '\n';
    }
    await send(msg);
  } catch (err) { await send('❌ Error al consultar la semana.'); }
}

// ── /agenda — Calendario ABM completo (vencidas + próximas 14d) ───────────────
async function handleAgenda() {
  try {
    const hoy   = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
    const en14d = new Date(Date.now() + 14 * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Lima' });

    const data  = await notionQuery(NOTION_EJECUCION_DB, null, 100);
    const leads = data.results || [];

    if (!leads.length) {
      await send('📆 *Agenda ABM vacía*\n\nAún no hay empresas en la base de ejecución.');
      return;
    }

    const ICON    = { LinkedIn: '🔵', Email: '📧', Seguimiento: '📞' };
    const CANALES = [
      ['Día 1 (LinkedIn)', 'LinkedIn'],
      ['Día 3 (Email)',    'Email'],
      ['Día 7 (WhatsApp)','Seguimiento'],
    ];

    const vencidas = [];  // [{empresa, canal, decisor, fecha}]
    const byDay    = {};  // fecha → [{empresa, canal, decisor}]
    const sinFecha = [];  // [empresa]

    for (const l of leads) {
      const empresa = getProp(l, 'Empresa') || 'Sin empresa';
      const decisor = getProp(l, 'Decisor') || '';
      let   tieneAlguna = false;

      for (const [campo, canal] of CANALES) {
        const fecha = getProp(l, campo);
        if (!fecha) continue;
        tieneAlguna = true;

        if (fecha < hoy) {
          vencidas.push({ empresa, canal, decisor, fecha });
        } else if (fecha <= en14d) {
          if (!byDay[fecha]) byDay[fecha] = [];
          byDay[fecha].push({ empresa, canal, decisor });
        }
      }

      if (!tieneAlguna) sinFecha.push(empresa);
    }

    const fechaHdr = new Date().toLocaleDateString('es-PE', {
      weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Lima',
    });

    let msg = `📆 *Agenda ABM · ${leads.length} empresas*\n_${fechaHdr}_\n\n`;

    // ── Vencidas ──
    if (vencidas.length) {
      msg += `⚠️ *Acciones vencidas (${vencidas.length})*\n`;
      for (const a of vencidas.sort((x, y) => x.fecha.localeCompare(y.fecha))) {
        const dias = Math.floor((new Date(hoy + 'T12:00:00-05:00') - new Date(a.fecha + 'T12:00:00-05:00')) / 864e5);
        const diasStr = dias === 1 ? '1d atrás' : `${dias}d atrás`;
        msg += `${ICON[a.canal]} ${a.canal} · *${a.empresa.slice(0, 30)}*`;
        if (a.decisor) msg += ` · ${a.decisor.split(' ')[0]}`;
        msg += ` _(${diasStr})_\n`;
      }
      msg += '\n';
    }

    // ── Hoy + próximas 14 días por día ──
    const dias = Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b));
    if (dias.length) {
      for (const [fecha, acc] of dias) {
        const esHoy = fecha === hoy;
        const dLabel = esHoy
          ? '📌 *Hoy*'
          : `*${new Date(fecha + 'T12:00:00-05:00').toLocaleDateString('es-PE', {
              weekday: 'short', day: 'numeric', month: 'short', timeZone: 'America/Lima',
            })}*`;
        msg += `${dLabel} — ${acc.length} acción${acc.length > 1 ? 'es' : ''}\n`;
        for (const a of acc) {
          msg += `${ICON[a.canal]} ${a.empresa.slice(0, 30)}`;
          if (a.decisor) msg += ` · _${a.decisor.split(' ')[0]}_`;
          msg += '\n';
        }
        msg += '\n';
      }
    } else if (!vencidas.length) {
      msg += `_Sin acciones en los próximos 14 días._\n\n`;
    }

    // ── Sin programar ──
    if (sinFecha.length) {
      msg += `📭 *Sin programar (${sinFecha.length})*\n`;
      for (const e of sinFecha) msg += `· ${e.slice(0, 35)}\n`;
      msg += `_\`/iniciar [empresa]\` para activar_`;
    }

    await send(msg);
  } catch (err) {
    console.error('[abm-bot] /agenda error:', err.message);
    await send('❌ Error al generar la agenda.');
  }
}

// ── /manana — Acciones de mañana ──────────────────────────────────────────────
async function handleManana() {
  const manana = new Date(Date.now() + 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Lima' });

  try {
    const data  = await notionQuery(NOTION_EJECUCION_DB, {
      or: [
        { property: 'Día 1 (LinkedIn)', date: { equals: manana } },
        { property: 'Día 3 (Email)',    date: { equals: manana } },
        { property: 'Día 7 (WhatsApp)', date: { equals: manana } },
      ],
    });

    const leads = data.results || [];

    if (!leads.length) {
      await send(`📋 *Mañana* (${manana})\n\n_Sin acciones programadas._\n\nUsa \`/agenda\` para ver el calendario completo.`);
      return;
    }

    const fechaLabel = new Date(manana + 'T12:00:00-05:00').toLocaleDateString('es-PE', {
      weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Lima',
    });

    let msg = `📋 *Mañana — ${fechaLabel}* · ${leads.length} lead(s)\n\n`;

    for (const lead of leads) {
      const empresa  = getProp(lead, 'Empresa')       || 'Sin empresa';
      const decisor  = getProp(lead, 'Decisor')       || '';
      const email    = getProp(lead, 'Email Decisor') || getProp(lead, 'Email') || '';
      const telefono = getProp(lead, 'Teléfono')      || '';
      const d1       = getProp(lead, 'Día 1 (LinkedIn)');
      const d3       = getProp(lead, 'Día 3 (Email)');
      const d7       = getProp(lead, 'Día 7 (WhatsApp)');

      let accion = '';
      if (d1 === manana) accion = '🔵 *LinkedIn* — Preparar conexión + mensaje';
      if (d3 === manana) accion = '📧 *Email* — Preparar email con one-pager';
      if (d7 === manana) accion = '📞 *Seguimiento* — Preparar email breve de cierre' + (telefono ? ' o llamada' : '');

      const score = getProp(lead, 'Score ICP') || '';
      let card = `━━━━━━━━━━━━━━━\n🏢 *${empresa}*`;
      if (score) card += ` · ICP ${score}/10`;
      card += '\n';
      if (decisor)  card += `👤 ${decisor}\n`;
      if (email)    card += `📧 ${email}\n`;
      if (telefono) card += `📞 ${telefono}\n`;
      card += accion;
      card += `\n💬 \`/mensaje ${empresa}\` para preparar el texto`;

      await send(card);
    }
  } catch (err) {
    console.error('[abm-bot] /manana error:', err.message);
    await send('❌ Error al consultar mañana.');
  }
}

// ── /bloqueantes — RAG con IA ─────────────────────────────────────────────────
async function handleBloqueantes() {
  try {
    const [crmData, abmData] = await Promise.all([
      notionQuery(NOTION_CRM_DB),
      notionQuery(NOTION_EJECUCION_DB),
    ]);
    const crm = crmData.results || [];
    const abm = abmData.results || [];
    const diasCierre = Math.ceil((new Date(FECHA_CIERRE) - new Date()) / 864e5);
    const cerrados   = crm.filter(l => getProp(l, 'Estado') === 'Cerrado').length;
    const prompt =
      `Eres asesor de Ricardo Cuba, Treevü (EWA B2B2E Perú, ${diasCierre}d para cierre Q2).\n` +
      `Pipeline: ${crm.length} leads CRM, ${crm.filter(l => getProp(l, 'Score') === 'ALTO').length} ALTO, ` +
      `${crm.filter(l => ['Reunion', 'Propuesta'].includes(getProp(l, 'Estado') || '')).length} en reunión. ` +
      `${abm.length} ABM. ${cerrados}/${CUPOS_TOTAL} cerrados.\n\n` +
      `Identifica los 3 bloqueantes más críticos con RAG.\n` +
      `Formato exacto por línea: 🔴/🟡/🟢 [Bloqueante] — [Acción inmediata]\n` +
      `Solo 3 líneas. Sin introducciones.`;
    await send('⏳ _Analizando bloqueantes..._');
    const resp = await _askClaude(prompt, 120);
    await send(`🚦 *Bloqueantes RAG*\n\n${resp}\n\n_/decision para decisiones pendientes_`);
  } catch (err) { await send('❌ Error al analizar bloqueantes.'); }
}

// ── /decision — Decisiones pendientes ─────────────────────────────────────────
async function handleDecision() {
  try {
    const diasCierre = Math.ceil((new Date(FECHA_CIERRE) - new Date()) / 864e5);
    const prompt =
      `Eres asesor de Ricardo Cuba, Treevü (EWA B2B2E Perú, ${diasCierre}d para cierre Q2, ${CUPOS_TOTAL} cupos piloto).\n` +
      `Lista las 3 decisiones estratégicas más urgentes que Ricardo debe tomar esta semana.\n` +
      `Formato: [N]. [Decisión] — [Criterio o consecuencia de no decidir]\n` +
      `Solo 3 líneas. Sin relleno.`;
    await send('⏳ _Identificando decisiones..._');
    const resp = await _askClaude(prompt, 120);
    await send(`⚖️ *Decisiones pendientes*\n\n${resp}`);
  } catch (err) { await send('❌ Error al generar decisiones.'); }
}

// ── /leads — Pipeline CRM con filtros ─────────────────────────────────────────
async function handleLeads(filtro) {
  try {
    let filter = null, titulo = 'Pipeline completo';
    if (filtro === 'alto') {
      filter = { property: 'Score', select: { equals: 'ALTO' } };
      titulo = 'Leads ALTO 🔥';
    } else if (filtro === 'medio') {
      filter = { property: 'Score', select: { equals: 'MEDIO' } };
      titulo = 'Leads MEDIO 🟡';
    } else if (filtro === 'reunion') {
      filter = { or: [
        { property: 'Estado', select: { equals: 'Reunion' } },
        { property: 'Estado', select: { equals: 'Reunión agendada' } },
        { property: 'Estado', select: { equals: 'Propuesta' } },
      ]};
      titulo = 'En reunión / propuesta 📅';
    }
    const data = await notionQuery(NOTION_CRM_DB, filter, 20);
    const leads = data.results || [];
    if (!leads.length) { await send(`Sin leads para _${titulo}_`); return; }
    let msg = `📋 *${titulo}* · ${leads.length} leads\n\n`;
    for (const l of leads.slice(0, 12)) {
      const nombre  = getProp(l, 'Nombre y Cargo') || 'Sin nombre';
      const empresa = getProp(l, 'Empresa') || '';
      const estado  = getProp(l, 'Estado') || 'Nuevo';
      const score   = getProp(l, 'Score') || 'BAJO';
      const email   = getProp(l, 'Email') || '';
      msg += `${SCORE_EMOJI[score] || '·'} *${nombre}*\n`;
      if (empresa) msg += `🏢 ${empresa}\n`;
      if (email)   msg += `📧 ${email}\n`;
      msg += `${ESTADO_EMOJI[estado] || '·'} ${estado}\n\n`;
    }
    if (leads.length > 12) msg += `_... y ${leads.length - 12} más. Usa /buscar para filtrar._`;
    await send(msg);
  } catch (err) { await send('❌ Error al consultar leads.'); }
}

// ── /contactos — Directorio ABM con datos de contacto ─────────────────────────
async function handleContactos() {
  try {
    const data  = await notionQuery(NOTION_EJECUCION_DB, null, 50);
    const leads = data.results || [];
    if (!leads.length) { await send('Sin contactos en pipeline ABM.'); return; }
    let msg = `📇 *Directorio ABM* · ${leads.length} empresas\n\n`;
    for (const l of leads.slice(0, 18)) {
      const empresa  = getProp(l, 'Empresa') || 'Sin empresa';
      const decisor  = getProp(l, 'Decisor') || '';
      const telefono = getProp(l, 'Teléfono') || '';
      const email    = getProp(l, 'Email Decisor') || getProp(l, 'Email') || '';
      const estado   = getProp(l, 'Estado') || '';
      msg += `🏢 *${empresa.slice(0, 35)}*\n`;
      if (decisor)  msg += `👤 ${decisor}\n`;
      if (telefono) msg += `📱 ${telefono}\n`;
      if (email)    msg += `📧 ${email}\n`;
      if (estado)   msg += `📌 ${estado}\n`;
      msg += '\n';
    }
    if (leads.length > 18) msg += `_... y ${leads.length - 18} más. Usa /buscar [empresa] para filtrar._`;
    await send(msg);
  } catch (err) { await send('❌ Error al obtener directorio.'); }
}

// ── /actualizar empresa estado ────────────────────────────────────────────────
async function handleActualizar(query) {
  const estadosValidos = ['Nuevo', 'Contactado', 'Reunion', 'Propuesta', 'Cerrado', 'Descartado'];
  if (!query?.trim()) {
    await send(`Uso: \`/actualizar [empresa] [estado]\`\n\nEstados: ${estadosValidos.map(e => `\`${e}\``).join(' ')}`);
    return;
  }
  const tokens   = query.trim().split(' ');
  const estadoRaw = tokens.pop();
  const empresa  = tokens.join(' ').trim();
  const estado   = estadosValidos.find(e => e.toLowerCase() === estadoRaw.toLowerCase());
  if (!estado)  { await send(`Estado _"${estadoRaw}"_ no válido.\nUsa: ${estadosValidos.map(e => `\`${e}\``).join(' ')}`); return; }
  if (!empresa) { await send('Falta el nombre de la empresa.\nUso: `/actualizar [empresa] [estado]`'); return; }
  try {
    const data = await notionQuery(NOTION_CRM_DB, { property: 'Empresa', rich_text: { contains: empresa } }, 3);
    const leads = data.results || [];
    if (!leads.length) { await send(`Sin resultados para _"${empresa}"_ en CRM.`); return; }
    const lead = leads[0];
    const nombre = getProp(lead, 'Empresa') || empresa;
    const anterior = getProp(lead, 'Estado') || 'Nuevo';
    await notionPatch(lead.id, { Estado: { select: { name: estado } } });
    await send(`✅ *${nombre}*\n${ESTADO_EMOJI[anterior] || '·'} ${anterior} → ${ESTADO_EMOJI[estado] || '·'} *${estado}*`);
  } catch (err) { await send('❌ Error al actualizar.'); }
}

// ── /compliance ────────────────────────────────────────────────────────────────
async function handleCompliance() {
  await send(
    `⚖️ *Compliance — Ciclo Legal Treevü*\n\n` +
    `*Documentos listos*\n` +
    `· LOI (Letter of Intent) — template disponible\n` +
    `· Contrato piloto B2B — modelo estándar\n` +
    `· NDA — firmado antes de revelar datos técnicos\n\n` +
    `*Regulatorio Perú*\n` +
    `· EWA no regulado específicamente → sin licencia SBS requerida\n` +
    `· Modelo no-custodio: cero obligación de supervisión financiera\n` +
    `· Sin modificación de contrato laboral del colaborador\n\n` +
    `*Próximos pasos legales*\n` +
    `· Revisión cláusula de responsabilidad en contrato piloto\n` +
    `· Definir SLA de pago con empresa cliente\n\n` +
    `_¿Dudas específicas? /pregunta [consulta legal]_`
  );
}

// ── /partners ──────────────────────────────────────────────────────────────────
async function handlePartners() {
  await send(
    `🤝 *Ecosistema B2B Treevü*\n\n` +
    `*Distribución*\n` +
    `· CCPLL — Cámara de Comercio La Libertad\n` +
    `· Asociaciones manufactureras Trujillo\n\n` +
    `*Tecnología*\n` +
    `· Integración nómina vía API (Alegra, Concar, otros)\n` +
    `· Pasarela de pagos: desembolso T+0\n\n` +
    `*Capital*\n` +
    `· Programa Fundadores: primeros clientes = socios estratégicos\n` +
    `· Ronda seed: por definir post-piloto\n\n` +
    `_/pregunta para análisis de partnerships específico_`
  );
}

// ── /ml — Modelo ML predictor de renuncia ──────────────────────────────────────
async function handleMl() {
  await send(
    `🤖 *Modelo ML — Predictor de Renuncia*\n\n` +
    `*Cómo funciona*\n` +
    `· Inputs: frecuencia de uso EWA, patrón de adelantos, días sin actividad\n` +
    `· Output: probabilidad de renuncia en próximas 3 semanas (0–100%)\n` +
    `· Alerta automática a RRHH cuando score > umbral configurable\n\n` +
    `*Estado actual*\n` +
    `· Entrenado con datos sintéticos de mercado peruano\n` +
    `· Precisión proyectada: 78–82% (se valida en piloto)\n` +
    `· Fine-tuning: con datos reales de los clientes piloto Q2\n\n` +
    `*Gates de validación*\n` +
    `· Gate 2 (mes 2): primeras predicciones con data real\n` +
    `· Gate 4 (mes 4): validar reducción de rotación vs baseline\n\n` +
    `_/gatereview 2 para criterios de éxito del mes 2_`
  );
}

// ── /gatereview — Gate reviews del piloto ─────────────────────────────────────
async function handleGatereview(num) {
  const gates = {
    '2': {
      t: 'Gate 2 — Mes 2 Piloto',
      c: ['✅ ≥30% colaboradores activados en EWA', '✅ NPS colaborador > 7', '✅ Cero incidentes de pago', '✅ Integración nómina estable', '🎯 MRR objetivo: S/ 500+'],
    },
    '4': {
      t: 'Gate 4 — Mes 4 Piloto',
      c: ['✅ Reducción rotación mensual > 10%', '✅ Tasa activación > 50%', '✅ NPS empresa > 8', '✅ Primera renovación o expansión', '🎯 MRR objetivo: S/ 1,200+'],
    },
    '6': {
      t: 'Gate 6 — Cierre Piloto (Mes 6)',
      c: ['✅ Reducción rotación > 25% vs baseline', '✅ ROI empresa demostrado > 3x', '✅ Decisión de expansión o contrato definitivo', '✅ Caso de estudio documentado', '🎯 MRR objetivo: S/ 2,500+'],
    },
  };
  const gate = gates[num];
  if (!gate) { await send('Uso: `/gatereview 2`, `/gatereview 4` o `/gatereview 6`'); return; }
  let msg = `🚪 *${gate.t}*\n\n*Criterios de éxito:*\n`;
  for (const c of gate.c) msg += `${c}\n`;
  msg += `\n_Revisa en reunión mensual con el cliente._`;
  await send(msg);
}

// ── /cuenta — Contador regresivo del piloto ───────────────────────────────────
async function handleCuenta() {
  try {
    const [crmData, abmData] = await Promise.all([
      notionQuery(NOTION_CRM_DB),
      notionQuery(NOTION_EJECUCION_DB),
    ]);
    const crm = crmData.results || [];
    const abm = abmData.results  || [];
    const diasCierre  = Math.ceil((new Date(FECHA_CIERRE) - new Date()) / 864e5);
    const cerrados    = crm.filter(l => getProp(l, 'Estado') === 'Cerrado').length;
    const enReunion   = crm.filter(l => ['Reunion', 'Propuesta'].includes(getProp(l, 'Estado') || '')).length;
    const enCadencia  = abm.filter(l => getProp(l, 'Estado') === 'En cadencia').length;
    const cuposLibres = Math.max(0, CUPOS_TOTAL - cerrados);

    const urgencia = diasCierre <= 7  ? '🔴' :
                     diasCierre <= 14 ? '🟠' :
                     diasCierre <= 21 ? '🟡' : '🟢';

    let msg = `${urgencia} *Cuenta regresiva Treevü Q2*\n\n`;
    msg += `📅 *${diasCierre} días* hasta el 30 de abril\n\n`;
    msg += `✅ Firmados: *${cerrados}/${CUPOS_TOTAL}*\n`;
    msg += `🎯 Cupos libres: *${cuposLibres}*\n\n`;
    msg += `📊 *Pipeline activo*\n`;
    msg += `· ${enReunion} en reunión/propuesta (CRM)\n`;
    msg += `· ${enCadencia} en cadencia ABM\n`;
    msg += `· ${crm.length} leads totales CRM\n\n`;

    if (cuposLibres > 0 && enReunion >= cuposLibres) {
      msg += `💡 _Tienes suficientes leads en reunión para cubrir los cupos — enfócate en cerrar._`;
    } else if (cuposLibres > 0) {
      const faltan = cuposLibres - enReunion;
      msg += `⚠️ _Necesitas ${faltan} reunión(es) adicional(es) para tener cobertura de cierre._`;
    } else {
      msg += `🎉 _¡Pipeline completado! ${cerrados}/${CUPOS_TOTAL} pilotos firmados._`;
    }

    await send(msg);
  } catch (err) { await send('❌ Error al calcular el contador.'); }
}

// ── /objecion — Respuesta IA a objeciones ─────────────────────────────────────
const OBJECIONES = {
  precio:      'precio / costo / inversión / caro',
  integracion: 'integración / sistema / nómina / tecnología / IT',
  tiempo:      'tiempo / ahora no / próximo año / no es el momento',
  riesgo:      'riesgo / startup / confianza / quién garantiza / pequeña empresa',
  prioridad:   'no es prioridad / tenemos otras cosas / estamos ocupados',
  resultado:   '¿cómo sé que funciona? / prueba / evidencia / caso',
};

async function handleObjecion(tipo) {
  const tipos = Object.keys(OBJECIONES);

  if (!tipo?.trim() || !tipos.includes(tipo.trim().toLowerCase())) {
    let msg = `💬 *Rebatidor de objeciones*\n\nUso: \`/objecion [tipo]\`\n\n*Tipos disponibles:*\n`;
    for (const [k, v] of Object.entries(OBJECIONES)) msg += `· \`${k}\` — _"${v}"_\n`;
    await send(msg);
    return;
  }

  const t = tipo.trim().toLowerCase();
  const diasCierre = Math.ceil((new Date(FECHA_CIERRE) - new Date()) / 864e5);

  const prompts = {
    precio:
      `Objeción de precio en venta B2B. El cliente dice que Treevü es caro o pide justificar el costo.\n` +
      `Contexto: Treevü = acceso anticipado al salario (EWA), costo S/0 para el colaborador, modelo no-custodio (sin riesgo financiero para la empresa). ` +
      `El costo de reemplazo de un colaborador es S/ 8,000+. La rotación reduce productividad y genera costos ocultos. ` +
      `El piloto es gratuito o de bajo costo. Quedan ${diasCierre} días para cerrar Q2.\n` +
      `Genera una respuesta de rebate: máximo 4 líneas, directa, orientada a ROI. Sin preámbulo.`,

    integracion:
      `Objeción técnica: el cliente pregunta cómo se integra Treevü con su sistema de nómina.\n` +
      `Contexto: Treevü no requiere integración profunda en el piloto — funciona con un reporte de nómina mensual (Excel/PDF). ` +
      `La integración API (Alegra, Concar, SIGE) viene en fase 2. El piloto arranca en 2 semanas sin IT.\n` +
      `Genera respuesta de rebate: máximo 4 líneas. Énfasis en velocidad de arranque.`,

    tiempo:
      `Objeción de timing: el cliente dice que ahora no es el momento o que lo evalúan para el próximo año.\n` +
      `Contexto: solo quedan ${diasCierre} días para cerrar el piloto Q2 con condiciones fundadoras (precio especial, atención directa del fundador, co-diseño del producto). ` +
      `Después del 30 de abril, el siguiente piloto será en Q3 con condiciones estándar.\n` +
      `Genera respuesta de rebate: máximo 4 líneas. Urgencia real, no presión falsa.`,

    riesgo:
      `Objeción de confianza/riesgo: el cliente desconfía de una startup o pregunta quién garantiza el servicio.\n` +
      `Contexto: Treevü es modelo no-custodio (la empresa no adelanta dinero, no hay riesgo financiero). ` +
      `El piloto tiene SLA definido, contrato con cláusula de responsabilidad limitada, y Ricardo Cuba (fundador) atiende directamente. ` +
      `El riesgo real para la empresa es cero — el peor escenario es que no funcione y ya.\n` +
      `Genera respuesta de rebate: máximo 4 líneas. Énfasis en cero riesgo financiero.`,

    prioridad:
      `Objeción de prioridad: el cliente dice que tienen otras prioridades o que están ocupados.\n` +
      `Contexto: implementar el piloto Treevü toma 2 semanas y requiere < 2 horas del equipo de RRHH. ` +
      `El costo de oportunidad de no hacerlo: cada mes de rotación no atendida cuesta S/ 8,000+ por colaborador que se va.\n` +
      `Genera respuesta de rebate: máximo 4 líneas. Énfasis en bajo esfuerzo de implementación.`,

    resultado:
      `Objeción de evidencia: el cliente pide prueba de que Treevü funciona o casos de éxito.\n` +
      `Contexto: Treevü está en fase de piloto — los primeros 2 clientes son socios fundadores que co-crean el producto. ` +
      `La lógica EWA está validada globalmente (DailyPay, Earned, Leaf). El ML predictor de renuncia se basa en modelos académicos validados. ` +
      `El piloto incluye métricas de éxito acordadas (gate review semana 2, 4, 6).\n` +
      `Genera respuesta de rebate: máximo 4 líneas. Reencuadra: ser piloto = ventaja competitiva.`,
  };

  try {
    await send(`⏳ _Preparando rebate para objeción de ${t}..._`);
    const resp = await _askClaude(prompts[t], 160);
    if (!resp) throw new Error('Sin respuesta de IA');
    await send(`💬 *Objeción: ${t}*\n\n${resp}\n\n_/objecion para ver todos los tipos_`);
  } catch (err) {
    console.error('[abm-bot] /objecion error:', err.message);
    await send('❌ Error al generar el rebate.');
  }
}

// ── Teclados del menú principal ────────────────────────────────────────────────
const KB_MENU = {
  inline_keyboard: [
    [{ text: '📋 Acciones de hoy',    callback_data: 'menu:hoy' },
     { text: '⚡ Alertas KPI',        callback_data: 'menu:alertas' }],
    [{ text: '📊 Estado pipeline',    callback_data: 'menu:estado' },
     { text: '🧠 ¿Qué hago hoy?',    callback_data: 'menu:nextstep' }],
    [{ text: '🔍 Buscar lead',        callback_data: 'menu:buscar' },
     { text: '🤖 Lo que puedo hacer', callback_data: 'menu:autonomo' }],
    [{ text: '📖 Todos los comandos', callback_data: 'menu:comandos' }],
  ],
};

const KB_AUTONOMO = {
  inline_keyboard: [
    [{ text: '📊 Estado del pipeline',    callback_data: 'menu:estado' },
     { text: '⚡ Alertas KPI',            callback_data: 'menu:alertas' }],
    [{ text: '🎯 3 próximos pasos',       callback_data: 'menu:nextstep' },
     { text: '🚦 Bloqueantes RAG',        callback_data: 'menu:bloqueantes' }],
    [{ text: '⚖️ Decisiones pendientes',  callback_data: 'menu:decision' },
     { text: '📈 Reporte semanal',        callback_data: 'menu:reporte' }],
    [{ text: '📋 Acciones de hoy',        callback_data: 'menu:hoy' },
     { text: '📅 Agenda 14 días',         callback_data: 'menu:agenda' }],
    [{ text: '⏱ Cuenta regresiva Q2',    callback_data: 'menu:cuenta' }],
    [{ text: '← Volver al menú',         callback_data: 'menu:inicio' }],
  ],
};

// ── /start — Dashboard contextual en vivo ─────────────────────────────────────
async function handleHelp() {
  const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
  const fecha = new Date().toLocaleDateString('es-PE', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Lima',
  });
  const hora = new Date().toLocaleTimeString('es-PE', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Lima',
  });
  const hace3d = new Date(Date.now() - 3 * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
  const diasCierre = Math.ceil((new Date(FECHA_CIERRE) - new Date()) / 864e5);

  // Fetch paralelo: acciones hoy, reuniones hoy, leads urgentes, estado piloto
  let accionesHoy = 0, reunionesHoy = 0, altosUrgentes = 0, cerrados = 0;
  try {
    const [abmData, reunData, crmData] = await Promise.all([
      notionQuery(NOTION_EJECUCION_DB, {
        or: [
          { property: 'Día 1 (LinkedIn)', date: { equals: hoy } },
          { property: 'Día 3 (Email)',    date: { equals: hoy } },
          { property: 'Día 7 (WhatsApp)', date: { equals: hoy } },
        ],
      }, 50),
      notionQuery(NOTION_EJECUCION_DB, {
        and: [
          { property: 'Fecha Reunión',      date:     { equals: hoy } },
          { property: 'Reunión Confirmada', checkbox: { equals: true } },
        ],
      }, 10),
      notionQuery(NOTION_CRM_DB, null, 100),
    ]);

    accionesHoy  = (abmData.results  || []).length;
    reunionesHoy = (reunData.results || []).length;

    const crm = crmData.results || [];
    cerrados = crm.filter(l => getProp(l, 'Estado') === 'Cerrado').length;
    altosUrgentes = crm.filter(l => {
      const score  = getProp(l, 'Score')  || '';
      const estado = getProp(l, 'Estado') || '';
      const creado = (l.created_time || '').split('T')[0];
      return score === 'ALTO' && ['Nuevo', 'Contactado'].includes(estado) && creado <= hace3d;
    }).length;
  } catch { /* si falla Notion, muestra el menú igual */ }

  const urgencia = diasCierre <= 7 ? '🔴' : diasCierre <= 14 ? '🟠' : diasCierre <= 21 ? '🟡' : '🟢';
  const div = '─────────────────';

  let msg = `*Treevü ABM* · ${hora} Lima\n_${fecha}_\n${div}\n`;

  if (accionesHoy > 0 || reunionesHoy > 0) {
    if (accionesHoy > 0)  msg += `📋 Hoy: *${accionesHoy} acción(es)* ABM pendiente(s)\n`;
    if (reunionesHoy > 0) msg += `📅 Reunion(es) hoy: *${reunionesHoy}*\n`;
  } else {
    msg += `📋 Sin acciones ABM programadas hoy\n`;
  }

  if (altosUrgentes > 0) {
    msg += `⚡ *${altosUrgentes} lead(s) ALTO* sin contacto en +3 días\n`;
  }

  msg += `${div}\n`;
  msg += `${urgencia} Piloto Q2: *${cerrados}/${CUPOS_TOTAL}* firmados · *${diasCierre}d* para cierre\n`;
  msg += `${div}\n_¿Qué hacemos?_`;

  await send(msg, { reply_markup: KB_MENU });
}

// ── Lo que puedo hacer por ti ──────────────────────────────────────────────────
async function handleAutonomo() {
  await send(
    `🤖 *Lo que puedo hacer por ti*\n\n` +
    `*Sin input — ejecuto solo:*\n` +
    `📊 Estado completo del pipeline (CRM + ABM)\n` +
    `⚡ Alertas KPI críticas en tiempo real\n` +
    `🎯 3 próximos pasos accionables (IA)\n` +
    `🚦 Bloqueantes RAG rojo/ámbar/verde (IA)\n` +
    `⚖️ Decisiones urgentes de esta semana (IA)\n` +
    `📈 Reporte semanal consolidado\n` +
    `📋 Acciones ABM de hoy ordenadas por ICP\n` +
    `📅 Agenda completa 14 días\n` +
    `⏱ Cuenta regresiva Q2 con análisis de cobertura\n\n` +
    `*Con un dato tuyo:*\n` +
    `💬 \`/mensaje [empresa]\` — Redacto el outreach listo para copiar\n` +
    `🔄 \`/iniciar [empresa]\` — Activo la cadencia D1/D3/D7\n` +
    `🎤 \`/objecion [tipo]\` — Genero el rebate para precio/tiempo/riesgo\n` +
    `🧠 \`/pregunta [consulta]\` — Respondo cualquier duda estratégica\n` +
    `📌 \`/actualizar [empresa] [estado]\` — Actualizo el CRM\n\n` +
    `_Toca lo que necesitas 👇_`,
    { reply_markup: KB_AUTONOMO }
  );
}

// ── Asesor estratégico ────────────────────────────────────────────────────────
async function handlePregunta(query) {
  if (!query?.trim()) {
    await send(
      '💡 *Asesor estratégico*\n\nUso: `/pregunta [tu pregunta]`\n\n' +
      '_Ejemplos:_\n' +
      '`/pregunta ¿cómo priorizo los bloqueantes esta semana?`\n' +
      '`/pregunta ¿cuál debería ser mi foco de ventas este mes?`\n' +
      '`/pregunta ¿cómo respondo a una objeción de precio?`'
    );
    return;
  }

  await send('🧠 _Consultando al asesor estratégico..._');

  const hoy = new Date().toLocaleDateString('es-PE', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Lima',
  });

  const prompt =
    `Eres el asesor estratégico personal de Ricardo Cuba, fundador de Treevü (EWA B2B2E, Perú).\n\n` +
    `Contexto de Treevü:\n` +
    `- Producto: acceso anticipado al salario devengado para colaboradores (EWA). Costo S/0 para el colaborador, modelo no-custodio (cero riesgo empresa).\n` +
    `- Motor ML que predice renuncia 3 semanas antes.\n` +
    `- Etapa: early sales, piloto Q2 con ${CUPOS_TOTAL} cupos disponibles, cierre 30 abril.\n` +
    `- Pipeline: CRM inbound + outbound ABM activo.\n` +
    `- Canales: LinkedIn (D1), Email (D3), Email/llamada de seguimiento (D7).\n` +
    `- Meta: cerrar 2 pilotos fundadores antes del 30 abril.\n\n` +
    `Fecha actual: ${hoy}\n\n` +
    `Pregunta de Ricardo: ${query.trim()}\n\n` +
    `Responde como asesor experimentado en B2B SaaS early-stage. Máximo 5 líneas. Directo, accionable, sin relleno. Si la pregunta requiere contexto que no tienes, dilo brevemente y da igual tu mejor recomendación.`;

  try {
    const respuesta = await _askClaude(prompt, 200);
    if (!respuesta) throw new Error('Sin respuesta');
    await send(`🧠 *Asesor estratégico*\n\n${respuesta}`);
  } catch (err) {
    console.error('[abm-bot] /pregunta error:', err.message);
    await send('❌ No pude conectar con el asesor. Intenta de nuevo en un momento.');
  }
}

// ── Botón inline: resultado post-reunión ──────────────────────────────────────
async function handleResultadoButton(cq) {
  const [, idRaw, code] = cq.data.split(':');
  const estado = RESULTADO_CODES[code];
  const label  = RESULTADO_LABEL[code];
  if (!estado) return _answerCallback(cq.id, '❓ Opción desconocida');
  const pageId = restoreId(idRaw);
  try {
    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
    await notionPatch(pageId, {
      Estado: { select: { name: estado } },
      'Fecha Último Contacto': { date: { start: hoy } },
    });
    await _answerCallback(cq.id, `✅ ${estado}`);
    const newText = `${cq.message?.text || ''}\n\n${label}`;
    await _editMessage(cq.message.chat.id, cq.message.message_id, newText);

    // Para L (LOI) y F (Follow-up): buscar en CRM y disparar post-meeting
    if (code === 'L' || code === 'F') {
      try {
        const pageRes = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
          headers: { 'Authorization': `Bearer ${NOTION.TOKEN}`, 'Notion-Version': '2022-06-28' },
        });
        if (pageRes.ok) {
          const page    = await pageRes.json();
          const empresa = getProp(page, 'Empresa') || '';
          if (empresa) {
            const crmData = await notionQuery(NOTION_CRM_DB, {
              property: 'Empresa', rich_text: { contains: empresa },
            }, 1);
            const crmLead = crmData.results?.[0];
            if (crmLead) await triggerPostMeeting(crmLead.id, { siguiente_paso: RESULTADO_SIG[code], dolor_principal: 'Registrado desde botón ABM' });
          }
        }
      } catch (err) {
        console.error('[abm-bot] post-meeting trigger error:', err.message);
      }
    }
  } catch (err) {
    console.error('[abm-bot] resultado button error:', err.message);
    await _answerCallback(cq.id, '❌ Error al actualizar');
  }
}

// ── Notificar al prospecto vía @treevubot cuando el equipo actúa ──────────────
async function notifyProspect(pageId, estado) {
  const vuBotToken = process.env.TELEGRAM_VU_BOT_TOKEN;
  if (!vuBotToken) return;

  try {
    // Leer el Notion page para extraer el chatId guardado en Notas
    const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      headers: { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28' },
    });
    if (!res.ok) return;
    const page = await res.json();

    const notas = page.properties?.['Notas']?.rich_text?.[0]?.plain_text || '';
    const match = notas.match(/\[tg:(\d+)\]/);
    if (!match) return; // lead no vino de @treevubot

    const chatId = match[1];
    const nombre = page.properties?.['Nombre y Cargo']?.title?.[0]?.plain_text || '';
    const firstName = nombre.split(/[\s,]+/)[0] || '';

    const messages = {
      Contactado: `Hola${firstName ? ` ${firstName}` : ''} 👋 El equipo de Treevü revisó tu información y se pondrá en contacto contigo muy pronto.`,
      Reunion:    `Hola${firstName ? ` ${firstName}` : ''} 📅 Quedó confirmada tu reunión con el equipo de Treevü. Nos vemos pronto.`,
    };

    const text = messages[estado];
    if (!text) return;

    await sendMessage(vuBotToken, chatId, text);

    console.log(`[abm-bot] Prospecto notificado via @treevubot — chatId ${chatId}, estado: ${estado}`);
  } catch (err) {
    console.error('[abm-bot] notifyProspect error:', err.message);
  }
}

// ── Botón inline: actualizar estado CRM ───────────────────────────────────────
async function handleEstadoButton(cq) {
  const [, idRaw, code] = cq.data.split(':');
  const estado = ESTADO_CODES[code];
  if (!estado) return _answerCallback(cq.id, '❓ Acción desconocida');
  const pageId = restoreId(idRaw);
  try {
    await notionPatch(pageId, { Estado: { select: { name: estado } } });
    await _answerCallback(cq.id, `✅ ${estado}`);
    const newText = `${cq.message?.text || ''}\n\n${ESTADO_EMOJI[estado] || '✏️'} *Estado → ${estado}*`;
    await _editMessage(cq.message.chat.id, cq.message.message_id, newText);

    // Notificar al prospecto si vino de @treevubot (Contactado o Reunion)
    if (code === 'C' || code === 'R') {
      notifyProspect(pageId, estado).catch(() => {});
    }
  } catch (err) {
    console.error('[abm-bot] estado button error:', err.message);
    await _answerCallback(cq.id, '❌ Error al actualizar');
  }
}

// ── Handler principal ──────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  const body = req.body || {};

  // ── Callbacks de botones inline ────────────────────────────────────────────
  if (body.callback_query) {
    const cq = body.callback_query;
    await answerCallback(TOKEN, cq.id);

    if (cq.data?.startsWith('pm_start:')) {
      // CEO: iniciar flujo post-meeting
      const lead_id = cq.data.slice(9);
      const cbChatId = String(cq.message.chat.id);
      await setCeoState(cbChatId, { step: 'awaiting_siguiente', lead_id });
      await editMessage(TOKEN, cbChatId, cq.message.message_id, (cq.message.text || '') + '\n\n_✏️ Registrando resultado..._');
      await sendMessage(TOKEN, cbChatId, '*¿Cuál fue el resultado de la reunión?*', { reply_markup: kbSiguientePM(lead_id) });
    } else if (cq.data?.startsWith('pm_sig:')) {
      // CEO: siguiente paso seleccionado → pedir dolor
      const parts    = cq.data.split(':');
      const sigAbrev = parts[1];
      const lead_id  = parts.slice(2).join(':');
      const sig      = PM_SIG_MAP[sigAbrev] || 'seguimiento';
      const sigLabel = PM_SIG_LABEL[sigAbrev] || sig;
      const cbChatId = String(cq.message.chat.id);
      await setCeoState(cbChatId, { step: 'awaiting_dolor', lead_id, siguiente_paso: sig });
      await editMessage(TOKEN, cbChatId, cq.message.message_id,
        `*Resultado: ${sigLabel}* ✓\n\n¿Cuál fue el *dolor principal* que mencionaron?\n_(Texto libre)_`
      );
    } else if (cq.data?.startsWith('e:')) {
      await handleEstadoButton(cq);
    } else if (cq.data?.startsWith('r:')) {
      await handleResultadoButton(cq);
    } else if (cq.data?.startsWith('menu:')) {
      const action = cq.data.split(':')[1];
      try {
        if      (action === 'hoy')        await handleHoy();
        else if (action === 'alertas')    await handleAlerta();
        else if (action === 'estado')     await handleEstado();
        else if (action === 'nextstep')   await handleNextStep();
        else if (action === 'bloqueantes') await handleBloqueantes();
        else if (action === 'decision')   await handleDecision();
        else if (action === 'reporte')    await handleReporte();
        else if (action === 'agenda')     await handleAgenda();
        else if (action === 'cuenta')     await handleCuenta();
        else if (action === 'autonomo')   await handleAutonomo();
        else if (action === 'inicio')     await handleHelp();
        else if (action === 'buscar')     await send('Escribe `/buscar [nombre o empresa]` para buscar en CRM y ABM.');
        else if (action === 'comandos')   await send(
          `*Todos los comandos:*\n\n` +
          `📊 \`/estado\` \`/alerta\` \`/reporte\` \`/nextstep\` \`/pipeline\`\n` +
          `🎯 \`/hoy\` \`/manana\` \`/semana\` \`/agenda\`\n` +
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

  // ── CEO: flujo post-meeting (texto libre, no comando) ──────────────────────
  if (inChatId === String(CEO_CHAT_ID)) {
    try {
      const ceoState = await getCeoState(inChatId);
      if (ceoState?.step === 'awaiting_dolor') {
        await clearCeoState(inChatId);
        await triggerPostMeeting(ceoState.lead_id, ceoState.siguiente_paso, text);
        await sendMessage(TOKEN, inChatId, '✅ *Listo.* Notion actualizado, follow-up draft creado en Gmail.');
        return res.status(200).json({ ok: true });
      }
    } catch (err) { console.error('[abm-bot] CEO state error:', err.message); }
  }

  // Procesar comando y luego responder — el Lambda permanece vivo durante el await.
  // Telegram espera hasta 5s; el timeout de Vercel serverless es 10s (plan gratuito).
  try {
    if (text === '/hoy')                              await handleHoy();
    else if (text === '/manana' || text === '/mañana') await handleManana();
    else if (text === '/agenda')                      await handleAgenda();
    else if (text.startsWith('/resultado'))           await handleResultado(text.replace('/resultado', '').trim());
    else if (text.startsWith('/reunion'))             await handleReunion(text.replace('/reunion', '').trim());
    else if (text.startsWith('/mensaje'))             await handleMensaje(text.replace('/mensaje', '').trim());
    else if (text.startsWith('/iniciar'))             await handleIniciar(text.replace('/iniciar', '').trim());
    else if (text.startsWith('/buscar'))              await handleBuscar(text.replace('/buscar', '').trim());
    else if (text === '/pipeline')                    await handlePipeline();
    else if (text.startsWith('/pregunta'))            await handlePregunta(text.replace('/pregunta', '').trim());
    // ── Command Center ────────────────────────────────────────────────────────
    else if (text === '/estado')                      await handleEstado();
    else if (text === '/alerta')                      await handleAlerta();
    else if (text === '/reporte')                     await handleReporte();
    else if (text === '/nextstep')                    await handleNextStep();
    else if (text === '/cronograma')                  await handleCronograma();
    else if (text === '/semana')                      await handleSemana();
    else if (text === '/bloqueantes')                 await handleBloqueantes();
    else if (text === '/decision')                    await handleDecision();
    else if (text.startsWith('/leads'))               await handleLeads(text.replace('/leads', '').trim().toLowerCase());
    else if (text === '/contactos')                   await handleContactos();
    else if (text.startsWith('/actualizar'))          await handleActualizar(text.replace('/actualizar', '').trim());
    else if (text === '/compliance')                  await handleCompliance();
    else if (text === '/partners')                    await handlePartners();
    else if (text === '/ml')                          await handleMl();
    else if (text.startsWith('/gatereview'))          await handleGatereview(text.replace('/gatereview', '').trim());
    else if (text === '/cuenta')                      await handleCuenta();
    else if (text.startsWith('/objecion'))            await handleObjecion(text.replace('/objecion', '').trim());
    else if (text === '/help' || text === '/start')    await handleHelp();
    else if (text === '/autonomo')                     await handleAutonomo();
  } catch (err) {
    console.error(`[abm-bot] handler error for "${text}":`, err.message);
    captureException(err, { text, chat_id: inChatId });
  }

  return res.status(200).json({ ok: true });
}
