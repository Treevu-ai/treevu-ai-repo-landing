/**
 * Tests para funciones puras de api/telegram.js
 * Cubre: estimarCostoRotacion, feedbackTamano, feedbackObjetivo, calcIcpScore, shouldShowCTA
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import {
  estimarCostoRotacion,
  feedbackTamano,
  feedbackObjetivo,
  calcIcpScore,
  shouldShowCTA,
} from '../lib/telegram-utils.js';

// ── estimarCostoRotacion ────────────────────────────────────────────────────

test('estimarCostoRotacion: 50-200 → promedio 125 colabs, 18% rotación', () => {
  const r = estimarCostoRotacion('50-200');
  assert.equal(r.colabs, 125);
  assert.equal(r.renuncias, 23); // round(125 * 0.18)
  assert.ok(typeof r.costo === 'string', 'costo debe ser string formateado');
});

test('estimarCostoRotacion: 1000-5000 → promedio 2500 colabs', () => {
  const r = estimarCostoRotacion('1000-5000');
  assert.equal(r.colabs, 2500);
  assert.equal(r.renuncias, 450); // round(2500 * 0.18)
});

test('estimarCostoRotacion: size desconocido → fallback a 125', () => {
  const r = estimarCostoRotacion('desconocido');
  assert.equal(r.colabs, 125);
});

test('estimarCostoRotacion: 5000+ → promedio 7000 colabs', () => {
  const r = estimarCostoRotacion('5000+');
  assert.equal(r.colabs, 7000);
});

// ── feedbackTamano ──────────────────────────────────────────────────────────

test('feedbackTamano: devuelve string no vacío para cada tamaño', () => {
  const sizes = ['50-200', '200-500', '500-1000', '1000-5000', '5000+'];
  for (const size of sizes) {
    const msg = feedbackTamano(size);
    assert.ok(typeof msg === 'string' && msg.length > 0, `feedbackTamano(${size}) vacío`);
  }
});

test('feedbackTamano: incluye el costo formateado en el mensaje', () => {
  const msg = feedbackTamano('200-500');
  // Debe incluir el símbolo S/ y un número con puntos (formato peruano)
  assert.match(msg, /S\//);
});

test('feedbackTamano: tamaño desconocido → no explota, devuelve fallback', () => {
  const msg = feedbackTamano('nada');
  assert.ok(typeof msg === 'string' && msg.length > 0);
});

// ── feedbackObjetivo ────────────────────────────────────────────────────────

test('feedbackObjetivo: devuelve mensajes distintos por objetivo', () => {
  const objetivos = ['rotacion', 'bienestar', 'clima', 'nomina', 'talento'];
  const msgs = objetivos.map(feedbackObjetivo);
  // Todos no vacíos
  msgs.forEach((m, i) => assert.ok(m.length > 0, `vacío para ${objetivos[i]}`));
  // Todos distintos entre sí
  const unicos = new Set(msgs);
  assert.equal(unicos.size, objetivos.length, 'todos los mensajes deben ser distintos');
});

test('feedbackObjetivo: objetivo desconocido → fallback no vacío', () => {
  const msg = feedbackObjetivo('otro');
  assert.ok(typeof msg === 'string' && msg.length > 0);
});

test('feedbackObjetivo: rotacion menciona -30% o impacto documentado', () => {
  const msg = feedbackObjetivo('rotacion');
  assert.match(msg, /-30%|mayor impacto/i);
});

// ── calcIcpScore ────────────────────────────────────────────────────────────

test('calcIcpScore: ALTO — tamaño grande + sector prioritario', () => {
  assert.equal(calcIcpScore('manufactura', '500-1000', 'rotacion'), 'ALTO');
  assert.equal(calcIcpScore('banca',       '1000-5000', 'bienestar'), 'ALTO');
  assert.equal(calcIcpScore('salud',       '5000+', 'clima'), 'ALTO');
});

test('calcIcpScore: ALTO — tamaño grande + objetivo prioritario (sector no top)', () => {
  assert.equal(calcIcpScore('construccion', '500-1000', 'rotacion'), 'ALTO');
});

test('calcIcpScore: MEDIO — tamaño grande + sector/objetivo no prioritario', () => {
  assert.equal(calcIcpScore('educacion', '500-1000', 'talento'), 'MEDIO');
});

test('calcIcpScore: MEDIO — tamaño medio + sector prioritario', () => {
  assert.equal(calcIcpScore('manufactura', '200-500', 'talento'), 'MEDIO');
});

test('calcIcpScore: MEDIO — tamaño medio + objetivo prioritario', () => {
  assert.equal(calcIcpScore('educacion', '200-500', 'bienestar'), 'MEDIO');
});

test('calcIcpScore: BAJO — empresa pequeña + sector/objetivo genérico', () => {
  assert.equal(calcIcpScore('otro', '50-200', 'talento'), 'BAJO');
  assert.equal(calcIcpScore('otro', '50-200', 'nomina'),  'BAJO');
});

test('calcIcpScore: los tres valores de retorno son ALTO | MEDIO | BAJO', () => {
  const valid = new Set(['ALTO', 'MEDIO', 'BAJO']);
  const combos = [
    ['retail',    '50-200',    'clima'],
    ['tecnologia','200-500',   'rotacion'],
    ['servicios', '1000-5000', 'bienestar'],
  ];
  for (const [s, sz, o] of combos) {
    assert.ok(valid.has(calcIcpScore(s, sz, o)), `resultado inválido para (${s},${sz},${o})`);
  }
});

// ── shouldShowCTA ───────────────────────────────────────────────────────────

test('shouldShowCTA: true con "equipo te contacte"', () => {
  assert.ok(shouldShowCTA('¿Quieres que el equipo te contacte?'));
});

test('shouldShowCTA: true con "comunique"', () => {
  assert.ok(shouldShowCTA('Te comunique con el equipo ahora.'));
});

test('shouldShowCTA: true con variantes de la regex', () => {
  const positivos = [
    'El equipo se pondrá en contacto',
    'Podemos reserve una llamada',
    'Te puedo hablar contigo mañana',
    '¿Te gustaría más información formal?',
  ];
  for (const txt of positivos) {
    assert.ok(shouldShowCTA(txt), `debería ser true: "${txt}"`);
  }
});

test('shouldShowCTA: false con respuesta genérica sin trigger', () => {
  const negativos = [
    'Treevü reduce la rotación un 30% en 6 meses.',
    'El costo para el colaborador es cero.',
    '¿Cuántos colaboradores tiene tu empresa?',
  ];
  for (const txt of negativos) {
    assert.ok(!shouldShowCTA(txt), `debería ser false: "${txt}"`);
  }
});
