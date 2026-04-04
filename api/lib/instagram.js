// api/lib/instagram.js — Instagram Graph API v20 para publicar imágenes

const IG_USER_ID = () => process.env.INSTAGRAM_USER_ID;
const IG_TOKEN   = () => process.env.INSTAGRAM_ACCESS_TOKEN;
const GRAPH_BASE = 'https://graph.facebook.com/v20.0';

/**
 * Publica una imagen en Instagram via Graph API.
 * Flujo: crear container → publicar container → devolver URL del post.
 *
 * @param {string} imageUrl — URL pública de la imagen (JPEG/PNG, accesible sin auth)
 * @param {string} caption  — texto del post (con hashtags al final si se quiere)
 * @returns {{ id: string, url: string }}
 */
export async function postInstagram(imageUrl, caption) {
  if (!IG_USER_ID()) throw new Error('INSTAGRAM_USER_ID no configurado');
  if (!IG_TOKEN())   throw new Error('INSTAGRAM_ACCESS_TOKEN no configurado');

  // 1. Crear media container
  const containerRes = await fetch(`${GRAPH_BASE}/${IG_USER_ID()}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image_url:    imageUrl,
      caption,
      access_token: IG_TOKEN(),
    }),
  });

  if (!containerRes.ok) {
    const err = await containerRes.text();
    throw new Error(`Instagram container ${containerRes.status}: ${err.slice(0, 200)}`);
  }

  const { id: containerId } = await containerRes.json();
  if (!containerId) throw new Error('Instagram no devolvió container ID');

  // 2. Publicar el container
  const publishRes = await fetch(`${GRAPH_BASE}/${IG_USER_ID()}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      creation_id:  containerId,
      access_token: IG_TOKEN(),
    }),
  });

  if (!publishRes.ok) {
    const err = await publishRes.text();
    throw new Error(`Instagram publish ${publishRes.status}: ${err.slice(0, 200)}`);
  }

  const { id: mediaId } = await publishRes.json();
  return {
    id:  mediaId,
    url: `https://www.instagram.com/p/${mediaId}/`,
  };
}
