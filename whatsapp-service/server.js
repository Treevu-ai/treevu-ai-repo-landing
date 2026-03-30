/**
 * whatsapp-service/server.js — Treevü WhatsApp Bridge
 *
 * Corre como proceso persistente (local o Fly.io).
 * Vercel no es compatible — este servicio necesita conexión 24/7.
 *
 * Endpoints:
 *   GET  /health  → estado de la conexión WhatsApp
 *   POST /send    → envía mensaje a un número
 *
 * Variables de entorno:
 *   PORT                     → (opcional) puerto, default 3001
 *   WHATSAPP_SERVICE_SECRET  → secret para autenticar /send
 *   TELEGRAM_BOT_TOKEN       → para reenviar mensajes entrantes
 *   TELEGRAM_ABM_CHAT_ID     → chat destino en Telegram
 */

import 'dotenv/config';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import express from 'express';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import QRCode from 'qrcode';

const app = express();
app.use(express.json());

const PORT               = process.env.PORT                    || 3001;
const SERVICE_SECRET     = process.env.WHATSAPP_SERVICE_SECRET;
if (!SERVICE_SECRET) {
  console.error('[wa] FATAL: WHATSAPP_SERVICE_SECRET no configurado — servicio /send deshabilitado');
}
const TELEGRAM_TOKEN     = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_ABM_CHAT_ID;
const NOTION_TOKEN       = process.env.NOTION_API_KEY;
const NOTION_EJECUCION_DB = 'bcebf14878f04db087f052722f9a084d';

let sock        = null;
let isConnected = false;

// ── Cache de números conocidos (evita consultar Notion en cada mensaje) ────────
const phoneCache = new Map(); // phone → { empresa, decisor, pageId } | null

async function findLeadByPhone(phone) {
  if (phoneCache.has(phone)) return phoneCache.get(phone);
  if (!NOTION_TOKEN) {
    console.warn('[wa] ⚠️  NOTION_API_KEY no configurado — todos los mensajes serán bloqueados');
    return null;
  }

  try {
    // Normalizar: quitar prefijo de país para búsqueda flexible
    const local = phone.replace(/^51/, ''); // quita +51 peruano

    // Paginar hasta agotar resultados (Notion devuelve max 100 por request)
    let cursor    = undefined;
    let hasMore   = true;

    while (hasMore) {
      const body = { page_size: 100 };
      if (cursor) body.start_cursor = cursor;

      const res  = await fetch(`https://api.notion.com/v1/databases/${NOTION_EJECUCION_DB}/query`, {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
        body:    JSON.stringify(body),
      });
      const data = await res.json();

      for (const page of data.results || []) {
        const tel = (page.properties?.['Teléfono']?.phone_number || '').replace(/\D/g, '');
        if (!tel) continue;
        const telLocal = tel.replace(/^51/, '');
        if (tel === phone || telLocal === local || tel === local || telLocal === phone) {
          const match = {
            empresa: page.properties?.['Empresa']?.title?.[0]?.plain_text || '',
            decisor: page.properties?.['Decisor']?.rich_text?.[0]?.plain_text || '',
            pageId:  page.id,
          };
          phoneCache.set(phone, match);
          setTimeout(() => phoneCache.delete(phone), 30 * 60 * 1000);
          return match;
        }
      }

      hasMore = data.has_more || false;
      cursor  = data.next_cursor || undefined;
    }

    // No encontrado — cachear como null por 10 min
    phoneCache.set(phone, null);
    setTimeout(() => phoneCache.delete(phone), 10 * 60 * 1000);
    return null;
  } catch (err) {
    console.error('[wa] notion lookup error:', err.message);
    return null;
  }
}


// ── Conectar a WhatsApp ────────────────────────────────────────────────────────
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const { version }          = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth:    state,
    logger:  pino({ level: 'silent' }),
    browser: ['Treevü ABM', 'Chrome', '1.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async update => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n📱 Escanea este QR con tu número secundario de WhatsApp:\n');
      qrcode.generate(qr, { small: true });
      // Enviar QR como imagen a Telegram
      if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
        try {
          const qrBuffer = await QRCode.toBuffer(qr, { scale: 8 });
          const form = new FormData();
          form.append('chat_id', TELEGRAM_CHAT_ID);
          form.append('photo', new Blob([qrBuffer], { type: 'image/png' }), 'qr.png');
          form.append('caption', '📱 *Escanea este QR para vincular WhatsApp*\n_Se generó porque la sesión expiró o es la primera vez._');
          form.append('parse_mode', 'Markdown');
          await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`, {
            method: 'POST', body: form,
          });
          console.log('[wa] QR enviado a Telegram');
        } catch (e) {
          console.error('[wa] QR telegram error:', e.message);
        }
      }
    }

    if (connection === 'close') {
      isConnected = false;
      const code = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode
        : null;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log(`[wa] Conexión cerrada (código ${code}). ${shouldReconnect ? 'Reconectando en 5s...' : 'Sesión cerrada — re-escanea QR.'}`);
      // Alerta Telegram en desconexión inesperada
      if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
        const alertMsg = shouldReconnect
          ? `⚠️ *WhatsApp desconectado* — reconectando automáticamente\nCódigo: \`${code || 'desconocido'}\``
          : `🔴 *WhatsApp cerró sesión* — re-escanea el QR para reconectar\nCódigo: \`${code}\``;
        fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: alertMsg, parse_mode: 'Markdown' }),
        }).catch(() => {});
      }
      if (shouldReconnect) setTimeout(connectToWhatsApp, 5000);
    } else if (connection === 'open') {
      isConnected = true;
      console.log(`✅ WhatsApp conectado — ${sock.user?.name || sock.user?.id}`);
      // Verificar acceso a Notion y contar números vigilados
      if (NOTION_TOKEN) {
        try {
          const r = await fetch(`https://api.notion.com/v1/databases/${NOTION_EJECUCION_DB}/query`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Content-Type': 'application/json', 'Notion-Version': '2022-06-28' },
            body: JSON.stringify({ page_size: 100 }),
          });
          const d = await r.json();
          if (d.results) {
            const numeros = d.results.filter(p => p.properties?.['Teléfono']?.phone_number?.trim()).length;
            console.log(`[wa] 🛡️  Filtro ABM activo — ${d.results.length} empresas, ${numeros} números vigilados`);
          } else {
            console.warn('[wa] ⚠️  Notion responde pero sin resultados. Verifica NOTION_API_KEY.');
          }
        } catch (e) {
          console.error('[wa] ❌ No se pudo conectar con Notion:', e.message);
        }
      } else {
        console.warn('[wa] ⚠️  NOTION_API_KEY no configurado — filtro ABM INACTIVO');
      }
    }
  });

  // ── Mensajes entrantes (solo de leads en Notion Ejecución) ──────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      const jid = msg.key.remoteJid || '';

      // Barrera 1 — solo chats personales 1-a-1 (descarta grupos, newsletters, broadcasts)
      if (!jid.endsWith('@s.whatsapp.net')) {
        console.log(`[wa] 🔕 JID no personal descartado: ${jid.split('@')[1] || jid}`);
        continue;
      }

      // Barrera 2 — descartar mensajes propios
      if (msg.key.fromMe) continue;

      // Barrera 3 — descartar sin contenido
      if (!msg.message) continue;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        msg.message.imageMessage?.caption ||
        '';

      if (!text.trim()) continue;

      // Barrera 4 — validar longitud del número (newsletters/canales tienen 15-18 dígitos)
      // Teléfonos reales: máx 13 dígitos (código país + número)
      const phone = jid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
      if (phone.length > 13) {
        console.log(`[wa] 🔕 Número descartado — ${phone.length} dígitos (newsletter/canal): +${phone.slice(0, 6)}...`);
        continue;
      }

      // Barrera 5 — lookup en Notion ABM
      const lead = await findLeadByPhone(phone);

      if (!lead) {
        console.log(`[wa] 🔕 Bloqueado (+${phone}) — no está en Notion ABM`);
        continue;
      }

      // Reenvío a Telegram desactivado — WhatsApp fuera del flujo ABM
      console.log(`[wa] 🔕 Reenvío desactivado: ${lead.empresa} (+${phone}): "${text.slice(0, 80)}"`);
    }
  });
}

// ── REST API ───────────────────────────────────────────────────────────────────

app.get('/health', (_, res) => {
  res.json({
    ok:        true,
    connected: isConnected,
    user:      sock?.user?.name || sock?.user?.id || null,
  });
});

app.post('/send', async (req, res) => {
  const { to, message } = req.body || {};

  // Acepta auth via Authorization header (Bearer) o body.secret (legacy)
  const authHeader = req.headers['authorization'];
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const providedSecret = bearerToken || req.body?.secret;

  if (!SERVICE_SECRET || providedSecret !== SERVICE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!isConnected || !sock) {
    return res.status(503).json({ error: 'WhatsApp no conectado. Inicia el servicio y escanea el QR.' });
  }
  if (!to || !message) {
    return res.status(400).json({ error: 'to y message son requeridos' });
  }

  try {
    const phone = String(to).replace(/\D/g, '');
    const jid   = `${phone}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    console.log(`[wa] ✅ Enviado a +${phone}: "${message.slice(0, 60)}..."`);
    res.json({ success: true, to: phone });
  } catch (err) {
    console.error('[wa] send error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Arrancar ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🤖 Treevü WhatsApp Service`);
  console.log(`   Puerto:   ${PORT}`);
  console.log(`   Secret:   ${SERVICE_SECRET}`);
  console.log(`   Telegram: ${TELEGRAM_CHAT_ID ? '✅ configurado' : '⚠️  sin TELEGRAM_ABM_CHAT_ID'}\n`);
});

connectToWhatsApp();
