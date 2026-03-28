// ── lib/llm.js ───────────────────────────────────────────────────────────────
// Capa de abstracción multi-LLM
// Primario: Claude (Anthropic) | Fallback: OpenAI (configurable)
// Diseño: agregar nuevos proveedores sin tocar código de negocio

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY    = process.env.OPENAI_API_KEY; // opcional

export const MODELS = {
  // Claude
  claude_haiku:  'claude-haiku-4-5-20251001',
  claude_sonnet: 'claude-sonnet-4-6',
  claude_opus:   'claude-opus-4-6',
  // OpenAI (fallback futuro)
  gpt4o:         'gpt-4o',
  gpt4o_mini:    'gpt-4o-mini'
};

// ── Proveedores ───────────────────────────────────────────────────────────────

async function callAnthropic({ model, system, messages, maxTokens }) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY no configurada');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':    'application/json',
      'x-api-key':       ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic ${res.status}: ${err}`);
  }
  const data = await res.json();
  return data.content?.[0]?.text?.trim() || '';
}

async function callOpenAI({ model, system, messages, maxTokens }) {
  if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY no configurada');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model,
      max_tokens:  maxTokens,
      temperature: 0.3,
      messages:    [{ role: 'system', content: system }, ...messages]
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI ${res.status}: ${err}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

// ── Router de proveedor ───────────────────────────────────────────────────────

function getProvider(modelId) {
  if (modelId.startsWith('claude')) return 'anthropic';
  if (modelId.startsWith('gpt'))    return 'openai';
  return 'anthropic';
}

// ── Función principal ─────────────────────────────────────────────────────────
/**
 * Llama al LLM configurado con fallback automático.
 *
 * @param {Object}  opts
 * @param {string}  opts.task       - nombre para logging
 * @param {string}  opts.system     - system prompt
 * @param {string}  opts.user       - mensaje del usuario
 * @param {string}  [opts.model]    - clave de MODELS (default: 'claude_haiku')
 * @param {number}  [opts.maxTokens]
 * @param {boolean} [opts.parseJson] - parsea la respuesta como JSON
 * @returns {Promise<string|Object>}
 */
export async function llmCall({
  task,
  system,
  user,
  model      = 'claude_haiku',
  maxTokens  = 1024,
  parseJson  = false
}) {
  const modelId  = MODELS[model] || model;
  const provider = getProvider(modelId);
  const messages = [{ role: 'user', content: user }];

  let raw;
  try {
    if (provider === 'anthropic') {
      raw = await callAnthropic({ model: modelId, system, messages, maxTokens });
    } else if (provider === 'openai') {
      raw = await callOpenAI({ model: modelId, system, messages, maxTokens });
    } else {
      throw new Error(`Proveedor desconocido: ${provider}`);
    }
    console.log(`[llm] ${task} OK (${modelId})`);
  } catch (primaryErr) {
    console.error(`[llm] ${task} error primario (${modelId}):`, primaryErr.message);

    // Fallback: si falla Claude intenta OpenAI y viceversa
    if (provider === 'anthropic' && OPENAI_API_KEY) {
      console.warn(`[llm] ${task} — fallback a OpenAI gpt-4o-mini`);
      try {
        raw = await callOpenAI({ model: MODELS.gpt4o_mini, system, messages, maxTokens });
        console.log(`[llm] ${task} fallback OK (gpt-4o-mini)`);
      } catch (fallbackErr) {
        console.error(`[llm] ${task} fallback error:`, fallbackErr.message);
        throw primaryErr; // relanza error original
      }
    } else {
      throw primaryErr;
    }
  }

  if (!parseJson) return raw;

  const clean = raw
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i,    '')
    .replace(/```\s*$/,     '')
    .trim();

  try {
    return JSON.parse(clean);
  } catch {
    throw new Error(`[llm] ${task}: JSON parse fallido — ${clean.slice(0, 200)}`);
  }
}
