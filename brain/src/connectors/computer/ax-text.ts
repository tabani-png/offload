// s27 round 8: the ONE format of an accessibility text line, written by both drivers' readUi and read by the read
// step's parser (plan/read-source.ts): `<role> "<label>"` or `<role> "<label>" = "<value>"`, label and value as JSON
// strings (quotes, backslashes and newlines escaped). Reading also accepts curly quotes (“label” = “value”), which
// carry no escapes. Pure, no imports.

export interface AxLine {
  role: string;
  label: string;
  /** The field's value; null for an element that only has a label. */
  value: string | null;
}

export function formatAxLine(role: string, label: string, value?: string | null): string {
  return `${role} ${JSON.stringify(label)}${value === undefined || value === null ? "" : ` = ${JSON.stringify(value)}`}`;
}

/** One quoted string at the start of `s`: [text, rest] or null. Straight quotes use JSON escapes; curly ones none. */
function quoted(s: string): [string, string] | null {
  if (s.startsWith("“")) {
    const end = s.indexOf("”", 1);
    return end < 0 ? null : [s.slice(1, end), s.slice(end + 1)];
  }
  if (!s.startsWith('"')) return null;
  for (let i = 1; i < s.length; i++) {
    if (s[i] === "\\") {
      i += 1;
      continue;
    }
    if (s[i] === '"') {
      try {
        return [JSON.parse(s.slice(0, i + 1)) as string, s.slice(i + 1)];
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Parses one line in the format above; null when it is not one. */
export function parseAxLine(line: string): AxLine | null {
  const m = /^(AX[A-Za-z]+)\s+(.*)$/.exec(line.trim());
  if (m === null) return null;
  const first = quoted(m[2]!);
  if (first === null) return null;
  const rest = first[1].trim();
  if (rest === "") return { role: m[1]!, label: first[0], value: null };
  const eq = /^=\s*(.*)$/.exec(rest);
  if (eq === null) return null;
  const second = quoted(eq[1]!);
  if (second === null || second[1].trim() !== "") return null;
  return { role: m[1]!, label: first[0], value: second[0] };
}
