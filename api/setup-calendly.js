// ── api/setup-calendly.js ─────────────────────────────────────────────────────
// Endpoint de uso único para registrar el webhook en Calendly
// Llamar UNA VEZ desde el navegador:
// https://gettreevu.com/api/setup-calendly?secret=TU_CRON_SECRET

const CALENDLY_TOKEN  = process.env.CALENDLY_TOKEN;
const CRON_SECRET     = process.env.CRON_SECRET;
const WEBHOOK_URL     = 'https://gettreevu.com/api/calendly-webhook';

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
    // Paso 1: obtener user URI y org URI
    const meRes = await fetch('https://api.calendly.com/users/me', {
      headers: { 'Authorization': `Bearer ${CALENDLY_TOKEN}` }
    });

    if (!meRes.ok) {
      const err = await meRes.text();
      return res.status(400).json({ error: `Calendly /users/me falló: ${err}` });
    }

    const meData = await meRes.json();
    const userUri = meData.resource?.uri;
    const orgUri  = meData.resource?.current_organization;

    console.log(`[setup-calendly] User URI: ${userUri}`);
    console.log(`[setup-calendly] Org URI:  ${orgUri}`);

    if (!userUri || !orgUri) {
      return res.status(400).json({ error: 'No se pudo obtener user URI u org URI', meData });
    }

    // Paso 2: verificar si el webhook ya existe
    const existingRes = await fetch(
      `https://api.calendly.com/webhook_subscriptions?organization=${encodeURIComponent(orgUri)}&scope=user`,
      { headers: { 'Authorization': `Bearer ${CALENDLY_TOKEN}` } }
    );
    const existingData = await existingRes.json();
    const alreadyExists = existingData.collection?.some(w => w.callback_url === WEBHOOK_URL);

    if (alreadyExists) {
      return res.status(200).json({
        success: true,
        message: 'Webhook ya estaba registrado',
        webhook_url: WEBHOOK_URL
      });
    }

    // Paso 3: registrar el webhook
    const webhookRes = await fetch('https://api.calendly.com/webhook_subscriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CALENDLY_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        url: WEBHOOK_URL,
        events: ['invitee.created', 'invitee.canceled'],
        organization: orgUri,
        user: userUri,
        scope: 'user'
      })
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
      calendly_webhook_id: webhookData.resource?.uri
    });

  } catch (err) {
    console.error('[setup-calendly] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
