// RFC 8785 JSON Canonicalization Scheme (JCS), own small implementation (no dependency). Object keys are sorted by
// UTF-16 code units, numbers use the ECMAScript Number-to-String rules (which JCS adopts), strings use the JSON escaping
// of ECMA-262 JSON.stringify, no whitespace. Values JCS cannot represent (NaN, Infinity, undefined, functions,
// non-plain objects) throw instead of being dropped, so a signed envelope never silently loses a field.

export class JcsError extends Error {}

function num(n: number): string {
  if (!Number.isFinite(n)) throw new JcsError(`JCS cannot represent ${n}`);
  // ES Number::toString: -0 prints "0"; everything else is exactly what JCS section 3.2.2.3 specifies.
  return Object.is(n, -0) ? "0" : String(n);
}

function walk(v: unknown, out: string[]): void {
  if (v === null) return void out.push("null");
  switch (typeof v) {
    case "boolean":
      return void out.push(v ? "true" : "false");
    case "number":
      return void out.push(num(v));
    case "string":
      return void out.push(JSON.stringify(v));
    case "object": {
      if (Array.isArray(v)) {
        out.push("[");
        v.forEach((item, i) => {
          if (i > 0) out.push(",");
          if (item === undefined) throw new JcsError("JCS cannot represent undefined in an array");
          walk(item, out);
        });
        return void out.push("]");
      }
      const proto = Object.getPrototypeOf(v) as unknown;
      if (proto !== Object.prototype && proto !== null) throw new JcsError("JCS takes plain objects only");
      const rec = v as Record<string, unknown>;
      // Default sort compares UTF-16 code units, which is the JCS order (section 3.2.3).
      const keys = Object.keys(rec).filter((k) => rec[k] !== undefined).sort();
      out.push("{");
      keys.forEach((k, i) => {
        if (i > 0) out.push(",");
        out.push(JSON.stringify(k), ":");
        walk(rec[k], out);
      });
      return void out.push("}");
    }
    default:
      throw new JcsError(`JCS cannot represent a ${typeof v}`);
  }
}

/** The canonical JSON text of `v`. Object properties whose value is undefined are omitted (as JSON.parse never yields them). */
export function canonicalize(v: unknown): string {
  const out: string[] = [];
  walk(v, out);
  return out.join("");
}

/** UTF-8 bytes of the canonical text: what ES256 signs. */
export const canonicalBytes = (v: unknown): Uint8Array => new TextEncoder().encode(canonicalize(v));
