-- Add the Today-banner "show recommended target bars" toggle to the
-- per-user preferences row. Default TRUE so existing users see the new
-- infographic bars on first paint after the FE ships; users who find
-- the bars distracting or prescriptive can flip them off from the
-- settings screen.
ALTER TABLE user_preferences
    ADD COLUMN show_recommended_targets boolean NOT NULL DEFAULT true;
