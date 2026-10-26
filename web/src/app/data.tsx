// Data access for screens: one ApiClient in context, TanStack Query for caching. Screens never call fetch directly.

import { QueryClient, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { ApiError, listAll, type ApiClient } from "../api/client.ts";
import type { FeatureEnablement, SensitiveFeature, Session, Tenant } from "../api/types.ts";
import { periodAt, type Period } from "../lib/period.ts";
import { ErrorNote, Loading } from "../design/components.tsx";

export interface AppDeps {
  api: ApiClient;
  /** Clock for "effective" checks and relative times. The mock passes its fixed day. */
  now: () => number;
}

const Deps = createContext<AppDeps | null>(null);

export function DepsProvider(props: { deps: AppDeps; children: ReactNode }) {
  return <Deps.Provider value={props.deps}>{props.children}</Deps.Provider>;
}

export function useDeps(): AppDeps {
  const d = useContext(Deps);
  if (!d) throw new Error("DepsProvider missing");
  return d;
}

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        // 4xx answers are final (forbidden, not found, feature off); retry only server trouble.
        retry: (n, err) => !(err instanceof ApiError && err.status < 500) && n < 2,
      },
    },
  });
}

export function useGet<T>(path: string | null): UseQueryResult<T> {
  const { api } = useDeps();
  return useQuery({ queryKey: [path], queryFn: () => api.get<T>(path!), enabled: path !== null });
}

/** A list endpoint, all pages, as a plain array. */
export function useList<T>(path: string | null): UseQueryResult<T[]> {
  const { api } = useDeps();
  return useQuery({ queryKey: ["list", path], queryFn: () => listAll<T>(api, path!), enabled: path !== null });
}

export function useText(path: string | null): UseQueryResult<string> {
  const { api } = useDeps();
  return useQuery({ queryKey: ["text", path], queryFn: () => api.getText(path!), enabled: path !== null });
}

/** Render loading, plain-words error, or the data. */
export function Load<T>(props: { q: UseQueryResult<T>; label?: string; children: (data: T) => ReactNode }) {
  if (props.q.isError) return <ErrorNote error={props.q.error} />;
  if (props.q.data === undefined) return <Loading label={props.label} />;
  return <>{props.children(props.q.data)}</>;
}

export function useSession() {
  return useGet<Session>("/auth/session");
}

/**
 * The reporting period (this month so far) in the tenant's reporting timezone, from the clock in deps. Null until the
 * tenant is loaded, so screens never ask for a period in the wrong timezone. If the tenant cannot be read (signed out,
 * server trouble) the period falls back to UTC so the screen's own reads run and show their error in plain words.
 */
export function usePeriod(): Period | null {
  const { now } = useDeps();
  const tenant = useGet<Tenant>("/v1/tenant");
  if (tenant.data) return periodAt(now(), tenant.data.reportingTimezone);
  return tenant.isError ? periodAt(now(), "UTC") : null;
}

/** A metrics path for the period, or null while the period is unknown. */
export function periodPath(base: string, p: Period | null): string | null {
  if (!p) return null;
  return `${base}${base.includes("?") ? "&" : "?"}from=${p.from}&to=${p.to}`;
}

/** A sensitive feature counts as on only when an enablement exists, is not disabled, and its notice period passed. */
export function featureState(records: FeatureEnablement[] | undefined, f: SensitiveFeature, now: number) {
  const rec = records?.find((r) => r.feature === f && r.disabledAt === null);
  if (!rec) return { on: false, scheduled: false, rec: undefined };
  return { on: rec.effectiveAt <= now, scheduled: rec.effectiveAt > now, rec };
}

export function useFeature(f: SensitiveFeature) {
  const { now } = useDeps();
  const q = useList<FeatureEnablement>("/v1/compliance/features");
  return { ...featureState(q.data, f, now()), loaded: q.data !== undefined || q.isError };
}

/**
 * A page-level key: fires when focus is not in a field, on a control, or inside an open sheet. "Enter" is the primary
 * action's key (shown as a keycap on the button).
 */
export function useKey(key: string, handler: () => void, enabled = true) {
  const h = useRef(handler);
  h.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if (e.key.toLowerCase() !== key.toLowerCase()) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("input, textarea, select, button, a, [role=dialog], tr[tabindex]")) return;
      if (document.querySelector("[role=dialog]")) return;
      e.preventDefault();
      h.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [key, enabled]);
}
