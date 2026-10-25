import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createHttpClient } from "./api/client.ts";
import { App, createAppRouter } from "./app/router.tsx";
import type { AppDeps } from "./app/data.tsx";
import { tokenCss } from "./design/tokens.ts";
import "./design/styles.css";

// Tokens become CSS variables once, before first paint.
const style = document.createElement("style");
style.dataset.tokens = "";
style.textContent = tokenCss();
document.head.prepend(style);

const params = new URLSearchParams(location.search);
if (params.get("theme") === "light") document.documentElement.dataset.theme = "light";

// The production build always talks to the control plane. The schema-driven mock (invented fixtures) exists only in
// dev (`bun run dev`) and the review build (`vite build --mode mock`); the static condition lets the bundler drop it
// from dist/. VITE_API=real uses the control plane in dev too (S2-11). In the mock,
// ?features=per_person_views,working_time turns sensitive features on for review.
async function deps(): Promise<AppDeps> {
  if ((import.meta.env.DEV || import.meta.env.MODE === "mock") && import.meta.env.VITE_API !== "real") {
    const [{ createMockClient }, { NOW }] = await Promise.all([import("./api/mock/server.ts"), import("./api/mock/fixtures.ts")]);
    const features = (params.get("features") ?? "").split(",").filter((f) => f === "per_person_views" || f === "working_time");
    return { api: createMockClient({ features: features as ("per_person_views" | "working_time")[] }), now: () => NOW };
  }
  return { api: createHttpClient(), now: () => Date.now() };
}

void deps().then((d) => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App deps={d} router={createAppRouter()} />
    </StrictMode>,
  );
});
