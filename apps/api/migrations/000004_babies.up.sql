CREATE TABLE babies (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    household_id   uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    name           text NOT NULL,
    date_of_birth  date,
    -- Free-form text. UI offers 'female', 'male', 'unspecified' but the schema
    -- doesn't enforce so we can add categories without a migration.
    sex            text,
    created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER babies_set_updated_at BEFORE UPDATE ON babies
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX babies_household_id_idx ON babies (household_id);

-- Per-baby display units. Defaults match the user prompt (ml/cm/kg, 24h-ish).
-- Changing these never mutates historical rows; conversion happens on the FE.
CREATE TABLE baby_settings (
    baby_id      uuid PRIMARY KEY REFERENCES babies(id) ON DELETE CASCADE,
    unit_volume  text NOT NULL DEFAULT 'ml' CHECK (unit_volume IN ('ml', 'oz')),
    unit_length  text NOT NULL DEFAULT 'cm' CHECK (unit_length IN ('cm', 'in')),
    unit_weight  text NOT NULL DEFAULT 'kg' CHECK (unit_weight IN ('kg', 'lb')),
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER baby_settings_set_updated_at BEFORE UPDATE ON baby_settings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
