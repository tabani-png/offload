// Design tokens for the admin web. Mirrors app/Sources/Core/Tokens.swift and app/Sources/Design/Theme.swift so the web
// reads as the same product as the Mac app. tests/tokens.test.ts parses the Swift file and checks parity.

/** 4-pt grid (Tokens.Space). */
export const space = { s4: 4, s8: 8, s12: 12, s16: 16, s20: 20, s24: 24, s32: 32, s40: 40, s48: 48 } as const;
export const nudge = 2;

/** Concentric radii (Tokens.Radius): 24 outside, 16 for an 8-pt inset, 12 for rows. */
export const radius = { card: 24, well: 16, row: 12, key: 5, inset: 8, control: 6, bar: 3, window: 12 } as const;

/** Fixed control sizes (Tokens.Size). */
export const size = { key: 18, control: 30, chip: 22, chipSmall: 20, tag: 18, row: 36, dot: 8, dotSmall: 6, toolbar: 52, actionBar: 56 } as const;

/** Durations in seconds, as in Tokens.Duration. CSS uses the ms values below. */
export const duration = { press: 0.1, fast: 0.15, base: 0.2, slow: 0.3, pulse: 1.6 } as const;

/** The app's easings (CubicBezier.outExpo, .standard). */
export const easing = {
  outExpo: "cubic-bezier(0.16, 1, 0.3, 1)",
  standard: "cubic-bezier(0.4, 0, 0.2, 1)",
} as const;

export const motion = { pressScale: 0.97, riseOffset: 7 } as const;

/** Ink opacity ladder (Tokens.Ink). Hierarchy by opacity, not weight. */
export const ink = {
  primary: 0.96,
  secondary: 0.84,
  tertiary: 0.52,
  lightPrimary: 0.86,
  lightSecondary: 0.72,
  lightTertiary: 0.63,
} as const;

export const font = {
  sans: '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif',
  display: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", system-ui, sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, monospace',
} as const;

export interface TypeStyle {
  size: number;
  weight: 400 | 500;
  tracking: number;
  lineHeight: number;
}

/**
 * Type scale (Tokens.TypeScale). The web uses weights 400 and 500 only (SPEC); the app's 600 badge maps to 500.
 */
export const type = {
  hero: { size: 34, weight: 500, tracking: -0.9, lineHeight: 1.0 },
  largeTitle: { size: 26, weight: 500, tracking: -0.6, lineHeight: 1.15 },
  display: { size: 20, weight: 500, tracking: -0.35, lineHeight: 1.2 },
  sheetTitle: { size: 17, weight: 500, tracking: -0.3, lineHeight: 1.25 },
  title: { size: 15, weight: 500, tracking: -0.15, lineHeight: 1.3 },
  body: { size: 13, weight: 400, tracking: -0.05, lineHeight: 1.45 },
  label: { size: 13, weight: 500, tracking: -0.05, lineHeight: 1.3 },
  callout: { size: 12, weight: 400, tracking: 0, lineHeight: 1.4 },
  calloutEmphasis: { size: 12, weight: 500, tracking: 0, lineHeight: 1.3 },
  caption: { size: 11, weight: 500, tracking: 0.1, lineHeight: 1.2 },
  footnote: { size: 11, weight: 400, tracking: 0.05, lineHeight: 1.3 },
  micro: { size: 10, weight: 400, tracking: 0.1, lineHeight: 1 },
  key: { size: 11, weight: 500, tracking: 0, lineHeight: 1 },
  mono: { size: 11, weight: 500, tracking: 0, lineHeight: 1 },
  code: { size: 12, weight: 400, tracking: 0, lineHeight: 1.35 },
} as const satisfies Record<string, TypeStyle>;

/** Colour means state. Four hues plus neutral, as in Palette.status / statusInk. */
export type StateRole = "working" | "needsYou" | "done" | "recording" | "neutral";

export interface Scheme {
  canvas: string;
  sidebar: string;
  toolbar: string;
  sheet: string;
  group: string;
  ink1: string;
  ink2: string;
  ink3: string;
  ring: string;
  ringStrong: string;
  fill: string;
  fillStrong: string;
  track: string;
  primaryFill: string;
  primaryInk: string;
  focus: string;
  scrim: string;
  status: Record<StateRole, string>;
  statusInk: Record<StateRole, string>;
}

const white = (a: number) => `rgba(255, 255, 255, ${a})`;
const black = (a: number) => `rgba(0, 0, 0, ${a})`;

/** Dark is the hero (Theme.swift + WindowKit.swift values). */
export const dark: Scheme = {
  canvas: "#161618",
  sidebar: "#1F1F22",
  toolbar: "#232326",
  sheet: "#2A2A2D",
  group: white(0.045),
  ink1: white(ink.primary),
  ink2: white(ink.secondary),
  ink3: white(ink.tertiary),
  ring: white(0.1),
  ringStrong: white(0.22),
  fill: white(0.06),
  fillStrong: white(0.12),
  track: white(0.1),
  primaryFill: "#FFFFFF",
  primaryInk: "#0B0B0C",
  focus: "#4C9DFF",
  scrim: black(0.62),
  status: { working: "#4C9DFF", needsYou: "#FFC75C", done: "#30D158", recording: "#FF453A", neutral: white(0.38) },
  statusInk: { working: "#4C9DFF", needsYou: "#FFC75C", done: "#30D158", recording: "#FF453A", neutral: white(ink.secondary) },
};

/** Light mirrors dark with black ink. */
export const light: Scheme = {
  canvas: "#F3F3F5",
  sidebar: "#E8E8EB",
  toolbar: "#EDEDF0",
  sheet: "#FBFBFC",
  group: "#FFFFFF",
  ink1: black(ink.lightPrimary),
  ink2: black(ink.lightSecondary),
  ink3: black(ink.lightTertiary),
  ring: black(0.1),
  ringStrong: black(0.18),
  fill: black(0.055),
  fillStrong: white(0.96),
  track: black(0.07),
  primaryFill: "#1C1C1F",
  primaryInk: "#FFFFFF",
  focus: "#0A7AFF",
  scrim: black(0.38),
  status: { working: "#0A7AFF", needsYou: "#E29A00", done: "#1FA84A", recording: "#FF3B30", neutral: black(0.28) },
  statusInk: { working: "#0058C4", needsYou: "#6E4500", done: "#1A7A3A", recording: "#C4241B", neutral: black(ink.lightSecondary) },
};

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function schemeVars(s: Scheme): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(s)) {
    if (typeof v === "string") out.push(`--${kebab(k)}: ${v};`);
  }
  for (const [k, v] of Object.entries(s.status)) out.push(`--state-${kebab(k)}: ${v};`);
  for (const [k, v] of Object.entries(s.statusInk)) out.push(`--state-ink-${kebab(k)}: ${v};`);
  return out;
}

/** The CSS custom properties every stylesheet reads. Injected once at startup (main.tsx). */
export function tokenCss(): string {
  const common: string[] = [];
  for (const [k, v] of Object.entries(space)) common.push(`--space-${k.slice(1)}: ${v}px;`);
  for (const [k, v] of Object.entries(radius)) common.push(`--radius-${k}: ${v}px;`);
  for (const [k, v] of Object.entries(size)) common.push(`--size-${kebab(k)}: ${v}px;`);
  for (const [k, v] of Object.entries(duration)) common.push(`--dur-${k}: ${Math.round(v * 1000)}ms;`);
  common.push(`--ease-out-expo: ${easing.outExpo};`, `--ease-standard: ${easing.standard};`);
  common.push(`--rise: ${motion.riseOffset}px;`, `--press-scale: ${motion.pressScale};`);
  common.push(`--font-sans: ${font.sans};`, `--font-display: ${font.display};`, `--font-mono: ${font.mono};`);
  for (const [k, t] of Object.entries(type)) {
    const n = kebab(k);
    common.push(`--type-${n}-size: ${t.size}px;`, `--type-${n}-weight: ${t.weight};`,
      `--type-${n}-tracking: ${t.tracking}px;`, `--type-${n}-lh: ${t.lineHeight};`);
  }
  return [
    `:root { ${common.join(" ")} ${schemeVars(dark).join(" ")} color-scheme: dark; }`,
    `:root[data-theme="light"] { ${schemeVars(light).join(" ")} color-scheme: light; }`,
    `@media (prefers-reduced-motion: reduce) { :root { --dur-press: 0ms; --dur-fast: 0ms; --dur-base: 0ms; --dur-slow: 0ms; --rise: 0px; --press-scale: 1; } }`,
  ].join("\n");
}

// Contrast (WCAG 2.x) helpers, used by the A11Y tests and nowhere at runtime.
type RGBA = [number, number, number, number];

export function parseColor(c: string): RGBA {
  const hex = /^#([0-9a-f]{6})$/i.exec(c);
  if (hex) {
    const n = parseInt(hex[1]!, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const m = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(c);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  throw new Error(`unparsed colour ${c}`);
}

/** Composite `fg` over an opaque `bg`. */
export function over(fg: string, bg: string): RGBA {
  const [r, g, b, a] = parseColor(fg);
  const [R, G, B] = parseColor(bg);
  return [r * a + R * (1 - a), g * a + G * (1 - a), b * a + B * (1 - a), 1];
}

function luminance([r, g, b]: RGBA): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(a: RGBA, b: RGBA): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
