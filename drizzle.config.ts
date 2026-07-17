import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: "postgresql://postgres:fWsclhTEgtlqbABIKNIpPbFIIWBXWvJr@tokaido.proxy.rlwy.net:54360/railway",
  },
});
