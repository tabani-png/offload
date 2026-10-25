import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createHttpClient } from "./api/client.ts";
import { createMockClient } from "./api/mock/server.ts";
import { NOW } from "./api/mock/fixtures.ts";
import { App, createAppRouter } from "./app/router.tsx";
import { tokenCss } from "./design/tokens.ts";
import "./design/styles.css";

// Tokens become CSS variables once, before first paint.
const style = document.createElement("style");
style.dataset.tokens = "";
style.textContent = tokenCss();
document.head.prepend(style);

const params = new URLSearchParams(location.search);
if (params.get("theme") === "light") document.documentElement.dataset.theme = "light";

// VITE_API=real uses the control plane (S2-11). Otherwise the schema-driven mock; ?features=per_person_views,working_time
// turns sensitive features on in the mock for review.
const real = import.meta.env.VITE_API === "real";
const features = (params.get("features") ?? "").split(",").filter((f) => f === "per_person_views" || f === "working_time");
const deps = real
  ? { api: createHttpClient(), now: () => Date.now() }
  : { api: createMockClient({ features: features as ("per_person_views" | "working_time")[] }), now: () => NOW };

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App deps={deps} router={createAppRouter()} />
  </StrictMode>,
);
