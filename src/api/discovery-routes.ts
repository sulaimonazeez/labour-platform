import { and, asc, desc, eq, ilike, inArray, ne, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../db/client";
import { marketCurrencies, markets, projectMembers, projects, providerProfiles, providerServices, serviceCategories, tasks } from "../db/schema";
import { requireAuth, type AuthEnv } from "../auth/middleware";
import { isProviderOnly, type ProjectRole } from "../authz/projects";

// Read-only endpoints a front end needs before it can build its screens:
//   GET /reference       public reference data (active markets and their currencies)
//   GET /projects        the projects I am a member of, with my roles
//   GET /providers?q=    a small provider directory so a manager can pick who to invite
// Real matching (PRD §95) is Phase 4; this is deliberately the simplest useful thing.

export const referenceRoutes = new Hono();

referenceRoutes.get("/", async (c) => {
  const ms = await db
    .select({
      id: markets.id, code: markets.code, name: markets.name, defaultLanguage: markets.defaultLanguage,
      defaultCurrency: markets.defaultCurrency, defaultTimezone: markets.defaultTimezone,
    })
    .from(markets)
    .where(eq(markets.isActive, true))
    .orderBy(asc(markets.name));
  const cur = ms.length === 0
    ? []
    : await db
      .select({ marketId: marketCurrencies.marketId, code: marketCurrencies.currencyCode })
      .from(marketCurrencies)
      .where(inArray(marketCurrencies.marketId, ms.map((m) => m.id)));
  return c.json({ markets: ms.map((m) => ({ ...m, currencies: cur.filter((x) => x.marketId === m.id).map((x) => x.code) })) });
});

export const projectListRoutes = new Hono<AuthEnv>();
projectListRoutes.use("*", requireAuth);

projectListRoutes.get("/", async (c) => {
  const userId = c.get("auth").userId;
  const rows = await db
    .select({
      id: projects.id, title: projects.title, status: projects.status, health: projects.health,
      currency: projects.currency, createdAt: projects.createdAt, role: projectMembers.role,
    })
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(eq(projectMembers.userId, userId))
    .orderBy(desc(projects.createdAt))
    .limit(200);

  const byId = new Map<string, Omit<(typeof rows)[number], "role"> & { roles: string[] }>();
  for (const { role, ...p } of rows) {
    const existing = byId.get(p.id);
    if (existing) existing.roles.push(role);
    else byId.set(p.id, { ...p, roles: [role] });
  }
  const list = [...byId.values()].slice(0, 50);
  // Task counts by status feed the progress tape. A provider-only member sees just their own tasks, so they get no counts.
  const countable = list.filter((p) => !isProviderOnly(p.roles as ProjectRole[])).map((p) => p.id);
  const counts = countable.length === 0
    ? []
    : await db
      .select({ projectId: tasks.projectId, status: tasks.status, n: sql<number>`count(*)::int` })
      .from(tasks)
      .where(inArray(tasks.projectId, countable))
      .groupBy(tasks.projectId, tasks.status);
  return c.json({
    projects: list.map((p) => ({
      ...p,
      taskStatuses: Object.fromEntries(counts.filter((x) => x.projectId === p.id).map((x) => [x.status, x.n])) as Record<string, number>,
    })),
  });
});

export const providerDirectoryRoutes = new Hono<AuthEnv>();
providerDirectoryRoutes.use("*", requireAuth);

providerDirectoryRoutes.get("/", async (c) => {
  const userId = c.get("auth").userId;
  const q = (c.req.query("q") ?? "").trim().slice(0, 80);
  const category = (c.req.query("category") ?? "").trim().slice(0, 100);
  const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;

  // category = canonical key (PRD §24). Providers who list that service, matched by identity, never by display name.
  const byCategory = category
    ? sql`${providerProfiles.id} in (
        select ${providerServices.providerProfileId} from ${providerServices}
        join ${serviceCategories} on ${serviceCategories.id} = ${providerServices.categoryId}
        where ${serviceCategories.canonicalKey} = ${category})`
    : undefined;

  const rows = await db
    .select({
      id: providerProfiles.id, displayName: providerProfiles.displayName, headline: providerProfiles.headline,
      kind: providerProfiles.kind, remoteOk: providerProfiles.remoteOk,
    })
    .from(providerProfiles)
    .where(and(
      eq(providerProfiles.isActive, true),
      ne(providerProfiles.userId, userId),
      byCategory,
      q ? or(ilike(providerProfiles.displayName, like), ilike(providerProfiles.headline, like)) : undefined,
    ))
    .orderBy(asc(providerProfiles.displayName))
    .limit(20);

  const ids = rows.map((r) => r.id);
  const svc = ids.length === 0 ? [] : await db
    .select({ providerId: providerServices.providerProfileId, key: serviceCategories.canonicalKey })
    .from(providerServices)
    .innerJoin(serviceCategories, eq(serviceCategories.id, providerServices.categoryId))
    .where(inArray(providerServices.providerProfileId, ids));
  return c.json({
    providers: rows.map((r) => ({ ...r, categories: svc.filter((x) => x.providerId === r.id).map((x) => x.key) })),
  });
});
