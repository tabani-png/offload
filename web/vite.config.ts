import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { tokenCss } from "./src/design/tokens.ts";

// The design tokens as a real stylesheet (`import "virtual:offload-tokens.css"`), bundled and hashed with the rest of
// the CSS. The control plane serves the SPA with `style-src 'self'` (S2-11, ADR 0114), so no inline <style> is allowed.
const TOKENS_ID = "virtual:offload-tokens.css";
function tokens(): Plugin {
  return {
    name: "offload-tokens",
    resolveId: (id) => (id === TOKENS_ID ? `\0${TOKENS_ID}` : null),
    load: (id) => (id === `\0${TOKENS_ID}` ? tokenCss() : null),
  };
}

// Static SPA; S2-11 serves dist/ from the control plane. No source maps in the bundle (they would carry local paths).
export default defineConfig({
  plugins: [tokens(), react()],
  build: { sourcemap: false, outDir: "dist", emptyOutDir: true },
  server: { port: 5174 },
});
