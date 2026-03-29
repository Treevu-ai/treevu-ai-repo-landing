// api/lib/supabase.js — Supabase REST client (no SDK — plain fetch)
//
// Requires env vars:
//   SUPABASE_URL          e.g. https://xxxxx.supabase.co
//   SUPABASE_SERVICE_KEY  service_role key (server-side only, never expose to browser)
//
// SQL schema for leads table (run once in Supabase SQL editor):
// ─────────────────────────────────────────────────────────────
//   create table leads (
//     id           uuid primary key default gen_random_uuid(),
//     notion_id    text unique,
//     name         text not null,
//     email        text not null,
//     company      text,
//     role         text,
//     sector       text,
//     employees    text,
//     objetivo     text,
//     message      text,
//     source       text,
//     score        text,
//     probability  int,
//     estado       text default 'Nuevo',
//     created_at   timestamptz default now(),
//     updated_at   timestamptz default now()
//   );
//   create unique index leads_email_idx on leads(email);
//
//   -- auto-update updated_at on any change
//   create or replace function set_updated_at()
//   returns trigger language plpgsql as $$
//   begin new.updated_at = now(); return new; end; $$;
//
//   create trigger leads_updated_at before update on leads
//   for each row execute procedure set_updated_at();
// ─────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

function headers(prefer = 'return=representation') {
  return {
    'apikey':          SUPABASE_KEY,
    'Authorization':   `Bearer ${SUPABASE_KEY}`,
    'Content-Type':    'application/json',
    'Prefer':          prefer,
  };
}

function isConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_KEY);
}

// Insert a single row. Returns inserted row or null on error.
export async function supabaseInsert(table, row) {
  if (!isConfigured()) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method:  'POST',
      headers: headers(),
      body:    JSON.stringify(row),
    });
    if (!res.ok) {
      console.error(`[supabase] insert ${table} ${res.status}:`, await res.text());
      return null;
    }
    const data = await res.json();
    return Array.isArray(data) ? data[0] : data;
  } catch (err) {
    console.error(`[supabase] insert ${table}:`, err.message);
    return null;
  }
}

// Upsert (insert or update) by a conflict column (default: email).
// Returns upserted row or null on error.
export async function supabaseUpsert(table, row, onConflict = 'email') {
  if (!isConfigured()) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
      method:  'POST',
      headers: headers('resolution=merge-duplicates,return=representation'),
      body:    JSON.stringify(row),
    });
    if (!res.ok) {
      console.error(`[supabase] upsert ${table} ${res.status}:`, await res.text());
      return null;
    }
    const data = await res.json();
    return Array.isArray(data) ? data[0] : data;
  } catch (err) {
    console.error(`[supabase] upsert ${table}:`, err.message);
    return null;
  }
}

// Patch (update) rows matching a filter. filter: { column, value }
export async function supabasePatch(table, filter, updates) {
  if (!isConfigured()) return null;
  try {
    const url = `${SUPABASE_URL}/rest/v1/${table}?${filter.column}=eq.${encodeURIComponent(filter.value)}`;
    const res = await fetch(url, {
      method:  'PATCH',
      headers: headers(),
      body:    JSON.stringify(updates),
    });
    if (!res.ok) {
      console.error(`[supabase] patch ${table} ${res.status}:`, await res.text());
      return null;
    }
    const data = await res.json();
    return Array.isArray(data) ? data[0] : data;
  } catch (err) {
    console.error(`[supabase] patch ${table}:`, err.message);
    return null;
  }
}
