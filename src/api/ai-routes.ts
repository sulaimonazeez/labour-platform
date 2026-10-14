import { and, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db/client.js";
import {
  changeRequests, marketCurrencies, markets, projectBudgets, projectDrafts, projectMembers, projects, requests, serviceCategories,
  stages, taskDependencies, tasks, users,
} from "../db/schema/index.js";
import { requireAuth, type AuthEnv } from "../auth/middleware.js";
import { requireProjectRole, PROJECT_MANAGERS } from "../authz/projects.js";
import { aiStatus, extractJson, runAi } from "../ai/govern.js";
import { AiUnavailable } from "../ai/providers.js";
import { askAssistant, changeImpact, compareQuotes, computeBrief } from "../ai/context.js";
import { buildDraft, draftSchema, findTemplate, structuralProblems } from "../ai/draft.js";
import { categoryByKey, classify } from "../ai/rules.js";
import { recordActivity } from "../lib/activity.js";
import { runIdempotent } from "../lib/idempotency.js";
import { ApiError, parseOrThrow, readJson, uuidParam } from "./http.js";

// PRD §16-23, §33, §54, §105, §144. AI is optional everywhere: with AI_PROVIDER=none every route here still answers
// from rules, templates and the project record (PRD §20).

export const aiRoutes = new Hono<AuthEnv>();
aiRoutes.use("*", requireAuth);
aiRoutes.get("/status", (c) => c.json({ ai: aiStatus() }));

// ── adaptive questions (PRD §17): only what is still unknown, retrieved from a template first ──
const GENERIC = [
  { id: "where", text: "Where will the work happen? (area is enough for now)" },
  { id: "when", text: "When do you need it done?" },
  { id: "problem", text: "What exactly is wrong, or what should it look like when finished?" },
  { id: "access", text: "Is the site easy to get into (gate, stairs, parking)?" },
  { id: "materials", text: "Will you supply any materials, or should the provider?" },
  { id: "budget", text: "Do you have a budget in mind?" },
];
const questionsBody = z.strictObject({
  text: z.string().trim().min(1).max(2000),
  answers: z.record(z.string().max(60), z.string().max(1000)).default({}),
  categoryKey: z.string().trim().max(120).optional(),
});

aiRoutes.post("/questions", async (c) => {
  const userId = c.get("auth").userId;
  const b = parseOrThrow(questionsBody, await readJson(c));
  const [me] = await db.select({ lang: users.preferredLanguage, code: markets.code }).from(users).leftJoin(markets, eq(markets.id, users.marketId)).where(eq(users.id, userId)).limit(1);
  const cls = await classify(db, b.text, me?.lang ?? "en");
  const key = b.categoryKey ?? cls.topKey;
  const tpl = await findTemplate(db, key, me?.code ?? "", me?.lang ?? "en");
  const fromTemplate = Array.isArray((tpl?.v.body as { questions?: unknown } | undefined)?.questions)
    ? ((tpl?.v.body as { questions: { id?: unknown; text?: unknown }[] }).questions).filter((q) => typeof q.id === "string" && typeof q.text === "string").map((q) => ({ id: q.id as string, text: q.text as string }))
    : [];
  const pool = fromTemplate.length > 0 ? fromTemplate : GENERIC;
  const limit = cls.path === "quick_service" ? 3 : 5;
  let questions = pool.filter((q) => !(q.id in b.answers)).slice(0, limit);
  let source: "template" | "rules" | "ai" = fromTemplate.length > 0 ? "template" : "rules";

  // Optional AI: re-orders and rephrases from what is already known. It can only ask, never decide (PRD §17, §20).
  if (questions.length > 0 && cls.path !== "quick_service") {
    try {
      const out = await runAi(db, {
        userId, purpose: "questions", maxTokens: 400,
        system: "You help scope a job. Given the customer's words and answers so far, return JSON only: {\"questions\":[{\"id\":string,\"text\":string}]} with at most 4 short, plain-language questions that are still unknown. Do not repeat answered ids.",
        prompt: `Need: ${b.text}\nAnswered: ${JSON.stringify(b.answers)}\nCandidate questions: ${JSON.stringify(questions)}`,
        context: { fallback: { questions } },
      });
      const j = extractJson(out.text) as { questions?: { id?: unknown; text?: unknown }[] } | null;
      const ai = (j?.questions ?? []).filter((q) => typeof q.id === "string" && typeof q.text === "string" && !((q.id as string) in b.answers)).slice(0, 4).map((q) => ({ id: q.id as string, text: (q.text as string).slice(0, 300) }));
      if (ai.length > 0) { questions = ai; source = "ai"; }
    } catch (e) {
      if (!(e instanceof AiUnavailable)) throw e;
    }
  }
  return c.json({ classification: cls, questions, source, done: questions.length === 0 });
});

// ── drafts: generate -> validate -> review -> accept (PRD §19-20) ────────────
export const requestDraftRoutes = new Hono<AuthEnv>();
requestDraftRoutes.use("*", requireAuth);
const generateBody = z.strictObject({
  answers: z.record(z.string().max(60), z.string().max(1000)).default({}),
  categoryKey: z.string().trim().max(120).optional(),
});

requestDraftRoutes.post("/:id/drafts", async (c) => {
  const userId = c.get("auth").userId;
  const requestId = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(generateBody, raw);
  return runIdempotent(c, { scope: "requests.draft", userId, body: { requestId, raw } }, async (tx) => {
    const [r] = await tx.select().from(requests).where(and(eq(requests.id, requestId), eq(requests.requesterUserId, userId))).limit(1);
    if (!r) throw new ApiError(404, "not_found", "Not found");
    if (r.status === "converted") throw new ApiError(409, "already_converted", "This request already became a project");
    const [me] = await tx.select({ lang: users.preferredLanguage, code: markets.code }).from(users).leftJoin(markets, eq(markets.id, users.marketId)).where(eq(users.id, userId)).limit(1);
    const lang = r.originalLanguage ?? me?.lang ?? "en";
    const text = r.rawText ?? "";
    const cls = await classify(tx, text, lang);
    let key = b.categoryKey ?? cls.topKey;
    if (!key && r.categoryId) { const [cat] = await tx.select({ k: serviceCategories.canonicalKey }).from(serviceCategories).where(eq(serviceCategories.id, r.categoryId)).limit(1); key = cat?.k ?? null; }
    const cat = key ? await categoryByKey(tx, key) : null;
    const catName = cls.matches.find((m) => m.key === key)?.name ?? null;
    const res = await buildDraft(tx, {
      userId, marketCode: me?.code ?? "", language: lang, text, answers: b.answers, categoryKey: cat ? key : null, categoryName: catName,
      risk: cat?.riskLevel ?? "low", path: cls.path,
    });
    const [row] = await tx.insert(projectDrafts).values({
      requestId, requesterUserId: userId, templateVersionId: res.templateVersionId, source: res.source, language: lang,
      payload: res.draft as unknown as Record<string, unknown>, warnings: res.warnings,
    }).returning({ id: projectDrafts.id, createdAt: projectDrafts.createdAt });
    return { status: 201, body: { draft: { id: row.id, createdAt: row.createdAt, source: res.source, labels: res.labels, warnings: res.warnings, payload: res.draft, classification: cls } } };
  });
});

export const draftRoutes = new Hono<AuthEnv>();
draftRoutes.use("*", requireAuth);

draftRoutes.get("/:id", async (c) => {
  const userId = c.get("auth").userId;
  const [d] = await db.select().from(projectDrafts).where(and(eq(projectDrafts.id, uuidParam(c.req.param("id"))), eq(projectDrafts.requesterUserId, userId))).limit(1);
  if (!d) throw new ApiError(404, "not_found", "Not found");
  return c.json({ draft: { id: d.id, requestId: d.requestId, source: d.source, status: d.status, warnings: d.warnings, payload: d.payload, projectId: d.projectId, createdAt: d.createdAt } });
});

draftRoutes.post("/:id/reject", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  return runIdempotent(c, { scope: "drafts.reject", userId, body: { id } }, async (tx) => {
    const r = await tx.update(projectDrafts).set({ status: "rejected", decidedAt: new Date() })
      .where(and(eq(projectDrafts.id, id), eq(projectDrafts.requesterUserId, userId), eq(projectDrafts.status, "validated"))).returning({ id: projectDrafts.id });
    if (r.length === 0) throw new ApiError(409, "not_reviewable", "Only a draft you have not decided yet can be rejected");
    return { status: 200, body: { draft: { id, status: "rejected" } } };
  });
});

const acceptBody = z.strictObject({
  currency: z.string().trim().length(3),
  title: z.string().trim().min(1).max(200).optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
  edits: z.unknown().optional(), // the reviewed draft, if the owner changed it; re-validated like any other
});

draftRoutes.post("/:id/accept", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const raw = await readJson(c);
  const b = parseOrThrow(acceptBody, raw);
  return runIdempotent(c, { scope: "drafts.accept", userId, body: { id, raw } }, async (tx) => {
    const [d] = await tx.select().from(projectDrafts).where(and(eq(projectDrafts.id, id), eq(projectDrafts.requesterUserId, userId))).limit(1).for("update");
    if (!d) throw new ApiError(404, "not_found", "Not found");
    if (d.status !== "validated") throw new ApiError(409, "not_reviewable", `A ${d.status} draft cannot be accepted`);
    const parsed = draftSchema.safeParse(b.edits ?? d.payload);
    if (!parsed.success) throw new ApiError(400, "invalid_draft", "The draft does not match the expected shape", parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    const draft = parsed.data;
    const problems = structuralProblems(draft);
    if (problems.length > 0) throw new ApiError(400, "invalid_draft", problems.join("; "));

    const [r] = d.requestId ? await tx.select().from(requests).where(and(eq(requests.id, d.requestId), eq(requests.requesterUserId, userId))).limit(1).for("update") : [];
    if (!r) throw new ApiError(409, "request_missing", "This draft is not attached to a request you own");
    if (r.status === "converted") throw new ApiError(409, "already_converted", "This request already became a project");
    const [cur] = await tx.select({ code: marketCurrencies.currencyCode }).from(marketCurrencies).where(and(eq(marketCurrencies.marketId, r.marketId), eq(marketCurrencies.currencyCode, b.currency))).limit(1);
    if (!cur) throw new ApiError(400, "currency_not_allowed", "This currency is not enabled for the request's market");
    let timezone = b.timezone;
    if (!timezone) { const [me] = await tx.select({ timezone: users.timezone }).from(users).where(eq(users.id, userId)).limit(1); timezone = me?.timezone; }
    if (!timezone) throw new ApiError(400, "timezone_required", "timezone is required");

    const [p] = await tx.insert(projects).values({
      ownerUserId: userId, organisationId: r.organisationId, requestId: r.id, marketId: r.marketId, title: b.title ?? draft.title,
      objective: draft.objective ?? null, currency: b.currency, timezone,
    }).returning({ id: projects.id, title: projects.title, currency: projects.currency });
    await tx.insert(projectMembers).values({ projectId: p.id, userId, role: "project_owner" });
    await tx.insert(projectBudgets).values({ projectId: p.id, currency: b.currency });

    const keys = [...new Set(draft.stages.flatMap((s) => s.tasks.map((t) => t.categoryKey).filter((x): x is string => !!x)))];
    const cats = keys.length > 0 ? await tx.select({ id: serviceCategories.id, k: serviceCategories.canonicalKey }).from(serviceCategories).where(inArray(serviceCategories.canonicalKey, keys)) : [];
    const idByKey = new Map<string, string>();
    let position = 0;
    for (const [si, s] of draft.stages.entries()) {
      const [st] = await tx.insert(stages).values({ projectId: p.id, name: s.name, position: si }).returning({ id: stages.id });
      for (const t of s.tasks) {
        const description = [t.description, t.acceptanceCriteria ? `Done when: ${t.acceptanceCriteria}` : null, t.inspectionRequired ? "Inspection required." : null].filter(Boolean).join("\n") || null;
        const [row] = await tx.insert(tasks).values({
          projectId: p.id, stageId: st.id, categoryId: cats.find((x) => x.k === t.categoryKey)?.id ?? null, title: t.title, description,
          materialResponsibility: t.materialResponsibility, position: position++,
        }).returning({ id: tasks.id });
        idByKey.set(t.key, row.id);
      }
    }
    for (const s of draft.stages) for (const t of s.tasks) for (const dep of t.dependsOn) {
      await tx.insert(taskDependencies).values({ taskId: idByKey.get(t.key) as string, dependsOnTaskId: idByKey.get(dep) as string, type: "finish_to_start" });
    }
    await tx.update(requests).set({ status: "converted" }).where(eq(requests.id, r.id));
    await tx.update(projectDrafts).set({ status: "accepted", projectId: p.id, decidedAt: new Date() }).where(eq(projectDrafts.id, d.id));
    await recordActivity(tx, { projectId: p.id, actorUserId: userId, eventType: "request.converted", subjectType: "request", subjectId: r.id, payload: { projectId: p.id, via: "draft", source: d.source } });
    await recordActivity(tx, { projectId: p.id, actorUserId: userId, eventType: "project.created", subjectType: "project", subjectId: p.id, payload: { draftId: d.id, source: d.source, tasks: position, currency: b.currency } });
    return { status: 201, body: { project: p, draftId: d.id, tasks: position } };
  });
});

// ── project-scoped intelligence ──────────────────────────────────────────────
export const projectAiRoutes = new Hono<AuthEnv>();
projectAiRoutes.use("*", requireAuth);

const askBody = z.strictObject({ question: z.string().trim().min(2).max(1000), taskId: z.uuid().optional() });
projectAiRoutes.post("/:id/assistant/ask", async (c) => {
  const userId = c.get("auth").userId;
  const projectId = uuidParam(c.req.param("id"));
  const b = parseOrThrow(askBody, await readJson(c));
  await requireProjectRole(db, projectId, userId);
  return c.json(await askAssistant(db, { userId, projectId, taskId: b.taskId, question: b.question }));
});

projectAiRoutes.get("/:id/brief", async (c) => {
  const userId = c.get("auth").userId;
  const projectId = uuidParam(c.req.param("id"));
  await requireProjectRole(db, projectId, userId);
  const brief = await computeBrief(db, projectId, userId);
  if (!brief) throw new ApiError(404, "not_found", "Not found");
  return c.json({ brief });
});

// PRD §77: the stored health is calculated from project data, never from AI. Managers can refresh it.
projectAiRoutes.post("/:id/recompute-health", async (c) => {
  const userId = c.get("auth").userId;
  const projectId = uuidParam(c.req.param("id"));
  return runIdempotent(c, { scope: "projects.health", userId, body: { projectId } }, async (tx) => {
    await requireProjectRole(tx, projectId, userId, PROJECT_MANAGERS);
    const brief = await computeBrief(tx, projectId, userId);
    if (!brief) throw new ApiError(404, "not_found", "Not found");
    const allowed = ["on_track", "attention_required", "delayed", "blocked", "awaiting_approval", "awaiting_payment", "disputed"] as const;
    const health = allowed.find((h) => h === brief.derivedHealth) ?? "on_track";
    await tx.update(projects).set({ health }).where(eq(projects.id, projectId));
    await recordActivity(tx, { projectId, actorUserId: userId, eventType: "project.health_recomputed", subjectType: "project", subjectId: projectId, payload: { from: brief.storedHealth, to: health } });
    return { status: 200, body: { health, previous: brief.storedHealth } };
  });
});

export const taskAiRoutes = new Hono<AuthEnv>();
taskAiRoutes.use("*", requireAuth);
taskAiRoutes.get("/:id/quotes/compare", async (c) => {
  const userId = c.get("auth").userId;
  const taskId = uuidParam(c.req.param("id"));
  const [t] = await db.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!t) throw new ApiError(404, "not_found", "Not found");
  await requireProjectRole(db, t.projectId, userId, PROJECT_MANAGERS);
  return c.json({ comparison: await compareQuotes(db, taskId, userId, t.projectId) });
});

export const changeAiRoutes = new Hono<AuthEnv>();
changeAiRoutes.use("*", requireAuth);
changeAiRoutes.get("/:id/impact", async (c) => {
  const userId = c.get("auth").userId;
  const id = uuidParam(c.req.param("id"));
  const [cr] = await db.select({ projectId: changeRequests.projectId }).from(changeRequests).where(eq(changeRequests.id, id)).limit(1);
  if (!cr) throw new ApiError(404, "not_found", "Not found");
  await requireProjectRole(db, cr.projectId, userId, PROJECT_MANAGERS);
  const impact = await changeImpact(db, id, userId);
  if (!impact) throw new ApiError(404, "not_found", "Not found");
  return c.json({ impact });
});
