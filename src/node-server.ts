import "dotenv/config";
import { serve } from "@hono/node-server";
import { app } from "./api/app.js";

// Local development and VPS entry (`npm run dev` / `npm start`). Vercel uses src/index.ts instead.
const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, (info) => console.log(`API listening on http://localhost:${info.port}`));
