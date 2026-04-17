// api/lib/sector-intel.js — Inteligencia sectorial + cálculos de ROI
// Fuente única de verdad para tasas de rotación y costo estimado de renuncias.
// Importar calcRenuncias() en lugar de definir tasas locales en cada handler.

// Tasa de rotación anual por sector (para cálculos de ROI)
export const ROTACION_RATES = {
  'Retail y consumo':     0.20,
  'Manufactura':          0.18,
  'Construccion/Mineria': 0.22,
  'Banca y finanzas':     0.12,
  'Servicios':            0.15,
  'Salud':                0.16,
  'Tecnologia':           0.13,
  'Educacion':            0.14,
};

// Mapa de keys del formulario → nombre de sector normalizado
const SECTOR_KEY_MAP = {
  retail:       'Retail y consumo',
  manufactura:  'Manufactura',
  construccion: 'Construccion/Mineria',
  banca:        'Banca y finanzas',
  servicios:    'Servicios',
  salud:        'Salud',
  tecnologia:   'Tecnologia',
  educacion:    'Educacion',
};

// Mapa de rango de empleados → número representativo para cálculos
const PROMEDIOS_EMPLEADOS = {
  '50-200':    125,
  '200-500':   350,
  '500-1000':  750,
  '1000-5000': 2500,
  '5000+':     7000,
};

const COSTO_REEMPLAZO = 8000; // S/ por renuncia (costo directo de reemplazo)

/**
 * Calcula renuncias estimadas y costo anual de rotación para un lead.
 * @param {string} sectorKey — key del formulario (ej: 'retail') o nombre normalizado
 * @param {string} employees — rango de empleados (ej: '200-500') o número
 * @returns {{ renuncias: number, tasa: number, costo: number, costoStr: string }}
 */
export function calcRenuncias(sectorKey, employees) {
  const sectorName = SECTOR_KEY_MAP[sectorKey] || sectorKey;
  const tasa       = ROTACION_RATES[sectorName] || 0.15;
  const colabs     = PROMEDIOS_EMPLEADOS[employees]
    || parseInt((employees || '').split('-')[0].replace('+', ''))
    || 200;
  const renuncias  = Math.round(colabs * tasa);
  const costo      = renuncias * COSTO_REEMPLAZO;
  return { renuncias, tasa, costo, costoStr: costo.toLocaleString('es-PE') };
}

export function getSectorIntel(sector, employees) {
  const intel = {
    'Retail y consumo': {
      rotacion: '35-45% anual',
      dolor: 'cajeros y personal de piso, turnos festivos, adelantos al supervisor',
      objecion: '"Ya tenemos bonos de permanencia"',
      respuesta: 'Los bonos retienen en papeles — el EWA elimina el estrés diario que causa la salida',
      perfil_decisor: 'Gerente de RRHH + Gerente de Operaciones (a veces CFO)',
      tip: 'Preguntar por ausentismo en temporadas altas (navidad, verano)',
    },
    'Manufactura': {
      rotacion: '25-35% anual',
      dolor: 'operarios con deudas, accidentabilidad por estrés, absentismo los lunes',
      objecion: '"Nuestros operarios no tienen smartphone"',
      respuesta: 'App funciona en Android 6+ básico — y hay versión web para compartir cabina',
      perfil_decisor: 'RRHH + COO. El área de nómina bloquea si no los incluyes desde el inicio',
      tip: 'Preguntar cuántos piden adelanto al área de RRHH por mes — número revelador',
    },
    'Salud': {
      rotacion: '20-30% anual (enfermeros y técnicos)',
      dolor: 'turnos nocturnos + deuda → renuncia sin previo aviso, difícil reemplazo urgente',
      objecion: '"Tenemos convenio con cooperativa de ahorro"',
      respuesta: 'La cooperativa es ahorro — Treevü resuelve liquidez inmediata sin endeudamiento',
      perfil_decisor: 'Dirección Médica o Gerencia General suele tomar la decisión final',
      tip: 'El ML de predicción de renuncia es muy llamativo en esta industria — mencionarlo',
    },
    'Servicios': {
      rotacion: '30-40% anual',
      dolor: 'call centers, limpieza, seguridad — alta rotación y bajo margen para bonos',
      objecion: '"El margen es muy ajustado para agregar costos"',
      respuesta: 'Costo S/ 0 para el colaborador — empresa paga S/ 7/activo/mes, se recupera en <1 renuncia evitada',
      perfil_decisor: 'Gerente de RRHH o Gerente General en empresas medianas',
      tip: 'Enfocarse en el ROI concreto: una renuncia evitada financia 12 meses de Treevü',
    },
    'Banca y finanzas': {
      rotacion: '15-20% anual',
      dolor: 'analistas y promotores financieros con estrés de cumplimiento de metas',
      objecion: '"Tenemos un banco interno / caja de beneficios"',
      respuesta: 'Treevü complementa — acceso inmediato sin proceso de aprobación ni deuda registrada',
      perfil_decisor: 'RRHH + Compliance. Presentar regulación SBS desde el inicio',
      tip: 'La aprobación SBS es un diferenciador clave — mencionarla primero con esta industria',
    },
    'Construccion/Mineria': {
      rotacion: '40-55% anual (alta volatilidad)',
      dolor: 'pagos por quincena o quincenal irregular, operarios con deudas de capital riesgo',
      objecion: '"La planilla es por obra, muy variable"',
      respuesta: 'Treevü se adapta a planillas por proyecto — solo se activa para colaboradores activos',
      perfil_decisor: 'Gerente de RRHH o Jefe de Administración en proyectos',
      tip: 'Alta rotación significa que el caso de negocio es muy fuerte — calcular en vivo',
    },
  };

  const data = intel[sector] || {
    rotacion: '20-35% promedio Peru',
    dolor: 'estrés financiero, adelantos informales, baja retención',
    objecion: '"No teníamos esto en nuestro presupuesto"',
    respuesta: 'El costo es variable y se activa solo con colaboradores activos — sin costo fijo',
    perfil_decisor: 'Gerente de RRHH o CEO en empresas medianas',
    tip: 'Preguntar cuántos colaboradores pidieron adelanto este mes',
  };

  const { renuncias, costoStr } = calcRenuncias(sector, employees);

  return { ...data, renuncias, ahorroEstimado: costoStr, employees };
}
