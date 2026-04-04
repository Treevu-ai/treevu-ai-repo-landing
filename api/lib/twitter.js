// api/lib/twitter.js — Twitter API v2 helper con OAuth 1.0a

import crypto from 'crypto';

const API_KEY    = () => process.env.TWITTER_API_KEY;
const API_SECRET = () => process.env.TWITTER_API_SECRET;
const ACC_TOKEN  = () => process.env.TWITTER_ACCESS_TOKEN;
const ACC_SECRET = () => process.env.TWITTER_ACCESS_TOKEN_SECRET;

function percentEncode(str) {
  return encodeURIComponent(String(str))
    .replace(/!/g, '%21').replace(/'/g, '%27')
    .replace(/\(/g, '%28').replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

function buildAuthHeader(method, url, bodyParams = {}) {
  const nonce     = crypto.randomBytes(16).toString('hex');
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const oauthParams = {
    oauth_consumer_key:     API_KEY(),
    oauth_nonce:            nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp:        timestamp,
    oauth_token:            ACC_TOKEN(),
    oauth_version:          '1.0',
  };

  // Juntar oauth params + body params y ordenar
  const allParams = { ...oauthParams, ...bodyParams };
  const sortedPairs = Object.keys(allParams)
    .sort()
    .map(k => `${percentEncode(k)}=${percentEncode(allParams[k])}`);

  const paramStr   = sortedPairs.join('&');
  const baseString = [
    method.toUpperCase(),
    percentEncode(url),
    percentEncode(paramStr),
  ].join('&');

  const signingKey = `${percentEncode(API_SECRET())}&${percentEncode(ACC_SECRET())}`;
  const signature  = crypto
    .createHmac('sha1', signingKey)
    .update(baseString)
    .digest('base64');

  oauthParams.oauth_signature = signature;

  const headerValue = 'OAuth ' + Object.keys(oauthParams)
    .map(k => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`)
    .join(', ');

  return headerValue;
}

/**
 * Publica un tweet via Twitter API v2.
 * @param {string} text — texto del tweet (max 280 chars)
 * @returns {{ id: string, text: string, url: string }}
 */
export async function postTweet(text) {
  if (!API_KEY() || !API_SECRET() || !ACC_TOKEN() || !ACC_SECRET()) {
    throw new Error('Faltan env vars de Twitter (TWITTER_API_KEY/SECRET/ACCESS_TOKEN/SECRET)');
  }

  const url    = 'https://api.twitter.com/2/tweets';
  const body   = { text };
  const auth   = buildAuthHeader('POST', url, {}); // Twitter v2 usa JSON body, no form params en firma

  const res = await fetch(url, {
    method:  'POST',
    headers: {
      'Authorization': auth,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Twitter API ${res.status}: ${err.slice(0, 200)}`);
  }

  const data   = await res.json();
  const tweetId = data.data?.id;
  return {
    id:   tweetId,
    text: data.data?.text || text,
    url:  tweetId ? `https://x.com/treevu_app/status/${tweetId}` : null,
  };
}
