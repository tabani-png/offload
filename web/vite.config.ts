import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Static SPA; S2-11 serves dist/ from the control plane. No source maps in the bundle (they would carry local paths).
export default defineConfig({
  plugins: [react()],
  build: { sourcemap: false, outDir: "dist", emptyOutDir: true },
  server: { port: 5174 },
});
