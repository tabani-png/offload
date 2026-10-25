import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createPool } from "./db/pool.ts";
import { migrate } from "./db/migrate.ts";
import { importEs256SigningKey } from "./auth/jwt.ts";
import { workosSdk } from "./auth/workos.ts";

const config = loadConfig();
const migrator = createPool(config.migratorPgUrl, { max: 1, ...(config.dbSchema ? { schema: config.dbSchema } : {}) });
await migrate(migrator);
await migrator.close();

const { app } = await createApp({
  db: createPool(config.appPgUrl, config.dbSchema ? { schema: config.dbSchema } : {}),
  config,
  workos: workosSdk(config.workos),
  deviceKey: await importEs256SigningKey(config.deviceSigningJwk!),
});

const server = Bun.serve({ port: Number(process.env.PORT ?? 8787), fetch: app.fetch });
console.log(`control plane listening on :${server.port}`);
