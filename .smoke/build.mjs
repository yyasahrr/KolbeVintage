import { build } from "vite";
import react from "@vitejs/plugin-react";

const name = process.env.SMOKE_NAME;
const entry = process.env.SMOKE_ENTRY ?? ".smoke/entry.tsx";
if (!name) throw new Error("SMOKE_NAME is required");

await build({
  configFile: false,
  root: process.cwd(),
  logLevel: "warn",
  plugins: [react()],
  define: { "process.env.NODE_ENV": '"development"' },
  build: {
    outDir: ".smoke/out",
    emptyOutDir: false,
    cssCodeSplit: false,
    minify: false,
    target: "es2020",
    lib: { entry, formats: ["iife"], name: "Smoke", fileName: () => `${name}.js` },
  },
});
