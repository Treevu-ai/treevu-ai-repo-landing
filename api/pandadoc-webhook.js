// api/pandadoc-webhook.js — Recibe webhooks de PandaDoc al completarse una firma
//
// Setup en PandaDoc: Settings → Integrations → Webhook → Add endpoint
//   URL: https://gettreevu.com/api/pandadoc-webhook
//   Events: document_state_changed
//
// Flujo al recibir firma completada:
//   1. Identifica lead en Notion por metadata.lead_id o email del recipient
//   2. Actualiza estado Notion → Cerrado
//   3. Envía email de bienvenida al cliente via Gmail
//   4. Notifica al CEO por Telegram: ¡deal cerrado!

import { NOTION }                              from './lib/constants.js';
import { notionQuery, notionPatch, getProp }    from './lib/notion.js';
import { getGmailToken, gmailSend }             from './lib/gmail.js';
import { sendMessage }                          from './lib/telegram.js';
import { captureException }                     from './lib/sentry.js';

const BOT_TOKEN       = process.env.TELEGRAM_BOT_TOKEN;
const CEO_CHAT_ID     = process.env.TELEGRAM_CHAT_ID;
const PANDADOC_KEY    = process.env.PANDADOC_API_KEY;

const send = (text, extra = {}) => sendMessage(BOT_TOKEN, CEO_CHAT_ID, text, extra);

// ── Buscar lead por email ─────────────────────────────────────────────────────
async function findLeadByEmail(email) {
  const data = await notionQuery(NOTION.CRM_DB, {
    property: 'Email', email: { equals: email },
  }, 1);
  return data.results?.[0] || null;
}

// ── Email de bienvenida ───────────────────────────────────────────────────────
function buildWelcomeEmail(empresa, contacto) {
  return `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a">
  <div style="background:#0f4c81;padding:32px;border-radius:8px 8px 0 0">
    <h1 style="color:#fff;margin:0;font-size:24px">¡Bienvenidos a Treevü! 🎉</h1>
  </div>
  <div style="background:#fff;padding:32px;border:1px solid #e5e7eb;border-radius:0 0 8px 8px">
    <p>Hola${contacto ? ` ${contacto}` : ''},</p>
    <p>Es un placer dar la bienvenida a <strong>${empresa}</strong> a la familia Treevü. ¡El contrato está firmado y estamos listos para comenzar!</p>

    <h2 style="color:#0f4c81;font-size:18px">Próximos pasos</h2>
    <ol style="padding-left:20px;line-height:2">
      <li>Nuestro equipo técnico se pondrá en contacto en las próximas <strong>24 horas</strong> para coordinar la integración con su sistema de nómina.</li>
      <li>La plataforma estará lista para sus colaboradores en <strong>48 horas</strong>.</li>
      <li>Realizaremos una sesión de onboarding para el equipo de RR.HH.</li>
    </ol>

    <div style="background:#f0fdf4;border-left:4px solid #10b981;padding:16px;border-radius:4px;margin:24px 0">
      <p style="margin:0;font-weight:bold;color:#065f46">¿Alguna duda? Escríbenos</p>
      <p style="margin:8px 0 0">📧 <a href="mailto:hello@gettreevu.com" style="color:#0f4c81">hello@gettreevu.com</a></p>
    </div>

    <p>¡Gracias por confiar en nosotros!</p>
    <p style="margin-top:32px;color:#6b7280;font-size:14px">
      El equipo Treevü<br>
      <a href="https://gettreevu.com" style="color:#0f4c81">gettreevu.com</a>
    </p>
  </div>
</div>`;
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // PandaDoc recomienda verificar por API key en header o shared secret
  const authHeader = req.headers['authorization'] || '';
  if (PANDADOC_KEY && authHeader !== `API-Key ${PANDADOC_KEY}`) {
    console.warn('[pandadoc] Auth fallida');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const body = req.body || {};

  // PandaDoc envía array de eventos
  const events = Array.isArray(body) ? body : [body];

  for (const evt of events) {
    const event  = evt.event  || evt.type || '';
    const data   = evt.data   || evt.payload || evt;

    // Solo procesar documento completado (todos firmaron)
    const status = data.status || '';
    if (event !== 'document_state_changed' && !event.includes('document')) continue;
    if (!['document.completed', 'completed'].includes(status)) {
      console.log(`[pandadoc] Ignorado — event: ${event}, status: ${status}`);
      continue;
    }

    const docId   = data.id   || data.document?.id || '';
    const docName = data.name || data.document?.name || '';

    // Extraer lead_id de metadata si fue incluido al crear el doc
    const leadId  = data.metadata?.lead_id || data.tokens?.find(t => t.name === 'lead_id')?.value || '';

    // Extraer email del recipient principal
    const recipients = data.recipients || data.document?.recipients || [];
    const clientEmail = recipients.find(r => r.role !== 'signer.treevü' && r.role !== 'Treevü')?.email
      || recipients[0]?.email || '';

    console.log(`[pandadoc] Documento firmado: "${docName}" · email: ${clientEmail} · lead_id: ${leadId}`);

    try {
      // Buscar lead en Notion
      let lead = null;
      if (leadId) {
        const { getNotionPage } = await import('./lib/notion.js');
        lead = await getNotionPage(leadId).catch(() => null);
      }
      if (!lead && clientEmail) {
        lead = await findLeadByEmail(clientEmail);
      }

      const empresa = lead ? (getProp(lead, 'Empresa') || '') : docName;
      const contacto = lead ? (getProp(lead, 'Nombre') || getProp(lead, 'Contacto') || '') : '';
      const email   = lead ? (getProp(lead, 'Email') || clientEmail) : clientEmail;

      // Actualizar Notion → Cerrado
      if (lead) {
        await notionPatch(lead.id, {
          Estado: { select: { name: 'Cerrado' } },
          Notas:  { rich_text: [{ text: { content:
            `${getProp(lead, 'Notas') ? getProp(lead, 'Notas') + '\n\n' : ''}✅ Contrato firmado el ${new Date().toLocaleDateString('es-PE', { timeZone: 'America/Lima' })} via PandaDoc (doc: ${docId})`
          } }] },
        });
        console.log(`[pandadoc] Notion actualizado → Cerrado: ${empresa}`);
      }

      // Email de bienvenida al cliente
      if (email) {
        const token = await getGmailToken();
        if (token) {
          await gmailSend(token, {
            to:       email,
            subject:  `¡Bienvenidos a Treevü, ${empresa}! — Próximos pasos`,
            bodyHtml: buildWelcomeEmail(empresa, contacto),
          });
          console.log(`[pandadoc] Email de bienvenida enviado a ${email}`);
        }
      }

      // Notificar CEO
      const mrr = lead ? (() => {
        const colabs = getProp(lead, 'Colaboradores') || '';
        const n = parseInt((colabs).split('-')[0].replace('+', '')) || 0;
        return n ? `S/ ${((Math.round(n * 0.30) * 7) + 490).toLocaleString('es-PE')}/mes` : null;
      })() : null;

      let msg = `🎉 *¡DEAL CERRADO!*\n\n`;
      msg += `🏢 *${empresa}*\n`;
      if (contacto) msg += `👤 ${contacto}\n`;
      if (email)    msg += `📧 ${email}\n`;
      if (mrr)      msg += `💰 MRR: *${mrr}*\n`;
      msg += `\n✅ Contrato firmado vía PandaDoc\n`;
      msg += `📧 Email de bienvenida enviado\n`;
      if (lead)     msg += `📋 Notion → Cerrado`;
      else          msg += `⚠️ Lead no encontrado en Notion (email: ${clientEmail})`;

      await send(msg);

    } catch (err) {
      console.error('[pandadoc] Error procesando evento:', err.message);
      captureException(err, { path: '/api/pandadoc-webhook', docId, docName });
    }
  }

  return res.status(200).json({ ok: true });
}
