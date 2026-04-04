/**
 * TREEVÜBOT — Asistente público Telegram (@treevubot)
 * Flujo guiado con botones inline → baja fricción → captura de lead
 * Sesiones persistidas en Upstash Redis (TTL 24h) — sobrevive cold starts
 */

import { detectGender }                                                       from './lib/validators.js';
import { tg as _tg, sendMessage as _sendMsg, answerCallback as _answerCb,
         editMessage as _editMsg, sendTyping as _sendTyping }                 from './lib/telegram.js';
import { askClaude as _askClaudeLib }                                         from './lib/anthropic.js';
import { PROGRAMA }                                                           from './lib/constants.js';
import { captureException }                                                   from './lib/sentry.js';
import { redisCmd }                                                           from './lib/redis.js';

const BOT_TOKEN      = process.env.TELEGRAM_VU_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.LEAD_WEBHOOK_SECRET;
const FUNNEL_URL     = 'https://gettreevu.com/api/lead';


function defaultSession() {
  return {
    step: 'INIT',  // INIT → SECTOR → SIZE → OBJETIVO → CHAT → CAPTURE_NAME → CAPTURE_COMPANY → CAPTURE_EMAIL → DONE
    sector: null,
    size: null,
    objetivo: null,
    name: null,
    company: null,
    email: null,
    gender: null,   // 'M' | 'F'
    history: [],
    leadSent: false,
  };
}

async function getSession(chatId) {
  const raw = await redisCmd('GET', `sess:${chatId}`);
  if (!raw) return defaultSession();
  try { return JSON.parse(raw); } catch { return defaultSession(); }
}

async function saveSession(chatId, session) {
  // TTL: 24 horas (86400 segundos)
  await redisCmd('SET', `sess:${chatId}`, JSON.stringify(session), 'EX', 86400);
}

// ── Telegram wrappers (bound to BOT_TOKEN) ─────────────────────────────────
const send           = (chatId, text, extra = {})              => _sendMsg(BOT_TOKEN, chatId, text, extra);
const typing         = (chatId)                                => _sendTyping(BOT_TOKEN, chatId);
const answerCallback = (callbackQueryId, text = '')            => _answerCb(BOT_TOKEN, callbackQueryId, text);
const editMessage    = (chatId, messageId, text, extra = {})   => _editMsg(BOT_TOKEN, chatId, messageId, text, extra);

// ── Inline keyboards ───────────────────────────────────────────────────────
const KB_INTENT = {
  inline_keyboard: [
    [{ text: '📊 Hacer diagnóstico gratuito', callback_data: 'intent:diagnostico' }],
    [{ text: '🔍 ¿Qué es Treevü?',           callback_data: 'intent:learn' }],
  ]
};

const KB_INTENT_AFTER_LEARN = {
  inline_keyboard: [
    [{ text: '📊 Sí, hacer el diagnóstico', callback_data: 'intent:diagnostico' }],
  ]
};

const KB_SIZE = {
  inline_keyboard: [
    [{ text: '50 – 200',      callback_data: 'size:50-200' },
     { text: '200 – 500',     callback_data: 'size:200-500' }],
    [{ text: '500 – 1,000',   callback_data: 'size:500-1000' },
     { text: '1,000 – 5,000', callback_data: 'size:1000-5000' }],
    [{ text: '5,000+',        callback_data: 'size:5000+' }],
  ]
};

const KB_OBJETIVO = {
  inline_keyboard: [
    [{ text: '📉 Reducir rotación',       callback_data: 'objetivo:rotacion' }],
    [{ text: '💚 Bienestar financiero',   callback_data: 'objetivo:bienestar' }],
    [{ text: '😊 Mejorar clima laboral',  callback_data: 'objetivo:clima' }],
    [{ text: '💰 Optimizar nómina',       callback_data: 'objetivo:nomina' }],
    [{ text: '🎯 Atraer talento',         callback_data: 'objetivo:talento' }],
  ]
};

const KB_SECTOR = {
  inline_keyboard: [
    [{ text: '🏭 Manufactura',    callback_data: 'sector:manufactura' },
     { text: '🛒 Retail',         callback_data: 'sector:retail' }],
    [{ text: '⚙️ Servicios',      callback_data: 'sector:servicios' },
     { text: '🏥 Salud',          callback_data: 'sector:salud' }],
    [{ text: '🏗️ Construcción',   callback_data: 'sector:construccion' },
     { text: '📚 Educación',      callback_data: 'sector:educacion' }],
    [{ text: '💻 Tecnología',     callback_data: 'sector:tecnologia' },
     { text: '🏦 Banca/Finanzas', callback_data: 'sector:banca' }],
    [{ text: '❓ Otro',           callback_data: 'sector:otro' }],
  ]
};

const KB_CTA = {
  inline_keyboard: [
    [{ text: '📩 Quiero que me contacten', callback_data: 'cta:contactar' }],
    [{ text: '❓ Tengo más preguntas',     callback_data: 'cta:preguntas' }],
  ]
};

// ── Estimador de costo de rotación ──────────────────────────────────────────
function estimarCostoRotacion(size) {
  const COSTO_REEMPLAZO = 8000;
  const TASA_ROTACION   = 0.18;
  const promedios = { '50-200': 125, '200-500': 350, '500-1000': 750, '1000-5000': 2500, '5000+': 7000 };
  const colabs    = promedios[size] || 125;
  const renuncias = Math.round(colabs * TASA_ROTACION);
  const costo     = (renuncias * COSTO_REEMPLAZO).toLocaleString('es-PE');
  return { colabs, renuncias, costo };
}

// ── Micro-feedback por tamaño ────────────────────────────────────────────────
function feedbackTamano(size) {
  const { renuncias, costo } = estimarCostoRotacion(size);
  const msgs = {
    '50-200':    `Con equipos de hasta 200 personas, cada renuncia cuesta ~S/ 8,000. Con ${renuncias} salidas anuales estimadas, eso son *S/ ${costo} al año*. Vamos al siguiente paso:`,
    '200-500':   `Con ~350 colaboradores, la rotacion puede costar *S/ ${costo} al año*. Es exactamente donde Treevü tiene mayor impacto. Una pregunta mas:`,
    '500-1000':  `Con 500+ colaboradores, el ahorro potencial con Treevü supera *S/ ${costo} anuales*. Eres exactamente el perfil del Programa Fundadores. Una pregunta mas:`,
    '1000-5000': `Con mas de 1,000 personas, el impacto es transformacional: *S/ ${costo} en rotacion evitable al año*. Ultima pregunta de calificacion:`,
    '5000+':     `Con mas de 5,000 colaboradores, eres el perfil ideal para el Programa Fundadores de Treevu. Ahorro potencial: *S/ ${costo}+/año*. Una pregunta mas:`,
  };
  return msgs[size] || msgs['50-200'];
}

// ── Micro-feedback por objetivo ──────────────────────────────────────────────
function feedbackObjetivo(objetivo) {
  const msgs = {
    rotacion:   'Reducir rotacion es donde Treevu tiene el mayor impacto documentado: *-30% en 6 meses*. Solo falta saber en que sector operas:',
    bienestar:  'El bienestar financiero es la raiz de la rotacion. Treevu ataca el problema desde la causa, no el sintoma. ¿En que sector?',
    clima:      'El estres financiero explica el 40% del mal clima laboral. Treevu lo elimina sin costo para nadie. ¿En que sector opera tu empresa?',
    nomina:     'Treevu no toca la nomina — la complementa sin riesgo ni costo. Setup en 2 semanas. ¿En que sector?',
    talento:    'Los beneficios financieros son el diferenciador #1 para atraer talento en Peru hoy. ¿En que sector opera tu empresa?',
  };
  return msgs[objetivo] || '¿En que sector opera tu empresa?';
}

// ── Mapas de display ────────────────────────────────────────────────────────
const SECTOR_LABEL = {
  manufactura: 'Manufactura', retail: 'Retail y consumo', servicios: 'Servicios',
  salud: 'Salud', construccion: 'Construccion/Mineria', educacion: 'Educacion',
  tecnologia: 'Tecnologia', banca: 'Banca/Finanzas', otro: 'Otro'
};
const OBJETIVO_LABEL = {
  rotacion: 'Reducir rotación', bienestar: 'Bienestar financiero',
  clima: 'Mejorar clima laboral', nomina: 'Optimizar nómina', talento: 'Atraer talento'
};

// ── Claude ─────────────────────────────────────────────────────────────────
async function askClaude(session) {
  const reply = await _askClaudeLib(null, {
    system:    buildSystem(session),
    maxTokens: 200,
    messages:  session.history,
  });
  return reply || 'Escríbenos a hello@gettreevu.com.';
}

function buildSystem(s) {
  const f = s.gender === 'F';
  const nombre = s.name || '';
  const concordancia = f
    ? 'Usa formas femeninas (estimada, lista, interesada, dispuesta, encantada).'
    : 'Usa formas masculinas (estimado, listo, interesado, dispuesto, encantado).';
  return `## IDENTIDAD
Eres Vü, asistente de ventas de Treevü en Telegram. Tu único objetivo: convertir prospectos al Programa Fundadores.

## CONTEXTO DEL PROSPECTO
${nombre ? `Nombre: ${nombre}\n` : ''}Sector: ${SECTOR_LABEL[s.sector] || s.sector || 'no indicado'}
Tamaño: ${s.size || 'no indicado'} colaboradores
Objetivo declarado: ${OBJETIVO_LABEL[s.objetivo] || s.objetivo || 'no indicado'}
Género detectado: ${f ? 'F' : 'M'}

## PRODUCTO (hechos verificados)
- Salario devengado anticipado — S/ 0 costo para el colaborador
- Cero riesgo financiero para la empresa (modelo no-custodio)
- ML predice renuncias 3 semanas antes
- Setup en 2 semanas, sin cambios en nómina
- Rotación documentada: -30% en 6 meses
- Programa Fundadores: ~40% de descuento de por vida, cupos limitados

## REGLAS DE RESPUESTA
- Máximo 3 líneas por mensaje
- Tono cálido, español peruano
- 1 emoji por mensaje
- ${concordancia}

## RESTRICCIONES
- Si detectas interés real de ser contactado, escribe exactamente "¿Quieres que el equipo te contacte?" (el sistema mostrará el botón automáticamente)
- Si el usuario pide ser contactado, solo confirma que el equipo escribirá — tú no los aceptas al programa
- Solo responde temas de Treevü y bienestar financiero laboral
- Si te preguntan algo fuera de scope, redirecciona: "Para eso escríbenos a hello@gettreevu.com"`;
}

// Detecta si Claude sugiere mostrar CTA de contacto
function shouldShowCTA(reply) {
  return /contacte|contactar|equipo te|equipo se|comunique|reserve|reservar|más info|información formal|hablar contigo|ponerse en contacto/i.test(reply);
}

// ── Score ICP automático ─────────────────────────────────────────────────────
function calcIcpScore(sector, size, objetivo) {
  const highValueSectors = ['manufactura', 'banca', 'salud', 'tecnologia'];
  const highValueObjetivos = ['rotacion', 'bienestar'];
  const largeSizes = ['500-1000', '1000-5000', '5000+'];
  const midSizes   = ['200-500'];

  const isHighSector  = highValueSectors.includes(sector);
  const isHighObjetivo = highValueObjetivos.includes(objetivo);
  const isLargeSize   = largeSizes.includes(size);
  const isMidSize     = midSizes.includes(size);

  if ((isLargeSize) && (isHighSector || isHighObjetivo)) return 'ALTO';
  if (isLargeSize || (isMidSize && (isHighSector || isHighObjetivo))) return 'MEDIO';
  if (isMidSize || isHighSector) return 'MEDIO';
  return 'BAJO';
}

// ── Enviar al funnel ────────────────────────────────────────────────────────
async function submitToFunnel(session, chatId) {
  const score = calcIcpScore(session.sector, session.size, session.objetivo);
  try {
    await fetch(FUNNEL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': WEBHOOK_SECRET },
      body: JSON.stringify({
        name:           session.name,
        email:          session.email,
        company:        session.company || '',
        sector:         SECTOR_LABEL[session.sector] || session.sector,
        employees:      session.size,
        objetivo:       OBJETIVO_LABEL[session.objetivo] || session.objetivo,
        message:        `Objetivo: ${OBJETIVO_LABEL[session.objetivo] || session.objetivo} | Canal: @treevubot`,
        source:         'Telegram @treevubot',
        score,
        telegramChatId: chatId,
      }),
    });
  } catch (err) {
    console.error('[telegram] funnel error:', err.message);
  }
}

// ── Handler de mensajes de texto ────────────────────────────────────────────
async function handleText(chatId, text, firstName, session) {
  // Captura de nombre
  if (session.step === 'CAPTURE_NAME') {
    session.name   = text.trim();
    session.gender = detectGender(session.name);
    session.step   = 'CAPTURE_COMPANY';
    await saveSession(chatId, session);
    const esTu = session.gender === 'F' ? 'Perfecta' : 'Perfecto';
    await send(chatId, `${esTu}, *${session.name}*. ¿En qué empresa trabajas?`);
    return;
  }

  // Captura de empresa
  if (session.step === 'CAPTURE_COMPANY') {
    session.company = text.trim();
    session.step    = 'CAPTURE_EMAIL';
    await saveSession(chatId, session);
    await send(chatId, `¿Cuál es tu correo corporativo de *${session.company}*?`);
    return;
  }

  // Captura de email
  if (session.step === 'CAPTURE_EMAIL') {
    const emailOk = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(text.trim());
    if (!emailOk) {
      await send(chatId, 'Ese correo no parece válido. ¿Puedes escribirlo de nuevo?');
      return;
    }
    session.email    = text.trim();
    session.step     = 'DONE';
    session.leadSent = true;
    await saveSession(chatId, session);

    const score = calcIcpScore(session.sector, session.size, session.objetivo);
    const diasCierre = Math.ceil((new Date(PROGRAMA.FECHA_CIERRE) - new Date()) / 864e5);

    if (score === 'ALTO') {
      // Lead ideal → ofrecer Calendly directo con urgencia Founders Program
      await send(chatId,
        `✅ *${session.name}*, tu perfil encaja perfecto con el Programa Fundadores.\n\n` +
        `Solo quedan *${PROGRAMA.CUPOS_TOTAL} cupos disponibles* — cierre el *30 de abril* (${diasCierre} días).\n\n` +
        `Puedes agendar los 20 minutos directamente o esperar que el equipo te escriba a *${session.email}*:`,
        {
          reply_markup: {
            inline_keyboard: [[{
              text: '📅 Agendar reunión ahora',
              url:  PROGRAMA.BOOKING,
            }]],
          },
        }
      );
    } else if (score === 'MEDIO') {
      // Lead compatible → mensaje estándar + opción de agendar
      await send(chatId,
        `✅ *${session.name}*, recibido. El equipo de Treevü te escribirá en menos de 24 horas a *${session.email}*.\n\n` +
        `Si prefieres adelantar los pasos, puedes agendar una llamada de 20 minutos aquí:`,
        {
          reply_markup: {
            inline_keyboard: [[{
              text: '📅 Agendar 20 min',
              url:  PROGRAMA.BOOKING,
            }]],
          },
        }
      );
    } else {
      // Lead BAJO → mensaje estándar sin botón de Calendly
      await send(chatId,
        `✅ *${session.name}*, recibido. El equipo de Treevü revisará tu información y te escribirá en menos de 24 horas a *${session.email}* para coordinar los siguientes pasos.`
      );
    }

    await submitToFunnel(session, chatId);
    return;
  }

  // Conversación libre con Vü (solo si ya está calificado)
  if (session.step === 'CHAT' || session.step === 'DONE') {
    await typing(chatId);
    session.history.push({ role: 'user', content: text });
    if (session.history.length > 10) session.history = session.history.slice(-10);

    const reply = await askClaude(session);
    session.history.push({ role: 'assistant', content: reply });
    await saveSession(chatId, session);

    const extra = (!session.leadSent && shouldShowCTA(reply))
      ? { reply_markup: KB_CTA }
      : {};

    await send(chatId, reply, extra);
    return;
  }

  // Mensaje antes de completar el flujo de calificación
  await send(chatId, 'Completa las preguntas rápidas de arriba para continuar. ¡Solo son 3 toques! 👆');
}

// ── Handler de callbacks (botones) ─────────────────────────────────────────
async function handleCallback(chatId, callbackId, data, messageId, firstName, session) {
  const [field, value] = data.split(':');
  await answerCallback(callbackId);

  // ── Menú de intención ────────────────────────────────────────────────────
  if (field === 'intent' && value === 'learn') {
    await editMessage(chatId, messageId,
      `*Treevü en 30 segundos:*\n\n` +
      `✅ Tus colaboradores acceden a su salario ya ganado — antes del dia de pago.\n` +
      `✅ Costo S/ 0 para el colaborador y para la empresa.\n` +
      `✅ Motor ML que predice quien va a renunciar *3 semanas antes*.\n` +
      `✅ Setup en 2 semanas, sin cambios en tu sistema de nomina.\n\n` +
      `_¿Quieres ver cuanto le cuesta la rotacion a tu empresa especificamente?_`,
      { reply_markup: KB_INTENT_AFTER_LEARN }
    );
    return;
  }

  if (field === 'intent' && value === 'diagnostico') {
    session.step = 'INIT';
    await saveSession(chatId, session);
    await editMessage(chatId, messageId, `📊 *Diagnostico de rotacion — 3 preguntas*\n\n_Pregunta 1 de 3:_`);
    await send(chatId, '¿Cuantos colaboradores tiene tu empresa?', { reply_markup: KB_SIZE });
    return;
  }

  // ── 1/3 Tamaño → micro-feedback → objetivo ──────────────────────────────
  if (field === 'size') {
    session.size = value;
    session.step = 'SIZE';
    await saveSession(chatId, session);
    await editMessage(chatId, messageId, `👥 *${value} colaboradores* ✓  _(1/3)_`);
    await send(chatId, feedbackTamano(value) + '\n\n_Pregunta 2 de 3:_', { reply_markup: KB_OBJETIVO });
    return;
  }

  // ── 2/3 Objetivo → micro-feedback → sector ──────────────────────────────
  if (field === 'objetivo') {
    session.objetivo = value;
    session.step = 'OBJETIVO';
    await saveSession(chatId, session);
    await editMessage(chatId, messageId, `🎯 *${OBJETIVO_LABEL[value]}* ✓  _(2/3)_`);
    await send(chatId, feedbackObjetivo(value) + '\n\n_Pregunta 3 de 3:_', { reply_markup: KB_SECTOR });
    return;
  }

  // ── 3/3 Sector → insight personalizado → Vü inicia ──────────────────────
  if (field === 'sector') {
    session.sector = value;
    session.step = 'CHAT';
    await editMessage(chatId, messageId, `🏭 *${SECTOR_LABEL[value]}* ✓  _(3/3)_`);

    // Insight personalizado antes de abrir el chat
    const { renuncias, costo } = estimarCostoRotacion(session.size);
    await send(chatId,
      `📊 *Diagnostico completado*\n\n` +
      `Empresa: *${SECTOR_LABEL[value]}* · *${session.size} colaboradores*\n` +
      `Objetivo: *${OBJETIVO_LABEL[session.objetivo]}*\n\n` +
      `Rotacion anual estimada: *~${renuncias} personas*\n` +
      `Costo evitable con Treevu: *~S/ ${costo}/año*\n\n` +
      `_Vü te explica como resolverlo 👇_`
    );

    await typing(chatId);
    const intro = `Sector: ${SECTOR_LABEL[value]}, ${session.size} colaboradores, objetivo: ${OBJETIVO_LABEL[session.objetivo]}`;
    session.history.push({ role: 'user', content: `Mi empresa opera en: ${intro}. ¿Cómo me puede ayudar Treevü especificamente?` });

    const reply = await askClaude(session);
    session.history.push({ role: 'assistant', content: reply });
    await saveSession(chatId, session);

    const extra = shouldShowCTA(reply) ? { reply_markup: KB_CTA } : {};
    await send(chatId, reply, extra);
    return;
  }

  // ── CTA: quiero ser contactado ───────────────────────────────────────────
  if (field === 'cta' && value === 'contactar') {
    session.step = 'CAPTURE_NAME';
    await saveSession(chatId, session);
    await send(chatId, '¡Perfecto! ¿Cuál es tu nombre completo y cargo?\n_(Ej: María García, Directora RRHH)_');
    return;
  }

  // ── CTA: más preguntas ───────────────────────────────────────────────────
  if (field === 'cta' && value === 'preguntas') {
    await send(chatId, '¡Con gusto! ¿Qué quieres saber? 👇');
    return;
  }
}

// ── Handler principal ───────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  const body = req.body || {};

  try {
    // Callback query (botones)
    if (body.callback_query) {
      const cq        = body.callback_query;
      const chatId    = String(cq.message.chat.id);
      const firstName = cq.from?.first_name || '';
      const session   = await getSession(chatId);
      await handleCallback(chatId, cq.id, cq.data, cq.message.message_id, firstName, session);
      return res.status(200).json({ ok: true });
    }

    // Mensaje de texto
    const message = body.message || body.edited_message;
    if (!message?.text) return res.status(200).json({ ok: true });

    const chatId    = String(message.chat.id);
    const text      = message.text.trim();
    const firstName = message.from?.first_name || '';

    // /start — reinicia sesión
    if (text === '/start' || text.startsWith('/start ')) {
      const fresh = defaultSession();
      await saveSession(chatId, fresh);
      await send(chatId,
        `¡Hola${firstName ? ` ${firstName}` : ''}! 👋\n\n` +
        `*El 78% de trabajadores peruanos vive al dia.*\n` +
        `Eso cuesta a las empresas *2-3 horas semanales* por colaborador en productividad perdida — y *S/ 8,000+* cada vez que alguien se va.\n\n` +
        `Soy *Vü*, asistente de *Treevü*. En 3 preguntas rapidas calculo cuanto le cuesta esto a tu empresa y como resolverlo.\n\n` +
        `¿Por donde empezamos?`,
        { reply_markup: KB_INTENT }
      );
      return res.status(200).json({ ok: true });
    }

    const session = await getSession(chatId);
    await handleText(chatId, text, firstName, session);
  } catch (err) {
    console.error('[telegram] handler error:', err.message);
    captureException(err, { chatId: body?.message?.chat?.id || body?.callback_query?.message?.chat?.id });
  }

  return res.status(200).json({ ok: true });
}
