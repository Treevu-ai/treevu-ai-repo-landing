// api/lib/abm-cadence.js — Handlers de cadencia ABM: /hoy, /manana, /agenda, /semana, /iniciar

import { notionQuery, getProp } from './notion.js';
import { send, addDays, autoFillFechas, NOTION_EJECUCION_DB } from './abm-helpers.js';

export async function handleIniciar(query) {
  try {
    await send('⏳ _Calculando fechas de cadencia..._');
    const { actualizados, total } = await autoFillFechas(query || null);

    if (total === 0) {
      await send(query
        ? `Sin resultados para _"${query}"_ en la base de ejecución.`
        : '✅ Todos los leads ya tienen fechas asignadas.'
      );
      return;
    }

    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
    await send(
      `✅ *Cadencia iniciada — ${actualizados} lead(s)*\n\n` +
      `📅 Día 1 (LinkedIn): hoy\n` +
      `📧 Día 3 (Email): ${addDays(hoy, 2)}\n` +
      `📞 Día 7 (Seguimiento): ${addDays(hoy, 6)}\n\n` +
      `_Estado → En cadencia_`
    );
  } catch (err) {
    console.error('[abm] /iniciar error:', err.message);
    await send('❌ Error al iniciar cadencia.');
  }
}

export async function handleHoy() {
  const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });

  try {
    const data  = await notionQuery(NOTION_EJECUCION_DB, {
      or: [
        { property: 'Día 1 (LinkedIn)', date: { equals: hoy } },
        { property: 'Día 3 (Email)',    date: { equals: hoy } },
        { property: 'Día 7 (WhatsApp)', date: { equals: hoy } },
      ],
    });

    const leads = (data.results || []).sort((a, b) =>
      (getProp(b, 'Score ICP') || 0) - (getProp(a, 'Score ICP') || 0)
    );

    if (!leads.length) {
      await send(`📋 *Plan de hoy* — ${hoy}\n\n_Sin acciones programadas para hoy._\n\nUsa \`/agenda\` para ver el calendario completo.`);
      return;
    }

    const fechaHoy = new Date().toLocaleDateString('es-PE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Lima' });
    await send(`📋 *Acciones de hoy — ${fechaHoy}* · ${leads.length} lead(s)`);

    for (const lead of leads) {
      const empresa  = getProp(lead, 'Empresa')       || 'Sin empresa';
      const decisor  = getProp(lead, 'Decisor')       || '';
      const email    = getProp(lead, 'Email Decisor') || getProp(lead, 'Email') || '';
      const telefono = getProp(lead, 'Teléfono')      || '';
      const score    = getProp(lead, 'Score ICP')     || '';
      const d1 = getProp(lead, 'Día 1 (LinkedIn)');
      const d3 = getProp(lead, 'Día 3 (Email)');
      const d7 = getProp(lead, 'Día 7 (WhatsApp)');

      let accion = '';
      if (d1 === hoy) accion = '🔵 *LinkedIn* — Enviar conexión + mensaje';
      if (d3 === hoy) accion = '📧 *Email* — Enviar con one-pager adjunto';
      if (d7 === hoy) accion = '📞 *Seguimiento* — Email breve de cierre' + (telefono ? ' o llamada' : '');

      let msg = `━━━━━━━━━━━━━━━\n🏢 *${empresa}*`;
      if (score) msg += ` · ICP ${score}/10`;
      msg += '\n';
      if (decisor)  msg += `👤 ${decisor}\n`;
      if (email)    msg += `📧 ${email}\n`;
      if (telefono) msg += `📞 ${telefono}\n`;
      msg += accion + `\n💬 \`/mensaje ${empresa}\` para generar el texto`;

      await send(msg);
    }
  } catch (err) {
    console.error('[abm] /hoy error:', err.message);
    await send('❌ Error al consultar la base de ejecución.');
  }
}

export async function handleManana() {
  const manana = new Date(Date.now() + 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Lima' });

  try {
    const data  = await notionQuery(NOTION_EJECUCION_DB, {
      or: [
        { property: 'Día 1 (LinkedIn)', date: { equals: manana } },
        { property: 'Día 3 (Email)',    date: { equals: manana } },
        { property: 'Día 7 (WhatsApp)', date: { equals: manana } },
      ],
    });

    const leads = data.results || [];

    if (!leads.length) {
      await send(`📋 *Mañana* (${manana})\n\n_Sin acciones programadas._\n\nUsa \`/agenda\` para ver el calendario completo.`);
      return;
    }

    const fechaLabel = new Date(manana + 'T12:00:00-05:00').toLocaleDateString('es-PE', {
      weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Lima',
    });

    let msg = `📋 *Mañana — ${fechaLabel}* · ${leads.length} lead(s)\n\n`;

    for (const lead of leads) {
      const empresa  = getProp(lead, 'Empresa')       || 'Sin empresa';
      const decisor  = getProp(lead, 'Decisor')       || '';
      const email    = getProp(lead, 'Email Decisor') || getProp(lead, 'Email') || '';
      const telefono = getProp(lead, 'Teléfono')      || '';
      const score    = getProp(lead, 'Score ICP')     || '';
      const d1 = getProp(lead, 'Día 1 (LinkedIn)');
      const d3 = getProp(lead, 'Día 3 (Email)');
      const d7 = getProp(lead, 'Día 7 (WhatsApp)');

      let accion = '';
      if (d1 === manana) accion = '🔵 *LinkedIn* — Preparar conexión + mensaje';
      if (d3 === manana) accion = '📧 *Email* — Preparar email con one-pager';
      if (d7 === manana) accion = '📞 *Seguimiento* — Preparar email breve de cierre' + (telefono ? ' o llamada' : '');

      let card = `━━━━━━━━━━━━━━━\n🏢 *${empresa}*`;
      if (score) card += ` · ICP ${score}/10`;
      card += '\n';
      if (decisor)  card += `👤 ${decisor}\n`;
      if (email)    card += `📧 ${email}\n`;
      if (telefono) card += `📞 ${telefono}\n`;
      card += accion + `\n💬 \`/mensaje ${empresa}\` para preparar el texto`;

      await send(card);
    }
  } catch (err) {
    console.error('[abm] /manana error:', err.message);
    await send('❌ Error al consultar mañana.');
  }
}

export async function handleAgenda() {
  try {
    const hoy   = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
    const en14d = new Date(Date.now() + 14 * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Lima' });

    const data  = await notionQuery(NOTION_EJECUCION_DB, null, 100);
    const leads = data.results || [];

    if (!leads.length) {
      await send('📆 *Agenda ABM vacía*\n\nAún no hay empresas en la base de ejecución.');
      return;
    }

    const ICON    = { LinkedIn: '🔵', Email: '📧', Seguimiento: '📞' };
    const CANALES = [
      ['Día 1 (LinkedIn)', 'LinkedIn'],
      ['Día 3 (Email)',    'Email'],
      ['Día 7 (WhatsApp)','Seguimiento'],
    ];

    const vencidas = [];
    const byDay    = {};
    const sinFecha = [];

    for (const l of leads) {
      const empresa = getProp(l, 'Empresa') || 'Sin empresa';
      const decisor = getProp(l, 'Decisor') || '';
      let   tieneAlguna = false;

      for (const [campo, canal] of CANALES) {
        const fecha = getProp(l, campo);
        if (!fecha) continue;
        tieneAlguna = true;

        if (fecha < hoy) {
          vencidas.push({ empresa, canal, decisor, fecha });
        } else if (fecha <= en14d) {
          if (!byDay[fecha]) byDay[fecha] = [];
          byDay[fecha].push({ empresa, canal, decisor });
        }
      }

      if (!tieneAlguna) sinFecha.push(empresa);
    }

    const fechaHdr = new Date().toLocaleDateString('es-PE', {
      weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Lima',
    });

    let msg = `📆 *Agenda ABM · ${leads.length} empresas*\n_${fechaHdr}_\n\n`;

    if (vencidas.length) {
      msg += `⚠️ *Acciones vencidas (${vencidas.length})*\n`;
      for (const a of vencidas.sort((x, y) => x.fecha.localeCompare(y.fecha))) {
        const dias = Math.floor((new Date(hoy + 'T12:00:00-05:00') - new Date(a.fecha + 'T12:00:00-05:00')) / 864e5);
        msg += `${ICON[a.canal]} ${a.canal} · *${a.empresa.slice(0, 30)}*`;
        if (a.decisor) msg += ` · ${a.decisor.split(' ')[0]}`;
        msg += ` _(${dias === 1 ? '1d atrás' : `${dias}d atrás`})_\n`;
      }
      msg += '\n';
    }

    const dias = Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b));
    if (dias.length) {
      for (const [fecha, acc] of dias) {
        const dLabel = fecha === hoy
          ? '📌 *Hoy*'
          : `*${new Date(fecha + 'T12:00:00-05:00').toLocaleDateString('es-PE', {
              weekday: 'short', day: 'numeric', month: 'short', timeZone: 'America/Lima',
            })}*`;
        msg += `${dLabel} — ${acc.length} acción${acc.length > 1 ? 'es' : ''}\n`;
        for (const a of acc) {
          msg += `${ICON[a.canal]} ${a.empresa.slice(0, 30)}`;
          if (a.decisor) msg += ` · _${a.decisor.split(' ')[0]}_`;
          msg += '\n';
        }
        msg += '\n';
      }
    } else if (!vencidas.length) {
      msg += `_Sin acciones en los próximos 14 días._\n\n`;
    }

    if (sinFecha.length) {
      msg += `📭 *Sin programar (${sinFecha.length})*\n`;
      for (const e of sinFecha) msg += `· ${e.slice(0, 35)}\n`;
      msg += `_\`/iniciar [empresa]\` para activar_`;
    }

    await send(msg);
  } catch (err) {
    console.error('[abm] /agenda error:', err.message);
    await send('❌ Error al generar la agenda.');
  }
}

export async function handleSemana() {
  try {
    const hoy  = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
    const en7d = new Date(Date.now() + 7 * 864e5).toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
    const data = await notionQuery(NOTION_EJECUCION_DB, {
      or: [
        { property: 'Día 1 (LinkedIn)', date: { on_or_after: hoy } },
        { property: 'Día 3 (Email)',    date: { on_or_after: hoy } },
        { property: 'Día 7 (WhatsApp)', date: { on_or_after: hoy } },
      ],
    });
    const leads = data.results || [];
    if (!leads.length) {
      await send('📋 *Sin acciones esta semana*\n\nUsa `/iniciar [empresa]` para activar leads.');
      return;
    }
    const byDay = {};
    for (const l of leads) {
      const empresa = getProp(l, 'Empresa') || 'Sin empresa';
      [['Día 1 (LinkedIn)', 'LinkedIn'], ['Día 3 (Email)', 'Email'], ['Día 7 (WhatsApp)', 'Seguimiento']].forEach(([campo, canal]) => {
        const fecha = getProp(l, campo);
        if (fecha && fecha >= hoy && fecha <= en7d) {
          if (!byDay[fecha]) byDay[fecha] = [];
          byDay[fecha].push({ empresa, canal });
        }
      });
    }
    const ICON = { LinkedIn: '🔵', Email: '📧', Seguimiento: '📞' };
    let msg = `📅 *Acciones esta semana*\n\n`;
    for (const [fecha, acc] of Object.entries(byDay).sort()) {
      const label = fecha === hoy ? '*Hoy*' : `*${new Date(fecha + 'T12:00:00-05:00').toLocaleDateString('es-PE', { weekday: 'short', day: 'numeric', timeZone: 'America/Lima' })}*`;
      msg += `${label} (${acc.length})\n`;
      for (const a of acc) msg += `${ICON[a.canal]} ${a.canal} → ${a.empresa.slice(0, 35)}\n`;
      msg += '\n';
    }
    await send(msg);
  } catch (err) { await send('❌ Error al consultar la semana.'); }
}
