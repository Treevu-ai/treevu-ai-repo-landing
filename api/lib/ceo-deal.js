// api/lib/ceo-deal.js
// Lógica de deal flow del CEO bot:
//   generateProposal  — genera propuesta con Claude, crea draft Gmail, actualiza Notion
//   sendToPandaDoc    — envía propuesta para firma electrónica
//   triggerCierre     — marca deal cerrado y dispara onboarding
//   callPostMeeting   — llama a /api/primera-reunion con notas
//   completarPostMeeting — orquesta el cierre del flujo post-reunión

import { getNotionPage, getProp, notionPatch } from './notion.js';
import { askClaude }                            from './anthropic.js';
import { getGmailToken, gmailDraft }            from './gmail.js';
import { redisCmd }                             from './redis.js';

const CRON_SECRET = process.env.CRON_SECRET;

// ── Pricing ───────────────────────────────────────────────────────────────────
export function estimarPrecio(colabsStr = '') {
  const n = parseInt((colabsStr || '').split('-')[0].replace('+', '')) || 0;
  if (!n) return null;
  const adopcion = Math.round(n * 0.30);
  const mensual  = adopcion * 7 + 490;
  return { colaboradores: n, adopcion, mensual };
}

// ── Propuesta automática con Claude ──────────────────────────────────────────
export async function generateProposal(leadId, chatId, send) {
  await send(chatId, '_⏳ Generando propuesta con Claude..._');

  let page;
  try { page = await getNotionPage(leadId); }
  catch (err) {
    console.error('[ceo-deal/propuesta] Notion error:', err.message);
    await send(chatId, '❌ No pude obtener los datos del lead desde Notion.');
    return;
  }

  const empresa       = getProp(page, 'Empresa')        || getProp(page, 'Name') || 'la empresa';
  const contacto      = getProp(page, 'Nombre')          || getProp(page, 'Contacto') || '';
  const email         = getProp(page, 'Email')           || '';
  const sector        = getProp(page, 'Sector')          || '';
  const colabs        = getProp(page, 'Colaboradores')   || '';
  const objetivo      = getProp(page, 'Objetivo')        || '';
  const dolor         = getProp(page, 'Notas')           || getProp(page, 'Dolor') || '';
  const siguientePaso = getProp(page, 'Siguiente_paso')  || '';

  const precio    = estimarPrecio(colabs);
  const precioStr = precio
    ? `S/ ${precio.mensual.toLocaleString('es-PE')}/mes (${precio.adopcion} usuarios × S/ 7 + S/ 490 base)`
    : 'a cotizar según adopción';

  const system = `Eres el equipo comercial de Treevü (EWA B2B, Perú). Generas el contenido de propuestas comerciales.
Producto: Earned Wage Access — colaboradores acceden al salario ganado antes del pago, S/ 0 costo para el colaborador.
Beneficios clave: reduce rotación 15-40%, mejora clima laboral, cero riesgo financiero para la empresa, implementación en 48h.
Precio: S/ 7 por usuario activo/mes + S/ 490 mensual de plataforma.
Escribe en español formal peruano. Sé conciso y orientado a resultados. Sin relleno corporativo.
Responde SOLO con JSON válido, sin markdown adicional.`;

  const userPrompt = `Genera el contenido de la propuesta para:
- Empresa: ${empresa}
- Contacto: ${contacto || 'el equipo'}
- Sector: ${sector || 'no indicado'}
- Colaboradores: ${colabs || 'no indicado'}
- Objetivo principal: ${objetivo || 'no indicado'}
- Dolor detectado en reunión: ${dolor || 'rotación y estrés financiero'}
- Siguiente paso acordado: ${siguientePaso || 'por definir'}
- Precio estimado: ${precioStr}

Devuelve este JSON:
{
  "saludo": "<primera línea personalizada para ${contacto || 'el equipo'}>",
  "resumen_dolor": "<1 párrafo sobre el dolor específico que mencionaron en la reunión>",
  "beneficios": ["<bullet 1 con dato concreto>", "<bullet 2>", "<bullet 3>"],
  "roi": "<1 frase de ROI: ahorro estimado evitando renuncias en ${empresa}>",
  "inversion": "<${precioStr}>",
  "pasos": ["<paso 1>", "<paso 2>", "<paso 3 máximo>"],
  "cta": "<llamada a la acción según siguiente paso: diagnóstico o NDA>"
}`;

  const contentJson = await askClaude(userPrompt, { system, maxTokens: 800 });
  let content;
  try {
    const clean = (contentJson || '').replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    content = JSON.parse(clean);
  } catch {
    content = null;
  }

  const bulletsHtml = content?.beneficios?.length
    ? content.beneficios.map(b => `<li style="margin-bottom:6px">${b}</li>`).join('')
    : `<li>Acceso al salario devengado sin costo para el colaborador</li>
       <li>Motor ML predice renuncias 3 semanas antes</li>
       <li>Setup en 2 semanas, sin cambios en sistemas de nómina</li>`;

  const pasosHtml = content?.pasos?.length
    ? content.pasos.map((p, i) => `<li><strong>Paso ${i + 1}:</strong> ${p}</li>`).join('')
    : `<li><strong>Paso 1:</strong> Agendar diagnóstico (30 min)</li>
       <li><strong>Paso 2:</strong> Revisar propuesta con el equipo</li>
       <li><strong>Paso 3:</strong> Firma de acuerdo piloto</li>`;

  const htmlBody = `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a2e">
  <div style="background:#0f4c81;padding:24px 32px;border-radius:8px 8px 0 0">
    <h1 style="color:#fff;margin:0;font-size:20px">Propuesta Treevü × ${empresa}</h1>
  </div>
  <div style="background:#f9fafb;padding:32px;border-radius:0 0 8px 8px;border:1px solid #e5e7eb">
    <p>${content?.saludo || `Hola ${contacto || 'equipo'},`}</p>
    <p>${content?.resumen_dolor || `Gracias por la reunión. Adjunto nuestra propuesta para ${empresa} basada en los puntos que conversamos.`}</p>

    <h3 style="color:#0f4c81;border-bottom:2px solid #10b981;padding-bottom:6px">¿Cómo lo resuelve Treevü?</h3>
    <ul style="padding-left:20px">${bulletsHtml}</ul>

    <h3 style="color:#0f4c81;border-bottom:2px solid #10b981;padding-bottom:6px">ROI estimado</h3>
    <p style="background:#ecfdf5;padding:12px 16px;border-radius:6px;border-left:4px solid #10b981">
      ${content?.roi || `Evitar una sola renuncia en ${empresa} cubre más de 12 meses de inversión en Treevü.`}
    </p>

    <h3 style="color:#0f4c81;border-bottom:2px solid #10b981;padding-bottom:6px">Inversión mensual estimada</h3>
    <p style="font-size:18px;font-weight:bold;color:#0f4c81">${content?.inversion || precioStr}</p>
    <p style="font-size:12px;color:#6b7280">Implementación y soporte incluidos. Precio fundador congelado al firmar.</p>

    <h3 style="color:#0f4c81;border-bottom:2px solid #10b981;padding-bottom:6px">Siguientes pasos</h3>
    <ol style="padding-left:20px">${pasosHtml}</ol>

    <div style="text-align:center;margin-top:28px">
      <a href="https://calendar.app.google/Rxprk5tCDSDivwaA9"
         style="background:#0f4c81;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;display:inline-block;font-weight:bold">
        ${content?.cta || '📅 Agendar diagnóstico'}
      </a>
    </div>

    <p style="margin-top:32px;color:#6b7280;font-size:13px">
      Equipo Treevü · <a href="https://gettreevu.com" style="color:#0f4c81">gettreevu.com</a> · hello@gettreevu.com
    </p>
  </div>
</div>`.trim();

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
      if (draft?.id) draftUrl = `https://mail.google.com/mail/#drafts/${draft.id}`;
    }
  }

  // Notion: estado → Propuesta
  try {
    await notionPatch(leadId, { Estado: { select: { name: 'Propuesta' } } });
  } catch (err) {
    console.warn('[ceo-deal/propuesta] no pudo actualizar estado Notion:', err.message);
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

  if (email && process.env.PANDADOC_API_KEY) {
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

  console.log(`[ceo-deal/propuesta] OK — ${empresa} (leadId: ${leadId})`);
}

// ── PandaDoc ──────────────────────────────────────────────────────────────────
export async function sendToPandaDoc(leadId, chatId, send) {
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

  const htmlBody = await redisCmd('GET', `propuesta_html:${leadId}`);
  if (!htmlBody) {
    await send(chatId, '❌ El HTML de la propuesta expiró (>24h). Generá la propuesta nuevamente.');
    return;
  }

  try {
    const createRes = await fetch('https://api.pandadoc.com/public/v1/documents', {
      method:  'POST',
      headers: { 'Authorization': `API-Key ${PANDADOC_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name:      `Propuesta Treevü · ${empresa}`,
        recipients: [{
          email,
          first_name: contacto.split(' ')[0] || contacto,
          last_name:  contacto.split(' ').slice(1).join(' ') || '',
          role:       'Client',
        }],
        content:          [{ type: 'text', content: htmlBody }],
        metadata:         { lead_id: leadId },
        parse_form_fields: false,
      }),
    });

    if (!createRes.ok) {
      const err = await createRes.text();
      console.error('[ceo-deal/pandadoc] create error:', err);
      await send(chatId, `❌ PandaDoc error al crear documento:\n\`${err.slice(0, 200)}\``);
      return;
    }

    const doc   = await createRes.json();
    const docId = doc.id || doc.uuid;

    await new Promise(r => setTimeout(r, 3000));

    const sendRes = await fetch(`https://api.pandadoc.com/public/v1/documents/${docId}/send`, {
      method:  'POST',
      headers: { 'Authorization': `API-Key ${PANDADOC_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Hola${contacto ? ` ${contacto.split(' ')[0]}` : ''}, adjuntamos la propuesta comercial de Treevü para tu revisión y firma. Cualquier duda, estamos disponibles en hello@gettreevu.com`,
        subject: `Propuesta Treevü · ${empresa}`,
        silent:  false,
      }),
    });

    if (!sendRes.ok) {
      const err = await sendRes.text();
      console.error('[ceo-deal/pandadoc] send error:', err);
      await send(chatId, `❌ PandaDoc error al enviar:\n\`${err.slice(0, 200)}\``);
      return;
    }

    const docUrl = `https://app.pandadoc.com/a/#/documents/${docId}`;
    await send(chatId,
      `✍️ *Propuesta enviada para firma*\n\n🏢 ${empresa}\n📧 ${email}\n\n[Ver en PandaDoc](${docUrl})\n\n_Recibirás notificación aquí cuando ${contacto || 'el cliente'} firme._`,
      { parse_mode: 'Markdown', disable_web_page_preview: true }
    );

    console.log(`[ceo-deal/pandadoc] OK — doc ${docId} enviado a ${email}`);
  } catch (err) {
    console.error('[ceo-deal/pandadoc] error:', err.message);
    await send(chatId, `❌ Error inesperado: ${err.message}`);
  }
}

// ── Cierre de deal + onboarding ───────────────────────────────────────────────
export async function triggerCierre(leadId, chatId, send) {
  try {
    await notionPatch(leadId, { Estado: { select: { name: 'Cerrado' } } });
  } catch (err) {
    console.warn('[ceo-deal/cierre] Notion patch error:', err.message);
  }

  let empresa = '', email = '', contacto = '', sector = '', colabs = '';
  try {
    const page = await getNotionPage(leadId);
    empresa  = getProp(page, 'Empresa')      || getProp(page, 'Name') || '';
    email    = getProp(page, 'Email')         || '';
    contacto = getProp(page, 'Nombre')        || getProp(page, 'Contacto') || '';
    sector   = getProp(page, 'Sector')        || '';
    colabs   = getProp(page, 'Colaboradores') || '';
  } catch (err) {
    console.warn('[ceo-deal/cierre] Notion read error:', err.message);
  }

  if (email && CRON_SECRET) {
    fetch('https://gettreevu.com/api/onboarding', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CRON_SECRET}` },
      body:    JSON.stringify({ leadId, empresa, email, contacto, sector, colabs }),
    }).catch(err => console.error('[ceo-deal/cierre] onboarding error:', err.message));
  }

  const mrr = (() => {
    const n = parseInt((colabs || '').split('-')[0].replace('+', '')) || 0;
    return n ? `S/ ${((Math.round(n * 0.30) * 7) + 490).toLocaleString('es-PE')}/mes` : null;
  })();

  await send(chatId,
    `🎉 *¡Deal cerrado!*\n\n🏢 *${empresa || 'Lead'}*\n` +
    (email ? `📧 ${email}\n` : '') +
    (mrr   ? `💰 MRR: *${mrr}*\n` : '') +
    `\n✅ Notion → Cerrado\n` +
    (email ? `📩 Secuencia de onboarding iniciada (D+1, D+3, D+7, D+30)` : `⚠️ Sin email — onboarding no iniciado`)
  );

  console.log(`[ceo-deal/cierre] Deal cerrado: ${empresa} (${leadId})`);
}

// ── Post-meeting ──────────────────────────────────────────────────────────────
export async function callPostMeeting(lead_id, notas) {
  if (!CRON_SECRET) return;
  try {
    await fetch('https://gettreevu.com/api/primera-reunion', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CRON_SECRET}` },
      body:    JSON.stringify({ action: 'post-meeting', lead_id, notas }),
    });
    console.log(`[ceo-deal] post-meeting llamado: ${lead_id}`);
  } catch (err) {
    console.error('[ceo-deal] error llamando post-meeting:', err.message);
  }
}

export async function completarPostMeeting(chatId, state, send, kbPropuesta, SIG_LABEL, SIG_MAP) {
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

  if (state.siguiente_paso === 'cerrado') {
    await triggerCierre(state.lead_id, chatId, send);
    return;
  }

  if (['diagnostico', 'nda', 'seguimiento'].includes(state.siguiente_paso) && (state.interes || 0) >= 3) {
    await send(chatId,
      `¿Querés que genere la *propuesta comercial* automáticamente para este lead?`,
      { reply_markup: kbPropuesta(state.lead_id) }
    );
  }
}
