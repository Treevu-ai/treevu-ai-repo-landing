// api/lib/firecrawl.js — Firecrawl helper para scraping de sitios de prospectos

const API_KEY  = () => process.env.FIRECRAWL_API_KEY;
const BASE_URL = 'https://api.firecrawl.dev/v1';

const TIMEOUT_MS = 15000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`firecrawl timeout (${ms}ms)`)), ms)
    ),
  ]);
}

/**
 * Raspa una URL y devuelve el contenido en markdown limpio.
 * @param {string} url
 * @returns {string|null} markdown del contenido principal, o null si falla
 */
export async function scrapeUrl(url) {
  if (!API_KEY()) return null;

  const res = await withTimeout(
    fetch(`${BASE_URL}/scrape`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${API_KEY()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        formats:          ['markdown'],
        onlyMainContent: true,
        timeout:          12000,
      }),
    }),
    TIMEOUT_MS
  );

  if (!res.ok) return null;
  const data = await res.json();
  return data.data?.markdown || null;
}

/**
 * Busca el sitio web de una empresa y lo raspa.
 * Primero busca la URL oficial, luego la raspa.
 * @param {string} company — nombre de la empresa
 * @param {string} sector  — sector (para enfocar la búsqueda)
 * @returns {string|null} contenido útil del sitio
 */
export async function scrapeCompany(company, sector = '') {
  if (!API_KEY() || !company) return null;

  try {
    // 1. Buscar el sitio web oficial de la empresa vía Firecrawl search
    const searchRes = await withTimeout(
      fetch(`${BASE_URL}/search`, {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${API_KEY()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query:      `${company} Peru empresa oficial sitio web ${sector}`,
          limit:       3,
          scrapeOptions: { formats: ['markdown'], onlyMainContent: true },
        }),
      }),
      TIMEOUT_MS
    );

    if (!searchRes.ok) return null;
    const searchData = await searchRes.json();
    const results    = searchData.data || [];

    if (!results.length) return null;

    // Preferir el primer resultado que no sea LinkedIn, Wikipedia ni directorios
    const SKIP_DOMAINS = ['linkedin.com', 'wikipedia.org', 'facebook.com', 'glassdoor.com', 'computrabajo.com', 'bumeran.com'];
    const best = results.find(r => !SKIP_DOMAINS.some(d => (r.url || '').includes(d))) || results[0];

    // Combinar los snippets de los resultados para contexto rápido
    const snippets = results
      .map(r => r.markdown || r.description || '')
      .filter(Boolean)
      .map(s => s.slice(0, 400))
      .join('\n\n---\n\n');

    return snippets.slice(0, 2000) || null;

  } catch (err) {
    console.warn('[firecrawl] scrapeCompany error:', err.message);
    return null;
  }
}
