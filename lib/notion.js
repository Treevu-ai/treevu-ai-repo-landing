// ── lib/notion.js ─────────────────────────────────────────────────────────────
// Utilidades compartidas de Notion — capa visual/operativa del CRM

const NOTION_TOKEN = process.env.NOTION_TOKEN;
export const NOTION_DB = '8a5cb4e6-16b9-4248-ac44-cab55c9ace6f';

function notionHeaders() {
  return {
    'Authorization':   `Bearer ${NOTION_TOKEN}`,
    'Content-Type':    'application/json',
    'Notion-Version':  '2022-06-28'
  };
}

export function getProp(page, name) {
  const prop = page?.properties?.[name];
  if (!prop) return null;
  switch (prop.type) {
    case 'select':    return prop.select?.name    || null;
    case 'title':     return prop.title?.[0]?.plain_text  || null;
    case 'rich_text': return prop.rich_text?.[0]?.plain_text || null;
    case 'email':     return prop.email           || null;
    case 'number':    return prop.number          ?? null;
    case 'date':      return prop.date?.start     || null;
    default:          return null;
  }
}

export async function queryNotionDB(filter = {}, pageSize = 100) {
  if (!NOTION_TOKEN) throw new Error('NOTION_TOKEN no configurado');
  const body = pageSize ? { filter, page_size: pageSize } : { filter };
  const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB}/query`, {
    method:  'POST',
    headers: notionHeaders(),
    body:    JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Notion query ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function createNotionPage(properties) {
  if (!NOTION_TOKEN) throw new Error('NOTION_TOKEN no configurado');
  const res = await fetch('https://api.notion.com/v1/pages', {
    method:  'POST',
    headers: notionHeaders(),
    body:    JSON.stringify({ parent: { database_id: NOTION_DB }, properties })
  });
  if (!res.ok) throw new Error(`Notion create ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function updateNotionPage(pageId, properties) {
  if (!NOTION_TOKEN) throw new Error('NOTION_TOKEN no configurado');
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method:  'PATCH',
    headers: notionHeaders(),
    body:    JSON.stringify({ properties })
  });
  if (!res.ok) throw new Error(`Notion update ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function findLeadByEmail(email) {
  const data = await queryNotionDB({ property: 'Email', email: { equals: email } }, 1);
  return data.results?.[0] || null;
}

export async function updateLeadEstado(pageId, nuevoEstado, notaAdicional = null) {
  const props = { 'Estado': { select: { name: nuevoEstado } } };
  if (notaAdicional) props['Notas'] = { rich_text: [{ text: { content: notaAdicional } }] };
  return updateNotionPage(pageId, props);
}
