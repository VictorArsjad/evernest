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
      includeAssets: ["favicon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "Evernest",
        short_name: "Evernest",
        description: "Track your baby's feedings, diapers, growth and more.",
        theme_color: "#1f2937",
        background_color: "#0b1220",
        display: "standalone",
        orientation: "portrait",
        start_url: BASE_PATH,
        scope: BASE_PATH,
        icons: [
          { src: withBase("pwa-192.png"), sizes: "192x192", type: "image/png" },
          { src: withBase("pwa-512.png"), sizes: "512x512", type: "image/png" },
          { src: withBase("pwa-512-maskable.png"), sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        navigateFallback: withBase("index.html"),
        // Never cache API responses in the SW; TanStack Query owns that cache.
        navigateFallbackDenylist: [/\/v1\//],
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
