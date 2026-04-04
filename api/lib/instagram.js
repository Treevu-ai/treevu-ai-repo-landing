// api/lib/instagram.js — Publica en Instagram vía webhook de n8n (treevu-n8n.fly.dev)
//
// n8n maneja el OAuth de Instagram. Treevu solo envía { imageUrl, caption }.
// Webhook URL → Vercel env var: N8N_INSTAGRAM_WEBHOOK

/**
 * Publica una imagen en Instagram enviando los datos al workflow de n8n.
 * @param {string} imageUrl — URL pública de la imagen (Pexels)
 * @param {string} caption  — texto del post con hashtags
 * @returns {{ id: string, url: string }}
 */
export async function postInstagram(imageUrl, caption) {
  const webhookUrl = process.env.N8N_INSTAGRAM_WEBHOOK;
  if (!webhookUrl) throw new Error('N8N_INSTAGRAM_WEBHOOK no configurado en Vercel');

  const res = await fetch(webhookUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ imageUrl, caption }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`n8n webhook ${res.status}: ${err.slice(0, 150)}`);
  }

  const data = await res.json().catch(() => ({}));
  return {
    id:  data.id  || '',
    url: data.url || 'https://www.instagram.com/treevu_app/',
  };
}
