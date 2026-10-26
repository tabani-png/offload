import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./pool.ts";

export const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");

export interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export function listMigrations(dir = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((f) => {
      const sql = readFileSync(join(dir, f), "utf8");
      return {
        version: Number(f.slice(0, 4)),
        name: f,
        sql,
        checksum: new Bun.CryptoHasher("sha256").update(sql).digest("hex"),
      };
    });
}

/**
 * Applies numbered migrations in order, each in its own transaction, as the migrator (table owner).
 * An applied migration whose file changed is an error: migrations are append-only.
 */
export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<string[]> {
  await db.unsafe(`create table if not exists schema_migrations (
    version integer primary key, name text not null, checksum text not null,
    applied_at timestamptz not null default now())`);
  const applied = new Map<number, string>();
  for (const r of await db`select version, checksum from schema_migrations`) applied.set(r.version, r.checksum);
  const ran: string[] = [];
  for (const m of listMigrations(dir)) {
    const prior = applied.get(m.version);
    if (prior !== undefined) {
      if (prior !== m.checksum) throw new Error(`migration ${m.name} changed after it was applied`);
      continue;
    }
    await db.begin(async (tx) => {
      await tx.unsafe(m.sql);
      await tx`insert into schema_migrations (version, name, checksum) values (${m.version}, ${m.name}, ${m.checksum})`;
    });
    ran.push(m.name);
  }
  return ran;
}
