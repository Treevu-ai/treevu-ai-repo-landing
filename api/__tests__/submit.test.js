// Tests para validación de /api/submit — sin dependencias externas
import { test } from 'node:test';
import assert   from 'node:assert/strict';
import { validateSubmitBody } from '../lib/validation.js';

const VALID_BODY = {
  nombre:        'Ricardo Cuba',
  email:         'ricardo@empresa.com',
  empresa:       'Empresa SAC',
  sector:        'retail',
  colaboradores: '200-500',
  objetivo:      'reducir-rotacion',
};

// ── Honeypot ──────────────────────────────────────────────────────────────────
test('validateSubmitBody: honeypot → marca honeypot:true, ok:true', () => {
  const r = validateSubmitBody({ ...VALID_BODY, website: 'spam' });
  assert.ok(r.ok);
  assert.ok(r.honeypot);
});

// ── Campos requeridos ─────────────────────────────────────────────────────────
test('validateSubmitBody: body nulo → 400', () => {
  const r = validateSubmitBody(null);
  assert.equal(r.ok,     false);
  assert.equal(r.status, 400);
});

for (const field of ['nombre', 'email', 'empresa', 'sector', 'colaboradores', 'objetivo']) {
  test(`validateSubmitBody: falta "${field}" → 400`, () => {
    const body = { ...VALID_BODY };
    delete body[field];
    const r = validateSubmitBody(body);
    assert.equal(r.ok,     false);
    assert.equal(r.status, 400);
  });
}

// ── Email inválido ────────────────────────────────────────────────────────────
test('validateSubmitBody: email inválido → 400', () => {
  const r = validateSubmitBody({ ...VALID_BODY, email: 'no-es-email' });
  assert.equal(r.ok,     false);
  assert.equal(r.status, 400);
});

// ── Payload grande ────────────────────────────────────────────────────────────
test('validateSubmitBody: payload > 10KB → 400', () => {
  const r = validateSubmitBody({ ...VALID_BODY, problema: 'x'.repeat(11_000) });
  assert.equal(r.ok,     false);
  assert.equal(r.status, 400);
});

// ── Happy path ────────────────────────────────────────────────────────────────
test('validateSubmitBody: body válido → ok:true', () => {
  const r = validateSubmitBody(VALID_BODY);
  assert.ok(r.ok);
  assert.equal(r.honeypot, undefined);
});
