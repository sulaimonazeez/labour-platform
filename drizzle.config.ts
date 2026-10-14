import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// Migrations must use a DIRECT (or session-pooler) connection, never the
// transaction-mode pooler used by the app at runtime.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DIRECT_URL! },
  strict: true,
  verbose: true,
});
