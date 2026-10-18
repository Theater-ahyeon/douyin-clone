import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// web has no @types/node (the app itself never touches Node APIs), so name the one
// global this config reads instead of pulling in a dependency for it.
declare const process: { env: Record<string, string | undefined> };

const apiTarget = `http://${process.env.DY_HOST || "127.0.0.1"}:${process.env.DY_PORT || 8787}`;

export default defineConfig({
  plugins: [react()],
  server: {
    /* Vite's default host is "localhost", which on Windows resolves to ::1 only — so the
       http://127.0.0.1:5173 URL that scripts/dev.mjs prints refused connections. Bind the
       same family as the API (DY_HOST exposes both to a phone when set to 0.0.0.0). */
    host: process.env.DY_HOST || "127.0.0.1",
    port: Number(process.env.DY_WEB_PORT) || 5173,
    proxy: {
      "/api": { target: apiTarget, changeOrigin: true },
      "/media": { target: apiTarget, changeOrigin: true }
    }
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 700
  }
});
