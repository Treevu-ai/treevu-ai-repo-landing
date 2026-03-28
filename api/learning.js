// ── api/learning.js ───────────────────────────────────────────────────────────
// Cron job semanal: loop de aprendizaje
// Schedule: "0 12 * * 1" (lunes 7am Lima = 12:00 UTC)
//
// Flujo:
// 1. Lee learning_data (resultados de reuniones completadas)
// 2. Agrupa por segmento (sector + colaboradores + objetivo)
// 3. Calcula win rate real por segmento
// 4. Upserta scoring_calibration → el scoring usa estos datos en la siguiente ejecución
// 5. Evalúa si el score inicial fue preciso (calibración del modelo)
// 6. Reporta resumen a Telegram

import { sbSelect, sbInsert, sbUpdate } from '../lib/supabase.js';
import { sendTelegram }                 from '../lib/telegram.js';
import { llmCall }                      from '../lib/llm.js';

const CRON_SECRET = process.env.CRON_SECRET;

// ── Agregación de resultados por segmento ─────────────────────────────────────

function buildSegmentKey(sector, colaboradores, objetivo) {
  return `${sector || 'otro'}_${colaboradores || 'desconocido'}_${objetivo || 'otro'}`;
}

async function aggregateLearningData() {
  const data = await sbSelect('learning_data', {
    select: 'sector,colaboradores,objetivo,score_inicial,probabilidad_inicial,result,converted,dias_hasta_reunion',
    limit:  500
  });

  if (!data?.length) return {};

  // Agrupar por segmento
  const segments = {};
  for (const row of data) {
    const key = buildSegmentKey(row.sector, row.colaboradores, row.objetivo);
    if (!segments[key]) {
      segments[key] = {
        sector:        row.sector,
        colaboradores: row.colaboradores,
        objetivo:      row.objetivo,
        total:         0,
        ganados:       0,
        perdidos:      0,
        seguimiento:   0,
        no_show:       0,
        total_dias:    0,
        dias_count:    0,
        // Para calibración del modelo: cuántas veces fue preciso
        score_precision: { ALTO: { correct: 0, total: 0 }, MEDIO: { correct: 0, total: 0 }, BAJO: { correct: 0, total: 0 } }
      };
    }

    const seg = segments[key];
    seg.total++;
    if (row.converted)              seg.ganados++;
    if (row.result === 'perdido')   seg.perdidos++;
    if (row.result === 'seguimiento') seg.seguimiento++;
    if (row.result === 'no_show')   seg.no_show++;
    if (row.dias_hasta_reunion) {
      seg.total_dias += row.dias_hasta_reunion;
      seg.dias_count++;
    }

    // Precisión del score inicial
    if (row.score_inicial && seg.score_precision[row.score_inicial]) {
      seg.score_precision[row.score_inicial].total++;
      // Score fue preciso si ALTO→ganado, MEDIO→seguimiento o ganado, BAJO→perdido
      const wasPrecise =
        (row.score_inicial === 'ALTO'  && row.result === 'ganado') ||
        (row.score_inicial === 'MEDIO' && ['ganado', 'seguimiento'].includes(row.result)) ||
        (row.score_inicial === 'BAJO'  && row.result === 'perdido');
      if (wasPrecise) seg.score_precision[row.score_inicial].correct++;
    }
  }

  return segments;
}

// ── Upsert calibración ────────────────────────────────────────────────────────

async function updateCalibrations(segments) {
  const now     = new Date().toISOString();
  const updated = [];

  for (const [key, seg] of Object.entries(segments)) {
    if (seg.total < 2) continue; // mínimo 2 casos para calibrar

    const winRate     = ((seg.ganados / seg.total) * 100).toFixed(2);
    const avgDias     = seg.dias_count > 0 ? (seg.total_dias / seg.dias_count).toFixed(1) : null;

    try {
      // Intentar update primero
      const existing = await sbSelect('scoring_calibration', {
        filters: { segment_key: `eq.${key}` },
        limit: 1
      });

      const calData = {
        segment_key:   key,
        sector:        seg.sector,
        colaboradores: seg.colaboradores,
        objetivo:      seg.objetivo,
        win_rate:      parseFloat(winRate),
        sample_count:  seg.total,
        ganados:       seg.ganados,
        perdidos:      seg.perdidos,
        avg_days_to_close: avgDias ? parseFloat(avgDias) : null,
        last_updated:  now
      };

      if (existing?.[0]) {
        await sbUpdate('scoring_calibration', { segment_key: key }, calData);
      } else {
        await sbInsert('scoring_calibration', calData);
      }
      updated.push({ key, winRate, total: seg.total });
    } catch (err) {
      console.error(`[learning] Error calibración ${key}:`, err.message);
    }
  }

  return updated;
}

// ── Insight automático con Claude ─────────────────────────────────────────────

async function generateLearningInsight(segments, calibrations) {
  const summary = Object.entries(segments)
    .filter(([, s]) => s.total >= 2)
    .map(([key, s]) => ({
      segmento:   key,
      total:      s.total,
      win_rate:   `${((s.ganados / s.total) * 100).toFixed(0)}%`,
      ganados:    s.ganados,
      perdidos:   s.perdidos
    }));

  if (!summary.length) return null;

  try {
    const insight = await llmCall({
      task:   'learning-insight',
      system: `Eres el analista de revenue de Treevü. Analiza datos de conversión y genera recomendaciones accionables.
Sé directo, concreto, máximo 200 palabras. Formato: bullets.`,
      user:   `Resultados de reuniones por segmento:\n${JSON.stringify(summary, null, 2)}\n\nIdentifica: 1) Segmentos con mejor win rate, 2) Segmentos que el scoring sobreestima, 3) Una acción concreta de mejora.`,
      model:   'claude_haiku',
      maxTokens: 400
    });
    return insight;
  } catch {
    return null;
  }
}

// ── Reporte a Telegram ────────────────────────────────────────────────────────

async function sendLearningReport(segments, calibrations, insight) {
  const totalData = Object.values(segments).reduce((acc, s) => {
    acc.total    += s.total;
    acc.ganados  += s.ganados;
    acc.perdidos += s.perdidos;
    return acc;
  }, { total: 0, ganados: 0, perdidos: 0 });

  const globalWinRate = totalData.total > 0
    ? ((totalData.ganados / totalData.total) * 100).toFixed(1)
    : 'N/D';

  let msg = `🧠 *Loop de Aprendizaje — Treevü*\n`;
  msg += `_${new Date().toLocaleDateString('es-PE', { timeZone: 'America/Lima', weekday: 'long', day: 'numeric', month: 'long' })}_\n\n`;

  msg += `*Resultados globales:*\n`;
  msg += `📊 Total reuniones: ${totalData.total}\n`;
  msg += `🏆 Ganados: ${totalData.ganados} · Perdidos: ${totalData.perdidos}\n`;
  msg += `📈 Win rate global: *${globalWinRate}%*\n\n`;

  if (calibrations.length) {
    msg += `*Segmentos calibrados (${calibrations.length}):*\n`;
    for (const c of calibrations.slice(0, 5)) {
      msg += `· ${c.key.replace(/_/g, '/')} → ${c.winRate}% win (n=${c.total})\n`;
    }
    if (calibrations.length > 5) msg += `_...y ${calibrations.length - 5} más_\n`;
    msg += '\n';
  }

  if (insight) {
    msg += `*🤖 Insight automático:*\n${insight}\n\n`;
  }

  msg += `_Calibración aplicada al scoring de nuevos leads_`;
  await sendTelegram(msg);
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  const authHeader   = req.headers['authorization'];
  const secret       = req.query?.secret;
  const isVercelCron = authHeader === `Bearer ${CRON_SECRET}`;
  const isManual     = secret && secret === CRON_SECRET;

  if (!isVercelCron && !isManual) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('[learning] Iniciando loop de aprendizaje...');

    const segments     = await aggregateLearningData();
    const segCount     = Object.keys(segments).length;
    const totalRows    = Object.values(segments).reduce((s, seg) => s + seg.total, 0);

    console.log(`[learning] ${segCount} segmentos, ${totalRows} casos totales`);

    const calibrations = await updateCalibrations(segments);
    const insight      = await generateLearningInsight(segments, calibrations);

    await sendLearningReport(segments, calibrations, insight);

    console.log(`[learning] OK — ${calibrations.length} segmentos calibrados`);
    return res.status(200).json({
      success: true,
      segmentos:   segCount,
      calibrados:  calibrations.length,
      total_casos: totalRows
    });
  } catch (err) {
    console.error('[learning] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
