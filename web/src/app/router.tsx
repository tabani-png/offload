// Routes (SPEC "Screens") and the shell: sidebar, keyboard navigation, the page frame every screen uses.

import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import {
  Link, Outlet, RouterProvider, createRootRoute, createRoute, createRouter, useNavigate, useRouterState, type RouterHistory,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import { Page, ROLE_WORDS } from "./page.tsx";
import type { Batch, Department } from "../api/types.ts";
import { Keycap, StateDot } from "../design/components.tsx";
import { DepsProvider, makeQueryClient, useGet, useSession, type AppDeps } from "./data.tsx";
import { ApprovalsScreen } from "../screens/Approvals.tsx";
import { ComplianceScreen } from "../screens/Compliance.tsx";
import { DepartmentScreen } from "../screens/Department.tsx";
import { DigestScreen } from "../screens/Digest.tsx";
import { EvidenceScreen } from "../screens/Evidence.tsx";
import { MeScreen } from "../screens/Me.tsx";
import { OffboardingScreen } from "../screens/Offboarding.tsx";
import { OverviewScreen } from "../screens/Overview.tsx";
import { PeopleScreen } from "../screens/People.tsx";
import { WorkerScreen, WorkerRunScreen, WorkersScreen } from "../screens/Workers.tsx";
import { WorkflowScreen } from "../screens/Workflow.tsx";
import { WorkflowsScreen } from "../screens/Workflows.tsx";

export const NAV = [
  { to: "/", label: "Overview", key: "1" },
  { to: "/workflows", label: "Workflows", key: "2" },
  { to: "/approvals", label: "Approvals", key: "3" },
  { to: "/digest", label: "Digest", key: "4" },
  { to: "/workers", label: "Workers", key: "5" },
  { to: "/people", label: "People", key: "6" },
  { to: "/offboarding", label: "Offboarding", key: "7" },
  { to: "/compliance", label: "Compliance", key: "8" },
  { to: "/me", label: "My data", key: "9" },
] as const;

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

function Sidebar() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const session = useSession();
  const depts = useGet<Department[]>("/v1/departments");
  const pending = useGet<Batch[]>("/v1/batches?state=pending");
  const active = (to: string) => (to === "/" ? path === "/" : path === to || path.startsWith(`${to}/`));
  return (
    <nav className="sidebar" aria-label="Main">
      <div className="brand">
        <div className="t-title ink1">Offload</div>
        <div className="t-callout ink3">Admin</div>
      </div>
      <div className="nav-group">
        {NAV.map((n) => (
          <Link key={n.to} to={n.to} className="nav-item" aria-current={active(n.to) ? "page" : undefined}>
            <span className="nav-label">{n.label}</span>
            {n.to === "/approvals" && (pending.data?.length ?? 0) > 0 && (
              <span className="nav-badge"><StateDot role="needsYou" label="Needs you" />{pending.data!.length}</span>
            )}
            <Keycap k={n.key} />
          </Link>
        ))}
      </div>
      {depts.data && (
        <div className="nav-group">
          <div className="nav-heading t-caption ink3">Departments</div>
          {depts.data.map((d) => (
            <Link key={d.id} to="/departments/$id" params={{ id: d.id }} className="nav-item"
              aria-current={path === `/departments/${d.id}` ? "page" : undefined}>
              <span className="nav-label">{d.name}</span>
            </Link>
          ))}
        </div>
      )}
      {session.data && (
        <div className="sidebar-foot">
          <span className="t-label ink1">{session.data.person.displayName}</span>
          <span className="t-callout ink3">{ROLE_WORDS[session.data.person.accessRole]}</span>
          <span className="nav-hint t-footnote ink3"><Keycap k="1" />–<Keycap k="9" /> to move between views</span>
        </div>
      )}
    </nav>
  );
}

function Shell() {
  const navigate = useNavigate();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || document.querySelector("[role=dialog]")) return;
      const item = NAV.find((n) => n.key === e.key);
      if (item) {
        e.preventDefault();
        void navigate({ to: item.to });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);
  return (
    <div className="shell">
      <a href="#main" className="sr-only">Skip to content</a>
      <Sidebar />
      <div className="main">
        <Outlet />
      </div>
    </div>
  );
}

function NotFound() {
  return (
    <Page title="Not found">
      <p className="t-body ink2">This page does not exist. <Link to="/" className="link">Go to the overview</Link>.</p>
    </Page>
  );
}

const root = createRootRoute({ component: Shell, notFoundComponent: NotFound });
const r = (path: string, component: () => ReactNode) => createRoute({ getParentRoute: () => root, path, component });

export const ROUTE_PATHS = [
  "/", "/departments/$id", "/workflows", "/workflows/$id", "/workflows/$id/evidence", "/approvals", "/digest", "/workers",
  "/workers/$id", "/worker-runs/$id", "/people", "/offboarding", "/compliance", "/me",
] as const;

const tree = root.addChildren([
  r("/", OverviewScreen),
  r("/departments/$id", DepartmentScreen),
  r("/workflows", WorkflowsScreen),
  r("/workflows/$id", WorkflowScreen),
  r("/workflows/$id/evidence", EvidenceScreen),
  r("/approvals", ApprovalsScreen),
  r("/digest", DigestScreen),
  r("/workers", WorkersScreen),
  r("/workers/$id", WorkerScreen),
  r("/worker-runs/$id", WorkerRunScreen),
  r("/people", PeopleScreen),
  r("/offboarding", OffboardingScreen),
  r("/compliance", ComplianceScreen),
  r("/me", MeScreen),
]);

export function createAppRouter(history?: RouterHistory) {
  return createRouter({ routeTree: tree, history, defaultPreload: false, scrollRestoration: true });
}

export function App(props: { deps: AppDeps; router: ReturnType<typeof createAppRouter>; queryClient?: QueryClient }) {
  return (
    <QueryClientProvider client={props.queryClient ?? makeQueryClient()}>
      <DepsProvider deps={props.deps}>
        <RouterProvider router={props.router} />
      </DepsProvider>
    </QueryClientProvider>
  );
}
