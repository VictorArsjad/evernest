package auth

import (
	"context"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/varsjad/evernest/apps/api/internal/httpx"
)

type ctxKey int

const userIDKey ctxKey = iota

// RequireUser is a chi middleware that validates the Authorization Bearer token
// and stores the user id on the request context. Unauthenticated requests get
// a 401 with a stable error envelope.
func RequireUser(secret []byte) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h := r.Header.Get("Authorization")
			if !strings.HasPrefix(h, "Bearer ") {
				httpx.WriteError(w, http.StatusUnauthorized, "unauthorized", "missing bearer token")
				return
			}
			token := strings.TrimSpace(strings.TrimPrefix(h, "Bearer "))
			claims, err := ParseAccessToken(secret, token)
			if err != nil {
				httpx.WriteError(w, http.StatusUnauthorized, "unauthorized", "invalid or expired token")
				return
			}
			ctx := context.WithValue(r.Context(), userIDKey, claims.UserID)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// UserIDFrom returns the authenticated user id from the request context.
// Panics if called on a request that did not pass through RequireUser.
func UserIDFrom(ctx context.Context) uuid.UUID {
	v, ok := ctx.Value(userIDKey).(uuid.UUID)
	if !ok {
		panic("auth.UserIDFrom: context has no user id (route not wrapped in RequireUser)")
	}
	return v
}
