-- Per-user "feature visibility" map. Lets a caregiver hide event kinds
-- (bottle / nursing / pumping / diaper / growth) from the Today banner
-- stats, the action tile grid, and the Charts page WITHOUT touching the
-- underlying data. Past entries remain in their tables; this column
-- only gates UI surfaces.
--
-- Stored sparsely: a key only appears when the user explicitly hid the
-- feature, e.g. {"bottle": false}. Missing key ⇒ visible. Default '{}'
-- keeps every existing user fully unchanged after the migration.
--
-- Mirrors the chart_palette JSONB precedent (migration 000008): the FE
-- always reads/writes the whole blob, the BE validates keys against a
-- closed allowlist in the PUT handler, and the column carries a
-- non-null default so SELECTs never need to nil-guard.
ALTER TABLE user_preferences
    ADD COLUMN feature_visibility jsonb NOT NULL DEFAULT '{}'::jsonb;
