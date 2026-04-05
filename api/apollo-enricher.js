/**
 * api/apollo-enricher.js — Enriquece leads del SDR Agent con datos verificados de Apollo
 *
 * Lee el CRM de Notion buscando leads de "SDR Agent" sin email →
 * llama a Apollo People Match por nombre + empresa + LinkedIn →
 * actualiza Notion con email, teléfono y cargo verificado.
 *
 * POST /api/apollo-enricher
 * Headers: Authorization: Bearer CRON_SECRET
 * Body: { max_leads?: number (default: 20), notify?: boolean (default: true) }
 */

import { NOTION }                            from './lib/constants.js';
import { notionQuery, notionPatch, getProp } from './lib/notion.js';
import { sendMessage }                       from './lib/telegram.js';

const APOLLO_KEY     = process.env.APOLLO_API_KEY;
const CRON_SECRET    = process.env.CRON_SECRET;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CEO_CHAT_ID    = process.env.TELEGRAM_CHAT_ID;

// ── Timeout helper ─────────────────────────────────────────────────────────────

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`timeout:${label} (${ms}ms)`)), ms)
    ),
  ]);
}

// ── Apollo People Match ────────────────────────────────────────────────────────

/**
 * Busca a una persona en Apollo por nombre + empresa (+ LinkedIn opcional).
 * Devuelve { email, phone, title, company } o null si no encontrado.
 */
async function apolloMatch({ firstName, lastName, company, linkedinUrl }) {
  if (!APOLLO_KEY) throw new Error('APOLLO_API_KEY no configurada');

  const body = {
    first_name:              firstName,
    last_name:               lastName,
    organization_name:       company,
    reveal_personal_emails:  false,
    reveal_phone_number:     false,
  };
  if (linkedinUrl) body.linkedin_url = linkedinUrl;

  const res = await fetch('https://api.apollo.io/v1/people/match', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Cache-Control': 'no-cache',
      'X-Api-Key':     APOLLO_KEY,
    },
    body: JSON.stringify(body),
  });

  if (res.status === 404 || res.status === 422) return null; // not found
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Apollo ${res.status}: ${err.slice(0, 100)}`);
  }

  const data   = await res.json();
  const person = data.person;
  if (!person) return null;

  const email = person.email && !person.email.includes('email_not_unlocked')
    ? person.email
    : null;

  const phone = person.phone_numbers?.[0]?.sanitized_number || null;

  return {
    email,
    phone,
    title:   person.title   || null,
    company: person.organization?.name || null,
  };
}

// ── Parsear nombre completo ────────────────────────────────────────────────────

function splitName(fullName = '') {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  // Tomar primer token como nombre, resto como apellido
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

// ── Extraer LinkedIn URL de las notas de Notion ───────────────────────────────

function extractLinkedIn(notas = '') {
  const match = notas.match(/https?:\/\/(?:www\.)?linkedin\.com\/in\/[^\s\n]+/i);
  return match ? match[0].trim() : null;
}

// ── Fetch leads SDR sin email ─────────────────────────────────────────────────

async function fetchSdrLeadsWithoutEmail(maxLeads) {
  const filter = {
    and: [
      { property: 'Fuente', select: { equals: 'SDR Agent' } },
      { property: 'Email',  email:  { is_empty: true } },
    ],
  };
  const sorts = [{ timestamp: 'created_time', direction: 'descending' }];

  const r = await withTimeout(
    notionQuery(NOTION.CRM_DB, filter, maxLeads, sorts),
    10000,
    'notion:fetchLeads'
  );
  return r.results || [];
}

// ── Handler principal ──────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = req.headers.authorization || '';
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ error: 'Unauthorized' });

  const { max_leads = 20, notify = true } = req.body || {};

  if (!APOLLO_KEY) {
    return res.status(500).json({ error: 'APOLLO_API_KEY no configurada en Vercel' });
  }

  const startTime = Date.now();
  const enriched  = [];
  const skipped   = [];
  const errors    = [];

  try {
    const pages = await fetchSdrLeadsWithoutEmail(max_leads);

    if (!pages.length) {
      return res.status(200).json({ message: 'No hay leads SDR sin email para enriquecer.', enriched: 0 });
    }

    // Procesar en paralelo (con límite implícito por max_leads)
    await Promise.allSettled(pages.map(async (page) => {
      const pageId  = page.id;
      const rawName = getProp(page, 'Nombre y Cargo') || '';
      // "Nombre y Cargo" puede ser "Nombre, Cargo" — separar por coma
      const namePart    = rawName.split(',')[0].trim();
      const companyRaw  = getProp(page, 'Empresa') || '';
      const notas       = getProp(page, 'Notas')   || '';
      const linkedinUrl = extractLinkedIn(notas);

      if (!namePart) {
        skipped.push({ name: rawName, company: companyRaw, reason: 'sin nombre' });
        return;
      }

      const { firstName, lastName } = splitName(namePart);

      try {
        const result = await withTimeout(
          apolloMatch({ firstName, lastName, company: companyRaw, linkedinUrl }),
          8000,
          `apollo:${namePart}`
        );

        if (!result || !result.email) {
          skipped.push({ name: namePart, company: companyRaw, reason: result ? 'sin email en Apollo' : 'no encontrado' });
          return;
        }

        // Construir patch para Notion
        const properties = {
          'Email': { email: result.email },
        };
        if (result.phone) {
          properties['Teléfono'] = { phone_number: result.phone };
        }

        await withTimeout(
          notionPatch(pageId, properties),
          8000,
          `notion:patch:${namePart}`
        );

        enriched.push({
          name:    namePart,
          company: companyRaw,
          email:   result.email,
          phone:   result.phone || '—',
        });
        console.log(`[apollo-enricher] ✓ ${namePart} @ ${companyRaw} → ${result.email}`);

      } catch (err) {
        errors.push({ name: namePart, company: companyRaw, error: err.message });
        console.error(`[apollo-enricher] ✗ ${namePart}:`, err.message);
      }
    }));

  } catch (err) {
    console.error('[apollo-enricher] error:', err.message);
    if (enriched.length === 0 && errors.length === 0) {
      return res.status(500).json({ error: err.message });
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  // Notificar al CEO
  if (notify && TELEGRAM_TOKEN && CEO_CHAT_ID && enriched.length > 0) {
    let msg = `📬 *Apollo Enricher — completado*\n\n`;
    msg += `✅ *${enriched.length} leads enriquecidos* con email verificado\n`;
    msg += `⏭ ${skipped.length} sin match · ❌ ${errors.length} errores\n\n`;
    enriched.slice(0, 8).forEach(l => {
      msg += `• *${l.company}* — ${l.name}\n  📧 ${l.email}`;
      if (l.phone !== '—') msg += ` · 📞 ${l.phone}`;
      msg += '\n';
    });
    if (enriched.length > 8) msg += `_...y ${enriched.length - 8} más_\n`;
    msg += `\n⏱ ${duration}s · Revisá en Notion → CRM`;
    sendMessage(TELEGRAM_TOKEN, CEO_CHAT_ID, msg, { parse_mode: 'Markdown' }).catch(() => {});
  }

  return res.status(200).json({
    enriched:        enriched.length,
    skipped:         skipped.length,
    errors:          errors.length,
    leads:           enriched,
    skipped_detail:  skipped.slice(0, 5),
    duration_s:      parseFloat(duration),
  });
}

export const config = { maxDuration: 60 };
