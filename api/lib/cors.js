// api/lib/cors.js — CORS allowlist + rate limiting en memoria por IP

const ALLOWED_ORIGINS = [
  'https://gettreevu.com',
  'https://www.gettreevu.com',
];

// En dev/preview se acepta localhost
if (process.env.VERCEL_ENV !== 'production') {
  ALLOWED_ORIGINS.push('http://localhost:3000', 'http://localhost:8080');
}

// ── Rate limiting ─────────────────────────────────────────────────────────────
const RATE_LIMIT = 10;        // requests máximos
const WINDOW_MS  = 60_000;    // ventana de 1 minuto

/** @type {Map<string, { count: number, resetAt: number }>} */
const _store = new Map();

export function checkRateLimit(ip) {
  const now = Date.now();
  const key = ip || 'unknown';
  const rec = _store.get(key);

  if (!rec || now > rec.resetAt) {
    _store.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, remaining: RATE_LIMIT - 1 };
  }
  if (rec.count >= RATE_LIMIT) {
    return { allowed: false, remaining: 0, retryAfter: Math.ceil((rec.resetAt - now) / 1000) };
  }
  rec.count++;
  return { allowed: true, remaining: RATE_LIMIT - rec.count };
}

// Limpieza periódica de entradas expiradas
const _cleanup = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _store) if (now > v.resetAt) _store.delete(k);
}, WINDOW_MS * 5);
_cleanup.unref?.();

// ── CORS ──────────────────────────────────────────────────────────────────────
export function setCorsHeaders(req, res) {
  const origin  = req.headers?.origin || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader('Access-Control-Allow-Origin',  allowed);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}

export function isOriginAllowed(req) {
  const origin = req.headers?.origin || '';
  if (!origin) return true; // peticiones server-to-server / curl
  return ALLOWED_ORIGINS.includes(origin);
}

export { ALLOWED_ORIGINS };
