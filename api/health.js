// api/health.js — GET /api/health
// Verifica Redis, Notion API y variables de entorno críticas

import { redisCmd } from './lib/redis.js';
import { NOTION, CONFIG } from './lib/constants.js';
import { supabaseSelect } from './lib/supabase.js';

export default async function handler(req, res) {
  const start = Date.now();
  const checks = {};

  // ── Redis ─────────────────────────────────────────────────────────────────
  try {
    await redisCmd('SET', 'health:ping', '1', 'EX', 10);
    const val = await redisCmd('GET', 'health:ping');
    checks.redis = val === '1' ? 'ok' : 'error: unexpected value';
  } catch (err) {
    checks.redis = `error: ${err.message}`;
  }

  // ── Notion ────────────────────────────────────────────────────────────────
  try {
    const res2 = await fetch(`https://api.notion.com/v1/databases/${NOTION.CRM_DB}`, {
      headers: {
        'Authorization': `Bearer ${NOTION.TOKEN}`,
        'Notion-Version': '2022-06-28',
      },
    });
    checks.notion = res2.ok ? 'ok' : `error: ${res2.status}`;
  } catch (err) {
    checks.notion = `error: ${err.message}`;
  }

  // ── Supabase ──────────────────────────────────────────────────────────────
  try {
    const rows = await supabaseSelect('leads', { columns: 'id', limit: 1 });
    checks.supabase = Array.isArray(rows) ? 'ok' : 'error: unexpected response';
  } catch (err) {
    checks.supabase = `error: ${err.message}`;
  }

  // ── Env vars ──────────────────────────────────────────────────────────────
  checks.env = {
    openai:    !!(process.env.OPENAI_API_KEY || process.env.OPENCLAW_TOKEN),
    notion:    !!NOTION.TOKEN,
    ceo_bot:   !!CONFIG.TELEGRAM_CEO_BOT_TOKEN,
    abm_bot:   !!CONFIG.TELEGRAM_ABM_BOT_TOKEN,
    cron:      !!CONFIG.CRON_SECRET,
  };

  const healthy = checks.redis === 'ok' && checks.notion === 'ok' && checks.supabase === 'ok';

  res.status(healthy ? 200 : 503).json({
    ok:     healthy,
    ms:     Date.now() - start,
    checks,
    ts:     new Date().toISOString(),
  });
}
