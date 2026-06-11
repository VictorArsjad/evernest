ALTER TABLE diapers
    DROP CONSTRAINT IF EXISTS diapers_photo_mime_chk,
    DROP CONSTRAINT IF EXISTS diapers_photo_pair_chk,
    DROP COLUMN IF EXISTS photo_mime,
    DROP COLUMN IF EXISTS photo;
