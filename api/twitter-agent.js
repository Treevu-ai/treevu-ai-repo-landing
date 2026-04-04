/**
 * api/twitter-agent.js — Publica tweets desde el CEO Bot
 *
 * POST /api/twitter-agent
 * Headers: Authorization: Bearer CRON_SECRET
 * Body:
 *   { action: 'draft',   text?: string }  → genera/pule y devuelve draft (no publica)
 *   { action: 'publish', text: string  }  → publica el texto recibido y devuelve URL
 */

import { askClaude }   from './lib/anthropic.js';
import { postTweet }   from './lib/twitter.js';

const CRON_SECRET = process.env.CRON_SECRET;

// Temas rotativos (misma lista que content-reminder para coherencia)
const TEMAS = [
  'rotación de personal: el costo oculto que sangra a las empresas peruanas',
  'cómo el estrés financiero reduce la productividad de tus colaboradores',
  'EWA en Perú: qué es el acceso al salario devengado y por qué importa ahora',
  'employer branding: mejorar el bienestar financiero reduce rotación 15-40%',
  'el colaborador endeudado no rinde — datos y soluciones reales',
  'retener talento cuesta menos que reclutar — con números',
  'las finanzas personales de tus colaboradores son tu problema de negocio',
];

function weekTema() {
  const weekNum = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 1)) / (7 * 864e5));
  return TEMAS[weekNum % TEMAS.length];
}

async function generateDraft(rawText) {
  // Si hay texto del CEO → Claude lo pule para Twitter
  // Si no → Claude genera desde cero sobre el tema de la semana
  const prompt = rawText
    ? `Eres el equipo de contenido de Treevü (startup B2B EWA, Perú). El CEO quiere publicar este tweet:

"${rawText}"

Pulelo para que sea más directo, con gancho en la primera línea y cierre con una pregunta o dato concreto. Máximo 270 caracteres. Sin hashtags genéricos. Sin emojis exagerados. Voz experta, tono humano. Devuelve SOLO el texto del tweet.`
    : `Eres el equipo de contenido de Treevü (startup B2B EWA, Perú — plataforma que permite a trabajadores retirar su salario ganado antes del día de pago, sin costo para ellos ni riesgo para la empresa).

Escribe un tweet sobre: "${weekTema()}"

Reglas:
- Máximo 270 caracteres
- Primer línea = gancho que detiene el scroll
- Dato concreto o pregunta al final
- Tono directo, peruano, B2B (audiencia: gerentes RRHH y CEOs de empresas 200-2000 personas)
- Sin hashtags genéricos (#RRHH #Peru está prohibido)
- Máximo 1 emoji si aporta

Devuelve SOLO el texto del tweet.`;

  return askClaude(prompt, { maxTokens: 150 });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = req.headers.authorization || '';
  if (!auth.includes(CRON_SECRET)) return res.status(401).json({ error: 'Unauthorized' });

  const { action, text } = req.body || {};

  if (!action || !['draft', 'publish'].includes(action)) {
    return res.status(400).json({ error: 'action debe ser "draft" o "publish"' });
  }

  // ── Draft: generar/pulear texto, devolver sin publicar ────────────────────
  if (action === 'draft') {
    try {
      const draft = await generateDraft(text || '');
      if (!draft) return res.status(500).json({ error: 'Claude no pudo generar el draft' });
      return res.status(200).json({ draft: draft.trim(), chars: draft.trim().length });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── Publish: postear el texto recibido ────────────────────────────────────
  if (action === 'publish') {
    if (!text?.trim()) return res.status(400).json({ error: 'text es requerido para publish' });
    try {
      const result = await postTweet(text.trim());
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }
}

export const config = { maxDuration: 30 };
