-- Free-form notes: caregiver observations that don't fit the structured
-- event kinds ("had a small rash on hand"). Follows the shared event-table
-- shape (000005) plus the optional inline-photo columns/constraints from the
-- diaper photo migration (000011). Unlike the other tables, the free-text
-- content IS the entry, so it lives in a required `body` column rather than
-- the optional `notes` column the other kinds carry.
CREATE TABLE notes (
    id                  uuid PRIMARY KEY,
    baby_id             uuid NOT NULL REFERENCES babies(id) ON DELETE CASCADE,
    occurred_at         timestamptz NOT NULL,
    body                text NOT NULL CHECK (length(btrim(body)) > 0),
    photo               bytea,
    photo_mime          text,
    source              text NOT NULL DEFAULT 'manual',
    created_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT notes_photo_pair_chk
        CHECK ((photo IS NULL) = (photo_mime IS NULL)),
    CONSTRAINT notes_photo_mime_chk
        CHECK (photo_mime IS NULL OR photo_mime IN ('image/jpeg', 'image/png', 'image/webp'))
);
CREATE TRIGGER notes_set_updated_at BEFORE UPDATE ON notes
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX notes_baby_occurred_idx ON notes (baby_id, occurred_at DESC);
CREATE INDEX notes_source_idx ON notes (baby_id, source);
