import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// In Docker the backend is reachable as http://backend:8000; locally it's localhost.
const backendUrl = process.env.BACKEND_URL ?? "http://localhost:8000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    // File change events don't reliably cross Docker bind mounts on Windows/macOS.
    watch: { usePolling: true, interval: 300 },
    proxy: {
      "/api": { target: backendUrl, changeOrigin: true },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // Page tests render real pages (and SQL Lab loads Monaco): allow for a busy machine.
    testTimeout: 15_000,
  },
});
