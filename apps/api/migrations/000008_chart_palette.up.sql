-- Per-user chart color palette for the /charts screen. Stored as JSONB
-- because the series-key set and the preset list will keep growing, and
-- the FE always reads/writes the whole blob in one go.
--
-- Shape: { "preset": "default"|"warm"|"pastel"|"high_contrast"|"colorblind",
--          "overrides": { "<series_key>": "#rrggbb", ... } }
--
-- The column default seeds existing users with the `default` preset which
-- matches today's hard-coded chart fills verbatim, so no user sees a
-- visual change until they actively pick a different preset or override
-- a series color.
ALTER TABLE user_preferences
    ADD COLUMN chart_palette jsonb NOT NULL
        DEFAULT '{"preset":"default","overrides":{}}'::jsonb;
