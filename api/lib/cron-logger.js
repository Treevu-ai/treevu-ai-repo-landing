// api/lib/cron-logger.js — Wrapper de observabilidad para cron jobs
// Uso: export default cronJob('daily-summary', handler)

/**
 * Envuelve un handler de cron con logging estructurado de inicio/fin/error.
 * @param {string} name - Nombre del cron (para logs)
 * @param {Function} fn - async (req, res) => void
 * @returns {Function} handler
 */
export function cronJob(name, fn) {
  return async function (req, res) {
    const start = Date.now();
    const ts    = new Date().toISOString();
    console.log(`[cron:${name}] START ${ts}`);

    try {
      await fn(req, res);
      console.log(`[cron:${name}] DONE ${Date.now() - start}ms`);
    } catch (err) {
      console.error(`[cron:${name}] ERROR ${Date.now() - start}ms — ${err.message}`);
      if (!res.headersSent) {
        res.status(500).json({ ok: false, error: err.message, cron: name });
      }
    }
  };
}
