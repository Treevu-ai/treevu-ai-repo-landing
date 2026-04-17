// api/lib/openai.js — Helper centralizado para OpenAI API (GPT-3.5) vía OpenClaw gateway

const MODEL   = process.env.OPENAI_MODEL || 'gpt-3.5-turbo';
const API_URL = process.env.OPENAI_API_URL || 'https://api.openai.com/v1/chat/completions';

export async function askClaude(userPrompt, { system, maxTokens = 250, messages } = {}) {
  const apiKey = process.env.OPENAI_API_KEY || process.env.OPENCLAW_TOKEN;
  if (!apiKey) {
    console.warn('[openai] OPENAI_API_KEY / OPENCLAW_TOKEN no configurada');
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
  const timeout    = setTimeout(() => controller.abort(), 60000);

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
      const errorText = await res.text();
      console.error('[openai] API error:', res.status, errorText);
      return null;
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error('[openai] Timeout after 60s');
    } else {
      console.error('[openai] fetch error:', err.message);
    }
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
