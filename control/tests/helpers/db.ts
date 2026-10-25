import { SQL } from "bun";
import { createPool, type Db } from "../../src/db/pool.ts";
import { migrate } from "../../src/db/migrate.ts";

export const DEFAULT_PG_URL = "postgres://offload_migrator:offload@127.0.0.1:54329/offload_test";
export const APP_ROLE_PASSWORD = "offload";

export interface TestDb {
  schema: string;
  /** Table owner (bootstrap superuser in the test container): seeding and tampering only. */
  migrator: Db;
  /** offload_app: what the server uses. */
  app: Db;
  appUrl: string;
  /** offload_anchor: the anchoring job and verify-chain. */
  anchor: Db;
  anchorUrl: string;
  close(): Promise<void>;
}

function local(url: string): string {
  const h = new URL(url).hostname;
  if (h !== "localhost" && h !== "127.0.0.1") throw new Error("tests only run against a local Postgres");
  return url;
}

/** A fresh schema per test file, migrated, with offload_app able to log in (tests only; production grants LOGIN out of band). */
export async function testDb(): Promise<TestDb> {
  const url = local(process.env.OFFLOAD_PG_URL ?? DEFAULT_PG_URL);
  const schema = `t_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const boot = new SQL({ url, max: 1 });
  await boot.unsafe(`create schema ${schema}`);
  await boot.close();
  const migrator = createPool(url, { schema, max: 4 });
  await migrate(migrator);
  await migrator.unsafe(`alter role offload_app login password '${APP_ROLE_PASSWORD}'`);
  const u = new URL(url);
  u.username = "offload_app";
  u.password = APP_ROLE_PASSWORD;
  const appUrl = u.toString();
  const app = createPool(appUrl, { schema, max: 8 });
  await migrator.unsafe(`alter role offload_anchor login password '${APP_ROLE_PASSWORD}'`);
  u.username = "offload_anchor";
  const anchorUrl = u.toString();
  const anchor = createPool(anchorUrl, { schema, max: 2 });
  return {
    schema,
    migrator,
    app,
    appUrl,
    anchor,
    anchorUrl,
    async close() {
      await app.close();
      await anchor.close();
      await migrator.unsafe(`drop schema ${schema} cascade`);
      await migrator.close();
    },
  };
}
