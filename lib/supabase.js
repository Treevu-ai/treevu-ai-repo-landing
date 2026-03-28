// ── lib/supabase.js ──────────────────────────────────────────────────────────
// Supabase REST client — sin SDK, solo fetch nativo
// Source of truth: todos los leads y eventos fluyen aquí primero

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY; // service_role key

function sbHeaders(extras = {}) {
  return {
    'apikey':        SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Content-Type':  'application/json',
    ...extras
  };
}

export async function sbInsert(table, data, options = {}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.warn(`[supabase] No configurado — skip insert ${table}`);
    return null;
  }
  const prefer = options.upsert
    ? 'resolution=merge-duplicates,return=representation'
    : 'return=representation';

  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method:  'POST',
    headers: sbHeaders({ 'Prefer': prefer }),
    body:    JSON.stringify(data)
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`[supabase] insert ${table}: ${res.status} ${err}`);
  }
  return res.json();
}

export async function sbSelect(table, { select = '*', filters = {}, order, limit, offset } = {}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return [];

  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  url.searchParams.set('select', select);
  for (const [k, v] of Object.entries(filters)) url.searchParams.set(k, v);
  if (order)  url.searchParams.set('order', order);
  if (limit)  url.searchParams.set('limit',  String(limit));
  if (offset) url.searchParams.set('offset', String(offset));

  const res = await fetch(url.toString(), { headers: sbHeaders() });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`[supabase] select ${table}: ${res.status} ${err}`);
  }
  return res.json();
}

export async function sbUpdate(table, match, data) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;

  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  for (const [k, v] of Object.entries(match)) url.searchParams.set(k, `eq.${v}`);

  const res = await fetch(url.toString(), {
    method:  'PATCH',
    headers: sbHeaders({ 'Prefer': 'return=representation' }),
    body:    JSON.stringify(data)
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`[supabase] update ${table}: ${res.status} ${err}`);
  }
  return res.json();
}

// ── Helpers de alto nivel ─────────────────────────────────────────────────────

export async function upsertLead(leadData) {
  return sbInsert('leads', leadData, { upsert: true });
}

export async function updateLead(email, data) {
  return sbUpdate('leads', { email }, { ...data, updated_at: new Date().toISOString() });
}

export async function getLeadByEmail(email) {
  const rows = await sbSelect('leads', { filters: { email: `eq.${email}` }, limit: 1 });
  return rows?.[0] || null;
}

export async function getLeadById(id) {
  const rows = await sbSelect('leads', { filters: { id: `eq.${id}` }, limit: 1 });
  return rows?.[0] || null;
}

// ── Event log — fire & forget, nunca bloquea el flujo principal ───────────────
export async function logEvent(email, eventType, payload = {}, {
  leadId    = null,
  stageFrom = null,
  stageTo   = null
} = {}) {
  try {
    await sbInsert('events', {
      lead_id:    leadId,
      email,
      event_type: eventType,
      stage_from: stageFrom,
      stage_to:   stageTo,
      payload
    });
  } catch (err) {
    console.error(`[supabase] logEvent(${eventType}) error:`, err.message);
  }
}

// ── Score history ─────────────────────────────────────────────────────────────
export async function logScoreHistory(email, leadId, score, probabilidad, fuente, signals = {}) {
  try {
    await sbInsert('score_history', {
      lead_id:      leadId,
      email,
      score,
      probabilidad,
      fuente,
      signals
    });
  } catch (err) {
    console.error('[supabase] logScoreHistory error:', err.message);
  }
}

// ── Métricas de pipeline ──────────────────────────────────────────────────────
export async function getPipelineMetrics() {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;

  const [leads, events, meetings] = await Promise.all([
    sbSelect('leads',   { select: 'id,score,estado,sector,colaboradores,objetivo,probabilidad,created_at' }),
    sbSelect('events',  { select: 'event_type,created_at', order: 'created_at.desc', limit: 1000 }),
    sbSelect('meetings',{ select: 'id,result,scheduled_at,completed_at,created_at' })
  ]);

  const total     = leads.length;
  const byScore   = { ALTO: 0, MEDIO: 0, BAJO: 0 };
  const byEstado  = {};
  let   altoCount = 0;

  for (const l of leads) {
    byScore[l.score]  = (byScore[l.score]  || 0) + 1;
    byEstado[l.estado] = (byEstado[l.estado] || 0) + 1;
    if (l.score === 'ALTO') altoCount++;
  }

  const meetingsScheduled = leads.filter(l => l.estado === 'Reunión agendada').length;
  const meetingsDone      = meetings.filter(m => m.result).length;
  const won               = meetings.filter(m => m.result === 'ganado').length;
  const lost              = meetings.filter(m => m.result === 'perdido').length;

  const convLeadToMeeting = total > 0 ? ((meetingsScheduled / total) * 100).toFixed(1) : '0.0';
  const winRate           = meetingsDone > 0 ? ((won / meetingsDone) * 100).toFixed(1) : 'N/D';

  // Tiempo promedio lead → reunión (días)
  const meetingLeads = leads.filter(l => l.estado === 'Reunión agendada' && l.created_at);
  let avgDaysToMeeting = 'N/D';
  if (meetingLeads.length >= 2) {
    const avg = meetingLeads.reduce((sum, l) => {
      const scheduledMeeting = meetings.find(m => m.created_at > l.created_at);
      if (!scheduledMeeting) return sum;
      return sum + (new Date(scheduledMeeting.created_at) - new Date(l.created_at)) / 86400000;
    }, 0) / meetingLeads.length;
    avgDaysToMeeting = avg.toFixed(1);
  }

  return {
    total, byScore, byEstado, altoCount,
    meetingsScheduled, meetingsDone, won, lost,
    convLeadToMeeting, winRate, avgDaysToMeeting
  };
}
