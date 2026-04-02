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
    '💼 LinkedIn': `Eres el equipo de contenido de Treevü, startup B2B de acceso al salario devengado (EWA) en Perú.
Escribe un post de LinkedIn sobre: "${tema}".
Estilo: directo, datos concretos, voz de experto peruano en RRHH/finanzas.
Estructura: gancho (1 línea), 3-4 puntos cortos, CTA suave.
Máximo 180 palabras. Sin hashtags genéricos. Sin emojis exagerados.
Devuelve SOLO el texto del post.`,

    '🖼 Carrusel Instagram': `Eres el equipo de contenido de Treevü (EWA B2B, Perú).
Genera títulos y copy corto para un carrusel de Instagram de 5 slides sobre: rotación laboral y bienestar financiero.
Formato: slide 1 = gancho, slides 2-4 = puntos de valor, slide 5 = CTA.
Máximo 15 palabras por slide. Tono cercano y visual.
Devuelve SOLO los 5 slides en formato: "Slide N: [título]"`,

    '🎬 Reel Instagram': `Eres el equipo de contenido de Treevü (EWA B2B, Perú).
Genera un guión breve para un Reel de Instagram de 30-45 segundos.
Tema: cómo Treevü ayuda a las empresas a reducir rotación.
Incluye: hook en los primeros 3 segundos, 2-3 puntos de valor, cierre con pregunta.
Formato: [segundos] acción/texto en pantalla.
Máximo 80 palabras total.`,

    '📸 Story + Behind the Scenes': `Eres el equipo de contenido de Treevü (EWA B2B, Perú).
Sugiere 3 ideas de Stories + Behind the Scenes para Instagram de hoy.
Enfoque: mostrar el equipo, el proceso, o el impacto real en colaboradores.
Formato: una línea por idea, comenzando con un emoji.
Sin texto largo. Ideas concretas y filmables.`,
  };

  const prompt = prompts[tipo] || prompts['💼 LinkedIn'];
  return askClaude(prompt, { maxTokens: 400 });
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
