// ── api/calendly-webhook.js ───────────────────────────────────────────────────
// Recibe webhooks de Calendly cuando un lead agenda una reunión
// Flujo: invitee.created → Supabase + Notion → briefing pre-reunión → Telegram

import { getLeadByEmail, updateLead, logEvent,
         logScoreHistory, sbInsert }               from '../lib/supabase.js';
import { findLeadByEmail, updateLeadEstado }       from '../lib/notion.js';
import { sendTelegram }                            from '../lib/telegram.js';
import { applyBehavioralSignals, SCORE_EMOJI,
         SECTOR_MAP, OBJ_MAP }                     from '../lib/scoring.js';
import { llmCall }                                 from '../lib/llm.js';

// ── Briefing pre-reunión ──────────────────────────────────────────────────────
async function generateBriefing(lead) {
  const system = `Eres el asistente de ventas de Treevü. Genera briefings pre-reunión concisos y accionables.
Formato: bullets cortos, tono ejecutivo. Máximo 350 palabras.`;

  const user = `Briefing para reunión con:
- Nombre: ${lead.nombre}
- Empresa: ${lead.empresa}
- Sector: ${SECTOR_MAP[lead.sector] || lead.sector}
- Colaboradores: ${lead.colaboradores}
- Objetivo: ${OBJ_MAP[lead.objetivo] || lead.objetivo}
- Reto: ${lead.problema || 'No especificado'}
- Score: ${lead.score} (${lead.probabilidad}%)
- Análisis: ${lead.razon || 'N/D'}

Incluye: contexto del lead, dolor principal, 2 objeciones probables con respuesta, objetivo de la reunión.`;

  return llmCall({ task: 'pre-meeting-briefing', system, user, model: 'claude_sonnet', maxTokens: 700 });
}

// ── Telegram: notificación de reunión agendada ────────────────────────────────
async function notifyMeetingScheduled(invitee, eventData, lead, briefing) {
  const fechaReunion = new Date(eventData.start_time).toLocaleString('es-PE', {
    timeZone: 'America/Lima',
    weekday: 'long', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });

  const emoji = lead ? (SCORE_EMOJI[lead.score] || '📅') : '📅';
  let msg = `📅 *¡Reunión agendada! — Treevü*\n\n`;
  msg += `👤 *${invitee.name}*\n`;
  msg += `📧 ${invitee.email}\n`;
  msg += `🗓 ${fechaReunion}\n`;
  msg += `📋 ${eventData.name || 'Llamada Treevü 30 min'}\n`;
  if (lead) {
    msg += `\n${emoji} Lead ${lead.score} · ${lead.probabilidad}% prob. cierre\n`;
    msg += `🏢 ${lead.empresa}\n`;
  }
  msg += `\n✅ *Notion + Supabase actualizados*\n`;

  if (briefing) {
    msg += `\n📋 *Briefing pre-reunión:*\n${briefing.slice(0, 800)}`;
    if (briefing.length > 800) msg += '\n_...ver completo con /reunion_';
  }

  msg += `\n\n💡 Después: \`/resultado ${invitee.email} <ganado|perdido|seguimiento|no_show>\``;

  return sendTelegram(msg);
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { event, payload } = req.body || {};

  if (event !== 'invitee.created') {
    return res.status(200).json({ ignored: true, event });
  }

  const invitee   = payload?.invitee || {};
  const eventData = payload?.event   || {};
  const email     = invitee?.email?.toLowerCase();
  const nombre    = invitee?.name;

  if (!email) {
    console.warn('[calendly] Webhook sin email');
    return res.status(200).json({ ok: true, note: 'no email' });
  }

  console.log(`[calendly] Reunión agendada: ${nombre} <${email}>`);

  // Buscar lead en Supabase y Notion en paralelo
  const [sbLead, notionLead] = await Promise.allSettled([
    getLeadByEmail(email),
    findLeadByEmail(email)
  ]);

  const lead    = sbLead.status    === 'fulfilled' ? sbLead.value    : null;
  const nLead   = notionLead.status === 'fulfilled' ? notionLead.value : null;

  const scheduledAt = eventData.start_time || new Date().toISOString();

  // Actualizar Supabase
  if (lead?.id) {
    try {
      // Aplicar señal comportamental: reunión agendada
      const { newProb, newScore, delta, applied } = applyBehavioralSignals(lead.probabilidad || 50, {
        meeting_scheduled: true
      });

      await Promise.all([
        updateLead(email, {
          estado:       'Reunión agendada',
          probabilidad: newProb,
          score:        newScore
        }),
        logEvent(email, 'meeting_scheduled', {
          scheduled_at:  scheduledAt,
          event_name:    eventData.name,
          score_delta:   delta,
          applied_signals: applied
        }, { leadId: lead.id, stageFrom: lead.estado, stageTo: 'Reunión agendada' }),
        logScoreHistory(email, lead.id, newScore, newProb, 'behavioral', {
          meeting_scheduled: true,
          applied
        }),
        // Crear registro en meetings
        sbInsert('meetings', {
          lead_id:      lead.id,
          email,
          scheduled_at: scheduledAt,
          event_name:   eventData.name || 'Llamada Treevü 30 min'
        })
      ]);

      console.log(`[calendly] Supabase actualizado: ${email} → Reunión agendada (score: ${newScore} ${newProb}%)`);
    } catch (err) {
      console.error('[calendly] Supabase error:', err.message);
    }
  }

  // Actualizar Notion
  if (nLead?.id) {
    try {
      const nota = `Reunión agendada vía Calendly el ${new Date().toLocaleDateString('es-PE', { timeZone: 'America/Lima' })}. Evento: ${eventData.name || 'Llamada 30 min'}`;
      await updateLeadEstado(nLead.id, 'Reunión agendada', nota);
      console.log(`[calendly] Notion actualizado: ${email}`);
    } catch (err) {
      console.error('[calendly] Notion error:', err.message);
    }
  }

  // Generar briefing si tenemos datos del lead
  let briefing = null;
  if (lead?.nombre) {
    try {
      briefing = await generateBriefing(lead);
      await logEvent(email, 'briefing_generated', {}, { leadId: lead?.id });
    } catch (err) {
      console.error('[calendly] Briefing error:', err.message);
    }
  }

  // Notificar Telegram
  try {
    await notifyMeetingScheduled(invitee, eventData, lead, briefing);
  } catch (err) {
    console.error('[calendly] Telegram error:', err.message);
  }

  return res.status(200).json({ success: true });
}
