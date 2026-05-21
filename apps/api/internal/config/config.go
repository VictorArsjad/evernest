package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"time"
)

type Config struct {
	Bind                 string
	Port                 string
	DatabaseURL          string
	JWTSecret            []byte
	AccessTokenTTL       time.Duration
	RefreshTokenTTLDays  int
	CORSAllowOrigin      string
	PublicWebOrigin      string
}

func Load() (*Config, error) {
	cfg := &Config{
		Bind:            getEnv("API_BIND", "0.0.0.0"),
		Port:            getEnv("API_PORT", "8080"),
		DatabaseURL:     os.Getenv("DATABASE_URL"),
		CORSAllowOrigin: getEnv("CORS_ALLOW_ORIGIN", "http://localhost:5173"),
		PublicWebOrigin: getEnv("PUBLIC_WEB_ORIGIN", "http://localhost:5173"),
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
