-- Solid meals: a sitting of complementary food (Glow-ish meal log, not a
-- per-food introduction catalog). foods[] is the required payload; reaction,
-- amount_g, notes, and an optional diaper-style photo are all optional.
-- amount_g is grams (canonical weight); FE converts via baby unit_weight.
CREATE TABLE solid_meals (
    id                  uuid PRIMARY KEY,
    baby_id             uuid NOT NULL REFERENCES babies(id) ON DELETE CASCADE,
    occurred_at         timestamptz NOT NULL,
    foods               text[] NOT NULL,
    reaction            text CHECK (reaction IS NULL OR reaction IN ('liked', 'neutral', 'refused', 'reaction')),
    amount_g            numeric(8, 2) CHECK (amount_g IS NULL OR amount_g >= 0),
    notes               text,
    photo               bytea,
    photo_mime          text,
    source              text NOT NULL DEFAULT 'manual',
    created_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT solid_meals_foods_nonempty_chk CHECK (cardinality(foods) >= 1),
    CONSTRAINT solid_meals_photo_pair_chk
        CHECK ((photo IS NULL) = (photo_mime IS NULL)),
    CONSTRAINT solid_meals_photo_mime_chk
        CHECK (photo_mime IS NULL OR photo_mime IN ('image/jpeg', 'image/png', 'image/webp'))
);
CREATE TRIGGER solid_meals_set_updated_at BEFORE UPDATE ON solid_meals
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX solid_meals_baby_occurred_idx ON solid_meals (baby_id, occurred_at DESC);
CREATE INDEX solid_meals_source_idx ON solid_meals (baby_id, source);
