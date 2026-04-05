// api/lib/ceo-commands.js
// Handlers de comandos del panel CEO:
//   handleHelp, handlePipeline, handleFollowup
//   handleSDR, handleBriefing, handlePost, handleTweet, handleEnrich, handleQA

import { notionQuery, getProp } from './notion.js';
import { askClaude }            from './anthropic.js';
import { redisCmd }             from './redis.js';
import { postLinkedIn }         from './linkedin.js';
import { postInstagram }        from './instagram.js';
import { searchPhoto, buildPhotoQuery } from './pexels.js';
import { scrapeCompany }        from './firecrawl.js';
import { NOTION }               from './constants.js';

const CRON_SECRET = process.env.CRON_SECRET;

// ── /help ────────────────────────────────────────────────────────────────────
export async function handleHelp(chatId, send) {
  await send(chatId,
    `*Panel de Control Treevü* 🎛️\n\n` +
    `*Comandos:*\n` +
    `📊 /pipeline — resumen del CRM por etapa\n` +
    `🔔 /followup — leads sin actividad +7 días\n` +
    `🎯 /sdr [industria] [tamaño] — busca prospectos en LinkedIn\n` +
    `   _Ej: /sdr retail 200+ · /sdr manufactura 500+_\n` +
    `📬 /enrich — enriquece leads SDR con email y teléfono (Apollo)\n` +
    `🐦 /tweet [texto] — genera o pule un tweet y pide confirmación antes de publicar\n` +
    `📲 /post [linkedin|instagram] — genera contenido listo para copiar (algoritmo-aware)\n` +
    `   _/post → ambos · /post linkedin → solo LI · /post instagram → solo IG_\n` +
    `🔍 /briefing <empresa o URL> — inteligencia pre-reunión (Firecrawl + Claude)\n` +
    `   _Ej: /briefing Alicorp · /briefing https://alicorp.com.pe_\n` +
    `🧠 /cto <pregunta> — CTO Virtual: Piloto vs API, tiempos, arquitectura\n` +
    `   _Ej: /cto ¿cuánto tarda la integración con Buk?_\n` +
    `   _/cto reset — limpia el contexto de conversación_\n` +
    `❓ /help — este menú\n\n` +
    `*Modo Q&A:*\nEscribí cualquier pregunta sobre el pipeline y te respondo con contexto real del CRM.\n\n` +
    `_Ej: "¿qué leads están calientes?" · "¿cuántos deals tengo en propuesta?"_`,
    { parse_mode: 'Markdown' }
  );
}

// ── /pipeline ─────────────────────────────────────────────────────────────────
export async function handlePipeline(chatId, send) {
  await send(chatId, '_Consultando pipeline en Notion..._');

  const ESTADO_EMOJI = { Nuevo: '🔵', Contactado: '🟡', Reunion: '🟠', Propuesta: '🔴', Cerrado: '✅' };
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
    items.slice(0, 3).forEach(p => {
      const empresa    = getProp(p, 'Empresa') || getProp(p, 'Name') || '—';
      const score      = getProp(p, 'Score')   || '';
      const scoreEmoji = score === 'ALTO' ? '🔥' : score === 'MEDIO' ? '🟡' : '';
      msg += `   ${scoreEmoji} ${empresa}\n`;
    });
    if (items.length > 3) msg += `   _...y ${items.length - 3} más_\n`;
    msg += '\n';
  }

  for (const [estado, items] of Object.entries(grupos)) {
    if (!ordenEstados.includes(estado)) msg += `• *${estado}* (${items.length})\n`;
  }

  await send(chatId, msg, { parse_mode: 'Markdown' });
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
    const webCtx = isUrl
      ? await import('./firecrawl.js').then(m => m.scrapeUrl(input)).catch(() => null)
      : await scrapeCompany(input).catch(() => null);

    const hasWeb = webCtx && webCtx.length > 80;

    const system = `Eres el asistente estratégico del CEO de Treevü (EWA B2B para empresas peruanas).
Genera briefings de reunión concisos y accionables.
Usa Markdown Telegram (*negrita*, _itálica_) — sin ### ni encabezados markdown.`;

    const userPrompt = `El CEO va a reunirse con: ${input}
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
export async function handlePost(chatId, platform, send, edit) {
  const now     = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Lima' }));
  const weekNum = Math.floor((now - new Date(now.getFullYear(), 0, 1)) / (7 * 864e5));

  const TEMAS_LI = [
    'rotación de personal: el costo oculto que sangra a las empresas peruanas',
    'cómo el estrés financiero reduce la productividad de tus colaboradores',
    'EWA en Perú: qué es el acceso al salario devengado y por qué importa ahora',
    'employer branding: mejorar el bienestar financiero reduce rotación 15-40%',
    'el colaborador endeudado no rinde — datos y soluciones reales',
    'retener talento cuesta menos que reclutar — con números',
    'las finanzas personales de tus colaboradores son tu problema de negocio',
    'casos reales: empresas que redujeron rotación con beneficios financieros',
  ];
  const tema = TEMAS_LI[weekNum % TEMAS_LI.length];

  const genLinkedIn = () => askClaude(
    `Eres el equipo de contenido de Treevü, startup B2B de EWA en Perú.\n\nEscribe un post de LinkedIn sobre: "${tema}"\n\nREGLAS (obligatorias):\n- Primera línea = gancho. Dato concreto, pregunta incómoda o afirmación contrarian.\n- Salto de línea cada 1-2 oraciones.\n- Números reales: %, S/, días.\n- Ángulo insider: "lo que nadie dice sobre...", "lo aprendí con X empresas..."\n- Cierra con UNA pregunta abierta.\n- Sin links en el cuerpo. Sin hashtags genéricos. Máx 3 hashtags nicho.\n- 150-250 palabras. Tono experto pero humano.\n\nDevuelve SOLO el texto del post.`,
    { maxTokens: 400 }
  );

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

  await send(chatId, `_✍️ Generando contenido${doLinkedIn && doIG ? ' para LinkedIn e Instagram' : doLinkedIn ? ' para LinkedIn' : ' para Instagram'}..._`);

  if (doLinkedIn) {
    const li = await genLinkedIn().catch(() => null);
    if (li) {
      const key = `li:draft:${chatId}:${Date.now()}`;
      await redisCmd('SET', key, li, 'EX', 300);
      await send(chatId,
        `💼 *LinkedIn — draft listo*\n_Tema: ${tema}_\n\n${li}\n\n💡 _El link va en el primer comentario._`,
        { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
          { text: '✅ Publicar en LinkedIn', callback_data: `li_ok:${key}` },
          { text: '📋 Solo copiar',          callback_data: 'li_cancel' },
        ]] } }
      );
    }
  }

  if (doIG) {
    const ig = await genInstagram(igTipo).catch(() => null);
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
    }
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

  const system = `Eres el asesor de ventas del CEO de Treevü, startup EWA peruana B2B. El CEO te hace preguntas sobre su pipeline.
Responde de forma directa, concisa y accionable. Usa bullet points cuando ayude. Máximo 5 líneas.
Pipeline actual:
${contexto}`;

  const respuesta = await askClaude(pregunta, { system, maxTokens: 400 });
  await send(chatId, respuesta || '❌ No pude procesar tu pregunta. Intentá de nuevo.');
}
