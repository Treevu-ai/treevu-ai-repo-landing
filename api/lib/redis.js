// api/lib/redis.js — Upstash Redis REST client centralizado

const UPSTASH_URL   = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

export async function redisCmd(...args) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  try {
    const res = await fetch(UPSTASH_URL, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(args),
    });
    return (await res.json()).result ?? null;
  } catch { return null; }
}

// Upstash SCAN via REST path — itera todos los cursores hasta agotar resultados
export async function redisScan(pattern, count = 200) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return [];
  const keys = [];
  let cursor = '0';
  try {
    do {
      const res = await fetch(
        `${UPSTASH_URL}/scan/${cursor}/match/${encodeURIComponent(pattern)}/count/${count}`,
        { headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}` } }
      );
      const result = (await res.json()).result;
      cursor = result?.[0] ?? '0';
      if (result?.[1]?.length) keys.push(...result[1]);
    } while (cursor !== '0');
    return keys;
  } catch { return keys; }
}
