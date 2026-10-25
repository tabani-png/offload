// happy-dom as the global DOM for bun test (test-only). Mirrors what @happy-dom/global-registrator does, without
// the extra dependency: copy every window property bun's global does not already have.
import { Window } from "happy-dom";

const win = new Window({ url: "http://localhost/" });
const g = globalThis as unknown as Record<string, unknown>;
for (const key of Object.getOwnPropertyNames(win)) {
  if (key in g) continue;
  g[key] = (win as unknown as Record<string, unknown>)[key];
}
g.window = win;
g.document = win.document;
g.navigator = win.navigator;
g.location = win.location;
g.history = win.history;
g.getComputedStyle = win.getComputedStyle.bind(win);
g.requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 0);
g.cancelAnimationFrame = (id: number) => clearTimeout(id);
g.IS_REACT_ACT_ENVIRONMENT = true;
