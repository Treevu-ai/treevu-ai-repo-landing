// api/lib/notion.js — Helpers centralizados para Notion API

import { NOTION } from './constants.js';

const NOTION_HEADERS = () => ({
  'Authorization':  `Bearer ${NOTION.TOKEN}`,
  'Content-Type':   'application/json',
  'Notion-Version': '2022-06-28',
});

// Retry con backoff exponencial para 429 y 5xx
// Delays: 500ms → 1500ms (max 2 reintentos adicionales = 3 intentos total)
async function fetchWithRetry(url, options, maxRetries = 3) {
  const DELAYS = [0, 500, 1500];
  let lastErr;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (DELAYS[attempt]) await new Promise(r => setTimeout(r, DELAYS[attempt]));
    let res;
    try { res = await fetch(url, options); } catch (err) { lastErr = err; continue; }
    if (res.ok) return res;
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`Notion ${res.status}: ${await res.text()}`);
      if (attempt < maxRetries - 1) {
        const retryAfter = parseInt(res.headers.get('retry-after') || '0') * 1000;
        if (retryAfter > 0) await new Promise(r => setTimeout(r, Math.min(retryAfter, 2000)));
        continue;
      }
    } else {
      throw new Error(`Notion ${res.status}: ${await res.text()}`);
    }
  }
  throw lastErr || new Error('Notion fetch failed after retries');
}

// Extrae el valor de una propiedad Notion independientemente del tipo
export function getProp(page, name) {
  const p = page.properties?.[name];
  if (!p) return null;
  if (p.type === 'select')       return p.select?.name || null;
  if (p.type === 'title')        return p.title?.[0]?.plain_text || null;
  if (p.type === 'rich_text')    return p.rich_text?.[0]?.plain_text || null;
  if (p.type === 'email')        return p.email || null;
  if (p.type === 'number')       return p.number ?? null;
  if (p.type === 'phone_number') return p.phone_number || null;
  if (p.type === 'date')         return p.date?.start || null;
  if (p.type === 'checkbox')     return p.checkbox ?? false;
  return null;
}

// Convierte ID con guiones a sin guiones y viceversa
export function restoreId(s) {
  const c = s.replace(/-/g, '');
  return `${c.slice(0,8)}-${c.slice(8,12)}-${c.slice(12,16)}-${c.slice(16,20)}-${c.slice(20)}`;
}

// Query a una DB de Notion con filtro y sorts opcionales
export async function notionQuery(dbId, filter, pageSize = 100, sorts = null, startCursor = null) {
  const body = { page_size: pageSize };
  if (filter)      body.filter       = filter;
  if (sorts)       body.sorts        = sorts;
  if (startCursor) body.start_cursor = startCursor;
  const res = await fetchWithRetry(`https://api.notion.com/v1/databases/${dbId}/query`, {
    method:  'POST',
    headers: NOTION_HEADERS(),
    body:    JSON.stringify(body),
  });
  return res.json();
}

// Actualiza propiedades de una página en Notion
export async function notionPatch(pageId, properties) {
  const res = await fetchWithRetry(`https://api.notion.com/v1/pages/${pageId}`, {
    method:  'PATCH',
    headers: NOTION_HEADERS(),
    body:    JSON.stringify({ properties }),
  });
  return res.json();
}

// Obtiene una página por su ID
export async function getNotionPage(pageId) {
  const res = await fetchWithRetry(`https://api.notion.com/v1/pages/${pageId}`, {
    headers: NOTION_HEADERS(),
  });
  return res.json();
}

// Crea una nueva página en una DB de Notion
export async function notionCreate(dbId, properties) {
  const res = await fetchWithRetry('https://api.notion.com/v1/pages', {
    method:  'POST',
    headers: NOTION_HEADERS(),
    body:    JSON.stringify({ parent: { database_id: dbId }, properties }),
  });
  return res.json();
}
