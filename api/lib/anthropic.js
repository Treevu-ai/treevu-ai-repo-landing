// api/lib/anthropic.js — Helper centralizado para Claude API (via OpenClaw gateway)

const MODEL   = 'claude-sonnet-4-6';
const API_URL = 'https://treevu-openclaw.fly.dev/v1/chat/completions';

/**
 * Llama a Claude con un prompt de usuario y system prompt opcional.
 * @param {string} userPrompt
 * @param {object} opts - { system, maxTokens, messages }
 * @returns {string|null} texto de la respuesta o null si falla
 */
export async function askClaude(userPrompt, { system, maxTokens = 250, messages } = {}) {
  const apiKey = process.env.OPENCLAW_TOKEN;
  if (!apiKey) {
    console.warn('[openclaw] OPENCLAW_TOKEN no configurada');
    return null;
  }

  const msgs = messages ? [...messages] : [{ role: 'user', content: userPrompt }];
  if (system) msgs.unshift({ role: 'system', content: system });

  const body = {
    model:      MODEL,
    max_tokens: maxTokens,
    messages:   msgs,
  };

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 20000); // 20s max

  try {
    const res = await fetch(API_URL, {
      method:  'POST',
      signal:  controller.signal,
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      console.error('[openclaw] API error:', res.status, await res.text());
      return null;
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (err) {
    console.error('[openclaw] fetch error:', err.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
