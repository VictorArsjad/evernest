package auth

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/varsjad/evernest/apps/api/internal/store"
)

type User struct {
	ID           uuid.UUID `json:"id"`
	Email        string    `json:"email"`
	DisplayName  string    `json:"display_name"`
	CreatedAt    time.Time `json:"created_at"`
}

type UserWithSecret struct {
	User
	PasswordHash string `json:"-"`
}

var (
	ErrUserExists   = errors.New("user already exists")
	ErrUserNotFound = errors.New("user not found")
)

func CreateUser(ctx context.Context, st *store.Store, email, displayName, passwordHash string) (User, error) {
	var u User
	err := st.Pool.QueryRow(ctx, `
		WITH new_user AS (
			INSERT INTO users (email, display_name, password_hash)
			VALUES ($1, $2, $3)
			RETURNING id, email, display_name, created_at
		), seed_prefs AS (
			INSERT INTO user_preferences (user_id) SELECT id FROM new_user
		)
		SELECT id, email, display_name, created_at FROM new_user
	`, email, displayName, passwordHash).Scan(&u.ID, &u.Email, &u.DisplayName, &u.CreatedAt)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return User{}, ErrUserExists
		}
		return User{}, err
	}
	return u, nil
}

func GetUserByEmail(ctx context.Context, st *store.Store, email string) (UserWithSecret, error) {
	var u UserWithSecret
	err := st.Pool.QueryRow(ctx, `
		SELECT id, email, display_name, created_at, password_hash
		FROM users WHERE email = $1
	`, email).Scan(&u.ID, &u.Email, &u.DisplayName, &u.CreatedAt, &u.PasswordHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return u, ErrUserNotFound
	}
	return u, err
}

func GetUserByID(ctx context.Context, st *store.Store, id uuid.UUID) (User, error) {
	var u User
	err := st.Pool.QueryRow(ctx, `
		SELECT id, email, display_name, created_at
		FROM users WHERE id = $1
	`, id).Scan(&u.ID, &u.Email, &u.DisplayName, &u.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return u, ErrUserNotFound
	}
	return u, err
}
