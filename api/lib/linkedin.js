// api/lib/linkedin.js — LinkedIn Posts API v2 helper

const TOKEN  = () => process.env.LINKEDIN_ACCESS_TOKEN;
const AUTHOR = () => process.env.LINKEDIN_AUTHOR_URN; // urn:li:organization:xxx o urn:li:person:xxx

/**
 * Publica un post de texto en LinkedIn.
 * @param {string} text — cuerpo del post
 * @returns {{ urn: string, url: string }}
 */
export async function postLinkedIn(text) {
  if (!TOKEN())  throw new Error('LINKEDIN_ACCESS_TOKEN no configurado');
  if (!AUTHOR()) throw new Error('LINKEDIN_AUTHOR_URN no configurado');

  const body = {
    author:            AUTHOR(),
    commentary:        text,
    visibility:        'PUBLIC',
    distribution: {
      feedDistribution:            'MAIN_FEED',
      targetEntities:              [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState:              'PUBLISHED',
    isReshareDisabledByAuthor:   false,
  };

  const res = await fetch('https://api.linkedin.com/rest/posts', {
    method:  'POST',
    headers: {
      'Authorization':              `Bearer ${TOKEN()}`,
      'Content-Type':               'application/json',
      'X-Restli-Protocol-Version':  '2.0.0',
      'LinkedIn-Version':           '202504',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`LinkedIn API ${res.status}: ${err.slice(0, 200)}`);
  }

  // LinkedIn devuelve el URN del post en el header x-restli-id
  const urn = res.headers.get('x-restli-id') || res.headers.get('X-RestLi-Id') || '';
  const encodedUrn = encodeURIComponent(urn);
  const url = urn ? `https://www.linkedin.com/feed/update/${encodedUrn}/` : 'https://www.linkedin.com/feed/';

  return { urn, url };
}
