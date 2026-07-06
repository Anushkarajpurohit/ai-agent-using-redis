import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

// Reuse the pool across hot-reloads in dev (Next.js) and across lambda
// invocations in serverless deployments where the module stays warm.
declare global {
  // eslint-disable-next-line no-var
  var __mayaPgPool: Pool | undefined;
}

const pool =
  global.__mayaPgPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
  });

if (process.env.NODE_ENV !== "production") {
  global.__mayaPgPool = pool;
}

export const db = drizzle(pool, { schema });
export { pool };
