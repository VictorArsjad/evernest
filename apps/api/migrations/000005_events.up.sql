-- Nursing sessions: baby fed at the breast. No volume, but per-side durations.
CREATE TABLE nursing_sessions (
    id                  uuid PRIMARY KEY,
    baby_id             uuid NOT NULL REFERENCES babies(id) ON DELETE CASCADE,
    started_at          timestamptz NOT NULL,
    ended_at            timestamptz,
    starting_breast     text CHECK (starting_breast IN ('left', 'right')),
    nursing_side        text NOT NULL CHECK (nursing_side IN ('left', 'right', 'both')),
    left_duration_s     integer NOT NULL DEFAULT 0 CHECK (left_duration_s >= 0),
    right_duration_s    integer NOT NULL DEFAULT 0 CHECK (right_duration_s >= 0),
    notes               text,
    source              text NOT NULL DEFAULT 'manual',
    created_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER nursing_sessions_set_updated_at BEFORE UPDATE ON nursing_sessions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX nursing_sessions_baby_started_idx ON nursing_sessions (baby_id, started_at DESC);
CREATE INDEX nursing_sessions_source_idx ON nursing_sessions (baby_id, source);

-- Bottle feeds: a bottle can contain expressed breastmilk OR formula.
-- We split this from nursing because the shapes differ fundamentally (volume vs
-- duration+side) and ~67% of bottles in the real BabyPlus export are expressed
-- breastmilk, which a single `type=breast|formula` enum cannot model.
CREATE TABLE bottle_feeds (
    id                  uuid PRIMARY KEY,
    baby_id             uuid NOT NULL REFERENCES babies(id) ON DELETE CASCADE,
    occurred_at         timestamptz NOT NULL,
    milk_source         text NOT NULL CHECK (milk_source IN ('breast', 'formula')),
    amount_ml           numeric(7, 2) NOT NULL CHECK (amount_ml >= 0),
    notes               text,
    source              text NOT NULL DEFAULT 'manual',
    created_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER bottle_feeds_set_updated_at BEFORE UPDATE ON bottle_feeds
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX bottle_feeds_baby_occurred_idx ON bottle_feeds (baby_id, occurred_at DESC);
CREATE INDEX bottle_feeds_source_idx ON bottle_feeds (baby_id, source);

-- Pumping: mother pumps milk. No baby is "fed"; we just track the volume.
CREATE TABLE pumpings (
    id                  uuid PRIMARY KEY,
    baby_id             uuid NOT NULL REFERENCES babies(id) ON DELETE CASCADE,
    occurred_at         timestamptz NOT NULL,
    amount_ml           numeric(7, 2) NOT NULL CHECK (amount_ml >= 0),
    duration_seconds    integer CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
    notes               text,
    source              text NOT NULL DEFAULT 'manual',
    created_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER pumpings_set_updated_at BEFORE UPDATE ON pumpings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX pumpings_baby_occurred_idx ON pumpings (baby_id, occurred_at DESC);
CREATE INDEX pumpings_source_idx ON pumpings (baby_id, source);

CREATE TABLE diapers (
    id                  uuid PRIMARY KEY,
    baby_id             uuid NOT NULL REFERENCES babies(id) ON DELETE CASCADE,
    occurred_at         timestamptz NOT NULL,
    type                text NOT NULL CHECK (type IN ('wet', 'soiled', 'mixed')),
    notes               text,
    source              text NOT NULL DEFAULT 'manual',
    created_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER diapers_set_updated_at BEFORE UPDATE ON diapers
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX diapers_baby_occurred_idx ON diapers (baby_id, occurred_at DESC);
CREATE INDEX diapers_source_idx ON diapers (baby_id, source);

-- Growth measurements. Any combination of weight/height/head may be NULL on a
-- given row (you might just weigh the baby without re-measuring height).
-- BabyPlus stores 0 to mean "not measured"; the importer converts those to NULL.
CREATE TABLE growths (
    id                       uuid PRIMARY KEY,
    baby_id                  uuid NOT NULL REFERENCES babies(id) ON DELETE CASCADE,
    measured_at              timestamptz NOT NULL,
    weight_g                 numeric(8, 2) CHECK (weight_g IS NULL OR weight_g >= 0),
    height_cm                numeric(6, 2) CHECK (height_cm IS NULL OR height_cm >= 0),
    head_circumference_cm    numeric(6, 2) CHECK (head_circumference_cm IS NULL OR head_circumference_cm >= 0),
    notes                    text,
    source                   text NOT NULL DEFAULT 'manual',
    created_by_user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at               timestamptz NOT NULL DEFAULT now(),
    updated_at               timestamptz NOT NULL DEFAULT now(),
    CHECK (weight_g IS NOT NULL OR height_cm IS NOT NULL OR head_circumference_cm IS NOT NULL)
);
CREATE TRIGGER growths_set_updated_at BEFORE UPDATE ON growths
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX growths_baby_measured_idx ON growths (baby_id, measured_at DESC);
CREATE INDEX growths_source_idx ON growths (baby_id, source);
