// api/lib/metrics.js — Logging estructurado y métricas de observabilidad
// Emite JSON por stdout/stderr (Vercel los indexa automáticamente).
// Si SENTRY_DSN está presente, los errores también van a Sentry vía sentry.js.

const ENV = process.env.VERCEL_ENV || process.env.NODE_ENV || 'development';

function emit(level, event, data = {}) {
  const entry = { ts: new Date().toISOString(), level, event, env: ENV, ...data };
  (level === 'error' ? console.error : console.log)(JSON.stringify(entry));
}

// ── Log genérico ──────────────────────────────────────────────────────────────
export const log = {
  info:  (event, data) => emit('info',  event, data),
  warn:  (event, data) => emit('warn',  event, data),
  error: (event, data) => emit('error', event, data),
};

// ── Request completado ────────────────────────────────────────────────────────
// Uso: logRequest('/api/submit', 'POST', 200, durationMs, { score: 'ALTO' })
export function logRequest(endpoint, method, statusCode, durationMs, extra = {}) {
  emit('info', 'http.request', { endpoint, method, statusCode, durationMs, ...extra });
}

// ── Error de integración ──────────────────────────────────────────────────────
// Uso: logError('gmail', err, { email })
export function logError(source, err, context = {}) {
  emit('error', 'integration.error', { source, message: err?.message, ...context });
}

// ── Métrica de negocio ────────────────────────────────────────────────────────
// Uso: logMetric('lead.score', 'ALTO', { fuente: 'claude' })
export function logMetric(name, value, tags = {}) {
  emit('info', 'metric', { name, value, ...tags });
}

// ── Rate limit excedido ───────────────────────────────────────────────────────
export function logRateLimit(ip, endpoint) {
  emit('warn', 'rate_limit.exceeded', { ip, endpoint });
}

// ── Webhook rechazado ─────────────────────────────────────────────────────────
export function logWebhookReject(source, reason, extra = {}) {
  emit('warn', 'webhook.rejected', { source, reason, ...extra });
}
