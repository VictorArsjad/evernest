-- Add the "auto-fill bottle amount" toggle to the per-user preferences
-- row. When on, the bottle-feed log form prefills the Amount field with a
-- suggestion derived from recent feeds (bottle amounts are usually
-- constant), saving a tap on the most common logging action. Default TRUE
-- so existing users get the convenience on first paint after the FE ships;
-- users who'd rather start from an empty field flip it off from settings.
ALTER TABLE user_preferences
    ADD COLUMN autofill_bottle_amount boolean NOT NULL DEFAULT true;
