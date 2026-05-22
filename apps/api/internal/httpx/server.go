// Package httpx exposes only the HTTP helpers (JSON encode/decode, error
// envelope, logging middleware) that every domain package needs. Router
// composition lives in the api package so we can avoid an import cycle
// between httpx and the domain packages that import its helpers.
package httpx

import (
	"encoding/json"
	"log/slog"
	"net/http"
)

// WriteJSON writes a JSON response with the given status code. Errors during
// encoding are logged but cannot meaningfully be returned to the caller at
// that point (headers may already be flushed).
func WriteJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if body == nil {
		return
	}
	if err := json.NewEncoder(w).Encode(body); err != nil {
		slog.Default().Error("write json", "err", err)
	}
}

// WriteError writes a JSON error envelope: { "error": { "code": ..., "message": ... } }.
// Code is a stable machine-readable string (e.g. "validation_failed", "unauthorized");
// message is a human-readable explanation.
func WriteError(w http.ResponseWriter, status int, code, message string) {
	WriteJSON(w, status, map[string]any{
		"error": map[string]string{
			"code":    code,
			"message": message,
		},
	})
}

// DecodeJSON deserializes the request body into dst, returning a stable error
// envelope on failure.
func DecodeJSON(r *http.Request, dst any) error {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	return dec.Decode(dst)
}
