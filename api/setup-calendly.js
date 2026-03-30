// ── api/setup-calendly.js ─────────────────────────────────────────────────────
// Endpoint de uso único para registrar el webhook en Calendly
// Llamar UNA VEZ desde el navegador:
// https://gettreevu.com/api/setup-calendly?secret=TU_CRON_SECRET

const CALENDLY_TOKEN          = process.env.CALENDLY_TOKEN;
const CRON_SECRET             = process.env.CRON_SECRET;
const CALENDLY_WEBHOOK_SECRET = process.env.CALENDLY_WEBHOOK_SECRET;
const WEBHOOK_URL             = 'https://gettreevu.com/api/calendly-webhook';

export default async function handler(req, res) {
  // Seguridad: solo con secret correcto
  const secret = req.query?.secret;
  if (!secret || secret !== CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!CALENDLY_TOKEN) {
    return res.status(500).json({ error: 'CALENDLY_TOKEN no configurado en Vercel' });
  }

  try {
    // Paso 1: extraer user_uuid del JWT (evita llamar /users/me que requiere users:read)
    let userUri, orgUri;
    try {
      const payload = JSON.parse(Buffer.from(CALENDLY_TOKEN.split('.')[1], 'base64').toString('utf8'));
      const userUuid = payload.user_uuid;
      if (!userUuid) throw new Error('user_uuid no encontrado en JWT');
      userUri = `https://api.calendly.com/users/${userUuid}`;
      console.log(`[setup-calendly] User URI (from JWT): ${userUri}`);
    } catch (jwtErr) {
      return res.status(400).json({ error: `No se pudo decodificar el token JWT: ${jwtErr.message}` });
    }

    // Obtener org URI llamando al endpoint del usuario (requiere users:read o es público)
    const userRes = await fetch(userUri, {
      headers: { 'Authorization': `Bearer ${CALENDLY_TOKEN}` }
    });
    if (userRes.ok) {
      const userData = await userRes.json();
      orgUri = userData.resource?.current_organization;
    }

    // Fallback A: extraer org URI desde event_types (requiere scheduled_events:read)
    if (!orgUri) {
      console.log('[setup-calendly] Intentando obtener org URI desde /event_types...');
      const etRes = await fetch(
        `https://api.calendly.com/event_types?user=${encodeURIComponent(userUri)}&count=1`,
        { headers: { 'Authorization': `Bearer ${CALENDLY_TOKEN}` } }
      );
      if (etRes.ok) {
        const etData = await etRes.json();
        const firstEvent = etData.collection?.[0];
        if (firstEvent?.profile?.owner) {
          // profile.owner puede ser la org URI
          const owner = firstEvent.profile.owner;
          if (owner.includes('/organizations/')) {
            orgUri = owner;
            console.log(`[setup-calendly] Org URI (from event_types): ${orgUri}`);
          }
        }
      }
    }

    // Fallback B: intentar listar webhooks por user scope sin org URI
    if (!orgUri) {
      console.log('[setup-calendly] Intentando listar webhooks sin org URI...');
      const fallbackRes = await fetch(
        `https://api.calendly.com/webhook_subscriptions?user=${encodeURIComponent(userUri)}&scope=user`,
        { headers: { 'Authorization': `Bearer ${CALENDLY_TOKEN}` } }
      );
      if (fallbackRes.ok) {
        const fallbackData = await fallbackRes.json();
        const anyWebhook = fallbackData.collection?.[0];
        if (anyWebhook?.organization) {
          orgUri = anyWebhook.organization;
          console.log(`[setup-calendly] Org URI (from webhook): ${orgUri}`);
        }
      }
    }

    if (!userUri || !orgUri) {
      return res.status(400).json({
        error: 'No se pudo obtener org URI. Agrega el scope "users:read" al token de Calendly.',
        userUri
      });
    }

    console.log(`[setup-calendly] User URI: ${userUri}`);
    console.log(`[setup-calendly] Org URI:  ${orgUri}`);

    // Paso 2: listar webhooks existentes
    const existingRes = await fetch(
      `https://api.calendly.com/webhook_subscriptions?organization=${encodeURIComponent(orgUri)}&scope=user`,
      { headers: { 'Authorization': `Bearer ${CALENDLY_TOKEN}` } }
    );
    const existingData = await existingRes.json();
    const existing = existingData.collection?.find(w => w.callback_url === WEBHOOK_URL);

    // Si ya existe, borrarlo para poder re-registrar con signing_key
    if (existing) {
      const webhookUri = existing.uri;
      const webhookId = webhookUri.split('/').pop();
      await fetch(`https://api.calendly.com/webhook_subscriptions/${webhookId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${CALENDLY_TOKEN}` }
      });
      console.log(`[setup-calendly] Webhook anterior eliminado: ${webhookId}`);
    }

    // Paso 3: registrar el webhook (con signing_key si está disponible)
    const webhookBody = {
      url: WEBHOOK_URL,
      events: ['invitee.created', 'invitee.canceled'],
      organization: orgUri,
      user: userUri,
      scope: 'user'
    };
    if (CALENDLY_WEBHOOK_SECRET) {
      webhookBody.signing_key = CALENDLY_WEBHOOK_SECRET;
    }

    const webhookRes = await fetch('https://api.calendly.com/webhook_subscriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CALENDLY_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(webhookBody)
    });

    if (!webhookRes.ok) {
      const err = await webhookRes.text();
      return res.status(400).json({ error: `Calendly webhook creation falló: ${err}` });
    }

    const webhookData = await webhookRes.json();
    console.log(`[setup-calendly] Webhook registrado OK: ${webhookData.resource?.uri}`);

    return res.status(200).json({
      success: true,
      message: '✅ Webhook de Calendly registrado correctamente',
      webhook_url: WEBHOOK_URL,
      events: ['invitee.created', 'invitee.canceled'],
      signing_key_active: !!CALENDLY_WEBHOOK_SECRET,
      calendly_webhook_id: webhookData.resource?.uri
    });

  } catch (err) {
    console.error('[setup-calendly] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
