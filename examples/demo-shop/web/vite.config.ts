import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const apiPort = process.env["API_PORT"] ?? "3001";

export default defineConfig({
  plugins: [react()],
  server: {
    host: process.env["WEB_HOST"] ?? "localhost",
    port: Number(process.env["WEB_PORT"] ?? 5173),
    strictPort: true,
    proxy: { "/api": `http://127.0.0.1:${apiPort}` },
  },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["test/setup.ts"],
  },
});
