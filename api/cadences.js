// ── api/cadences.js ───────────────────────────────────────────────────────────
// Cron job: cadencias de nurturing D+1 / D+3 / D+7 + reactivación semanal
// Schedule: "0 15 * * *" (10am Lima = 15:00 UTC)
//
// Flujo:
// 1. Procesa cadences pendientes en Supabase (D+1/D+3/D+7)
// 2. Genera mensajes personalizados con Claude
// 3. Alerta por Telegram para envío manual (o futuro envío automático)
// 4. Detecta leads sin actividad >14 días → reactivación semanal

import { sbSelect, sbUpdate, sbInsert, logEvent } from '../lib/supabase.js';
import { sendTelegram }                            from '../lib/telegram.js';
import { llmCall }                                 from '../lib/llm.js';
import { SECTOR_MAP, OBJ_MAP, SCORE_EMOJI }        from '../lib/scoring.js';

const CRON_SECRET = process.env.CRON_SECRET;

// ── Cadences D+1 / D+3 / D+7 ─────────────────────────────────────────────────

async function processPendingCadences() {
  const now      = new Date().toISOString();
  const pending  = await sbSelect('cadences', {
    filters: {
      send_at:       `lte.${now}`,
      sent_at:       'is.null',
      cancelled_at:  'is.null'
    },
    limit: 20
  });

  if (!pending.length) {
    console.log('[cadences] Sin cadencias pendientes');
    return 0;
  }

  console.log(`[cadences] Procesando ${pending.length} cadencias`);

  const cadenceMessages = {
    1: (lead) => `Genera un mensaje de nurturing Día 1 para ${lead.nombre} de ${lead.empresa}.
Sector: ${SECTOR_MAP[lead.sector] || lead.sector}. Objetivo: ${OBJ_MAP[lead.objetivo] || lead.objetivo}.
Incluye un caso de uso concreto de Treevü en su sector. Máximo 100 palabras. Sin saludos genéricos.`,
    3: (lead) => `Genera un mensaje de nurturing Día 3 para ${lead.nombre} de ${lead.empresa}.
Sector: ${SECTOR_MAP[lead.sector] || lead.sector}. Colaboradores: ${lead.colaboradores}.
Referencia el ahorro estimado en rotación y ofrece ver la calculadora personalizada. Máximo 100 palabras.`,
    7: (lead) => `Genera un mensaje de nurturing Día 7 para ${lead.nombre} de ${lead.empresa}.
Es el último touch de la secuencia. CTA directo: agendar 20 minutos.
Usa la escasez del Programa Fundadores (4 cupos). Máximo 80 palabras. Sin presión exagerada.`
  };

  const system = `Eres el asistente de ventas de Treevü. Escribes mensajes de nurturing directos, con valor real.
Tono: ejecutivo, peruano, sin relleno. Jamás uses "espero que estés bien" ni frases genéricas.`;

  let processed = 0;
  for (const cad of pending) {
    try {
      // Obtener datos del lead
      const leadRows = await sbSelect('leads', {
        filters: { id: `eq.${cad.lead_id}` },
        limit:   1
      });
      const lead = leadRows?.[0];
      if (!lead) {
        await sbUpdate('cadences', { id: cad.id }, { cancelled_at: now });
        continue;
      }

      // Cancelar si lead ya está en estado avanzado
      if (['Piloto activo', 'Firmado', 'Descartado', 'Reunión agendada'].includes(lead.estado)) {
        await sbUpdate('cadences', { id: cad.id }, { cancelled_at: now });
        console.log(`[cadences] Cancelada cad D+${cad.day_number} para ${lead.email} (estado: ${lead.estado})`);
        continue;
      }

      const promptFn = cadenceMessages[cad.day_number] || cadenceMessages[1];
      const mensaje  = await llmCall({
        task:      `cadence-d${cad.day_number}`,
        system,
        user:      promptFn(lead),
        model:     'claude_haiku',
        maxTokens: 300
      });

      // Notificar por Telegram con el mensaje generado
      const emoji = SCORE_EMOJI[lead.score] || '·';
      const msg = `📬 *Cadencia D+${cad.day_number} — ${lead.empresa}*\n` +
        `${emoji} ${lead.score} · ${lead.probabilidad}%\n\n` +
        `*Para:* ${lead.nombre} <${lead.email}>\n\n` +
        `*Mensaje sugerido:*\n${mensaje}\n\n` +
        `_Envía desde hello@gettreevu.com_`;

      await sendTelegram(msg);

      // Marcar como enviada
      await sbUpdate('cadences', { id: cad.id }, { sent_at: now });
      await logEvent(lead.email, `cadence_d${cad.day_number}_sent`, {
        day_number: cad.day_number,
        mensaje
      }, { leadId: lead.id });

      processed++;
      console.log(`[cadences] D+${cad.day_number} procesada para ${lead.email}`);
    } catch (err) {
      console.error(`[cadences] Error en cad ${cad.id}:`, err.message);
    }
  }

  return processed;
}

// ── Reactivación semanal ──────────────────────────────────────────────────────
// Leads ALTO/MEDIO sin actividad en 14+ días que no tengan cad de reactivación reciente

async function processWeeklyReactivations() {
  const hace14dias = new Date(Date.now() - 14 * 86400000).toISOString();

  let staleLeads;
  try {
    staleLeads = await sbSelect('leads', {
      filters: {
        updated_at: `lte.${hace14dias}`,
        estado:     'not.in.(Piloto activo,Firmado,Descartado)'
      },
      select: 'id,email,nombre,empresa,sector,colaboradores,objetivo,score,probabilidad,estado,updated_at',
      limit:  10
    });
  } catch {
    staleLeads = [];
  }

  // Filtrar solo ALTO/MEDIO
  const candidates = (staleLeads || []).filter(l => ['ALTO', 'MEDIO'].includes(l.score));

  if (!candidates.length) {
    console.log('[cadences] Sin candidatos de reactivación semanal');
    return 0;
  }

  let summary = `🔄 *Reactivación semanal — ${candidates.length} lead(s)*\n\n`;
  for (const lead of candidates) {
    const daysSince = Math.floor((Date.now() - new Date(lead.updated_at)) / 86400000);
    const emoji     = lead.score === 'ALTO' ? '🔥' : '🟡';
    summary += `${emoji} ${lead.nombre} — ${lead.empresa} _(${daysSince}d sin actividad)_\n`;
    summary += `📧 ${lead.email}\n\n`;

    await logEvent(lead.email, 'reactivation_candidate', { days_since: daysSince }, { leadId: lead.id });
  }

  summary += `\n💡 Usa \`/reactivar <email>\` para generar mensaje personalizado`;
  await sendTelegram(summary);
  return candidates.length;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const authHeader = req.headers['authorization'];
  const secret     = req.query?.secret;
  const isVercelCron = authHeader === `Bearer ${CRON_SECRET}`;
  const isManual     = secret && secret === CRON_SECRET;

  if (!isVercelCron && !isManual) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('[cadences] Iniciando procesamiento de cadencias...');
    const [cadProcessed, reactivations] = await Promise.all([
      processPendingCadences(),
      processWeeklyReactivations()
    ]);

    console.log(`[cadences] OK — ${cadProcessed} cadencias + ${reactivations} reactivaciones`);
    return res.status(200).json({ success: true, cadencias: cadProcessed, reactivaciones: reactivations });
  } catch (err) {
    console.error('[cadences] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
