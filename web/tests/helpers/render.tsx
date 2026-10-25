// Test-only: render the whole app at a path on a fresh mock (happy-dom + @testing-library/react).
import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, render } from "@testing-library/react";
import { createMockClient, type MockOptions } from "../../src/api/mock/server.ts";
import { NOW } from "../../src/api/mock/fixtures.ts";
import { App, createAppRouter } from "../../src/app/router.tsx";

export async function renderAt(path: string, options: MockOptions = {}) {
  const api = createMockClient(options);
  const router = createAppRouter(createMemoryHistory({ initialEntries: [path] }));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const utils = render(<App deps={{ api, now: () => NOW }} router={router} queryClient={queryClient} />);
  await settle();
  return { ...utils, api, router, queryClient };
}

/**
 * Poll `ok` (inside act, real timers) until it holds. Used instead of testing-library's waitFor, which stalled for
 * tens of seconds under bun test + happy-dom when its callback threw bun `expect` failures.
 */
export async function until(ok: () => boolean, what: string, timeout = 4000) {
  const start = Date.now();
  for (;;) {
    let pass = false;
    try {
      pass = ok();
    } catch {
      pass = false;
    }
    if (pass) return;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
}

/** Wait until the page has a title and nothing is loading. */
export async function settle() {
  await until(() => !!document.querySelector("main#main") && !document.querySelector("[role=status]"), "page to load");
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

export const main = () => document.querySelector("main#main") as HTMLElement;
export const h1 = () => document.querySelector("h1")?.textContent ?? "";
