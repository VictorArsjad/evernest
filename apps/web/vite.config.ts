import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";

const API_URL = process.env.VITE_API_BASE_URL ?? "http://localhost:8080";

// Vite serves the bundle from this path. GH Pages publishes under /<repo>/,
// so prod CI sets VITE_BASE_PATH=/evernest/. Local dev leaves it unset = "/".
const BASE_PATH = process.env.VITE_BASE_PATH ?? "/";

// PWA manifest paths must agree with BASE_PATH or the installed app boots into
// a 404 on GH Pages. We prefix every manifest URL with BASE_PATH so the same
// vite build works at "/" and at "/evernest/".
const withBase = (p: string) =>
  `${BASE_PATH.replace(/\/$/, "")}/${p.replace(/^\//, "")}`;

export default defineConfig({
  base: BASE_PATH,
  plugins: [
    TanStackRouterVite({ target: "react", autoCodeSplitting: true }),
    react(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      // Static assets that aren't directly imported by the JS bundle but
      // still need to be precached so iOS/Android can render the home-screen
      // icon and tab favicon without a network round-trip post-install.
      includeAssets: [
        "favicon.svg",
        "favicon-16.png",
        "favicon-32.png",
        "apple-touch-icon.png",
        "icons/icon-source.svg",
      ],
      manifest: {
        name: "Evernest",
        short_name: "Evernest",
        description: "Track your baby's feedings, diapers, growth and more.",
        // theme_color drives the Android status-bar tint when installed and
        // the iOS standalone status bar (we set status-bar-style to
        // black-translucent so the bar takes this color). Matches index.html
        // <meta name="theme-color"> below.
        theme_color: "#0b1220",
        background_color: "#0b1220",
        display: "standalone",
        orientation: "portrait",
        start_url: BASE_PATH,
        scope: BASE_PATH,
        lang: "en",
        categories: ["health", "lifestyle"],
        icons: [
          {
            src: withBase("icons/icon-192.png"),
            sizes: "192x192",
            type: "image/png",
            purpose: "any",
          },
          {
            src: withBase("icons/icon-512.png"),
            sizes: "512x512",
            type: "image/png",
            purpose: "any",
          },
          {
            src: withBase("icons/icon-192-maskable.png"),
            sizes: "192x192",
            type: "image/png",
            purpose: "maskable",
          },
          {
            src: withBase("icons/icon-512-maskable.png"),
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        navigateFallback: withBase("index.html"),
        // Never cache API responses in the SW; TanStack Query owns that cache.
        navigateFallbackDenylist: [/\/v1\//],
        // Allow the larger 512-icon PNGs through the default 2 MiB cap.
        // The maskable 512 hovers ~16 KB today, but we bump to 4 MiB to
        // leave headroom for future hi-res assets without surprise build
        // warnings.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      "/v1": { target: API_URL, changeOrigin: true },
      "/healthz": { target: API_URL, changeOrigin: true },
    },
  },
});
