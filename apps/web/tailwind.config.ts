import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          base: "#0b1220",
          surface: "#111a2c",
          subtle: "#192238",
        },
        accent: {
          DEFAULT: "#7c9cff",
          subtle: "#3b4f8a",
        },
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      borderRadius: {
        xl: "14px",
        "2xl": "18px",
      },
      // One-shot accent pulse used to flag the History rows a user
      // jumped to from a chart bar. Starts as a bright accent ring +
      // faint surface lift, then fades to nothing so the row settles
      // back into its normal `.card` look.
      keyframes: {
        historyGlow: {
          "0%": {
            boxShadow: "0 0 0 0 rgba(124,156,255,0)",
            backgroundColor: "#111a2c",
          },
          "15%": {
            boxShadow: "0 0 0 2px rgba(124,156,255,0.7)",
            backgroundColor: "#192238",
          },
          "100%": {
            boxShadow: "0 0 0 0 rgba(124,156,255,0)",
            backgroundColor: "#111a2c",
          },
        },
      },
      animation: {
        "history-glow": "historyGlow 1.8s ease-out",
      },
    },
  },
  plugins: [],
} satisfies Config;
