import { useEffect, type ReactNode } from "react";

export const ROLE_WORDS = {
  owner: "Owner", admin: "Admin", dept_lead: "Department lead", member: "Member", auditor: "Auditor", service: "Service",
} as const;

/** Toolbar plus content. Each screen renders one; `actions` holds the view's single primary action. */
export function Page(props: { title: string; subtitle?: string; actions?: ReactNode; children: ReactNode }) {
  useEffect(() => {
    document.title = `${props.title} · Offload`;
  }, [props.title]);
  return (
    <>
      <header className="toolbar">
        <div className="toolbar-title">
          <h1 className="t-title ink1">{props.title}</h1>
          {props.subtitle && <span className="t-callout ink3">{props.subtitle}</span>}
        </div>
        {props.actions && <div className="toolbar-actions">{props.actions}</div>}
      </header>
      <main className="content" id="main" tabIndex={-1}>{props.children}</main>
    </>
  );
}

