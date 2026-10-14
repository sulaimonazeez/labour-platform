import { Hono } from "hono";
import { app as api } from "./api/app";
import { err } from "./api/http";

// Vercel entry (zero-config Hono detection): a file named src/index.ts that imports `hono` and DEFAULT-EXPORTS the app.
// Local/VPS entry is src/node-server.ts (starts a listener). Do not name any other file src/app|index|server.ts:
// Vercel picks its entry by those names.
const app = new Hono();
app.route("/", api); // the API's own onError (ApiError -> JSON) applies to its routes
app.notFound((c) => c.json(err("not_found", "Not found"), 404));

export default app;
