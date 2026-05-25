package config

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Bind                string
	Port                string
	DatabaseURL         string
	JWTSecret           []byte
	AccessTokenTTL      time.Duration
	RefreshTokenTTLDays int
	CORSAllowOrigin     string
	PublicWebOrigin     string
	// CookieSameSite controls the SameSite attribute on the refresh-token
	// cookie. Defaults to "lax" (good for same-origin dev / Caddy prod). Must
	// be "none" when the FE and API live on different origins (e.g. FE on
	// GitHub Pages, API on a Tailscale hostname); the browser then also
	// requires Secure=true, which secureCookie() already covers when
	// PUBLIC_WEB_ORIGIN starts with https://.
	CookieSameSite http.SameSite
}

func Load() (*Config, error) {
	sameSite, err := parseSameSite(getEnv("COOKIE_SAMESITE", "lax"))
	if err != nil {
		return nil, err
	}
	cfg := &Config{
		Bind:            getEnv("API_BIND", "0.0.0.0"),
		Port:            getEnv("API_PORT", "8080"),
		DatabaseURL:     os.Getenv("DATABASE_URL"),
		CORSAllowOrigin: getEnv("CORS_ALLOW_ORIGIN", "http://localhost:5173"),
		PublicWebOrigin: getEnv("PUBLIC_WEB_ORIGIN", "http://localhost:5173"),
		CookieSameSite:  sameSite,
	}

	if cfg.DatabaseURL == "" {
		return nil, errors.New("DATABASE_URL is required")
	}

	secret := os.Getenv("JWT_SECRET")
	if secret == "" {
		return nil, errors.New("JWT_SECRET is required")
	}
	// Accept either a hex-encoded 32-byte key or any non-empty string of >=32 chars.
	// We store raw bytes; HS256 accepts any length but >=32 bytes is recommended.
	if len(secret) < 32 {
		return nil, fmt.Errorf("JWT_SECRET must be at least 32 chars (got %d)", len(secret))
	}
	cfg.JWTSecret = []byte(secret)

	ttl, err := time.ParseDuration(getEnv("ACCESS_TOKEN_TTL", "15m"))
	if err != nil {
		return nil, fmt.Errorf("ACCESS_TOKEN_TTL: %w", err)
	}
	cfg.AccessTokenTTL = ttl

	days, err := strconv.Atoi(getEnv("REFRESH_TOKEN_TTL_DAYS", "30"))
	if err != nil {
		return nil, fmt.Errorf("REFRESH_TOKEN_TTL_DAYS: %w", err)
	}
	cfg.RefreshTokenTTLDays = days

	return cfg, nil
}

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// parseSameSite maps the env-friendly strings "lax" / "none" / "strict" to
// the Go http.SameSite constants. Default is Lax for any unset value; an
// unrecognized value returns an error rather than silently falling back so
// that misconfiguration is loud.
func parseSameSite(v string) (http.SameSite, error) {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "", "lax":
		return http.SameSiteLaxMode, nil
	case "none":
		return http.SameSiteNoneMode, nil
	case "strict":
		return http.SameSiteStrictMode, nil
	default:
		return 0, fmt.Errorf("COOKIE_SAMESITE: unknown value %q (want lax|none|strict)", v)
	}
}
