/**
 * Tests para funciones puras de api/lib/ceo-deal.js
 * Cubre: estimarPrecio
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { estimarPrecio } from '../lib/ceo-deal.js';

// ── estimarPrecio ───────────────────────────────────────────────────────────

test('estimarPrecio: colaboradores vacíos → null', () => {
  assert.equal(estimarPrecio(''), null);
  assert.equal(estimarPrecio(),   null);
  assert.equal(estimarPrecio(null), null);
});

test('estimarPrecio: string no numérico → null', () => {
  assert.equal(estimarPrecio('desconocido'), null);
  assert.equal(estimarPrecio('-'),           null);
});

test('estimarPrecio: "200-500" → toma el primer número (200)', () => {
  const r = estimarPrecio('200-500');
  assert.equal(r.colaboradores, 200);
  assert.equal(r.adopcion, Math.round(200 * 0.30)); // 60
  assert.equal(r.mensual, 60 * 7 + 490);            // 910
});

test('estimarPrecio: "1000-5000" → toma 1000', () => {
  const r = estimarPrecio('1000-5000');
  assert.equal(r.colaboradores, 1000);
  assert.equal(r.adopcion, 300);         // round(1000 * 0.30)
  assert.equal(r.mensual, 300 * 7 + 490); // 2590
});

test('estimarPrecio: "5000+" → elimina el +, toma 5000', () => {
  const r = estimarPrecio('5000+');
  assert.equal(r.colaboradores, 5000);
  assert.equal(r.adopcion, 1500);
  assert.equal(r.mensual, 1500 * 7 + 490); // 11,490
});

test('estimarPrecio: "500" (número suelto) → funciona', () => {
  const r = estimarPrecio('500');
  assert.equal(r.colaboradores, 500);
  assert.equal(r.adopcion, 150);
});

test('estimarPrecio: estructura de retorno correcta', () => {
  const r = estimarPrecio('300-600');
  assert.ok(Object.hasOwn(r, 'colaboradores'), 'falta colaboradores');
  assert.ok(Object.hasOwn(r, 'adopcion'),      'falta adopcion');
  assert.ok(Object.hasOwn(r, 'mensual'),       'falta mensual');
  assert.ok(typeof r.colaboradores === 'number');
  assert.ok(typeof r.adopcion      === 'number');
  assert.ok(typeof r.mensual       === 'number');
});

test('estimarPrecio: mensual = adopcion * 7 + 490 (invariante de precio)', () => {
  const sizes = ['50-200', '200-500', '500-1000', '1000-5000'];
  for (const s of sizes) {
    const r = estimarPrecio(s);
    assert.equal(r.mensual, r.adopcion * 7 + 490, `invariante roto para ${s}`);
  }
});
