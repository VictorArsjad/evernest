CREATE TABLE households (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER households_set_updated_at BEFORE UPDATE ON households
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE household_members (
    household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role         text NOT NULL CHECK (role IN ('owner', 'caregiver')),
    joined_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (household_id, user_id)
);
CREATE INDEX household_members_user_id_idx ON household_members (user_id);

-- Invites are link-based: the importer/UI shares a URL containing the plaintext
-- token; only the SHA-256 hash is stored in the DB. The optional email field is
-- just metadata for the UI ("invite sent to alex@example.com"); no email is
-- actually sent in v1.
CREATE TABLE household_invites (
    token_hash    bytea PRIMARY KEY,
    household_id  uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    email         text,
    created_by    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at    timestamptz NOT NULL,
    accepted_at   timestamptz,
    accepted_by   uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX household_invites_household_id_idx ON household_invites (household_id);
CREATE INDEX household_invites_expires_at_idx ON household_invites (expires_at);
