import { askClaude }    from './lib/anthropic.js';
import { detectGender } from './lib/validators.js';
import { setCorsHeaders, isOriginAllowed, checkRateLimit } from './lib/cors.js';
import { logRequest, logError, logRateLimit, logWebhookReject } from './lib/metrics.js';
import { CHATBOT_VU }   from './lib/prompts.js';

// ── Detecta email y datos clave en la conversación ────────────────────────
function extractLeadFromChat(messages) {
  const text = messages.map(m => m.content).join(' ');
  const email = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)?.[0];
  if (!email) return null;

  const empresa = text.match(/(?:empresa|compañía|trabajo en|soy de|de\s+)([A-ZÁÉÍÓÚ][^\n,.?!]{2,30})/i)?.[1]?.trim();
  const nombre  = text.match(/(?:me llamo|soy|nombre[:\s]+)([A-ZÁÉÍÓÚ][a-záéíóú]+ [A-ZÁÉÍÓÚ][a-záéíóú]+)/i)?.[1]?.trim();
  const gender  = detectGender(nombre);

  // Resumen de la conversación (últimos 4 turnos del usuario — ampliado)
  const userMsgs = messages.filter(m => m.role === 'user').slice(-4).map(m => m.content).join(' | ');

  return { email, empresa, nombre, gender, resumen: userMsgs.slice(0, 600) };
}

async function sendToCRM(lead) {
  try {
    await fetch('https://gettreevu.com/api/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': process.env.LEAD_WEBHOOK_SECRET },
      body: JSON.stringify({
        name:      lead.nombre || 'Prospecto Web Chat',
        email:     lead.email,
        company:   lead.empresa || '',
        sector:    lead.profile?.sector || '',
        employees: lead.profile?.size   || '',
        objetivo:  lead.profile?.objetivo || '',
        message:   lead.resumen,
        source:    'Vü Chat (gettreevu.com)',
      }),
    });
  } catch (err) {
    console.error('[chat] CRM error:', err.message);
  }
}

export default async function handler(req, res) {
  const t0 = Date.now();
  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!isOriginAllowed(req)) {
    logWebhookReject('chat', 'origin_blocked', { origin: req.headers?.origin });
    return res.status(403).json({ error: 'Forbidden' });
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '';
  const rl = await checkRateLimit(ip);
  if (!rl.allowed) {
    logRateLimit(ip, '/api/chat');
    res.setHeader('Retry-After', String(rl.retryAfter));
    return res.status(429).json({ error: 'Too many requests' });
  }

  const { messages, profile } = req.body || {};
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages required' });
  }
  // Bloquear inyección de roles no permitidos
  const validRoles = new Set(['user', 'assistant']);
  if (messages.some(m => !validRoles.has(m?.role) || typeof m?.content !== 'string')) {
    return res.status(400).json({ error: 'messages inválidos' });
  }

  // Si ya completó el flujo de calificación, enriquecer el system prompt
  const system = (profile?.sector)
    ? CHATBOT_VU + `\n\nCONTEXTO DEL PROSPECTO:\n- Sector: ${profile.sector}\n- Colaboradores: ${profile.size || 'No indicado'}\n- Objetivo: ${profile.objetivo || 'No indicado'}\nAdapta tu respuesta a este perfil. Sé específico con los números de impacto relevantes.`
    : CHATBOT_VU;

  try {
    const reply = (await askClaude(null, { system, messages, maxTokens: 300 })) || 'Escribenos a hello@gettreevu.com.';

    // ── Captura al CRM si detectamos email en la conversación ──────────
    const leadData = extractLeadFromChat(messages);
    if (leadData) {
      leadData.profile = profile || {};
      sendToCRM(leadData); // fire-and-forget
    }

    logRequest('/api/chat', 'POST', 200, Date.now() - t0, { leadCaptured: !!leadData });
    return res.status(200).json({ reply, leadCaptured: !!leadData });
  } catch (err) {
    logError('chat', err);
    return res.status(500).json({ error: 'Error del servidor' });
  }
}
