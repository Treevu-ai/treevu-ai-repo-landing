/**
 * scripts/get-chat-id.js
 * Corre UNA VEZ para obtener el Chat ID del grupo ABM.
 *
 * Pasos previos:
 *  1. Crear el bot en @BotFather y guardar el token en .env.local
 *  2. Invitar el bot al grupo "🤖 Treevü ABM Notificaciones"
 *  3. Enviar cualquier mensaje en el grupo (ej: "hola")
 *  4. Ejecutar: node scripts/get-chat-id.js
 *  5. Copiar el chat_id (número negativo) y pegarlo en .env.local como TELEGRAM_ABM_CHAT_ID
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

// Cargar .env.local manualmente (sin dependencias externas)
try {
  const envPath = resolve(process.cwd(), '.env.local');
  const lines   = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const [key, ...rest] = line.split('=');
    if (key && rest.length) {
      process.env[key.trim()] = rest.join('=').trim().replace(/^"|"$/g, '');
    }
  }
} catch {
  console.warn('No se pudo leer .env.local — asegúrate de tener TELEGRAM_BOT_TOKEN en el entorno');
}

const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token || token.startsWith('REEMPLAZAR')) {
  console.error('❌ TELEGRAM_BOT_TOKEN no está configurado en .env.local');
  console.error('   Pega el token del nuevo bot antes de correr este script.');
  process.exit(1);
}

console.log('🔍 Consultando getUpdates...\n');

const res  = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
const data = await res.json();

if (!data.ok) {
  console.error('❌ Error de Telegram:', data.description);
  process.exit(1);
}

if (!data.result?.length) {
  console.warn('⚠️  Sin mensajes recientes.');
  console.warn('   Asegúrate de:');
  console.warn('   1. Haber invitado el bot al grupo');
  console.warn('   2. Haber enviado al menos un mensaje en el grupo DESPUÉS de invitarlo');
  process.exit(0);
}

const grupos = new Map();

for (const update of data.result) {
  const msg = update.message || update.channel_post;
  if (!msg) continue;
  const { id, title, type } = msg.chat;
  if (type === 'group' || type === 'supergroup') {
    grupos.set(id, title || '(sin nombre)');
  }
}

if (!grupos.size) {
  console.warn('⚠️  No se encontraron mensajes de grupos.');
  console.warn('   Envía un mensaje en el grupo e intenta de nuevo.');
  process.exit(0);
}

console.log('✅ Grupos encontrados:\n');
for (const [id, title] of grupos) {
  console.log(`  ${title}`);
  console.log(`  TELEGRAM_ABM_CHAT_ID="${id}"\n`);
}
console.log('Copia el valor de TELEGRAM_ABM_CHAT_ID en tu .env.local');
