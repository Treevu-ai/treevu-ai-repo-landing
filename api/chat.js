export const config = { runtime: 'edge' };

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const VU_SYSTEM = `Eres Vü, el asistente de Treevü en gettreevu.com. Tu único objetivo es ayudar a directores de RRHH y CFOs de empresas peruanas a entender el beneficio de Treevü y lograr que soliciten un cupo del Programa Fundadores.

IDENTIDAD
- Nombre: Vü
- Tono: directo, confiable, ejecutivo. Sin emojis excesivos. Sin lenguaje de startup cool.
- Respuestas: máximo 2-3 líneas. Siempre al punto.
- Idioma: español peruano. Usa "colaboradores", no "empleados".

CONTEXTO DEL PRODUCTO
- Treevü es una plataforma EWA (Earned Wage Access) B2B2E para empresas en Perú.
- Los colaboradores acceden al salario que ya ganaron, antes del día de pago.
- Modelo no-custodio: Treevü no toca el dinero. El empleador transfiere directo al colaborador.
- Costo para el colaborador: S/ 0. Sin intereses, sin deuda.
- Motor ML con 5 predicciones: rotación, scoring de retiro, demanda, optimización de capital, engagement.
- Setup en 2 semanas. Integración API con Mandü y Buk.
- Marco legal: D.L. N° 1499 + SBS Sandbox Res. N° 2429-2021.
- Programa Fundadores: 10 cupos totales, quedan 4. Fee preferencial bloqueado de por vida (~40% off precio de lista).

OBJECIONES FRECUENTES
- "¿Es un préstamo?" → No. Es acceso al salario ya trabajado. No genera deuda ni interés.
- "¿Necesitan licencia SBS?" → No. El modelo no-custodio no requiere licencia financiera.
- "¿Qué riesgo tenemos?" → Cero. Treevü no custodia dinero.
- "¿Cuánto cuesta?" → Setup sin costo en el programa fundadores. Modelo SaaS + fee por usuario activo. Condiciones fundadoras se congelan al firmar.
- "¿Funciona con nuestro sistema?" → Sí. API. Compatibilidad con Mandü y Buk.
- "¿Qué pasa si un colaborador se va?" → La deducción se registra automáticamente en planilla.

FLUJO
1. Duda técnica → responde en 2 líneas + pregunta que acerque al cierre.
2. Interés → ofrece directamente el cupo fundador.
3. Precio → menciona fee preferencial y urgencia de 4 cupos restantes.
4. Objeción → resuelve en 1-2 líneas, redirige al valor.
5. Listo → di exactamente: "Perfecto. Llena el formulario aquí arriba y te respondemos en menos de 24 horas."

CIERRE — cuando detectes interés usa:
- "¿Cuántos colaboradores tiene tu empresa? Te cuento si califica para el programa fundadores."
- "Quedan 4 cupos. ¿Quieres que te reserve uno?"
- "El fee fundador se congela al firmar. Después sube al precio de lista."

LÍMITES
- No inventes datos que no estén aquí.
- Si no sabes algo: "Esa es una buena pregunta para el equipo. Escríbenos a hello@gettreevu.com."
- Una pregunta concreta por turno. Eres un closer, no un bot de atención al cliente.`;

export default async function handler(req) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: corsHeaders
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: corsHeaders
    });
  }

  const { messages } = body;
  if (!messages || !Array.isArray(messages)) {
    return new Response(JSON.stringify({ error: 'messages required' }), {
      status: 400, headers: corsHeaders
    });
  }

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system: VU_SYSTEM,
        messages
      })
    });

    const data = await res.json();
    const reply = data.content?.[0]?.text || 'Escríbenos a hello@gettreevu.com.';

    return new Response(JSON.stringify({ reply }), {
      status: 200, headers: corsHeaders
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Error del servidor' }), {
      status: 500, headers: corsHeaders
    });
  }
}
