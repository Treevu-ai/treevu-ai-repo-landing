// api/lib/whatsapp.js — WhatsApp service helpers

const WA_URL    = process.env.WHATSAPP_SERVICE_URL;
const WA_SECRET = process.env.WHATSAPP_SERVICE_SECRET;

export function normalizePhone(phone) {
  const digits = (phone || '').replace(/\D/g, '');
  if (digits.startsWith('51') && digits.length >= 11) return digits;
  if (digits.length === 9) return `51${digits}`;
  return digits;
}

export async function sendWhatsApp(phone, message) {
  if (!WA_URL || !WA_SECRET || !phone) return null;
  const to = normalizePhone(phone);
  if (to.length < 10) return null;
  try {
    const res = await fetch(`${WA_URL}/send`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${WA_SECRET}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ to, message }),
    });
    return res.ok;
  } catch { return null; }
}
