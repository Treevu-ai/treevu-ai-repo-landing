// api/lib/notion-schema.js — Property builders para Notion
// Centraliza la construcción de propiedades para evitar drift entre archivos.
// Uso: notionPatch(pageId, schema.estado('Cerrado'))

export const schema = {
  // ── CRM unificado ─────────────────────────────────────────────────────────
  estado:     (v)   => ({ Estado:                    { select: { name: v } } }),
  score:      (v)   => ({ Score:                     { select: { name: v } } }),
  notas:      (v)   => ({ Notas:                     { rich_text: [{ text: { content: String(v) } }] } }),
  ultimoContacto: (date) => ({ 'Fecha Último Contacto': { date: { start: date } } }),
  email:      (v)   => ({ Email:                     { email: v } }),
  telefono:   (v)   => ({ Teléfono:                  { phone_number: v } }),
  sector:     (v)   => ({ Sector:                    { select: { name: v } } }),
  colaboradores: (v) => ({ Colaboradores:            { rich_text: [{ text: { content: String(v) } }] } }),
  fechaReunion: (date) => ({ 'Fecha Reunión':        { date: { start: date } } }),

  // ── Ejecución ABM ─────────────────────────────────────────────────────────
  dia1:       (date) => ({ 'Día 1 (LinkedIn)':       { date: { start: date } } }),
  dia3:       (date) => ({ 'Día 3 (Email)':          { date: { start: date } } }),
  dia7:       (date) => ({ 'Día 7 (WhatsApp)':       { date: { start: date } } }),
  cadencia:   (d1, d3, d7) => ({
    'Día 1 (LinkedIn)': { date: { start: d1 } },
    'Día 3 (Email)':    { date: { start: d3 } },
    'Día 7 (WhatsApp)': { date: { start: d7 } },
    Estado:             { select: { name: 'En cadencia' } },
  }),
  reunionConfirmada: (date) => ({
    'Reunión Confirmada': { checkbox: true },
    'Fecha Reunión':      { date: { start: date } },
  }),
};
