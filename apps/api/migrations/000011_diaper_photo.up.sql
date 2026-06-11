-- Optional photo attached to a diaper change. Stored inline as BYTEA on the
-- existing row so the offline outbox can ride the same JSON write path with
-- the bytes carried as base64 — no multipart, no second round-trip, no new
-- infra. The FE compresses to <=1024px JPEG before send (typically
-- 150–400 KB), and the handler caps raw payload at 2 MB so a misbehaving
-- client can't fill Postgres. TOAST keeps the blob out-of-line and the
-- main heap row's footprint near-unchanged; the list endpoint deliberately
-- projects only `(photo IS NOT NULL) AS has_photo` to avoid pulling chunks.
ALTER TABLE diapers
    ADD COLUMN photo      bytea,
    ADD COLUMN photo_mime text,
    ADD CONSTRAINT diapers_photo_pair_chk
        CHECK ((photo IS NULL) = (photo_mime IS NULL)),
    ADD CONSTRAINT diapers_photo_mime_chk
        CHECK (photo_mime IS NULL OR photo_mime IN ('image/jpeg', 'image/png', 'image/webp'));
