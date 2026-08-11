-- Sleep intervals ("baby asleep / awake"). Follows the shared event-table
-- shape (000005). ended_at is NULL while a session is open ("baby just fell
-- asleep, close it later"), mirroring nursing_sessions' open-session model.
-- Duration is always derived (ended_at - started_at) — no duration column.
-- At most one open session per baby is enforced in the app layer (like
-- nursing), NOT via a partial unique index: a partial index would collide on
-- idempotent outbox replays of the same open-create row, breaking the
-- ON CONFLICT (id) DO NOTHING contract.
CREATE TABLE sleeps (
    id                  uuid PRIMARY KEY,
    baby_id             uuid NOT NULL REFERENCES babies(id) ON DELETE CASCADE,
    started_at          timestamptz NOT NULL,
    ended_at            timestamptz,
    sleep_type          text CHECK (sleep_type IN ('nap', 'night')),
    location            text,
    notes               text,
    source              text NOT NULL DEFAULT 'manual',
    created_by_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT sleeps_interval_chk CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE TRIGGER sleeps_set_updated_at BEFORE UPDATE ON sleeps
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX sleeps_baby_started_idx ON sleeps (baby_id, started_at DESC);
CREATE INDEX sleeps_source_idx ON sleeps (baby_id, source);
