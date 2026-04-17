// api/lib/pexels.js — Busca imágenes en Pexels para Instagram

import { fetchWithRetry } from './fetch-utils.js';

const API_KEY = () => process.env.PEXELS_API_KEY;

/**
 * Busca una foto relevante en Pexels y devuelve la URL de la imagen.
 * @param {string} query — términos de búsqueda
 * @param {'landscape'|'portrait'|'square'} orientation — portrait para Instagram feed
 * @returns {{ url: string, photographer: string, pageUrl: string } | null}
 */
export async function searchPhoto(query, orientation = 'portrait') {
  if (!API_KEY()) return null;

  const params = new URLSearchParams({
    query,
    per_page:    '5',
    orientation,
    locale:      'es-ES',
  });

  const res = await fetchWithRetry(
    `https://api.pexels.com/v1/search?${params}`,
    { headers: { 'Authorization': API_KEY() } },
    { timeoutMs: 8_000 }
  );

  if (!res.ok) return null;

  const data   = await res.json();
  const photos = data.photos || [];
  if (!photos.length) return null;

  // Elegir la foto con mejor resolución (preferir la primera)
  const photo = photos[0];
  return {
    url:          photo.src?.large2x || photo.src?.original,
    photographer: photo.photographer || '',
    pageUrl:      photo.url || '',
  };
}

/**
 * Elige los términos de búsqueda más relevantes para una temática de RRHH/EWA.
 * @param {string} tema — tema del post
 * @returns {string} query optimizado para Pexels
 */
export function buildPhotoQuery(tema = '') {
  const TEMA_MAP = [
    { match: /rotaci/i,     query: 'team work employees office' },
    { match: /estrés|financier/i, query: 'financial stress work life balance' },
    { match: /talento|retener/i,  query: 'talent recruitment team success' },
    { match: /productividad/i,    query: 'productivity work focus office' },
    { match: /salario|sueldo|pago/i, query: 'salary payment success money' },
    { match: /bienestar/i,        query: 'employee wellbeing happy workplace' },
    { match: /rrhh|recursos humanos/i, query: 'human resources team meeting' },
  ];

  for (const { match, query } of TEMA_MAP) {
    if (match.test(tema)) return query;
  }

  return 'professional team workplace latin america';
}
