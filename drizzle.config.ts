import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: "postgresql://postgres:QVpGNIfjgFihQRBRZoeQJVyHbdSgEjBl@hayabusa.proxy.rlwy.net:27620/railway",
  },
});
