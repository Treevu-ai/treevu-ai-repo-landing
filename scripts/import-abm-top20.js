/**
 * scripts/import-abm-top20.js
 *
 * Lee el CSV de empresas, calcula Score ICP, importa las top 20
 * a la base de Ejecución de Notion como leads pendientes.
 *
 * Uso:
 *   node scripts/import-abm-top20.js
 *
 * Variables de entorno requeridas:
 *   NOTION_API_KEY (o en .env.local)
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────────
// Leer .env.local manualmente (sin depender de dotenv)
try {
  const env = readFileSync(resolve(__dirname, '../.env.local'), 'utf-8');
  for (const line of env.split('\n')) {
    const m = line.match(/^([^#=]+)=["']?(.+?)["']?\s*$/);
    if (m) process.env[m[1].trim()] = m[2].trim();
  }
} catch {}

const NOTION_TOKEN     = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN;
const NOTION_EJECUCION = 'bcebf14878f04db087f052722f9a084d';
const CSV_PATH         = resolve('C:/Users/acuba/Downloads/CCPLL_ABM_Limpio_ParaNotion (1).csv');
const TOP_N            = 20;
const DELAY_MS         = 400; // entre requests a Notion (rate limit)

if (!NOTION_TOKEN) {
  console.error('❌ NOTION_API_KEY no encontrado en .env.local');
  process.exit(1);
}

// ── Parsear CSV ───────────────────────────────────────────────────────────────
function parseCSV(content) {
  const lines = content.trim().split('\n');
  const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim());
  return lines.slice(1).map(line => {
    const vals = [];
    let cur = '', inQ = false;
    for (const c of line) {
      if (c === '"') inQ = !inQ;
      else if (c === ',' && !inQ) { vals.push(cur.trim()); cur = ''; }
      else cur += c;
    }
    vals.push(cur.trim());
    return Object.fromEntries(headers.map((h, i) => [h, (vals[i] || '').replace(/^"|"$/g, '').trim()]));
  });
}

// ── Scoring ICP ───────────────────────────────────────────────────────────────
// Escala 1-10 basada en datos disponibles
function calcScore(row) {
  let pts = 0;

  // Sector (Manufactura = mayor rotación, mejor fit para EWA)
  const sector = row['Sector'] || '';
  if (sector === 'Manufactura')                                          pts += 4;
  else if (['Construcción', 'Transportes'].includes(sector))            pts += 3;
  else if (sector === 'Servicios Especializados')                       pts += 2;
  else                                                                   pts += 1; // Comercio

  // Decisor identificado con teléfono directo = contactabilidad alta
  if (row['Nombre Decisor']?.trim())    pts += 2;
  if (row['Teléfono Decisor']?.trim())  pts += 2;
  else if (row['Teléfono Primario']?.trim()) pts += 1;
  if (row['Email Decisor']?.trim())     pts += 1;
  else if (row['Email Primario']?.trim()) pts += 0.5;
  if (row['Sitio Web']?.trim())         pts += 0.5;

  return Math.min(10, Math.round(pts));
}

// ── Limpiar teléfono ──────────────────────────────────────────────────────────
function cleanPhone(raw) {
  if (!raw?.trim()) return null;
  // Tomar primer número si hay varios separados por espacio
  const first = raw.trim().split(/\s+/)[0];
  const digits = first.replace(/\D/g, '');
  if (digits.length < 7) return null;
  // Agregar prefijo peruano si es número local
  if (digits.length === 9 && digits.startsWith('9')) return `+51${digits}`;
  if (digits.length === 9) return `+51${digits}`;
  if (digits.length === 7 || digits.length === 8) return `+5144${digits}`; // Trujillo
  return `+${digits}`;
}

// ── Crear página en Notion ────────────────────────────────────────────────────
async function createLead(row, score) {
  const phone = cleanPhone(row['Teléfono Decisor']) || cleanPhone(row['Teléfono Primario']);
  const email = row['Email Decisor']?.trim() || row['Email Primario']?.trim() || null;
  const decisor = [row['Nombre Decisor']?.trim(), row['Cargo Decisor']?.trim()]
    .filter(Boolean).join(', ') || row['Representante Legal']?.trim() || '';
  const notas = [row['Actividad Económica']?.trim(), row['Notas Internas']?.trim()]
    .filter(Boolean).join(' | ') || '';

  const properties = {
    'Empresa':   { title:    [{ text: { content: row['Empresa'] || 'Sin nombre' } }] },
    'Decisor':   { rich_text: [{ text: { content: decisor } }] },
    'Score ICP': { number:   score },
  };

  if (row['Sector']?.trim()) properties['Sector'] = { select: { name: row['Sector'].trim() } };
  if (phone)   properties['Teléfono']     = { phone_number: phone };
  if (email)   properties['Email Decisor'] = { email };
  if (notas)   properties['Notas']        = { rich_text: [{ text: { content: notas.slice(0, 2000) } }] };

  const res = await fetch('https://api.notion.com/v1/pages', {
    method:  'POST',
    headers: {
      'Authorization':  `Bearer ${NOTION_TOKEN}`,
      'Content-Type':   'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: JSON.stringify({ parent: { database_id: NOTION_EJECUCION }, properties }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Notion ${res.status}: ${err}`);
  }
  return res.json();
}

// ── Main ──────────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

const content = readFileSync(CSV_PATH, 'utf-8');
const rows    = parseCSV(content);

// Calcular score y ordenar
const scored = rows
  .map(r => ({ ...r, _score: calcScore(r) }))
  .sort((a, b) => b._score - a._score);

const top20 = scored.slice(0, TOP_N);

console.log(`\n📊 Top ${TOP_N} empresas por Score ICP:\n`);
console.log('Score  Sector                    Empresa');
console.log('─'.repeat(70));
top20.forEach((r, i) => {
  console.log(
    `  ${String(r._score).padStart(2)}   ${r['Sector'].padEnd(25)} ${r['Empresa'].slice(0, 40)}`
  );
});

console.log(`\n⏳ Importando a Notion...\n`);

let ok = 0, fail = 0;
for (const row of top20) {
  try {
    await createLead(row, row._score);
    console.log(`✅ [${row._score}] ${row['Empresa'].slice(0, 50)}`);
    ok++;
  } catch (err) {
    console.error(`❌ ${row['Empresa'].slice(0, 40)} → ${err.message.slice(0, 80)}`);
    fail++;
  }
  await sleep(DELAY_MS);
}

console.log(`\n🏁 Listo — ${ok} importadas, ${fail} errores`);
console.log(`\nPróximo paso: en @treev_abm_bot usa /iniciar [empresa] para activar la cadencia D1/D3/D7 de las que quieras arrancar.`);
