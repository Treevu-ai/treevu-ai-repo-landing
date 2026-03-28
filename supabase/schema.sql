-- ── Treevü Revenue Engine — Supabase Schema ─────────────────────────────────
-- Source of truth: todas las entidades fluyen aquí primero
-- Notion = capa visual/operativa (sincronizada desde estos datos)
--
-- Setup:
-- 1. Crea un proyecto en supabase.com
-- 2. Ejecuta este SQL en el SQL Editor
-- 3. Copia la URL y service_role key a variables de entorno en Vercel:
--    SUPABASE_URL=https://<ref>.supabase.co
--    SUPABASE_SERVICE_KEY=<service_role_key>

-- ── Extensions ────────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Tabla principal: leads ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leads (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email                 TEXT        UNIQUE NOT NULL,
  nombre                TEXT,
  empresa               TEXT,
  sector                TEXT,
  colaboradores         TEXT,
  objetivo              TEXT,
  problema              TEXT,
  score                 TEXT        CHECK (score IN ('ALTO','MEDIO','BAJO')),
  score_inicial         TEXT        CHECK (score_inicial IN ('ALTO','MEDIO','BAJO')),
  probabilidad          INTEGER     CHECK (probabilidad BETWEEN 0 AND 100),
  estado                TEXT        DEFAULT 'Nuevo',
  fuente_scoring        TEXT        DEFAULT 'fallback',
  razon                 TEXT,
  señales_positivas     JSONB       DEFAULT '[]',
  señales_negativas     JSONB       DEFAULT '[]',
  mensaje_personalizado TEXT,
  notion_id             TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS leads_email_idx       ON leads(email);
CREATE INDEX IF NOT EXISTS leads_score_idx       ON leads(score);
CREATE INDEX IF NOT EXISTS leads_estado_idx      ON leads(estado);
CREATE INDEX IF NOT EXISTS leads_created_at_idx  ON leads(created_at DESC);

-- ── Eventos: audit log completo ───────────────────────────────────────────────
-- Registra cada touchpoint del funnel
-- event_type: lead_created, lead_scored, lead_rescored, meeting_scheduled,
--             briefing_generated, meeting_result, followup_generated,
--             followup_alert_sent, nextstep_logged, reactivation_triggered,
--             cadence_d1_sent, cadence_d3_sent, cadence_d7_sent
CREATE TABLE IF NOT EXISTS events (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id    UUID        REFERENCES leads(id) ON DELETE SET NULL,
  email      TEXT        NOT NULL,
  event_type TEXT        NOT NULL,
  stage_from TEXT,
  stage_to   TEXT,
  payload    JSONB       DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS events_email_idx      ON events(email);
CREATE INDEX IF NOT EXISTS events_type_idx       ON events(event_type);
CREATE INDEX IF NOT EXISTS events_lead_id_idx    ON events(lead_id);
CREATE INDEX IF NOT EXISTS events_created_at_idx ON events(created_at DESC);

-- ── Reuniones ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meetings (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id             UUID        REFERENCES leads(id) ON DELETE SET NULL,
  email               TEXT        NOT NULL,
  scheduled_at        TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  event_name          TEXT,
  result              TEXT        CHECK (result IN ('ganado','perdido','seguimiento','no_show')),
  notas               TEXT,
  briefing_generado   BOOLEAN     DEFAULT FALSE,
  follow_up_generado  BOOLEAN     DEFAULT FALSE,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS meetings_email_idx   ON meetings(email);
CREATE INDEX IF NOT EXISTS meetings_lead_id_idx ON meetings(lead_id);
CREATE INDEX IF NOT EXISTS meetings_result_idx  ON meetings(result);

-- ── Historial de scores ───────────────────────────────────────────────────────
-- Permite ver la evolución del score de un lead a lo largo del tiempo
-- fuente: initial, behavioral, post_meeting, learning, manual
CREATE TABLE IF NOT EXISTS score_history (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id      UUID        REFERENCES leads(id) ON DELETE SET NULL,
  email        TEXT        NOT NULL,
  score        TEXT,
  probabilidad INTEGER,
  fuente       TEXT,
  signals      JSONB       DEFAULT '{}',
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS score_history_email_idx   ON score_history(email);
CREATE INDEX IF NOT EXISTS score_history_lead_id_idx ON score_history(lead_id);

-- ── Datos de aprendizaje ──────────────────────────────────────────────────────
-- Cada resultado de reunión alimenta el loop de aprendizaje
CREATE TABLE IF NOT EXISTS learning_data (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id               UUID        REFERENCES leads(id) ON DELETE SET NULL,
  sector                TEXT,
  colaboradores         TEXT,
  objetivo              TEXT,
  score_inicial         TEXT,
  probabilidad_inicial  INTEGER,
  dias_hasta_reunion    INTEGER,
  result                TEXT,
  converted             BOOLEAN,
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS learning_data_segment_idx ON learning_data(sector, colaboradores, objetivo);
CREATE INDEX IF NOT EXISTS learning_data_result_idx  ON learning_data(result, converted);

-- ── Calibración de scoring ────────────────────────────────────────────────────
-- Output del loop de aprendizaje — alimenta el prompt de scoring
CREATE TABLE IF NOT EXISTS scoring_calibration (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  segment_key    TEXT        UNIQUE NOT NULL,
  sector         TEXT,
  colaboradores  TEXT,
  objetivo       TEXT,
  win_rate       NUMERIC(5,2),
  sample_count   INTEGER     DEFAULT 0,
  ganados        INTEGER     DEFAULT 0,
  perdidos       INTEGER     DEFAULT 0,
  avg_days_to_close NUMERIC(6,1),
  last_updated   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS scoring_calibration_key_idx ON scoring_calibration(segment_key);

-- ── Cadencias de nurturing ────────────────────────────────────────────────────
-- D+1 / D+3 / D+7 y reactivaciones semanales
CREATE TABLE IF NOT EXISTS cadences (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id       UUID        REFERENCES leads(id) ON DELETE CASCADE,
  email         TEXT        NOT NULL,
  empresa       TEXT,
  sector        TEXT,
  colaboradores TEXT,
  day_number    INTEGER,                -- 1, 3, 7
  send_at       TIMESTAMPTZ NOT NULL,
  sent_at       TIMESTAMPTZ,
  cancelled_at  TIMESTAMPTZ,
  type          TEXT        DEFAULT 'nurturing',  -- nurturing, reactivation
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS cadences_pending_idx  ON cadences(send_at) WHERE sent_at IS NULL AND cancelled_at IS NULL;
CREATE INDEX IF NOT EXISTS cadences_email_idx    ON cadences(email);
CREATE INDEX IF NOT EXISTS cadences_lead_id_idx  ON cadences(lead_id);

-- ── Función: updated_at automático ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER leads_updated_at
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── Row Level Security ────────────────────────────────────────────────────────
-- Las APIs usan service_role key → bypasea RLS
-- Activar RLS por seguridad (service_role siempre puede todo)
ALTER TABLE leads              ENABLE ROW LEVEL SECURITY;
ALTER TABLE events             ENABLE ROW LEVEL SECURITY;
ALTER TABLE meetings           ENABLE ROW LEVEL SECURITY;
ALTER TABLE score_history      ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_data      ENABLE ROW LEVEL SECURITY;
ALTER TABLE scoring_calibration ENABLE ROW LEVEL SECURITY;
ALTER TABLE cadences           ENABLE ROW LEVEL SECURITY;
