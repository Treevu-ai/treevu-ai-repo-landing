// api/lib/fetch-utils.js — Fetch helpers con timeout y retry

/**
 * Wrapper de fetch con AbortController timeout.
 * @param {string} url
 * @param {RequestInit} options
 * @param {number} timeoutMs — default 10s
 */
export async function fetchWithTimeout(url, options = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`timeout after ${timeoutMs}ms: ${url}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * fetchWithTimeout + reintentos exponenciales para operaciones de solo lectura.
 * NO usar en llamadas que escriben/publican — riesgo de duplicar acciones.
 * @param {string} url
 * @param {RequestInit} options
 * @param {{ timeoutMs?: number, retries?: number, delayMs?: number }} opts
 */
export async function fetchWithRetry(url, options = {}, { timeoutMs = 10_000, retries = 2, delayMs = 500 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, delayMs * attempt));
    try {
      const res = await fetchWithTimeout(url, options, timeoutMs);
      if (res.ok || res.status < 500) return res; // no reintentar 4xx (error del cliente)
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}
