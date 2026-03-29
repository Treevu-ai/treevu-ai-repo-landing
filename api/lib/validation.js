// api/lib/validation.js — Validación de payload del formulario de lead
// Módulo puro sin dependencias externas — fácilmente testeable.

import { isValidEmail } from './validators.js';

export const REQUIRED_FIELDS = ['nombre', 'email', 'empresa', 'sector', 'colaboradores', 'objetivo'];
export const MAX_PAYLOAD_BYTES = 10_000;

/**
 * Valida el body de /api/submit.
 * @returns {{ ok: true } | { ok: false, status: number, error: string }}
 */
export function validateSubmitBody(body) {
  if (!body) return { ok: false, status: 400, error: 'Body requerido' };

  // Honeypot
  if (body.website) return { ok: true, honeypot: true };

  // Campos requeridos
  for (const field of REQUIRED_FIELDS) {
    if (!body[field]) return { ok: false, status: 400, error: 'Campos requeridos faltantes' };
  }

  // Tamaño del payload
  if (JSON.stringify(body).length > MAX_PAYLOAD_BYTES) {
    return { ok: false, status: 400, error: 'Payload demasiado grande' };
  }

  // Email
  if (!isValidEmail(body.email)) {
    return { ok: false, status: 400, error: 'Email inválido' };
  }

  return { ok: true };
}
