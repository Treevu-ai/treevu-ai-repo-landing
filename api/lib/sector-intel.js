// api/lib/sector-intel.js — Pure sector intelligence data for primera-reunion
// Extracted here so it can be unit-tested without importing heavy runtime deps.

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

  const colabs        = parseInt((employees || '').split('-')[0]) || 0;
  const renuncias     = Math.round(colabs * 0.25);
  const ahorroEstimado = (renuncias * 8000).toLocaleString('es-PE');

  return { ...data, renuncias, ahorroEstimado, employees };
}
