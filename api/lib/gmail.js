// api/lib/gmail.js — Gmail OAuth2 + send/draft centralizado

const GMAIL_FROM = process.env.GMAIL_FROM || 'hello@gettreevu.com';

export async function getGmailToken() {
  const id  = process.env.GMAIL_CLIENT_ID;
  const sec = process.env.GMAIL_CLIENT_SECRET;
  const ref = process.env.GMAIL_REFRESH_TOKEN;
  if (!id || !sec || !ref) return null;
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: id, client_secret: sec,
        refresh_token: ref, grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) return null;
    const { access_token } = await res.json();
    return access_token;
  } catch { return null; }
}

function buildMime({ to, subject, bodyHtml }) {
  const raw = [
    `From: Treevü <${GMAIL_FROM}>`, `To: ${to}`,
    `Subject: ${subject}`, `Content-Type: text/html; charset=utf-8`,
    `MIME-Version: 1.0`, ``, bodyHtml,
  ].join('\r\n');
  return Buffer.from(raw).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function gmailSend(token, { to, subject, bodyHtml }) {
  if (!token || !to) return null;
  try {
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: buildMime({ to, subject, bodyHtml }) }),
    });
    if (!res.ok) { console.error('[gmail] send error:', await res.text()); return null; }
    const msg = await res.json();
    console.log(`[gmail] sent OK: ${msg.id}`);
    return msg;
  } catch (err) { console.error('[gmail] send:', err.message); return null; }
}

export async function gmailDraft(token, { to, subject, bodyHtml }) {
  if (!token || !to) return null;
  try {
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { raw: buildMime({ to, subject, bodyHtml }) } }),
    });
    if (!res.ok) { console.error('[gmail] draft error:', await res.text()); return null; }
    const draft = await res.json();
    console.log(`[gmail] draft OK: ${draft.id}`);
    return draft;
  } catch (err) { console.error('[gmail] draft:', err.message); return null; }
}
