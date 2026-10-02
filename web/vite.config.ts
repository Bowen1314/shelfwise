import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const webRoot = fileURLToPath(new URL(".", import.meta.url));
const projectRoot = resolve(webRoot, "..");
const backend = "http://127.0.0.1:8790";

export default defineConfig({
  root: webRoot,
  plugins: [react()],
  resolve: {
    alias: { "@shared": resolve(projectRoot, "src/shared") },
  },
  build: {
    outDir: resolve(projectRoot, "dist/web"),
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    // The shared contract lives outside the web root.
    fs: { allow: [projectRoot] },
    proxy: { "/api": backend, "/healthz": backend },
  },
});
