-- Sleep-day cutover hour for this baby. 0 = local midnight (legacy
-- behavior); 6 means each sleep-day runs 06:00→06:00 so overnight
-- sessions stay on one parenting day. FE-only aggregation; the column
-- is display config, never mutates event rows.
ALTER TABLE baby_settings
    ADD COLUMN day_start_hour smallint NOT NULL DEFAULT 0
        CHECK (day_start_hour BETWEEN 0 AND 23);
