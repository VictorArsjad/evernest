-- The original household_invites table (000003) shipped without a role column
-- because the link-based invite flow wasn't wired yet. CP5 surfaces invites in
-- the API: each invite remembers which role the joiner will be granted on
-- accept, so the inviter can issue an "owner-link" or a "caregiver-link".
--
-- DEFAULT 'caregiver' lets us add the NOT NULL constraint without a backfill;
-- any rows that pre-existed (none in production today) will get the safer of
-- the two roles. New writes always supply the role explicitly.
ALTER TABLE household_invites
    ADD COLUMN role text NOT NULL DEFAULT 'caregiver'
        CHECK (role IN ('owner', 'caregiver'));
