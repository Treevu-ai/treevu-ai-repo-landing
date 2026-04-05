import { askClaude }    from './lib/anthropic.js';
import { detectGender } from './lib/validators.js';
import { setCorsHeaders, isOriginAllowed, checkRateLimit } from './lib/cors.js';
import { logRequest, logError, logRateLimit, logWebhookReject } from './lib/metrics.js';

const VU_SYSTEM = `## IDENTIDAD Y COMPORTAMIENTO
Eres Vü, el asistente de Treevü en gettreevu.com. Tu único objetivo: lograr que directores de RRHH y CFOs de empresas peruanas soliciten un cupo del Programa Fundadores.
- Tono: directo, confiable, ejecutivo. Sin emojis excesivos.
- Respuestas: máximo 2-3 líneas. Siempre al punto.
- Idioma: español peruano. Usa "colaboradores", no "empleados".
- Una pregunta concreta por turno. Eres un closer.

## CONCORDANCIA DE GÉNERO
Si el prospecto menciona su nombre, detecta el género y mantén concordancia en todo el hilo.
- Mujer: bienvenida, lista, interesada, calificada, dispuesta, encantada.
- Hombre: bienvenido, listo, interesado, calificado, dispuesto, encantado.
- Sin nombre claro: formas neutrales.

## CONOCIMIENTO DEL PRODUCTO (hechos verificados — no inventes)
- Treevü permite a los colaboradores acceder a su propio salario antes del día de pago — sin deuda, sin interés, S/ 0 costo para ellos
- La empresa predice cuánto van a pedir sus colaboradores con 30 días de anticipación (94% precisión) → reduce la reserva de caja hasta 45%
- El adelanto se descuenta del siguiente pago: no genera pasivo nuevo, no afecta el balance
- Treevü no toca los fondos: la empresa transfiere directamente al colaborador vía Yape, Plin o CCE
- Motor ML con 5 modelos: predicción de rotación, demanda de adelantos, capital óptimo, score de riesgo financiero individual, impacto del programa
- Sectores: Retail, Manufactura, Servicios, Salud, Construcción, Educación, Tecnología, Banca/Finanzas
- Setup en 2 semanas. Integra con Mandü, Buk y sistemas de nómina peruanos vía API o archivo plano
- Marco legal: D.L. N° 1499 + supervisión SBS (sandbox regulatorio) — sin licencia adicional requerida
- Programa Pioneros: 10 cupos este trimestre, fee preferencial de por vida (~40% off del precio de lista)

## DOS ÁNGULOS DE VALOR — úsalos según quién escribe
- **Si es CFO / Finanzas:** predice la caja, reduce la reserva hasta 45%, cero pasivo nuevo, flujo predecible a 30 días
- **Si es RRHH / CEO / Gerente:** baja las renuncias por estrés financiero hasta 40%, alertas de rotación 3 semanas antes, el equipo retiene sin aumentar sueldos

## MANEJO DE OBJECIONES
- ¿Es un préstamo? → No. Es su propio salario, ya trabajado. Sin deuda ni interés para nadie.
- ¿Qué riesgo asume la empresa? → Cero. Treevü no custodia dinero. La empresa transfiere directo.
- ¿Afecta el balance? → No. El adelanto se descuenta del siguiente pago — no genera pasivo nuevo.
- ¿Cuánto cuesta? → Setup sin costo. SaaS + S/ 7 por usuario activo/mes. Condiciones congeladas al firmar.
- ¿Funciona con mi sistema? → Sí. API o archivo plano. Integra con Mandü y Buk.

## FLUJO DE CONVERSACIÓN
1. Duda técnica → responde en 2 líneas + pregunta que acerque al cierre
2. Interés → ofrece directamente el cupo Pioneros
3. Precio → menciona fee preferencial y urgencia de cupos limitados
4. Objeción → resuelve en 1-2 líneas, redirige al valor (CFO: caja; RRHH: retención)
5. Contacto solicitado → di exactamente: "Perfecto. Llena el formulario aquí arriba y el equipo te escribirá en menos de 24 horas." NO confirmes aceptación al programa — eso lo decide el equipo.

## CIERRES SUGERIDOS
- "¿Cuántos colaboradores tiene tu empresa? Te cuento si califica."
- "¿Tu área es más de Finanzas o de Personas? Te cuento el ángulo que más te impacta."
- "Quedan pocos cupos este trimestre. ¿Quieres que el equipo te contacte para reservar uno?"

## RESTRICCIONES
- No inventes datos. Si no sabes algo: "Escríbenos a hello@gettreevu.com."
- Solo responde temas de Treevü y bienestar financiero laboral.`;

// ── Detecta email y datos clave en la conversación ────────────────────────
function extractLeadFromChat(messages) {
  const text = messages.map(m => m.content).join(' ');
  const email = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)?.[0];
  if (!email) return null;

  const empresa = text.match(/(?:empresa|compañía|trabajo en|soy de|de\s+)([A-ZÁÉÍÓÚ][^\n,.?!]{2,30})/i)?.[1]?.trim();
  const nombre  = text.match(/(?:me llamo|soy|nombre[:\s]+)([A-ZÁÉÍÓÚ][a-záéíóú]+ [A-ZÁÉÍÓÚ][a-záéíóú]+)/i)?.[1]?.trim();
  const gender  = detectGender(nombre);

  // Resumen de la conversación (últimos 4 turnos del usuario — ampliado)
  const userMsgs = messages.filter(m => m.role === 'user').slice(-4).map(m => m.content).join(' | ');

  return { email, empresa, nombre, gender, resumen: userMsgs.slice(0, 600) };
}

async function sendToCRM(lead) {
  try {
    await fetch('https://gettreevu.com/api/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-secret': process.env.LEAD_WEBHOOK_SECRET },
      body: JSON.stringify({
        name:      lead.nombre || 'Prospecto Web Chat',
        email:     lead.email,
        company:   lead.empresa || '',
        sector:    lead.profile?.sector || '',
        employees: lead.profile?.size   || '',
        objetivo:  lead.profile?.objetivo || '',
        message:   lead.resumen,
        source:    'Vü Chat (gettreevu.com)',
      }),
    });
  } catch (err) {
    console.error('[chat] CRM error:', err.message);
  }
}

export default async function handler(req, res) {
  const t0 = Date.now();
  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!isOriginAllowed(req)) {
    logWebhookReject('chat', 'origin_blocked', { origin: req.headers?.origin });
    return res.status(403).json({ error: 'Forbidden' });
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '';
  const rl = checkRateLimit(ip);
  if (!rl.allowed) {
    logRateLimit(ip, '/api/chat');
    res.setHeader('Retry-After', String(rl.retryAfter));
    return res.status(429).json({ error: 'Too many requests' });
  }

  const { messages, profile } = req.body || {};
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages required' });
  }
  // Bloquear inyección de roles no permitidos
  const validRoles = new Set(['user', 'assistant']);
  if (messages.some(m => !validRoles.has(m?.role) || typeof m?.content !== 'string')) {
    return res.status(400).json({ error: 'messages inválidos' });
  }

  // Si ya completó el flujo de calificación, enriquecer el system prompt
  const system = (profile?.sector)
    ? VU_SYSTEM + `\n\nCONTEXTO DEL PROSPECTO:\n- Sector: ${profile.sector}\n- Colaboradores: ${profile.size || 'No indicado'}\n- Objetivo: ${profile.objetivo || 'No indicado'}\nAdapta tu respuesta a este perfil. Sé específico con los números de impacto relevantes.`
    : VU_SYSTEM;

  try {
    const reply = (await askClaude(null, { system, messages, maxTokens: 300 })) || 'Escribenos a hello@gettreevu.com.';

    // ── Captura al CRM si detectamos email en la conversación ──────────
    const leadData = extractLeadFromChat(messages);
    if (leadData) {
      leadData.profile = profile || {};
      sendToCRM(leadData); // fire-and-forget
    }

    logRequest('/api/chat', 'POST', 200, Date.now() - t0, { leadCaptured: !!leadData });
    return res.status(200).json({ reply, leadCaptured: !!leadData });
  } catch (err) {
    logError('chat', err);
    return res.status(500).json({ error: 'Error del servidor' });
  }
}
