// api/lib/validators.js — Validadores y parsers centralizados

const MALE_EXCEPTIONS = [
  'joseba','nikola','luca','bautista','joshua','elia','andrea',
  'garcia','villa','meza','tapia','mejia','silva','soria',
];

const FEMALE_SPECIALS = [
  'isabel','pilar','carmen','belen','mercedes','ines','rocio',
  'flor','luz','paz','sol','esperanza','milagros','nieves',
  'trinidad','dolores','consuelo','amparo','fe','ruth','esther',
  'miriam','raquel','rebeca','judith','noemi','debora','mar',
];

// Detecta género ('M'|'F') a partir del primer nombre
export function detectGender(fullName) {
  if (!fullName) return 'M';
  const first = fullName.trim().split(/[\s,\-]+/)[0]
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (MALE_EXCEPTIONS.includes(first))   return 'M';
  if (FEMALE_SPECIALS.includes(first))   return 'F';
  if (first.endsWith('a'))               return 'F';
  return 'M';
}

// Valida formato de email
export function isValidEmail(email) {
  return /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(String(email || '').trim());
}

// Extrae email de un texto libre
export function extractEmail(text) {
  return text?.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/)?.[0] || null;
}
