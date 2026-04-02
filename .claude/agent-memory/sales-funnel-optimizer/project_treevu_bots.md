---
name: Treevü Bots — Arquitectura y configuración
description: Configuración técnica de los bots de Telegram de Treevü (público y ABM), incluyendo límites de tokens, comandos y flujo de calificación
type: project
---

Stack de bots de Treevü al 2026-03-26:

- Bot público @treevubot (api/telegram.js): Claude Haiku 4.5, max_tokens=160, historial=8 mensajes (4 turnos). System prompt ~90 tokens (comprimido desde ~200). Motor de flujo guiado con botones inline (sector, size, objetivo) + chat libre con Vü.
- Bot interno @treev_abm_bot (api/abm-bot.js): max_tokens parametrizado por comando: /nextstep=120, /bloqueantes=120, /decision=120, /objecion=160, /pregunta=200, /mensaje=300. Default del helper askClaude=250.
- CRM: Notion (CRM unificado + EJECUCIÓN 14 DÍAS DB). Cadencia ABM: D1/D3/D7.
- Captura de leads: flujo INIT → SIZE → OBJETIVO → SECTOR → CHAT → CAPTURE_NAME → CAPTURE_COMPANY → CAPTURE_EMAIL → DONE. Lead enviado a /api/lead vía webhook.
- ICP Score automático: ALTO/MEDIO/BAJO según sector, tamaño y objetivo.
- Trigger CTA: regex /contacte|contactar|equipo te|reserve|reservar|más info|información formal/i sobre la respuesta de Claude.

**Why:** Optimización de costos de tokens manteniendo la calidad de respuesta del funnel.
**How to apply:** Al sugerir cambios en los bots, tener en cuenta estos límites como punto de partida. Cualquier expansión de historial o tokens tiene impacto directo en costo por conversación.
