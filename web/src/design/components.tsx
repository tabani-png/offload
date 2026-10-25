// Design components (SPEC: Card, Well, Row, Ring, StatHero, GradeSplit, StateDot, Keycap, Sheet, Table,
// SuppressedCell, FeatureOffPanel). Numbers come from tokens.ts through CSS variables; colour only carries state.

import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import type { Grade, Suppressed } from "../api/types.ts";
import { errorWords } from "../api/client.ts";
import { hoursText, pct, share } from "../lib/format.ts";
import type { StateRole } from "./tokens.ts";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

export function Card(props: { title?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string; labelledBy?: string }) {
  const id = useId();
  return (
    <section className={cx("card", props.className)} aria-labelledby={props.title ? id : props.labelledBy}>
      {(props.title || props.aside) && (
        <header className="card-head">
          {props.title && <h2 id={id} className="t-title">{props.title}</h2>}
          {props.aside && <div className="card-aside">{props.aside}</div>}
        </header>
      )}
      {props.children}
    </section>
  );
}

export function Well(props: { children: ReactNode; className?: string }) {
  return <div className={cx("well", props.className)}>{props.children}</div>;
}

export function Section(props: { title: string; aside?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section className="section" aria-labelledby={id}>
      <header className="section-head">
        <h2 id={id} className="t-display">{props.title}</h2>
        {props.aside && <div className="t-callout ink3">{props.aside}</div>}
      </header>
      {props.children}
    </section>
  );
}

/** One line in a list: optional state dot, title over detail, trailing content. */
export function Row(props: { state?: StateRole; title: ReactNode; detail?: ReactNode; trailing?: ReactNode; stateLabel?: string }) {
  return (
    <div className="row">
      {props.state && <StateDot role={props.state} label={props.stateLabel} />}
      <div className="row-main">
        <div className="t-label ink1">{props.title}</div>
        {props.detail && <div className="t-callout ink2">{props.detail}</div>}
      </div>
      {props.trailing && <div className="row-trailing">{props.trailing}</div>}
    </div>
  );
}

const STATE_WORDS: Record<StateRole, string> = {
  working: "Working", needsYou: "Needs you", done: "Done", recording: "Recording", neutral: "Idle",
};

export function StateDot(props: { role: StateRole; label?: string }) {
  return <span className={`dot dot-${props.role}`} role="img" aria-label={props.label ?? STATE_WORDS[props.role]} />;
}

/** A dot plus words: state is never colour alone. */
export function StateTag(props: { role: StateRole; children: ReactNode }) {
  return (
    <span className="state-tag">
      <span className={`dot dot-${props.role}`} aria-hidden="true" />
      <span className="t-callout ink2">{props.children}</span>
    </span>
  );
}

export function Keycap(props: { k: string; onPrimary?: boolean }) {
  return <kbd className={cx("keycap", props.k.length > 2 && "keycap-word", props.onPrimary && "keycap-on-primary")} aria-label={`Key ${props.k}`}>{props.k}</kbd>;
}

export function Chip(props: { children: ReactNode; tone?: "neutral" | "done" | "needsYou" | "working" }) {
  return <span className={cx("chip", props.tone && props.tone !== "neutral" && `chip-${props.tone}`)}>{props.children}</span>;
}

export function Button(props: {
  children: ReactNode;
  primary?: boolean;
  keycap?: string;
  onClick?: () => void;
  type?: "button" | "submit";
  disabled?: boolean;
  title?: string;
  form?: string;
  /** Low-emphasis, for actions inside table rows. */
  quiet?: boolean;
  "aria-label"?: string;
  "aria-describedby"?: string;
}) {
  return (
    <button
      type={props.type ?? "button"}
      className={cx("btn", props.primary && "btn-primary", props.quiet && "btn-quiet")}
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title}
      form={props.form}
      aria-label={props["aria-label"]}
      aria-describedby={props["aria-describedby"]}
    >
      <span>{props.children}</span>
      {props.keycap && <Keycap k={props.keycap} onPrimary={props.primary} />}
    </button>
  );
}

/** Progress or share as a ring. `segments` draw several shares around one ring (ink steps, not hues). */
export function Ring(props: {
  value?: number;
  segments?: { value: number; className: string; label: string }[];
  size?: number;
  stroke?: number;
  label: string;
  center?: ReactNode;
  role?: StateRole;
}) {
  const size = props.size ?? 72;
  const stroke = props.stroke ?? 7;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const segs = props.segments ?? [{ value: props.value ?? 0, className: props.role ? `arc-${props.role}` : "arc-ink", label: props.label }];
  let offset = 0;
  return (
    <div className="ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={props.label}>
        <circle className="ring-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" />
        {segs.map((s, i) => {
          const len = Math.max(0, Math.min(1, s.value)) * c;
          const gap = segs.length > 1 && len > 2 ? 1.5 : 0;
          const el = (
            <circle
              key={i}
              className={s.className}
              cx={size / 2}
              cy={size / 2}
              r={r}
              strokeWidth={stroke}
              fill="none"
              strokeDasharray={`${Math.max(0, len - gap)} ${c}`}
              strokeDashoffset={-offset}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          );
          offset += len;
          return el;
        })}
      </svg>
      {props.center && <div className="ring-center">{props.center}</div>}
    </div>
  );
}

/** The one big number on a view. */
export function StatHero(props: { value: ReactNode; label: ReactNode; chip?: ReactNode; detail?: ReactNode }) {
  return (
    <div className="stat-hero">
      <div className="stat-hero-line">
        <span className="t-hero ink1">{props.value}</span>
        {props.chip}
      </div>
      <div className="t-body ink2">{props.label}</div>
      {props.detail && <div className="t-callout ink3">{props.detail}</div>}
    </div>
  );
}

export const GRADE_WORDS: Record<Grade, string> = {
  A: "Measured: 5 or more observed samples that agree closely",
  B: "Measured: observed, but few samples or a wide spread",
  C: "Estimated: the workflow owner's own estimate",
};

/** Hours saved split by confidence grade (ADR 0109 §2), as a ring and a legend. */
export function GradeSplit(props: { byGrade: Record<Grade, number>; size?: number; compact?: boolean }) {
  const total = props.byGrade.A + props.byGrade.B + props.byGrade.C;
  const parts = (["A", "B", "C"] as const).map((g) => ({ g, s: share(props.byGrade[g], total) }));
  const label = `Confidence: ${parts.map((p) => `grade ${p.g} ${pct(p.s)}`).join(", ")}`;
  if (props.compact) {
    return (
      <div className="grade-bar" role="img" aria-label={label}>
        {parts.map((p) => <span key={p.g} className={`grade-seg grade-${p.g}`} style={{ flexGrow: p.s }} />)}
      </div>
    );
  }
  return (
    <div className="grade-split">
      <Ring size={props.size ?? 88} stroke={8} label={label}
        segments={parts.map((p) => ({ value: p.s, className: `arc-grade-${p.g}`, label: `Grade ${p.g}` }))}
        center={<span className="t-calloutEmphasis ink2">{pct(share(props.byGrade.A + props.byGrade.B, total))}<br /><span className="t-micro ink3">measured</span></span>} />
      <dl className="grade-legend">
        {parts.map((p) => (
          <div key={p.g} className="grade-legend-row">
            <dt><span className={`swatch grade-${p.g}`} aria-hidden="true" /> <span className="t-label ink1">Grade {p.g}</span></dt>
            <dd className="t-callout ink2">{hoursText(props.byGrade[p.g])} · {pct(p.s)} <span className="ink3">· {GRADE_WORDS[p.g]}</span></dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export const SUPPRESSED_WORDS: Record<Suppressed["reason"], string> = {
  group_floor: "Fewer than 5 people",
  feature_disabled: "Feature off",
  jurisdiction: "Off in this person's region",
};

/** A cell of 5 or more hidden only so a smaller sibling cannot be worked out from the total (complementary suppression). */
export const COMPLEMENTARY_WORDS = "Hidden to protect a small group";

/** In place of a number that may not be shown. Never renders the number. */
export function SuppressedCell(props: { reason: Suppressed["reason"]; complementary?: boolean }) {
  return (
    <span className="suppressed t-callout ink3" data-suppressed={props.complementary ? "complementary" : props.reason}>
      {props.complementary ? COMPLEMENTARY_WORDS : SUPPRESSED_WORDS[props.reason]}
    </span>
  );
}

const FEATURE_TITLE = { per_person_views: "Per-person views are off", working_time: "Working time is off" } as const;
const FEATURE_BODY = {
  per_person_views:
    "Numbers here are for groups of 5 or more people. The owner can turn on per-person views after a DPIA and a notice period; each person is told and can see every time someone looks.",
  working_time:
    "Active time per day is not collected. The owner can turn it on after a DPIA and a notice period. It then shows team medians only, never a list of people.",
} as const;

/** Visible gate for a sensitive feature that is off (ADR 0108: hidden, not just warned). */
export function FeatureOffPanel(props: { feature: keyof typeof FEATURE_TITLE; action?: ReactNode }) {
  return (
    <div className="feature-off" role="note" data-feature-off={props.feature}>
      <StateDot role="neutral" label="Off" />
      <div className="row-main">
        <div className="t-label ink1">{FEATURE_TITLE[props.feature]}</div>
        <div className="t-callout ink2">{FEATURE_BODY[props.feature]}</div>
      </div>
      {props.action}
    </div>
  );
}

export function ErrorNote(props: { error: unknown }) {
  return (
    <div className="error-note" role="alert">
      <StateDot role="needsYou" label="Needs you" />
      <span className="t-body ink1">{errorWords(props.error)}</span>
    </div>
  );
}

export function Loading(props: { label?: string }) {
  return <div className="loading t-callout ink3" role="status">{props.label ?? "Loading"}</div>;
}

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  align?: "start" | "end";
  width?: string;
}

/**
 * A plain table. Rows can be opened with Enter and walked with j/k or the arrow keys. There is deliberately no sort
 * prop: tables of people must never be ordered by a metric (ADR 0108 §6), so the component does not offer it at all.
 */
export function Table<T>(props: {
  caption: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onOpen?: (row: T) => void;
  empty?: string;
}) {
  const body = useRef<HTMLTableSectionElement>(null);
  const onKey = (e: KeyboardEvent<HTMLTableRowElement>, row: T) => {
    const rows = Array.from(body.current?.querySelectorAll<HTMLTableRowElement>("tr[tabindex]") ?? []);
    const i = rows.indexOf(e.currentTarget);
    if (e.key === "Enter" && props.onOpen) {
      e.preventDefault();
      props.onOpen(row);
    } else if (e.key === "ArrowDown" || e.key === "j") {
      e.preventDefault();
      rows[Math.min(rows.length - 1, i + 1)]?.focus();
    } else if (e.key === "ArrowUp" || e.key === "k") {
      e.preventDefault();
      rows[Math.max(0, i - 1)]?.focus();
    }
  };
  return (
    <div className="table-wrap">
      <table className="table">
        <caption className="sr-only">{props.caption}</caption>
        <thead>
          <tr>
            {props.columns.map((c) => (
              <th key={c.key} scope="col" className={cx("t-caption ink3", c.align === "end" && "num")} style={c.width ? { width: c.width } : undefined}>{c.header}</th>
            ))}
          </tr>
        </thead>
        <tbody ref={body}>
          {props.rows.length === 0 && (
            <tr><td colSpan={props.columns.length} className="t-callout ink3 empty">{props.empty ?? "Nothing here yet."}</td></tr>
          )}
          {props.rows.map((row) => (
            <tr
              key={props.rowKey(row)}
              tabIndex={props.onOpen ? 0 : undefined}
              className={props.onOpen ? "openable" : undefined}
              onClick={props.onOpen ? () => props.onOpen!(row) : undefined}
              onKeyDown={props.onOpen ? (e) => onKey(e, row) : undefined}
            >
              {props.columns.map((c) => (
                <td key={c.key} className={cx("t-body ink2", c.align === "end" && "num")}>{c.cell(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** An attached sheet: scrim, focus moved inside, Escape closes, focus returns to the opener. */
export function Sheet(props: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; onEnter?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!props.open) return;
    const opener = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>("input, select, textarea, button:not([data-close]), [href], [tabindex]:not([tabindex='-1'])");
    (first ?? ref.current)?.focus();
    return () => opener?.focus?.();
  }, [props.open]);
  if (!props.open) return null;
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      props.onClose();
    }
    if (e.key === "Enter" && props.onEnter && !(e.target as HTMLElement).closest("button, a, input, textarea, select")) {
      e.preventDefault();
      props.onEnter();
    }
    if (e.key === "Tab") {
      const f = Array.from(ref.current?.querySelectorAll<HTMLElement>("input, select, textarea, button, [href], [tabindex]:not([tabindex='-1'])") ?? []).filter((x) => !x.hasAttribute("disabled"));
      if (f.length === 0) return;
      const first = f[0]!;
      const last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  return (
    <div className="sheet-layer">
      <div className="scrim" onClick={props.onClose} aria-hidden="true" />
      <div ref={ref} className={cx("sheet", props.wide && "sheet-wide")} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKey}>
        <header className="sheet-head">
          <h2 id={titleId} className="t-sheetTitle ink1">{props.title}</h2>
          <button type="button" className="btn btn-quiet" data-close onClick={props.onClose} aria-label="Close">
            <span>Close</span><Keycap k="esc" />
          </button>
        </header>
        <div className="sheet-body">{props.children}</div>
        {props.footer && <footer className="sheet-foot">{props.footer}</footer>}
      </div>
    </div>
  );
}

/** Our own SVG bars (no chart library). Values in seconds; labels underneath. */
export function Bars(props: { data: { label: string; value: number; partial?: boolean }[]; label: string; height?: number }) {
  const h = props.height ?? 120;
  const max = Math.max(1, ...props.data.map((d) => d.value));
  const w = 36;
  const gap = 20;
  const width = props.data.length * (w + gap) - gap;
  return (
    <figure className="bars">
      <svg width="100%" height={h + 36} viewBox={`0 0 ${width} ${h + 36}`} role="img" aria-label={props.label} preserveAspectRatio="xMinYMid meet">
        {props.data.map((d, i) => {
          const bh = Math.max(2, (d.value / max) * h);
          const x = i * (w + gap);
          return (
            <g key={d.label}>
              <rect x={x} y={h - bh} width={w} height={bh} rx={3} className={d.partial ? "bar bar-partial" : "bar"} />
              <text x={x + w / 2} y={h - bh - 6} textAnchor="middle" className="bar-value">{hoursText(d.value).replace(" h", "")}</text>
              <text x={x + w / 2} y={h + 18} textAnchor="middle" className="bar-label">{d.label}</text>
            </g>
          );
        })}
      </svg>
    </figure>
  );
}

export function Segmented<T extends string>(props: { label: string; options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={props.label}>
      {props.options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={props.value === o.value}
          className={cx("seg", props.value === o.value && "seg-on")} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field(props: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="t-label ink1">{props.label}</span>
      {props.children}
      {props.hint && <span className="t-footnote ink3">{props.hint}</span>}
      {props.error && <span className="t-footnote state-ink-needs-you" role="alert">{props.error}</span>}
    </label>
  );
}
