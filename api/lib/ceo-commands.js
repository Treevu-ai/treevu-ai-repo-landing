// api/lib/ceo-commands.js
// Handlers de comandos del panel CEO:
//   handleHelp, handlePipeline, handleFollowup
//   handleSDR, handleBriefing, handlePost, handleTweet, handleEnrich, handleQA
//   handleCierre, handleObjecion, handleDemo, handleROI

import { notionQuery, getProp } from './notion.js';
import { askClaude }            from './anthropic.js';
import {
  PIPELINE_ACCIONES, CIERRE_VENTAS, OBJECION_RESPUESTA,
  DEMO_SCRIPT, ROI_CALCULO, QA_PIPELINE,
} from './prompts.js';
import { redisCmd }             from './redis.js';
import { postLinkedIn }         from './linkedin.js';
import { postInstagram }        from './instagram.js';
import { searchPhoto, buildPhotoQuery } from './pexels.js';
import { scrapeCompany }        from './firecrawl.js';
import { NOTION }               from './constants.js';
import { getSectorIntel }       from './sector-intel.js';
import { escapeMd }             from './telegram.js';
import { getPipelineSummary, getPipelineActions } from './pipeline.js';

const CRON_SECRET = process.env.CRON_SECRET;

// ── Personas y ángulos para variedad de contenido ────────────────────────────
const PERSONAS = [
  {
    rol:      'CEO',
    emoji:    '👔',
    contexto: 'Escribís desde la mirada del CEO: visión estratégica, cultura organizacional, ventaja competitiva, retención del talento clave para el crecimiento del negocio.',
    audiencia: 'CEOs y directores generales de empresas peruanas de 200–2000 colaboradores',
    tono:     'visionario pero directo, con urgencia estratégica. Corto y contundente.',
  },
  {
    rol:      'CFO',
    emoji:    '💰',
    contexto: 'Escribís desde la mirada del CFO: costo total de la rotación en S/, ROI del beneficio EWA, impacto en el flujo de caja de la empresa, eficiencia de nómina vs. adelantos informales.',
    audiencia: 'CFOs, directores financieros y gerentes de administración de empresas peruanas medianas',
    tono:     'analítico, orientado a datos. Números en S/ cuando sea posible. Riguroso pero accesible.',
  },
  {
    rol:      'CHRO',
    emoji:    '🧑‍🤝‍🧑',
    contexto: 'Escribís desde la mirada del CHRO o Gerente de RRHH: bienestar financiero del colaborador, engagement, clima laboral, people analytics, retención y reducción de rotación.',
    audiencia: 'directores y gerentes de Recursos Humanos de empresas peruanas medianas',
    tono:     'empático y cercano, con datos de respaldo. Voz humana, no corporativa.',
  },
];

const ANGULOS = [
  'estadística + implicancia práctica que el lector no esperaba',
  'historia real de una empresa (sin nombrarla) + la lección que aprendieron',
  'afirmación contrarian que rompe un mito muy extendido en el sector',
  'pregunta incómoda que el lector debería hacerse pero evita',
  'comparación concreta: antes y después de implementar EWA en una empresa similar',
];

function pickPersona(weekNum, dayNum, forzada) {
  if (forzada) return PERSONAS.find(p => p.rol.toLowerCase() === forzada) || PERSONAS[0];
  return PERSONAS[(weekNum + Math.floor(dayNum / 2)) % PERSONAS.length];
}

// ── /help ────────────────────────────────────────────────────────────────────
export async function handleHelp(chatId, send) {
  await send(chatId,
    `*Panel de Control Treevü* 🎛️\n\n` +
    `*Pipeline:*\n` +
    `📊 /pipeline — resumen del CRM + 3 acciones de hoy\n` +
    `🔔 /followup — leads sin actividad +7 días\n\n` +
    `*Prospección:*\n` +
    `🎯 /sdr [industria] [tamaño] — busca prospectos en LinkedIn\n` +
    `   _Ej: /sdr retail 200+ · /sdr manufactura 500+_\n` +
    `📬 /enrich — agrega email y teléfono a leads SDR (Apollo)\n\n` +
    `*Ventas:*\n` +
    `🔍 /briefing <empresa o URL> — inteligencia pre-reunión + historial CRM\n` +
    `   _Ej: /briefing Alicorp · /briefing https://alicorp.com.pe_\n` +
    `🎬 /demo <empresa> — script personalizado para la demo\n` +
    `🛑 /objecion <texto> — 3 respuestas a la objeción del prospecto\n` +
    `🎯 /cierre <empresa> — mensaje de cierre listo para WhatsApp/email\n` +
    `💰 /roi <empresa> — cálculo de ROI listo para el CFO\n` +
    `🧠 /cto <pregunta> — CTO Virtual: Piloto vs API, tiempos, arquitectura\n` +
    `   _/cto reset — limpia el contexto_\n\n` +
    `*Contenido:*\n` +
    `📲 /post [linkedin|instagram] [ceo|cfo|chro] — genera post algoritmo-aware\n` +
    `   _Ej: /post linkedin cfo · /post instagram chro · /post ceo_\n` +
    `🐦 /tweet [texto] — genera o pule un tweet con confirmación\n\n` +
    `*Modo Q&A:*\nEscribí cualquier pregunta sobre el pipeline y te respondo con contexto real del CRM.\n` +
    `_Ej: "¿qué leads están calientes?" · "¿cuántos deals en propuesta?"_`,
    { parse_mode: 'Markdown' }
  );
}

// ── /pipeline ─────────────────────────────────────────────────────────────────
export async function handlePipeline(chatId, send) {
  await send(chatId, '_Consultando pipeline en Notion..._');

  try {
    const msg = await getPipelineSummary({ showDetails: true, showActions: false });
    await send(chatId, msg, { parse_mode: 'Markdown' });

    // Acciones IA
    const acciones = await getPipelineActions();
    if (acciones) await send(chatId, acciones, { parse_mode: 'Markdown' });
  } catch (err) {
    await send(chatId, `❌ Error consultando Notion: ${err.message}`);
  }
}

// ── /followup ─────────────────────────────────────────────────────────────────
export async function handleFollowup(chatId, send) {
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

  if (!pages.length) { await send(chatId, '✅ No hay leads pendientes.'); return; }

  const hoy      = new Date();
  const hace7d   = new Date(hoy - 7 * 24 * 60 * 60 * 1000).toISOString();
  const pendientes = pages.filter(p => (p.last_edited_time || '') < hace7d);

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

// ── /sdr ──────────────────────────────────────────────────────────────────────
export async function handleSDR(chatId, args, send) {
  const INDUSTRIES = ['retail', 'manufactura', 'salud', 'tecnologia', 'construccion', 'educacion', 'banca', 'servicios'];
  const SIZE_MAP   = { '50+': '51,200', '200+': '201,500', '500+': '501,1000', '1000+': '1001,5000' };

  const parts    = args.toLowerCase().split(/\s+/).filter(Boolean);
  const industry = parts.find(p => INDUSTRIES.includes(p)) || null;
  const sizeKey  = parts.find(p => SIZE_MAP[p]) || null;
  const size     = sizeKey ? SIZE_MAP[sizeKey] : '201,500';
  const label    = [industry || 'todas las industrias', sizeKey || '200+ empleados', 'Lima'].join(' · ');

  await send(chatId, `_🎯 Iniciando SDR Agent: ${label}..._\nRecibí los resultados en unos segundos.`);

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 58000);

  try {
    const res  = await fetch('https://gettreevu.com/api/sdr-agent', {
      method:  'POST',
      signal:  controller.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CRON_SECRET}` },
      body:    JSON.stringify({ industry, size, location: 'Lima, Peru', max_leads: 10, notify: false, strategy: 'intro' }),
    });

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); }
    catch {
      await send(chatId, `❌ SDR Agent devolvió error ${res.status}. Revisá los logs en Vercel.`);
      return;
    }

    if (!res.ok) { await send(chatId, `❌ SDR Agent error ${res.status}: ${data.error || text.slice(0, 100)}`); return; }

    let msg = `🎯 *SDR Agent terminado*\n_${label}_\n\n✅ *${data.added} leads* añadidos al CRM\n⏭ ${data.skipped} omitidos\n`;
    if (data.errors > 0) msg += `❌ ${data.errors} errores\n`;
    if (data.leads?.length) {
      msg += '\n*Nuevos prospectos:*\n';
      data.leads.slice(0, 8).forEach(l => { msg += `• *${l.company || '—'}* — ${l.role || '—'}\n`; });
    }
    if (!data.added && !data.leads?.length) msg += `\n_Sin prospectos nuevos. Intentá con otra industria._`;
    else msg += `\nUsá /pipeline para verlos en el CRM.`;

    await send(chatId, msg, { parse_mode: 'Markdown' });
  } catch (err) {
    if (err.name === 'AbortError') await send(chatId, `⏱ SDR Agent tardó más de 58s. Revisá Notion en 1 minuto.`);
    else                           await send(chatId, `❌ SDR Agent: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

// ── /briefing ────────────────────────────────────────────────────────────────
export async function handleBriefing(chatId, input, send) {
  if (!input) {
    await send(chatId, 'Uso: `/briefing <empresa o URL>`\n_Ej: /briefing Alicorp · /briefing https://alicorp.com.pe_', { parse_mode: 'Markdown' });
    return;
  }

  await send(chatId, `_🔍 Investigando "${input}"..._`);
  const isUrl = /^https?:\/\//i.test(input);

  try {
    // Buscar historial en CRM
    let crmHistorial = '';
    if (!isUrl) {
      try {
        const crmRes = await notionQuery(NOTION.CRM_DB, {
          property: 'Empresa',
          rich_text: { contains: input },
        }, 1);
        if (crmRes.results?.length) {
          const p = crmRes.results[0];
          const estado  = getProp(p, 'Estado')  || '—';
          const score   = getProp(p, 'Score')   || '—';
          const sector  = getProp(p, 'Sector')  || '—';
          const colabs  = getProp(p, 'Colaboradores') || '—';
          const notas   = getProp(p, 'Notas')   || '';
          const dias    = Math.floor((Date.now() - new Date(p.last_edited_time)) / 864e5);
          crmHistorial = `Estado en CRM: ${estado} | Score: ${score} | Sector: ${sector} | Colaboradores: ${colabs} | Última actividad: hace ${dias}d${notas ? ` | Notas previas: ${notas.slice(0, 120)}` : ''}`;
        }
      } catch { /* continue */ }
    }

    const webCtx = isUrl
      ? await import('./firecrawl.js').then(m => m.scrapeUrl(input)).catch(() => null)
      : await scrapeCompany(input).catch(() => null);

    const hasWeb = webCtx && webCtx.length > 80;

    const system = `Eres el asistente estratégico del CEO de Treevü (plataforma de acceso anticipado al salario con ML predictivo para empresas peruanas).
Treevü tiene dos ángulos de valor: (1) CFO/Finanzas — predice la caja 30 días antes, reduce la reserva hasta 45%, cero pasivo nuevo; (2) CEO/RRHH — baja renuncias por estrés financiero hasta 40%, alertas de rotación 3 semanas antes.
Genera briefings de reunión concisos y accionables. Adapta el ángulo según el perfil de la empresa.
Usa Markdown Telegram (*negrita*, _itálica_) — sin ### ni encabezados markdown.`;

    const userPrompt = `El CEO va a reunirse con: ${input}
${crmHistorial ? `\n*Historial en CRM:*\n${crmHistorial}\n` : ''}
${hasWeb ? `\nInformación del sitio web:\n${webCtx}\n` : ''}
Genera el briefing en este formato:

*🏢 ${isUrl ? 'Empresa' : input}*
_[Qué hace la empresa en 1 línea]_

*📊 Fit con Treevü*
• Sector y rotación probable
• Tamaño estimado y perfil de colaboradores
• Dolor más probable que resuelve Treevü
• Score de fit: ALTO / MEDIO / BAJO — razón en 1 frase

*🎯 Apertura recomendada*
[Guión de 2-3 oraciones, primera persona, personalizado]

*❓ Preguntas clave*
1. [Pregunta sobre dolor de rotación]
2. [Pregunta sobre adelantos informales]
3. [Pregunta sobre proceso de decisión]

*⚠️ Objeción probable*
[La más probable] → [respuesta concisa]

*💡 Dato ganador*
[Un dato o ángulo específico que conecta con esta empresa]`;

    const briefing = await askClaude(userPrompt, { system, maxTokens: 600 });
    if (!briefing) { await send(chatId, '❌ No pude generar el briefing. Intentá de nuevo.'); return; }

    await send(chatId, briefing, { parse_mode: 'Markdown' });
    if (!hasWeb) await send(chatId, `_⚠️ Sin datos web — briefing basado en sector/nombre. Agregá la URL: /briefing https://..._`, { parse_mode: 'Markdown' });
  } catch (err) {
    await send(chatId, `❌ Briefing: ${err.message}`);
  }
}

// ── /post ────────────────────────────────────────────────────────────────────
export async function handlePost(chatId, platform, personaArg, send, edit) {
  console.log('[ceo-commands/post] Iniciando handlePost', { chatId, platform, personaArg });
  const now     = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  const weekNum = Math.floor((now - new Date(now.getFullYear(), 0, 1)) / (7 * 864e5));
  const dayNum  = now.getDay();
  console.log('[ceo-commands/post] Fecha calculada', { now, weekNum, dayNum });

  const TEMAS_LI = [
    'el costo real de tener dinero parado en la reserva de nómina',
    'cómo el estrés financiero reduce la productividad de tus colaboradores',
    'predice la caja antes de que se convierta en un problema',
    'el colaborador que no llega a fin de mes ya está buscando otro trabajo',
    'rotación laboral: lo que el CFO ve que RRHH no está midiendo',
    'retener talento cuesta menos que reclutar — con números reales de Perú',
    'acceso anticipado al salario: la decisión que cambia dos estados financieros',
    'casos reales: empresas que redujeron renuncias y optimizaron su caja a la vez',
  ];
  const tema    = TEMAS_LI[weekNum % TEMAS_LI.length];
  const persona = pickPersona(weekNum, dayNum, personaArg);
  const angulo  = ANGULOS[(weekNum * 2 + dayNum) % ANGULOS.length];

  const genLinkedIn = () => {
    console.log('[ceo-commands/post] genLinkedIn iniciando');
    return askClaude(
      `Escribe un post de LinkedIn sobre: ${tema}

Perspectiva: ${persona.rol}
Tono: ${persona.tono}

REGLAS:
- Máximo 150 palabras
- Primera línea = gancho impactante
- Salto de línea cada 1-2 oraciones
- Cierra con 1 pregunta abierta
- Sin links en el cuerpo
- Máximo 3 hashtags nicho al final

Devuelve SOLO el texto del post.`,
      { maxTokens: 300 }
    ).then(result => {
      console.log('[ceo-commands/post] genLinkedIn completado, longitud:', result?.length || 0);
      return result;
    }).catch(err => {
      console.error('[ceo-commands/post] genLinkedIn error:', err);
      throw err;
    });
  };

  const genInstagram = (tipo) => {
    if (tipo === 'carousel') {
      return askClaude(
        `Eres el equipo de contenido de Treevü (EWA B2B, Perú).\n\nGenera un carrusel de Instagram de 6 slides sobre rotación laboral y bienestar financiero.\n\nREGLAS:\n- Slide 1: afirmación que duela. Max 8 palabras.\n- Slides 2-5: UN punto + 1 dato. Max 10 palabras de título.\n- Slide 6: CTA que genere SAVES.\n\nFormato:\nSlide 1: [texto]\nSlide 2: [título] — [dato]\nSlide 3: [título] — [dato]\nSlide 4: [título] — [dato]\nSlide 5: [título] — [dato]\nSlide 6: [CTA]\nCaption: [hook 125 chars] | [caption 150 palabras] | [3-5 hashtags nicho]`,
        { maxTokens: 400 }
      );
    }
    return askClaude(
      `Eres el equipo de contenido de Treevü (EWA B2B, Perú).\n\nGuión de Reel 30-45s sobre cómo Treevü reduce la rotación.\n\nREGLAS:\n- 0-3s: texto EN PANTALLA + voz distintos pero complementarios.\n- 3-30s: 3 puntos con dato + visual.\n- 30-45s: cierre que invite a guardar.\n\nFormato:\n[0-3s] TEXTO: "..." | VOZ: "..."\n[3-15s] VOZ: "..." | VISUAL: ...\n[15-28s] VOZ: "..." | VISUAL: ...\n[28-40s] VOZ: "..." | VISUAL: ...\n[40-45s] VOZ: "..." (cierre)\nAUDIO: [mood]\nCAPTION: [hook] | [texto] | [3-5 hashtags nicho]`,
      { maxTokens: 400 }
    );
  };

  const doLinkedIn = !platform || platform === 'linkedin' || platform === 'li';
  const doIG       = !platform || platform === 'instagram' || platform === 'ig';
  const igTipo     = now.getDay() === 3 ? 'reel' : 'carousel';
  console.log('[ceo-commands/post] Plataformas', { doLinkedIn, doIG, igTipo });

  await send(chatId, `_✍️ Generando contenido${doLinkedIn && doIG ? ' para LinkedIn e Instagram' : doLinkedIn ? ' para LinkedIn' : ' para Instagram'}..._`);
  console.log('[ceo-commands/post] Mensaje de "generando" enviado');

  try {
    if (doLinkedIn) {
      console.log('[ceo-commands/post] Generando LinkedIn...');
      const li = await genLinkedIn().catch(err => {
        console.error('[ceo-commands/post] genLinkedIn error:', err);
        return null;
      });
      if (li) {
        const key = `li:draft:${chatId}:${Date.now()}`;
        await redisCmd('SET', key, li, 'EX', 300);
        // Escapar backticks en el contenido para evitar romper el bloque de código
        const liEscapado = li.replace(/`/g, "'");
        await send(chatId,
          `💼 *LinkedIn — draft listo* _(${persona.rol} ${persona.emoji})_\n_Tema: ${tema}_\n\n\`\`\`\n${liEscapado}\n\`\`\`\n\n💡 _El link va en el primer comentario._`,
          { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
            { text: '✅ Publicar en LinkedIn', callback_data: `li_ok:${key}` },
            { text: '📋 Solo copiar',          callback_data: 'li_cancel' },
          ]] } }
        );
      } else {
        console.error('[ceo-commands/post] genLinkedIn retornó null');
        await send(chatId, '❌ Error generando el post de LinkedIn. Intentá de nuevo.');
      }
    }

    if (doIG) {
      console.log('[ceo-commands/post] Generando Instagram...');
      const ig = await genInstagram(igTipo).catch(err => {
        console.error('[ceo-commands/post] genInstagram error:', err);
        return null;
      });
      if (ig) {
        const label = igTipo === 'carousel' ? '🖼 Carrusel Instagram' : '🎬 Reel Instagram';
        if (igTipo === 'carousel') {
          const photo = await searchPhoto(buildPhotoQuery(tema)).catch(() => null);
          if (photo) {
            const captionMatch = ig.match(/Caption:\s*(.+?)(?:\n|$)/s);
            const caption = captionMatch ? captionMatch[1].trim() : ig.slice(0, 500);
            const igKey   = `ig:draft:${chatId}:${Date.now()}`;
            await redisCmd('SET', igKey, JSON.stringify({ imageUrl: photo.url, caption }), 'EX', 300);
            await send(chatId,
              `${label} — *draft listo*\n\n🖼 Imagen: [ver foto](${photo.pageUrl}) _(${photo.photographer})_\n\n📝 Caption:\n${caption.slice(0, 400)}`,
              { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
                { text: '✅ Publicar en Instagram', callback_data: `ig_ok:${igKey}` },
                { text: '📋 Solo copiar',           callback_data: 'ig_cancel' },
              ]] } }
            );
          } else {
            await send(chatId, `${label} — *guión listo*\n\n${ig}`, { parse_mode: 'Markdown' });
          }
        } else {
          await send(chatId, `${label} — *guión listo*\n\n${ig}`, { parse_mode: 'Markdown' });
        }
      } else {
        console.error('[ceo-commands/post] genInstagram retornó null');
        await send(chatId, '❌ Error generando el contenido de Instagram. Intentá de nuevo.');
      }
    }
  } catch (err) {
    console.error('[ceo-commands/post] Error inesperado:', err);
    await send(chatId, `❌ Error inesperado: ${err.message}`);
  }
}

// ── /tweet ───────────────────────────────────────────────────────────────────
export async function handleTweet(chatId, rawText, send) {
  await send(chatId, rawText ? '_✍️ Puliendo tu tweet con Claude..._' : '_🤖 Generando tweet de la semana..._');

  try {
    const res = await fetch('https://gettreevu.com/api/twitter-agent', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CRON_SECRET}` },
      body:    JSON.stringify({ action: 'draft', text: rawText || '' }),
    });
    const data = await res.json();
    if (!res.ok || !data.draft) { await send(chatId, `❌ No pude generar el draft: ${data.error || 'error desconocido'}`); return; }

    const key = `tw:draft:${chatId}:${Date.now()}`;
    await redisCmd('SET', key, data.draft, 'EX', 300);

    await send(chatId,
      `📝 *Draft del tweet* (${data.chars}/280)\n\n_${data.draft}_\n\n¿Lo publicamos?`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
        { text: '✅ Publicar', callback_data: `tw_ok:${key}` },
        { text: '❌ Cancelar', callback_data: 'tw_cancel' },
      ]] } }
    );
  } catch (err) {
    await send(chatId, `❌ Twitter Agent: ${err.message}`);
  }
}

// ── /enrich ───────────────────────────────────────────────────────────────────
export async function handleEnrich(chatId, send) {
  await send(chatId, '_📬 Iniciando Apollo Enricher — buscando emails para leads SDR..._');
  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 58000);

  try {
    const res = await fetch('https://gettreevu.com/api/apollo-enricher', {
      method:  'POST',
      signal:  controller.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CRON_SECRET}` },
      body:    JSON.stringify({ max_leads: 20, notify: false }),
    });

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); }
    catch { await send(chatId, `❌ Apollo Enricher devolvió error ${res.status}.`); return; }

    if (!res.ok) { await send(chatId, `❌ Apollo Enricher error ${res.status}: ${data.error || text.slice(0, 100)}`); return; }
    if (data.message) { await send(chatId, `📬 ${data.message}`); return; }

    let msg = `📬 *Apollo Enricher terminado*\n\n✅ *${data.enriched} leads* con email verificado\n⏭ ${data.skipped} sin match\n`;
    if (data.errors > 0) msg += `❌ ${data.errors} errores\n`;
    if (data.leads?.length) {
      msg += '\n*Emails obtenidos:*\n';
      data.leads.slice(0, 8).forEach(l => {
        msg += `• *${l.company || '—'}* — ${l.name}\n  📧 ${l.email}`;
        if (l.phone && l.phone !== '—') msg += ` · 📞 ${l.phone}`;
        msg += '\n';
      });
      if (data.enriched > 8) msg += `_...y ${data.enriched - 8} más_\n`;
      msg += `\nYa podés contactarlos desde Notion.`;
    } else {
      msg += `\n_Sin matches esta vez._`;
    }
    await send(chatId, msg, { parse_mode: 'Markdown' });
  } catch (err) {
    if (err.name === 'AbortError') await send(chatId, `⏱ Apollo Enricher tardó más de 58s. Revisá Notion en 1 minuto.`);
    else                           await send(chatId, `❌ Apollo Enricher: ${err.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

// ── /cierre ──────────────────────────────────────────────────────────────────
export async function handleCierre(chatId, empresa, send) {
  if (!empresa) {
    await send(chatId, 'Uso: `/cierre <empresa>`\n_Ej: /cierre Alicorp_', { parse_mode: 'Markdown' });
    return;
  }

  await send(chatId, `_🎯 Generando mensaje de cierre para ${empresa}..._`);

  let crmData = null;
  try {
    const res = await notionQuery(NOTION.CRM_DB, { property: 'Empresa', rich_text: { contains: empresa } }, 1);
    if (res.results?.length) {
      const p = res.results[0];
      crmData = {
        sector:        getProp(p, 'Sector')        || '—',
        colaboradores: getProp(p, 'Colaboradores') || '—',
        dolor:         getProp(p, 'Notas')         || '—',
      };
    }
  } catch { /* continue */ }

  const intel = crmData ? getSectorIntel(crmData.sector, crmData.colaboradores) : getSectorIntel('—', '100');

  const system = CIERRE_VENTAS;

  const user = `Empresa: ${empresa}
${crmData ? `Sector: ${crmData.sector} | Colaboradores: ${crmData.colaboradores} | Dolor registrado: ${crmData.dolor}` : ''}
Objeción probable del sector: ${intel.objecion}
Respuesta sugerida: ${intel.respuesta}
ROI: evitar ~${intel.renuncias} renuncias/año = S/ ${intel.ahorroEstimado} ahorrados

Genera 2 versiones del mensaje de cierre:

*Versión WhatsApp* (60 palabras máx, directo, listo para copiar):
[mensaje]

*Versión Email* (100 palabras máx, más formal):
Asunto: [asunto]
[cuerpo con propuesta de valor específica del sector, ROI concreto y CTA con fecha tentativa]`;

  const msg = await askClaude(user, { system, maxTokens: 500 });
  if (!msg) { await send(chatId, '❌ No pude generar el mensaje. Intentá de nuevo.'); return; }
  await send(chatId, msg, { parse_mode: 'Markdown' });
}

// ── /objecion ────────────────────────────────────────────────────────────────
export async function handleObjecion(chatId, texto, send) {
  if (!texto) {
    await send(chatId, 'Uso: `/objecion <texto de la objeción>`\n_Ej: /objecion ya tenemos bonos de permanencia_', { parse_mode: 'Markdown' });
    return;
  }

  await send(chatId, '_🧠 Analizando objeción..._');

  const system = OBJECION_RESPUESTA;

  const user = `Objeción del prospecto: "${texto}"

Genera 3 respuestas distintas:

*Respuesta 1 — Redirigir* (reencuadra la objeción como confirmación del problema):
[respuesta]

*Respuesta 2 — Datos* (para perfiles analíticos, con número concreto):
[respuesta]

*Respuesta 3 — Pregunta* (mantiene el diálogo, expone el dolor):
[respuesta]`;

  const resp = await askClaude(user, { system, maxTokens: 450 });
  if (!resp) { await send(chatId, '❌ No pude procesar la objeción. Intentá de nuevo.'); return; }
  await send(chatId, resp, { parse_mode: 'Markdown' });
}

// ── /demo ────────────────────────────────────────────────────────────────────
export async function handleDemo(chatId, empresa, send) {
  if (!empresa) {
    await send(chatId, 'Uso: `/demo <empresa>`\n_Ej: /demo Alicorp_', { parse_mode: 'Markdown' });
    return;
  }

  await send(chatId, `_🎬 Generando script de demo para ${empresa}..._`);

  let crmData = null;
  try {
    const res = await notionQuery(NOTION.CRM_DB, { property: 'Empresa', rich_text: { contains: empresa } }, 1);
    if (res.results?.length) {
      const p = res.results[0];
      crmData = {
        sector:        getProp(p, 'Sector')        || '—',
        colaboradores: getProp(p, 'Colaboradores') || '—',
        dolor:         getProp(p, 'Notas')         || '—',
        contacto:      getProp(p, 'Decisor')       || getProp(p, 'Contacto') || '—',
      };
    }
  } catch { /* continue */ }

  const intel = crmData ? getSectorIntel(crmData.sector, crmData.colaboradores) : getSectorIntel('—', '100');

  const system = DEMO_SCRIPT;

  const user = `Empresa: ${empresa}
${crmData ? `Sector: ${crmData.sector} | Colaboradores: ${crmData.colaboradores} | Decisor: ${crmData.contacto} | Dolor: ${crmData.dolor}` : ''}
Tip del sector: ${intel.tip}
Perfil decisor típico: ${intel.perfil_decisor}

Script de demo:

*🎯 Apertura (2 min)*
[cómo abrir según sector y dolor específico]

*📊 Qué mostrar primero (en orden)*
1. [feature + por qué le importa a este cliente]
2. [feature + por qué le importa a este cliente]
3. [feature + por qué le importa a este cliente]

*💬 Preguntas durante la demo*
• [pregunta que descubre más dolor]
• [pregunta que involucra al decisor técnico si aplica]
• [pregunta que acelera la decisión]

*🔑 KPIs a mencionar*
[datos del sector con mayor impacto]

*⚡ Cierre de la demo*
[cómo cerrar con siguiente paso concreto y fecha]`;

  const script = await askClaude(user, { system, maxTokens: 600 });
  if (!script) { await send(chatId, '❌ No pude generar el script. Intentá de nuevo.'); return; }
  await send(chatId, script, { parse_mode: 'Markdown' });
}

// ── /roi ──────────────────────────────────────────────────────────────────────
export async function handleROI(chatId, empresa, send) {
  if (!empresa) {
    await send(chatId, 'Uso: `/roi <empresa>`\n_Ej: /roi Alicorp_', { parse_mode: 'Markdown' });
    return;
  }

  await send(chatId, `_💰 Calculando ROI para ${empresa}..._`);

  let crmData = null;
  try {
    const res = await notionQuery(NOTION.CRM_DB, { property: 'Empresa', rich_text: { contains: empresa } }, 1);
    if (res.results?.length) {
      const p = res.results[0];
      crmData = {
        sector:        getProp(p, 'Sector')        || '—',
        colaboradores: getProp(p, 'Colaboradores') || '—',
      };
    }
  } catch { /* continue */ }

  const sector      = crmData?.sector        || '—';
  const colabs      = crmData?.colaboradores || '100';
  const intel       = getSectorIntel(sector, colabs);
  const numColabs   = parseInt((colabs || '').split('-')[0]) || 100;
  const activosEst  = Math.round(numColabs * 0.30);
  const costoMes    = activosEst * 7;
  const costoAnual  = costoMes * 12;
  const ahorroAnual = intel.renuncias * 8000;
  const roi         = costoAnual > 0 ? Math.round((ahorroAnual - costoAnual) / costoAnual * 100) : 0;

  const system = ROI_CALCULO;

  const user = `Empresa: ${empresa} | Sector: ${sector} | Colaboradores: ${colabs}
Rotación del sector: ${intel.rotacion}

Cálculo:
- Activos estimados (30% adopción): ${activosEst}
- Costo Treevü: S/ ${costoMes.toLocaleString('es-PE')}/mes → S/ ${costoAnual.toLocaleString('es-PE')}/año
- Renuncias evitables (25%): ${intel.renuncias}/año × S/ 8,000 = S/ ${ahorroAnual.toLocaleString('es-PE')} ahorro
- ROI: ${roi}%

Redactá el mensaje listo para mandar al CFO (máx 150 palabras, tono ejecutivo):

*💰 ROI Treevü para ${empresa}*

*Inversión:*
[desglose del costo]

*Retorno:*
[desglose del ahorro]

*Resultado:*
[ahorro neto + ROI + payback period]

*Supuestos:*
[3 bullets transparentes]`;

  const roi_msg = await askClaude(user, { system, maxTokens: 400 });
  if (!roi_msg) { await send(chatId, '❌ No pude calcular el ROI. Intentá de nuevo.'); return; }
  await send(chatId, roi_msg, { parse_mode: 'Markdown' });
}

// ── Q&A libre ─────────────────────────────────────────────────────────────────
export async function handleQA(chatId, pregunta, send) {
  await send(chatId, '_Consultando pipeline..._');

  let contexto = '';
  try {
    const res   = await notionQuery(NOTION.CRM_DB, {
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
      return `- ${empresa} | ${estado} | Score: ${score} | Sector: ${sector} | Colabs: ${colabs} | Última actividad: hace ${dias}d${notas ? ` | Notas: ${notas.slice(0, 80)}` : ''}`;
    }).join('\n');
  } catch (err) {
    console.error('[ceo-commands/qa] Notion error:', err.message);
    contexto = '(no se pudo obtener el pipeline)';
  }

  const system = QA_PIPELINE(contexto);

  const respuesta = await askClaude(pregunta, { system, maxTokens: 400 });
  await send(chatId, respuesta || '❌ No pude procesar tu pregunta. Intentá de nuevo.');
}
