// api/lib/abm-ai.js — Handlers IA (mensaje, objeción, análisis) y menús ABM

import { notionQuery, getProp } from './notion.js';
import { tg } from './telegram.js';
import { redisCmd } from './redis.js';
import {
  send, _askClaude,
  TOKEN, CHAT_ID,
  NOTION_CRM_DB, NOTION_EJECUCION_DB,
  CUPOS_TOTAL, FECHA_CIERRE, CALENDLY,
} from './abm-helpers.js';
import { escapeMd as _escapeMd } from './telegram.js';

// ── /mensaje ──────────────────────────────────────────────────────────────────
export async function handleMensaje(query) {
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

    let canal = 'LinkedIn';
    if      (d7 && d7 <= hoy) canal = 'Seguimiento';
    else if (d3 && d3 <= hoy) canal = 'Email';
    else if (d1 && d1 <= hoy) canal = 'LinkedIn';

    const primerNombre = decisor.split(/[\s,]+/)[0] || 'Hola';

    const instruccionCanal =
      canal === 'LinkedIn'
        ? `Conexión + mensaje. Máximo 3 líneas. Abre con el ángulo financiero (caja/reserva) si el decisor es CFO, o con retención si es RRHH/CEO. Termina con pregunta: "¿Te interesa charlar 20 min?"`
      : canal === 'Email'
        ? `Asunto: "${empresa} — Predice tu caja y retén a tu equipo (${CUPOS_TOTAL} cupos)". Cuerpo: 5-6 líneas. Menciona los dos ROIs: CFO (reserva de caja −45%) y retención (−40% renuncias). CTA: confirmar 20 min.`
      :
        `Email breve de seguimiento. Asunto: "Re: Treevü — cupos Q2 cerrando". Máximo 3 líneas. Tono directo y urgente: quedan pocos cupos, cierre 30 abr. CTA: "¿Agendamos 20 min esta semana?" + link Calendly.`;

    const system =
      `Eres el equipo de ventas de Treevü (Perú), redactando en nombre del fundador.\n` +
      `Producto: acceso anticipado al salario propio del colaborador — S/ 0 costo para ellos, cero riesgo para la empresa.\n` +
      `Dos ángulos de valor: (1) CFO/Finanzas: predice la demanda 30 días antes, reduce reserva de caja hasta 45%, cero pasivo nuevo; (2) CEO/RRHH: renuncias por estrés financiero −40%, alertas de rotación 3 semanas antes.\n` +
      `Motor ML con 5 modelos. Setup en 2 semanas.\n` +
      `Piloto Q2: ${CUPOS_TOTAL} cupos disponibles, cierre 30 abril. Calendly: ${CALENDLY}\n\n` +
      `Reglas:\n- Canal activo: ${canal}. ${instruccionCanal}\n` +
      `- Responde SOLO con el mensaje listo para copiar, sin explicaciones ni contexto adicional.`;

    const user =
      `Genera el mensaje ${canal} para este lead:\n` +
      `- Empresa: ${empresa}\n- Decisor: ${decisor} (primer nombre: ${primerNombre})\n` +
      `- Sector: ${sector}\n- Score ICP: ${score || 'no indicado'}\n- Notas: ${notas || 'ninguna'}`;

    await send(`⏳ _Generando mensaje ${canal} para ${empresa}..._`);

    const mensaje = await _askClaude({ system, user }, 300);
    if (!mensaje) { await send('❌ Error generando mensaje con IA.'); return; }

    const canal_emoji    = canal === 'LinkedIn' ? '🔵' : canal === 'Email' ? '📧' : '📞';
    const empresaEsc     = _escapeMd(empresa);
    const mensajeEscapado = mensaje.replace(/`/g, "'");
    await send(`${canal_emoji} *Mensaje ${canal} — ${empresaEsc}*\n\n\`\`\`\n${mensajeEscapado}\n\`\`\`\n\n_Copia y envía manualmente por ${canal}_`);

  } catch (err) {
    console.error('[abm] /mensaje error:', err.message);
    await send('❌ Error al generar el mensaje.');
  }
}

// ── /nextstep ─────────────────────────────────────────────────────────────────
export async function handleNextStep() {
  try {
    const [crmData, abmData] = await Promise.all([
      notionQuery(NOTION_CRM_DB),
      notionQuery(NOTION_EJECUCION_DB),
    ]);
    const crm       = crmData.results || [];
    const abm       = abmData.results || [];
    const alto      = crm.filter(l => getProp(l, 'Score') === 'ALTO').length;
    const enReunion = crm.filter(l => ['Reunion', 'Propuesta'].includes(getProp(l, 'Estado') || '')).length;
    const cerrados  = crm.filter(l => getProp(l, 'Estado') === 'Cerrado').length;
    const diasCierre = Math.ceil((new Date(FECHA_CIERRE) - new Date()) / 864e5);
    const system =
      `Eres asesor estratégico de ventas B2B SaaS early-stage para Treevü (EWA B2B2E, Perú).\n` +
      `Treevü: acceso al salario devengado para colaboradores, S/0 costo, modelo no-custodio, ML predice renuncias 3 semanas antes.\n` +
      `Responde siempre con exactamente 3 próximos pasos accionables para esta semana. Numerados, 1 línea c/u. Sin relleno.`;
    const user =
      `Pipeline actual:\n- CRM: ${crm.length} leads (${alto} ALTO, ${enReunion} en reunión/propuesta)\n` +
      `- ABM outbound: ${abm.length} empresas\n- Piloto: ${cerrados}/${CUPOS_TOTAL} firmados · ${diasCierre} días para cierre 30 abril`;
    await send('⏳ _Analizando pipeline..._');
    const resp = await _askClaude({ system, user }, 120);
    await send(`🎯 *Próximos pasos — esta semana*\n\n${resp}`);
  } catch (err) { await send('❌ Error al generar próximos pasos.'); }
}

// ── /bloqueantes ──────────────────────────────────────────────────────────────
export async function handleBloqueantes() {
  try {
    const [crmData, abmData] = await Promise.all([
      notionQuery(NOTION_CRM_DB),
      notionQuery(NOTION_EJECUCION_DB),
    ]);
    const crm        = crmData.results || [];
    const abm        = abmData.results || [];
    const diasCierre = Math.ceil((new Date(FECHA_CIERRE) - new Date()) / 864e5);
    const cerrados   = crm.filter(l => getProp(l, 'Estado') === 'Cerrado').length;
    const enReunion  = crm.filter(l => ['Reunion', 'Propuesta'].includes(getProp(l, 'Estado') || '')).length;
    const system =
      `Eres asesor estratégico de Treevü (EWA B2B2E, Perú). Identificas bloqueantes críticos de ventas.\n` +
      `Formato de respuesta: exactamente 3 líneas con emoji de semáforo.\n` +
      `Formato exacto por línea: 🔴/🟡/🟢 [Bloqueante] — [Acción inmediata]\nSin introducciones ni cierre.`;
    const user =
      `Pipeline actual (${diasCierre} días para cierre Q2 — 30 abril):\n` +
      `- CRM: ${crm.length} leads, ${crm.filter(l => getProp(l, 'Score') === 'ALTO').length} ALTO, ${enReunion} en reunión/propuesta\n` +
      `- ABM outbound: ${abm.length} empresas\n- Piloto: ${cerrados}/${CUPOS_TOTAL} cerrados`;
    await send('⏳ _Analizando bloqueantes..._');
    const resp = await _askClaude({ system, user }, 120);
    await send(`🚦 *Bloqueantes RAG*\n\n${resp}\n\n_/decision para decisiones pendientes_`);
  } catch (err) { await send('❌ Error al analizar bloqueantes.'); }
}

// ── /decision ─────────────────────────────────────────────────────────────────
export async function handleDecision() {
  try {
    const diasCierre = Math.ceil((new Date(FECHA_CIERRE) - new Date()) / 864e5);
    const system =
      `Eres asesor estratégico de Treevü (EWA B2B2E, Perú). Identificas decisiones urgentes de ventas early-stage.\n` +
      `Responde con exactamente 3 líneas numeradas.\n` +
      `Formato: [N]. [Decisión] — [Criterio o consecuencia de no decidir]\nSin relleno.`;
    const user =
      `Identifica las 3 decisiones más urgentes para esta semana.\n` +
      `Contexto: ${CUPOS_TOTAL} cupos piloto · ${diasCierre} días para cierre 30 abril.`;
    await send('⏳ _Identificando decisiones..._');
    const resp = await _askClaude({ system, user }, 120);
    await send(`⚖️ *Decisiones pendientes*\n\n${resp}`);
  } catch (err) { await send('❌ Error al generar decisiones.'); }
}

// ── /objecion ─────────────────────────────────────────────────────────────────
const OBJECIONES = {
  precio:      'precio / costo / inversión / caro',
  integracion: 'integración / sistema / nómina / tecnología / IT',
  tiempo:      'tiempo / ahora no / próximo año / no es el momento',
  riesgo:      'riesgo / startup / confianza / quién garantiza / pequeña empresa',
  prioridad:   'no es prioridad / tenemos otras cosas / estamos ocupados',
  resultado:   '¿cómo sé que funciona? / prueba / evidencia / caso',
};

export async function handleObjecion(tipo) {
  const tipos = Object.keys(OBJECIONES);

  if (!tipo?.trim() || !tipos.includes(tipo.trim().toLowerCase())) {
    let msg = `💬 *Rebatidor de objeciones*\n\nUso: \`/objecion [tipo]\`\n\n*Tipos disponibles:*\n`;
    for (const [k, v] of Object.entries(OBJECIONES)) msg += `· \`${k}\` — _"${v}"_\n`;
    await send(msg);
    return;
  }

  const t = tipo.trim().toLowerCase();
  const diasCierre = Math.ceil((new Date(FECHA_CIERRE) - new Date()) / 864e5);

  const objecionSystem =
    `Eres el equipo de ventas de Treevü (EWA B2B2E, Perú), experto en rebatir objeciones.\n` +
    `Treevü: acceso anticipado al salario devengado, S/0 costo para el colaborador, modelo no-custodio.\n` +
    `Motor ML predice renuncia 3 semanas antes. Setup en 2 semanas sin IT. Piloto Q2 con condiciones fundadoras.\n` +
    `Regla: responde SOLO con el rebate, máximo 4 líneas, sin preámbulo ni cierre.`;

  const objecionUser = {
    precio:
      `Objeción de precio: el cliente dice que Treevü es caro o pide justificar el costo.\n` +
      `Argumentos disponibles: costo reemplazo S/8,000+/colaborador, piloto de bajo costo, ROI en <1 renuncia evitada. Quedan ${diasCierre} días para cerrar Q2.`,
    integracion:
      `Objeción técnica: el cliente pregunta cómo se integra con su sistema de nómina.\n` +
      `Argumentos disponibles: piloto funciona con reporte mensual (Excel/PDF), sin IT. Integración API (Alegra, Concar, SIGE) en fase 2. Arranque en 2 semanas.`,
    tiempo:
      `Objeción de timing: el cliente dice que ahora no es el momento o lo evalúa para el próximo año.\n` +
      `Argumentos disponibles: condiciones fundadoras cierran el 30 de abril (${diasCierre} días). Q3 = condiciones estándar, precio mayor, sin co-diseño del producto.`,
    riesgo:
      `Objeción de confianza/riesgo: el cliente desconfía de una startup o pregunta quién garantiza el servicio.\n` +
      `Argumentos disponibles: modelo no-custodio (empresa no adelanta dinero, cero riesgo financiero), SLA definido, contrato con cláusula de responsabilidad limitada, el equipo Treevü atiende directamente.`,
    prioridad:
      `Objeción de prioridad: el cliente dice que tienen otras prioridades o están ocupados.\n` +
      `Argumentos disponibles: implementación toma 2 semanas y <2 horas del equipo de RRHH. Costo de oportunidad: S/8,000+ por cada renuncia que ocurre mientras se demora la decisión.`,
    resultado:
      `Objeción de evidencia: el cliente pide prueba de que Treevü funciona o casos de éxito.\n` +
      `Argumentos disponibles: lógica EWA validada globalmente (DailyPay, Earned, Leaf). ML predictor basado en modelos académicos. Piloto incluye gate reviews semana 2/4/6. Ser piloto fundador = co-diseño del producto.`,
  };

  try {
    await send(`⏳ _Preparando rebate para objeción de ${t}..._`);
    const resp = await _askClaude({ system: objecionSystem, user: objecionUser[t] }, 160);
    if (!resp) throw new Error('Sin respuesta de IA');
    await send(`💬 *Objeción: ${t}*\n\n${resp}\n\n_/objecion para ver todos los tipos_`);
  } catch (err) {
    console.error('[abm] /objecion error:', err.message);
    await send('❌ Error al generar el rebate.');
  }
}

// ── /pregunta ─────────────────────────────────────────────────────────────────
export async function handlePregunta(query) {
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

  const system =
    `Eres asesor estratégico de Treevü (EWA B2B2E, Perú) para ventas early-stage.\n\n` +
    `## CONTEXTO DEL PRODUCTO\n` +
    `- EWA: acceso al salario devengado antes del pago, S/0 costo para el colaborador, modelo no-custodio\n` +
    `- Motor ML predice renuncia 3 semanas antes\n` +
    `- Piloto Q2: ${CUPOS_TOTAL} cupos, cierre 30 abril\n` +
    `- Cadencia ABM: LinkedIn (D1) · Email (D3) · Seguimiento (D7)\n` +
    `- Meta: cerrar 2 pilotos fundadores antes del 30 abril\n\n` +
    `## REGLAS DE RESPUESTA\n` +
    `- Máximo 5 líneas, directo, accionable, sin relleno\n` +
    `- Si falta contexto para responder bien, indícalo brevemente y da tu mejor recomendación igual`;

  const user = `Fecha: ${hoy}\n\nPregunta: ${query.trim()}`;

  try {
    const respuesta = await _askClaude({ system, user }, 200);
    if (!respuesta) throw new Error('Sin respuesta');
    await send(`🧠 *Asesor estratégico*\n\n${respuesta}`);
  } catch (err) {
    console.error('[abm] /pregunta error:', err.message);
    await send('❌ No pude conectar con el asesor. Intenta de nuevo en un momento.');
  }
}

// ── Comandos informativos estáticos ──────────────────────────────────────────
export async function handleCompliance() {
  await send(
    `⚖️ *Compliance — Ciclo Legal Treevü*\n\n` +
    `*Documentos listos*\n· LOI (Letter of Intent) — template disponible\n· Contrato piloto B2B — modelo estándar\n· NDA — firmado antes de revelar datos técnicos\n\n` +
    `*Regulatorio Perú*\n· EWA no regulado específicamente → sin licencia SBS requerida\n· Modelo no-custodio: cero obligación de supervisión financiera\n· Sin modificación de contrato laboral del colaborador\n\n` +
    `*Próximos pasos legales*\n· Revisión cláusula de responsabilidad en contrato piloto\n· Definir SLA de pago con empresa cliente\n\n` +
    `_¿Dudas específicas? /pregunta [consulta legal]_`
  );
}

export async function handlePartners() {
  await send(
    `🤝 *Ecosistema B2B Treevü*\n\n` +
    `*Distribución*\n· CCPLL — Cámara de Comercio La Libertad\n· Asociaciones manufactureras Trujillo\n\n` +
    `*Tecnología*\n· Integración nómina vía API (Alegra, Concar, otros)\n· Pasarela de pagos: desembolso T+0\n\n` +
    `*Capital*\n· Programa Fundadores: primeros clientes = socios estratégicos\n· Ronda seed: por definir post-piloto\n\n` +
    `_/pregunta para análisis de partnerships específico_`
  );
}

export async function handleMl() {
  await send(
    `🤖 *Modelo ML — Predictor de Renuncia*\n\n` +
    `*Cómo funciona*\n· Inputs: frecuencia de uso EWA, patrón de adelantos, días sin actividad\n· Output: probabilidad de renuncia en próximas 3 semanas (0–100%)\n· Alerta automática a RRHH cuando score > umbral configurable\n\n` +
    `*Estado actual*\n· Entrenado con datos sintéticos de mercado peruano\n· Precisión proyectada: 78–82% (se valida en piloto)\n· Fine-tuning: con datos reales de los clientes piloto Q2\n\n` +
    `*Gates de validación*\n· Gate 2 (mes 2): primeras predicciones con data real\n· Gate 4 (mes 4): validar reducción de rotación vs baseline\n\n` +
    `_/gatereview 2 para criterios de éxito del mes 2_`
  );
}

export async function handleGatereview(num) {
  const gates = {
    '2': { t: 'Gate 2 — Mes 2 Piloto',     c: ['✅ ≥30% colaboradores activados en EWA', '✅ NPS colaborador > 7', '✅ Cero incidentes de pago', '✅ Integración nómina estable', '🎯 MRR objetivo: S/ 500+'] },
    '4': { t: 'Gate 4 — Mes 4 Piloto',     c: ['✅ Reducción rotación mensual > 10%', '✅ Tasa activación > 50%', '✅ NPS empresa > 8', '✅ Primera renovación o expansión', '🎯 MRR objetivo: S/ 1,200+'] },
    '6': { t: 'Gate 6 — Cierre Piloto (Mes 6)', c: ['✅ Reducción rotación > 25% vs baseline', '✅ ROI empresa demostrado > 3x', '✅ Decisión de expansión o contrato definitivo', '✅ Caso de estudio documentado', '🎯 MRR objetivo: S/ 2,500+'] },
  };
  const gate = gates[num];
  if (!gate) { await send('Uso: `/gatereview 2`, `/gatereview 4` o `/gatereview 6`'); return; }
  let msg = `🚪 *${gate.t}*\n\n*Criterios de éxito:*\n`;
  for (const c of gate.c) msg += `${c}\n`;
  msg += `\n_Revisa en reunión mensual con el cliente._`;
  await send(msg);
}

// ── Menús inline ──────────────────────────────────────────────────────────────
const KB_MENU = {
  inline_keyboard: [
    [{ text: '📋 Acciones de hoy',    callback_data: 'menu:hoy' },
     { text: '🧠 ¿Qué hago hoy?',    callback_data: 'menu:nextstep' }],
    [{ text: '📅 Agenda 14 días',     callback_data: 'menu:agenda' },
     { text: '⚡ Alertas KPI',        callback_data: 'menu:alertas' }],
    [{ text: '📊 Estado pipeline',    callback_data: 'menu:estado' },
     { text: '🔍 Buscar lead',        callback_data: 'menu:buscar' }],
    [{ text: '🗓 Registrar reunión',  callback_data: 'menu:reunion' },
     { text: '📝 Resultado reunión',  callback_data: 'menu:resultado' }],
    [{ text: '🤖 Lo que puedo hacer', callback_data: 'menu:autonomo' },
     { text: '📖 Comandos',           callback_data: 'menu:comandos' }],
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

// ── /start — Dashboard contextual ────────────────────────────────────────────
export async function handleHelp() {
  const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
  const fecha = new Date().toLocaleDateString('es-PE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Lima' });
  const hora  = new Date().toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Lima' });
  const hace3d = new Date(Date.now() - 3 * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
  const diasCierre = Math.ceil((new Date(FECHA_CIERRE) - new Date()) / 864e5);

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

  if (accionesHoy > 0)  msg += `📋 Hoy: *${accionesHoy} acción(es)* ABM pendiente(s)\n`;
  if (reunionesHoy > 0) msg += `📅 Reunion(es) hoy: *${reunionesHoy}*\n`;
  if (!accionesHoy && !reunionesHoy) msg += `📋 Sin acciones ABM programadas hoy\n`;
  if (altosUrgentes > 0) msg += `⚡ *${altosUrgentes} lead(s) ALTO* sin contacto en +3 días\n`;

  msg += `${div}\n`;
  msg += `${urgencia} Piloto Q2: *${cerrados}/${CUPOS_TOTAL}* firmados · *${diasCierre}d* para cierre\n`;
  msg += `${div}\n_¿Qué hacemos?_`;

  const prevMsgId = await redisCmd('GET', `menu_msg:${CHAT_ID}`).catch(() => null);
  if (prevMsgId) {
    await tg(TOKEN, 'deleteMessage', { chat_id: CHAT_ID, message_id: parseInt(prevMsgId) }).catch(() => {});
  }

  const sent = await send(msg, { reply_markup: KB_MENU });
  if (sent?.result?.message_id) {
    await redisCmd('SET', `menu_msg:${CHAT_ID}`, String(sent.result.message_id), 'EX', 86400);
  }
}

// ── /autonomo ─────────────────────────────────────────────────────────────────
export async function handleAutonomo() {
  await send(
    `🤖 *Lo que puedo hacer por ti*\n\n` +
    `*Sin input — ejecuto solo:*\n` +
    `📊 Estado completo del pipeline (CRM + ABM)\n⚡ Alertas KPI críticas en tiempo real\n🎯 3 próximos pasos accionables (IA)\n` +
    `🚦 Bloqueantes RAG rojo/ámbar/verde (IA)\n⚖️ Decisiones urgentes de esta semana (IA)\n📈 Reporte semanal consolidado\n` +
    `📋 Acciones ABM de hoy ordenadas por ICP\n📅 Agenda completa 14 días\n⏱ Cuenta regresiva Q2 con análisis de cobertura\n\n` +
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
