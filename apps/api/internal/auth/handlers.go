// Package auth implements user registration, login, refresh, logout and the
// /me endpoint. The refresh token lives in an httpOnly cookie; the access
// token is returned in the JSON body so the client can put it in memory.
package auth

import (
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-playground/validator/v10"
	"github.com/google/uuid"

	"github.com/varsjad/evernest/apps/api/internal/config"
	"github.com/varsjad/evernest/apps/api/internal/httpx"
	"github.com/varsjad/evernest/apps/api/internal/store"
)

const refreshCookieName = "evernest_refresh"

type Handler struct {
	cfg    *config.Config
	store  *store.Store
	logger *slog.Logger
	v      *validator.Validate
}

func NewHandler(cfg *config.Config, st *store.Store, logger *slog.Logger) *Handler {
	return &Handler{cfg: cfg, store: st, logger: logger, v: validator.New(validator.WithRequiredStructEnabled())}
}

// Routes wires the public auth endpoints. The authenticated /me endpoint is
// expected to be mounted by the caller under a router that already has the
// RequireUser middleware applied.
func (h *Handler) Routes(r chi.Router) {
	r.Post("/register", h.register)
	r.Post("/login", h.login)
	r.Post("/refresh", h.refresh)
	r.Post("/logout", h.logout)
}

type registerReq struct {
	Email       string `json:"email" validate:"required,email,max=254"`
	Password    string `json:"password" validate:"required,min=8,max=200"`
	DisplayName string `json:"display_name" validate:"required,min=1,max=80"`
}

type loginReq struct {
	Email    string `json:"email" validate:"required,email"`
	Password string `json:"password" validate:"required"`
}

type tokenResp struct {
	AccessToken string    `json:"access_token"`
	ExpiresAt   time.Time `json:"expires_at"`
	User        User      `json:"user"`
}

func (h *Handler) register(w http.ResponseWriter, r *http.Request) {
	var req registerReq
	if err := httpx.DecodeJSON(r, &req); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	req.Email = strings.ToLower(strings.TrimSpace(req.Email))
	if err := h.v.Struct(req); err != nil {
		httpx.WriteError(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
		return
	}
	hash, err := HashPassword(req.Password)
	if err != nil {
		h.logger.Error("hash password", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not hash password")
		return
	}
	user, err := CreateUser(r.Context(), h.store, req.Email, req.DisplayName, hash)
	if errors.Is(err, ErrUserExists) {
		httpx.WriteError(w, http.StatusConflict, "user_exists", "email already registered")
		return
	}
	if err != nil {
		h.logger.Error("create user", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not create user")
		return
	}

	h.issueAndRespond(w, r, user, nil, http.StatusCreated)
}

func (h *Handler) login(w http.ResponseWriter, r *http.Request) {
	var req loginReq
	if err := httpx.DecodeJSON(r, &req); err != nil {
		httpx.WriteError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	req.Email = strings.ToLower(strings.TrimSpace(req.Email))
	if err := h.v.Struct(req); err != nil {
		httpx.WriteError(w, http.StatusUnprocessableEntity, "validation_failed", err.Error())
		return
	}
	u, err := GetUserByEmail(r.Context(), h.store, req.Email)
	if errors.Is(err, ErrUserNotFound) {
		// Use the same error as a bad password to avoid user enumeration.
		httpx.WriteError(w, http.StatusUnauthorized, "invalid_credentials", "invalid email or password")
		return
	}
	if err != nil {
		h.logger.Error("get user by email", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not log in")
		return
	}
	ok, err := VerifyPassword(req.Password, u.PasswordHash)
	if err != nil || !ok {
		httpx.WriteError(w, http.StatusUnauthorized, "invalid_credentials", "invalid email or password")
		return
	}

	h.issueAndRespond(w, r, u.User, nil, http.StatusOK)
}

func (h *Handler) refresh(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie(refreshCookieName)
	if err != nil {
		httpx.WriteError(w, http.StatusUnauthorized, "no_refresh_cookie", "no refresh cookie")
		return
	}
	rec, err := LookupRefreshToken(r.Context(), h.store, cookie.Value)
	if errors.Is(err, ErrRefreshTokenInvalid) {
		http.SetCookie(w, expiredRefreshCookie(h.cfg))
		httpx.WriteError(w, http.StatusUnauthorized, "invalid_refresh", "refresh token invalid")
		return
	}
	if err != nil {
		h.logger.Error("lookup refresh", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "refresh failed")
		return
	}
	u, err := GetUserByID(r.Context(), h.store, rec.UserID)
	if err != nil {
		http.SetCookie(w, expiredRefreshCookie(h.cfg))
		httpx.WriteError(w, http.StatusUnauthorized, "invalid_refresh", "user gone")
		return
	}
	parent := rec.ID
	h.issueAndRespond(w, r, u, &parent, http.StatusOK)
}

func (h *Handler) logout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(refreshCookieName); err == nil {
		_ = RevokeRefreshToken(r.Context(), h.store, cookie.Value)
	}
	http.SetCookie(w, expiredRefreshCookie(h.cfg))
	w.WriteHeader(http.StatusNoContent)
}

// Me handles GET /v1/me. Mount it under a router with RequireUser.
func (h *Handler) Me(w http.ResponseWriter, r *http.Request) {
	uid := UserIDFrom(r.Context())
	u, err := GetUserByID(r.Context(), h.store, uid)
	if err != nil {
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not load user")
		return
	}
	httpx.WriteJSON(w, http.StatusOK, u)
}

// issueAndRespond issues an access token + a rotated refresh cookie and writes
// the token response. parentRefreshID, if non-nil, is the prior refresh token
// being rotated (used by /refresh).
func (h *Handler) issueAndRespond(w http.ResponseWriter, r *http.Request, user User, parentRefreshID *uuid.UUID, status int) {
	access, accessExp, err := IssueAccessToken(h.cfg.JWTSecret, user.ID, h.cfg.AccessTokenTTL)
	if err != nil {
		h.logger.Error("issue access token", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not issue access token")
		return
	}

	refreshTTL := time.Duration(h.cfg.RefreshTokenTTLDays) * 24 * time.Hour
	refresh, refreshExp, err := IssueRefreshToken(r.Context(), h.store, user.ID, refreshTTL, r.UserAgent(), clientIP(r), parentRefreshID)
	if err != nil {
		h.logger.Error("issue refresh token", "err", err)
		httpx.WriteError(w, http.StatusInternalServerError, "internal", "could not issue refresh token")
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     refreshCookieName,
		Value:    refresh,
		Path:     "/v1/auth",
		Expires:  refreshExp,
		MaxAge:   int(refreshTTL.Seconds()),
		HttpOnly: true,
		Secure:   secureCookie(h.cfg),
		SameSite: http.SameSiteLaxMode,
	})

	httpx.WriteJSON(w, status, tokenResp{
		AccessToken: access,
		ExpiresAt:   accessExp,
		User:        user,
	})
}

func expiredRefreshCookie(cfg *config.Config) *http.Cookie {
	return &http.Cookie{
		Name:     refreshCookieName,
		Value:    "",
		Path:     "/v1/auth",
		Expires:  time.Unix(0, 0),
		MaxAge:   -1,
		HttpOnly: true,
		Secure:   secureCookie(cfg),
		SameSite: http.SameSiteLaxMode,
	}
}

func secureCookie(cfg *config.Config) bool {
	return strings.HasPrefix(cfg.PublicWebOrigin, "https://")
}

func clientIP(r *http.Request) net.IP {
	// chi's middleware.RealIP normalizes r.RemoteAddr to a bare IP. Fall back to
	// parsing whatever Go gave us.
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	return net.ParseIP(host)
}
