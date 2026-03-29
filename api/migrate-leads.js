// api/migrate-leads.js — Migración única: Notion CRM → Supabase
//
// Lee todos los leads del CRM de Notion (con paginación) y los upserta en Supabase.
// Idempotente — se puede correr múltiples veces sin duplicar datos (upsert por email).
//
// Trigger: POST /api/migrate-leads
//          Header: Authorization: Bearer CRON_SECRET

import { NOTION } from './lib/constants.js';
import { getProp } from './lib/notion.js';
import { supabaseUpsert } from './lib/supabase.js';

const CRON_SECRET = process.env.CRON_SECRET;

function isAuthorized(req) {
  const header = req.headers['authorization'];
  const query  = new URL(req.url || '/', 'https://x').searchParams.get('secret');
  return (header?.replace('Bearer ', '') || query) === CRON_SECRET;
}

// Leer todos los leads de Notion con paginación completa
async function fetchAllNotionLeads() {
  const leads = [];
  let cursor  = undefined;

  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;

    const res = await fetch(`https://api.notion.com/v1/databases/${NOTION.CRM_DB}/query`, {
      method:  'POST',
      headers: {
        'Authorization':  `Bearer ${NOTION.TOKEN}`,
        'Content-Type':   'application/json',
        'Notion-Version': '2022-06-28',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`Notion ${res.status}: ${await res.text()}`);
    const data = await res.json();

    for (const page of data.results) {
      leads.push({
        notion_id:   page.id,
        name:        getProp(page, 'Nombre y Cargo') || 'Sin nombre',
        email:       getProp(page, 'Email'),
        company:     getProp(page, 'Empresa')        || null,
        sector:      getProp(page, 'Sector')         || null,
        employees:   getProp(page, 'Colaboradores')  || null,
        objetivo:    getProp(page, 'Objetivo')       || null,
        source:      getProp(page, 'Fuente')         || null,
        score:       getProp(page, 'Score')          || null,
        probability: getProp(page, 'Probabilidad'),
        estado:      getProp(page, 'Estado')         || 'Nuevo',
        message:     getProp(page, 'Notas')          || null,
      });
    }

    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);

  return leads;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!isAuthorized(req))    return res.status(401).json({ error: 'Unauthorized' });

  console.log('[migrate-leads] Iniciando migración Notion → Supabase...');

  try {
    const leads = await fetchAllNotionLeads();
    console.log(`[migrate-leads] ${leads.length} leads leídos de Notion`);

    let ok = 0, skipped = 0, failed = 0;

    for (const lead of leads) {
      // Saltar leads sin email — no se pueden upsertear por email
      if (!lead.email) { skipped++; continue; }

      const result = await supabaseUpsert('leads', lead, 'email');
      if (result) ok++; else failed++;
    }

    console.log(`[migrate-leads] Resultado: ${ok} ok, ${skipped} sin email, ${failed} errores`);
    return res.status(200).json({ ok: true, total: leads.length, migrated: ok, skipped, failed });

  } catch (err) {
    console.error('[migrate-leads] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
