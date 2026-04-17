// api/lib/abm-crm.js — Handlers CRM, reuniones, métricas y botones de resultado/estado

import { notionQuery, notionPatch, getProp, restoreId } from './notion.js';
import { sendMessage } from './telegram.js';
import { redisCmd } from './redis.js';
import { getPipelineSummary } from './pipeline.js';
import { SCORE_EMOJI, ESTADO_EMOJI, NOTION, CONFIG } from './constants.js';
import {
  send, _answerCallback, _editMessage,
  TOKEN, CHAT_ID,
  NOTION_CRM_DB, NOTION_EJECUCION_DB, CUPOS_TOTAL, FECHA_CIERRE,
  ESTADO_CODES, RESULTADO_CODES, RESULTADO_LABEL, RESULTADO_SIG,
  triggerPreMeeting, triggerPostMeeting,
} from './abm-helpers.js';

// ── /pipeline ─────────────────────────────────────────────────────────────────
export async function handlePipeline() {
  try {
    const msg = await getPipelineSummary({ showDetails: false, showActions: false });
    await send(msg);
  } catch (err) {
    console.error('[abm] /pipeline error:', err.message);
    await send('❌ Error al consultar el pipeline.');
  }
}

// ── /buscar ───────────────────────────────────────────────────────────────────
export async function handleBuscar(query) {
  if (!query?.trim()) { await send('Uso: `/buscar nombre o empresa`'); return; }
  try {
    const [crmData, abmData] = await Promise.all([
      notionQuery(NOTION_CRM_DB, {
        or: [
          { property: 'Nombre y Cargo', title:     { contains: query } },
          { property: 'Empresa',        rich_text: { contains: query } },
        ],
      }, 5),
      notionQuery(NOTION_EJECUCION_DB, { property: 'Empresa', title: { contains: query } }, 3),
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
        const empresa  = getProp(lead, 'Empresa')           || 'Sin empresa';
        const decisor  = getProp(lead, 'Decisor')           || '';
        const estado   = getProp(lead, 'Estado')            || '';
        const d7       = getProp(lead, 'Día 7 (WhatsApp)')  || '';
        const reunConf = getProp(lead, 'Reunión Confirmada');
        msg += `🏢 *${empresa}*\n`;
        if (decisor)  msg += `👤 ${decisor}\n`;
        if (estado)   msg += `📌 ${estado}\n`;
        if (d7)       msg += `📅 D7: ${d7}\n`;
        if (reunConf) msg += `✅ Reunión confirmada\n`;
        msg += '\n';
      }
    }

    await send(msg);
  } catch (err) {
    console.error('[abm] /buscar error:', err.message);
    await send('❌ Error al buscar en Notion.');
  }
}

// ── /resultado ────────────────────────────────────────────────────────────────
export async function handleResultado(query) {
  if (!query?.trim()) { await send('Uso: `/resultado nombre de empresa`'); return; }
  try {
    const data  = await notionQuery(NOTION_EJECUCION_DB, { property: 'Empresa', title: { contains: query.trim() } }, 3);
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
    console.error('[abm] /resultado error:', err.message);
    await send('❌ Error al registrar resultado.');
  }
}

// ── /reunion ──────────────────────────────────────────────────────────────────
export async function handleReunion(query) {
  if (!query?.trim()) {
    await send('Uso: `/reunion [empresa]`\n_Ej: `/reunion Textil Peru`_');
    return;
  }
  const empresa = query.trim();
  try {
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

    await notionPatch(crmLead.id, { 'Estado': { select: { name: 'Reunion' } } });
    await triggerPreMeeting(crmLead.id, null);

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
    console.error('[abm] /reunion error:', err.message);
    await send('❌ Error al confirmar la reunión.');
  }
}

// ── /estado ───────────────────────────────────────────────────────────────────
export async function handleEstado() {
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

// ── /alerta ───────────────────────────────────────────────────────────────────
export async function handleAlerta() {
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

      if (score === 'ALTO' && ['Nuevo', 'Contactado'].includes(estado) && ultimoContacto <= hace3d) {
        const dias = Math.floor((Date.now() - new Date(ultimoContacto)) / 864e5);
        alertas.push(`🔴 *${nombre}* · ${empresa} · ${dias}d sin contacto`);
      }

      if (['Reunion', 'Propuesta'].includes(estado)) {
        const fechaReunion = getProp(l, 'Fecha Reunión') || ultimoContacto;
        if (fechaReunion && fechaReunion <= hace5d) {
          const dias = Math.floor((Date.now() - new Date(fechaReunion)) / 864e5);
          alertas.push(`🟠 *${nombre}* · ${empresa} · Reunión hace ${dias}d — ¿enviaste propuesta?`);
        }
      }
    }

    for (const l of abm) {
      const estado  = getProp(l, 'Estado')           || '';
      const empresa = getProp(l, 'Empresa')          || 'Sin empresa';
      const d7      = getProp(l, 'Día 7 (WhatsApp)') || '';
      if (estado === 'En cadencia' && d7 && d7 < hoy)
        alertas.push(`⚠️ *${empresa}* · ABM — cadencia completada, define next step`);
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

// ── /reporte ──────────────────────────────────────────────────────────────────
export async function handleReporte() {
  try {
    const [crmData, abmData] = await Promise.all([
      notionQuery(NOTION_CRM_DB),
      notionQuery(NOTION_EJECUCION_DB),
    ]);
    const crm = crmData.results || [];
    const abm = abmData.results || [];
    const hace7d    = new Date(Date.now() - 7 * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
    const nuevos    = crm.filter(l => (l.created_time || '').split('T')[0] >= hace7d);
    const reunion   = crm.filter(l => ['Reunion', 'Propuesta'].includes(getProp(l, 'Estado') || ''));
    const cerrados  = crm.filter(l => getProp(l, 'Estado') === 'Cerrado');
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

// ── /cuenta ───────────────────────────────────────────────────────────────────
export async function handleCuenta() {
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

    const urgencia = diasCierre <= 7  ? '🔴' : diasCierre <= 14 ? '🟠' : diasCierre <= 21 ? '🟡' : '🟢';

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
      msg += `⚠️ _Necesitas ${cuposLibres - enReunion} reunión(es) adicional(es) para tener cobertura de cierre._`;
    } else {
      msg += `🎉 _¡Pipeline completado! ${cerrados}/${CUPOS_TOTAL} pilotos firmados._`;
    }

    await send(msg);
  } catch (err) { await send('❌ Error al calcular el contador.'); }
}

// ── /cronograma ───────────────────────────────────────────────────────────────
export async function handleCronograma() {
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

// ── /leads ────────────────────────────────────────────────────────────────────
export async function handleLeads(filtro) {
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
    const data  = await notionQuery(NOTION_CRM_DB, filter, 20);
    const leads = data.results || [];
    if (!leads.length) { await send(`Sin leads para _${titulo}_`); return; }
    let msg = `📋 *${titulo}* · ${leads.length} leads\n\n`;
    for (const l of leads.slice(0, 12)) {
      const nombre  = getProp(l, 'Nombre y Cargo') || 'Sin nombre';
      const empresa = getProp(l, 'Empresa') || '';
      const estado  = getProp(l, 'Estado')  || 'Nuevo';
      const score   = getProp(l, 'Score')   || 'BAJO';
      const email   = getProp(l, 'Email')   || '';
      msg += `${SCORE_EMOJI[score] || '·'} *${nombre}*\n`;
      if (empresa) msg += `🏢 ${empresa}\n`;
      if (email)   msg += `📧 ${email}\n`;
      msg += `${ESTADO_EMOJI[estado] || '·'} ${estado}\n\n`;
    }
    if (leads.length > 12) msg += `_... y ${leads.length - 12} más. Usa /buscar para filtrar._`;
    await send(msg);
  } catch (err) { await send('❌ Error al consultar leads.'); }
}

// ── /contactos ────────────────────────────────────────────────────────────────
export async function handleContactos() {
  try {
    const data  = await notionQuery(NOTION_EJECUCION_DB, null, 50);
    const leads = data.results || [];
    if (!leads.length) { await send('Sin contactos en pipeline ABM.'); return; }
    let msg = `📇 *Directorio ABM* · ${leads.length} empresas\n\n`;
    for (const l of leads.slice(0, 18)) {
      const empresa  = getProp(l, 'Empresa')                              || 'Sin empresa';
      const decisor  = getProp(l, 'Decisor')                             || '';
      const telefono = getProp(l, 'Teléfono')                            || '';
      const email    = getProp(l, 'Email Decisor') || getProp(l, 'Email') || '';
      const estado   = getProp(l, 'Estado')                              || '';
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

// ── /actualizar ───────────────────────────────────────────────────────────────
export async function handleActualizar(query) {
  const estadosValidos = ['Nuevo', 'Contactado', 'Reunion', 'Propuesta', 'Cerrado', 'Descartado'];
  if (!query?.trim()) {
    await send(`Uso: \`/actualizar [empresa] [estado]\`\n\nEstados: ${estadosValidos.map(e => `\`${e}\``).join(' ')}`);
    return;
  }
  const tokens    = query.trim().split(' ');
  const estadoRaw = tokens.pop();
  const empresa   = tokens.join(' ').trim();
  const estado    = estadosValidos.find(e => e.toLowerCase() === estadoRaw.toLowerCase());
  if (!estado)  { await send(`Estado _"${estadoRaw}"_ no válido.\nUsa: ${estadosValidos.map(e => `\`${e}\``).join(' ')}`); return; }
  if (!empresa) { await send('Falta el nombre de la empresa.\nUso: `/actualizar [empresa] [estado]`'); return; }
  try {
    const data  = await notionQuery(NOTION_CRM_DB, { property: 'Empresa', rich_text: { contains: empresa } }, 3);
    const leads = data.results || [];
    if (!leads.length) { await send(`Sin resultados para _"${empresa}"_ en CRM.`); return; }
    const lead     = leads[0];
    const nombre   = getProp(lead, 'Empresa') || empresa;
    const anterior = getProp(lead, 'Estado')  || 'Nuevo';
    await notionPatch(lead.id, { Estado: { select: { name: estado } } });
    await send(`✅ *${nombre}*\n${ESTADO_EMOJI[anterior] || '·'} ${anterior} → ${ESTADO_EMOJI[estado] || '·'} *${estado}*`);
  } catch (err) { await send('❌ Error al actualizar.'); }
}

// ── Botón inline: resultado post-reunión ─────────────────────────────────────
export async function handleResultadoButton(cq) {
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
    await _editMessage(cq.message.chat.id, cq.message.message_id, `${cq.message?.text || ''}\n\n${label}`);

    if (code === 'L' || code === 'F') {
      try {
        const pageRes = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
          headers: { 'Authorization': `Bearer ${NOTION.TOKEN}`, 'Notion-Version': '2022-06-28' },
        });
        if (pageRes.ok) {
          const page    = await pageRes.json();
          const empresa = getProp(page, 'Empresa') || '';
          if (empresa) {
            const crmData = await notionQuery(NOTION_CRM_DB, { property: 'Empresa', rich_text: { contains: empresa } }, 1);
            const crmLead = crmData.results?.[0];
            if (crmLead) await triggerPostMeeting(crmLead.id, { siguiente_paso: RESULTADO_SIG[code], dolor_principal: 'Registrado desde botón ABM' });
          }
        }
      } catch (err) {
        console.error('[abm] post-meeting trigger error:', err.message);
      }
    }
  } catch (err) {
    console.error('[abm] resultado button error:', err.message);
    await _answerCallback(cq.id, '❌ Error al actualizar');
  }
}

// ── Notificar al prospecto vía @treevubot ─────────────────────────────────────
async function notifyProspect(pageId, estado) {
  const vuBotToken = CONFIG.TELEGRAM_VU_BOT_TOKEN;
  if (!vuBotToken) return;

  try {
    const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      headers: { 'Authorization': `Bearer ${NOTION.TOKEN}`, 'Notion-Version': '2022-06-28' },
    });
    if (!res.ok) return;
    const page = await res.json();

    const notas   = page.properties?.['Notas']?.rich_text?.[0]?.plain_text || '';
    const match   = notas.match(/\[tg:(\d+)\]/);
    if (!match) return;

    const chatId     = match[1];
    const nombre     = page.properties?.['Nombre y Cargo']?.title?.[0]?.plain_text || '';
    const firstName  = nombre.split(/[\s,]+/)[0] || '';

    const messages = {
      Contactado: `Hola${firstName ? ` ${firstName}` : ''} 👋 El equipo de Treevü revisó tu información y se pondrá en contacto contigo muy pronto.`,
      Reunion:    `Hola${firstName ? ` ${firstName}` : ''} 📅 Quedó confirmada tu reunión con el equipo de Treevü. Nos vemos pronto.`,
    };

    const text = messages[estado];
    if (!text) return;

    await sendMessage(vuBotToken, chatId, text);
    console.log(`[abm] Prospecto notificado via @treevubot — chatId ${chatId}, estado: ${estado}`);
  } catch (err) {
    console.error('[abm] notifyProspect error:', err.message);
  }
}

// ── Botón inline: actualizar estado CRM ──────────────────────────────────────
export async function handleEstadoButton(cq) {
  const [, idRaw, code] = cq.data.split(':');
  const estado = ESTADO_CODES[code];
  if (!estado) return _answerCallback(cq.id, '❓ Acción desconocida');
  const pageId = restoreId(idRaw);
  try {
    await notionPatch(pageId, { Estado: { select: { name: estado } } });
    await _answerCallback(cq.id, `✅ ${estado}`);
    await _editMessage(cq.message.chat.id, cq.message.message_id, `${cq.message?.text || ''}\n\n${ESTADO_EMOJI[estado] || '✏️'} *Estado → ${estado}*`);

    if (code === 'C' || code === 'R') {
      notifyProspect(pageId, estado).catch(() => {});
    }
  } catch (err) {
    console.error('[abm] estado button error:', err.message);
    await _answerCallback(cq.id, '❌ Error al actualizar');
  }
}
