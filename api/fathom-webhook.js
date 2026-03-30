// api/fathom-webhook.js — Recibe webhooks de Fathom al terminar una llamada
//
// Setup en Fathom: Settings → Integrations → Webhooks
//   URL: https://gettreevu.com/api/fathom-webhook
//   Events: call.completed
//
// Flujo:
//   1. Recibe transcript + summary + action_items de Fathom
//   2. Identifica al lead en Notion por email del attendee
//   3. Claude extrae: dolor confirmado, objeciones, acuerdos, próximo paso
//   4. Actualiza Notas en Notion con el resumen estructurado
//   5. Notifica al CEO por Telegram con los puntos clave

import { NOTION }                        from './lib/constants.js';
import { notionQuery, notionPatch, getProp } from './lib/notion.js';
import { askClaude }                     from './lib/anthropic.js';
import { sendMessage }                   from './lib/telegram.js';
import { captureException }              from './lib/sentry.js';

const BOT_TOKEN       = process.env.TELEGRAM_BOT_TOKEN;
const CEO_CHAT_ID     = process.env.TELEGRAM_CHAT_ID;
const FATHOM_SECRET   = process.env.FATHOM_WEBHOOK_SECRET;
const GMAIL_FROM      = process.env.GMAIL_FROM || 'hello@gettreevu.com';

const send = (text) => sendMessage(BOT_TOKEN, CEO_CHAT_ID, text);

// ── Buscar lead por email ─────────────────────────────────────────────────────
async function findLeadByEmail(email) {
  const data = await notionQuery(NOTION.CRM_DB, {
    property: 'Email', email: { equals: email },
  }, 1);
  return data.results?.[0] || null;
}

// ── Extraer email del prospecto (excluir emails de Treevü) ────────────────────
function extractProspectEmail(attendees = []) {
  const TREEVÜ_DOMAINS = ['gettreevu.com', 'treevu.com'];
  for (const a of attendees) {
    const email = a.email || a.emailAddress || '';
    if (!email) continue;
    const domain = email.split('@')[1] || '';
    if (!TREEVÜ_DOMAINS.some(d => domain.includes(d))) return email;
  }
  return null;
}

// ── Analizar transcript con Claude ────────────────────────────────────────────
async function analyzeTranscript({ summary, transcript, actionItems, empresa }) {
  const input = summary || transcript || '';
  if (!input) return null;

  const userPrompt = `Analiza estas notas de reunión comercial de Treevü con ${empresa || 'un prospecto'} y extrae en formato estructurado:

${input}

${actionItems?.length ? `\nAction items detectados:\n${actionItems.map(a => `- ${a}`).join('\n')}` : ''}

Devuelve un JSON con:
{
  "dolor_confirmado": "dolor principal confirmado en la llamada (1 frase)",
  "objeciones": "objeciones mencionadas o vacío si ninguna",
  "acuerdos": "acuerdos o compromisos de la llamada",
  "siguiente_paso": "próximo paso concreto con fecha si se mencionó",
  "nivel_interes": "ALTO|MEDIO|BAJO basado en la conversación",
  "resumen": "resumen ejecutivo de 2-3 líneas"
}

Devuelve SOLO el JSON, sin markdown.`;

  const raw = await askClaude(userPrompt, { maxTokens: 600 });
  if (!raw) return null;
  try { return JSON.parse(raw.trim()); }
  catch { return { resumen: raw.trim() }; }
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Verificar secret si está configurado
  if (FATHOM_SECRET) {
    const sig = req.headers['x-fathom-signature'] || req.headers['x-webhook-secret'] || '';
    if (sig !== FATHOM_SECRET) {
      console.warn('[fathom] Firma inválida — request rechazado');
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const body = req.body || {};

  // Fathom envía: { event, data: { id, title, date, duration, summary, transcript, action_items, attendees, recording_url } }
  const event   = body.event || body.type || '';
  const data    = body.data  || body.payload || body;

  if (!['call.completed', 'meeting.completed', 'recording.completed'].includes(event)) {
    return res.status(200).json({ ignored: true, event });
  }

  const title       = data.title       || data.name || '';
  const summary     = data.summary     || data.ai_summary || '';
  const transcript  = data.transcript  || '';
  const actionItems = data.action_items || data.actionItems || [];
  const attendees   = data.attendees   || data.participants || [];
  const recordingUrl = data.recording_url || data.recordingUrl || '';

  console.log(`[fathom] Llamada recibida: "${title}" — ${attendees.length} asistentes`);

  try {
    // Identificar lead
    const prospectEmail = extractProspectEmail(attendees);
    if (!prospectEmail) {
      console.warn('[fathom] No se encontró email de prospecto en attendees');
      return res.status(200).json({ ok: true, note: 'no prospect email' });
    }

    const lead    = await findLeadByEmail(prospectEmail);
    const empresa = lead ? getProp(lead, 'Empresa') || '' : prospectEmail;

    // Analizar con Claude
    const insights = await analyzeTranscript({ summary, transcript, actionItems, empresa });

    // Construir nota para Notion
    const fecha   = new Date().toLocaleDateString('es-PE', { timeZone: 'America/Lima' });
    const notaPartes = [
      `📞 Llamada ${fecha}${recordingUrl ? ` · [Grabación](${recordingUrl})` : ''}`,
      insights?.resumen        ? `📝 ${insights.resumen}` : (summary || '').slice(0, 300),
      insights?.dolor_confirmado ? `🔴 Dolor: ${insights.dolor_confirmado}` : null,
      insights?.objeciones       ? `⚠️ Objeciones: ${insights.objeciones}` : null,
      insights?.acuerdos         ? `✅ Acuerdos: ${insights.acuerdos}` : null,
      insights?.siguiente_paso   ? `⏭ Sig. paso: ${insights.siguiente_paso}` : null,
    ].filter(Boolean).join('\n');

    // Actualizar Notion
    if (lead) {
      const notasActuales = getProp(lead, 'Notas') || '';
      const notasNuevas   = notasActuales ? `${notasActuales}\n\n${notaPartes}` : notaPartes;
      await notionPatch(lead.id, {
        Notas: { rich_text: [{ text: { content: notasNuevas.slice(0, 2000) } }] },
        ...(insights?.nivel_interes === 'ALTO' ? { Score: { select: { name: 'ALTO' } } } : {}),
      });
      console.log(`[fathom] Notion actualizado: ${empresa}`);
    } else {
      console.warn(`[fathom] Lead no encontrado para ${prospectEmail} — solo notificando`);
    }

    // Notificar CEO
    const div = '─────────────────';
    let msg = `📞 *Llamada completada · ${empresa}*\n${div}\n\n`;
    if (insights?.resumen)         msg += `${insights.resumen}\n\n`;
    if (insights?.dolor_confirmado) msg += `🔴 *Dolor:* ${insights.dolor_confirmado}\n`;
    if (insights?.objeciones)       msg += `⚠️ *Objeciones:* ${insights.objeciones}\n`;
    if (insights?.acuerdos)         msg += `✅ *Acuerdos:* ${insights.acuerdos}\n`;
    if (insights?.siguiente_paso)   msg += `⏭ *Sig. paso:* ${insights.siguiente_paso}\n`;
    if (insights?.nivel_interes)    msg += `\n🎯 Interés estimado: *${insights.nivel_interes}*\n`;
    if (recordingUrl)               msg += `\n🎬 [Ver grabación](${recordingUrl})\n`;
    if (lead)                       msg += `\n${div}\n_Notas guardadas en Notion_`;
    else                            msg += `\n${div}\n_Lead no encontrado en CRM para ${prospectEmail}_`;

    await send(msg);

    return res.status(200).json({ ok: true, empresa, insights });

  } catch (err) {
    console.error('[fathom] Error:', err.message);
    captureException(err, { path: '/api/fathom-webhook' });
    return res.status(500).json({ error: err.message });
  }
}
