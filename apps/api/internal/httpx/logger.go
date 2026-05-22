package httpx

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5/middleware"
)

// SlogLogger logs each request as a single structured JSON line on completion.
// It mirrors what chi's built-in Logger does but uses slog so it composes with
// our application logs.
func SlogLogger(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
			start := time.Now()
			defer func() {
				logger.Info("http",
					"reqID", middleware.GetReqID(r.Context()),
					"method", r.Method,
					"path", r.URL.Path,
					"status", ww.Status(),
					"bytes", ww.BytesWritten(),
					"dur_ms", time.Since(start).Milliseconds(),
					"remote", r.RemoteAddr,
				)
			}()
			next.ServeHTTP(ww, r)
		})
	}
}
