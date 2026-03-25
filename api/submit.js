const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID;
const NOTION_TOKEN       = process.env.NOTION_TOKEN;
const ANTHROPIC_API_KEY  = process.env.ANTHROPIC_API_KEY;
const NOTION_DATABASE_ID = "8a5cb4e6-16b9-4248-ac44-cab55c9ace6f";

const GMAIL_CLIENT_ID     = process.env.GMAIL_CLIENT_ID;
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const GMAIL_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN;
const GMAIL_FROM          = process.env.GMAIL_FROM || 'hello@gettreevu.com';

// ── Lookup maps ───────────────────────────────────────────────────────────────
const SECTOR_MAP = {
  retail: 'Retail y consumo', manufactura: 'Manufactura', servicios: 'Servicios',
  salud: 'Salud', tecnologia: 'Tecnologia', construccion: 'Construccion/Mineria',
  educacion: 'Educacion', otro: 'Otro'
};
const OBJ_MAP = {
  'reducir-rotacion': 'Reducir rotacion', 'mejorar-clima': 'Mejorar clima laboral',
  'optimizar-nomina': 'Optimizar nomina', 'bienestar-financiero': 'Bienestar financiero',
  'atraccion-talento': 'Atraer talento', otro: 'Otro'
};
const SCORE_EMOJI = { ALTO: '🔥', MEDIO: '🟡', BAJO: '🔵' };

// ── Fallback scoring ──────────────────────────────────────────────────────────
function calcScoreFallback(sector, colaboradores, objetivo) {
  let pts = 0;
  if (['200-500','500-1000','1000-5000'].includes(colaboradores)) pts += 3;
  else if (colaboradores === '50-200') pts += 2;
  else if (colaboradores === '5000+') pts += 1;
  if (objetivo === 'reducir-rotacion') pts += 3;
  else if (['bienestar-financiero','mejorar-clima'].includes(objetivo)) pts += 2;
  else pts += 1;
  if (['retail','manufactura'].includes(sector)) pts += 2;
  else if (['servicios','salud','construccion'].includes(sector)) pts += 1;
  if (pts >= 7) return { score: 'ALTO', probabilidad: 75, razon: 'Perfil ideal: sector + tamaño + objetivo alineados.', accion: 'Contactar HOY — llamada de 20 min', señales_positivas: [], señales_negativas: [], mensaje_personalizado: null };
  if (pts >= 4) return { score: 'MEDIO', probabilidad: 45, razon: 'Perfil compatible. Requiere validación adicional.', accion: 'Contactar esta semana', señales_positivas: [], señales_negativas: [], mensaje_personalizado: null };
  return { score: 'BAJO', probabilidad: 15, razon: 'Perfil fuera del ICP actual del piloto.', accion: 'Nutrir con contenido, evaluar más adelante', señales_positivas: [], señales_negativas: [], mensaje_personalizado: null };
}

// ── Claude scoring ────────────────────────────────────────────────────────────
async function scoreWithClaude({ nombre, empresa, sector, colaboradores, objetivo, problema }) {
  if (!ANTHROPIC_API_KEY) {
    console.warn('[submit] ANTHROPIC_API_KEY no configurada — usando fallback');
    return null;
  }

  const systemPrompt = `Eres el sistema de calificación de leads de Treevü, plataforma B2B2E de Earned Wage Access (EWA) con motor ML para empresas en Perú.

PRODUCTO:
- Modelo no-custodio: Treevü orquesta, el empleador transfiere directo al colaborador
- Precio piloto: S/ 7/colaborador activo/mes meses 1-2, luego S/ 490/mes dashboard + S/ 7/usuario activo
- ICP: empresas peruanas 100-5000 colaboradores, sectores retail/manufactura/servicios/construcción
- Decisores objetivo: Directores RRHH, CFO, CEO
- Dolor que resuelve: rotación laboral (S/ 8,000+ por reemplazo), estrés financiero, productividad perdida
- Diferenciador: 5 modelos ML predictivos, alerta de renuncia 3 semanas antes, cero riesgo financiero para la empresa

SCORING:
- ALTO (prob > 65%): empresa 200-5000 colab + sector prioritario + objetivo rotación/bienestar + urgencia o detalle específico en el reto
- MEDIO (prob 35-65%): empresa 100-500 colab + sector compatible + objetivo parcialmente alineado
- BAJO (prob < 35%): empresa <100 colab o sector no prioritario o objetivo poco alineado al producto

Responde SOLO con JSON válido, sin texto ni markdown adicional:
{
  "score": "ALTO|MEDIO|BAJO",
  "probabilidad": <número 0-100>,
  "razon": "<1-2 oraciones con análisis concreto del lead>",
  "accion": "<acción específica recomendada al equipo de ventas>",
  "señales_positivas": ["<señal>"],
  "señales_negativas": ["<señal>"],
  "mensaje_personalizado": "<oración de apertura personalizada para el primer contacto>"
}`;

  const userPrompt = `Lead a calificar:
- Nombre y cargo: ${nombre}
- Empresa: ${empresa}
- Sector: ${SECTOR_MAP[sector] || sector}
- Colaboradores: ${colaboradores}
- Objetivo principal: ${OBJ_MAP[objetivo] || objetivo}
- Reto declarado: ${problema || 'No especificado'}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    if (!res.ok) {
      console.error('[submit] Claude API error:', res.status, await res.text());
      return null;
    }

    const data = await res.json();
    const raw = data.content?.[0]?.text?.trim() || '';
    const clean = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    const parsed = JSON.parse(clean);

    if (!parsed.score || !['ALTO','MEDIO','BAJO'].includes(parsed.score)) {
      throw new Error('Score inválido en respuesta Claude');
    }
    console.log(`[submit] Claude scoring OK: ${parsed.score} (${parsed.probabilidad}%)`);
    return parsed;

  } catch (err) {
    console.error('[submit] Claude parsing error:', err.message);
    return null;
  }
}

// ── Gmail Draft ───────────────────────────────────────────────────────────────
async function createGmailDraft({ nombre, email, empresa, sector, colaboradores, objetivo, problema, probabilidad, razon, accion, mensajePersonalizado }) {
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    console.warn('[gmail] Credenciales Gmail no configuradas — skip draft');
    return null;
  }

  // 1. Obtener access token con refresh token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     GMAIL_CLIENT_ID,
      client_secret: GMAIL_CLIENT_SECRET,
      refresh_token: GMAIL_REFRESH_TOKEN,
      grant_type:    'refresh_token'
    })
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    console.error('[gmail] Error obteniendo access token:', err);
    return null;
  }

  const { access_token } = await tokenRes.json();

  // 2. Construir el email
  const primerNombre = nombre.split(' ')[0];
  const apertura = mensajePersonalizado
    ? mensajePersonalizado
    : `Vi que ${empresa} opera en el sector ${SECTOR_MAP[sector] || sector} con ${colaboradores} colaboradores — un perfil donde Treevü genera impacto directo en retención y productividad.`;

  const subject = `Treevü × ${empresa} — Piloto EWA`;

  // Costo estimado de rotación (referencia interna ICP)
  const colabNum = parseInt(colaboradores.split('-')[0].replace('+','')) || 200;
  const rotacionEstimada = Math.round(colabNum * 0.15);
  const costoEstimado = (rotacionEstimada * 8000).toLocaleString('es-PE');

  const bodyHtml = `
<p>Hola ${primerNombre}, espero que estés bien.</p>

<p>${apertura}</p>

<p><strong>¿Por qué esto es urgente?</strong><br>
Con una rotación promedio del 15% en tu sector, ${empresa} podría estar asumiendo ~S/ ${costoEstimado}/año solo en costos de reemplazo (S/ 8,000 por colaborador según estudios SHRM adaptados a Perú).</p>

<p><strong>Lo que Treevü resuelve:</strong><br>
✅ Acceso anticipado al salario — sin costo para el colaborador<br>
✅ Alerta de renuncia con 3 semanas de anticipación (motor ML)<br>
✅ Cero riesgo financiero para ${empresa} — modelo no-custodio<br>
✅ Piloto desde S/ 7/colaborador activo/mes</p>

<p>${razon ? `<em>${razon}</em><br><br>` : ''}¿Agendamos 30 minutos esta semana?<br>
👉 <a href="https://calendly.com/hello-gettreevu/30min">Reserva tu espacio aquí</a></p>

<p>Quedo atento,<br>
<strong>Equipo Treevü</strong><br>
<a href="https://gettreevu.com">gettreevu.com</a> · hello@gettreevu.com</p>
`.trim();

  // 3. Codificar en base64url (formato RFC 2822)
  const mimeMessage = [
    `From: Treevü <${GMAIL_FROM}>`,
    `To: ${email}`,
    `Subject: ${subject}`,
    `Content-Type: text/html; charset=utf-8`,
    `MIME-Version: 1.0`,
    ``,
    bodyHtml
  ].join('\r\n');

  const encoded = Buffer.from(mimeMessage)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  // 4. Crear draft via Gmail API
  const draftRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${access_token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ message: { raw: encoded } })
  });

  if (!draftRes.ok) {
    const err = await draftRes.text();
    console.error('[gmail] Error creando draft:', err);
    return null;
  }

  const draft = await draftRes.json();
  console.log(`[gmail] Draft creado OK — ID: ${draft.id} para ${email}`);
  return draft;
}

// ── Notion ────────────────────────────────────────────────────────────────────
async function saveToNotion({ nombre, email, empresa, sector, colaboradores, objetivo, problema, score, probabilidad, razon, mensajePersonalizado }) {
  if (!NOTION_TOKEN) {
    console.warn('[submit] NOTION_TOKEN no configurado');
    return null;
  }

  const body = {
    parent: { database_id: NOTION_DATABASE_ID },
    properties: {
      "Nombre y Cargo": { title: [{ text: { content: nombre } }] },
      "Email":          { email: email },
      "Empresa":        { rich_text: [{ text: { content: empresa } }] },
      "Sector":         { select: { name: SECTOR_MAP[sector] || 'Otro' } },
      "Colaboradores":  { select: { name: colaboradores } },
      "Objetivo":       { select: { name: OBJ_MAP[objetivo] || 'Otro' } },
      "Score":          { select: { name: score } },
      "Estado":         { select: { name: 'Nuevo' } }
    }
  };

  if (problema) body.properties["Reto libre"] = { rich_text: [{ text: { content: problema } }] };
  if (typeof probabilidad === 'number') body.properties["Probabilidad"] = { number: probabilidad };
  if (razon) {
    const nota = [razon, mensajePersonalizado ? `\nApertura sugerida: "${mensajePersonalizado}"` : ''].join('').trim();
    body.properties["Notas"] = { rich_text: [{ text: { content: nota } }] };
  }

  const res = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) throw new Error(`Notion ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── Telegram ──────────────────────────────────────────────────────────────────
async function sendToTelegram({ nombre, email, empresa, sector, colaboradores, objetivo, problema, score, probabilidad, razon, accion, senalesPositivas, senalesNegativas, mensajePersonalizado, fuenteScoring }) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('[submit] Telegram no configurado');
    return null;
  }
  if (score === 'BAJO') {
    console.log('[submit] Lead BAJO — sin notificación Telegram');
    return null;
  }

  const emoji = SCORE_EMOJI[score] || '⚪';
  const probText = typeof probabilidad === 'number' ? ` · ${probabilidad}% prob. cierre` : '';
  const fuenteTag = fuenteScoring === 'claude' ? '🤖 IA' : '⚡ Reglas';

  let msg = `${emoji} *Nuevo Lead ${score} — Treevü*\n`;
  msg += `_Scoring: ${fuenteTag}${probText}_\n\n`;
  msg += `👤 *${nombre}*\n`;
  msg += `📧 ${email}\n`;
  msg += `🏢 ${empresa}\n`;
  msg += `🏭 ${SECTOR_MAP[sector] || sector}\n`;
  msg += `👥 ${colaboradores} colaboradores\n`;
  msg += `🎯 ${OBJ_MAP[objetivo] || objetivo}`;
  if (problema) msg += `\n💬 _${problema}_`;
  if (razon)   msg += `\n\n📊 *Análisis:* ${razon}`;

  if (senalesPositivas?.length) msg += `\n✅ ${senalesPositivas.join(' · ')}`;
  if (senalesNegativas?.length) msg += `\n⚠️ ${senalesNegativas.join(' · ')}`;

  if (mensajePersonalizado) {
    msg += `\n\n✉️ *Apertura sugerida:*\n_"${mensajePersonalizado}"_`;
  }

  msg += `\n\n🚀 *Acción:* ${accion || 'Contactar pronto'}`;
  msg += `\n\n_Registrado en Notion CRM · Draft Gmail listo_`;

  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: msg, parse_mode: 'Markdown' })
  });

  if (!res.ok) throw new Error(`Telegram ${res.status}: ${await res.text()}`);
  return res.json();
}

// ── Nurturing sequence para leads MEDIO ──────────────────────────────────────
async function scheduleNurturing({ nombre, email, empresa, sector, colaboradores, probabilidad }) {
  console.log(`[nurturing] Lead MEDIO agendado para seguimiento: ${email} — ${empresa}`);
  console.log(`[nurturing] Día 1: caso de uso en ${sector}`);
  console.log(`[nurturing] Día 3: calculadora personalizada (${colaboradores} colab, ${probabilidad}% prob)`);
  console.log(`[nurturing] Día 5: CTA directo Calendly`);
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

  // Scoring: Claude primero, fallback a reglas
  let result = await scoreWithClaude({ nombre, empresa, sector, colaboradores, objetivo, problema });
  let fuenteScoring = 'claude';

  if (!result) {
    result = calcScoreFallback(sector, colaboradores, objetivo);
    fuenteScoring = 'fallback';
    console.log('[submit] Fallback scoring aplicado');
  }

  const {
    score, probabilidad, razon, accion,
    señales_positivas: senalesPositivas,
    señales_negativas: senalesNegativas,
    mensaje_personalizado: mensajePersonalizado
  } = result;

  console.log(`[submit] Score final: ${score} (${fuenteScoring}) — ${probabilidad}%`);

  // Nurturing para leads MEDIO
  if (score === 'MEDIO') {
    scheduleNurturing({ nombre, email, empresa, sector, colaboradores, probabilidad }).catch(
      err => console.error('[submit] Nurturing error:', err.message)
    );
  }

  // Draft Gmail solo para leads ALTO
  if (score === 'ALTO') {
    createGmailDraft({ nombre, email, empresa, sector, colaboradores, objetivo, problema, probabilidad, razon, accion, mensajePersonalizado }).catch(
      err => console.error('[gmail] Draft error:', err.message)
    );
  }

  const [notionResult, telegramResult] = await Promise.allSettled([
    saveToNotion({ nombre, email, empresa, sector, colaboradores, objetivo, problema, score, probabilidad, razon, mensajePersonalizado }),
    sendToTelegram({ nombre, email, empresa, sector, colaboradores, objetivo, problema, score, probabilidad, razon, accion, senalesPositivas, senalesNegativas, mensajePersonalizado, fuenteScoring })
  ]);

  if (notionResult.status   === 'rejected') console.error('[submit] Notion error:', notionResult.reason?.message);
  if (telegramResult.status === 'rejected') console.error('[submit] Telegram error:', telegramResult.reason?.message);

  if (notionResult.status === 'rejected' && telegramResult.status === 'rejected') {
    return res.status(500).json({ error: 'Error al procesar solicitud' });
  }

  // ── Notificar a AsisTreevü (guarda en Contacts DB + notificación en bot piloto) ──
  fetch('https://treevu-bot.vercel.app/lead', {
    method: 'POST',
    headers: {
      'Content-Type':     'application/json',
      'x-webhook-secret': 'treevu_lead_2026',
    },
    body: JSON.stringify({
      name:        nombre,
      email:       email,
      company:     empresa,
      role:        nombre.includes('-') ? nombre.split('-')[1]?.trim() : '',
      sector:      SECTOR_MAP[sector] || sector,
      employees:   colaboradores,
      message:     `[${score} · ${probabilidad}%] ${razon || ''} | Acción: ${accion || ''} | Apertura: ${mensajePersonalizado || ''}`.slice(0, 500),
      source:      'gettreevu.com',
      score:       score,
      probability: probabilidad,
    }),
  }).catch(err => console.error('[submit] AsisTreevü webhook error:', err.message));

  return res.status(200).json({ success: true, score, fuente_scoring: fuenteScoring });
}
