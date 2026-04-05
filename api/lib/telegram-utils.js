// api/lib/telegram-utils.js — Pure utility functions for the Telegram bot
// Extracted here so they can be unit-tested without importing heavy runtime deps.

// ── Estimador de costo de rotación ──────────────────────────────────────────
export function estimarCostoRotacion(size) {
  const COSTO_REEMPLAZO = 8000;
  const TASA_ROTACION   = 0.18;
  const promedios = { '50-200': 125, '200-500': 350, '500-1000': 750, '1000-5000': 2500, '5000+': 7000 };
  const colabs    = promedios[size] || 125;
  const renuncias = Math.round(colabs * TASA_ROTACION);
  const costo     = (renuncias * COSTO_REEMPLAZO).toLocaleString('es-PE');
  return { colabs, renuncias, costo };
}

// ── Micro-feedback por tamaño ────────────────────────────────────────────────
export function feedbackTamano(size) {
  const { renuncias, costo } = estimarCostoRotacion(size);
  const msgs = {
    '50-200':    `Con equipos de hasta 200 personas, cada renuncia cuesta ~S/ 8,000. Con ${renuncias} salidas anuales estimadas, eso son *S/ ${costo} al año*. Vamos al siguiente paso:`,
    '200-500':   `Con ~350 colaboradores, la rotacion puede costar *S/ ${costo} al año*. Es exactamente donde Treevü tiene mayor impacto. Una pregunta mas:`,
    '500-1000':  `Con 500+ colaboradores, el ahorro potencial con Treevü supera *S/ ${costo} anuales*. Eres exactamente el perfil del Programa Fundadores. Una pregunta mas:`,
    '1000-5000': `Con mas de 1,000 personas, el impacto es transformacional: *S/ ${costo} en rotacion evitable al año*. Ultima pregunta de calificacion:`,
    '5000+':     `Con mas de 5,000 colaboradores, eres el perfil ideal para el Programa Fundadores de Treevu. Ahorro potencial: *S/ ${costo}+/año*. Una pregunta mas:`,
  };
  return msgs[size] || msgs['50-200'];
}

// ── Micro-feedback por objetivo ──────────────────────────────────────────────
export function feedbackObjetivo(objetivo) {
  const msgs = {
    rotacion:   'Reducir rotacion es donde Treevu tiene el mayor impacto documentado: *-30% en 6 meses*. Solo falta saber en que sector operas:',
    bienestar:  'El bienestar financiero es la raiz de la rotacion. Treevu ataca el problema desde la causa, no el sintoma. ¿En que sector?',
    clima:      'El estres financiero explica el 40% del mal clima laboral. Treevu lo elimina sin costo para nadie. ¿En que sector opera tu empresa?',
    nomina:     'Treevu no toca la nomina — la complementa sin riesgo ni costo. Setup en 2 semanas. ¿En que sector?',
    talento:    'Los beneficios financieros son el diferenciador #1 para atraer talento en Peru hoy. ¿En que sector opera tu empresa?',
  };
  return msgs[objetivo] || '¿En que sector opera tu empresa?';
}

// ── Score ICP automático ─────────────────────────────────────────────────────
export function calcIcpScore(sector, size, objetivo) {
  const highValueSectors   = ['manufactura', 'banca', 'salud', 'tecnologia'];
  const highValueObjetivos = ['rotacion', 'bienestar'];
  const largeSizes         = ['500-1000', '1000-5000', '5000+'];
  const midSizes           = ['200-500'];

  const isHighSector   = highValueSectors.includes(sector);
  const isHighObjetivo = highValueObjetivos.includes(objetivo);
  const isLargeSize    = largeSizes.includes(size);
  const isMidSize      = midSizes.includes(size);

  if ((isLargeSize) && (isHighSector || isHighObjetivo)) return 'ALTO';
  if (isLargeSize || (isMidSize && (isHighSector || isHighObjetivo))) return 'MEDIO';
  if (isMidSize || isHighSector) return 'MEDIO';
  return 'BAJO';
}

// ── Detecta si Claude sugiere mostrar CTA de contacto ───────────────────────
export function shouldShowCTA(reply) {
  return /contacte|contactar|equipo te|equipo se|comunique|reserve|reservar|más info|información formal|hablar contigo|ponerse en contacto/i.test(reply);
}
