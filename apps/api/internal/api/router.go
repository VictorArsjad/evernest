// Package api composes all domain routes into a single http.Handler. Domain
// packages own their handlers and route registration; api is the only place
// they get wired together. Keeping this here (rather than in httpx) avoids an
// import cycle between httpx (which provides helpers) and the domain
// packages (which use them).
package api

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"

	"github.com/varsjad/evernest/apps/api/internal/auth"
	"github.com/varsjad/evernest/apps/api/internal/baby"
	"github.com/varsjad/evernest/apps/api/internal/bottlefeed"
	"github.com/varsjad/evernest/apps/api/internal/config"
	"github.com/varsjad/evernest/apps/api/internal/diaper"
	"github.com/varsjad/evernest/apps/api/internal/growth"
	"github.com/varsjad/evernest/apps/api/internal/household"
	"github.com/varsjad/evernest/apps/api/internal/httpx"
	"github.com/varsjad/evernest/apps/api/internal/nursing"
	"github.com/varsjad/evernest/apps/api/internal/pumping"
	"github.com/varsjad/evernest/apps/api/internal/store"
)

func NewRouter(cfg *config.Config, st *store.Store, logger *slog.Logger) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(httpx.SlogLogger(logger))
	r.Use(middleware.Recoverer)
	// Strip trailing slashes so /households and /households/ both route to the
	// same handler. We can't use RedirectSlashes because it sends a 301, which
	// browsers happily downgrade POST -> GET on.
	r.Use(middleware.StripSlashes)
	r.Use(middleware.Timeout(30 * time.Second))
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins:   []string{cfg.CORSAllowOrigin},
		AllowedMethods:   []string{"GET", "POST", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Authorization", "Content-Type"},
		AllowCredentials: true,
		MaxAge:           300,
	}))

	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
		httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	r.Get("/readyz", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := st.Pool.Ping(ctx); err != nil {
			httpx.WriteJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "not_ready", "err": err.Error()})
			return
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "ready"})
	})

	r.Route("/v1", func(r chi.Router) {
		mountV1(r, cfg, st, logger)
	})

	return r
}

func mountV1(r chi.Router, cfg *config.Config, st *store.Store, logger *slog.Logger) {
	r.Get("/ping", func(w http.ResponseWriter, r *http.Request) {
		httpx.WriteJSON(w, http.StatusOK, map[string]string{"pong": "evernest"})
	})

	authH := auth.NewHandler(cfg, st, logger)
	householdH := household.NewHandler(st, logger)
	babyH := baby.NewHandler(st, logger)
	bottleH := bottlefeed.NewHandler(st, logger)
	diaperH := diaper.NewHandler(st, logger)
	pumpingH := pumping.NewHandler(st, logger)
	nursingH := nursing.NewHandler(st, logger)
	growthH := growth.NewHandler(st, logger)

	r.Route("/auth", authH.Routes)

	r.Group(func(r chi.Router) {
		r.Use(auth.RequireUser(cfg.JWTSecret))
		r.Get("/me", authH.Me)
		r.Route("/households", func(r chi.Router) {
			householdH.Routes(r)
			r.Route("/{householdID}", babyH.HouseholdRoutes)
		})
		r.Route("/babies/{babyID}", func(r chi.Router) {
			babyH.BabyRoutes(r)
			bottleH.BabyRoutes(r)
			diaperH.BabyRoutes(r)
			pumpingH.BabyRoutes(r)
			nursingH.BabyRoutes(r)
			growthH.BabyRoutes(r)
		})
		r.Route("/bottle-feeds/{id}", bottleH.ItemRoutes)
		r.Route("/diapers/{id}", diaperH.ItemRoutes)
		r.Route("/pumpings/{id}", pumpingH.ItemRoutes)
		r.Route("/nursing-sessions/{id}", nursingH.ItemRoutes)
		r.Route("/growths/{id}", growthH.ItemRoutes)
	})
}
