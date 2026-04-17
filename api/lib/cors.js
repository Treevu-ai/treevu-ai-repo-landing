// api/lib/cors.js — CORS allowlist + rate limiting (Redis primario, memoria fallback)

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
const WINDOW_S   = 60;        // ventana en segundos
const WINDOW_MS  = WINDOW_S * 1_000;

// Fallback en memoria (cuando Redis no está configurado)
/** @type {Map<string, { count: number, resetAt: number }>} */
const _store = new Map();

function _memRateLimit(ip) {
  const now = Date.now();
  const rec = _store.get(ip);
  if (!rec || now > rec.resetAt) {
    _store.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, remaining: RATE_LIMIT - 1 };
  }
  if (rec.count >= RATE_LIMIT) {
    return { allowed: false, remaining: 0, retryAfter: Math.ceil((rec.resetAt - now) / 1000) };
  }
  rec.count++;
  return { allowed: true, remaining: RATE_LIMIT - rec.count };
}

const _cleanup = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _store) if (now > v.resetAt) _store.delete(k);
}, WINDOW_MS * 5);
_cleanup.unref?.();

/**
 * Verifica rate limit por IP. Usa Redis cuando está disponible para persistir
 * contadores entre instancias de Vercel (evita reset en cold starts).
 * @returns {Promise<{ allowed: boolean, remaining: number, retryAfter?: number }>}
 */
export async function checkRateLimit(ip) {
  const key = `rl:${ip || 'unknown'}`;

  // Importación dinámica para evitar ciclos y permitir que el módulo funcione sin Redis
  const { redisCmd } = await import('./redis.js');
  const count = await redisCmd('INCR', key);

  if (count !== null) {
    // Redis disponible: primer hit → fijar ventana de expiración
    if (count === 1) redisCmd('EXPIRE', key, WINDOW_S).catch(() => {});
    if (count > RATE_LIMIT) return { allowed: false, remaining: 0, retryAfter: WINDOW_S };
    return { allowed: true, remaining: RATE_LIMIT - count };
  }

  // Redis no configurado o caído → fallback en memoria
  return _memRateLimit(ip || 'unknown');
}

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
