// api/lib/constants.js — Fuente única de verdad para constantes de Treevu
//
// ── Registro de variables de entorno ─────────────────────────────────────────
// Fuente única de verdad. Todos los handlers deben leer desde CONFIG en lugar
// de acceder a process.env directamente. Facilita auditoría y renombrado.
export const CONFIG = {
  // Claude / OpenClaw
  OPENCLAW_TOKEN:         process.env.OPENCLAW_TOKEN,

  // Notion
  NOTION_API_KEY:         process.env.NOTION_API_KEY || process.env.NOTION_TOKEN,

  // Telegram — CEO personal
  TELEGRAM_CEO_BOT_TOKEN: process.env.TELEGRAM_CEO_BOT_TOKEN,
  TELEGRAM_CEO_CHAT_ID:   process.env.TELEGRAM_CEO_CHAT_ID,

  // Telegram — ABM team
  TELEGRAM_ABM_BOT_TOKEN: process.env.TELEGRAM_ABM_BOT_TOKEN,
  TELEGRAM_ABM_CHAT_ID:   process.env.TELEGRAM_ABM_CHAT_ID,

  // Telegram — VU público
  TELEGRAM_VU_BOT_TOKEN:  process.env.TELEGRAM_VU_BOT_TOKEN,   // @treevubot público

  // Variables antiguas (deprecated) - mantener por compatibilidad
  TELEGRAM_BOT_TOKEN:     process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID:       process.env.TELEGRAM_CHAT_ID,

  // Auth / secrets
  CRON_SECRET:            process.env.CRON_SECRET,
  LEAD_WEBHOOK_SECRET:    process.env.LEAD_WEBHOOK_SECRET,
  FATHOM_WEBHOOK_SECRET:  process.env.FATHOM_WEBHOOK_SECRET,
  CALENDLY_WEBHOOK_SECRET: process.env.CALENDLY_WEBHOOK_SECRET,

  // Redis (Upstash)
  UPSTASH_REDIS_REST_URL:   process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,

  // Gmail OAuth
  GMAIL_CLIENT_ID:       process.env.GMAIL_CLIENT_ID,
  GMAIL_CLIENT_SECRET:   process.env.GMAIL_CLIENT_SECRET,
  GMAIL_REFRESH_TOKEN:   process.env.GMAIL_REFRESH_TOKEN,
  GMAIL_FROM:            process.env.GMAIL_FROM || 'hello@gettreevu.com',

  // Calendly
  CALENDLY_TOKEN:        process.env.CALENDLY_TOKEN,

  // APIs externas
  APOLLO_API_KEY:        process.env.APOLLO_API_KEY,
  TAVILY_API_KEY:        process.env.TAVILY_API_KEY,
  FIRECRAWL_API_KEY:     process.env.FIRECRAWL_API_KEY,
  PEXELS_API_KEY:        process.env.PEXELS_API_KEY,
  PANDADOC_API_KEY:      process.env.PANDADOC_API_KEY,

  // LinkedIn
  LINKEDIN_ACCESS_TOKEN: process.env.LINKEDIN_ACCESS_TOKEN,
  LINKEDIN_AUTHOR_URN:   process.env.LINKEDIN_AUTHOR_URN,

  // Twitter / X
  TWITTER_API_KEY:              process.env.TWITTER_API_KEY,
  TWITTER_API_SECRET:           process.env.TWITTER_API_SECRET,
  TWITTER_ACCESS_TOKEN:         process.env.TWITTER_ACCESS_TOKEN,
  TWITTER_ACCESS_TOKEN_SECRET:  process.env.TWITTER_ACCESS_TOKEN_SECRET,

  // Instagram (n8n webhook)
  N8N_INSTAGRAM_WEBHOOK: process.env.N8N_INSTAGRAM_WEBHOOK,

  // WhatsApp service (Fly.io)
  WHATSAPP_SERVICE_URL:    process.env.WHATSAPP_SERVICE_URL,
  WHATSAPP_SERVICE_SECRET: process.env.WHATSAPP_SERVICE_SECRET,

  // Supabase
  SUPABASE_URL:         process.env.SUPABASE_URL,
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,

  // Sentry
  SENTRY_DSN:           process.env.SENTRY_DSN,

  // Misc
  NOTION_CTO_DOC_URL:   process.env.NOTION_CTO_DOC_URL,
  VERCEL_ENV:           process.env.VERCEL_ENV,
};

// ── Notion Database IDs ───────────────────────────────────────────────────────
export const NOTION = {
  TOKEN:         process.env.NOTION_API_KEY || process.env.NOTION_TOKEN,
  CRM_DB:        '2e5f06c0295b46fbbc212bac5f6fcb3c', // CRM unificado (inbound)
  EJECUCION_DB:  'bcebf14878f04db087f052722f9a084d', // Pipeline ABM 14 días
  LEGACY_DB:     '8a5cb4e6-16b9-4248-ac44-cab55c9ace6f', // solo submit.js legacy
};

// ── Programa Fundadores ───────────────────────────────────────────────────────
export const PROGRAMA = {
  CUPOS_TOTAL:  10,   // slots totales del programa Fundadores
  FECHA_CIERRE: '2026-04-30',
  BOOKING:      'https://calendar.app.google/Rxprk5tCDSDivwaA9',
};

// ── Lookup maps ───────────────────────────────────────────────────────────────
export const SECTOR_MAP = {
  retail:       'Retail y consumo',
  manufactura:  'Manufactura',
  servicios:    'Servicios',
  salud:        'Salud',
  tecnologia:   'Tecnologia',
  construccion: 'Construccion/Mineria',
  educacion:    'Educacion',
  banca:        'Banca y finanzas',
  otro:         'Otro',
};

export const OBJ_MAP = {
  'reducir-rotacion':     'Reducir rotacion',
  'mejorar-clima':        'Mejorar clima laboral',
  'optimizar-nomina':     'Optimizar nomina',
  'bienestar-financiero': 'Bienestar financiero',
  'atraccion-talento':    'Atraer talento',
  rotacion:               'Reducir rotacion',
  bienestar:              'Bienestar financiero',
  clima:                  'Mejorar clima laboral',
  nomina:                 'Optimizar nomina',
  talento:                'Atraer talento',
  otro:                   'Otro',
};

export const SCORE_EMOJI = { ALTO: '🔥', MEDIO: '🟡', BAJO: '🔵' };

export const ESTADO_EMOJI = {
  Nuevo:       '🆕',
  Contactado:  '📨',
  Reunion:     '📅',
  Propuesta:   '📄',
  Cerrado:     '✅',
  Descartado:  '❌',
};

// ── Validación de env vars al arranque ───────────────────────────────────────
/**
 * Verifica que las variables de entorno requeridas estén presentes.
 * Loguea un warning por cada una ausente y devuelve las que faltan.
 * @param {string[]} required  - nombres de variables requeridas
 * @param {string}   context   - nombre del archivo/módulo (para el log)
 * @returns {string[]}         - lista de variables ausentes (vacía si todo OK)
 */
export function checkEnvVars(required, context = 'app') {
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) {
    console.warn(`[${context}] Variables de entorno faltantes: ${missing.join(', ')}`);
  }
  return missing;
}

// ── Scoring ──────────────────────────────────────────────────────────────────
export function calcScore(sector, employees, objetivo) {
  let pts = 0;
  const emp = String(employees || '');
  if (['200-500', '500-1000', '1000-5000'].includes(emp)) pts += 3;
  else if (emp === '50-200') pts += 2;
  else if (emp === '5000+')  pts += 1;

  const objNorm = OBJ_MAP[objetivo] || objetivo || '';
  if (['Reducir rotacion', 'reducir-rotacion'].includes(objNorm) || (objNorm === objetivo && objetivo?.includes('rotac'))) pts += 3;
  else if (['Bienestar financiero','bienestar-financiero','Mejorar clima laboral','mejorar-clima'].some(v => v === objNorm || v === objetivo)) pts += 2;
  else pts += 1;

  const sectorNorm = SECTOR_MAP[sector] || sector || '';
  if (['retail','Retail y consumo','manufactura','Manufactura','banca','Banca y finanzas','Banca/Finanzas'].includes(sector) ||
      ['Retail y consumo','Manufactura','Banca y finanzas'].includes(sectorNorm)) pts += 2;
  else if (sector) pts += 1;

  if (pts >= 7) return 'ALTO';
  if (pts >= 4) return 'MEDIO';
  return 'BAJO';
}
