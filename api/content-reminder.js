// api/content-reminder.js
// Cron: 7am Lima (12:00 UTC) lun–vie — genera o recuerda el post del día
// Si hay contenido en Notion → lo manda. Si no → genera con Claude.
// LinkedIn (jueves) → siempre genera un draft, aunque haya contenido en Notion.

import { sendMessage }      from './lib/telegram.js';
import { captureException } from './lib/sentry.js';
import { askClaude }        from './lib/anthropic.js';

const NOTION_TOKEN     = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;
const TELEGRAM_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET      = process.env.CRON_SECRET;

// Día JS (getDay) → label del bloque en Notion
const DIA_LABEL = { 1: 'LUNES', 3: 'MIÉRCOLES', 4: 'JUEVES', 5: 'VIERNES' };

const DIA_TIPO = {
  1: '🖼 Carrusel Instagram',
  3: '🎬 Reel Instagram',
  4: '💼 LinkedIn',
  5: '📸 Story + Behind the Scenes',
};

// Temas rotativos para LinkedIn (se elige por semana del año para variedad)
const LINKEDIN_TEMAS = [
  'rotación de personal: el costo oculto que sangra a las empresas',
  'cómo el estrés financiero afecta la productividad de tus colaboradores',
  'EWA (acceso al salario devengado): qué es y por qué las empresas líderes ya lo usan',
  'employer branding: cómo reducir la rotación mejorando el bienestar financiero',
  'el colaborador endeudado no rinde: datos y soluciones reales',
  'por qué retener talento es más barato que reclutar (con números)',
  'finanzas personales de tus colaboradores = tu problema de negocio',
  'casos reales: empresas peruanas que redujeron rotación con beneficios financieros',
];

// ── Generación con Claude ─────────────────────────────────────────────────────

async function generarContenido(tipo, weekNum) {
  const tema = LINKEDIN_TEMAS[weekNum % LINKEDIN_TEMAS.length];

  const prompts = {
    // ── LINKEDIN ─────────────────────────────────────────────────────────────
    // Algoritmo 2026: dwell time es la señal #1. Hook → tiempo de lectura → comentario.
    // Sin links en el cuerpo (matan alcance). Sin "me complace compartir". Una sola pregunta al final.
    '💼 LinkedIn': `Eres el equipo de contenido de Treevü, startup B2B de EWA (acceso al salario devengado) en Perú.

Escribe un post de LinkedIn sobre: "${tema}"

REGLAS DE ALGORITMO (obligatorias):
- Primera línea = gancho que corta el scroll. Dato concreto, pregunta incómoda o afirmación contrarian. Sin saludos.
- Salto de línea después de cada 1-2 oraciones (el algoritmo premia el dwell time; los párrafos cortos hacen leer más).
- Usa números reales cuando puedas: %, S/, días, personas.
- Ángulo personal o de insider: "lo que nadie dice sobre...", "lo aprendí trabajando con X empresas..."
- Cierra con UNA sola pregunta abierta (genera comentarios = señal de engagement).
- NO pongas links (reducen alcance; van en el primer comentario).
- Sin hashtags genéricos (#RRHH #Peru). Máximo 3 hashtags nicho al final si aportan.
- 150-250 palabras. Tono experto pero humano. Sin bullets con guión largo.

Devuelve SOLO el texto del post, listo para copiar.`,

    // ── CARRUSEL INSTAGRAM ───────────────────────────────────────────────────
    // Algoritmo 2026: swipe rate + saves son las señales clave.
    // Slide 1 debe detener el scroll. Slide final debe generar "guardar".
    '🖼 Carrusel Instagram': `Eres el equipo de contenido de Treevü (EWA B2B, Perú).

Genera un carrusel de Instagram de 6 slides sobre: rotación laboral y bienestar financiero.

REGLAS DE ALGORITMO (obligatorias):
- Slide 1: afirmación que duela o sorprenda. Sin contexto previo. Max 8 palabras. Que detenga el scroll.
- Slides 2-5: cada uno = UN solo punto accionable. Max 10 palabras de título + 1 línea de dato/ejemplo.
- Slide 6: CTA que genere SAVES. Fórmula: "Guarda esto para la próxima vez que..." o "Comparte con el gerente de RRHH de tu empresa".
- Tono: directo, peruano, B2B. Audiencia: gerentes RRHH y CEO de 200-2000 empleados.
- Cada slide debe poder leerse en 3 segundos.

Formato de respuesta:
Slide 1: [texto]
Slide 2: [título] — [dato/ejemplo]
Slide 3: [título] — [dato/ejemplo]
Slide 4: [título] — [dato/ejemplo]
Slide 5: [título] — [dato/ejemplo]
Slide 6: [CTA]
Caption: [primera línea antes del "ver más" — debe obligar a hacer tap. Max 125 caracteres] + [caption completo, max 200 palabras] + [3-5 hashtags nicho]`,

    // ── REEL INSTAGRAM ───────────────────────────────────────────────────────
    // Algoritmo 2026: retention rate es todo. Los primeros 3 segundos determinan el alcance.
    // Save > share > comment > like. El hook de texto en pantalla + hook hablado = doble impacto.
    '🎬 Reel Instagram': `Eres el equipo de contenido de Treevü (EWA B2B, Perú).

Genera el guión de un Reel de Instagram de 30-45 segundos sobre cómo Treevü reduce la rotación.

REGLAS DE ALGORITMO (obligatorias):
- 0-3s: hook de texto EN PANTALLA (bold, grande) + lo que dice la voz. Deben ser distintos pero complementarios. El texto del gancho debe provocar "¿qué?" o "¿de verdad?".
- 3-30s: desarrollo en 3 puntos máximo. Cada punto = 1 dato concreto + visual sugerido.
- 30-45s: cierre con pregunta o dato sorprendente que invite a guardar o comentar.
- Sugiere el audio: tipo de música o mood (no nombre específico para no violar derechos).
- El guión hablado debe sonar natural, no leído.

Formato:
[0-3s] TEXTO EN PANTALLA: "..." | VOZ: "..."
[3-15s] VOZ: "..." | VISUAL: [descripción]
[15-28s] VOZ: "..." | VISUAL: [descripción]
[28-40s] VOZ: "..." | VISUAL: [descripción]
[40-45s] VOZ: "..." (cierre)
AUDIO SUGERIDO: [mood/tipo]
CAPTION: [primera línea hook] + [caption] + [3-5 hashtags nicho]`,

    // ── STORY + BTS ──────────────────────────────────────────────────────────
    // Stories: autenticidad > producción. BTS genera confianza y humaniza la marca.
    // Algoritmo premia las respuestas (DMs) y los taps en el link/sticker.
    '📸 Story + Behind the Scenes': `Eres el equipo de contenido de Treevü (EWA B2B, Perú).

Genera 3 ideas de Stories + Behind the Scenes para hoy.

REGLAS DE ALGORITMO (obligatorias):
- Cada idea debe provocar una RESPUESTA (DM) o tap en sticker/link. El algoritmo mide replies.
- Autenticidad > producción perfecta. Mostrar el proceso, los errores, el equipo real.
- Incluir un sticker interactivo en cada una: encuesta, pregunta, cuenta regresiva o quiz.
- Formato vertical, pensado para grabarse en 30 segundos con el celular.

Formato por idea:
📍 Idea [N]: [descripción en 1 línea de qué grabar]
🎬 Cómo: [instrucciones de grabación simples]
💬 Sticker: [tipo de sticker + texto exacto de la pregunta/encuesta]
🎯 Objetivo: [respuesta / tap en link / guardar]`,
  };

  const prompt = prompts[tipo] || prompts['💼 LinkedIn'];
  return askClaude(prompt, { maxTokens: 600 });
}

// ── Notion helpers ────────────────────────────────────────────────────────────

async function findContentPage() {
  const res = await fetch('https://api.notion.com/v1/search', {
    method:  'POST',
    headers: {
      'Authorization':  `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type':   'application/json',
    },
    body: JSON.stringify({
      query:  'Banco de Posts Semana',
      filter: { value: 'page', property: 'object' },
      sort:   { direction: 'descending', timestamp: 'last_edited_time' },
    }),
  });
  const data = await res.json();
  // La primera página cuyo título incluya "Banco de Posts" (ya viene ordenada por edición desc)
  return (data.results || []).find(p => {
    const titleArr = p.properties?.title?.title || p.properties?.Name?.title || [];
    return titleArr.map(t => t.plain_text).join('').includes('Banco de Posts');
  });
}

async function getBlocks(pageId) {
  const res = await fetch(
    `https://api.notion.com/v1/blocks/${pageId}/children?page_size=100`,
    {
      headers: {
        'Authorization':  `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
      },
    }
  );
  const data = await res.json();
  return data.results || [];
}

function blockText(block) {
  return (block[block.type]?.rich_text || []).map(rt => rt.plain_text).join('');
}

// Devuelve las líneas de la sección del día (entre su cabecera y la del siguiente día)
function extractDaySection(blocks, diaKey) {
  const marker     = `🗓 ${diaKey}`;
  const dayPattern = /^🗓\s+(LUNES|MARTES|MIÉRCOLES|JUEVES|VIERNES|SÁBADO|DOMINGO)/;
  let inSection    = false;
  const lines      = [];

  for (const block of blocks) {
    const text = blockText(block);
    if (text.includes(marker)) {
      inSection = true;
      lines.push(text);
      continue;
    }
    if (inSection && dayPattern.test(text)) break; // siguiente día → fin de sección
    if (inSection && text.trim())           lines.push(text);
  }

  return lines;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const isVercelCron = req.headers['authorization'] === `Bearer ${CRON_SECRET}`;
  const isManual     = req.query?.secret === CRON_SECRET;

  if (!isVercelCron && !isManual) return res.status(401).json({ error: 'Unauthorized' });

  try {
    // Día actual en Lima
    const nowLima   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
    const diaSemana = nowLima.getDay(); // 0=Dom…6=Sáb
    const diaKey    = DIA_LABEL[diaSemana];

    // Martes, sábado, domingo → sin contenido programado
    if (!diaKey) {
      console.log(`[content-reminder] Sin contenido para día ${diaSemana}`);
      return res.status(200).json({ skipped: true, day: diaSemana });
    }

    // Buscar la semana más reciente en Notion
    const page = await findContentPage();
    if (!page) throw new Error('No se encontró ninguna página "Banco de Posts" en Notion');

    const titleArr  = page.properties?.title?.title || page.properties?.Name?.title || [];
    const pageTitle = titleArr.map(t => t.plain_text).join('');

    // Leer bloques y extraer sección del día
    const blocks  = await getBlocks(page.id);
    const section = extractDaySection(blocks, diaKey);

    const tipo    = DIA_TIPO[diaSemana];
    const weekNum = Math.floor((nowLima - new Date(nowLima.getFullYear(), 0, 1)) / (7 * 864e5));
    const div     = '─────────────────';
    let msg       = `📅 *Contenido de hoy — ${diaKey}*\n`;
    msg += `${tipo} · _${pageTitle}_\n${div}\n`;

    if (section.length > 0) {
      msg += section.join('\n').substring(0, 1800);
    } else {
      // Sin contenido en Notion → generar con Claude
      const generado = await generarContenido(tipo, weekNum);
      if (generado) {
        msg += `_Sin contenido en Notion — draft generado por IA:_\n\n${generado.trim()}`;
      } else {
        msg += `_Sin contenido registrado para ${diaKey} en esta semana._`;
      }
    }

    // LinkedIn (jueves) → siempre agregar draft de post, aunque haya contenido en Notion
    if (diaSemana === 4 && section.length > 0) {
      const draft = await generarContenido('💼 LinkedIn', weekNum);
      if (draft) {
        msg += `\n\n${div}\n💼 *Draft LinkedIn (IA):*\n${draft.trim()}`;
      }
    }

    msg += `\n${div}\n_Abre Notion para el copy completo_ 📋`;

    await sendMessage(TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, msg);
    console.log(`[content-reminder] Enviado OK — ${diaKey} · ${pageTitle}`);
    return res.status(200).json({ ok: true, day: diaKey, page: pageTitle });

  } catch (err) {
    console.error('[content-reminder] Error:', err.message);
    captureException(err, { path: '/api/content-reminder' });
    sendMessage(TELEGRAM_TOKEN, TELEGRAM_CHAT_ID,
      `⚠️ *Error en content-reminder*\n\`${err.message}\``
    ).catch(() => {});
    return res.status(500).json({ error: err.message });
  }
}
