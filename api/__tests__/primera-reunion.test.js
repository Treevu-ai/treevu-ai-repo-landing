/**
 * Tests para funciones puras de api/primera-reunion.js
 * Cubre: getSectorIntel
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { getSectorIntel } from '../lib/sector-intel.js';

const SECTORS_KNOWN = [
  'Retail y consumo',
  'Manufactura',
  'Salud',
  'Servicios',
  'Banca y finanzas',
  'Construccion/Mineria',
];

// ── estructura de retorno ───────────────────────────────────────────────────

test('getSectorIntel: devuelve todos los campos requeridos', () => {
  const required = ['rotacion', 'dolor', 'objecion', 'respuesta', 'perfil_decisor', 'tip', 'renuncias', 'ahorroEstimado', 'employees'];
  const r = getSectorIntel('Manufactura', '200-500');
  for (const key of required) {
    assert.ok(Object.hasOwn(r, key), `campo faltante: ${key}`);
  }
});

test('getSectorIntel: sector desconocido → fallback no vacío con todos los campos', () => {
  const r = getSectorIntel('OtraIndustria', '100-300');
  assert.ok(typeof r.rotacion === 'string' && r.rotacion.length > 0);
  assert.ok(typeof r.dolor    === 'string' && r.dolor.length    > 0);
  assert.ok(typeof r.tip      === 'string' && r.tip.length      > 0);
});

// ── sectores conocidos ──────────────────────────────────────────────────────

test('getSectorIntel: cada sector conocido devuelve datos específicos', () => {
  for (const sector of SECTORS_KNOWN) {
    const r = getSectorIntel(sector, '500-1000');
    assert.ok(typeof r.rotacion === 'string' && r.rotacion.length > 0, `rotacion vacía: ${sector}`);
    assert.ok(typeof r.tip      === 'string' && r.tip.length      > 0, `tip vacío: ${sector}`);
  }
});

test('getSectorIntel: los sectores conocidos tienen contenido distinto al fallback', () => {
  const fallback = getSectorIntel('SectorInexistente', '100');
  const retail   = getSectorIntel('Retail y consumo', '100');
  // Al menos el dolor debe ser diferente
  assert.notEqual(retail.dolor, fallback.dolor);
});

// ── cálculo de renuncias y ahorro ───────────────────────────────────────────

test('getSectorIntel: renuncias = round(PROMEDIO * tasa) con rango "200-500" + Manufactura', () => {
  const r = getSectorIntel('Manufactura', '200-500');
  // PROMEDIOS_EMPLEADOS['200-500'] = 350, tasa Manufactura = 0.18 → round(350 * 0.18) = 63
  assert.equal(r.renuncias, 63);
});

test('getSectorIntel: renuncias = round(750 * 0.20) = 150 con "500-1000" + Retail', () => {
  const r = getSectorIntel('Retail y consumo', '500-1000');
  // PROMEDIOS_EMPLEADOS['500-1000'] = 750, tasa Retail = 0.20 → round(750 * 0.20) = 150
  assert.equal(r.renuncias, 150);
});

test('getSectorIntel: ahorroEstimado = renuncias * 8000 (formateado)', () => {
  const r = getSectorIntel('Salud', '200-500');
  const expected = (r.renuncias * 8000).toLocaleString('es-PE');
  assert.equal(r.ahorroEstimado, expected);
});

test('getSectorIntel: employees se pasa tal cual al retorno', () => {
  const r = getSectorIntel('Servicios', '1000-5000');
  assert.equal(r.employees, '1000-5000');
});

test('getSectorIntel: employees vacío → fallback a 200 colaboradores', () => {
  const r = getSectorIntel('Manufactura', '');
  // parseInt('') = NaN → fallback 200, tasa 0.18 → round(200 * 0.18) = 36
  assert.equal(r.renuncias, 36);
});

test('getSectorIntel: employees undefined → fallback a 200 colaboradores', () => {
  const r = getSectorIntel('Salud');
  // fallback 200, tasa Salud 0.16 → round(200 * 0.16) = 32
  assert.equal(r.renuncias, 32);
});
