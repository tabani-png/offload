import { SQL } from "bun";

export type Db = SQL;
export type Tx = Bun.TransactionSQL;

/** A `Bun.sql` pool. `schema` pins search_path (tests use one schema per file; production uses the default). */
export function createPool(url: string, opts: { schema?: string; max?: number } = {}): Db {
  return new SQL({
    url,
    max: opts.max ?? 10,
    ...(opts.schema ? { connection: { search_path: opts.schema } } : {}),
  });
}

/** Postgres timestamptz → epoch ms. */
export function ms(v: Date | string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.getTime();
  return typeof v === "number" ? v : Number(v);
}

export function msNN(v: Date | string | number): number {
  return ms(v) as number;
}
