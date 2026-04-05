// api/lib/constants.js — Fuente única de verdad para constantes de Treevu

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
