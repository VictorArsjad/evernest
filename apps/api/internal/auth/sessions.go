// Refresh-token lifecycle: opaque random tokens issued at login, hashed before
// being stored. The plaintext lives only in the user's httpOnly cookie. On
// /refresh we look up by hash, mark the row revoked, and insert a new row
// (rotation). Re-using a revoked token returns 401.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/varsjad/evernest/apps/api/internal/store"
)

const refreshTokenBytes = 32

// NewRefreshToken returns a base64url-encoded random token suitable for setting
// in the refresh-token cookie.
func NewRefreshToken() (string, error) {
	b := make([]byte, refreshTokenBytes)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("rand: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func hashToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

type RefreshRecord struct {
	ID         uuid.UUID
	UserID     uuid.UUID
	IssuedAt   time.Time
	ExpiresAt  time.Time
	RevokedAt  *time.Time
	ReplacedBy *uuid.UUID
}

// IssueRefreshToken persists a hashed token and returns the plaintext to set in
// the cookie. If parentID is non-nil, the new token is recorded as the
// replacement for that prior row (rotation chain).
func IssueRefreshToken(ctx context.Context, st *store.Store, userID uuid.UUID, ttl time.Duration, userAgent string, ip net.IP, parentID *uuid.UUID) (string, time.Time, error) {
	token, err := NewRefreshToken()
	if err != nil {
		return "", time.Time{}, err
	}
	expiresAt := time.Now().Add(ttl)
	newID := uuid.New()

	tx, err := st.Pool.Begin(ctx)
	if err != nil {
		return "", time.Time{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	_, err = tx.Exec(ctx, `
		INSERT INTO refresh_tokens (id, user_id, token_hash, issued_at, expires_at, user_agent, ip)
		VALUES ($1, $2, $3, now(), $4, $5, $6)
	`, newID, userID, hashToken(token), expiresAt, nullStr(userAgent), nullIP(ip))
	if err != nil {
		return "", time.Time{}, fmt.Errorf("insert refresh token: %w", err)
	}

	if parentID != nil {
		_, err = tx.Exec(ctx, `
			UPDATE refresh_tokens
			SET revoked_at = now(), replaced_by = $1
			WHERE id = $2 AND revoked_at IS NULL
		`, newID, *parentID)
		if err != nil {
			return "", time.Time{}, fmt.Errorf("rotate refresh token: %w", err)
		}
	}

	if err := tx.Commit(ctx); err != nil {
		return "", time.Time{}, err
	}
	return token, expiresAt, nil
}

// LookupRefreshToken returns the active record for a plaintext token, or an
// error if it's missing, revoked, or expired.
var ErrRefreshTokenInvalid = errors.New("refresh token invalid")

func LookupRefreshToken(ctx context.Context, st *store.Store, token string) (RefreshRecord, error) {
	var rec RefreshRecord
	err := st.Pool.QueryRow(ctx, `
		SELECT id, user_id, issued_at, expires_at, revoked_at
		FROM refresh_tokens
		WHERE token_hash = $1
	`, hashToken(token)).Scan(&rec.ID, &rec.UserID, &rec.IssuedAt, &rec.ExpiresAt, &rec.RevokedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return rec, ErrRefreshTokenInvalid
	}
	if err != nil {
		return rec, err
	}
	if rec.RevokedAt != nil {
		return rec, ErrRefreshTokenInvalid
	}
	if time.Now().After(rec.ExpiresAt) {
		return rec, ErrRefreshTokenInvalid
	}
	return rec, nil
}

// RevokeRefreshToken marks a token as revoked. Returns nil if it was already
// revoked or missing — logout is idempotent.
func RevokeRefreshToken(ctx context.Context, st *store.Store, token string) error {
	_, err := st.Pool.Exec(ctx, `
		UPDATE refresh_tokens SET revoked_at = now()
		WHERE token_hash = $1 AND revoked_at IS NULL
	`, hashToken(token))
	return err
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func nullIP(ip net.IP) any {
	if ip == nil {
		return nil
	}
	return ip.String()
}
