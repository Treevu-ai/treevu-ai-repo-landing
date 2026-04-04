// api/ceo-bot.js — Bot interno CEO (TELEGRAM_BOT_TOKEN)
//
// Maneja el flujo post-reunión cuando el CEO toca "Registrar resultado"
// en el briefing de primera-reunion.js.
//
// Setup (una sola vez después de deploy):
//   curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
//        -d "url=https://gettreevu.com/api/ceo-bot"

import { sendMessage, answerCallback, editMessage } from './lib/telegram.js';
import { redisCmd }                                 from './lib/redis.js';
import { getNotionPage, getProp, notionPatch, notionQuery } from './lib/notion.js';
import { NOTION, ESTADO_EMOJI }                             from './lib/constants.js';
import { askClaude }                                 from './lib/anthropic.js';
import { getGmailToken, gmailDraft }                 from './lib/gmail.js';
import { handleCTO, clearCTOContext }                from './cto-bot.js';

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
const SIG_MAP = { d: 'diagnostico', n: 'nda', s: 'seguimiento', f: 'no_fit', c: 'cerrado' };
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

// ── Propuesta automática con Claude ──────────────────────────────────────────
function kbPropuesta(leadId) {
  return {
    inline_keyboard: [[
      { text: '📄 Generar propuesta', callback_data: `pm_prop:${leadId}` },
      { text: '⏭ Omitir',            callback_data: `pm_skip:${leadId}` },
    ]],
  };
}

// Pricing: S/ 490 base + S/ 7 por colab estimado (30% adopción)
function estimarPrecio(colabsStr = '') {
  const n = parseInt((colabsStr || '').split('-')[0].replace('+', '')) || 0;
  if (!n) return null;
  const adopcion = Math.round(n * 0.30);
  const mensual  = adopcion * 7 + 490;
  return { colaboradores: n, adopcion, mensual };
}

async function generateProposal(leadId, chatId) {
  await send(chatId, '_⏳ Generando propuesta con Claude..._');

  let page;
  try { page = await getNotionPage(leadId); }
  catch (err) {
    console.error('[ceo-bot/propuesta] Notion error:', err.message);
    await send(chatId, '❌ No pude obtener los datos del lead desde Notion.');
    return;
  }

  const empresa     = getProp(page, 'Empresa')       || getProp(page, 'Name') || 'la empresa';
  const contacto    = getProp(page, 'Nombre')         || getProp(page, 'Contacto') || '';
  const email       = getProp(page, 'Email')          || '';
  const sector      = getProp(page, 'Sector')         || '';
  const colabs      = getProp(page, 'Colaboradores')  || '';
  const objetivo    = getProp(page, 'Objetivo')       || '';
  const dolor       = getProp(page, 'Notas')          || getProp(page, 'Dolor') || '';
  const siguientePaso = getProp(page, 'Siguiente_paso') || '';

  const precio = estimarPrecio(colabs);
  const precioStr = precio
    ? `S/ ${precio.mensual.toLocaleString('es-PE')}/mes (${precio.adopcion} usuarios × S/ 7 + S/ 490 base)`
    : 'a cotizar según adopción';

  const system = `Eres el equipo comercial de Treevü, una plataforma de Earned Wage Access (EWA) para empresas peruanas.
Treevü permite a los trabajadores retirar su sueldo ganado antes del día de pago, sin costo para la empresa.
Beneficios clave: reduce rotación 15-40%, mejora clima laboral, cero costo financiero para la empresa, implementación en 48h.
Precio: S/ 7 por usuario activo/mes + S/ 490 mensual de plataforma. Implementación y soporte incluidos.
Escribe en español formal peruano. Sé conciso, orientado a resultados, sin relleno corporativo.`;

  const userPrompt = `Genera una propuesta comercial en HTML para enviar por email a ${contacto || 'el contacto'} de ${empresa}.

Datos del prospecto:
- Empresa: ${empresa}
- Sector: ${sector}
- Colaboradores: ${colabs}
- Objetivo principal: ${objetivo}
- Dolor detectado en reunión: ${dolor || '(no especificado)'}
- Siguiente paso acordado: ${siguientePaso || 'por definir'}
- Precio estimado: ${precioStr}

El HTML debe incluir:
1. Saludo personalizado
2. Resumen del dolor que mencionaron (1 párrafo)
3. Cómo Treevü lo resuelve (2-3 bullets concretos con datos)
4. Inversión mensual estimada (precio calculado arriba)
5. ROI estimado: ahorro en rotación (costo de reemplazar 1 empleado = 3-6 meses de sueldo)
6. Próximos pasos claros (máximo 3 pasos)
7. CTA: agendar diagnóstico o firmar NDA
8. Firma: equipo Treevü, hello@gettreevu.com

Usa un estilo limpio con colores corporativos (#0f4c81 azul, #10b981 verde). No uses imágenes externas.
Devuelve SOLO el HTML del body (sin <html>, <head>).`;

  const htmlBody = await askClaude(userPrompt, { system, maxTokens: 2500 });
  if (!htmlBody) {
    await send(chatId, '❌ Claude no pudo generar la propuesta. Intentá de nuevo en un momento.');
    return;
  }

  // Gmail draft
  let draftUrl = null;
  if (email) {
    const token = await getGmailToken();
    if (token) {
      const draft = await gmailDraft(token, {
        to:       email,
        subject:  `Propuesta Treevü · ${empresa}`,
        bodyHtml: htmlBody,
      });
      if (draft?.id) {
        draftUrl = `https://mail.google.com/mail/#drafts/${draft.id}`;
      }
    }
  }

  // Update Notion: estado → Propuesta
  try {
    await notionPatch(leadId, {
      Estado: { select: { name: 'Propuesta' } },
    });
  } catch (err) {
    console.warn('[ceo-bot/propuesta] no pudo actualizar estado Notion:', err.message);
  }

  const draftLine = draftUrl
    ? `\n\n📧 [Abrir borrador Gmail](${draftUrl})`
    : email
      ? '\n\n⚠️ No se pudo crear el borrador Gmail (verificá el token).'
      : '\n\n⚠️ Sin email registrado — propuesta no enviada por Gmail.';

  await send(chatId,
    `✅ *Propuesta generada para ${empresa}*\n` +
    `• Sector: ${sector || '—'} · Colabs: ${colabs || '—'}\n` +
    `• Precio estimado: ${precioStr}\n` +
    `• Estado Notion → Propuesta${draftLine}`,
    { parse_mode: 'Markdown', disable_web_page_preview: true }
  );

  // Ofrecer envío para firma si hay email y PandaDoc configurado
  if (email && process.env.PANDADOC_API_KEY) {
    // Guardar HTML en Redis temporalmente para usarlo al firmar
    await redisCmd('SET', `propuesta_html:${leadId}`, htmlBody, 'EX', 86400);
    await send(chatId,
      `¿Enviamos la propuesta para *firma electrónica* vía PandaDoc?`,
      { reply_markup: {
        inline_keyboard: [[
          { text: '✍️ Enviar para firma', callback_data: `pm_sign:${leadId}` },
          { text: '⏭ Solo borrador',     callback_data: `pm_nosign:${leadId}` },
        ]],
      }}
    );
  }

  console.log(`[ceo-bot/propuesta] OK — ${empresa} (leadId: ${leadId})`);
}

// ── Enviar propuesta a PandaDoc para firma ────────────────────────────────────
async function sendToPandaDoc(leadId, chatId) {
  const PANDADOC_KEY = process.env.PANDADOC_API_KEY;
  if (!PANDADOC_KEY) {
    await send(chatId, '❌ PANDADOC_API_KEY no configurada en Vercel.');
    return;
  }

  await send(chatId, '_⏳ Creando documento en PandaDoc..._');

  let page;
  try { page = await getNotionPage(leadId); }
  catch (err) {
    await send(chatId, '❌ No pude obtener datos del lead desde Notion.');
    return;
  }

  const empresa  = getProp(page, 'Empresa') || getProp(page, 'Name') || 'la empresa';
  const contacto = getProp(page, 'Nombre')  || getProp(page, 'Contacto') || '';
  const email    = getProp(page, 'Email')   || '';

  if (!email) {
    await send(chatId, `❌ No hay email registrado para ${empresa} — no se puede enviar a PandaDoc.`);
    return;
  }

  // Recuperar HTML de propuesta guardado temporalmente
  const htmlBody = await redisCmd('GET', `propuesta_html:${leadId}`);
  if (!htmlBody) {
    await send(chatId, '❌ El HTML de la propuesta expiró (>24h). Generá la propuesta nuevamente.');
    return;
  }

  try {
    // 1. Crear documento en PandaDoc desde HTML
    const createRes = await fetch('https://api.pandadoc.com/public/v1/documents', {
      method:  'POST',
      headers: {
        'Authorization': `API-Key ${PANDADOC_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        name:      `Propuesta Treevü · ${empresa}`,
        recipients: [{
          email,
          first_name: contacto.split(' ')[0] || contacto,
          last_name:  contacto.split(' ').slice(1).join(' ') || '',
          role:       'Client',
        }],
        content: [{ type: 'text', content: htmlBody }],
        metadata: { lead_id: leadId },
        parse_form_fields: false,
      }),
    });

    if (!createRes.ok) {
      const err = await createRes.text();
      console.error('[ceo-bot/pandadoc] create error:', err);
      await send(chatId, `❌ PandaDoc error al crear documento:\n\`${err.slice(0, 200)}\``);
      return;
    }

    const doc = await createRes.json();
    const docId = doc.id || doc.uuid;

    // 2. Esperar a que el documento procese (PandaDoc necesita ~2s)
    await new Promise(r => setTimeout(r, 3000));

    // 3. Enviar al recipient para firma
    const sendRes = await fetch(`https://api.pandadoc.com/public/v1/documents/${docId}/send`, {
      method:  'POST',
      headers: {
        'Authorization': `API-Key ${PANDADOC_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        message: `Hola${contacto ? ` ${contacto.split(' ')[0]}` : ''}, adjuntamos la propuesta comercial de Treevü para tu revisión y firma. Cualquier duda, estamos disponibles en hello@gettreevu.com`,
        subject: `Propuesta Treevü · ${empresa}`,
        silent:  false,
      }),
    });

    if (!sendRes.ok) {
      const err = await sendRes.text();
      console.error('[ceo-bot/pandadoc] send error:', err);
      await send(chatId, `❌ PandaDoc error al enviar:\n\`${err.slice(0, 200)}\``);
      return;
    }

    const docUrl = `https://app.pandadoc.com/a/#/documents/${docId}`;
    await send(chatId,
      `✍️ *Propuesta enviada para firma*\n\n` +
      `🏢 ${empresa}\n📧 ${email}\n\n` +
      `[Ver en PandaDoc](${docUrl})\n\n` +
      `_Recibirás notificación aquí cuando ${contacto || 'el cliente'} firme._`,
      { parse_mode: 'Markdown', disable_web_page_preview: true }
    );

    console.log(`[ceo-bot/pandadoc] OK — doc ${docId} enviado a ${email}`);

  } catch (err) {
    console.error('[ceo-bot/pandadoc] error:', err.message);
    await send(chatId, `❌ Error inesperado: ${err.message}`);
  }
}

// ── Cierre de deal + onboarding ───────────────────────────────────────────────
async function triggerCierre(leadId, chatId) {
  // 1. Actualizar Notion → Cerrado
  try {
    await notionPatch(leadId, { Estado: { select: { name: 'Cerrado' } } });
  } catch (err) {
    console.warn('[ceo-bot/cierre] Notion patch error:', err.message);
  }

  // 2. Leer datos del lead para onboarding
  let empresa = '', email = '', contacto = '', sector = '', colabs = '';
  try {
    const page = await getNotionPage(leadId);
    empresa  = getProp(page, 'Empresa')      || getProp(page, 'Name') || '';
    email    = getProp(page, 'Email')         || '';
    contacto = getProp(page, 'Nombre')        || getProp(page, 'Contacto') || '';
    sector   = getProp(page, 'Sector')        || '';
    colabs   = getProp(page, 'Colaboradores') || '';
  } catch (err) {
    console.warn('[ceo-bot/cierre] Notion read error:', err.message);
  }

  // 3. Disparar onboarding
  if (email && CRON_SECRET) {
    fetch('https://gettreevu.com/api/onboarding', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CRON_SECRET}` },
      body:    JSON.stringify({ leadId, empresa, email, contacto, sector, colabs }),
    }).catch(err => console.error('[ceo-bot/cierre] onboarding error:', err.message));
  }

  // 4. Confirmar al CEO
  const mrr = (() => {
    const n = parseInt((colabs || '').split('-')[0].replace('+', '')) || 0;
    return n ? `S/ ${((Math.round(n * 0.30) * 7) + 490).toLocaleString('es-PE')}/mes` : null;
  })();

  await send(chatId,
    `🎉 *¡Deal cerrado!*\n\n` +
    `🏢 *${empresa || 'Lead'}*\n` +
    (email    ? `📧 ${email}\n`    : '') +
    (mrr      ? `💰 MRR: *${mrr}*\n` : '') +
    `\n✅ Notion → Cerrado\n` +
    (email ? `📩 Secuencia de onboarding iniciada (D+1, D+3, D+7, D+30)` : `⚠️ Sin email — onboarding no iniciado`)
  );

  console.log(`[ceo-bot/cierre] Deal cerrado: ${empresa} (${leadId})`);
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

  // Deal cerrado → actualizar Notion + disparar onboarding
  if (state.siguiente_paso === 'cerrado') {
    await triggerCierre(state.lead_id, chatId);
    return;
  }

  // Ofrecer propuesta automática para deals que avanzan
  if (['diagnostico', 'nda', 'seguimiento'].includes(state.siguiente_paso) && (state.interes || 0) >= 3) {
    await send(chatId,
      `¿Querés que genere la *propuesta comercial* automáticamente para este lead?`,
      { reply_markup: kbPropuesta(state.lead_id) }
    );
  }
}

// ── Panel de control: comandos y Q&A ─────────────────────────────────────────

async function handleHelp(chatId) {
  await send(chatId,
    `*Panel de Control Treevü* 🎛️\n\n` +
    `*Comandos:*\n` +
    `📊 /pipeline — resumen del CRM por etapa\n` +
    `🔔 /followup — leads sin actividad +7 días\n` +
    `🎯 /sdr [industria] [tamaño] — busca prospectos en LinkedIn\n` +
    `   _Ej: /sdr retail 200+ · /sdr manufactura 500+_\n` +
    `🧠 /cto <pregunta> — CTO Virtual: Piloto vs API, tiempos, arquitectura\n` +
    `   _Ej: /cto ¿cuánto tarda la integración con Buk?_\n` +
    `   _/cto reset — limpia el contexto de conversación_\n` +
    `❓ /help — este menú\n\n` +
    `*Modo Q&A:*\nEscribí cualquier pregunta sobre el pipeline y te respondo con contexto real del CRM.\n\n` +
    `_Ej: "¿qué leads están calientes?" · "¿cuántos deals tengo en propuesta?"_`,
    { parse_mode: 'Markdown' }
  );
}

async function handlePipeline(chatId) {
  await send(chatId, '_Consultando pipeline en Notion..._');

  let pages = [];
  try {
    const res = await notionQuery(NOTION.CRM_DB, {
      property: 'Estado',
      select: { does_not_equal: 'Descartado' },
    }, 100, [{ property: 'Estado', direction: 'ascending' }]);
    pages = res.results || [];
  } catch (err) {
    await send(chatId, `❌ Error consultando Notion: ${err.message}`);
    return;
  }

  // Agrupar por estado
  const grupos = {};
  for (const p of pages) {
    const estado = getProp(p, 'Estado') || 'Sin estado';
    if (!grupos[estado]) grupos[estado] = [];
    grupos[estado].push(p);
  }

  const ordenEstados = ['Nuevo', 'Contactado', 'Reunion', 'Propuesta', 'Cerrado'];
  const total = pages.length;

  let msg = `*Pipeline Treevü* 📊\n_${total} lead${total !== 1 ? 's' : ''} activos_\n\n`;

  for (const estado of ordenEstados) {
    const items = grupos[estado] || [];
    if (!items.length) continue;
    const emoji = ESTADO_EMOJI[estado] || '•';
    msg += `${emoji} *${estado}* (${items.length})\n`;
    // Mostrar top 3 por estado
    items.slice(0, 3).forEach(p => {
      const empresa = getProp(p, 'Empresa') || getProp(p, 'Name') || '—';
      const score   = getProp(p, 'Score')   || '';
      const scoreEmoji = score === 'ALTO' ? '🔥' : score === 'MEDIO' ? '🟡' : '';
      msg += `   ${scoreEmoji} ${empresa}\n`;
    });
    if (items.length > 3) msg += `   _...y ${items.length - 3} más_\n`;
    msg += '\n';
  }

  // Otros estados
  for (const [estado, items] of Object.entries(grupos)) {
    if (!ordenEstados.includes(estado)) {
      msg += `• *${estado}* (${items.length})\n`;
    }
  }

  await send(chatId, msg, { parse_mode: 'Markdown' });
}

async function handleFollowup(chatId) {
  await send(chatId, '_Buscando leads que necesitan atención..._');

  let pages = [];
  try {
    const res = await notionQuery(NOTION.CRM_DB, {
      and: [
        { property: 'Estado', select: { does_not_equal: 'Cerrado' } },
        { property: 'Estado', select: { does_not_equal: 'Descartado' } },
      ],
    }, 50, [{ property: 'last_edited_time', direction: 'ascending' }]);
    pages = res.results || [];
  } catch (err) {
    await send(chatId, `❌ Error consultando Notion: ${err.message}`);
    return;
  }

  if (!pages.length) {
    await send(chatId, '✅ No hay leads pendientes de atención.');
    return;
  }

  const hoy = new Date();
  const hace7dias = new Date(hoy - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Leads sin actividad en +7 días
  const pendientes = pages.filter(p => {
    const editado = p.last_edited_time || '';
    return editado < hace7dias;
  });

  if (!pendientes.length) {
    await send(chatId, '✅ Todos los leads tienen actividad reciente (< 7 días).');
    return;
  }

  let msg = `*Follow-up pendiente* 🔔\n_${pendientes.length} lead${pendientes.length !== 1 ? 's' : ''} sin actividad en +7 días_\n\n`;

  pendientes.slice(0, 10).forEach(p => {
    const empresa = getProp(p, 'Empresa') || getProp(p, 'Name') || '—';
    const estado  = getProp(p, 'Estado')  || '—';
    const score   = getProp(p, 'Score')   || '';
    const scoreE  = score === 'ALTO' ? '🔥' : score === 'MEDIO' ? '🟡' : '🔵';
    const dias    = Math.floor((hoy - new Date(p.last_edited_time)) / (1000 * 60 * 60 * 24));
    msg += `${scoreE} *${empresa}* — ${estado} (${dias}d sin actividad)\n`;
  });

  if (pendientes.length > 10) msg += `\n_...y ${pendientes.length - 10} más_`;

  await send(chatId, msg, { parse_mode: 'Markdown' });
}

async function handleSDR(chatId, args) {
  // Parsear args: "retail 200+ Lima" → { industry, size, location }
  const INDUSTRIES = ['retail', 'manufactura', 'salud', 'tecnologia', 'construccion', 'educacion', 'banca', 'servicios'];
  const SIZE_MAP   = { '50+': '51,200', '200+': '201,500', '500+': '501,1000', '1000+': '1001,5000' };

  const parts    = args.toLowerCase().split(/\s+/).filter(Boolean);
  const industry = parts.find(p => INDUSTRIES.includes(p)) || null;
  const sizeKey  = parts.find(p => SIZE_MAP[p]) || null;
  const size     = sizeKey ? SIZE_MAP[sizeKey] : '201,500';

  const label = [
    industry || 'todas las industrias',
    sizeKey  || '200+ empleados',
    'Lima',
  ].join(' · ');

  await send(chatId, `_🎯 Iniciando SDR Agent: ${label}..._\nRecibí los resultados en unos segundos.`);

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 58000); // 58s — antes del límite Vercel

  try {
    const res  = await fetch('https://gettreevu.com/api/sdr-agent', {
      method:  'POST',
      signal:  controller.signal,
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${CRON_SECRET}`,
      },
      body: JSON.stringify({ industry, size, location: 'Lima, Peru', max_leads: 10, notify: false, strategy: 'intro' }),
    });

    // Leer como texto primero — Vercel puede devolver HTML/texto en errores 5xx
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      console.error('[handleSDR] respuesta no-JSON:', res.status, text.slice(0, 200));
      await send(chatId, `❌ SDR Agent devolvió error ${res.status}. Revisá los logs en Vercel.`);
      return;
    }

    if (!res.ok) {
      await send(chatId, `❌ SDR Agent error ${res.status}: ${data.error || text.slice(0, 100)}`);
      return;
    }

    let msg = `🎯 *SDR Agent terminado*\n_${label}_\n\n`;
    msg += `✅ *${data.added} leads* añadidos al CRM\n`;
    msg += `⏭ ${data.skipped} omitidos (ya existían)\n`;
    if (data.errors > 0) msg += `❌ ${data.errors} errores\n`;
    if (data.leads?.length) {
      msg += '\n*Nuevos prospectos:*\n';
      data.leads.slice(0, 8).forEach(l => {
        msg += `• *${l.company || '—'}* — ${l.role || '—'}\n`;
      });
    }
    if (!data.added && !data.leads?.length) {
      msg += `\n_Sin prospectos nuevos esta vez. Intentá con otra industria o estrategia._`;
    } else {
      msg += `\nUsá /pipeline para verlos en el CRM.`;
    }
    await send(chatId, msg, { parse_mode: 'Markdown' });

  } catch (err) {
    if (err.name === 'AbortError') {
      await send(chatId, `⏱ SDR Agent tardó más de 58s. El proceso puede estar corriendo en background — revisá Notion en 1 minuto.`);
    } else {
      await send(chatId, `❌ SDR Agent: ${err.message}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function handleQA(chatId, pregunta) {
  await send(chatId, '_Consultando pipeline..._');

  let contexto = '';
  try {
    const res = await notionQuery(NOTION.CRM_DB, {
      property: 'Estado',
      select: { does_not_equal: 'Descartado' },
    }, 30, [{ property: 'last_edited_time', direction: 'descending' }]);
    const pages = res.results || [];

    contexto = pages.map(p => {
      const empresa = getProp(p, 'Empresa') || getProp(p, 'Name') || '—';
      const estado  = getProp(p, 'Estado')  || '—';
      const score   = getProp(p, 'Score')   || '—';
      const sector  = getProp(p, 'Sector')  || '—';
      const colabs  = getProp(p, 'Colaboradores') || '—';
      const notas   = getProp(p, 'Notas')   || '';
      const dias    = Math.floor((Date.now() - new Date(p.last_edited_time)) / (1000 * 60 * 60 * 24));
      return `- ${empresa} | ${estado} | Score: ${score} | Sector: ${sector} | Colabs: ${colabs} | Última actividad: hace ${dias}d${notas ? ` | Notas: ${notas.slice(0,80)}` : ''}`;
    }).join('\n');
  } catch (err) {
    console.error('[ceo-bot/qa] Notion error:', err.message);
    contexto = '(no se pudo obtener el pipeline)';
  }

  const respuesta = await askClaude(pregunta, {
    system: `Eres el asesor de ventas del CEO de Treevü, startup EWA peruana B2B. El CEO te hace preguntas sobre su pipeline de ventas.
Responde de forma directa, concisa y accionable. Usa bullet points cuando ayude. Máximo 5 líneas.
Contexto del pipeline actual:
${contexto}`,
    maxTokens: 400,
  });

  await send(chatId, respuesta || '❌ No pude procesar tu pregunta. Intentá de nuevo.');
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

      // CEO solicitó generar propuesta
      if (data.startsWith('pm_prop:')) {
        const lead_id = data.slice(8);
        await edit(chatId, msgId, (cq.message.text || '') + '\n\n_📄 Generando propuesta..._');
        res.status(200).json({ ok: true }); // responder a Telegram antes de la llamada larga
        await generateProposal(lead_id, chatId);
        return;
      }

      // CEO omitió propuesta
      if (data.startsWith('pm_skip:')) {
        await edit(chatId, msgId, (cq.message.text || '') + '\n\n_⏭ Propuesta omitida_');
        return res.status(200).json({ ok: true });
      }

      // CEO quiere enviar para firma vía PandaDoc
      if (data.startsWith('pm_sign:')) {
        const lead_id = data.slice(8);
        await edit(chatId, msgId, (cq.message.text || '') + '\n\n_✍️ Enviando a PandaDoc..._');
        res.status(200).json({ ok: true });
        await sendToPandaDoc(lead_id, chatId);
        return;
      }

      // CEO prefiere solo el borrador Gmail
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

    const text  = message.text.trim();

    // ── Comandos (no requieren estado activo) ─────────────────────────────────
    if (text === '/help' || text === '/start') {
      await handleHelp(chatId);
      return res.status(200).json({ ok: true });
    }
    if (text === '/pipeline' || text === '/resumen') {
      await handlePipeline(chatId);
      return res.status(200).json({ ok: true });
    }
    if (text === '/followup') {
      await handleFollowup(chatId);
      return res.status(200).json({ ok: true });
    }
    if (text.startsWith('/sdr')) {
      res.status(200).json({ ok: true }); // responder a Telegram de inmediato
      await handleSDR(chatId, text.slice(4).trim());
      return;
    }
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
        res.status(200).json({ ok: true }); // responder a Telegram antes de Claude
        await handleCTO(chatId, query, (text, opts) => send(chatId, text, opts));
        return;
      }
      return res.status(200).json({ ok: true });
    }

    const state = await getState(chatId);

    // ── Modo Q&A libre (sin estado activo) ────────────────────────────────────
    if (!state) {
      if (!text.startsWith('/')) await handleQA(chatId, text);
      return res.status(200).json({ ok: true });
    }

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
