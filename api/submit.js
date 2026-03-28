// ── api/submit.js ─────────────────────────────────────────────────────────────
// Endpoint de captación de leads
// Flujo: recibe form → scoring (Claude + fallback) → Supabase → Notion → Gmail → Telegram → cadencias

import { upsertLead, updateLead, logEvent,
         logScoreHistory, sbInsert }                       from '../lib/supabase.js';
import { scoreWithLLM, calcScoreFallback,
         SECTOR_MAP, OBJ_MAP, SCORE_EMOJI }                from '../lib/scoring.js';
import { createNotionPage }                                from '../lib/notion.js';
import { sendTelegram }                                    from '../lib/telegram.js';

const TELEGRAM_CHAT_ID    = process.env.TELEGRAM_CHAT_ID;
const GMAIL_CLIENT_ID     = process.env.GMAIL_CLIENT_ID;
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const GMAIL_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN;
const GMAIL_FROM          = process.env.GMAIL_FROM || 'hello@gettreevu.com';

// ── Gmail Draft ───────────────────────────────────────────────────────────────
async function createGmailDraft({ nombre, email, empresa, sector, colaboradores, objetivo, problema, probabilidad, razon, accion, mensajePersonalizado }) {
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    console.warn('[gmail] Credenciales no configuradas — skip draft');
    return null;
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      client_id:     GMAIL_CLIENT_ID,
      client_secret: GMAIL_CLIENT_SECRET,
      refresh_token: GMAIL_REFRESH_TOKEN,
      grant_type:    'refresh_token'
    })
  });
  if (!tokenRes.ok) { console.error('[gmail] Error access token:', await tokenRes.text()); return null; }
  const { access_token } = await tokenRes.json();

  const primerNombre = nombre.split(' ')[0];
  const apertura     = mensajePersonalizado
    ? mensajePersonalizado
    : `Vi que ${empresa} opera en el sector ${SECTOR_MAP[sector] || sector} con ${colaboradores} colaboradores — un perfil donde Treevü genera impacto directo en retención y productividad.`;

  const colabNum         = parseInt(colaboradores.split('-')[0].replace('+', '')) || 200;
  const rotacionEstimada = Math.round(colabNum * 0.15);
  const costoEstimado    = (rotacionEstimada * 8000).toLocaleString('es-PE');

  const bodyHtml = `
<p>Hola ${primerNombre}, espero que estés bien.</p>
<p>${apertura}</p>
<p><strong>¿Por qué esto es urgente?</strong><br>
Con una rotación promedio del 15% en tu sector, ${empresa} podría estar asumiendo ~S/ ${costoEstimado}/año solo en costos de reemplazo.</p>
<p><strong>Lo que Treevü resuelve:</strong><br>
✅ Acceso anticipado al salario — sin costo para el colaborador<br>
✅ Alerta de renuncia con 3 semanas de anticipación (motor ML)<br>
✅ Cero riesgo financiero para ${empresa} — modelo no-custodio<br>
✅ Piloto desde S/ 7/colaborador activo/mes</p>
<p>${razon ? `<em>${razon}</em><br><br>` : ''}¿Agendamos 30 minutos esta semana?<br>
👉 <a href="https://calendly.com/hello-gettreevu/30min">Reserva tu espacio aquí</a></p>
<p>Quedo atento,<br><strong>Equipo Treevü</strong><br>
<a href="https://gettreevu.com">gettreevu.com</a> · hello@gettreevu.com</p>`.trim();

  const mimeMessage = [
    `From: Treevü <${GMAIL_FROM}>`,
    `To: ${email}`,
    `Subject: Treevü × ${empresa} — Piloto EWA`,
    `Content-Type: text/html; charset=utf-8`,
    `MIME-Version: 1.0`,
    '',
    bodyHtml
  ].join('\r\n');

  const encoded = Buffer.from(mimeMessage).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const draftRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ message: { raw: encoded } })
  });
  if (!draftRes.ok) { console.error('[gmail] Error draft:', await draftRes.text()); return null; }
  const draft = await draftRes.json();
  console.log(`[gmail] Draft creado — ID: ${draft.id}`);
  return draft;
}

// ── Notion ────────────────────────────────────────────────────────────────────
async function saveToNotion({ nombre, email, empresa, sector, colaboradores, objetivo, problema, score, probabilidad, razon, mensajePersonalizado }) {
  const props = {
    'Nombre y Cargo': { title:     [{ text: { content: nombre } }] },
    'Email':          { email:     email },
    'Empresa':        { rich_text: [{ text: { content: empresa } }] },
    'Sector':         { select:    { name: SECTOR_MAP[sector] || 'Otro' } },
    'Colaboradores':  { select:    { name: colaboradores } },
    'Objetivo':       { select:    { name: OBJ_MAP[objetivo] || 'Otro' } },
    'Score':          { select:    { name: score } },
    'Estado':         { select:    { name: 'Nuevo' } }
  };
  if (problema)                     props['Reto libre']   = { rich_text: [{ text: { content: problema } }] };
  if (typeof probabilidad === 'number') props['Probabilidad'] = { number: probabilidad };
  if (razon) {
    const nota = [razon, mensajePersonalizado ? `\nApertura: "${mensajePersonalizado}"` : ''].join('').trim();
    props['Notas'] = { rich_text: [{ text: { content: nota } }] };
  }
  return createNotionPage(props);
}

// ── Telegram ──────────────────────────────────────────────────────────────────
async function notifyTelegram({ nombre, email, empresa, sector, colaboradores, objetivo, problema, score, probabilidad, razon, accion, senalesPositivas, senalesNegativas, mensajePersonalizado, fuenteScoring }) {
  if (score === 'BAJO') return null;

  const emoji    = SCORE_EMOJI[score] || '⚪';
  const probText = typeof probabilidad === 'number' ? ` · ${probabilidad}% prob.` : '';
  const fuenteTag = fuenteScoring === 'claude' ? '🤖 IA' : '⚡ Reglas';

  let msg = `${emoji} *Nuevo Lead ${score} — Treevü*\n_Scoring: ${fuenteTag}${probText}_\n\n`;
  msg += `👤 *${nombre}*\n📧 ${email}\n🏢 ${empresa}\n`;
  msg += `🏭 ${SECTOR_MAP[sector] || sector}\n👥 ${colaboradores} colaboradores\n`;
  msg += `🎯 ${OBJ_MAP[objetivo] || objetivo}`;
  if (problema)           msg += `\n💬 _${problema}_`;
  if (razon)              msg += `\n\n📊 *Análisis:* ${razon}`;
  if (senalesPositivas?.length) msg += `\n✅ ${senalesPositivas.join(' · ')}`;
  if (senalesNegativas?.length) msg += `\n⚠️ ${senalesNegativas.join(' · ')}`;
  if (mensajePersonalizado)     msg += `\n\n✉️ *Apertura sugerida:*\n_"${mensajePersonalizado}"_`;
  msg += `\n\n🚀 *Acción:* ${accion || 'Contactar pronto'}`;
  msg += `\n\n_Registrado en Supabase + Notion · Draft Gmail listo_`;

  return sendTelegram(msg);
}

// ── Cadencias D+1/D+3/D+7 para leads MEDIO ───────────────────────────────────
async function scheduleCadences(leadId, email, empresa, sector, colaboradores) {
  const now  = Date.now();
  const days = [1, 3, 7];
  const cadences = days.map(d => ({
    lead_id:       leadId,
    email,
    empresa,
    sector,
    colaboradores,
    day_number:    d,
    send_at:       new Date(now + d * 86400000).toISOString(),
    type:          'nurturing'
  }));
  try {
    await sbInsert('cadences', cadences);
    console.log(`[submit] Cadencias D+1/D+3/D+7 agendadas para ${email}`);
  } catch (err) {
    console.error('[submit] Error agendando cadencias:', err.message);
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { nombre, email, empresa, sector, colaboradores, objetivo, problema } = req.body || {};

  if (!nombre || !email || !empresa || !sector || !colaboradores || !objetivo) {
    return res.status(400).json({ error: 'Campos requeridos faltantes' });
  }
  if (JSON.stringify(req.body).length > 10_000) {
    return res.status(400).json({ error: 'Payload demasiado grande' });
  }

  console.log(`[submit] Lead entrante: ${empresa} | ${sector} | ${colaboradores}`);

  // 1. Scoring: Claude primero, fallback a reglas
  let result;
  let fuenteScoring = 'claude';
  try {
    result = await scoreWithLLM({ nombre, empresa, sector, colaboradores, objetivo, problema });
  } catch {
    result = calcScoreFallback(sector, colaboradores, objetivo);
    fuenteScoring = 'fallback';
    console.log('[submit] Fallback scoring aplicado');
  }

  const {
    score, probabilidad, razon, accion,
    señales_positivas:  senalesPositivas,
    señales_negativas:  senalesNegativas,
    mensaje_personalizado: mensajePersonalizado
  } = result;

  console.log(`[submit] Score: ${score} (${fuenteScoring}) — ${probabilidad}%`);

  // 2. Supabase — source of truth (no bloquea si falla)
  let leadId = null;
  try {
    const sbResult = await upsertLead({
      email,
      nombre,
      empresa,
      sector,
      colaboradores,
      objetivo,
      problema:             problema || null,
      score,
      score_inicial:        score,
      probabilidad,
      estado:               'Nuevo',
      fuente_scoring:       fuenteScoring,
      razon:                razon || null,
      señales_positivas:    senalesPositivas || [],
      señales_negativas:    senalesNegativas || [],
      mensaje_personalizado: mensajePersonalizado || null
    });
    leadId = sbResult?.[0]?.id || null;

    // Log eventos en paralelo
    await Promise.all([
      logEvent(email, 'lead_created', { score, probabilidad, fuenteScoring, sector, colaboradores, objetivo },
        { leadId, stageTo: 'Nuevo' }),
      logScoreHistory(email, leadId, score, probabilidad, fuenteScoring, {
        señales_positivas: senalesPositivas,
        señales_negativas: senalesNegativas
      })
    ]);
  } catch (err) {
    console.error('[submit] Supabase error:', err.message);
  }

  // 3. Cadencias para leads MEDIO
  if (score === 'MEDIO' && leadId) {
    scheduleCadences(leadId, email, empresa, sector, colaboradores).catch(() => {});
  }

  // 4. Draft Gmail para leads ALTO (async, no bloquea)
  if (score === 'ALTO') {
    createGmailDraft({ nombre, email, empresa, sector, colaboradores, objetivo, problema, probabilidad, razon, accion, mensajePersonalizado })
      .catch(err => console.error('[gmail] Draft error:', err.message));
  }

  // 5. Notion + Telegram en paralelo
  const [notionResult, telegramResult] = await Promise.allSettled([
    saveToNotion({ nombre, email, empresa, sector, colaboradores, objetivo, problema, score, probabilidad, razon, mensajePersonalizado }),
    notifyTelegram({ nombre, email, empresa, sector, colaboradores, objetivo, problema, score, probabilidad, razon, accion, senalesPositivas, senalesNegativas, mensajePersonalizado, fuenteScoring })
  ]);

  if (notionResult.status   === 'rejected') console.error('[submit] Notion error:', notionResult.reason?.message);
  if (telegramResult.status === 'rejected') console.error('[submit] Telegram error:', telegramResult.reason?.message);

  if (notionResult.status === 'rejected' && telegramResult.status === 'rejected') {
    return res.status(500).json({ error: 'Error al procesar solicitud' });
  }

  // Log notion_id en Supabase
  if (notionResult.status === 'fulfilled' && notionResult.value?.id && leadId) {
    updateLead(email, { notion_id: notionResult.value.id }).catch(() => {});
  }

  return res.status(200).json({ success: true, score, fuente_scoring: fuenteScoring });
}
