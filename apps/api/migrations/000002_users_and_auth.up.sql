CREATE TABLE users (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email           citext NOT NULL UNIQUE,
    password_hash   text NOT NULL,
    display_name    text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One row per user with display/locale preferences. Units live on baby_settings
-- because units are tracked per-baby (e.g. one child measured in cm, another in
-- inches); locale/time-format are inherently per-user.
CREATE TABLE user_preferences (
    user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    time_format text NOT NULL DEFAULT '24h' CHECK (time_format IN ('24h', '12h')),
    timezone    text NOT NULL DEFAULT 'UTC',
    locale      text NOT NULL DEFAULT 'en',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER user_preferences_set_updated_at BEFORE UPDATE ON user_preferences
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Refresh tokens: opaque random tokens issued at login, stored hashed.
-- The plaintext lives only in the user's httpOnly cookie. Rotation = mark
-- revoked_at + insert a new row.
CREATE TABLE refresh_tokens (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   bytea NOT NULL UNIQUE,
    issued_at    timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    revoked_at   timestamptz,
    replaced_by  uuid REFERENCES refresh_tokens(id) ON DELETE SET NULL,
    user_agent   text,
    ip           inet
);
CREATE INDEX refresh_tokens_user_id_idx ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_expires_at_idx ON refresh_tokens (expires_at);
