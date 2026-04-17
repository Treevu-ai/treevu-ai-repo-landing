// Tests para api/lib/cors.js — CORS allowlist y rate limiting
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { checkRateLimit, isOriginAllowed, ALLOWED_ORIGINS } from '../lib/cors.js';

// Generamos IPs únicas por test para no interferir con el store compartido
let testIpCounter = 0;
function freshIp() { return `10.0.test.${++testIpCounter}`; }

// ── checkRateLimit ────────────────────────────────────────────────────────────
// Redis no está configurado en tests → usa fallback en memoria automáticamente.
test('checkRateLimit: permite las primeras N peticiones', async () => {
  const ip = freshIp();
  const r1 = await checkRateLimit(ip);
  assert.ok(r1.allowed);
  assert.equal(r1.remaining, 9);
});

test('checkRateLimit: bloquea cuando se supera el límite', async () => {
  const ip = freshIp();
  for (let i = 0; i < 10; i++) await checkRateLimit(ip);
  const blocked = await checkRateLimit(ip);
  assert.equal(blocked.allowed,    false);
  assert.equal(blocked.remaining,  0);
  assert.ok(blocked.retryAfter > 0);
});

test('checkRateLimit: IPs distintas no se afectan entre sí', async () => {
  const ip1 = freshIp();
  const ip2 = freshIp();
  for (let i = 0; i < 10; i++) await checkRateLimit(ip1);
  const r = await checkRateLimit(ip2);
  assert.ok(r.allowed, 'ip2 no debe verse afectada por ip1');
});

test('checkRateLimit: ip vacía no lanza error', async () => {
  await assert.doesNotReject(() => checkRateLimit(''));
  await assert.doesNotReject(() => checkRateLimit(null));
});

// ── isOriginAllowed ───────────────────────────────────────────────────────────
test('isOriginAllowed: acepta orígenes en la allowlist', () => {
  const req = (origin) => ({ headers: { origin } });
  for (const o of ALLOWED_ORIGINS) {
    assert.ok(isOriginAllowed(req(o)), `debería aceptar: ${o}`);
  }
});

test('isOriginAllowed: rechaza orígenes fuera de la allowlist', () => {
  const req = (origin) => ({ headers: { origin } });
  assert.equal(isOriginAllowed(req('https://evil.com')),        false);
  assert.equal(isOriginAllowed(req('https://phishing.net')),    false);
  assert.equal(isOriginAllowed(req('http://gettreevu.com')),    false); // http sin TLS
});

test('isOriginAllowed: permite peticiones sin cabecera origin (server-to-server)', () => {
  assert.ok(isOriginAllowed({ headers: {} }));
  assert.ok(isOriginAllowed({ headers: { origin: '' } }));
});
