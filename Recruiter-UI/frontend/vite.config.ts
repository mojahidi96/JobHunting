/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Same-origin in dev: the browser talks to :5173 and Vite forwards /api to the backend.
    proxy: { "/api": process.env.API_PROXY_TARGET ?? "http://localhost:4000" },
  },
  test: { environment: "jsdom", globals: true, setupFiles: ["./src/test/setup.ts"] },
});
