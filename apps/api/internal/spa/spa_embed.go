//go:build embedspa

// Package spa serves the built web bundle from the API binary so the
// front-end and API share a single origin. Same-origin is what lets the
// refresh token ride a first-party httpOnly cookie that iOS WebKit does
// not evict (the cross-site GitHub Pages deploy could not, which forced
// the FE to keep the token in localStorage where ITP reclaims it).
//
// The embed lives behind the `embedspa` build tag so tag-free builds
// (local dev, CI `go build ./...`, tests) never need the web artifact to
// compile — see spa_noop.go for the fallback. The Docker image builds the
// web bundle in a node stage, copies it to ./dist here, and compiles with
// `-tags embedspa`.
package spa

import (
	"embed"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

//go:embed all:dist
var distFS embed.FS

// Enabled reports whether the SPA was embedded at build time.
const Enabled = true

// Handler serves the embedded SPA: real files when they exist, falling
// back to index.html for client-side routes. API paths (/v1/*) are never
// served the shell so an unknown endpoint still returns a JSON 404.
func Handler() http.Handler {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		panic("spa: sub dist: " + err.Error())
	}
	index, err := fs.ReadFile(sub, "index.html")
	if err != nil {
		panic("spa: read index.html: " + err.Error())
	}
	fileServer := http.FileServer(http.FS(sub))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Unknown API routes are not SPA routes — let them 404 as JSON-less
		// 404s rather than handing back the HTML shell.
		if strings.HasPrefix(r.URL.Path, "/v1/") {
			http.NotFound(w, r)
			return
		}

		upath := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if upath == "" {
			upath = "index.html"
		}

		if f, err := sub.Open(upath); err == nil {
			_ = f.Close()
			// Hashed build assets are content-addressed and safe to cache
			// forever; everything else (index.html, the service worker, the
			// manifest) must revalidate so a new deploy is picked up.
			if strings.HasPrefix(upath, "assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			} else {
				w.Header().Set("Cache-Control", "no-cache")
			}
			fileServer.ServeHTTP(w, r)
			return
		}

		// No matching file: a client-side route. Serve the shell.
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(index)
	})
}
