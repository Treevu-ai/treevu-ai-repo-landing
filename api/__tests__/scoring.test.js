// Tests para calcScore (api/lib/constants.js) — lógica de scoring de leads
import { test } from 'node:test';
import assert   from 'node:assert/strict';
import { calcScore } from '../lib/constants.js';

test('calcScore: ALTO — empresa grande + sector prioritario + objetivo rotación', () => {
  assert.equal(calcScore('retail', '200-500', 'reducir-rotacion'), 'ALTO');
  assert.equal(calcScore('manufactura', '500-1000', 'rotacion'),   'ALTO');
  assert.equal(calcScore('banca', '1000-5000', 'reducir-rotacion'),'ALTO');
});

test('calcScore: ALTO — sector prioritario + empresa mediana + objetivo clima', () => {
  // retail(2) + 500-1000(3) + mejorar-clima(2) = 7 → ALTO
  assert.equal(calcScore('retail', '500-1000', 'mejorar-clima'), 'ALTO');
  // manufactura(2) + 1000-5000(3) + bienestar(2) = 7 → ALTO
  assert.equal(calcScore('manufactura', '1000-5000', 'bienestar-financiero'), 'ALTO');
});

test('calcScore: MEDIO — empresa pequeña o sector no prioritario', () => {
  // servicios(1) + 50-200(2) + bienestar(2) = 5 → MEDIO
  assert.equal(calcScore('servicios', '50-200', 'bienestar-financiero'), 'MEDIO');
  // construccion(1) + 50-200(2) + optimizar-nomina(1) = 4 → MEDIO
  assert.equal(calcScore('construccion', '50-200', 'optimizar-nomina'),  'MEDIO');
});

test('calcScore: BAJO — empresa fuera del ICP', () => {
  // sin datos relevantes
  assert.equal(calcScore(undefined, undefined, undefined), 'BAJO');
});

test('calcScore: valores nulos no rompen la función', () => {
  assert.doesNotThrow(() => calcScore(null, null, null));
  assert.doesNotThrow(() => calcScore('', '', ''));
});
