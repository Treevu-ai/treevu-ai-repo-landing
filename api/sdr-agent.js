/**
 * api/sdr-agent.js — Agente SDR de Treevu
 *
 * Busca prospectos en Apollo → deduplica contra Notion CRM
 * → genera mensaje personalizado con Claude → carga a Notion → notifica al CEO.
 *
 * POST /api/sdr-agent
 * Headers: Authorization: Bearer CRON_SECRET
 * Body: {
 *   keywords?:   string,   // "gerente RRHH" (default: "gerente recursos humanos")
 *   location?:   string,   // "Lima, Peru" (default)
 *   industry?:   string,   // "retail" | "manufactura" | "salud" | etc.
 *   size?:       string,   // "201,500" | "501,1000" | "1001,5000" (Apollo format)
 *   max_leads?:  number,   // cuántos leads añadir (default: 10)
 *   notify?:     boolean,  // enviar resumen a Telegram (default: true)
 * }
 *
 * Trigger manual: curl -X POST https://gettreevu.com/api/sdr-agent \
 *   -H "Authorization: Bearer $CRON_SECRET" \
 *   -H "Content-Type: application/json" \
 *   -d '{"industry":"retail","size":"201,500"}'
 */

import { NOTION, SECTOR_MAP }                          from './lib/constants.js';
import { notionCreate, notionQuery, getProp }           from './lib/notion.js';
import { sendMessage }                                  from './lib/telegram.js';
import { askClaude }                                    from './lib/anthropic.js';
import { captureException }                             from './lib/sentry.js';

const TAVILY_KEY     = process.env.TAVILY_API_KEY;
const CRON_SECRET    = process.env.CRON_SECRET;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CEO_CHAT_ID    = process.env.TELEGRAM_CHAT_ID;

// ── Búsqueda de prospectos vía Tavily (LinkedIn + Google) ─────────────────────

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

async function searchLinkedIn({ keywords, location, industry, size }) {
  if (!TAVILY_KEY) throw new Error('TAVILY_API_KEY no configurada');

  const loc    = (location || 'Lima Peru').replace(/,/g, '');
  const indKw  = INDUSTRY_KEYWORDS[industry] || industry || '';

  // Intentar hasta 3 roles distintos hasta obtener resultados
  const roles = keywords
    ? [keywords]
    : [...ROLE_QUERIES].sort(() => Math.random() - 0.5).slice(0, 3);

  for (const roleKw of roles) {
    const query = `site:linkedin.com/in ${roleKw} ${loc} ${indKw}`.trim();

    const res = await fetch('https://api.tavily.com/search', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
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
  }

  return [];
}

function parseLinkedInResults(results) {
  const people = [];
  for (const r of results) {
    if (!r.url?.includes('linkedin.com/in/')) continue;

    // Limpiar el título: remover "| LinkedIn" y "- LinkedIn" del final
    const cleanTitle = (r.title || '')
      .replace(/\s*[|\-]\s*LinkedIn\s*$/i, '')
      .trim();

    // Formato: "Nombre - Cargo en Empresa" o "Nombre - Cargo - Empresa"
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

    // Si company es inválida, extraer del snippet
    const INVALID_COMPANIES = ['linkedin', ''];
    if (!company || INVALID_COMPANIES.includes(company.toLowerCase())) {
      // Buscar en snippet: "en NombreEmpresa" o "at NombreEmpresa"
      const snippetMatch = (r.content || '').match(/\ben\s+([A-ZÁÉÍÓÚÑ][^\n,\.·|]{3,40})/i);
      company = snippetMatch?.[1]?.trim() || '';
    }

    // Filtrar solo si claramente es otro país (ej. .mx. .co. .ar. .br.)
    const otherCountry = /\/(mx|co|ar|br|cl|ec|ve|bo|uy|py)\.linkedin\.com/i.test(r.url);
    if (otherCountry) continue;

    people.push({
      name,
      role,
      company,
      email:       '',
      linkedinUrl: r.url,
      industry:    '',
      employees:   '',
      snippet:     (r.content || '').slice(0, 300),
    });
  }
  return people;
}

// ── Deduplicación contra CRM ──────────────────────────────────────────────────

async function isAlreadyInCRM(email, company) {
  if (email) {
    try {
      const r = await notionQuery(NOTION.CRM_DB,
        { property: 'Email', email: { equals: email.toLowerCase().trim() } }, 1);
      if (r.results?.length) return true;
    } catch { /* continuar */ }
  }
  if (company && company.length > 3 && company.toLowerCase() !== 'linkedin') {
    try {
      const r = await notionQuery(NOTION.CRM_DB,
        { property: 'Empresa', rich_text: { contains: company.slice(0, 50) } }, 1);
      if (r.results?.length) return true;
    } catch { /* continuar */ }
  }
  return false;
}

// ── Generar mensaje personalizado con Claude ──────────────────────────────────

async function generateOutreach(lead) {
  const { name, role, company, industry, employees } = lead;
  const firstName = (name || 'equipo').split(/[\s,]+/)[0];

  const prompt = `Redacta un mensaje de primer contacto de LinkedIn para ${firstName}, ${role || 'líder'} de ${company || 'la empresa'}.

Contexto:
- Industria: ${industry || 'empresa peruana'}
- Tamaño: ${employees || 'mediana empresa'}
- Info adicional del perfil: ${lead.snippet || 'no disponible'}
- Tu propuesta: Treevü, plataforma EWA (Earned Wage Access) — permite a trabajadores retirar su salario ganado antes del día de pago. Cero costo para la empresa, reduce rotación 15-40%.

Reglas:
- Máximo 4 líneas
- Tono directo, no corporativo
- Menciona un dolor concreto del sector (rotación, retención de talento)
- Termina con una pregunta de 1 línea para abrir conversación
- NO uses emojis ni saludos formales como "Estimado"
- Escribe en español peruano natural`;

  const msg = await askClaude(prompt, { maxTokens: 200 });
  return msg || `Hola ${firstName}, vi que lideran el área de personas en ${company}. En Treevü ayudamos a empresas como la tuya a reducir rotación con acceso anticipado al salario — sin costo para la empresa. ¿Tiene sentido conversar 15 minutos?`;
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

  const notas = [
    mensaje,
    linkedinUrl ? `LinkedIn: ${linkedinUrl}` : '',
  ].filter(Boolean).join('\n');

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

  return notionCreate(NOTION.CRM_DB, properties);
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
  } = req.body || {};

  const startTime = Date.now();
  const added     = [];
  const skipped   = [];
  const errors    = [];
  const debug_log = [];

  try {
    // 1. Buscar en LinkedIn vía Tavily
    debug_log.push(`TAVILY_KEY: ${TAVILY_KEY ? TAVILY_KEY.slice(0,12)+'...' : 'MISSING'}`);
    const people = await searchLinkedIn({ keywords, location, industry, size });
    debug_log.push(`profiles_found: ${people.length}`);
    people.slice(0,3).forEach(p => debug_log.push(`  ${p.name} | ${p.company || '(no company)'}`));

    if (!people.length) {
      return res.status(200).json({ message: 'No se encontraron prospectos.', added: 0, skipped: 0, debug: debug_log });
    }

    // 2. Procesar cada prospecto
    for (const person of people) {
      if (added.length >= max_leads) break;

      const name        = person.name        || '';
      const role        = person.role        || '';
      const email       = person.email       || '';
      const company     = person.company     || '';
      const employees   = size;
      const linkedinUrl = person.linkedinUrl || '';
      const orgIndustry = person.industry    || industry || '';

      // Saltar si no tiene empresa o nombre
      if (!name && !company) { skipped.push({ reason: 'sin datos', name, company }); continue; }

      // Deduplicar
      const exists = await isAlreadyInCRM(email, company);
      if (exists) { skipped.push({ company, name, reason: 'ya en CRM' }); continue; }

      // Generar mensaje
      let mensaje = '';
      try {
        mensaje = await generateOutreach({ name, role, company, industry: orgIndustry, employees });
      } catch (err) {
        console.warn(`[sdr-agent] Claude error para ${company}:`, err.message);
        mensaje = `Hola ${name?.split(' ')[0] || 'equipo'}, ¿conversamos sobre bienestar financiero en ${company}?`;
      }

      // Guardar en Notion
      try {
        await saveToNotion({ name, role, email, company, industry: orgIndustry, employees, linkedinUrl }, mensaje);
        added.push({ name, company, role, email: email ? '✓' : '—', linkedin: linkedinUrl ? '✓' : '—' });
        console.log(`[sdr-agent] ✓ ${company} — ${name}`);
      } catch (err) {
        errors.push({ company, error: err.message });
        console.error(`[sdr-agent] Notion error ${company}:`, err.message);
      }

      // Pequeña pausa para no saturar Notion API
      await new Promise(r => setTimeout(r, 300));
    }

  } catch (err) {
    captureException(err, { tags: { handler: 'sdr-agent' } });
    console.error('[sdr-agent] error:', err.message);
    return res.status(500).json({ error: err.message });
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  // 3. Notificar al CEO
  if (notify && TELEGRAM_TOKEN && CEO_CHAT_ID && added.length > 0) {
    const industryLabel = industry || 'general';
    let msg = `🎯 *SDR Agent completado*\n`;
    msg += `_${industryLabel} · ${location} · ${size} empleados_\n\n`;
    msg += `✅ *${added.length} leads añadidos al CRM*\n`;
    msg += `⏭ ${skipped.length} omitidos (ya en CRM o sin datos)\n\n`;

    added.slice(0, 8).forEach(l => {
      msg += `• *${l.company}* — ${l.role || '—'}\n`;
    });
    if (added.length > 8) msg += `_...y ${added.length - 8} más_\n`;

    msg += `\n⏱ ${duration}s · Revisá en Notion → CRM (/pipeline)`;

    sendMessage(TELEGRAM_TOKEN, CEO_CHAT_ID, msg, { parse_mode: 'Markdown' }).catch(() => {});
  }

  return res.status(200).json({
    added:      added.length,
    skipped:    skipped.length,
    errors:     errors.length,
    leads:      added,
    skipped_detail: skipped.slice(0, 5),
    debug:      debug_log,
    duration_s: parseFloat(duration),
  });
}

// Convierte número de empleados a rango Apollo
function rangeEmployees(n) {
  if (n <= 50)   return '1,50';
  if (n <= 200)  return '51,200';
  if (n <= 500)  return '201,500';
  if (n <= 1000) return '501,1000';
  if (n <= 5000) return '1001,5000';
  return '5001,10000';
}
// Wed Apr  1 23:28:30 HPS 2026
