import "dotenv/config";
import { eq } from "drizzle-orm";
import { db, queryClient } from "../db/client.js";
import { users } from "../db/schema/index.js";

// Prints the user id for an email, for PLATFORM_ADMIN_USER_IDS. Usage: npx tsx src/dev/user-id.ts you@example.com
const email = (process.argv[2] ?? "").trim().toLowerCase();
const [u] = email ? await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1) : [];
console.log(u ? u.id : "No user with that email.");
await queryClient.end();
