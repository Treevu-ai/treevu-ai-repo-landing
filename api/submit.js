import { sendAbmNotification }              from './abm-notify.js';
import { NOTION, SECTOR_MAP, OBJ_MAP, SCORE_EMOJI, checkEnvVars } from './lib/constants.js';

checkEnvVars(['NOTION_API_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'LEAD_WEBHOOK_SECRET', 'OPENCLAW_TOKEN'], 'submit');
import { sendMessage, escapeMd }            from './lib/telegram.js';
import { askClaude }                        from './lib/anthropic.js';
import { SCORING_LEADS }                    from './lib/prompts.js';
import { calcRenuncias }                    from './lib/sector-intel.js';
import { detectGender, calcScore } from './lib/validators.js';
import { captureException }                 from './lib/sentry.js';
import { getGmailToken, gmailDraft }        from './lib/gmail.js';
import { setCorsHeaders, isOriginAllowed, checkRateLimit } from './lib/cors.js';
import { logRequest, logError, logMetric, logRateLimit, logWebhookReject } from './lib/metrics.js';
import { validateSubmitBody } from './lib/validation.js';

const TELEGRAM_BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID    = process.env.TELEGRAM_CHAT_ID;

// ── Claude scoring ────────────────────────────────────────────────────────────
async function scoreWithClaude({ nombre, empresa, sector, colaboradores, objetivo, problema }) {

  const userPrompt = `Lead a calificar:
- Nombre y cargo: ${nombre}
- Empresa: ${empresa}
- Sector: ${SECTOR_MAP[sector] || sector}
- Colaboradores: ${colaboradores}
- Objetivo principal: ${OBJ_MAP[objetivo] || objetivo}
- Reto declarado: ${problema || 'No especificado'}`;

  try {
    const raw = await askClaude(userPrompt, { system: SCORING_LEADS, maxTokens: 380 });
    if (!raw) return null;
    const clean = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(clean);
    if (!parsed.score || !['ALTO','MEDIO','BAJO'].includes(parsed.score)) throw new Error('Score inválido');
    console.log(`[submit] Claude scoring OK: ${parsed.score} (${parsed.probabilidad}%)`);
    return parsed;
  } catch (err) {
    console.error('[submit] Claude error:', err.message);
    return null;
  }
}

// ── Fallback scoring (sin Claude) ─────────────────────────────────────────────
function calcScoreFallback(sector, colaboradores, objetivo) {
  const score = calcScore(sector, colaboradores, objetivo);
  if (score === 'ALTO') return { score, probabilidad: 75, razon: 'Perfil ideal: sector + tamaño + objetivo alineados.', accion: 'Contactar HOY — llamada de 20 min', señales_positivas: [], señales_negativas: [], mensaje_personalizado: null };
  if (score === 'MEDIO') return { score, probabilidad: 45, razon: 'Perfil compatible. Requiere validación adicional.', accion: 'Contactar esta semana', señales_positivas: [], señales_negativas: [], mensaje_personalizado: null };
  return { score, probabilidad: 15, razon: 'Perfil fuera del ICP actual del piloto.', accion: 'Nutrir con contenido, evaluar más adelante', señales_positivas: [], señales_negativas: [], mensaje_personalizado: null };
}

// ── Gmail Draft ───────────────────────────────────────────────────────────────
async function createGmailDraft({ nombre, email, empresa, sector, colaboradores, objetivo, problema, probabilidad, razon, accion, mensajePersonalizado }) {
  const access_token = await getGmailToken();
  if (!access_token) { console.warn('[gmail] No token — skip draft'); return null; }

  const primerNombre = nombre.split(/[\s,\-]+/)[0];
  const genero   = detectGender(nombre);
  const estimado = genero === 'F' ? 'estimada' : 'estimado';
  const atento   = genero === 'F' ? 'atenta'   : 'atento';
  const apertura = mensajePersonalizado
    ? mensajePersonalizado
    : `Vi que ${empresa} opera en el sector ${SECTOR_MAP[sector] || sector} con ${colaboradores} colaboradores — un perfil donde Treevü genera impacto directo en retención y productividad.`;

  const { renuncias: rotacionEstimada, tasa, costoStr: costoEstimado } = calcRenuncias(sector, colaboradores);
  const pctRotacion = Math.round(tasa * 100);

  const bodyHtml = `
<p>Hola ${primerNombre}, ${estimado}.</p>
<p>${apertura}</p>
<p><strong>¿Por qué esto es urgente?</strong><br>
Con una rotación promedio del ${pctRotacion}% en el sector ${SECTOR_MAP[sector] || sector}, ${empresa} podría estar asumiendo ~S/ ${costoEstimado}/año solo en costos de reemplazo.</p>
<p><strong>Lo que Treevü resuelve:</strong><br>
✅ <strong>CFO/Finanzas:</strong> predice la demanda de adelantos 30 días antes → reduce la reserva de caja hasta 45%, cero pasivo nuevo<br>
✅ <strong>RRHH/CEO:</strong> baja las renuncias por estrés financiero hasta 40% — alertas de rotación 3 semanas antes<br>
✅ Treevü no toca los fondos — la empresa transfiere directo, sin riesgo<br>
✅ Piloto desde S/ 7/colaborador activo/mes</p>
<p>${razon ? `<em>${razon}</em><br><br>` : ''}¿Agendamos 30 minutos esta semana?<br>
👉 <a href="https://calendar.app.google/Rxprk5tCDSDivwaA9">Reserva tu espacio aquí</a></p>
<p>Quedo ${atento},<br><strong>Equipo Treevü</strong><br>
<a href="https://gettreevu.com">gettreevu.com</a> · hello@gettreevu.com</p>`.trim();

  return gmailDraft(access_token, {
    to: email,
    subject: `Treevü × ${empresa} — Predice tu caja, retén a tu equipo`,
    bodyHtml,
  });
}

// ── Telegram ──────────────────────────────────────────────────────────────────
async function sendToTelegram({ nombre, email, empresa, sector, colaboradores, objetivo, problema, score, probabilidad, razon, accion, senalesPositivas, senalesNegativas, mensajePersonalizado, fuenteScoring }) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return null;
  if (score === 'BAJO') return null;

  const emoji    = SCORE_EMOJI[score] || '⚪';
  const probText = typeof probabilidad === 'number' ? ` · ${probabilidad}% prob. cierre` : '';
  const fuenteTag = fuenteScoring === 'claude' ? '🤖 IA' : '⚡ Reglas';

  let msg = `${emoji} *Nuevo Lead ${score} — Treevü*\n`;
  msg += `_Scoring: ${fuenteTag}${probText}_\n\n`;
  msg += `👤 *${escapeMd(nombre)}*\n📧 ${escapeMd(email)}\n🏢 ${escapeMd(empresa)}\n`;
  msg += `🏭 ${escapeMd(SECTOR_MAP[sector] || sector)}\n`;
  msg += `👥 ${colaboradores} colaboradores\n`;
  msg += `🎯 ${escapeMd(OBJ_MAP[objetivo] || objetivo)}`;
  if (problema) msg += `\n💬 _${escapeMd(problema)}_`;
  if (razon)    msg += `\n\n📊 *Análisis:* ${escapeMd(razon)}`;
  if (senalesPositivas?.length) msg += `\n✅ ${senalesPositivas.join(' · ')}`;
  if (senalesNegativas?.length) msg += `\n⚠️ ${senalesNegativas.join(' · ')}`;
  if (mensajePersonalizado) msg += `\n\n✉️ *Apertura sugerida:*\n_"${mensajePersonalizado}"_`;
  msg += `\n\n🚀 *Acción:* ${accion || 'Contactar pronto'}`;
  msg += `\n\n_Registrado en Notion CRM · Draft Gmail listo_`;

  return sendMessage(TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, msg);
}

// ── Handler ───────────────────────────────────────────────────────────────────
async function handler(req, res) {
  const t0 = Date.now();
  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  if (!isOriginAllowed(req)) {
    logWebhookReject('submit', 'origin_blocked', { origin: req.headers?.origin });
    return res.status(403).json({ error: 'Forbidden' });
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '';
  const rl = await checkRateLimit(ip);
  if (!rl.allowed) {
    logRateLimit(ip, '/api/submit');
    res.setHeader('Retry-After', String(rl.retryAfter));
    return res.status(429).json({ error: 'Too many requests' });
  }

  const validation = validateSubmitBody(req.body);
  if (validation.honeypot) {
    console.warn('[submit] Honeypot activado');
    return res.status(200).json({ success: true });
  }
  if (!validation.ok) return res.status(validation.status).json({ error: validation.error });

  const { nombre, email, empresa, sector, colaboradores, objetivo, problema } = req.body || {};

  console.log(`[submit] Lead entrante: ${empresa} | ${sector} | ${colaboradores}`);

  let result = await scoreWithClaude({ nombre, empresa, sector, colaboradores, objetivo, problema });
  let fuenteScoring = 'claude';

  if (!result) {
    result = calcScoreFallback(sector, colaboradores, objetivo);
    fuenteScoring = 'fallback';
    console.log('[submit] Fallback scoring aplicado');
  }

  const { score, probabilidad, razon, accion, señales_positivas: senalesPositivas, señales_negativas: senalesNegativas, mensaje_personalizado: mensajePersonalizado } = result;

  console.log(`[submit] Score final: ${score} (${fuenteScoring}) — ${probabilidad}%`);

  if (score === 'ALTO') {
    createGmailDraft({ nombre, email, empresa, sector, colaboradores, objetivo, problema, probabilidad, razon, accion, mensajePersonalizado })
      .catch(err => console.error('[gmail] Draft error:', err.message));
  }

  const [telegramResult] = await Promise.allSettled([
    sendToTelegram({ nombre, email, empresa, sector, colaboradores, objetivo, problema, score, probabilidad, razon, accion, senalesPositivas, senalesNegativas, mensajePersonalizado, fuenteScoring })
  ]);
  if (telegramResult.status === 'rejected') console.error('[submit] Telegram error:', telegramResult.reason?.message);

  // CRM unificado → notificación ABM con notionId
  fetch('https://gettreevu.com/api/lead', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-webhook-secret': process.env.LEAD_WEBHOOK_SECRET },
    body: JSON.stringify({
      name:        nombre,
      email,
      company:     empresa,
      role:        nombre.includes('-') ? nombre.split('-')[1]?.trim() : '',
      sector:      SECTOR_MAP[sector] || sector,
      employees:   colaboradores,
      objetivo:    OBJ_MAP[objetivo] || objetivo,
      message:     `${razon || ''} | Reto: ${problema || 'N/A'} | Acción: ${accion || ''} | Apertura: ${mensajePersonalizado || ''}`.slice(0, 500),
      source:      'gettreevu.com',
      score,
      probability: probabilidad,
    }),
  })
  .then(r => {
    if (!r.ok) throw new Error(`CRM respondió ${r.status}`);
    return r.json();
  })
  .then(data => sendAbmNotification('ALTA', { nombre, empresa, sector: SECTOR_MAP[sector] || sector, colaboradores, objetivo: OBJ_MAP[objetivo] || objetivo, score, email, notionId: data.notionId }))
  .catch(err => console.error('[submit] CRM/ABM error:', err.message));

  logMetric('lead.scored', score, { fuente: fuenteScoring, probabilidad });
  logRequest('/api/submit', 'POST', 200, Date.now() - t0, { score, empresa });
  return res.status(200).json({ success: true, score, fuente_scoring: fuenteScoring });
}

export default async function wrappedHandler(req, res) {
  try {
    return await handler(req, res);
  } catch (err) {
    logError('submit', err, { path: '/api/submit' });
    captureException(err, { path: '/api/submit' });
    return res.status(500).json({ error: 'Internal server error' });
  }
}
