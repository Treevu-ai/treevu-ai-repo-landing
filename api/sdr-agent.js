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

const APOLLO_KEY     = process.env.APOLLO_API_KEY;
const CRON_SECRET    = process.env.CRON_SECRET;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CEO_CHAT_ID    = process.env.TELEGRAM_CHAT_ID;

// ── Apollo: búsqueda de personas ─────────────────────────────────────────────

const INDUSTRY_MAP = {
  retail:        'Retail',
  manufactura:   'Manufacturing',
  salud:         'Hospital & Health Care',
  tecnologia:    'Information Technology and Services',
  construccion:  'Construction',
  educacion:     'Education Management',
  banca:         'Banking',
  servicios:     'Staffing and Recruiting',
};

const ROLES_TARGET = [
  'Gerente de Recursos Humanos',
  'Director de Recursos Humanos',
  'Gerente de Personas',
  'Chief People Officer',
  'HR Manager',
  'Gerente General',
  'Director General',
  'CEO',
  'Gerente Administrativo',
  'Gerente de Operaciones',
];

async function searchApollo({ keywords, location, industry, size }) {
  const body = {
    api_key:              APOLLO_KEY,
    q_keywords:           keywords || 'gerente recursos humanos',
    person_locations:     [location || 'Lima, Peru'],
    contact_email_status: ['verified', 'guessed', 'unavailable', 'bounced', 'pending_manual_fulfillment'],
    per_page:             25,
    page:                 1,
  };

  if (industry && INDUSTRY_MAP[industry]) {
    body.organization_industry_tag_ids = [INDUSTRY_MAP[industry]];
  }

  if (size) {
    body.organization_num_employees_ranges = [size];
  }

  const res = await fetch('https://api.apollo.io/v1/mixed_people/search', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
    body:    JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Apollo ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.people || [];
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
  if (company) {
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

  try {
    // 1. Buscar en Apollo
    console.log(`[sdr-agent] Buscando: industry=${industry} size=${size} location=${location}`);
    const people = await searchApollo({ keywords, location, industry, size });
    console.log(`[sdr-agent] Apollo devolvió ${people.length} personas`);

    if (!people.length) {
      return res.status(200).json({ message: 'No se encontraron prospectos en Apollo', added: 0, skipped: 0 });
    }

    // 2. Procesar cada prospecto
    for (const person of people) {
      if (added.length >= max_leads) break;

      const name        = [person.first_name, person.last_name].filter(Boolean).join(' ');
      const role        = person.title || '';
      const email       = person.email || '';
      const company     = person.organization?.name || '';
      const employees   = person.organization?.num_employees
        ? rangeEmployees(person.organization.num_employees) : size;
      const linkedinUrl = person.linkedin_url || '';
      const orgIndustry = person.organization?.industry || industry || '';

      // Saltar si no tiene empresa o nombre
      if (!name && !company) { skipped.push({ reason: 'sin datos' }); continue; }

      // Deduplicar
      const exists = await isAlreadyInCRM(email, company);
      if (exists) { skipped.push({ company, reason: 'ya en CRM' }); continue; }

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
    added:   added.length,
    skipped: skipped.length,
    errors:  errors.length,
    leads:   added,
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
