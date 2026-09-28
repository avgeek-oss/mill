import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: {
    port: 4322,
    proxy: {
      "/api": "http://127.0.0.1:4321",
      "/oauth": "http://127.0.0.1:4321",
      "/mcp": "http://127.0.0.1:4321",
    },
  },
  build: { outDir: "dist" },
});
