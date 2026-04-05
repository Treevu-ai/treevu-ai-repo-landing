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

test('getSectorIntel: renuncias = round(colabs * 0.25) con rango "200-500"', () => {
  const r = getSectorIntel('Manufactura', '200-500');
  // parseInt('200') = 200 → round(200 * 0.25) = 50
  assert.equal(r.renuncias, 50);
});

test('getSectorIntel: renuncias = round(500 * 0.25) = 125 con "500-1000"', () => {
  const r = getSectorIntel('Retail y consumo', '500-1000');
  assert.equal(r.renuncias, 125);
});

test('getSectorIntel: ahorroEstimado = renuncias * 8000 (formateado)', () => {
  const r = getSectorIntel('Salud', '200-500');
  // renuncias = 50 → 50 * 8000 = 400,000 → '400,000' (locale es-PE)
  const expected = (r.renuncias * 8000).toLocaleString('es-PE');
  assert.equal(r.ahorroEstimado, expected);
});

test('getSectorIntel: employees se pasa tal cual al retorno', () => {
  const r = getSectorIntel('Servicios', '1000-5000');
  assert.equal(r.employees, '1000-5000');
});

test('getSectorIntel: employees vacío → renuncias = 0', () => {
  const r = getSectorIntel('Manufactura', '');
  // parseInt('') → 0 → round(0 * 0.25) = 0
  assert.equal(r.renuncias, 0);
});

test('getSectorIntel: employees undefined → renuncias = 0', () => {
  const r = getSectorIntel('Salud');
  assert.equal(r.renuncias, 0);
});
