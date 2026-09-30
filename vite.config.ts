import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    // Any host: the sandbox preview proxy serves the dev server under its own hostname.
    allowedHosts: true,
    host: true,
    // Default local API; override with KV_API_PROXY_TARGET when the smoke stack uses another port.
    proxy: {
      "/api": process.env.KV_API_PROXY_TARGET ?? "http://127.0.0.1:4000",
      "/sitemap.xml": process.env.KV_API_PROXY_TARGET ?? "http://127.0.0.1:4000",
      "/robots.txt": process.env.KV_API_PROXY_TARGET ?? "http://127.0.0.1:4000",
    },
  },
});
