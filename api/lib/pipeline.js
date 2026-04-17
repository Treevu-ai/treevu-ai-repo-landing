// api/lib/pipeline.js — Pipeline unificado para todos los bots

import { getProp, notionQuery } from './notion.js';
import { NOTION, SCORE_EMOJI, ESTADO_EMOJI } from './constants.js';
import { askClaude } from './anthropic.js';
import { PIPELINE_ACCIONES } from './prompts.js';

const NOTION_CRM_DB       = NOTION.CRM_DB;
const NOTION_EJECUCION_DB = NOTION.EJECUCION_DB;

/**
 * Genera el resumen del pipeline unificado (CRM + ABM)
 * @param {Object} options - { showDetails: boolean, showActions: boolean }
 * @returns {string} mensaje formateado
 */
export async function getPipelineSummary({ showDetails = false, showActions = false } = {}) {
  try {
    const [crmData, abmData] = await Promise.all([
      notionQuery(NOTION_CRM_DB, {
        property: 'Estado',
        select: { does_not_equal: 'Descartado' },
      }, 100),
      notionQuery(NOTION_EJECUCION_DB),
    ]);

    const crmLeads = crmData.results || [];
    const abmLeads = abmData.results || [];

    // CRM stats
    const byEstado = {};
    const byScore  = { ALTO: 0, MEDIO: 0, BAJO: 0 };
    const crmByEstado = {};
    for (const lead of crmLeads) {
      const estado = getProp(lead, 'Estado') || 'Nuevo';
      const score  = getProp(lead, 'Score')  || 'BAJO';
      byEstado[estado] = (byEstado[estado] || 0) + 1;
      if (byScore[score] !== undefined) byScore[score]++;
      if (!crmByEstado[estado]) crmByEstado[estado] = [];
      crmByEstado[estado].push(lead);
    }

    // ABM stats
    const abmByEstado = {};
    let reunConfirmadas = 0;
    for (const lead of abmLeads) {
      const estado = getProp(lead, 'Estado') || 'Sin estado';
      abmByEstado[estado] = (abmByEstado[estado] || 0) + 1;
      if (getProp(lead, 'Reunión Confirmada')) reunConfirmadas++;
    }

    const hora = new Date().toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Lima' });
    const div = '─────────────────';

    let msg = `📊 *Pipeline Treevü* · ${hora} Lima\n\n`;

    // CRM section
    msg += `${div}\n`;
    msg += `📥 *Inbound CRM* · ${crmLeads.length} leads\n`;
    msg += `${SCORE_EMOJI.ALTO} ${byScore.ALTO} ALTO  ${SCORE_EMOJI.MEDIO} ${byScore.MEDIO} MEDIO  ${SCORE_EMOJI.BAJO} ${byScore.BAJO} BAJO\n`;

    if (showDetails) {
      const ordenEstados = ['Nuevo', 'Contactado', 'Reunion', 'Propuesta', 'Cerrado'];
      for (const estado of ordenEstados) {
        const items = crmByEstado[estado] || [];
        if (!items.length) continue;
        const emoji = ESTADO_EMOJI[estado] || '•';
        msg += `${emoji} *${estado}* (${items.length})\n`;
        items.slice(0, 3).forEach(p => {
          const empresa    = getProp(p, 'Empresa') || getProp(p, 'Name') || '—';
          const score      = getProp(p, 'Score')   || '';
          const scoreEmoji = score === 'ALTO' ? '🔥' : score === 'MEDIO' ? '🟡' : '';
          msg += `   ${scoreEmoji} ${empresa}\n`;
        });
        if (items.length > 3) msg += `   _...y ${items.length - 3} más_\n`;
      }
    } else {
      for (const [estado, count] of Object.entries(byEstado)) {
        msg += `${ESTADO_EMOJI[estado] || '·'} ${estado}: ${count}\n`;
      }
    }

    // ABM section
    msg += `\n${div}\n`;
    msg += `📤 *Outbound ABM* · ${abmLeads.length} leads`;
    if (reunConfirmadas) msg += ` · ${reunConfirmadas} reunión(es) confirmada(s)`;
    msg += `\n`;
    for (const [estado, count] of Object.entries(abmByEstado)) {
      msg += `· ${estado}: ${count}\n`;
    }

    return msg;
  } catch (err) {
    console.error('[pipeline] error:', err.message);
    return '❌ Error al consultar el pipeline.';
  }
}

/**
 * Genera 3 acciones IA para el pipeline
 * @returns {string|null} acciones formateadas
 */
export async function getPipelineActions() {
  try {
    const crmData = await notionQuery(NOTION_CRM_DB, {
      property: 'Estado',
      select: { does_not_equal: 'Descartado' },
    }, 100);

    const pages = crmData.results || [];
    const resumen = pages.map(p => {
      const empresa = getProp(p, 'Empresa') || getProp(p, 'Name') || '—';
      const estado  = getProp(p, 'Estado')  || '—';
      const score   = getProp(p, 'Score')   || '—';
      const dias    = Math.floor((Date.now() - new Date(p.last_edited_time)) / 864e5);
      return `${empresa} | ${estado} | Score:${score} | ${dias}d sin actividad`;
    }).join('\n');

    const acciones = await askClaude(resumen, {
      system: PIPELINE_ACCIONES,
      maxTokens: 150,
    });
    return acciones ? `*🎯 3 acciones para hoy:*\n${acciones}` : null;
  } catch (err) {
    console.error('[pipeline] actions error:', err.message);
    return null;
  }
}