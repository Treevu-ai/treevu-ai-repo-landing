/**
 * api/sdr-agent.js — Agente SDR de Treevu
 *
 * Busca prospectos en LinkedIn vía Tavily → deduplica contra Notion CRM + Redis
 * → genera mensaje personalizado con Claude (estrategia configurable) → guarda en Notion → notifica al CEO.
 *
 * POST /api/sdr-agent
 * Headers: Authorization: Bearer CRON_SECRET
 * Body: {
 *   keywords?:   string,   // "gerente RRHH" (default: rota entre roles)
 *   location?:   string,   // "Lima, Peru" (default)
 *   industry?:   string,   // "retail" | "manufactura" | "salud" | etc.
 *   size?:       string,   // "201,500" | "501,1000" | "1001,5000" (Apollo format)
 *   max_leads?:  number,   // cuántos leads añadir (default: 10)
 *   notify?:     boolean,  // enviar resumen a Telegram (default: true)
 *   strategy?:   string,   // "intro" | "seguimiento" | "caso_exito" | "urgencia" (default: "intro")
 * }
 */

import { NOTION, SECTOR_MAP }                          from './lib/constants.js';
import { notionCreate, notionQuery, getProp }           from './lib/notion.js';
import { sendMessage }                                  from './lib/telegram.js';
import { askClaude }                                    from './lib/anthropic.js';
import { redisCmd }                                     from './lib/redis.js';

const TAVILY_KEY     = process.env.TAVILY_API_KEY;
const CRON_SECRET    = process.env.CRON_SECRET;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CEO_CHAT_ID    = process.env.TELEGRAM_CHAT_ID;

// ── Timeout helper ────────────────────────────────────────────────────────────

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timeout:${label} (${ms}ms)`)), ms)
    ),
  ]);
}

// ── Estrategias de outreach ────────────────────────────────────────────────────

const STRATEGIES = {
  intro: {
    label: 'Primera conexión',
    instruction: `Redacta un primer contacto natural y directo. Menciona un dolor concreto del sector (rotación, retención). Termina con una pregunta abierta de una línea para iniciar conversación.`,
  },
  seguimiento: {
    label: 'Seguimiento suave',
    instruction: `Este es un segundo contacto. No insistas en lo anterior. Ofrece una perspectiva nueva: un dato del sector o una pregunta diferente. Cambia completamente el ángulo del primer mensaje.`,
  },
  caso_exito: {
    label: 'Caso de éxito',
    instruction: `Abre con un resultado concreto y creíble: "Una empresa de tu sector redujo rotación 30% en 3 meses con Treevü sin costo para la empresa." Propón una llamada de 15 minutos para compartir cómo lo lograron.`,
  },
  urgencia: {
    label: 'Cupos fundadores',
    instruction: `Menciona que quedan pocos cupos del Programa Fundadores (fee congelado de por vida, ~40% vs precio lista). Genera urgencia sin sonar desesperado. Un solo llamado a acción claro.`,
  },
};

// ── Búsqueda de prospectos vía Tavily ─────────────────────────────────────────

const INDUSTRY_KEYWORDS = {
  retail:       'retail tienda supermercado consumo masivo',
  manufactura:  'manufactura planta producción industrial',
  salud:        'clínica hospital salud médico',
  tecnologia:   'tecnología software IT sistemas',
  construccion: 'construcción minería inmobiliaria',
  educacion:    'educación colegio universidad instituto',
  banca:        'banco financiera seguro finanzas',
  servicios:    'servicios outsourcing BPO call center',
};

const ROLE_QUERIES = [
  'gerente recursos humanos',
  'director recursos humanos',
  'gerente de personas',
  'jefe de personal',
  'gerente general',
];

async function searchLinkedIn({ keywords, location, industry }) {
  if (!TAVILY_KEY) throw new Error('TAVILY_API_KEY no configurada');

  const loc   = (location || 'Lima Peru').replace(/,/g, '');
  const indKw = INDUSTRY_KEYWORDS[industry] || industry || '';

  const roles = keywords
    ? [keywords]
    : [...ROLE_QUERIES].sort(() => Math.random() - 0.5).slice(0, 3);

  for (const roleKw of roles) {
    const query = `site:linkedin.com/in ${roleKw} ${loc} ${indKw}`.trim();

    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 8000);

    try {
      const res = await fetch('https://api.tavily.com/search', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        signal:  controller.signal,
        body: JSON.stringify({
          api_key:        TAVILY_KEY,
          query,
          search_depth:   'basic',
          max_results:    20,
          include_answer: false,
        }),
      });

      if (!res.ok) throw new Error(`Tavily ${res.status}`);
      const data    = await res.json();
      const results = parseLinkedInResults(data.results || []);
      if (results.length > 0) return results;
    } catch (e) {
      if (e.name === 'AbortError') console.warn(`[sdr-agent] Tavily timeout (${roleKw})`);
      else throw e;
    } finally {
      clearTimeout(timeout);
    }
  }

  return [];
}

function parseLinkedInResults(results) {
  const people = [];
  for (const r of results) {
    if (!r.url?.includes('linkedin.com/in/')) continue;

    const cleanTitle = (r.title || '')
      .replace(/\s*[|\-]\s*LinkedIn\s*$/i, '')
      .trim();

    const atMatch = cleanTitle.match(/^(.+?)\s*-\s*(.+?)\s+(?:en|at)\s+(.+)$/i);
    let name, role, company;

    if (atMatch) {
      name    = atMatch[1].trim();
      role    = atMatch[2].trim();
      company = atMatch[3].trim();
    } else {
      const parts = cleanTitle.split(/\s*-\s*/);
      name    = parts[0]?.trim() || '';
      role    = parts[1]?.trim() || '';
      company = parts.length >= 3 ? parts.slice(2).join(' ').trim() : '';
    }

    if (!name) continue;

    const INVALID_COMPANIES = ['linkedin', ''];
    if (!company || INVALID_COMPANIES.includes(company.toLowerCase())) {
      const snippetMatch = (r.content || '').match(/\ben\s+([A-ZÁÉÍÓÚÑ][^\n,\.·|]{3,40})/i);
      company = snippetMatch?.[1]?.trim() || '';
    }

    const otherCountry = /\/(mx|co|ar|br|cl|ec|ve|bo|uy|py)\.linkedin\.com/i.test(r.url);
    if (otherCountry) continue;

    people.push({
      name,
      role,
      company,
      email:       '',
      linkedinUrl: r.url,
      industry:    '',
      snippet:     (r.content || '').slice(0, 300),
    });
  }
  return people;
}

// ── Deduplicación ─────────────────────────────────────────────────────────────

// Redis: marca una URL como procesada por 30 días para evitar re-procesar en runs futuros
const SEEN_TTL = 60 * 60 * 24 * 30; // 30 días

function urlKey(url) {
  // Clave corta y segura basada en la parte final de la URL de LinkedIn
  const slug = url.replace(/https?:\/\/[^/]+\/in\//i, '').replace(/[^a-z0-9-]/gi, '').slice(0, 40);
  return `sdr:seen:${slug}`;
}

async function isUrlSeen(url) {
  try {
    const result = await withTimeout(redisCmd('EXISTS', urlKey(url)), 3000, 'redis:exists');
    return result === 1;
  } catch {
    return false; // Si Redis falla, no bloquear el run
  }
}

async function markUrlSeen(url) {
  try {
    await withTimeout(redisCmd('SET', urlKey(url), '1', 'EX', SEEN_TTL), 3000, 'redis:set');
  } catch {
    // No crítico
  }
}

async function fetchExistingCompanies() {
  try {
    const r = await withTimeout(
      notionQuery(NOTION.CRM_DB, null, 100, [{ timestamp: 'created_time', direction: 'descending' }]),
      8000,
      'notion:fetchCompanies'
    );
    const companies = new Set();
    for (const page of r.results || []) {
      const emp = page.properties?.['Empresa']?.rich_text?.[0]?.plain_text?.toLowerCase().trim();
      if (emp && emp.length > 3) companies.add(emp);
    }
    return companies;
  } catch {
    return new Set();
  }
}

function isCompanyDup(company, existingSet) {
  if (!company || company.length <= 3) return false;
  const cLow = company.toLowerCase().trim();
  for (const existing of existingSet) {
    if (existing.includes(cLow) || cLow.includes(existing)) return true;
  }
  return false;
}

// ── Generar mensaje personalizado con Claude ──────────────────────────────────

async function generateOutreach(lead, strategy = 'intro') {
  const { name, role, company, industry, snippet } = lead;
  const firstName   = (name || 'equipo').split(/[\s,]+/)[0];
  const strat       = STRATEGIES[strategy] || STRATEGIES.intro;

  const system =
    `Eres el equipo de ventas de Treevü (Perú). Redactas mensajes de outreach en LinkedIn.\n` +
    `Producto: plataforma que permite a los colaboradores acceder a su propio salario antes del día de pago — S/ 0 costo para ellos, cero riesgo para la empresa.\n` +
    `Dos ángulos según el rol del prospecto: si es CFO/Finanzas → "predice la caja 30 días antes, reduce la reserva hasta 45%"; si es RRHH/CEO → "renuncias por estrés financiero −40%, alertas de rotación 3 semanas antes".\n\n` +
    `Estrategia activa (${strat.label}): ${strat.instruction}\n\n` +
    `Reglas de formato (siempre):\n` +
    `- Máximo 4 líneas en total\n` +
    `- Tono directo y humano, no corporativo\n` +
    `- Sin emojis ni saludos formales como "Estimado"\n` +
    `- Español peruano natural\n` +
    `- No repitas información obvia del perfil\n` +
    `- Responde SOLO con el mensaje, sin etiquetas ni explicaciones`;

  const userPrompt =
    `Prospecto: ${firstName}, ${role || 'líder'} de ${company || 'la empresa'}\n` +
    `Industria: ${industry || 'empresa peruana'}\n` +
    `Info del perfil: ${snippet || 'no disponible'}`;

  const msg = await withTimeout(
    askClaude(userPrompt, { system, maxTokens: 120 }),
    10000,
    'claude:outreach'
  ).catch(() => null);

  if (msg) return msg;

  // Fallback por estrategia si Claude falla
  const fallbacks = {
    intro:       `Hola ${firstName}, en Treevü ayudamos a empresas a predecir su caja de nómina y bajar la rotación — sin costo para la empresa ni para los colaboradores. ¿Tiene sentido conversar 15 minutos?`,
    seguimiento: `${firstName}, un dato que puede interesarle: empresas similares a ${company || 'la suya'} redujeron su reserva de caja en ~45% y las renuncias bajaron 30% con el mismo programa. ¿15 minutos para contarle cómo?`,
    caso_exito:  `${firstName}, una empresa del sector redujo renuncias 30% en 3 meses y optimizó su flujo de caja — sin costo adicional. ¿15 minutos para contarle cómo lo lograron?`,
    urgencia:    `${firstName}, quedan pocos cupos del Programa Pioneros de Treevü — fee congelado de por vida. ¿Vale la pena revisarlo antes de que cierren?`,
  };
  return fallbacks[strategy] || fallbacks.intro;
}

// ── Guardar en Notion CRM ─────────────────────────────────────────────────────

async function saveToNotion(lead, mensaje) {
  const { name, role, email, company, industry, employees, linkedinUrl } = lead;
  const nombreCargo = role ? `${name}, ${role}` : (name || 'Contacto SDR');

  const sectorNorm = industry
    ? Object.entries(SECTOR_MAP).find(([, v]) => v.toLowerCase().includes((industry || '').toLowerCase()))?.[1] || industry
    : null;

  const sizeMap = {
    '1,10': '5-50', '11,20': '5-50', '21,50': '5-50',
    '51,200': '50-200', '201,500': '200-500', '501,1000': '500-1000',
    '1001,5000': '1000-5000', '5001,10000': '5000+',
  };
  const colabsNorm = employees ? (sizeMap[employees] || employees) : null;

  const notas = [mensaje, linkedinUrl ? `LinkedIn: ${linkedinUrl}` : ''].filter(Boolean).join('\n');

  const properties = {
    'Nombre y Cargo': { title:     [{ text: { content: nombreCargo.slice(0, 100) } }] },
    'Email':          { email:     email || null },
    'Empresa':        { rich_text: [{ text: { content: (company || '').slice(0, 100) } }] },
    'Score':          { select:    { name: 'MEDIO' } },
    'Estado':         { select:    { name: 'Nuevo' } },
    'Fuente':         { select:    { name: 'SDR Agent' } },
    'Notas':          { rich_text: [{ text: { content: notas.slice(0, 2000) } }] },
  };

  if (sectorNorm)  properties['Sector']        = { select: { name: sectorNorm } };
  if (colabsNorm)  properties['Colaboradores'] = { select: { name: colabsNorm } };

  return withTimeout(notionCreate(NOTION.CRM_DB, properties), 10000, 'notion:create');
}

// ── Handler principal ─────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = req.headers.authorization || '';
  if (!auth.includes(CRON_SECRET)) return res.status(401).json({ error: 'Unauthorized' });

  const {
    keywords,
    location  = 'Lima, Peru',
    industry,
    size      = '201,500',
    max_leads = 10,
    notify    = true,
    strategy  = 'intro',
  } = req.body || {};

  if (!STRATEGIES[strategy]) {
    return res.status(400).json({ error: `strategy inválida. Usa: ${Object.keys(STRATEGIES).join(' | ')}` });
  }

  const startTime  = Date.now();
  const added      = [];
  const skipped    = [];
  const errors     = [];
  const debug_log  = [`strategy: ${strategy} (${STRATEGIES[strategy].label})`];

  try {
    debug_log.push(`TAVILY_KEY: ${TAVILY_KEY ? TAVILY_KEY.slice(0, 12) + '...' : 'MISSING'}`);

    // 1. Buscar y cargar CRM en paralelo con timeout global de 15s
    const [people, existingCompanies] = await withTimeout(
      Promise.all([
        searchLinkedIn({ keywords, location, industry }),
        fetchExistingCompanies(),
      ]),
      15000,
      'init:search+crm'
    );

    debug_log.push(`profiles_found: ${people.length}`);
    people.slice(0, 3).forEach(p => debug_log.push(`  ${p.name} | ${p.company || '(no company)'}`));

    if (!people.length) {
      return res.status(200).json({ message: 'No se encontraron prospectos.', added: 0, skipped: 0, debug: debug_log });
    }

    // 2. Dedup: chequear URLs en Redis en paralelo (no secuencial)
    const urlSeenResults = await Promise.all(
      people.slice(0, max_leads * 3).map(p =>
        p.linkedinUrl ? isUrlSeen(p.linkedinUrl) : Promise.resolve(false)
      )
    );

    const addedCompanies = new Set();
    const candidates     = [];

    for (let i = 0; i < Math.min(people.length, max_leads * 3); i++) {
      if (candidates.length >= max_leads) break;

      const { name = '', role = '', email = '', company = '', linkedinUrl = '' } = people[i];

      if (!name && !company) {
        skipped.push({ reason: 'sin datos', name, company }); continue;
      }
      if (urlSeenResults[i]) {
        skipped.push({ company, name, reason: 'ya procesado (Redis)' }); continue;
      }
      if (isCompanyDup(company, existingCompanies)) {
        skipped.push({ company, name, reason: 'ya en CRM' }); continue;
      }
      const companyKey = company.toLowerCase().trim();
      if (companyKey && addedCompanies.has(companyKey)) {
        skipped.push({ company, name, reason: 'duplicado en run' }); continue;
      }

      if (companyKey) addedCompanies.add(companyKey);
      candidates.push({ name, role, email, company, employees: size, linkedinUrl, orgIndustry: people[i].industry || industry || '', snippet: people[i].snippet || '' });
    }

    debug_log.push(`candidates_after_dedup: ${candidates.length}`);

    // 3. Procesar candidatos en PARALELO — Claude + Notion simultáneos
    await Promise.allSettled(candidates.map(async (c) => {
      try {
        const mensaje = await generateOutreach(
          { name: c.name, role: c.role, company: c.company, industry: c.orgIndustry, snippet: c.snippet },
          strategy
        );

        await saveToNotion(
          { name: c.name, role: c.role, email: c.email, company: c.company, industry: c.orgIndustry, employees: c.employees, linkedinUrl: c.linkedinUrl },
          mensaje
        );

        if (c.linkedinUrl) markUrlSeen(c.linkedinUrl); // fire-and-forget, no bloquea

        added.push({ name: c.name, company: c.company, role: c.role, linkedin: c.linkedinUrl ? '✓' : '—' });
        console.log(`[sdr-agent] ✓ ${c.company} — ${c.name} (${strategy})`);
      } catch (err) {
        errors.push({ company: c.company, error: err.message });
        console.error(`[sdr-agent] ✗ ${c.company}:`, err.message);
      }
    }));

  } catch (err) {
    console.error('[sdr-agent] error:', err.message);
    // Responder con lo que se pudo procesar, no cortar todo
    if (added.length === 0 && errors.length === 0) {
      return res.status(500).json({ error: err.message, debug: debug_log });
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  // 4. Notificar al CEO
  if (notify && TELEGRAM_TOKEN && CEO_CHAT_ID && added.length > 0) {
    const stratLabel  = STRATEGIES[strategy].label;
    const industryLabel = industry || 'general';
    let msg = `🎯 *SDR Agent — ${stratLabel}*\n`;
    msg += `_${industryLabel} · ${location} · ${size} emp_\n\n`;
    msg += `✅ *${added.length} leads añadidos*\n`;
    msg += `⏭ ${skipped.length} omitidos · ❌ ${errors.length} errores\n\n`;

    added.slice(0, 8).forEach(l => {
      msg += `• *${l.company}* — ${l.role || '—'}\n`;
    });
    if (added.length > 8) msg += `_...y ${added.length - 8} más_\n`;

    msg += `\n⏱ ${duration}s · Revisá en Notion → CRM`;

    sendMessage(TELEGRAM_TOKEN, CEO_CHAT_ID, msg, { parse_mode: 'Markdown' }).catch(() => {});
  }

  return res.status(200).json({
    strategy,
    added:          added.length,
    skipped:        skipped.length,
    errors:         errors.length,
    leads:          added,
    skipped_detail: skipped.slice(0, 5),
    debug:          debug_log,
    duration_s:     parseFloat(duration),
  });
}

// Vercel: 60s para permitir Tavily + Claude (x10) + Notion (x10)
export const config = { maxDuration: 60 };
