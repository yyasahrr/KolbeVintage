import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Extra hostnames the dev server may answer to, comma separated:
 *   KV_PREVIEW_HOSTS=.e2b.app npm run dev
 * Sandbox and tunnel previews set this at launch. Nothing is allow-listed by
 * default, so no preview host is baked into the repository.
 */
const previewHosts = (process.env.KV_PREVIEW_HOSTS ?? "")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    // `host` only binds the dev server to all interfaces so phones on the same
    // network — and the dev-only preview harness — can reach it.
    host: true,
    ...(previewHosts.length ? { allowedHosts: previewHosts } : {}),
    proxy: { "/api": "http://127.0.0.1:4000" },
  },
});
