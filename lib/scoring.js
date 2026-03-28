// ── lib/scoring.js ───────────────────────────────────────────────────────────
// Motor de scoring dinámico:
// 1. Score inicial por perfil (Claude + fallback reglas)
// 2. Señales comportamentales (boost/decay probabilidad)
// 3. Calibración histórica (loop de aprendizaje alimenta pesos)

import { llmCall } from './llm.js';
import { sbSelect } from './supabase.js';

export const SECTOR_MAP = {
  retail:       'Retail y consumo',
  manufactura:  'Manufactura',
  servicios:    'Servicios',
  salud:        'Salud',
  tecnologia:   'Tecnologia',
  construccion: 'Construccion/Mineria',
  educacion:    'Educacion',
  otro:         'Otro'
};

export const OBJ_MAP = {
  'reducir-rotacion':      'Reducir rotacion',
  'mejorar-clima':         'Mejorar clima laboral',
  'optimizar-nomina':      'Optimizar nomina',
  'bienestar-financiero':  'Bienestar financiero',
  'atraccion-talento':     'Atraer talento',
  otro:                    'Otro'
};

export const SCORE_EMOJI = { ALTO: '🔥', MEDIO: '🟡', BAJO: '🔵' };

// ── Fallback: scoring por reglas ──────────────────────────────────────────────
export function calcScoreFallback(sector, colaboradores, objetivo) {
  let pts = 0;
  if (['200-500','500-1000','1000-5000'].includes(colaboradores)) pts += 3;
  else if (colaboradores === '50-200') pts += 2;
  else if (colaboradores === '5000+')  pts += 1;
  if (objetivo === 'reducir-rotacion')                                    pts += 3;
  else if (['bienestar-financiero','mejorar-clima'].includes(objetivo))   pts += 2;
  else                                                                    pts += 1;
  if (['retail','manufactura'].includes(sector))                          pts += 2;
  else if (['servicios','salud','construccion'].includes(sector))         pts += 1;

  if (pts >= 7) return {
    score: 'ALTO', probabilidad: 75,
    razon: 'Perfil ideal: sector + tamaño + objetivo alineados.',
    accion: 'Contactar HOY — llamada de 20 min',
    señales_positivas: [], señales_negativas: [], mensaje_personalizado: null
  };
  if (pts >= 4) return {
    score: 'MEDIO', probabilidad: 45,
    razon: 'Perfil compatible. Requiere validación adicional.',
    accion: 'Contactar esta semana',
    señales_positivas: [], señales_negativas: [], mensaje_personalizado: null
  };
  return {
    score: 'BAJO', probabilidad: 15,
    razon: 'Perfil fuera del ICP actual del piloto.',
    accion: 'Nutrir con contenido, evaluar más adelante',
    señales_positivas: [], señales_negativas: [], mensaje_personalizado: null
  };
}

// ── Scoring con LLM + calibración histórica ───────────────────────────────────
export async function scoreWithLLM({ nombre, empresa, sector, colaboradores, objetivo, problema }) {
  // Intenta obtener calibración histórica del segmento
  let calibContext = '';
  try {
    const key = `${sector}_${colaboradores}_${objetivo}`;
    const rows = await sbSelect('scoring_calibration', {
      filters: { segment_key: `eq.${key}` },
      limit: 1
    });
    const cal = rows?.[0];
    if (cal && cal.sample_count >= 3) {
      calibContext = `\n\nDATOS HISTÓRICOS (${cal.sample_count} casos en este segmento): win rate real = ${cal.win_rate}%. Ajusta tu estimación de probabilidad acorde a este dato histórico.`;
    }
  } catch {
    // calibración no crítica, continúa sin ella
  }

  const system = `Eres el sistema de calificación de leads de Treevü, plataforma B2B2E de Earned Wage Access (EWA) con motor ML para empresas en Perú.

PRODUCTO:
- Modelo no-custodio: Treevü orquesta, empleador transfiere directo al colaborador
- Precio piloto: S/ 7/colaborador activo/mes meses 1-2, luego S/ 490/mes dashboard + S/ 7/usuario activo
- ICP: empresas peruanas 100-5000 colaboradores, sectores retail/manufactura/servicios/construcción
- Decisores: Directores RRHH, CFO, CEO
- Dolor: rotación laboral (S/ 8,000+ por reemplazo), estrés financiero, productividad perdida
- Diferenciador: 5 modelos ML predictivos, alerta de renuncia 3 semanas antes, cero riesgo financiero

SCORING:
- ALTO (prob > 65%): empresa 200-5000 colab + sector prioritario + objetivo rotación/bienestar + urgencia específica
- MEDIO (prob 35-65%): empresa 100-500 colab + sector compatible + objetivo parcialmente alineado
- BAJO (prob < 35%): empresa <100 colab o sector no prioritario o objetivo no alineado${calibContext}

Responde SOLO con JSON válido, sin texto ni markdown adicional:
{
  "score": "ALTO|MEDIO|BAJO",
  "probabilidad": <número 0-100>,
  "razon": "<1-2 oraciones con análisis concreto del lead>",
  "accion": "<acción específica recomendada al equipo de ventas>",
  "señales_positivas": ["<señal>"],
  "señales_negativas": ["<señal>"],
  "mensaje_personalizado": "<oración de apertura personalizada para primer contacto>"
}`;

  const user = `Lead a calificar:
- Nombre y cargo: ${nombre}
- Empresa: ${empresa}
- Sector: ${SECTOR_MAP[sector] || sector}
- Colaboradores: ${colaboradores}
- Objetivo principal: ${OBJ_MAP[objetivo] || objetivo}
- Reto declarado: ${problema || 'No especificado'}`;

  return llmCall({ task: 'lead-scoring', system, user, model: 'claude_haiku', maxTokens: 600, parseJson: true });
}

// ── Scoring dinámico: ajuste por señales comportamentales ────────────────────
/**
 * @param {number} currentProb - probabilidad actual (0-100)
 * @param {Object} signals
 * @param {boolean} [signals.meeting_scheduled]
 * @param {boolean} [signals.email_opened]
 * @param {boolean} [signals.calendly_link_visited]
 * @param {boolean} [signals.manual_contact_logged]
 * @param {number}  [signals.days_since_last_contact] - para decay
 * @returns {{ newProb: number, newScore: string, delta: number, applied: string[] }}
 */
export function applyBehavioralSignals(currentProb, signals = {}) {
  let prob    = currentProb;
  const applied = [];

  if (signals.meeting_scheduled)       { prob = Math.min(prob + 25, 95); applied.push('+25 reunión agendada'); }
  if (signals.email_opened)            { prob = Math.min(prob + 8,  95); applied.push('+8 email abierto'); }
  if (signals.calendly_link_visited)   { prob = Math.min(prob + 12, 95); applied.push('+12 visitó Calendly'); }
  if (signals.manual_contact_logged)   { prob = Math.min(prob + 5,  95); applied.push('+5 contacto manual'); }
  if (signals.days_since_last_contact) {
    const decay = Math.floor(signals.days_since_last_contact / 7) * 3;
    if (decay > 0) { prob = Math.max(prob - decay, 5); applied.push(`-${decay} decay (${signals.days_since_last_contact}d sin contacto)`); }
  }

  const newProb  = Math.round(prob);
  const newScore = probToScore(newProb);
  const delta    = newProb - currentProb;

  return { newProb, newScore, delta, applied };
}

export function probToScore(prob) {
  if (prob >= 65) return 'ALTO';
  if (prob >= 35) return 'MEDIO';
  return 'BAJO';
}
