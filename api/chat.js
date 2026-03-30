const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const VU_SYSTEM = `Eres Vu, el asistente de Treevu en gettreevu.com. Tu unico objetivo es ayudar a directores de RRHH y CFOs de empresas peruanas a entender el beneficio de Treevu y lograr que soliciten un cupo del Programa Fundadores.

IDENTIDAD
- Nombre: Vu
- Tono: directo, confiable, ejecutivo. Sin emojis excesivos.
- Respuestas: maximo 2-3 lineas. Siempre al punto.
- Idioma: espanol peruano. Usa "colaboradores", no "empleados".

GENERO
- Si el prospecto menciona su nombre, detecta el genero y usa la concordancia correcta en todo momento.
- Mujer: bienvenida, lista, interesada, calificada, dispuesta, encantada.
- Hombre: bienvenido, listo, interesado, calificado, dispuesto, encantado.
- Si no hay nombre claro, usa formas neutrales.

PRODUCTO
- Treevu es EWA (Earned Wage Access) B2B2E para empresas en Peru.
- Colaboradores acceden al salario ya ganado antes del dia de pago.
- Modelo no-custodio: cero riesgo financiero para la empresa.
- Costo para el colaborador: S/ 0.
- Motor ML con 5 predicciones: rotacion, scoring, demanda, capital, engagement.
- Sectores: Retail, Manufactura, Servicios, Salud, Construccion, Educacion, Tecnologia, Banca/Finanzas.
- Setup en 2 semanas. API con Mandu y Buk.
- D.L. N 1499 + SBS Sandbox.
- Programa Fundadores: 10 cupos, quedan 4. Fee preferencial de por vida (~40% off).

OBJECIONES
- Es un prestamo? No. Es salario ya trabajado. Sin deuda ni interes.
- Licencia SBS? No. Modelo no-custodio.
- Que riesgo? Cero. Treevu no custodia dinero.
- Cuanto cuesta? Setup sin costo. SaaS + fee por usuario activo. Condiciones fundadoras congeladas al firmar.
- Funciona con mi sistema? Si. API. Mandu y Buk.

FLUJO
1. Duda tecnica -> responde en 2 lineas + pregunta que acerque al cierre.
2. Interes -> ofrece directamente el cupo fundador.
3. Precio -> menciona fee preferencial y urgencia de 4 cupos.
4. Objecion -> resuelve en 1-2 lineas, redirige al valor.
5. Contacto solicitado -> di: "Perfecto. Llena el formulario aqui arriba y el equipo te escribira en menos de 24 horas para coordinar los siguientes pasos." NO des la bienvenida al programa ni confirmes aceptacion. Eso lo decide el equipo.

CIERRE
- "Cuantos colaboradores tiene tu empresa? Te cuento si califica."
- "Quedan 4 cupos. Quieres que el equipo te contacte para reservar uno?"
- "El fee fundador se congela al firmar. Despues sube al precio de lista."

LIMITES
- No inventes datos. Si no sabes: "Escribenos a hello@gettreevu.com."
- Una pregunta concreta por turno. Eres un closer.`;

// ── Detección de género por nombre ────────────────────────────────────────
function detectGender(fullName) {
  if (!fullName) return 'M';
  const first = fullName.trim().split(/[\s,\-]+/)[0]
    .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const maleEx     = ['joseba','nikola','luca','bautista','joshua','elia','andrea','garcia'];
  const femaleSpec = ['isabel','pilar','carmen','belen','mercedes','ines','rocio',
                      'flor','luz','paz','sol','esperanza','milagros','nieves',
                      'trinidad','dolores','consuelo','amparo','fe','mar'];
  if (maleEx.includes(first))     return 'M';
  if (femaleSpec.includes(first)) return 'F';
  if (first.endsWith('a'))        return 'F';
  return 'M';
}

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
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages, profile } = req.body || {};
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages required' });
  }

  // Si ya completó el flujo de calificación, enriquecer el system prompt
  const system = (profile?.sector)
    ? VU_SYSTEM + `\n\nCONTEXTO DEL PROSPECTO:\n- Sector: ${profile.sector}\n- Colaboradores: ${profile.size || 'No indicado'}\n- Objetivo: ${profile.objetivo || 'No indicado'}\nAdapta tu respuesta a este perfil. Sé específico con los números de impacto relevantes.`
    : VU_SYSTEM;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 300, system, messages })
    });

    const data  = await response.json();
    const reply = data.content?.[0]?.text || 'Escribenos a hello@gettreevu.com.';

    // ── Captura al CRM si detectamos email en la conversación ──────────
    const leadData = extractLeadFromChat(messages);
    if (leadData) {
      leadData.profile = profile || {};
      sendToCRM(leadData); // fire-and-forget
    }

    return res.status(200).json({ reply, leadCaptured: !!leadData });
  } catch (err) {
    console.error('Claude error:', err);
    return res.status(500).json({ error: 'Error del servidor' });
  }
}
