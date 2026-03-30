// api/content-reminder.js
// Cron: 7am Lima (12:00 UTC) lun–vie — manda el post del día desde Notion

import { sendMessage }    from './lib/telegram.js';
import { captureException } from './lib/sentry.js';

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

    const div = '─────────────────';
    let msg   = `📅 *Contenido de hoy — ${diaKey}*\n`;
    msg += `${DIA_TIPO[diaSemana]} · _${pageTitle}_\n${div}\n`;

    if (section.length === 0) {
      msg += `_Sin contenido registrado para ${diaKey} en esta semana._`;
    } else {
      // Truncar a 1800 chars para dejar margen al footer
      msg += section.join('\n').substring(0, 1800);
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
