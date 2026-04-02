// api/primera-reunion.js — Agente de primera reunión
//
// Dos acciones:
//   pre-meeting  → genera briefing para el CEO antes de la reunión
//   post-meeting → procesa notas, actualiza CRM, genera follow-up en Gmail
//
// Trigger automático:  calendly-webhook.js llama pre-meeting al confirmar reunión
// Trigger manual:      POST /api/primera-reunion?secret=CRON_SECRET
//
// Ejemplos:
//   Pre:  { "action": "pre-meeting",  "lead_id": "<notion_page_id>", "fecha_reunion": "2026-04-01T15:00:00Z" }
//   Post: { "action": "post-meeting", "lead_id": "<notion_page_id>",
//            "notas": { "dolor_principal": "...", "siguiente_paso": "diagnostico|nda|no_fit|seguimiento",
//                       "objeciones": "...", "fecha_siguiente": "...", "interes": 4 } }

import { NOTION, PROGRAMA, SCORE_EMOJI } from './lib/constants.js';
import { notionPatch, getProp, getNotionPage } from './lib/notion.js';
import { askClaude }                      from './lib/anthropic.js';
import { sendMessage }                    from './lib/telegram.js';
import { captureException }               from './lib/sentry.js';
import { supabasePatch }                  from './lib/supabase.js';
import { redisCmd }                       from './lib/redis.js';
import { getGmailToken, gmailSend, gmailDraft } from './lib/gmail.js';

const BOT_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID     = process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET = process.env.CRON_SECRET;

async function storePostMeeting(lead, notas) {
  const ts   = Math.floor(Date.now() / 1000);
  const data = JSON.stringify({
    lead_id:        lead.id,
    empresa:        lead.empresa        || '',
    nombre:         lead.nombre         || '',
    email:          lead.email          || '',
    siguiente_paso: notas.siguiente_paso || '',
    dolor:          notas.dolor_principal || '',
    fecha:          new Date().toISOString(),
  });
  await Promise.all([
    redisCmd('ZADD', 'postmeetings', ts, lead.id),
    redisCmd('SET',  `postmeeting:${lead.id}`, data, 'EX', 2592000), // 30 días
  ]);
}

// Estado de Notion al que mapea cada siguiente_paso
const ESTADO_SIGUIENTE = {
  diagnostico: 'Propuesta',   // diagnóstico = avanzamos a propuesta
  nda:         'Reunion',     // necesita revisión legal — quedamos en reunión
  no_fit:      'Descartado',
  seguimiento: 'Contactado',
};

// ── Auth ──────────────────────────────────────────────────────────────────────
function isAuthorized(req) {
  const header = req.headers['authorization'];
  const query  = new URL(req.url || '/', 'https://x').searchParams.get('secret');
  return (header?.replace('Bearer ', '') || query) === CRON_SECRET;
}

// ── Fetch lead por ID de página Notion ───────────────────────────────────────
async function fetchLead(leadId) {
  const page = await getNotionPage(leadId);
  return {
    id:            page.id,
    nombre:        getProp(page, 'Nombre y Cargo'),
    email:         getProp(page, 'Email'),
    empresa:       getProp(page, 'Empresa'),
    sector:        getProp(page, 'Sector'),
    colaboradores: getProp(page, 'Colaboradores'),
    objetivo:      getProp(page, 'Objetivo'),
    reto:          getProp(page, 'Reto libre'),
    notas:         getProp(page, 'Notas'),
    score:         getProp(page, 'Score'),
    probabilidad:  getProp(page, 'Probabilidad'),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRE-MEETING
// ═══════════════════════════════════════════════════════════════════════════════

// ── Inteligencia sectorial para Peru ─────────────────────────────────────────
function getSectorIntel(sector, employees) {
  const intel = {
    'Retail y consumo': {
      rotacion: '35-45% anual',
      dolor: 'cajeros y personal de piso, turnos festivos, adelantos al supervisor',
      objecion: '"Ya tenemos bonos de permanencia"',
      respuesta: 'Los bonos retienen en papeles — el EWA elimina el estrés diario que causa la salida',
      perfil_decisor: 'Gerente de RRHH + Gerente de Operaciones (a veces CFO)',
      tip: 'Preguntar por ausentismo en temporadas altas (navidad, verano)',
    },
    'Manufactura': {
      rotacion: '25-35% anual',
      dolor: 'operarios con deudas, accidentabilidad por estrés, absentismo los lunes',
      objecion: '"Nuestros operarios no tienen smartphone"',
      respuesta: 'App funciona en Android 6+ básico — y hay versión web para compartir cabina',
      perfil_decisor: 'RRHH + COO. El área de nómina bloquea si no los incluyes desde el inicio',
      tip: 'Preguntar cuántos piden adelanto al área de RRHH por mes — número revelador',
    },
    'Salud': {
      rotacion: '20-30% anual (enfermeros y técnicos)',
      dolor: 'turnos nocturnos + deuda → renuncia sin previo aviso, difícil reemplazo urgente',
      objecion: '"Tenemos convenio con cooperativa de ahorro"',
      respuesta: 'La cooperativa es ahorro — Treevü resuelve liquidez inmediata sin endeudamiento',
      perfil_decisor: 'Dirección Médica o Gerencia General suele tomar la decisión final',
      tip: 'El ML de predicción de renuncia es muy llamativo en esta industria — mencionarlo',
    },
    'Servicios': {
      rotacion: '30-40% anual',
      dolor: 'call centers, limpieza, seguridad — alta rotación y bajo margen para bonos',
      objecion: '"El margen es muy ajustado para agregar costos"',
      respuesta: 'Costo S/ 0 para el colaborador — empresa paga S/ 7/activo/mes, se recupera en <1 renuncia evitada',
      perfil_decisor: 'Gerente de RRHH o Gerente General en empresas medianas',
      tip: 'Enfocarse en el ROI concreto: una renuncia evitada financia 12 meses de Treevü',
    },
    'Banca y finanzas': {
      rotacion: '15-20% anual',
      dolor: 'analistas y promotores financieros con estrés de cumplimiento de metas',
      objecion: '"Tenemos un banco interno / caja de beneficios"',
      respuesta: 'Treevü complementa — acceso inmediato sin proceso de aprobación ni deuda registrada',
      perfil_decisor: 'RRHH + Compliance. Presentar regulación SBS desde el inicio',
      tip: 'La aprobación SBS es un diferenciador clave — mencionarla primero con esta industria',
    },
    'Construccion/Mineria': {
      rotacion: '40-55% anual (alta volatilidad)',
      dolor: 'pagos por quincena o quincenal irregular, operarios con deudas de capital riesgo',
      objecion: '"La planilla es por obra, muy variable"',
      respuesta: 'Treevü se adapta a planillas por proyecto — solo se activa para colaboradores activos',
      perfil_decisor: 'Gerente de RRHH o Jefe de Administración en proyectos',
      tip: 'Alta rotación significa que el caso de negocio es muy fuerte — calcular en vivo',
    },
  };
  const data = intel[sector] || {
    rotacion: '20-35% promedio Peru',
    dolor: 'estrés financiero, adelantos informales, baja retención',
    objecion: '"No teníamos esto en nuestro presupuesto"',
    respuesta: 'El costo es variable y se activa solo con colaboradores activos — sin costo fijo',
    perfil_decisor: 'Gerente de RRHH o CEO en empresas medianas',
    tip: 'Preguntar cuántos colaboradores pidieron adelanto este mes',
  };

  const colabs = parseInt((employees || '').split('-')[0]) || 0;
  const renuncias = Math.round(colabs * 0.25);
  const ahorroEstimado = (renuncias * 8000).toLocaleString('es-PE');

  return { ...data, renuncias, ahorroEstimado, employees };
}

async function researchCompany(empresa, sector) {
  const TAVILY_KEY = process.env.TAVILY_API_KEY;
  if (!TAVILY_KEY || !empresa) return null;
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        api_key:        TAVILY_KEY,
        query:          `${empresa} Peru empresa empleados ${sector || ''}`,
        search_depth:   'basic',
        max_results:    3,
        include_answer: true,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const answer = data.answer || '';
    const snippets = (data.results || []).map(r => r.content?.slice(0, 200)).filter(Boolean).join(' | ');
    return (answer + ' ' + snippets).slice(0, 600) || null;
  } catch { return null; }
}

async function generarBriefing(lead, researchContext) {
  const intel = getSectorIntel(lead.sector, lead.colaboradores);

  const system = `Eres el asistente estratégico del CEO de Treevü, plataforma EWA B2B para empresas peruanas.
Tu rol: preparar al CEO para una primera reunión de presentación con un empleador prospecto.

Contexto clave de Treevü:
- Opera bajo supervisión SBS (sandbox regulatorio) — resuelve objeción legal antes de que la hagan
- Founders Program: ${PROGRAMA.CUPOS_TOTAL} cupos hasta ${PROGRAMA.FECHA_CIERRE} — urgencia real
- Modelo no-custodio: cero riesgo financiero para el empleador
- ML predictivo: alerta de renuncia 3 semanas antes
- Piloto desde S/ 7/colaborador activo/mes
- Integra con Buk y Mandü sin carga para TI

Inteligencia sectorial (${lead.sector || 'sector general'}, Peru):
- Rotación típica: ${intel.rotacion}
- Dolor más frecuente: ${intel.dolor}
- Objeción más probable: ${intel.objecion} → respuesta: ${intel.respuesta}
- Perfil decisor habitual: ${intel.perfil_decisor}
- Tip específico para esta reunión: ${intel.tip}
- Ahorro estimado si evitan ${intel.renuncias} renuncias/año: S/ ${intel.ahorroEstimado}

Genera un briefing operativo. Responde SOLO con JSON válido:
{
  "apertura": "<guion 30 segundos personalizado, primera persona, incluye dato sectorial>",
  "preguntas": [
    "<pregunta 1 — dolor específico del sector>",
    "<pregunta 2 — adelantos informales (¿cuántos al mes?)>",
    "<pregunta 3 — proceso de decisión y stakeholders>",
    "<pregunta 4 — condiciones para decir sí al piloto>",
    "<pregunta 5 — mayor preocupación o riesgo percibido>"
  ],
  "objeciones": [
    { "objecion": "${intel.objecion}", "respuesta": "<respuesta adaptada a este lead>" },
    { "objecion": "<segunda objeción probable>", "respuesta": "<respuesta concisa>" }
  ],
  "cierre": "<frase de cierre con urgencia Founders, natural no agresiva, menciona el ahorro de S/ ${intel.ahorroEstimado}>",
  "alerta": "<punto sensible específico de este sector/empresa a manejar con cuidado>"
}`;

  const user = `Lead para preparar:
- Empresa: ${lead.empresa || 'N/A'}
- Sector: ${lead.sector || 'N/A'} · ${lead.colaboradores || 'N/A'} colaboradores
- Objetivo declarado: ${lead.objetivo || 'N/A'}
- Reto propio: ${lead.reto || 'No especificado'}
- Score CRM: ${lead.score || 'N/A'}${lead.probabilidad ? ` (${lead.probabilidad}% fit)` : ''}
- Notas previas: ${lead.notas || 'Sin notas'}
- Decisor probable: ${intel.perfil_decisor}${researchContext ? `\n\nInvestigación web de la empresa (usa esto para personalizar):\n${researchContext}` : ''}`;

  try {
    const raw = await askClaude(user, { system, maxTokens: 700 });
    if (!raw) return null;
    const clean = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    return JSON.parse(clean);
  } catch (err) {
    console.error('[primera-reunion] Error briefing Claude:', err.message);
    return null;
  }
}

async function enviarBriefingTelegram(lead, briefing, fechaReunion) {
  const empresa = lead.empresa || 'empresa';
  const scoreEmoji = SCORE_EMOJI[lead.score] || '⚪';
  const fechaStr = fechaReunion
    ? new Date(fechaReunion).toLocaleString('es-PE', {
        timeZone: 'America/Lima', weekday: 'long',
        day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
      })
    : 'Próximamente';

  let msg = `📋 *BRIEFING REUNIÓN — ${empresa}*\n`;
  msg += `_${fechaStr}_\n`;
  msg += `\n${scoreEmoji} *${lead.nombre || 'Contacto'}*`;
  msg += ` · ${lead.sector || '?'} · ${lead.colaboradores || '?'} colaboradores\n`;

  if (briefing) {
    msg += `\n🎯 *APERTURA (30 seg)*\n_"${briefing.apertura}"_\n`;

    msg += `\n❓ *PREGUNTAS CLAVE*\n`;
    (briefing.preguntas || []).forEach((p, i) => { msg += `${i + 1}. ${p}\n`; });

    if (briefing.objeciones?.length) {
      msg += `\n🛡 *OBJECIONES PROBABLES*\n`;
      briefing.objeciones.forEach(o => { msg += `• _${o.objecion}_\n  ↳ ${o.respuesta}\n`; });
    }

    msg += `\n🔒 *CIERRE*\n_"${briefing.cierre}"_\n`;
    if (briefing.alerta) msg += `\n⚠️ *Alerta:* ${briefing.alerta}\n`;

  } else {
    // Fallback si Claude no responde
    msg += `\n❓ *PREGUNTAS CLAVE*\n`;
    msg += `1. ¿Cuál es el dolor principal hoy? (rotación, estrés financiero, clima)\n`;
    msg += `2. ¿Sus colaboradores piden adelantos de sueldo informalmente?\n`;
    msg += `3. ¿Quién decide y cuál es el proceso interno?\n`;
    msg += `4. ¿Qué condiciones harían que el piloto sea un "sí"?\n`;
    msg += `5. ¿Qué les preocuparía? (legal, datos, carga operativa)\n`;
    msg += `\n🔒 *Cierre:* _"Tenemos ${PROGRAMA.CUPOS_TOTAL} cupos del Founders Program hasta el ${PROGRAMA.FECHA_CIERRE} — eso nos permite condiciones preferenciales de piloto."_\n`;
  }

  msg += `\n─────────────────────────\n`;
  msg += `📅 *AGENDA* (30-45 min)\n`;
  msg += `• 5 min — Contexto de la empresa\n`;
  msg += `• 10 min — Treevü + caso de uso\n`;
  msg += `• 15 min — Preguntas / objeciones\n`;
  msg += `• 5 min — Decisión de siguiente paso\n`;
  msg += `\n🏛 Treevü opera bajo supervisión SBS — mencionarlo en la apertura`;

  await sendMessage(BOT_TOKEN, CHAT_ID, msg, {
    reply_markup: {
      inline_keyboard: [[{
        text:          '✅ Registrar resultado de reunión',
        callback_data: `pm_start:${lead.id}`,
      }]],
    },
  });
}

async function crearDraftAgenda(lead, fechaReunion, gmailToken) {
  if (!gmailToken || !lead.email) return null;

  const primerNombre = (lead.nombre || 'equipo').split(/[\s,\-]+/)[0];
  const empresa      = lead.empresa || 'su empresa';
  const fechaStr     = fechaReunion
    ? new Date(fechaReunion).toLocaleString('es-PE', {
        timeZone: 'America/Lima', weekday: 'long',
        day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
      })
    : 'la fecha acordada';

  const bodyHtml = `
<p>Hola ${primerNombre},</p>
<p>Confirmamos nuestra reunión para el <strong>${fechaStr}</strong>.
Comparto la agenda para aprovechar al máximo los 30–45 minutos:</p>
<ol>
  <li><strong>5 min</strong> — Contexto de ${empresa} (nos cuenten brevemente su situación)</li>
  <li><strong>10 min</strong> — Qué es Treevü y cómo funciona el piloto</li>
  <li><strong>15 min</strong> — Preguntas y dudas</li>
  <li><strong>5 min</strong> — Definir siguiente paso concreto</li>
</ol>
<p><strong>Resultado esperado de la reunión:</strong> Definir si avanzamos a un diagnóstico y agendar fecha, o acordar un siguiente paso claro.</p>
<p>Para prepararnos mejor, si pueden compartir antes (sin compromiso):<br>
• Número aproximado de colaboradores<br>
• Algún desafío puntual que quieran que abordemos en la reunión</p>
<p>¡Nos vemos pronto!<br>
<strong>Equipo Treevü</strong><br>
<a href="https://gettreevu.com">gettreevu.com</a> · hello@gettreevu.com</p>`.trim();

  return gmailDraft(gmailToken, {
    to: lead.email,
    subject: `Confirmación + Agenda — Reunión Treevü × ${empresa}`,
    bodyHtml,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// POST-MEETING
// ═══════════════════════════════════════════════════════════════════════════════

async function generarFollowUp(lead, notas) {
  const system = `Eres el asistente de ventas de Treevü, plataforma EWA B2B para empresas peruanas.
Genera un correo de follow-up post-reunión: profesional, conciso, en español peruano de negocios.
Responde SOLO con JSON válido:
{
  "asunto": "<asunto del correo — máx 70 caracteres>",
  "bullets": [
    "<bullet 1: dolor identificado>",
    "<bullet 2: objetivo acordado>",
    "<bullet 3: cómo Treevü ayuda — específico>",
    "<bullet 4: alcance tentativo del piloto>",
    "<bullet 5: riesgo mencionado y cómo se resuelve>"
  ],
  "llamada_accion": "<frase de cierre con el siguiente paso concreto acordado>",
  "incluir_nda": <true|false — true solo si el siguiente paso es NDA o si se mencionó revisión legal>
}`;

  const user = `Reunión realizada con:
- Empresa: ${lead.empresa || 'N/A'} (${lead.sector || 'N/A'} · ${lead.colaboradores || 'N/A'} colaboradores)
- Contacto: ${lead.nombre || 'N/A'}

Notas de la reunión:
- Dolor principal identificado: ${notas.dolor_principal || 'No especificado'}
- Siguiente paso acordado: ${notas.siguiente_paso || 'N/A'}
- Objeciones mencionadas: ${notas.objeciones || 'Ninguna'}
- Próxima reunión: ${notas.fecha_siguiente || 'Por confirmar'}
- Nivel de interés (1-5): ${notas.interes || 'N/A'}`;

  try {
    const raw = await askClaude(user, { system, maxTokens: 500 });
    if (!raw) return null;
    const clean = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    return JSON.parse(clean);
  } catch (err) {
    console.error('[primera-reunion] Error follow-up Claude:', err.message);
    return null;
  }
}

async function crearDraftFollowUp(lead, notas, followUp, gmailToken) {
  if (!gmailToken || !lead.email) return null;

  const primerNombre = (lead.nombre || 'equipo').split(/[\s,\-]+/)[0];
  const empresa      = lead.empresa || 'su empresa';
  const asunto       = followUp?.asunto || `Treevü — Siguientes pasos × ${empresa}`;

  const bulletsHtml = followUp?.bullets?.length
    ? `<ul>${followUp.bullets.map(b => `<li>${b}</li>`).join('')}</ul>`
    : '';

  const proximaHtml = notas.fecha_siguiente
    ? `<p><strong>Próxima reunión:</strong> ${notas.fecha_siguiente}</p>`
    : '';

  const ndaHtml = followUp?.incluir_nda
    ? `<p>Para intercambiar información con mayor detalle, les proponemos firmar un NDA mutuo. Podemos coordinar el envío en los próximos días.</p>`
    : '';

  const bodyHtml = `
<p>Hola ${primerNombre},</p>
<p>Gracias por su tiempo hoy. Resumo los puntos clave de nuestra conversación:</p>
${bulletsHtml}
${proximaHtml}
${ndaHtml}
<p>${followUp?.llamada_accion || 'Quedamos atentos a cualquier consulta.'}</p>
<p>Saludos,<br>
<strong>Equipo Treevü</strong><br>
<a href="https://gettreevu.com">gettreevu.com</a> · hello@gettreevu.com</p>`.trim();

  return gmailDraft(gmailToken, { to: lead.email, subject: asunto, bodyHtml });
}

// ── Propuesta automática (para siguiente_paso = diagnostico) ──────────────────
async function crearDraftPropuesta(lead, notas, gmailToken) {
  if (!gmailToken || !lead.email) return null;

  const primerNombre  = (lead.nombre || 'equipo').split(/[\s,\-]+/)[0];
  const empresa       = lead.empresa  || 'su empresa';
  const colabs        = parseInt((lead.colaboradores || '').split('-')[0]) || 100;
  const renuncias     = Math.round(colabs * 0.25);
  const costoActual   = (renuncias * 8000).toLocaleString('es-PE');
  const activacion    = Math.round(colabs * 0.30);
  const mrrEstimado   = ((activacion * 7) + 490).toLocaleString('es-PE');
  const ahorro30      = (renuncias * 8000 * 0.30).toLocaleString('es-PE');
  const diasCierre    = Math.ceil((new Date(PROGRAMA.FECHA_CIERRE) - new Date()) / 864e5);
  const intel         = getSectorIntel(lead.sector, lead.colaboradores);

  const bodyHtml = `
<div style="font-family:Arial,sans-serif;max-width:620px;color:#1a1a2e">
<p>Hola ${primerNombre},</p>
<p>Gracias por la reunión de hoy. Adjunto la propuesta de piloto para <strong>${empresa}</strong>.</p>

<hr style="border:1px solid #eee;margin:20px 0">

<h2 style="color:#1a1a2e">Propuesta Treevü × ${empresa}</h2>
<p style="color:#666;font-size:13px">Programa Fundadores · Vigencia: hasta el ${PROGRAMA.FECHA_CIERRE}</p>

<h3>1. Diagnóstico de impacto estimado</h3>
<table style="width:100%;border-collapse:collapse;font-size:14px">
  <tr style="background:#f5f5f5">
    <td style="padding:10px;border:1px solid #ddd"><strong>Colaboradores totales</strong></td>
    <td style="padding:10px;border:1px solid #ddd">${lead.colaboradores || colabs + ' estimado'}</td>
  </tr>
  <tr>
    <td style="padding:10px;border:1px solid #ddd">Rotación anual estimada (${lead.sector || 'sector'})</td>
    <td style="padding:10px;border:1px solid #ddd">~${renuncias} personas/año</td>
  </tr>
  <tr style="background:#f5f5f5">
    <td style="padding:10px;border:1px solid #ddd"><strong>Costo actual de rotación</strong></td>
    <td style="padding:10px;border:1px solid #ddd;color:#c0392b"><strong>S/ ${costoActual}/año</strong></td>
  </tr>
  <tr>
    <td style="padding:10px;border:1px solid #ddd">Reducción estimada con Treevü (−30%)</td>
    <td style="padding:10px;border:1px solid #ddd;color:#27ae60"><strong>Ahorro S/ ${ahorro30}/año</strong></td>
  </tr>
</table>

<h3>2. Estructura del piloto</h3>
<ul style="line-height:1.8">
  <li><strong>Duración:</strong> 90 días</li>
  <li><strong>Colaboradores piloto:</strong> ~${activacion} (30% del total — área de mayor rotación)</li>
  <li><strong>Costo Programa Fundadores:</strong> S/ 7/colaborador activo/mes</li>
  <li><strong>Estimado mensual:</strong> S/ ${mrrEstimado} (solo por activos)</li>
  <li><strong>Setup:</strong> 2 semanas · sin cambios en sistema de nómina</li>
  <li><strong>Integración:</strong> Buk / Mandü / Excel (según sistema actual)</li>
</ul>

<h3>3. Condiciones Programa Fundadores</h3>
<ul style="line-height:1.8">
  <li>Tarifa S/ 7/activo/mes <strong>de por vida</strong> (precio actual de lista: S/ 12)</li>
  <li>Onboarding prioritario y soporte dedicado</li>
  <li>Acceso anticipado a funcionalidades ML (predicción de renuncia)</li>
  <li>Co-desarrollo del roadmap de integración</li>
</ul>
<p style="background:#fff3cd;padding:12px;border-radius:6px;font-size:13px">
  ⏰ <strong>Quedan ${diasCierre} días</strong> para el cierre del Programa Fundadores (${PROGRAMA.FECHA_CIERRE}).
  Solo hay cupos para empresas que confirmen antes de esa fecha.
</p>

<h3>4. Siguientes pasos</h3>
<ol style="line-height:2">
  <li>Confirmar fecha de kick-off</li>
  <li>Compartir estructura de planilla (sin datos personales) para configurar integración</li>
  <li>Firma de acuerdo de piloto (1 página)</li>
  <li>Setup en 2 semanas · lanzamiento</li>
</ol>

${notas.dolor_principal ? `<h3>5. Notas de la reunión</h3><p style="background:#f9f9f9;padding:12px;border-radius:6px"><em>${notas.dolor_principal}</em></p>` : ''}

<hr style="border:1px solid #eee;margin:20px 0">
<p>¿Alguna pregunta? Responde este correo o agendemos una llamada rápida:</p>
<p><a href="${PROGRAMA.BOOKING}" style="background:#1a1a2e;color:#fff;padding:10px 22px;border-radius:6px;text-decoration:none;display:inline-block;font-weight:bold">📅 Confirmar avance</a></p>
<p style="color:#888;font-size:12px">Treevü opera bajo supervisión SBS (sandbox regulatorio EWA). Modelo no-custodio — cero riesgo financiero para el empleador.</p>
<p>Saludos,<br><strong>Ricardo Cuba · CEO Treevü</strong><br>
<a href="https://gettreevu.com">gettreevu.com</a> · hello@gettreevu.com</p>
</div>`.trim();

  return gmailDraft(gmailToken, {
    to:       lead.email,
    subject:  `Propuesta Treevü × ${empresa} — Programa Fundadores`,
    bodyHtml,
  });
}

// Igual que crearDraftFollowUp pero envía directamente (para diagnostico)
async function enviarFollowUp(lead, notas, followUp, gmailToken) {
  if (!gmailToken || !lead.email) return null;

  const primerNombre = (lead.nombre || 'equipo').split(/[\s,\-]+/)[0];
  const empresa      = lead.empresa || 'su empresa';
  const asunto       = followUp?.asunto || `Treevü — Siguientes pasos × ${empresa}`;

  const bulletsHtml = followUp?.bullets?.length
    ? `<ul>${followUp.bullets.map(b => `<li>${b}</li>`).join('')}</ul>`
    : '';
  const proximaHtml = notas.fecha_siguiente
    ? `<p><strong>Próxima reunión:</strong> ${notas.fecha_siguiente}</p>`
    : '';

  const bodyHtml = `
<p>Hola ${primerNombre},</p>
<p>Gracias por su tiempo hoy. Resumo los puntos clave de nuestra conversación:</p>
${bulletsHtml}
${proximaHtml}
<p>${followUp?.llamada_accion || 'Quedamos atentos a cualquier consulta.'}</p>
<p>Saludos,<br>
<strong>Equipo Treevü</strong><br>
<a href="https://gettreevu.com">gettreevu.com</a> · hello@gettreevu.com</p>`.trim();

  return gmailSend(gmailToken, { to: lead.email, subject: asunto, bodyHtml });
}

async function actualizarCRM(leadId, notas) {
  const nuevoEstado = ESTADO_SIGUIENTE[notas.siguiente_paso] || 'Contactado';

  const notaTexto = [
    `[Post-reunión] Dolor: ${notas.dolor_principal || 'N/A'}`,
    `Sig. paso: ${notas.siguiente_paso || 'N/A'}`,
    notas.objeciones    ? `Objeciones: ${notas.objeciones}` : null,
    notas.fecha_siguiente ? `Próx. reunión: ${notas.fecha_siguiente}` : null,
    notas.interes       ? `Interés: ${notas.interes}/5` : null,
  ].filter(Boolean).join(' · ');

  return notionPatch(leadId, {
    'Estado': { select:    { name: nuevoEstado } },
    'Notas':  { rich_text: [{ text: { content: notaTexto } }] },
  });
}

async function notificarPostMeeting(lead, notas) {
  const empresa = lead.empresa || 'empresa';
  const estadoMap = { diagnostico: '🟢 Diagnóstico', nda: '🔵 NDA', no_fit: '❌ No fit', seguimiento: '🟡 Seguimiento' };
  const estadoLabel = estadoMap[notas.siguiente_paso] || notas.siguiente_paso;

  let msg = `✅ *Post-reunión procesado — ${empresa}*\n`;
  msg += `\n• Dolor: ${notas.dolor_principal || 'N/A'}`;
  msg += `\n• Siguiente paso: ${estadoLabel}`;
  if (notas.objeciones)     msg += `\n• Objeciones: ${notas.objeciones}`;
  if (notas.fecha_siguiente) msg += `\n• Próx. reunión: ${notas.fecha_siguiente}`;
  if (notas.interes)        msg += `\n• Interés declarado: ${notas.interes}/5`;
  const gmailLabel = notas.siguiente_paso === 'diagnostico'
    ? '📧 Follow-up enviado · 📄 Propuesta en draft (Gmail)' : '📧 Follow-up draft en Gmail';
  msg += `\n\n${gmailLabel}\n📝 Notion CRM actualizado`;

  await sendMessage(BOT_TOKEN, CHAT_ID, msg);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Handler principal
// ═══════════════════════════════════════════════════════════════════════════════

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!isAuthorized(req))    return res.status(401).json({ error: 'Unauthorized' });

  const { action, lead_id, notas, fecha_reunion } = req.body || {};

  if (!lead_id) return res.status(400).json({ error: 'lead_id requerido' });
  if (!action)  return res.status(400).json({ error: 'action requerida: pre-meeting | post-meeting' });

  console.log(`[primera-reunion] action=${action} lead=${lead_id}`);

  try {
    const lead = await fetchLead(lead_id);

    // ── PRE-MEETING ────────────────────────────────────────────────────────────
    if (action === 'pre-meeting') {
      // Critical path: generate briefing → send Telegram (must finish within 10s)
      const [researchCtx, briefing] = await Promise.all([
        researchCompany(lead.empresa, lead.sector),
        Promise.resolve(null), // placeholder para paralelismo
      ]);
      const briefingFinal = await generarBriefing(lead, researchCtx);
      await enviarBriefingTelegram(lead, briefingFinal, fecha_reunion);

      // Non-critical: Gmail agenda draft (fire-and-forget — avoids Vercel timeout)
      getGmailToken()
        .then(token => crearDraftAgenda(lead, fecha_reunion, token))
        .catch(err  => console.error('[primera-reunion] Gmail agenda:', err.message));

      console.log(`[primera-reunion] Pre-meeting OK: ${lead.empresa}`);
      return res.status(200).json({ ok: true, action: 'pre-meeting', empresa: lead.empresa });
    }

    // ── POST-MEETING ───────────────────────────────────────────────────────────
    if (action === 'post-meeting') {
      if (!notas) return res.status(400).json({ error: 'notas requeridas para post-meeting' });

      // Critical path: generate follow-up copy → update CRM → notify CEO (must finish within 10s)
      const followUp = await generarFollowUp(lead, notas);
      await Promise.all([
        actualizarCRM(lead_id, notas),
        notificarPostMeeting(lead, notas),
      ]);

      // Non-critical: Gmail — envía follow-up + genera draft propuesta si diagnostico
      getGmailToken().then(token => {
        const tasks = [];
        if (notas.siguiente_paso === 'diagnostico') {
          tasks.push(enviarFollowUp(lead, notas, followUp, token));
          tasks.push(crearDraftPropuesta(lead, notas, token));
        } else {
          tasks.push(crearDraftFollowUp(lead, notas, followUp, token));
        }
        return Promise.all(tasks);
      }).catch(err => console.error('[primera-reunion] Gmail follow-up:', err.message));

      // Store in Redis for D+1/D+3/D+7 followup sequence (fire-and-forget)
      storePostMeeting(lead, notas)
        .catch(err => console.error('[primera-reunion] Redis postmeeting:', err.message));

      // Store in proposal cadence queue D+2/D+5/D+10 (fire-and-forget, only for diagnostico)
      if (notas.siguiente_paso === 'diagnostico') {
        const ts   = Math.floor(Date.now() / 1000);
        const data = JSON.stringify({
          lead_id: lead.id, empresa: lead.empresa || '', nombre: lead.nombre || '',
          email: lead.email || '', sector: lead.sector || '',
        });
        Promise.all([
          redisCmd('ZADD', 'proposals', ts, lead.id),
          redisCmd('SET',  `proposal:${lead.id}`, data, 'EX', 2592000),
        ]).catch(err => console.error('[primera-reunion] Redis proposal cadence:', err.message));
      }

      // Sync estado to Supabase (fire-and-forget)
      const nuevoEstado = ESTADO_SIGUIENTE[notas.siguiente_paso] || 'Contactado';
      supabasePatch('leads', { column: 'notion_id', value: lead_id }, { estado: nuevoEstado })
        .catch(err => console.error('[primera-reunion] Supabase sync:', err.message));

      console.log(`[primera-reunion] Post-meeting OK: ${lead.empresa} → ${notas.siguiente_paso}`);
      return res.status(200).json({ ok: true, action: 'post-meeting', empresa: lead.empresa, estado: ESTADO_SIGUIENTE[notas.siguiente_paso] });
    }

    return res.status(400).json({ error: `Acción desconocida: ${action}` });

  } catch (err) {
    console.error('[primera-reunion] Error:', err.message);
    captureException(err, { action, lead_id });
    return res.status(500).json({ error: err.message });
  }
}
